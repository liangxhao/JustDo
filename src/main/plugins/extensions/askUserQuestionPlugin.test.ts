import fs from 'node:fs';
import path from 'node:path';

import { Value } from 'typebox/value';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_TIMEOUT_MINUTES,
  AskUserQuestionManager,
  AskUserQuestionSchema,
  buildWaitPolicy,
  default as askUserQuestionPlugin,
  MAX_ASK_USER_QUESTIONS,
  parseQuestions,
} from '../../../../openclaw-extensions/ask-user-question/index';

const question = {
  id: 'deploy_target',
  header: 'Deploy',
  question: 'Where should this be deployed?',
  options: [
    { id: 'staging', label: 'Staging (Recommended)' },
    { id: 'production', label: 'Production' },
  ],
};

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('AskUserQuestion extension', () => {
  test('keeps the rich question contract while adopting the native decision-only policy', () => {
    const questions = Array.from({ length: MAX_ASK_USER_QUESTIONS }, (_, index) => ({
      ...question,
      id: `question_${index + 1}`,
    }));

    expect(MAX_ASK_USER_QUESTIONS).toBe(8);
    expect(parseQuestions(questions)).toHaveLength(8);
    expect(AskUserQuestionSchema.properties.questions.maxItems).toBe(8);
    expect(Value.Check(AskUserQuestionSchema, { questions: [question] })).toBe(true);
    expect(ASK_USER_QUESTION_DESCRIPTION).toContain(
      'Use only when blocked on a decision that genuinely belongs to the user',
    );
    expect(ASK_USER_QUESTION_DESCRIPTION).toContain(
      'never ask whether to proceed, whether to continue, or to confirm your own plan',
    );
  });

  test('uses only native plugin services, scoped RPCs, and JustDo root sessions', () => {
    const registerGatewayMethod = vi.fn();
    const registerService = vi.fn();
    const registerTool = vi.fn();

    askUserQuestionPlugin.register({
      logger,
      pluginConfig: { timeoutMinutes: 15 },
      registerGatewayMethod,
      registerService,
      registerTool,
    } as never);

    expect(registerService).toHaveBeenCalledOnce();
    expect(registerGatewayMethod.mock.calls.map(call => [call[0], call[2]])).toEqual([
      ['askUserQuestion.list', { scope: 'operator.read' }],
      ['askUserQuestion.resolve', { scope: 'operator.write' }],
    ]);
    const factory = registerTool.mock.calls[0][0];
    expect(factory({ sessionKey: 'agent:main:subagent:child' })).toBeNull();
    expect(factory({ sessionKey: 'agent:main:unrelated:session' })).toBeNull();
    expect(factory({ sessionKey: 'agent:main:justdo:session-1' })).toMatchObject({
      name: 'AskUserQuestion',
      description: ASK_USER_QUESTION_DESCRIPTION,
    });
  });

  test('owns pending state and resolution inside the extension', async () => {
    const manager = new AskUserQuestionManager(logger);
    const emit = vi.fn();
    manager.setGatewayEventEmitter(emit);

    const response = manager.request([question], { mode: 'required' }, 'justdo:session-1');
    const request = manager.list()[0];
    expect(emit).toHaveBeenCalledWith('requested', request, { scope: 'operator.read' });

    manager.resolve(request.requestId, 'submit', {
      deploy_target: { selected: ['staging'] },
    });

    await expect(response).resolves.toEqual({
      status: 'answered',
      answers: { deploy_target: { selected: ['staging'] } },
    });
    expect(manager.list()).toEqual([]);
    expect(emit).toHaveBeenLastCalledWith(
      'resolved',
      { requestId: request.requestId, status: 'answered' },
      { scope: 'operator.read' },
    );
  });

  test('applies defaults or returns control to the model after the configured timeout', async () => {
    vi.useFakeTimers();
    const manager = new AskUserQuestionManager(logger);
    manager.setGatewayEventEmitter(vi.fn());
    const withDefaults = { ...question, defaultOptionIds: ['staging'] };

    expect(buildWaitPolicy(true, [withDefaults], 1)).toEqual({
      mode: 'timeout',
      timeoutMinutes: 1,
      onTimeout: 'use-defaults',
    });
    const defaulted = manager.request(
      [withDefaults],
      { mode: 'timeout', timeoutMinutes: 1, onTimeout: 'use-defaults' },
      'justdo:session-1',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(defaulted).resolves.toEqual({
      status: 'answered',
      answers: { deploy_target: { selected: ['staging'] } },
      timedOut: true,
    });

    const modelDecides = manager.request(
      [question],
      { mode: 'timeout', timeoutMinutes: 1, onTimeout: 'model-decides' },
      'justdo:session-1',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(modelDecides).resolves.toEqual({ status: 'timeout' });
  });

  test('does not publish a request after its run was already aborted', () => {
    const manager = new AskUserQuestionManager(logger);
    const emit = vi.fn();
    const controller = new AbortController();
    manager.setGatewayEventEmitter(emit);
    controller.abort();

    expect(() =>
      manager.request([question], { mode: 'required' }, 'justdo:session-1', controller.signal),
    ).toThrow();
    expect(manager.list()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  test('declares only timeout configuration and no callback transport', () => {
    const extensionDir = path.join(process.cwd(), 'openclaw-extensions', 'ask-user-question');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionDir, 'openclaw.plugin.json'), 'utf8'),
    ) as { configSchema: { properties: Record<string, unknown> } };
    const source = fs.readFileSync(path.join(extensionDir, 'index.ts'), 'utf8');

    expect(manifest.configSchema.properties).toEqual({
      timeoutMinutes: expect.objectContaining({ default: ASK_USER_TIMEOUT_MINUTES }),
    });
    expect(JSON.stringify(manifest)).not.toContain('callback');
    expect(JSON.stringify(manifest)).not.toContain('secret');
    expect(source).not.toContain("from 'node:http'");
    expect(source).not.toContain("from 'node:https'");
    expect(source).not.toContain('callbackUrl');
    expect(source).not.toContain('x-ask-user-secret');
  });
});

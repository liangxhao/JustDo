import { afterEach, describe, expect, test, vi } from 'vitest';

import plugin, {
  ASK_USER_QUESTION_DESCRIPTION,
  AskUserQuestionSchema,
  type AskUserRequest,
  type Question,
} from '../index';

const question: Question = {
  id: 'report_format',
  question: 'Which report format should I use?',
  options: [
    { id: 'markdown', label: 'Markdown (Recommended)' },
    { id: 'html', label: 'HTML' },
  ],
};

const createHarness = (pluginConfig?: { timeoutMinutes: number }) => {
  const registerService = vi.fn();
  const registerTool = vi.fn();
  const registerGatewayMethod = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  plugin.register({
    logger,
    pluginConfig,
    registerService,
    registerTool,
    registerGatewayMethod,
  } as never);
  const emit = vi.fn();
  const service = registerService.mock.calls[0][0];
  service.start({ gatewayEvents: { emit } });
  const tool = registerTool.mock.calls[0][0]({ sessionKey: 'agent:main:justdo:session-1' });
  const list = (): AskUserRequest[] => {
    const respond = vi.fn();
    registerGatewayMethod.mock.calls.find(([method]) => method === 'askUserQuestion.list')![1]({
      respond,
    });
    return respond.mock.calls[0][1].requests;
  };
  return { tool, service, emit, list, logger };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('AskUserQuestion tool timeout', () => {
  test('advertises a default timeout and requires explicit opt-out for essential answers', () => {
    expect(AskUserQuestionSchema.properties.timeoutEnabled.default).toBe(true);
    expect(ASK_USER_QUESTION_DESCRIPTION).toContain(
      'Set timeoutEnabled to false only when an explicit user answer is essential',
    );
    expect(ASK_USER_QUESTION_DESCRIPTION).toContain(
      'A question timeout alone is not a reason to pause or block an active goal.',
    );
  });

  test('keeps waiting only when timeoutEnabled is explicitly false', async () => {
    vi.useFakeTimers();
    const { tool, service, emit, list } = createHarness();
    const completed = vi.fn();
    const execution = tool.execute('call-required', {
      questions: [question],
      timeoutEnabled: false,
    });
    void execution.then(completed);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(completed).not.toHaveBeenCalled();
    expect(list()).toEqual([expect.objectContaining({ waitPolicy: { mode: 'required' } })]);
    expect(list()[0].expiresAt).toBeUndefined();
    expect(emit.mock.calls.map(([name]) => name)).toEqual(['requested']);
    service.stop();
    await execution;
  });

  test.each([undefined, true])(
    'returns control after ten minutes and releases the session when timeoutEnabled is %s',
    async timeoutEnabled => {
      vi.useFakeTimers();
      const { tool, service, emit, list } = createHarness();
      const completed = vi.fn();
      const execution = tool.execute('call-timeout', {
        questions: [question],
        ...(timeoutEnabled === undefined ? {} : { timeoutEnabled }),
      });
      void execution.then(completed);
      const request = list()[0];
      expect(request.waitPolicy).toEqual({
        mode: 'timeout',
        timeoutMinutes: 10,
        onTimeout: 'model-decides',
      });
      expect(request.expiresAt).toBe(Date.now() + 10 * 60_000);

      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(execution).resolves.toEqual({
        content: [
          {
            type: 'text',
            text: 'No answer arrived before the timeout; proceed with best judgment.',
          },
        ],
      });
      expect(list()).toEqual([]);
      expect(emit).toHaveBeenLastCalledWith(
        'resolved',
        { requestId: request.requestId, status: 'timeout' },
        { scope: 'operator.read' },
      );

      const next = tool.execute('call-next', { questions: [question] });
      expect(list()).toHaveLength(1);
      service.stop();
      await next;
    },
  );

  test('identifies default answers as automatic when every question defines a default', async () => {
    vi.useFakeTimers();
    const { tool, emit, list } = createHarness();
    const execution = tool.execute('call-defaults', {
      questions: [{ ...question, defaultOptionIds: ['markdown'] }],
    });
    const request = list()[0];

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(execution).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'The user did not respond before the timeout. The configured defaults were selected automatically.\n\nWhich report format should I use?\nUser selected: Markdown (Recommended)',
        },
      ],
    });
    expect(list()).toEqual([]);
    expect(emit).toHaveBeenLastCalledWith(
      'resolved',
      { requestId: request.requestId, status: 'answered' },
      { scope: 'operator.read' },
    );
  });

  test('returns best judgment instead of partial automatic answers when any question has no default', async () => {
    vi.useFakeTimers();
    const { tool, list } = createHarness();
    const execution = tool.execute('call-mixed', {
      questions: [
        { ...question, defaultOptionIds: ['markdown'] },
        { ...question, id: 'appendix', question: 'Which appendix format should I use?' },
      ],
    });
    expect(list()[0].waitPolicy).toMatchObject({ onTimeout: 'model-decides' });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(execution).resolves.toEqual({
      content: [
        { type: 'text', text: 'No answer arrived before the timeout; proceed with best judgment.' },
      ],
    });
    expect(list()).toEqual([]);
  });

  test('still returns the timeout result when publishing the resolution fails', async () => {
    vi.useFakeTimers();
    const { tool, emit, list, logger } = createHarness();
    const execution = tool.execute('call-publish-failure', {
      questions: [question],
    });
    emit.mockImplementation((name: string) => {
      if (name === 'resolved') throw new Error('event delivery failed');
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(execution).resolves.toMatchObject({
      content: [{ text: 'No answer arrived before the timeout; proceed with best judgment.' }],
    });
    expect(list()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  test('cancels the timeout when the owning run is aborted', async () => {
    vi.useFakeTimers();
    const { tool, emit, list } = createHarness();
    const controller = new AbortController();
    const execution = tool.execute('call-abort', { questions: [question] }, controller.signal);
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      content: [{ text: 'The question was cancelled; proceed with best judgment.' }],
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(list()).toEqual([]);
    expect(emit.mock.calls.filter(([name]) => name === 'resolved')).toHaveLength(1);
  });

  test('uses the configured wait time when the timeout flag is omitted', async () => {
    vi.useFakeTimers();
    const { tool, list } = createHarness({ timeoutMinutes: 2 });
    const execution = tool.execute('call-configured', { questions: [question] });
    expect(list()[0]).toMatchObject({
      waitPolicy: { mode: 'timeout', timeoutMinutes: 2 },
      expiresAt: Date.now() + 2 * 60_000,
    });

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    await expect(execution).resolves.toMatchObject({
      content: [{ text: 'No answer arrived before the timeout; proceed with best judgment.' }],
    });
    expect(list()).toEqual([]);
  });

  test.each([null, 'false', 0])(
    'rejects an invalid timeout flag instead of changing the wait policy: %s',
    async timeoutEnabled => {
      const { tool, service, list } = createHarness();
      try {
        await expect(
          tool.execute('call-invalid', { questions: [question], timeoutEnabled }),
        ).resolves.toMatchObject({ isError: true });
        expect(list()).toEqual([]);
      } finally {
        service.stop();
      }
    },
  );
});

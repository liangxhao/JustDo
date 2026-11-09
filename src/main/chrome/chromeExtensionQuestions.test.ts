import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { AskUserInteractionEvent } from '../../shared/cowork/interactions/askUserQuestion';
import { CoworkInteractionKind } from '../../shared/cowork/interactions/interactions';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { ChromeExtensionQuestions } from './chromeExtensionQuestions';

const fixture = () => {
  const source = { sessionKey: 'agent:main:justdo:one', nativeSessionId: 'physical',
    lifecycleRevision: 'revision', runId: 'run', toolCallId: 'call', agentId: 'main' };
  const questions = [{ id: 'target', question: 'Which targets?', multiSelect: true, allowOther: true,
    defaultOptionIds: ['prod'], options: [{ id: 'dev', label: 'Same', input: { label: 'Details' } },
      { id: 'prod', label: 'Same' }] }];
  const request = { requestId: 'ask_pending', questions, source, sessionKey: source.sessionKey,
    waitPolicy: { mode: 'timeout', timeoutMinutes: 10, onTimeout: 'use-defaults' }, expiresAt: Date.now() + 60_000 };
  const interaction = { sessionId: 'one', request: { requestId: request.requestId,
    toolName: 'ask_user_question', interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
    origin: { ...source, available: true, ownerSessionId: 'one' },
    toolInput: { ...request, sessionId: 'one' } } };
  const session = { id: 'one', source: CoworkSessionSource.ChromeExtension, agentId: 'main', cwd: '/task' };
  const client = { request: vi.fn(async () => ({ session: { key: source.sessionKey, sessionId: source.nativeSessionId,
    lifecycleRevision: source.lifecycleRevision } })) };
  let generation = 1;
  const runtime = Object.assign(new EventEmitter(), {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => generation,
    listPendingStructuredQuestions: vi.fn(async () => [interaction]),
    resolveAskUserInteraction: vi.fn(async (_id, _response, options) => { options.assertCurrent(); }),
  });
  const bridge = new ChromeExtensionQuestions({ getSession: () => session as never, getRuntime: () => runtime as never });
  return { bridge, interaction, session, source, request, client, runtime, retire: () => { generation++; } };
};

describe('Chrome native pending question views', () => {
  it('preserves full question IDs and richer answers while reusing the runtime answer authority', async () => {
    const f = fixture();
    const current = vi.fn();
    await expect(f.bridge.list('one', current)).resolves.toEqual([{
      requestId: f.request.requestId, questions: f.request.questions,
      waitPolicy: f.request.waitPolicy, expiresAt: f.request.expiresAt,
    }]);
    const answer = { behavior: 'submit' as const, answers: { target: {
      selected: ['dev', 'prod'], optionInputs: { dev: 'Details' }, other: 'Another',
    } } };
    await f.bridge.respond('one', f.request.requestId, answer, current);
    expect(f.runtime.resolveAskUserInteraction).toHaveBeenCalledExactlyOnceWith(f.request.requestId, answer,
      { assertCurrent: expect.any(Function) });
    expect(f.client.request).toHaveBeenCalledWith('sessions.describe', { key: f.source.sessionKey });
  });

  it.each(['another thread', 'plugin', 'source mismatch', 'physical session', 'revision', 'not available'])(
    'hides %s without claiming another execution', async kind => {
      const f = fixture();
      if (kind === 'another thread') f.interaction.sessionId = 'other';
      if (kind === 'plugin') Object.assign(f.interaction.request.toolInput.source, { ownerPluginId: 'team' });
      if (kind === 'source mismatch') f.interaction.request.origin.toolCallId = 'other';
      if (kind === 'not available') f.interaction.request.origin.available = false;
      if (kind === 'physical session' || kind === 'revision') f.client.request.mockResolvedValue({ session: {
        key: f.source.sessionKey, sessionId: kind === 'physical session' ? 'other' : f.source.nativeSessionId,
        lifecycleRevision: kind === 'revision' ? 'other' : f.source.lifecycleRevision,
      } });
      await expect(f.bridge.list('one', vi.fn())).resolves.toEqual([]);
      await expect(f.bridge.respond('one', f.request.requestId, { behavior: 'cancel' }, vi.fn()))
        .rejects.toThrow('no longer available');
      expect(f.runtime.resolveAskUserInteraction).not.toHaveBeenCalled();
    },
  );

  it('rejects a read whose connection changes during native identity verification', async () => {
    const f = fixture();
    f.client.request.mockImplementationOnce(async () => {
      f.retire();
      return { session: { key: f.source.sessionKey, sessionId: f.source.nativeSessionId, lifecycleRevision: f.source.lifecycleRevision } };
    });
    await expect(f.bridge.list('one', vi.fn())).rejects.toThrow('connection changed');
  });

  it('keeps the subscription guard live through the final runtime answer admission', async () => {
    const f = fixture();
    let current = true;
    f.runtime.resolveAskUserInteraction.mockImplementationOnce(async (_id, _response, options) => {
      current = false;
      options.assertCurrent();
    });
    await expect(f.bridge.respond('one', f.request.requestId, { behavior: 'cancel' }, () => {
      if (!current) throw new Error('Unsubscribed');
    })).rejects.toThrow('Unsubscribed');
  });

  it('publishes invalidations only for its thread and cleans up without answering', async () => {
    const f = fixture();
    const changed = vi.fn();
    const dispose = await f.bridge.subscribe('one', changed);
    f.runtime.emit(AskUserInteractionEvent.Changed, { sessionId: 'other' });
    expect(changed).not.toHaveBeenCalled();
    f.runtime.emit(AskUserInteractionEvent.Changed, { sessionId: 'one' });
    f.runtime.emit(AskUserInteractionEvent.Changed, { requestId: 'resolved' });
    f.runtime.emit('gatewayReady');
    expect(changed).toHaveBeenCalledTimes(3);
    dispose();
    f.runtime.emit(AskUserInteractionEvent.Changed, { sessionId: 'one' });
    expect(changed).toHaveBeenCalledTimes(3);
    expect(f.runtime.resolveAskUserInteraction).not.toHaveBeenCalled();
  });
});

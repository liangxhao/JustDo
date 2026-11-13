import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { AUTOMATIC_ERROR_RETRY_FAILURE_METHOD } from '../../engine/openclaw/automaticErrorRetry/failureCode';
import { REPEATED_TOOL_ERROR_CODE } from '../../engine/openclaw/automaticErrorRetry/rules';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { AcpProgress } from '../cli/acpProgress';
import { createExternalAgentExecution } from './externalAgentExecution';
import {
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentTypes';

afterEach(() => vi.useRealTimers());

function fixture(timing?: Parameters<typeof createExternalAgentExecution>[1], maxContinuations = 0) {
  const runtime = new EventEmitter();
  const session = {
    id: 'local',
    agentId: 'assistant',
    cwd: '/task',
    permissionMode: 'ask',
    modelRef: 'provider/old',
  };
  const store = {
    getSession: vi.fn(() => session),
    beginSessionRun: vi.fn(() => ({ id: 'timing' })),
    finishSessionRun: vi.fn(),
    updateSession: vi.fn(),
    getAgentRuntimeSettings: () => ({ automaticErrorRetry: { maxContinuations } }),
  };
  const identity: { sessionId: string; lifecycleRevision: string; activeRunIds?: string[]; lastRunId?: string } = {
    sessionId: 'native-id',
    lifecycleRevision: 'revision-1',
  };
  let finishAgent!: (value: unknown) => void;
  let finishReceipt!: (value: unknown) => void;
  const request = vi.fn(
    (
      method: string,
      _params?: unknown,
      _options?: Parameters<GatewayClientLike['request']>[2],
    ): Promise<unknown> => {
      if (method === 'sessions.describe') return Promise.resolve({ session: { key: 'native-key', ...identity } });
      if (method === AUTOMATIC_ERROR_RETRY_FAILURE_METHOD)
        return Promise.resolve({ ..._params as object, identityMatched: true, errorCode: REPEATED_TOOL_ERROR_CODE });
      if (method === 'agent' || method === 'chat.send')
        return new Promise(resolve => {
          finishAgent = resolve;
        });
      if (method === 'agent.wait')
        return new Promise(resolve => {
          finishReceipt = resolve;
        });
      return Promise.resolve({});
    },
  );
  let current = { request } as unknown as GatewayClientLike;
  const patchSessionModel = vi.fn(async (_id: string, model: string) => {
    session.modelRef = model;
    return { ok: true, modelRef: model };
  });
  const registerUnknownSessionRun = vi.fn();
  const fetchSessionHistoryByKey = vi.fn(async () => ({ sessionKey: 'native-key', messages: [] as unknown[] }));
  const publishAutomaticErrorRetry = vi.fn();
  Object.assign(runtime, {
    ensureReady: async () => {},
    getGatewayClient: () => current,
    getGatewayClientGeneration: () => 1,
    captureGatewayResponseContext: () => {
      const source = current;
      return { isCurrent: () => current === source, isResponseError: () => false };
    },
    patchSessionModel,
    registerUnknownSessionRun,
    fetchSessionHistoryByKey,
    publishAutomaticErrorRetry,
  });
  const router = {
    isSessionActive: () => false,
    prepareSession: vi.fn(async (..._args: Parameters<CoworkEngineRouter['prepareSession']>) => ({
      sessionKey: 'native-key',
      gatewaySessionId: 'native-id',
    })),
  };
  const execute = createExternalAgentExecution(
    {
      getStore: () => store as unknown as CoworkStore,
      getRouter: () => router as unknown as CoworkEngineRouter,
      getRuntime: () => runtime as OpenClawRuntimeAdapter,
      ensureReady: async () => ({ phase: 'running' }),
    },
    timing,
  );
  const controller = new AbortController();
  const onEvent = vi.fn();
  const onUnconfirmed = vi.fn();
  const onSettled = vi.fn();
  const cleanup = vi.fn();
  const onPrepared = vi.fn(async () => cleanup);
  const input = {
    sessionId: 'local',
    runId: 'run',
    message: 'task',
    modelRef: 'provider/selected',
    signal: controller.signal,
    onEvent,
    onUnconfirmed,
    onSettled,
    hooks: { onPrepared },
  };
  return {
    runtime,
    store,
    router,
    identity,
    request,
    patchSessionModel,
    execute,
    input,
    controller,
    onEvent,
    onUnconfirmed,
    onSettled,
    cleanup,
    onPrepared,
    registerUnknownSessionRun,
    fetchSessionHistoryByKey,
    publishAutomaticErrorRetry,
    finishAgent: (value: unknown) => finishAgent(value),
    finishReceipt: (value: unknown) => finishReceipt(value),
    replaceClient: (replacement: GatewayClientLike) => {
      current = replacement;
    },
  };
}

const final = { status: 'ok', result: { payloads: [{ text: 'Answer' }] } };
const receipt = {
  runId: 'run',
  status: 'ok',
  endedAt: 100,
  terminalReply: { disposition: 'visible', text: 'Confirmed answer' },
};

const fullReply = 'A'.repeat(5000) + ' FINAL-SUFFIX';
const cappedReply = fullReply.slice(0, 4095) + '…';
const fullResponse = (text = fullReply, snapshot = cappedReply) => ({
  runId: 'run',
  status: 'ok',
  result: {
    meta: { terminalReply: { disposition: 'visible', text: snapshot } },
    payloads: [{ text }],
  },
});
const cappedReceipt = { ...receipt, terminalReply: { disposition: 'visible', text: cappedReply } };
const repeatedToolFailureCopy =
  'OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.';
const emitTerminal = (f: ReturnType<typeof fixture>, text = cappedReply, seq = 1) =>
  f.runtime.emit('gatewayEvent', {
    event: 'agent',
    payload: {
      seq,
      sessionKey: 'native-key',
      sessionId: 'native-id',
      runId: 'run',
      lifecycleGeneration: 'generation-1',
      stream: 'lifecycle',
      data: {
        phase: 'end',
        executionSettled: true,
        terminalReply: { disposition: 'visible', text },
      },
    },
  });

describe('external execution ownership', () => {
  it('continues one logical external request with exact fresh native attempts and keeps errors internal until final failure', async () => {
    const f = fixture({ retryDelayMs: 0 }, 2);
    f.identity.activeRunIds = [];
    const onRetryPrepared = vi.fn();
    const onRetry = vi.fn();
    const outcome = f.execute({
      ...f.input, isRetryCurrent: () => true, onRetryPrepared,
      hooks: { ...f.input.hooks, interactiveApprovals: true, onRetry },
      attachments: [{ name: 'photo.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }],
    });
    const rejected = expect(outcome).rejects.toThrow('final failure');
    const agentCalls = () => f.request.mock.calls.filter(([method]) => method === 'agent');
    let runId = f.input.runId;
    for (const attempt of [0, 1, 2]) {
      await vi.waitFor(() => expect(agentCalls()).toHaveLength(attempt + 1));
      const [, params] = agentCalls()[attempt];
      const id = (params as { idempotencyKey: string }).idempotencyKey;
      if (attempt) {
        expect(id).not.toBe(runId);
        expect(onRetryPrepared).toHaveBeenNthCalledWith(attempt, runId, id);
        expect(params).toEqual(expect.objectContaining({
          channel: 'webchat', deliver: false, suppressPromptPersistence: true,
          expectedExistingSessionId: 'native-id', expectedExistingSessionLifecycleRevision: 'revision-1',
          inputProvenance: { kind: 'internal_system', sourceTool: 'execution-error-retry' },
        }));
        expect(params).not.toHaveProperty('attachments');
        expect(f.cleanup).toHaveBeenCalledTimes(attempt);
        expect(f.onEvent.mock.calls.flatMap(([event]) => event.data.error ?? [])).toEqual([]);
      }
      runId = id;
      f.identity.lastRunId = id;
      const emit = (seq: number, stream: string, data: Record<string, unknown>) => f.runtime.emit('gatewayEvent', {
        event: 'agent',
        payload: {
          runId: id, sessionKey: 'native-key', sessionId: 'native-id', lifecycleGeneration: 'generation-1',
          seq, stream, data,
        },
      });
      if (!attempt) emit(1, 'assistant', {
        itemId: 'scoped', assistantTextScope: { id: 'model-output' },
        text: repeatedToolFailureCopy, delta: repeatedToolFailureCopy,
      });
      emit(2, 'assistant', {
        itemId: 'native-failure', text: repeatedToolFailureCopy,
        ...(attempt ? { delta: '', replace: true } : { delta: repeatedToolFailureCopy }),
      });
      emit(3, 'lifecycle', { phase: 'finishing', livenessState: 'blocked', error: repeatedToolFailureCopy });
      emit(4, 'lifecycle', {
        phase: 'error', executionSettled: true, error: attempt === 2 ? 'final failure' : repeatedToolFailureCopy,
      });
    }
    await rejected;
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(f.onSettled).toHaveBeenCalledExactlyOnceWith('failed');
    const output = f.onEvent.mock.calls.map(([event]) => ({ runId: event.runId, data: event.data }));
    expect(output.filter(event => event.data.text)).toEqual([{
      runId: f.input.runId,
      data: expect.objectContaining({ itemId: 'scoped', text: repeatedToolFailureCopy }),
    }]);
    expect(output.filter(event => event.data.phase === 'finishing')).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ data: { phase: 'finishing', livenessState: 'blocked' } })),
    );
    expect(output.filter(event => event.data.error)).toEqual([{
      runId, data: expect.objectContaining({ error: 'final failure' }),
    }]);
    expect(f.publishAutomaticErrorRetry).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'failed', attempt: 2, runs: [
        expect.objectContaining({ disposition: 'superseded' }),
        expect.objectContaining({ disposition: 'superseded' }),
        expect.objectContaining({ disposition: 'final' }),
      ],
    }));
  });

  it.each([0, 1])('delivers genuine unscoped assistant copy on success with %i retries configured', async maxContinuations => {
    const f = fixture(undefined, maxContinuations);
    const outcome = f.execute({ ...f.input, isRetryCurrent: () => true });
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1));
    f.runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        seq: 1, sessionKey: 'native-key', sessionId: 'native-id', runId: 'run',
        lifecycleGeneration: 'generation-1', stream: 'assistant',
        data: { itemId: 'model-output', text: repeatedToolFailureCopy, delta: repeatedToolFailureCopy },
      },
    });
    await Promise.resolve();
    expect(f.onEvent).toHaveBeenCalledTimes(maxContinuations ? 0 : 1);
    f.runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        seq: 2, sessionKey: 'native-key', sessionId: 'native-id', runId: 'run',
        lifecycleGeneration: 'generation-1', stream: 'tool', data: { phase: 'start', toolCallId: 'lookup' },
      },
    });
    await vi.waitFor(() => expect(f.onEvent).toHaveBeenCalledTimes(2));
    emitTerminal(f, repeatedToolFailureCopy, 3);
    await expect(outcome).resolves.toBe(repeatedToolFailureCopy);
    expect(f.onEvent.mock.calls.map(([event]) => event.stream)).toEqual(['assistant', 'tool', 'lifecycle']);
    expect(f.onEvent.mock.calls[0][0].data.text).toBe(repeatedToolFailureCopy);
  });

  it.each([true, false])('selects the requested model before dispatch, with first native creation %s', async fresh => {
    const f = fixture();
    const outcome = f.execute({ ...f.input, ...(fresh ? { initialSession: true } : {
      expectedBinding: { sessionKey: 'native-key', sessionId: 'native-id', lifecycleRevision: 'revision-1' },
    }) });
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1));
    if (fresh) {
      expect(f.router.prepareSession).toHaveBeenCalledWith('local', expect.objectContaining({
        modelRef: f.input.modelRef,
      }));
      expect(f.patchSessionModel).not.toHaveBeenCalled();
    } else {
      expect(f.router.prepareSession).toHaveBeenCalledWith('local', expect.objectContaining({ expectedSessionId: 'native-id' }));
      expect(f.router.prepareSession.mock.calls[0][1]).not.toHaveProperty('modelRef');
      expect(f.patchSessionModel).toHaveBeenCalledWith('local', f.input.modelRef, 'assistant');
    }
    emitTerminal(f);
    f.finishAgent(fullResponse());
    await expect(outcome).resolves.toBe(fullReply);
  });

  it('cancels an external retry during its delay without issuing another native request', async () => {
    const f = fixture({ retryDelayMs: 5000 }, 1);
    f.identity.activeRunIds = [];
    f.identity.lastRunId = f.input.runId;
    const rejected = expect(f.execute({ ...f.input, isRetryCurrent: () => true }))
      .rejects.toBeInstanceOf(ExternalAgentCancelledError);
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1));
    f.runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        runId: f.input.runId, sessionKey: 'native-key', sessionId: 'native-id', lifecycleGeneration: 'generation-1',
        seq: 1, stream: 'lifecycle', data: { phase: 'error', executionSettled: true, error: 'retryable' },
      },
    });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith(
      AUTOMATIC_ERROR_RETRY_FAILURE_METHOD, expect.anything(), expect.anything(),
    ));
    f.controller.abort();
    await rejected;
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    expect(f.publishAutomaticErrorRetry).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'cancelled' }));
  });

  it('keeps the exact successor pending after losing its send outcome and does not use the remaining allowance', async () => {
    const f = fixture({ retryDelayMs: 0, timeoutMs: 100, pollIntervalMs: 20 }, 2);
    f.identity.activeRunIds = [];
    f.identity.lastRunId = f.input.runId;
    const outcome = f.execute({ ...f.input, isRetryCurrent: () => true });
    const rejected = expect(outcome).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
    const agentCalls = () => f.request.mock.calls.filter(([method]) => method === 'agent');
    await vi.waitFor(() => expect(agentCalls()).toHaveLength(1));
    f.runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        runId: f.input.runId, sessionKey: 'native-key', sessionId: 'native-id', lifecycleGeneration: 'generation-1',
        seq: 1, stream: 'lifecycle', data: { phase: 'error', executionSettled: true, error: 'retryable' },
      },
    });
    await vi.waitFor(() => expect(agentCalls()).toHaveLength(2));
    const nativeSuccessor = (agentCalls()[1][1] as { idempotencyKey: string }).idempotencyKey;
    f.finishAgent({ status: 'ok', runId: nativeSuccessor });
    await rejected;
    expect(agentCalls()).toHaveLength(2);
    expect(f.onSettled).not.toHaveBeenCalled();
    expect(f.registerUnknownSessionRun).toHaveBeenCalledWith('local', nativeSuccessor, { cancelled: false });
    expect(f.publishAutomaticErrorRetry).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'unknown', attempt: 1, runs: [
        expect.objectContaining({ runId: f.input.runId, disposition: 'pending' }),
        expect.objectContaining({ runId: nativeSuccessor, disposition: 'pending' }),
      ],
    }));
  });

  it('passes real image bytes through the native agent RPC while retaining its revision CAS', async () => {
    const f = fixture();
    const attachments = [{ name: 'photo.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }];
    const task = f.execute({ ...f.input, attachments });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('agent', expect.objectContaining({
      message: 'task', attachments: [{ type: 'image', mimeType: 'image/png', fileName: 'photo.png', content: 'aW1hZ2U=' }],
      expectedExistingSessionId: 'native-id', expectedExistingSessionLifecycleRevision: 'revision-1',
    }), expect.anything()));
    f.finishAgent(final);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('agent.wait', expect.anything()));
    f.finishReceipt(receipt);
    await expect(task).resolves.toBe('Confirmed answer');
    expect(f.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(0);
  });

  it('admits image-only input through chat.send without placeholder text and activates prepared approval ownership after ACK', async () => {
    const f = fixture();
    const task = f.execute({ ...f.input, message: '', attachments: [{ name: 'photo.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }] });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      message: '', sessionKey: 'native-key', sessionId: 'native-id', idempotencyKey: 'run',
      deliver: false, attachments: [{ type: 'image', mimeType: 'image/png', fileName: 'photo.png', content: 'aW1hZ2U=' }],
    }), expect.anything()));
    const binding = f.onPrepared.mock.calls[0][0] as unknown as { runIdReady: Promise<string | undefined> };
    let ready = false;
    void binding.runIdReady.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    f.finishAgent({ status: 'started', runId: 'run' });
    await expect(binding.runIdReady).resolves.toBe('run');
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('agent.wait', expect.anything()));
    f.finishReceipt(receipt);
    await expect(task).resolves.toBe('Confirmed answer');
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
  });

  it.each(['revision', 'runId'])('retains an uncertain media admission after a changed %s without retry or approval activation', async kind => {
    const f = fixture();
    const task = f.execute({ ...f.input, message: '', attachments: [{ name: 'photo.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }] });
    const failed = expect(task).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(true));
    const binding = f.onPrepared.mock.calls[0][0] as unknown as { runIdReady: Promise<string | undefined> };
    if (kind === 'revision') f.identity.lifecycleRevision = 'replacement';
    f.finishAgent({ status: 'started', runId: kind === 'runId' ? 'foreign-run' : 'run' });
    await failed;
    await expect(binding.runIdReady).resolves.toBeUndefined();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.registerUnknownSessionRun).toHaveBeenCalledWith('local', 'run', expect.anything());
    expect(f.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([method]) => method === 'agent.wait')).toHaveLength(0);
  });

  it('recovers a long media-only reply solely from one exact native final message and all of its text blocks', async () => {
    const f = fixture();
    const completeText = fullReply + '\nFinal second block';
    f.fetchSessionHistoryByKey.mockResolvedValue({ sessionKey: 'native-key', messages: [
      { role: 'assistant', phase: 'final_answer', content: [{ type: 'text', text: 'Foreign reply' }], __openclaw: { runId: 'foreign-run' } },
      { role: 'assistant', phase: 'commentary', content: 'Working', __openclaw: { runId: 'run' } },
      { role: 'assistant', phase: 'final_answer', content: [{ type: 'text', text: fullReply }, { type: 'text', text: 'Final second block' }], __openclaw: { runId: 'run' } },
    ] });
    const task = f.execute({ ...f.input, message: '', attachments: [{ name: 'photo.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }] });
    await vi.waitFor(() => expect(f.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(true));
    f.finishAgent({ status: 'started', runId: 'run' });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('agent.wait', expect.anything()));
    f.finishReceipt(cappedReceipt);
    await expect(task).resolves.toBe(completeText);
    expect(f.fetchSessionHistoryByKey).toHaveBeenCalledWith('native-key', undefined, expect.objectContaining({ forceFullSnapshot: true, signal: expect.any(AbortSignal) }));
    expect(f.onSettled).toHaveBeenCalledWith('completed');
  });

  it.each(['foreign-run', 'identity-change', 'commentary', 'ambiguous-final', 'mismatched-snapshot', 'conflicting-stamps'])
  ('does not fill a capped media reply from unsafe history: %s', async reason => {
    const f = fixture();
    f.fetchSessionHistoryByKey.mockImplementation(async () => {
      if (reason === 'identity-change') f.identity.lifecycleRevision = 'replacement';
      const message = { role: 'assistant', phase: reason === 'commentary' ? 'commentary' : 'final_answer',
        content: reason === 'mismatched-snapshot' ? 'Other prefix' + fullReply : fullReply,
        ...(reason === 'conflicting-stamps' ? { runId: 'foreign-run' } : {}),
        __openclaw: { runId: reason === 'foreign-run' ? 'foreign-run' : 'run' } };
      return { sessionKey: 'native-key', messages: reason === 'ambiguous-final' ? [message, message] : [message] };
    });
    const task = f.execute({ ...f.input, message: '', attachments: [{ name: 'photo.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }] });
    const failed = expect(task).rejects.toBeInstanceOf(ExternalAgentStreamError);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(true));
    f.finishAgent({ status: 'started', runId: 'run' });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('agent.wait', expect.anything()));
    f.finishReceipt(cappedReceipt);
    await failed;
    expect(f.onSettled).toHaveBeenCalledWith('completed');
    expect(f.store.finishSessionRun).toHaveBeenCalledExactlyOnceWith('timing', 'completed', expect.any(Number));
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
  });
  it.each([false, true])(
    'declares an interactive approval surface only with an explicit flag (%s) after preparation',
    async interactive => {
      const f = fixture();
      let prepared!: (value: typeof f.cleanup) => void;
      f.onPrepared.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            prepared = resolve;
          }),
      );
      const running = f.execute({
        ...f.input,
        hooks: {
          onPrepared: f.onPrepared,
          ...(interactive ? { interactiveApprovals: true as const } : {}),
        },
      });
      await vi.waitFor(() => expect(f.onPrepared).toHaveBeenCalledOnce());
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(false);
      prepared(f.cleanup);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
      );
      const params = f.request.mock.calls.find(([method]) => method === 'agent')![1];
      if (interactive) expect(params).toMatchObject({ channel: 'webchat', deliver: false });
      else {
        expect(params).not.toHaveProperty('channel');
        expect(params).not.toHaveProperty('deliver');
      }
      f.finishAgent(final);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
      );
      f.finishReceipt(receipt);
      await expect(running).resolves.toBe('Confirmed answer');
      expect(f.cleanup).toHaveBeenCalledOnce();
    },
  );

  it('does not submit an interactive run when approval preparation fails', async () => {
    const f = fixture();
    f.onPrepared.mockRejectedValueOnce(new Error('Approval route unavailable.'));
    await expect(
      f.execute({
        ...f.input,
        hooks: { interactiveApprovals: true, onPrepared: f.onPrepared },
      }),
    ).rejects.toThrow('Approval route unavailable.');
    expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(false);
    expect(f.store.beginSessionRun).not.toHaveBeenCalled();
    expect(f.registerUnknownSessionRun).not.toHaveBeenCalled();
    expect(f.runtime.listenerCount('gatewayEvent')).toBe(0);
  });

  it('recovers a long final reply from the same completed RPC and its matching producer snapshot', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    f.finishAgent(fullResponse());
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    f.finishReceipt(cappedReceipt);

    await expect(running).resolves.toBe(fullReply);
    expect(f.onSettled).toHaveBeenCalledWith('completed');
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  });

  it('waits briefly for the same final RPC after live settlement without duplicating its ACP text', async () => {
    const f = fixture({ outputRecoveryTimeoutMs: 1000 });
    const updates = vi.fn();
    const progress = new AcpProgress(updates);
    const running = f.execute({ ...f.input, onEvent: event => progress.accept(event) });
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    const finalSignal = f.request.mock.calls.find(([method]) => method === 'agent')![2]!.signal!;
    f.runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        seq: 1,
        sessionKey: 'native-key',
        sessionId: 'native-id',
        runId: 'run',
        stream: 'assistant',
        data: { text: fullReply, assistantTextScope: { id: 'final-answer' } },
      },
    });
    emitTerminal(f, cappedReply, 2);
    await vi.waitFor(() => expect(f.onSettled).toHaveBeenCalledWith('completed'));
    expect(finalSignal.aborted).toBe(false);
    f.finishAgent(fullResponse());

    const text = await running;
    progress.finish(text);
    expect(text).toBe(fullReply);
    expect(updates.mock.calls.map(([value]) => value.content.text)).toEqual([fullReply]);
    expect(f.onSettled).toHaveBeenCalledOnce();
  });

  it('bounds a hung final RPC after known settlement and consumes its cancellation rejection', async () => {
    const f = fixture({ outputRecoveryTimeoutMs: 1000 });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, options) =>
      method === 'agent'
        ? new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new Error('Final waiter retired')),
              { once: true },
            );
          })
        : original(method, params, options),
    );
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    const rejected = expect(running).rejects.toBeInstanceOf(ExternalAgentStreamError);
    vi.useFakeTimers();
    emitTerminal(f);
    await vi.advanceTimersByTimeAsync(1000);

    await rejected;
    expect(f.onSettled).toHaveBeenCalledExactlyOnceWith('completed');
    expect(f.store.finishSessionRun).toHaveBeenCalledWith(
      'timing',
      'completed',
      expect.any(Number),
    );
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    expect(f.request.mock.calls.find(([method]) => method === 'agent')![2]!.signal!.aborted).toBe(
      true,
    );
  });

  it.each(['run', 'producer', 'payload', 'unbound-tail', 'yielded'])(
    'does not promote a capped snapshot to complete output with mismatched %s evidence',
    async mismatch => {
      const f = fixture();
      const response = fullResponse();
      if (mismatch === 'run') response.runId = 'other-run';
      if (mismatch === 'producer')
        response.result.meta.terminalReply.text = 'Different final reply';
      if (mismatch === 'payload') response.result.payloads[0].text = 'B' + fullReply.slice(1);
      if (mismatch === 'unbound-tail') {
        response.result.payloads[0].text = fullReply.slice(0, 4095) + ' OLD ATTEMPT TAIL';
        response.result.meta.terminalReply.text = 'Different producer';
      }
      if (mismatch === 'yielded') Object.assign(response.result.meta, { yielded: true });
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params, options) =>
        method === 'agent' ? Promise.resolve(response) : original(method, params, options),
      );
      const running = f.execute(f.input);
      if (mismatch === 'yielded') {
        await vi.waitFor(() =>
          expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
        );
        // Exact live settlement supplies the non-yielded whole-run outcome;
        // the separate final RPC still cannot supply a yielded output payload.
        emitTerminal(f);
      } else {
        await vi.waitFor(() =>
          expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
        );
        f.finishReceipt(cappedReceipt);
      }

      await expect(running).rejects.toBeInstanceOf(ExternalAgentStreamError);
      expect(f.onSettled).toHaveBeenCalledExactlyOnceWith('completed');
      expect(f.store.finishSessionRun).toHaveBeenCalledWith(
        'timing',
        'completed',
        expect.any(Number),
      );
    },
  );

  it('matches native UTF-16-safe truncation when a capped reply is shorter than 4096 characters', async () => {
    const f = fixture();
    const text = 'A'.repeat(4094) + '😀' + 'remaining'.repeat(200);
    const snapshot = 'A'.repeat(4094) + '…';
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    f.finishAgent(fullResponse(text, snapshot));
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    f.finishReceipt({ ...receipt, terminalReply: { disposition: 'visible', text: snapshot } });

    await expect(running).resolves.toBe(text);
  });

  it.each(['sessionId', 'lifecycleRevision'] as const)(
    'prevents native admission when %s changes after the final identity read',
    async field => {
      const f = fixture();
      const original = f.request.getMockImplementation()!;
      let admitted = false;
      f.request.mockImplementation((method, params, options) => {
        if (method === 'sessions.messages.subscribe') {
          f.identity[field] = 'replacement';
          return Promise.resolve({});
        }
        if (method === 'agent') {
          const input = params as {
            expectedExistingSessionId?: string;
            expectedExistingSessionLifecycleRevision?: string;
          };
          if (
            input.expectedExistingSessionId !== undefined &&
            (input.expectedExistingSessionId !== f.identity.sessionId ||
              (input.expectedExistingSessionLifecycleRevision !== undefined &&
                input.expectedExistingSessionLifecycleRevision !== f.identity.lifecycleRevision))
          ) {
            return Promise.reject(new Error('Native admission rejected a changed session.'));
          }
          admitted = true;
          return Promise.resolve(final);
        }
        return original(method, params, options);
      });
      await expect(f.execute(f.input)).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
      expect(admitted).toBe(false);
      expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    },
  );

  it.each(['unavailable', 'hung-query', 'missing-receipt'])(
    'bounds reconciliation for %s without inventing settlement',
    async mode => {
      const f = fixture({ timeoutMs: 1000, pollIntervalMs: 100 });
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(method =>
        method === 'agent.wait'
          ? mode === 'hung-query'
            ? new Promise(() => {})
            : Promise.resolve({ runId: 'run', status: 'timeout' })
          : original(method),
      );
      const running = f.execute(f.input);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
      );
      vi.useFakeTimers();
      if (mode === 'unavailable')
        Object.assign(f.runtime, {
          ensureReady: () => Promise.reject(new Error('Gateway unavailable')),
        });
      const rejected = expect(running).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
      f.finishAgent(final);
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(f.store.finishSessionRun).not.toHaveBeenCalled();
      expect(f.onSettled).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
      f.controller.abort();
      expect(f.request).toHaveBeenCalledWith('sessions.abort', { key: 'native-key', runId: 'run' });
    },
  );

  it.each(['session-projection', 'pending-receipt'])(
    'does not impose a task deadline while %s proves the exact run remains active',
    async proof => {
      const f = fixture({ timeoutMs: 1000, pollIntervalMs: 100 });
      if (proof === 'session-projection') f.identity.activeRunIds = ['run'];
      let completed = false;
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(method =>
        method === 'agent.wait'
          ? Promise.resolve(
              completed
                ? receipt
                : { runId: 'run', status: proof === 'pending-receipt' ? 'pending' : 'timeout' },
            )
          : original(method),
      );
      const running = f.execute(f.input);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
      );
      vi.useFakeTimers();
      f.finishAgent(final);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.store.finishSessionRun).not.toHaveBeenCalled();
      expect(f.onSettled).not.toHaveBeenCalled();
      completed = true;
      f.identity.activeRunIds = [];
      await vi.advanceTimersByTimeAsync(100);
      await expect(running).resolves.toBe('Confirmed answer');
      expect(f.onSettled).toHaveBeenCalledWith('completed');
    },
  );

  it.each(['agent', 'agent.wait'])(
    'wakes a pending %s read on exact live settlement and ignores its late conflicting reply',
    async pending => {
      const f = fixture({ timeoutMs: 100, pollIntervalMs: 10 });
      const running = f.execute(f.input);
      const outcome = running.then(
        value => ({ value }),
        error => ({ error }),
      );
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
      );
      const finalWaitSignal = f.request.mock.calls.find(([method]) => method === 'agent')![2]!
        .signal!;
      const retiredFinalWait = vi.fn();
      finalWaitSignal.addEventListener('abort', retiredFinalWait);
      if (pending === 'agent.wait') {
        f.finishAgent(final);
        await vi.waitFor(() =>
          expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
        );
      }
      vi.useFakeTimers();
      f.runtime.emit('gatewayEvent', {
        event: 'agent',
        payload: {
          seq: 1,
          sessionKey: 'native-key',
          sessionId: 'native-id',
          runId: 'run',
          lifecycleGeneration: 'generation-1',
          stream: 'lifecycle',
          data: {
            phase: 'end',
            executionSettled: true,
            terminalReply: { disposition: 'visible', text: 'Live answer' },
          },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onSettled).toHaveBeenCalledWith('completed');
      expect(await outcome).toEqual({ value: 'Live answer' });
      expect(retiredFinalWait).toHaveBeenCalledTimes(pending === 'agent' ? 1 : 0);
      expect(f.controller.signal.aborted).toBe(false);
      expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);

      if (pending === 'agent') f.finishAgent({ status: 'error', summary: 'Late failure' });
      else f.finishReceipt({ runId: 'run', status: 'error', endedAt: 100, error: 'Late failure' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.store.finishSessionRun).toHaveBeenCalledExactlyOnceWith(
        'timing',
        'completed',
        expect.any(Number),
      );
      expect(f.onSettled).toHaveBeenCalledTimes(1);
      expect(f.cleanup).toHaveBeenCalledTimes(1);
      expect(f.registerUnknownSessionRun).not.toHaveBeenCalled();
      expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    },
  );

  it.each(['agent', 'agent.wait'])(
    'rechecks native incarnation after a live terminal wakes %s',
    async pending => {
      const f = fixture({ timeoutMs: 100, pollIntervalMs: 10 });
      const running = f.execute(f.input);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
      );
      if (pending === 'agent.wait') {
        f.finishAgent(final);
        await vi.waitFor(() =>
          expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
        );
      }
      const rejected = expect(running).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
      f.identity.lifecycleRevision = 'replacement-revision';
      f.runtime.emit('gatewayEvent', {
        event: 'agent',
        payload: {
          seq: 1,
          sessionKey: 'native-key',
          sessionId: 'native-id',
          runId: 'run',
          lifecycleGeneration: 'generation-1',
          stream: 'lifecycle',
          data: {
            phase: 'end',
            executionSettled: true,
            terminalReply: { disposition: 'visible', text: 'Old incarnation reply' },
          },
        },
      });
      await rejected;
      expect(f.store.finishSessionRun).not.toHaveBeenCalled();
      expect(f.onSettled).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
      f.controller.abort();
      expect(f.request).toHaveBeenCalledWith('sessions.abort', { key: 'native-key', runId: 'run' });
    },
  );

  it('releases a possibly admitted subscription when its ACK arrives after live settlement', async () => {
    const f = fixture({ timeoutMs: 100, pollIntervalMs: 10 });
    let acknowledgeSubscription!: () => void;
    const replacementRequest = vi.fn((method: string) => {
      if (method === 'sessions.describe') return Promise.resolve({ session: { ...f.identity } });
      if (method === 'sessions.messages.subscribe')
        return new Promise<void>(resolve => {
          acknowledgeSubscription = resolve;
        });
      return Promise.resolve({});
    });
    const replacement = { request: replacementRequest } as unknown as GatewayClientLike;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, options) => {
      if (method === 'agent') {
        f.replaceClient(replacement);
        return Promise.reject(new Error('Final response lost'));
      }
      return original(method, params, options);
    });
    const running = f.execute({ ...f.input, hooks: undefined });
    const outcome = running.then(
      value => ({ value }),
      error => ({ error }),
    );
    await vi.waitFor(() =>
      expect(replacementRequest).toHaveBeenCalledWith('sessions.messages.subscribe', {
        key: 'native-key',
        subscriptionId: 'external-agent:run',
      }),
    );
    vi.useFakeTimers();
    f.runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        seq: 1,
        sessionKey: 'native-key',
        sessionId: 'native-id',
        runId: 'run',
        lifecycleGeneration: 'generation-1',
        stream: 'lifecycle',
        data: {
          phase: 'end',
          executionSettled: true,
          terminalReply: { disposition: 'visible', text: 'Live answer' },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onSettled).toHaveBeenCalledWith('completed');
    expect(await outcome).toEqual({ value: 'Live answer' });
    expect(replacementRequest).toHaveBeenCalledWith('sessions.messages.unsubscribe', {
      key: 'native-key',
      subscriptionId: 'external-agent:run',
    });
    acknowledgeSubscription();
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      replacementRequest.mock.calls.filter(
        ([method]) => method === 'sessions.messages.unsubscribe',
      ),
    ).toHaveLength(1);
    expect(f.store.finishSessionRun).toHaveBeenCalledTimes(1);
    expect(f.onSettled).toHaveBeenCalledTimes(1);
  });

  it('leaves the unbounded final RPC wait on caller cancellation and reconciles instead of assuming cancellation', async () => {
    const f = fixture({ timeoutMs: 1000, pollIntervalMs: 100 });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, options) => {
      if (method === 'agent')
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('Transport wait cancelled')),
            { once: true },
          );
        });
      if (method === 'agent.wait') return Promise.resolve({ runId: 'run', status: 'timeout' });
      return original(method, params, options);
    });
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    vi.useFakeTimers();
    const rejected = expect(running).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
    f.controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(f.request).toHaveBeenCalledWith('sessions.abort', { key: 'native-key', runId: 'run' });
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    expect(f.onSettled).not.toHaveBeenCalled();
  });

  it.each(['missing', 'silent', 'empty'])(
    'preserves native success when the recovered reply is %s',
    async disposition => {
      const f = fixture();
      f.request.mockImplementation(method => {
        if (method === 'agent')
          return Promise.reject(new Error('gateway closed (1006): reply lost'));
        if (method === 'agent.wait')
          return Promise.resolve({
            runId: 'run',
            status: 'ok',
            endedAt: 100,
            ...(disposition === 'missing' ? {} : { terminalReply: { disposition } }),
          });
        return Promise.resolve(
          method === 'sessions.describe' ? { session: { ...f.identity } } : {},
        );
      });
      const running = f.execute(f.input);
      if (disposition === 'missing')
        await expect(running).rejects.toBeInstanceOf(ExternalAgentStreamError);
      else await expect(running).resolves.toBe('');
      expect(f.onSettled).toHaveBeenCalledWith('completed');
      expect(f.store.finishSessionRun).toHaveBeenCalledWith(
        'timing',
        'completed',
        expect.any(Number),
      );
    },
  );

  it.each(['lifecycle', 'wait', 'error-text'])(
    'uses exact cancellation evidence from %s',
    async source => {
      const f = fixture();
      const running = f.execute(f.input);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
      );
      if (source === 'lifecycle') {
        f.runtime.emit('gatewayEvent', {
          event: 'agent',
          payload: {
            seq: 1,
            sessionKey: 'native-key',
            sessionId: 'native-id',
            runId: 'run',
            lifecycleGeneration: 'generation-1',
            stream: 'lifecycle',
            data: { phase: 'end', executionSettled: true, aborted: true },
          },
        });
      }
      f.finishAgent(final);
      if (source !== 'lifecycle') {
        await vi.waitFor(() =>
          expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
        );
        f.finishReceipt({
          runId: 'run',
          status: 'error',
          endedAt: 100,
          ...(source === 'wait' ? { stopReason: 'aborted' } : { error: 'aborted' }),
        });
      }
      if (source === 'error-text') {
        await expect(running).rejects.not.toBeInstanceOf(ExternalAgentCancelledError);
        expect(f.store.finishSessionRun).toHaveBeenCalledWith(
          'timing',
          'failed',
          expect.any(Number),
        );
      } else {
        await expect(running).rejects.toBeInstanceOf(ExternalAgentCancelledError);
        expect(f.store.finishSessionRun).toHaveBeenCalledWith(
          'timing',
          'aborted',
          expect.any(Number),
        );
      }
      expect(f.controller.signal.aborted).toBe(false);
    },
  );

  it('awaits exact terminal evidence after a final response and cancellation acknowledgement', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({ sessionKey: 'native-key', idempotencyKey: 'run' }),
        { expectFinal: true, signal: expect.any(AbortSignal) },
      ),
    );
    expect(f.onPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        localSessionId: 'local',
        sessionKey: 'native-key',
        sessionId: 'native-id',
        lifecycleRevision: 'revision-1',
      }),
    );
    expect(f.onPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      f.request.mock.invocationCallOrder[
        f.request.mock.calls.findIndex(([method]) => method === 'agent')
      ],
    );
    f.finishAgent(final);
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith('agent.wait', { runId: 'run', timeoutMs: 0 }),
    );
    f.controller.abort();
    expect(f.request).toHaveBeenCalledWith('sessions.abort', { key: 'native-key', runId: 'run' });
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
    f.finishReceipt(receipt);
    await expect(running).resolves.toBe('Confirmed answer');
    expect(f.store.finishSessionRun).toHaveBeenCalledWith(
      'timing',
      'completed',
      expect.any(Number),
    );
    expect(f.onSettled).toHaveBeenCalledWith('completed');
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledWith('sessions.messages.unsubscribe', {
      key: 'native-key',
      subscriptionId: 'external-agent:run',
    });
  });

  it('admits only exact native identity, run, generation and increasing sequence', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    const emit = (overrides: Record<string, unknown>) =>
      f.runtime.emit('gatewayEvent', {
        event: 'agent',
        payload: {
          seq: 1,
          sessionKey: 'native-key',
          sessionId: 'native-id',
          runId: 'run',
          lifecycleGeneration: 'generation-1',
          stream: 'tool',
          data: {},
          ...overrides,
        },
      });
    for (const overrides of [
      { sessionId: 'other-id' },
      { sessionKey: 'other-key' },
      { runId: 'other-run' },
      { spawnedBy: 'parent' },
      {},
      {},
      { seq: 2, lifecycleGeneration: 'old-generation' },
    ])
      emit(overrides);
    await vi.waitFor(() => expect(f.onEvent).toHaveBeenCalledTimes(1));
    emit({ seq: 2, stream: 'lifecycle', data: { phase: 'end', executionSettled: false } });
    f.finishAgent(final);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    f.finishReceipt(receipt);
    await expect(running).resolves.toBe('Confirmed answer');
  });

  it('cleans preparation hooks after cancellation before native admission', async () => {
    const f = fixture();
    f.onPrepared.mockImplementation(async () => {
      f.controller.abort();
      return f.cleanup;
    });
    await expect(f.execute(f.input)).rejects.toThrow('Task cancelled');
    expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(false);
    expect(f.store.beginSessionRun).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.runtime.listenerCount('gatewayEvent')).toBe(0);
  });

  it('retains unknown native execution across disconnect without replaying the task', async () => {
    const f = fixture();
    const input = { ...f.input, hooks: undefined };
    let finish!: (value: unknown) => void;
    const replacementRequest = vi.fn((method: string) =>
      method === 'sessions.describe'
        ? Promise.resolve({ session: { ...f.identity } })
        : method === 'agent.wait'
          ? new Promise(resolve => {
              finish = resolve;
            })
          : Promise.resolve({}),
    );
    const replacement = { request: replacementRequest } as unknown as GatewayClientLike;
    f.request.mockImplementation(method => {
      if (method === 'agent') {
        f.replaceClient(replacement);
        return Promise.reject(new Error('gateway closed (1006): connection lost'));
      }
      return Promise.resolve(method === 'sessions.describe' ? { session: { ...f.identity } } : {});
    });
    const running = f.execute(input);
    await vi.waitFor(() =>
      expect(replacementRequest).toHaveBeenCalledWith('agent.wait', { runId: 'run', timeoutMs: 0 }),
    );
    expect(f.onUnconfirmed).toHaveBeenCalled();
    expect(f.registerUnknownSessionRun).toHaveBeenCalledWith('local', 'run', { cancelled: false });
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    finish(receipt);
    await expect(running).resolves.toBe('Confirmed answer');
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    expect(replacementRequest.mock.calls.some(([method]) => method === 'agent')).toBe(false);
  });

  it('does not transfer external tool or approval ownership implicitly to a replacement connection', async () => {
    const f = fixture();
    const replacementRequest = vi.fn(async (method: string) =>
      method === 'sessions.describe' ? { session: { ...f.identity } } : {},
    );
    const replacement = { request: replacementRequest } as unknown as GatewayClientLike;
    f.request.mockImplementation(method => {
      if (method === 'agent') {
        f.replaceClient(replacement);
        return Promise.reject(new Error('gateway closed (1006): connection lost'));
      }
      return Promise.resolve(method === 'sessions.describe' ? { session: { ...f.identity } } : {});
    });
    await expect(f.execute(f.input)).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    f.controller.abort();
    expect(replacementRequest).toHaveBeenCalledWith('sessions.abort', {
      key: 'native-key',
      runId: 'run',
    });
  });

  it('does not treat a missing lifecycle start and unstructured request failure as rejection', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.request.mockImplementation(method => {
      if (method === 'agent') return Promise.reject(new Error('Unstructured execution failure'));
      if (method === 'agent.wait')
        return new Promise(resolve => {
          finish = resolve;
        });
      return Promise.resolve(method === 'sessions.describe' ? { session: { ...f.identity } } : {});
    });
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith('agent.wait', { runId: 'run', timeoutMs: 0 }),
    );
    expect(f.onUnconfirmed).toHaveBeenCalled();
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
    finish(receipt);
    await expect(running).resolves.toBe('Confirmed answer');
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  });

  it('releases preparation resources when transport explicitly proves the request was never sent', async () => {
    const f = fixture();
    const failure = Object.assign(new Error('Not sent'), { requestSent: false });
    f.request.mockImplementation(method =>
      method === 'agent'
        ? Promise.reject(failure)
        : Promise.resolve(method === 'sessions.describe' ? { session: { ...f.identity } } : {}),
    );
    await expect(f.execute(f.input)).rejects.toThrow('Not sent');
    expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(false);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.store.finishSessionRun).toHaveBeenCalledWith('timing', 'failed', expect.any(Number));
  });

  it('keeps an unprovable yielded continuation reserved and does not infer its result from history or idle', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    f.finishAgent({
      status: 'ok',
      result: { meta: { yielded: true }, payloads: [{ text: 'Working' }] },
    });
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    f.finishReceipt({ runId: 'run', status: 'ok', yielded: true, endedAt: 100 });
    await expect(running).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === 'chat.history')).toBe(false);
    f.controller.abort();
    expect(f.request).toHaveBeenCalledWith('sessions.abort', { key: 'native-key', runId: 'run' });
  });

  it('keeps uncertain work reserved when a same-key native conversation is reset', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    f.finishAgent(final);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    f.identity.lifecycleRevision = 'replacement-revision';
    f.finishReceipt(receipt);
    await expect(running).rejects.toBeInstanceOf(ExternalAgentOutcomeUnknownError);
    expect(f.store.finishSessionRun).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it('preserves native success while reporting a failed output transport', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    f.controller.abort(new ExternalAgentStreamError('Output unavailable'));
    f.finishAgent(final);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    f.finishReceipt(receipt);
    await expect(running).rejects.toThrow('Output unavailable');
    expect(f.store.finishSessionRun).toHaveBeenCalledWith(
      'timing',
      'completed',
      expect.any(Number),
    );
    expect(f.onSettled).toHaveBeenCalledWith('completed');
  });

  it('does not replace exact native failure with a concurrent local stop request', async () => {
    const f = fixture();
    const running = f.execute(f.input);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent')).toBe(true),
    );
    f.controller.abort();
    f.finishAgent(final);
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'agent.wait')).toBe(true),
    );
    f.finishReceipt({ runId: 'run', status: 'error', endedAt: 100, error: 'Native failure' });
    await expect(running).rejects.not.toBeInstanceOf(ExternalAgentCancelledError);
    expect(f.store.finishSessionRun).toHaveBeenCalledWith('timing', 'failed', expect.any(Number));
    expect(f.onSettled).toHaveBeenCalledWith('failed');
  });
});

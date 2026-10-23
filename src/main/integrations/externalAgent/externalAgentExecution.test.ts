import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { AcpProgress } from './acpProgress';
import { createExternalAgentExecution } from './externalAgentExecution';
import {
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentTypes';

afterEach(() => vi.useRealTimers());

function fixture(timing?: Parameters<typeof createExternalAgentExecution>[1]) {
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
  };
  const identity: { sessionId: string; lifecycleRevision: string; activeRunIds?: string[] } = {
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
      if (method === 'sessions.describe') return Promise.resolve({ session: { ...identity } });
      if (method === 'agent')
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
  Object.assign(runtime, {
    ensureReady: async () => {},
    getGatewayClient: () => current,
    patchSessionModel,
    registerUnknownSessionRun,
  });
  const router = {
    isSessionActive: () => false,
    prepareSession: vi.fn(async () => ({
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

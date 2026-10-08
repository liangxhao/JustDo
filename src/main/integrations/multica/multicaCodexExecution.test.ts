import { EventEmitter } from 'node:events';

import { expect, it, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { createMulticaCodexExecution } from './multicaCodexExecution';
import { MulticaCodexStreamError } from './multicaCodexSession';

it.each(['confirmed', 'rejected', 'cancelled'])(
  'applies the selected native model before admission and handles %s confirmation',
  async mode => {
    const runtime = new EventEmitter();
    const controller = new AbortController();
    const calls: string[] = [];
    const session = {
      id: 'local',
      agentId: 'main',
      cwd: '/task',
      permissionMode: 'ask',
      modelRef: 'provider/old',
    };
    const request = vi.fn(async (method: string) => {
      calls.push(method);
      return method === 'agent' ? { status: 'ok', result: { payloads: [{ text: 'done' }] } } : {};
    });
    const patchSessionModel = vi.fn(async (id: string, modelRef: string, agentId?: string) => {
      expect([id, modelRef, agentId]).toEqual(['local', 'provider/selected', 'main']);
      calls.push('model-confirmation');
      if (mode === 'rejected') return { ok: false as const, error: 'Native model denied' };
      session.modelRef = modelRef;
      if (mode === 'cancelled') controller.abort();
      return {
        ok: true as const,
        modelRef,
        appliesTo: 'next-turn' as const,
        source: 'gateway' as const,
      };
    });
    Object.assign(runtime, {
      ensureReady: async () => {},
      getGatewayClient: () => ({ request }),
      patchSessionModel,
    });
    const store = {
      getSession: () => session,
      beginSessionRun: vi.fn(() => ({ id: 'timing' })),
      finishSessionRun: vi.fn(),
      updateSession: vi.fn(),
    };
    const execute = createMulticaCodexExecution({
      getStore: () => store as unknown as CoworkStore,
      getRuntime: () => runtime as OpenClawRuntimeAdapter,
      ensureReady: async () => ({ phase: 'running' }),
      getRouter: () =>
        ({
          isSessionActive: () => false,
          prepareSession: async () => {
            calls.push('prepare');
            return { sessionKey: 'native' };
          },
        }) as unknown as CoworkEngineRouter,
    });
    const result = execute({
      sessionId: 'local',
      runId: 'run',
      message: 'task',
      modelRef: 'provider/selected',
      onEvent: vi.fn(),
      onPrepared: vi.fn(),
      signal: controller.signal,
    });
    if (mode === 'confirmed') {
      await expect(result).resolves.toBe('done');
      expect(calls.slice(0, 4)).toEqual([
        'prepare',
        'model-confirmation',
        'sessions.messages.subscribe',
        'agent',
      ]);
      expect(store.beginSessionRun).toHaveBeenCalledWith(
        expect.objectContaining({ modelRef: 'provider/selected' }),
      );
    } else {
      await expect(result).rejects.toThrow(
        mode === 'rejected' ? 'Native model denied' : 'Task cancelled',
      );
      expect(request).not.toHaveBeenCalled();
      expect(store.beginSessionRun).not.toHaveBeenCalled();
    }
  },
);

it.each([
  'live',
  'live-no-reply',
  'recovered',
  'cancel',
  'unattributable',
  'nested-yield',
  'native-abort',
  'recovered-failure',
])('waits for yielded descendants and handles %s continuation', async mode => {
  const runtime = new EventEmitter();
  let settle!: (state: unknown) => void;
  const getSessionRuntimeStatus = vi.fn(
    () =>
      new Promise(resolve => {
        settle = resolve;
      }),
  );
  const request = vi.fn(async (method: string, params?: { runId?: string }) => {
    if (method === 'agent') {
      if (mode === 'recovered' || mode === 'unattributable' || mode === 'recovered-failure')
        throw new Error('gateway closed (1006): lost');
      return {
        status: 'ok',
        result: { meta: { yielded: true }, payloads: [{ text: 'Working on it.' }] },
      };
    }
    if (method === 'agent.wait')
      return params?.runId === 'continuation'
        ? {
            runId: 'continuation',
            status: mode === 'recovered-failure' ? 'error' : 'ok',
            endedAt: Date.now(),
          }
        : { runId: 'run', status: 'ok', yielded: true };
    if (method === 'chat.history' && mode === 'nested-yield') return { messages: [] };
    if (method === 'chat.history')
      return {
        messages: [
          {
            role: 'user',
            idempotencyKey: mode === 'unattributable' ? 'other:user' : 'run:user',
          },
          {
            role: 'assistant',
            text: 'Continuation finished.',
            __openclaw: { runId: 'continuation' },
          },
        ],
      };
    return {};
  });
  const client = { request };
  Object.assign(runtime, {
    ensureReady: async () => {},
    getGatewayClient: () => client,
    registerUnknownSessionRun: vi.fn(),
    getSessionRuntimeStatus,
  });
  const store = {
    getSession: () => ({ agentId: 'main', cwd: '/task', permissionMode: 'ask' }),
    beginSessionRun: () => ({ id: 'timing' }),
    finishSessionRun: vi.fn(),
    updateSession: vi.fn(),
  };
  const stopSession = vi.fn(async () => {});
  const execute = createMulticaCodexExecution({
    getStore: () => store as unknown as CoworkStore,
    getRuntime: () => runtime as OpenClawRuntimeAdapter,
    ensureReady: async () => ({ phase: 'running' }),
    getRouter: () =>
      ({
        stopSession,
        isSessionActive: () => false,
        prepareSession: async () => ({ sessionKey: 'native' }),
      }) as unknown as CoworkEngineRouter,
  });
  const controller = new AbortController(),
    onEvent = vi.fn();
  const result = execute({
    sessionId: 'local',
    runId: 'run',
    message: 'task',
    onEvent,
    onPrepared: vi.fn(),
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(getSessionRuntimeStatus).toHaveBeenCalled());
  expect(store.finishSessionRun).not.toHaveBeenCalled();
  if (
    mode === 'live' ||
    mode === 'live-no-reply' ||
    mode === 'nested-yield' ||
    mode === 'native-abort'
  )
    runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        seq: 2,
        runId: 'continuation',
        sessionKey: 'native',
        stream: 'lifecycle',
        data: {
          phase: 'end',
          executionSettled: true,
          yielded: mode === 'nested-yield',
          aborted: mode === 'native-abort',
          ...(mode === 'live-no-reply'
            ? {}
            : { terminalReply: { disposition: 'visible', text: 'Continuation finished.' } }),
        },
      },
    });
  if (mode === 'cancel') {
    controller.abort();
    expect(stopSession).toHaveBeenCalledWith('local');
  }
  settle({ known: true, running: false });
  if (mode === 'unattributable' || mode === 'nested-yield')
    await expect(result).rejects.toThrow('continuation reply could not be recovered');
  else if (mode === 'native-abort' || mode === 'recovered-failure')
    await expect(result).rejects.toThrow('Native execution failed.');
  else await expect(result).resolves.toBe(mode === 'cancel' ? '' : 'Continuation finished.');
  if (mode === 'live') expect(onEvent).toHaveBeenCalled();
  if (mode === 'recovered')
    expect(
      request.mock.calls.filter(
        ([method, params]) => method === 'agent.wait' && params?.runId === 'run',
      ),
    ).toHaveLength(1);
});

it.each(['cancel', 'stream-failure'])(
  'filters events and waits for native settlement after %s',
  async reason => {
    const runtime = new EventEmitter();
    let finish!: (result: unknown) => void;
    const request = vi.fn((method: string) =>
      method === 'agent'
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve({}),
    );
    Object.assign(runtime, { ensureReady: async () => {}, getGatewayClient: () => ({ request }) });
    const store = {
      getSession: () => ({ id: 'local', agentId: 'main', cwd: '/task', permissionMode: 'ask' }),
      beginSessionRun: () => ({ id: 'timing' }),
      finishSessionRun: vi.fn(),
      updateSession: vi.fn(),
    };
    const execute = createMulticaCodexExecution({
      getStore: () => store as unknown as CoworkStore,
      getRuntime: () => runtime as OpenClawRuntimeAdapter,
      ensureReady: async () => ({ phase: 'running' }),
      getRouter: () =>
        ({
          isSessionActive: () => false,
          prepareSession: async () => ({ sessionKey: 'native' }),
        }) as unknown as CoworkEngineRouter,
    });
    const controller = new AbortController(),
      onEvent = vi.fn(),
      onPrepared = vi.fn();
    const result = execute({
      sessionId: 'local',
      runId: 'run',
      message: 'task',
      onEvent,
      onPrepared,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({ sessionKey: 'native', idempotencyKey: 'run' }),
        { expectFinal: true },
      ),
    );
    for (const [sessionKey, runId] of [
      ['foreign', 'run'],
      ['native', 'other'],
      ['native', 'run'],
    ]) {
      runtime.emit('gatewayEvent', {
        event: 'agent',
        payload: {
          seq: 1,
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'start', name: 'read', toolCallId: 'call' },
        },
      });
    }
    expect(onPrepared).toHaveBeenCalledWith('native');
    expect(onEvent).toHaveBeenCalledTimes(1);
    controller.abort(
      reason === 'stream-failure' ? new MulticaCodexStreamError('Output limit.') : undefined,
    );
    expect(request).toHaveBeenCalledWith('sessions.abort', { key: 'native', runId: 'run' });
    expect(store.finishSessionRun).not.toHaveBeenCalled();
    finish({ status: 'ok', result: { payloads: [] } });
    if (reason === 'stream-failure') await expect(result).rejects.toThrow('Output limit.');
    else await result;
    expect(store.finishSessionRun).toHaveBeenCalledWith(
      'timing',
      reason === 'stream-failure' ? 'failed' : 'aborted',
      expect.any(Number),
    );
    expect(runtime.listenerCount('gatewayEvent')).toBe(0);
  },
);

it('rejects failed configuration readiness before preparing a native session', async () => {
  const getRouter = vi.fn();
  const execute = createMulticaCodexExecution({
    getStore: vi.fn(),
    getRuntime: vi.fn(),
    getRouter,
    ensureReady: async () => ({ phase: 'error', message: 'Configuration sync failed.' }),
  });
  await expect(
    execute({
      sessionId: 'local',
      runId: 'run',
      message: 'task',
      onEvent: vi.fn(),
      onPrepared: vi.fn(),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('Configuration sync failed.');
  expect(getRouter).not.toHaveBeenCalled();
});

it('retains execution ownership across disconnect and retries cancellation on the replacement client', async () => {
  const runtime = new EventEmitter();
  let receipt!: (value: unknown) => void;
  const replacement = {
    request: vi.fn((method: string) =>
      method === 'agent.wait'
        ? new Promise(resolve => {
            receipt = resolve;
          })
        : Promise.resolve({}),
    ),
  };
  let current: typeof replacement;
  const original = {
    request: vi.fn(async (method: string) => {
      if (method === 'agent') {
        current = replacement;
        throw new Error('gateway closed (1006): connection lost');
      }
      return {};
    }),
  };
  current = original;
  const registerUnknownSessionRun = vi.fn();
  Object.assign(runtime, {
    ensureReady: async () => {},
    getGatewayClient: () => current,
    registerUnknownSessionRun,
  });
  const store = {
    getSession: () => ({ agentId: 'main', cwd: '/task', permissionMode: 'ask' }),
    beginSessionRun: () => ({ id: 'timing' }),
    finishSessionRun: vi.fn(),
    updateSession: vi.fn(),
  };
  const execute = createMulticaCodexExecution({
    getStore: () => store as unknown as CoworkStore,
    getRuntime: () => runtime as OpenClawRuntimeAdapter,
    ensureReady: async () => ({ phase: 'running' }),
    getRouter: () =>
      ({
        isSessionActive: () => false,
        prepareSession: async () => ({ sessionKey: 'native' }),
      }) as unknown as CoworkEngineRouter,
  });
  const controller = new AbortController();
  const result = execute({
    sessionId: 'local',
    runId: 'run',
    message: 'task',
    onEvent: vi.fn(),
    onPrepared: vi.fn(),
    signal: controller.signal,
  });
  await vi.waitFor(() =>
    expect(replacement.request).toHaveBeenCalledWith('agent.wait', { runId: 'run', timeoutMs: 0 }),
  );
  expect(registerUnknownSessionRun).toHaveBeenCalledWith('local', 'run', { cancelled: false });
  expect(store.finishSessionRun).not.toHaveBeenCalled();
  controller.abort();
  expect(replacement.request).toHaveBeenCalledWith('sessions.abort', {
    key: 'native',
    runId: 'run',
  });
  receipt({ runId: 'run', status: 'timeout' });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(store.finishSessionRun).not.toHaveBeenCalled();
  await vi.waitFor(
    () =>
      expect(
        replacement.request.mock.calls.filter(([method]) => method === 'agent.wait'),
      ).toHaveLength(2),
    { timeout: 2000 },
  );
  receipt({ runId: 'run', status: 'timeout', endedAt: Date.now() });
  await expect(result).rejects.toThrow('Native execution failed.');
  expect(store.finishSessionRun).toHaveBeenCalledWith('timing', 'aborted', expect.any(Number));
  expect(runtime.listenerCount('gatewayEvent')).toBe(0);
  expect(original.request).toHaveBeenCalledWith('sessions.messages.subscribe', {
    key: 'native',
    subscriptionId: 'multica:run',
  });
  expect(
    replacement.request.mock.calls.filter(([method]) => method === 'sessions.messages.subscribe'),
  ).toHaveLength(1);
  expect(replacement.request).toHaveBeenCalledWith('sessions.messages.unsubscribe', {
    key: 'native',
    subscriptionId: 'multica:run',
  });
});

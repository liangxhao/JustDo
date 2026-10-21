import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { ChatController } from '../chat-controller';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:justdo:compaction-reconnect';
const flush = async () => {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
};

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.useRealTimers();
});

async function interruptedCompaction() {
  vi.useFakeTimers();
  const controller = new ChatController({ initialHistoryRetryDelaysMs: [] });
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.connected = true;
  let operationId = '';
  let rejectCompact!: (error: Error) => void;
  const pending = new Promise((_resolve, reject) => {
    rejectCompact = reject;
  });
  const request = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method !== 'sessions.compact') throw new Error('Unexpected original RPC: ' + method);
    operationId = params.operationId as string;
    return pending;
  });
  controller.state.client = { request, stop: vi.fn() } as never;
  const compacting = controller.sendMessage('/compact');
  const lifecycle = controller as unknown as {
    handleClose(): void;
    handleHello(hello: Record<string, unknown>): void;
    handleCompactionPhase(phase: string, key: string, data: Record<string, unknown>): void;
  };
  lifecycle.handleClose();
  rejectCompact(new Error('connection closed'));
  await compacting;
  return { controller, lifecycle, operationId, request };
}

function reconnect(
  controller: ChatController,
  lifecycle: { handleHello(hello: Record<string, unknown>): void },
  status: (method: string, params: Record<string, unknown>) => unknown,
) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method.startsWith('sessions.compaction.')) return status(method, params);
    if (method === 'chat.startup' || method === 'chat.history') return { messages: [] };
    return {};
  });
  controller.state.client = { request, stop: vi.fn() } as never;
  lifecycle.handleHello({});
  return request;
}

test.each(['completed', 'failed', 'skipped', 'aborted'] as const)(
  'reconciles the original %s receipt after reconnect without resubmitting',
  async outcome => {
    const {
      controller,
      lifecycle,
      operationId,
      request: originalRequest,
    } = await interruptedCompaction();
    const request = reconnect(controller, lifecycle, (_method, params) => ({
      ...params,
      phase: 'settled',
      outcome,
      markerExpected: false,
      tokensBefore: 12000,
      tokensAfter: 4000,
      reason: outcome === 'completed' ? undefined : 'native-error',
    }));
    expect(controller.state.chatSending).toBe(true);
    await flush();
    expect(request).toHaveBeenCalledWith('sessions.compaction.status', {
      key: sessionKey,
      operationId,
    });
    expect(originalRequest).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([method]) => method === 'sessions.compact')).toBe(false);
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.compactionInFlight).toBe(false);
    expect(controller.state.chatMessages).toContainEqual(
      expect.objectContaining({
        __openclaw: expect.objectContaining({ phase: outcome }),
      }),
    );
    if (outcome === 'completed') {
      expect(controller.state.chatMessages[0]).toMatchObject({
        __openclaw: { tokensBefore: 12000, tokensAfter: 4000 },
      });
    }
  },
);

test('keeps the sending lock for an in-progress receipt until the exact terminal event', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  reconnect(controller, lifecycle, (_method, params) => ({ ...params, phase: 'in-progress' }));
  await flush();
  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'in-progress' } });
  await expect(controller.sendMessage('new message')).rejects.toThrow(
    i18nService.t('coworkCompactionInProgress'),
  );
  lifecycle.handleCompactionPhase('end', sessionKey, {
    operationId: 'another-id',
    outcome: 'aborted',
    completed: false,
  });
  expect(controller.state.chatSending).toBe(true);
  lifecycle.handleCompactionPhase('end', sessionKey, {
    operationId,
    outcome: 'aborted',
    completed: false,
  });
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.compactionInFlight).toBe(false);
});

test('fences an unknown operation before showing an unconfirmed result and releasing the lock', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  let confirmAbort!: (receipt: unknown) => void;
  const aborted = new Promise(resolve => {
    confirmAbort = resolve;
  });
  const request = reconnect(controller, lifecycle, (method, params) =>
    method === 'sessions.compaction.status' ? { ...params, phase: 'unknown' } : aborted,
  );
  await flush();
  expect(request).toHaveBeenCalledWith('sessions.compaction.abort', {
    key: sessionKey,
    operationId,
  });
  expect(controller.state.chatSending).toBe(true);
  await expect(controller.sendMessage('/compact')).rejects.toThrow(
    i18nService.t('coworkCompactionInProgress'),
  );
  confirmAbort({ key: sessionKey, operationId, phase: 'settled', outcome: 'aborted' });
  await flush();
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatMessages).toContainEqual(
    expect.objectContaining({
      role: 'system',
      content: i18nService.t('coworkCompactPreviousResultUnknown'),
    }),
  );
  expect(
    controller.state.chatMessages.some(message => (message as { __openclaw?: unknown }).__openclaw),
  ).toBe(false);
  expect(request.mock.calls.some(([method]) => method === 'sessions.compact')).toBe(false);
});

test('keeps an immediate unknown-result notice visible after reconnect history finishes', async () => {
  const { controller, lifecycle } = await interruptedCompaction();
  const request = reconnect(controller, lifecycle, (method, params) => ({
    ...params,
    phase: method === 'sessions.compaction.status' ? 'unknown' : 'settled',
    outcome: method === 'sessions.compaction.abort' ? 'aborted' : undefined,
  }));
  await flush();
  expect(controller.state.initialHistoryReady).toBe(true);
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatMessages).toContainEqual(
    expect.objectContaining({
      content: i18nService.t('coworkCompactPreviousResultUnknown'),
    }),
  );
  const methods = request.mock.calls.map(([method]) => method);
  const historyIndex = methods.findIndex(
    method => method === 'chat.startup' || method === 'chat.history',
  );
  expect(historyIndex).toBeGreaterThanOrEqual(0);
  expect(methods.indexOf('sessions.compaction.status')).toBeGreaterThan(historyIndex);
});

test('does not assign marker-free compaction accounting to an earlier delayed marker', async () => {
  const controller = new ChatController();
  controllers.push(controller);
  const marker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'earlier-delayed-marker' },
  };
  const request = vi.fn(async (method: string) =>
    method === 'sessions.compact'
      ? {
          ok: true,
          compacted: true,
          markerExpected: false,
          result: { kind: 'server-endpoint', tokensBefore: 100, tokensAfter: 20 },
        }
      : { messages: [marker] },
  );
  controller.state.sessionKey = sessionKey;
  controller.state.connected = true;
  controller.state.client = { request, stop: vi.fn() } as never;
  await controller.sendMessage('/compact');
  expect(controller.state.chatMessages).toContainEqual(marker);
  expect(controller.state.chatMessages).toContainEqual(
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        phase: 'completed',
        tokensBefore: 100,
        tokensAfter: 20,
      }),
    }),
  );
});

test.each(['wrong-session', 'wrong-operation', 'missing-outcome', 'transport-error'])(
  'does not unlock from %s status evidence',
  async evidence => {
    const { controller, lifecycle } = await interruptedCompaction();
    reconnect(controller, lifecycle, (_method, params) => {
      if (evidence === 'transport-error') throw new Error('status connection closed');
      return {
        ...params,
        phase: 'settled',
        outcome: evidence === 'missing-outcome' ? undefined : 'completed',
        ...(evidence === 'wrong-session' ? { key: 'another-session' } : {}),
        ...(evidence === 'wrong-operation' ? { operationId: 'another-operation' } : {}),
      };
    });
    await flush();
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.compactionInFlight).toBe(true);
    await expect(controller.sendMessage('/compact')).rejects.toThrow(
      i18nService.t('coworkCompactionInProgress'),
    );
  },
);

test('ignores a stale status response when the same client reconnects again', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  let firstStatus!: (receipt: unknown) => void;
  let calls = 0;
  const pending = new Promise(resolve => {
    firstStatus = resolve;
  });
  reconnect(controller, lifecycle, (_method, params) =>
    ++calls === 1 ? pending : { ...params, phase: 'in-progress' },
  );
  await flush();
  lifecycle.handleClose();
  lifecycle.handleHello({});
  await flush();
  firstStatus({
    key: sessionKey,
    operationId,
    phase: 'settled',
    outcome: 'completed',
    markerExpected: false,
  });
  await flush();
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'in-progress' } });
});

test('applies a background receipt without unlocking the selected session', async () => {
  const { controller, lifecycle } = await interruptedCompaction();
  await controller.switchSession('agent:main:justdo:another');
  controller.state.chatSending = true;
  reconnect(controller, lifecycle, (_method, params) => ({
    ...params,
    phase: 'settled',
    outcome: 'aborted',
  }));
  await flush();
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatMessages).toEqual([]);
  controller.state.connected = false;
  await controller.switchSession(sessionKey);
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'aborted' } });
});

test('does not let a late Stop reply unlock newer work after the native terminal', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  let finishAbort!: (receipt: unknown) => void;
  const pending = new Promise(resolve => {
    finishAbort = resolve;
  });
  reconnect(controller, lifecycle, (method, params) =>
    method === 'sessions.compaction.status' ? { ...params, phase: 'in-progress' } : pending,
  );
  await flush();
  const stopping = controller.cancelManualCompaction(sessionKey);
  lifecycle.handleCompactionPhase('end', sessionKey, {
    operationId,
    completed: false,
    outcome: 'aborted',
  });
  controller.state.chatSending = true;
  controller.state.chatRunId = 'newer-run';
  finishAbort({ key: sessionKey, operationId, phase: 'settled', outcome: 'aborted' });
  await stopping;
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('newer-run');
});

test('retains a transport-unknown operation across explicit disconnect and blocks replacement', async () => {
  const { controller } = await interruptedCompaction();
  controller.disconnect();
  controller.state.client = { request: vi.fn(), stop: vi.fn() } as never;
  controller.state.connected = true;
  await expect(controller.sendMessage('/compact')).rejects.toThrow(
    i18nService.t('coworkCompactionInProgress'),
  );
  await expect(controller.sendMessage('ordinary new work')).rejects.toThrow(
    i18nService.t('coworkCompactionInProgress'),
  );
});

test('accepts a native terminal while a concurrent Stop request loses its transport', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  let rejectAbort!: (error: Error) => void;
  const abort = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  reconnect(controller, lifecycle, (method, params) =>
    method === 'sessions.compaction.status' ? { ...params, phase: 'in-progress' } : abort,
  );
  await flush();
  const stopping = controller.cancelManualCompaction(sessionKey);
  lifecycle.handleCompactionPhase('end', sessionKey, {
    operationId,
    completed: false,
    outcome: 'aborted',
  });
  rejectAbort(new Error('late abort connection closed'));
  await expect(stopping).resolves.toBeUndefined();
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.compactionInFlight).toBe(false);
});

test('does not treat a forbidden status read as proof the original operation was rejected', async () => {
  const { controller, lifecycle } = await interruptedCompaction();
  const request = reconnect(controller, lifecycle, method => {
    if (method === 'sessions.compaction.status') {
      throw Object.assign(new Error('status forbidden'), { gatewayCode: 'FORBIDDEN' });
    }
    throw new Error('abort connection closed');
  });
  await flush();
  await expect(controller.cancelManualCompaction(sessionKey)).rejects.toThrow(
    'abort connection closed',
  );
  expect(request.mock.calls.some(([method]) => method === 'sessions.compaction.abort')).toBe(true);
  expect(controller.state.chatSending).toBe(true);
});

test('retires an older manual operation without settling a newer automatic compaction', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  reconnect(controller, lifecycle, (_method, params) => ({ ...params, phase: 'in-progress' }));
  await flush();
  lifecycle.handleCompactionPhase('start', sessionKey, {
    operationId: 'newer-automatic-operation',
  });
  lifecycle.handleCompactionPhase('end', sessionKey, {
    operationId,
    completed: false,
    outcome: 'aborted',
  });
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'in-progress' } });
  expect(
    (controller as unknown as { manualCompactionOperations: Map<string, unknown> })
      .manualCompactionOperations.size,
  ).toBe(0);
});

test.each(['client', 'generation'])(
  'does not restore presentation or read receipts from a stale %s reconciliation entry',
  async stale => {
    const { controller, lifecycle } = await interruptedCompaction();
    const request = vi.fn();
    const client = { request, stop: vi.fn() };
    controller.state.client = client as never;
    controller.state.connected = true;
    lifecycle.handleCompactionPhase('start', sessionKey, { operationId: 'newer-automatic' });
    controller.state.chatSending = true;
    controller.state.chatRunId = 'newer-run';
    const messages = controller.state.chatMessages;
    const internals = controller as unknown as {
      manualCompactionRecoveryGeneration: number;
      reconcileManualCompactions(client: unknown, generation: number): Promise<void>;
    };
    await internals.reconcileManualCompactions(
      stale === 'client' ? { request, stop: vi.fn() } : client,
      internals.manualCompactionRecoveryGeneration - (stale === 'generation' ? 1 : 0),
    );
    expect(request).not.toHaveBeenCalled();
    expect(controller.state.chatMessages).toBe(messages);
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.compactionInFlight).toBe(true);
    expect(controller.state.chatRunId).toBe('newer-run');
  },
);

test.each([
  ['settled', true],
  ['unknown', true],
  ['settled', false],
  ['unknown', false],
] as const)(
  'retires an older manual %s receipt without restoring it over a newer run (automatic card: %s)',
  async (phase, automaticCard) => {
    const { controller, lifecycle, operationId } = await interruptedCompaction();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => ({
      ...params,
      phase: method === 'sessions.compaction.abort' ? 'settled' : phase,
      outcome: method === 'sessions.compaction.abort' ? 'aborted' : 'completed',
      markerExpected: false,
    }));
    const client = { request, stop: vi.fn() };
    controller.state.client = client as never;
    controller.state.connected = true;
    if (automaticCard) {
      lifecycle.handleCompactionPhase('start', sessionKey, { operationId: 'newer-automatic' });
    }
    controller.state.chatSending = true;
    controller.state.chatRunId = 'newer-run';
    controller.state.lastError = 'newer run status';
    const messages = controller.state.chatMessages;
    const internals = controller as unknown as {
      manualCompactionRecoveryGeneration: number;
      manualCompactionOperations: Map<string, unknown>;
      reconcileManualCompactions(client: unknown, generation: number): Promise<void>;
    };
    await internals.reconcileManualCompactions(
      client,
      internals.manualCompactionRecoveryGeneration,
    );
    expect(request).toHaveBeenCalledWith('sessions.compaction.status', {
      key: sessionKey,
      operationId,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      phase === 'unknown'
        ? ['sessions.compaction.status', 'sessions.compaction.abort']
        : ['sessions.compaction.status'],
    );
    expect(internals.manualCompactionOperations.size).toBe(0);
    expect(controller.state.chatMessages).toEqual(messages);
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.compactionInFlight).toBe(automaticCard);
    expect(controller.state.chatRunId).toBe('newer-run');
    expect(controller.state.lastError).toBe('newer run status');
  },
);

test('retires a delayed live manual terminal without changing the newer run restored by reconnect history', async () => {
  const { controller, lifecycle, operationId } = await interruptedCompaction();
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'sessions.compaction.status') return { ...params, phase: 'in-progress' };
    if (method === 'chat.startup' || method === 'chat.history') {
      return {
        messages: [{ role: 'user', content: 'newer task' }],
        sessionId: 'native-newer-run-session',
        sessionInfo: {
          sessionId: 'native-newer-run-session',
          hasActiveRun: true,
          activeRunIds: ['newer-run'],
          status: 'running',
        },
        inFlightRun: {
          runId: 'newer-run',
          startedAt: Date.now(),
          text: 'Newer live response',
          events: [],
        },
      };
    }
    return {};
  });
  controller.state.client = { request, stop: vi.fn() } as never;
  lifecycle.handleHello({});
  await flush();
  expect(controller.state.chatRunId).toBe('newer-run');
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId: 'newer-run',
    status: 'running',
  });
  controller.state.lastError = 'newer run status';
  const messages = controller.state.chatMessages;
  const activeTurn = controller.state.transcript.activeTurn;
  const compactionInFlight = controller.state.compactionInFlight;
  const callCount = request.mock.calls.length;
  (
    controller as unknown as { handleEvent(event: { event: string; payload: unknown }): void }
  ).handleEvent({
    event: 'session.operation',
    payload: {
      operation: 'compact',
      phase: 'end',
      sessionKey,
      operationId,
      completed: true,
      outcome: 'completed',
      markerExpected: false,
      tokensBefore: 100,
      tokensAfter: 20,
    },
  });
  expect(
    (controller as unknown as { manualCompactionOperations: Map<string, unknown> })
      .manualCompactionOperations.size,
  ).toBe(0);
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('newer-run');
  expect(controller.state.transcript.activeTurn).toBe(activeTurn);
  expect(controller.state.chatMessages).toBe(messages);
  expect(controller.state.compactionInFlight).toBe(compactionInFlight);
  expect(controller.state.lastError).toBe('newer run status');
  expect(request).toHaveBeenCalledTimes(callCount);
  (
    controller as unknown as { handleEvent(event: { event: string; payload: unknown }): void }
  ).handleEvent({
    event: 'session.operation',
    payload: {
      operation: 'compact',
      phase: 'end',
      sessionKey,
      operationId,
      completed: true,
      outcome: 'completed',
      markerExpected: false,
    },
  });
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatMessages).toBe(messages);
  expect(request).toHaveBeenCalledTimes(callCount);
});

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../chat-controller';

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:compaction-lifecycle';
  controller.state.connected = true;
  const emit = (phase: string, data: Record<string, unknown> = {}) =>
    (
      controller as unknown as {
        handleCompactionPhase(phase: string, key: string, data: Record<string, unknown>): void;
      }
    ).handleCompactionPhase(phase, controller.state.sessionKey, data);
  return { controller, emit };
}

test.each(['Compaction cancelled', 'Error: Compaction cancelled', 'aborted'])(
  'preserves native cancellation without an outcome field: %s',
  reason => {
    const { controller, emit } = setup();
    emit('start', { operationId: 'native-operation' });
    emit('end', { operationId: 'native-operation', completed: false, reason });
    expect(controller.state.compactionInFlight).toBe(false);
    expect(controller.state.chatMessages[0]).toMatchObject({
      __openclaw: { phase: 'aborted', reason },
    });
  },
);

test('does not hide an actual failure behind an arbitrary cancellation substring', () => {
  const { controller, emit } = setup();
  emit('start');
  emit('end', { completed: false, reason: 'provider failed after compaction cancelled' });
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'failed' } });
});

test.each([true, false])(
  'does not wait for a marker after endpoint compaction when history succeeds: %s',
  async historySucceeds => {
    vi.useFakeTimers();
    const { controller } = setup();
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.compact') {
        return {
          ok: true,
          compacted: true,
          result: { kind: 'server-endpoint', tokensBefore: 100, tokensAfter: 20 },
        };
      }
      if (!historySucceeds) throw new Error('history unavailable');
      return { messages: [] };
    });
    controller.state.client = { request } as never;
    await controller.sendMessage('/compact');
    expect(request.mock.calls.map(call => call[0])).toEqual(['sessions.compact', 'chat.history']);
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatMessages[0]).toMatchObject({
      __openclaw: { phase: 'completed', tokensBefore: 100, tokensAfter: 20 },
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('completes marker-free automatic recovery without scheduling marker catchup', () => {
  vi.useFakeTimers();
  const { controller, emit } = setup();
  emit('start', { itemId: 'recovery' });
  emit('end', { itemId: 'recovery', completed: true, outcome: 'completed', markerExpected: false });
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'completed' } });
  expect(vi.getTimerCount()).toBe(0);
});

test.each([true, false])(
  'refreshes manual marker-free history once when native end precedes the RPC (history succeeds: %s)',
  async historySucceeds => {
    vi.useFakeTimers();
    const { controller, emit } = setup();
    let finishCompact!: (result: unknown) => void;
    const compact = new Promise(resolve => {
      finishCompact = resolve;
    });
    let operationId = '';
    const authoritativeMessage = { role: 'assistant', content: 'Retained current context' };
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.compact') {
        operationId = params.operationId as string;
        return compact;
      }
      if (method === 'chat.history') {
        if (!historySucceeds) throw new Error('history unavailable');
        return { messages: [authoritativeMessage] };
      }
      throw new Error('Unexpected RPC: ' + method);
    });
    controller.state.client = { request } as never;
    controller.state.chatMessages = [{ role: 'assistant', content: 'Previous context' }];
    const compacting = controller.sendMessage('/compact');
    const terminal = {
      operationId,
      completed: true,
      outcome: 'completed',
      markerExpected: false,
      tokensBefore: 100,
      tokensAfter: 20,
    };
    emit('end', terminal);
    finishCompact({
      ok: true,
      compacted: true,
      markerExpected: false,
      result: { kind: 'server-endpoint', tokensBefore: 100, tokensAfter: 20 },
    });
    await compacting;
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(call => call[0])).toEqual(['sessions.compact', 'chat.history']);
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatMessages).toContainEqual(
      expect.objectContaining({
        __openclaw: expect.objectContaining({
          phase: 'completed',
          tokensBefore: 100,
          tokensAfter: 20,
        }),
      }),
    );
    if (historySucceeds) expect(controller.state.chatMessages).toContainEqual(authoritativeMessage);
    emit('end', terminal);
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('does not refresh a newer automatic compaction from a delayed manual terminal and RPC', async () => {
  vi.useFakeTimers();
  const { controller, emit } = setup();
  let finishCompact!: (result: unknown) => void;
  const compact = new Promise(resolve => {
    finishCompact = resolve;
  });
  let operationId = '';
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    operationId = params.operationId as string;
    if (method !== 'sessions.compact') throw new Error('Unexpected RPC: ' + method);
    return compact;
  });
  controller.state.client = { request } as never;
  const compacting = controller.sendMessage('/compact');
  emit('start', { operationId: 'newer-automatic-operation' });
  emit('end', { operationId, completed: true, outcome: 'completed', markerExpected: false });
  finishCompact({
    ok: true,
    compacted: true,
    markerExpected: false,
    result: { kind: 'server-endpoint' },
  });
  await compacting;
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages[0]).toMatchObject({ __openclaw: { phase: 'in-progress' } });
});

test('does not assign current RPC token counts to a delayed earlier marker when a marker is expected', async () => {
  const { controller } = setup();
  const earlierMarker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'earlier-marker-without-accounting' },
  };
  const request = vi.fn(async (method: string) =>
    method === 'sessions.compact'
      ? {
          ok: true,
          compacted: true,
          markerExpected: true,
          result: { tokensBefore: 100, tokensAfter: 20 },
        }
      : { messages: [earlierMarker] },
  );
  controller.state.client = { request } as never;
  await controller.sendMessage('/compact');
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.compact',
    'chat.history',
  ]);
  expect(controller.state.chatMessages).toContainEqual(earlierMarker);
});

test.each(['unknown', 'wrong-operation', 'wrong-session', 'missing-outcome'])(
  'does not unlock an uncertain cancellation using %s evidence',
  async evidence => {
    const { controller } = setup();
    let rejectCompact!: (error: Error) => void;
    const compact = new Promise((_resolve, reject) => {
      rejectCompact = reject;
    });
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.compact') return compact;
      rejectCompact(new Error('connection closed'));
      return {
        ...params,
        phase: evidence === 'unknown' ? 'unknown' : 'settled',
        outcome: evidence === 'missing-outcome' ? undefined : 'aborted',
        ...(evidence === 'wrong-operation' ? { operationId: 'another-operation' } : {}),
        ...(evidence === 'wrong-session' ? { key: 'another-session' } : {}),
      };
    });
    controller.state.client = { request } as never;
    const compacting = controller.sendMessage('/compact');
    await expect(controller.cancelManualCompaction(controller.state.sessionKey)).rejects.toThrow();
    await compacting;
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.compactionInFlight).toBe(true);
    expect(request.mock.calls.filter(call => call[0] === 'sessions.compact')).toHaveLength(1);
  },
);

test('uses the native terminal after transport loss without aborting newer session work', async () => {
  const { controller, emit } = setup();
  let rejectCompact!: (error: Error) => void;
  const compact = new Promise((_resolve, reject) => {
    rejectCompact = reject;
  });
  let operationId = '';
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'sessions.compact') {
      operationId = params.operationId as string;
      return compact;
    }
    throw new Error('connection closed');
  });
  controller.state.client = { request } as never;
  const compacting = controller.sendMessage('/compact');
  await expect(controller.cancelManualCompaction(controller.state.sessionKey)).rejects.toThrow();
  emit('end', { operationId, completed: false, outcome: 'aborted' });
  rejectCompact(new Error('late connection closed'));
  await compacting;
  const originalKey = controller.state.sessionKey;
  controller.state.sessionKey = 'agent:main:justdo:new-session';
  controller.state.chatSending = true;
  await controller.cancelManualCompaction(originalKey);
  expect(controller.state.chatSending).toBe(true);
  expect(request.mock.calls.filter(call => call[0] === 'sessions.compaction.abort')).toHaveLength(
    1,
  );
});

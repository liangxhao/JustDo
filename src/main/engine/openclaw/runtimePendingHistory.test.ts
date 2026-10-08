import { expect, test, vi } from 'vitest';

import { fetchNativePendingHistory } from './runtimePendingHistory';

const pending = (id: number) => ({ id: String(id), runId: `run-${id}`, acceptedAt: id,
  state: 'queued', message: { role: 'user', content: `pending-${id}`, timestamp: id } });
const tail = (items: unknown[] = [], extra: Record<string, unknown> = {}) => ({ sessionId: 'native-1',
  messages: [{ role: 'assistant', content: 'history', __openclaw: { id: 'existing' } }],
  hasMore: false, deltaCursor: 'c1', pendingInputs: { items, total: items.length }, ...extra });
const delta = (params: Record<string, unknown>, extra = {}) => ({ sessionInfo: { sessionId: 'native-1' }, kind: 'delta', messages: [], deltaCursor: 'c2',
  inputReceipts: (params.inputRunIds as string[] | undefined)?.map(runId => ({ runId, state: 'pending' })), ...extra });

test('reads all pending pages independently and never publishes pending bodies into the existing cache', async () => {
  const publish = vi.fn();
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.sessionId !== undefined && params.messageId === undefined) throw new Error('sessionId requires messageId');
    if (params.cursor) return delta(params);
    if (params.pendingBefore) return tail([pending(1)]);
    if (params.limit === 1) return tail();
    return tail(Array.from({ length: 20 }, (_, i) => pending(21 - i)), {
      pendingInputs: { items: Array.from({ length: 20 }, (_, i) => pending(21 - i)), total: 21, nextBefore: 2 },
    });
  });
  const result = await fetchNativePendingHistory({ request } as never, 'key', undefined, publish);
  expect(result.pendingInputs).toHaveLength(21);
  expect(request.mock.calls.some(([, params]) => params.pendingBefore === 2)).toBe(true);
  expect(request.mock.calls.every(([, params]) => !('sessionId' in params))).toBe(true);
  expect(JSON.stringify(publish.mock.calls)).not.toContain('pending-');
});

test('normal polling preserves cached canonical history and does not walk old history offsets', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.cursor ? delta(params) : tail([pending(1)], { hasMore: true, nextOffset: 500, totalMessages: 1000 }));
  const cached = { messages: [{ role: 'user', content: 'cached-history' }], deltaCursor: 'previous' };
  const result = await fetchNativePendingHistory({ request } as never, 'key', cached);
  expect(result.messages[0]).toEqual(cached.messages[0]);
  expect(request.mock.calls.some(([, params]) => params.offset !== undefined)).toBe(false);
});

test('rejects receipts from a reset physical session even when its delta cursor is valid', async () => {
  const publish = vi.fn();
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.cursor ? delta(params, { sessionInfo: { sessionId: 'physical-after-reset' } }) : tail([pending(1)]));
  await expect(fetchNativePendingHistory({ request } as never, 'key', undefined, publish)).rejects.toThrow('session changed');
  expect(publish).not.toHaveBeenCalled();
});

test('consumed receipts use native metadata identity and catch up canonical input during pagination', async () => {
  const canonical = { role: 'user', content: 'consumed', __openclaw: { id: 'event-1' } };
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.cursor) return delta(params, { messages: [canonical], inputReceipts: [{ runId: 'run-1', state: 'consumed', consumedByEventId: 'event-1' }] });
    return tail([pending(1)]);
  });
  const result = await fetchNativePendingHistory({ request } as never, 'key');
  expect(result.pendingInputs).toEqual([]);
  expect(result.messages).toContainEqual(canonical);
});

test('refreshes a full snapshot when a consumed body is outside the first generation', async () => {
  let reads = 0;
  const canonical = { role: 'user', content: 'consumed', __openclaw: { id: 'event-1' } };
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.cursor) return delta(params, { inputReceipts: [{ runId: 'run-1', state: 'consumed', consumedByEventId: 'event-1' }] });
    reads += 1;
    return reads === 1 ? tail([pending(1)]) : tail([pending(1)], { messages: [canonical] });
  });
  const result = await fetchNativePendingHistory({ request } as never, 'key');
  expect(result.messages).toEqual([canonical]);
  expect(reads).toBeGreaterThan(1);
});

test('rejects nonadvancing pending pages and a reset physical session', async () => {
  const repeated = vi.fn(async () => tail([], { pendingInputs: { items: [], total: 2, nextBefore: 2 } }));
  await expect(fetchNativePendingHistory({ request: repeated } as never, 'key')).rejects.toThrow('pagination');
  const reset = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.cursor) return delta(params);
    return tail([], { sessionId: params.limit === 1 ? 'new-session' : 'native-1' });
  });
  await expect(fetchNativePendingHistory({ request: reset } as never, 'key')).rejects.toThrow('session changed');
});

test('deduplicates the native runId:user identity even when a receipt remains pending', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => params.cursor ?
    delta(params, { messages: [{ role: 'user', content: 'canonical', __openclaw: { idempotencyKey: 'run-1:user' } }] }) : tail([pending(1)]));
  expect((await fetchNativePendingHistory({ request } as never, 'key')).pendingInputs).toEqual([]);
});

test('hydrates pending messages natively without falling back to stored transcript', async () => {
  const truncated = { ...pending(1), message: { role: 'user', content: 'short', __openclaw: { id: 'pending:1', truncated: true } } };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'chat.message.get') return { ok: true, message: { role: 'user', content: 'complete' } };
    return params.cursor ? delta(params) : tail([truncated]);
  });
  const result = await fetchNativePendingHistory({ request } as never, 'key');
  expect(result.pendingInputs[0].message.content).toBe('complete');
  expect(request.mock.calls.some(([method]) => method === 'runtimeServices.historyMessage')).toBe(false);
});

test.each(['not_found', 'not_visible'])('retires an unavailable pending input without run identity: %s', async reason => {
  const item = { ...pending(1), runId: undefined, message: { role: 'user', content: 'short', __openclaw: { id: 'pending:1', truncated: true } } };
  const canonical = { role: 'user', content: 'consumed', __openclaw: { id: 'event-1' } };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'chat.message.get') return { ok: false, unavailableReason: reason };
    return params.cursor ? delta(params, { messages: [canonical] }) : tail([item]);
  });
  const result = await fetchNativePendingHistory({ request } as never, 'key');
  expect(result.pendingInputs).toEqual([]);
  expect(result.messages).toContainEqual(canonical);
});

test('retains a truncated pending placeholder after a transient hydration failure', async () => {
  const item = { ...pending(1), runId: undefined, message: { role: 'user', content: 'short', __openclaw: { id: 'pending:1', truncated: true } } };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'chat.message.get') throw new Error('transport unavailable');
    return params.cursor ? delta(params) : tail([item]);
  });
  expect((await fetchNativePendingHistory({ request } as never, 'key')).pendingInputs).toEqual([item]);
});

const emptyHistory = (extra: Record<string, unknown> = {}) => ({
  sessionKey: 'key',
  messages: [],
  hasMore: false,
  totalMessages: 0,
  pendingInputs: { items: [], total: 0 },
  ...extra,
});

test.each([undefined, 'native-1'])('reads confirmed empty history before a transcript exists: %s', async sessionId => {
  const publish = vi.fn();
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>) =>
    emptyHistory(sessionId ? { sessionId } : {}));
  const cached = { messages: [{ role: 'user', content: 'stale' }], deltaCursor: 'stale-cursor' };

  await expect(fetchNativePendingHistory({ request } as never, 'key', cached, publish)).resolves.toEqual({
    sessionKey: 'key', messages: [], pendingInputs: [],
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([, params]) => !('cursor' in params))).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});

test('retries if the native session appears while confirming unprepared empty history', async () => {
  let reads = 0;
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.cursor) return delta(params);
    reads += 1;
    return reads === 1 ? emptyHistory() : tail();
  });
  const publish = vi.fn();

  const result = await fetchNativePendingHistory({ request } as never, 'key', undefined, publish);

  expect(result.messages).toEqual(tail().messages);
  expect(publish).toHaveBeenCalledWith(tail().messages, 'c2');
});

test('reads accepted pending input before the first transcript and never publishes it as history', async () => {
  const publish = vi.fn();
  const item = pending(1);
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    emptyHistory({ sessionId: 'native-1', pendingInputs: { items: [item], total: 1 },
      ...(params.inputRunIds ? { inputReceipts: [{ runId: 'run-1', state: 'pending' }] } : {}),
    }));

  await expect(fetchNativePendingHistory({ request } as never, 'key', undefined, publish)).resolves.toEqual({
    sessionKey: 'key', messages: [], pendingInputs: [item],
  });
  expect(request.mock.calls.every(([, params]) => !('cursor' in params))).toBe(true);
  expect(request.mock.calls.some(([, params]) => params.inputRunIds)).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});

test('restarts with canonical history when the first pending input is consumed during the read', async () => {
  const canonical = { role: 'user', content: 'pending-1', __openclaw: { id: 'event-1' } };
  let consumed = false;
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.inputRunIds) consumed = true;
    if (params.cursor) return delta(params);
    return consumed ? tail([], { messages: [canonical] }) : emptyHistory({
      sessionId: 'native-1', pendingInputs: { items: [pending(1)], total: 1 },
    });
  });
  const publish = vi.fn();

  const result = await fetchNativePendingHistory({ request } as never, 'key', undefined, publish);

  expect(result.messages).toEqual([canonical]);
  expect(result.pendingInputs).toEqual([]);
  expect(publish).toHaveBeenCalledWith([canonical], 'c2');
});

test('retries cursorless pending history when cancellation changes its display state', async () => {
  let reads = 0;
  const cancelled = { ...pending(1), state: 'cancelled' };
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    reads += 1;
    return emptyHistory({ sessionId: 'native-1',
      pendingInputs: { items: [reads === 1 ? pending(1) : cancelled], total: 1 },
      ...(params.inputRunIds ? { inputReceipts: [{ runId: 'run-1', state: 'pending', cancelled: true }] } : {}),
    });
  });

  expect((await fetchNativePendingHistory({ request } as never, 'key')).pendingInputs).toEqual([cancelled]);
});

test.each([true, false])('rechecks older cursorless pending pages after cancellation (run identity: %s)', async correlated => {
  const newest = Array.from({ length: 20 }, (_, index) => pending(21 - index));
  const older = { ...pending(1), ...(correlated ? {} : { runId: undefined }) };
  let cancelled = false;
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.inputRunIds) cancelled = true;
    const items = params.pendingBefore
      ? [{ ...older, state: cancelled ? 'cancelled' : 'queued' }]
      : newest;
    return emptyHistory({
      sessionId: 'native-1',
      pendingInputs: { items, total: 21, ...(params.pendingBefore ? {} : { nextBefore: 2 }) },
      ...(params.inputRunIds ? { inputReceipts: (params.inputRunIds as string[]).map(runId => ({
        runId, state: 'pending', ...(runId === 'run-1' ? { cancelled: true } : {}),
      })) } : {}),
    });
  });

  const result = await fetchNativePendingHistory({ request } as never, 'key');

  expect(result.pendingInputs).toHaveLength(21);
  expect(result.pendingInputs.find(item => item.id === '1')?.state).toBe('cancelled');
});

test('retires an older cursorless cancelled input when it is withdrawn during pagination', async () => {
  const newest = Array.from({ length: 20 }, (_, index) => pending(21 - index));
  let withdrawn = false;
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.inputRunIds) withdrawn = true;
    return emptyHistory({
      sessionId: 'native-1',
      pendingInputs: { items: params.pendingBefore ? [{ ...pending(1), state: 'cancelled',
        message: { role: 'user', content: withdrawn ? [] : 'withdrawn prompt',
          ...(withdrawn ? { display: false } : {}),
        },
      }] : newest, total: 21, ...(params.pendingBefore ? {} : { nextBefore: 2 }) },
      ...(params.inputRunIds ? { inputReceipts: (params.inputRunIds as string[]).map(runId => ({
        runId, state: 'pending', ...(runId === 'run-1' ? { cancelled: true } : {}),
      })) } : {}),
    });
  });

  const result = await fetchNativePendingHistory({ request } as never, 'key');

  expect(result.pendingInputs).toHaveLength(20);
  expect(JSON.stringify(result)).not.toContain('withdrawn prompt');
});

test('rejects cursorless pending history if native identity changes or receipts are unavailable', async () => {
  const publish = vi.fn();
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => emptyHistory({
    sessionId: params.inputRunIds ? 'other-session' : 'native-1',
    pendingInputs: { items: [pending(1)], total: 1 },
    inputReceipts: [{ runId: 'run-1', state: 'pending' }],
  }));
  await expect(fetchNativePendingHistory({ request } as never, 'key', undefined, publish)).rejects.toThrow('session changed');
  request.mockImplementation(async () => emptyHistory({
    sessionId: 'native-1', pendingInputs: { items: [pending(1)], total: 1 },
  }));
  await expect(fetchNativePendingHistory({ request } as never, 'key', undefined, publish)).rejects.toThrow('receipts');
  expect(publish).not.toHaveBeenCalled();
});

test.each([
  { messages: [{ role: 'user', content: 'history' }] },
  { totalMessages: 1 },
  { hasMore: true, nextOffset: 1 },
  { pendingInputs: { items: [pending(1)], total: 1 } },
  { pendingInputs: undefined },
  { pendingInputs: { items: [], total: 1 } },
  { sessionId: 123 },
  { deltaCursor: 'cursor-without-identity' },
])('rejects incomplete or malformed history instead of treating it as an empty conversation: %j', async extra => {
  const publish = vi.fn();
  const request = vi.fn(async () => emptyHistory(extra));

  await expect(fetchNativePendingHistory({ request } as never, 'key', undefined, publish)).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
});

test('rejects a failed empty-history confirmation instead of hiding a Gateway error', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.limit === 1) throw new Error('Gateway unavailable');
    return emptyHistory();
  });

  await expect(fetchNativePendingHistory({ request } as never, 'key')).rejects.toThrow('Gateway unavailable');
});

test('requires the native delta sessionInfo identity before publishing a snapshot', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.cursor ? delta(params, { sessionInfo: undefined }) : tail());
  const publish = vi.fn();

  await expect(fetchNativePendingHistory({ request } as never, 'key', undefined, publish)).rejects.toThrow('session changed');
  expect(publish).not.toHaveBeenCalled();
});

import { expect, test, vi } from 'vitest';

import { fetchNativePendingHistory } from './runtimePendingHistory';

const pending = (id: number) => ({ id: String(id), runId: `run-${id}`, acceptedAt: id,
  state: 'queued', message: { role: 'user', content: `pending-${id}`, timestamp: id } });
const tail = (items: unknown[] = [], extra: Record<string, unknown> = {}) => ({ sessionId: 'native-1',
  messages: [{ role: 'assistant', content: 'history', __openclaw: { id: 'existing' } }],
  hasMore: false, deltaCursor: 'c1', pendingInputs: { items, total: items.length }, ...extra });
const delta = (params: Record<string, unknown>, extra = {}) => ({ sessionId: 'native-1', kind: 'delta', messages: [], deltaCursor: 'c2',
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
    params.cursor ? delta(params, { sessionId: 'physical-after-reset' }) : tail([pending(1)]));
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

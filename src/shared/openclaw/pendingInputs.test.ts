import { describe, expect, test } from 'vitest';

import { filterNativePendingInputsByReceipts, parseNativePendingInputs } from './pendingInputs';

const item = (id: string, state = 'queued', display = true) => ({ id, runId: id, acceptedAt: 100,
  state, message: { role: 'user', content: id, display } });
describe('native pending custody', () => {
  test('preserves accepted inputs even without native memory queue flags', () => {
    const page = parseNativePendingInputs({ items: [item('a')], total: 1, queuedCount: 0 });
    expect(page?.items).toHaveLength(1);
    expect(filterNativePendingInputsByReceipts(page!.items, [{ runId: 'a', state: 'pending' }], ['a'])).toHaveLength(1);
  });
  test('keeps visible cancelled inputs but removes withdrawn, consumed and absent exact receipts', () => {
    const page = parseNativePendingInputs({ items: [item('cancelled', 'cancelled'), item('hidden', 'cancelled', false), item('used'), item('gone'), item('raced')], total: 5 })!;
    expect(filterNativePendingInputsByReceipts(page.items, [
      { runId: 'cancelled', state: 'pending', cancelled: true },
      { runId: 'hidden', state: 'pending', cancelled: true },
      { runId: 'used', state: 'consumed', consumedByEventId: 'e1' },
      { runId: 'raced', state: 'pending', cancelled: true },
    ], page.items.map(value => value.runId!)).map(value => value.id)).toEqual(['cancelled']);
  });
  test('rejects malformed cursors, duplicate identities and unrelated receipts', () => {
    expect(() => parseNativePendingInputs({ items: [], total: 0, nextBefore: 0 })).toThrow();
    expect(() => parseNativePendingInputs({ items: [item('a'), item('a')], total: 2 })).toThrow();
    expect(() => filterNativePendingInputsByReceipts([], [{ runId: 'other', state: 'pending' }], ['a'])).toThrow();
  });
});

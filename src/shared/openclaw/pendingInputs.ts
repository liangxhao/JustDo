/** Native 9.8 accepted-input custody, separate from durable transcript messages. */
export type NativePendingInput = {
  id: string;
  runId?: string;
  message: Record<string, unknown>;
  acceptedAt: number;
  state: 'queued' | 'cancelled' | 'interrupted';
  queued?: true;
};
export type NativePendingInputsPage = {
  items: NativePendingInput[];
  total: number;
  queuedCount?: number;
  nextBefore?: number;
};
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const runId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

export function parseNativePendingInputs(value: unknown): NativePendingInputsPage | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 20 ||
      !natural(value.total) || (value.queuedCount !== undefined && !natural(value.queuedCount)) ||
      (value.nextBefore !== undefined && (!natural(value.nextBefore) || value.nextBefore === 0))) {
    throw new Error('Invalid native pending-input page');
  }
  const seen = new Set<string>();
  const items = value.items.map(item => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id) ||
        (item.runId !== undefined && !runId(item.runId)) || !record(item.message) ||
        typeof item.acceptedAt !== 'number' || !Number.isFinite(item.acceptedAt) ||
        !['queued', 'cancelled', 'interrupted'].includes(String(item.state)) ||
        (item.queued !== undefined && item.queued !== true)) {
      throw new Error('Invalid native pending input');
    }
    seen.add(item.id);
    return item as NativePendingInput;
  });
  return { items, total: value.total,
    ...(value.queuedCount !== undefined ? { queuedCount: value.queuedCount as number } : {}),
    ...(value.nextBefore !== undefined ? { nextBefore: value.nextBefore as number } : {}) };
}

export function filterNativePendingInputsByReceipts(
  items: readonly NativePendingInput[],
  receipts: unknown,
  queriedRunIds: readonly string[],
): NativePendingInput[] {
  if (!Array.isArray(receipts) || receipts.length > 50) throw new Error('Invalid native input receipts');
  const queried = new Set(queriedRunIds);
  const pending = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (!record(receipt) || !runId(receipt.runId) || !queried.has(receipt.runId) || seen.has(receipt.runId) ||
        !['pending', 'consumed'].includes(String(receipt.state)) ||
        (receipt.state === 'consumed' && (typeof receipt.consumedByEventId !== 'string' || !receipt.consumedByEventId)) ||
        (receipt.queued !== undefined && receipt.queued !== true) ||
        (receipt.cancelled !== undefined && receipt.cancelled !== true)) {
      throw new Error('Invalid native input receipt');
    }
    seen.add(receipt.runId);
    if (receipt.state === 'pending') pending.set(receipt.runId, receipt);
  }
  return items.filter(item => {
    if (item.message.display === false) return false;
    if (!item.runId || !queried.has(item.runId)) return true;
    const receipt = pending.get(item.runId);
    return Boolean(receipt && (!receipt.cancelled || item.state === 'cancelled'));
  });
}

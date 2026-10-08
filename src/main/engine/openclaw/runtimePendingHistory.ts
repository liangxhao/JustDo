import {
  filterNativePendingInputsByReceipts,
  type NativePendingInput,
  parseNativePendingInputs,
} from '../../../shared/openclaw/pendingInputs';
import type { GatewayClientLike } from '../gateway/types';
import {
  FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS,
  FULL_HISTORY_SYNC_LIMIT,
  mergeGatewayHistoryPages,
} from './runtimeAdapterSupport';
import { parseChatHistoryCursorResultV2026_9_8, parseChatHistoryResultV2026_9_8 } from './wire/v2026_9_8';

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const historySessionId = (page: Record<string, unknown>): unknown => {
  if (page.kind === 'delta') {
    return record(page.sessionInfo) ? page.sessionInfo.sessionId : undefined;
  }
  return page.sessionId;
};

const isEmptyCanonicalHistoryWithoutCursor = (raw: Record<string, unknown>): boolean => {
  const page = parseChatHistoryResultV2026_9_8(raw);
  return (
    !page.deltaCursor &&
    !page.hasMore &&
    page.messages.length === 0 &&
    (page.totalMessages ?? 0) === 0
  );
};

const isEmptyHistoryWithoutCursor = (raw: Record<string, unknown>): boolean => {
  const pending = parseNativePendingInputs(raw.pendingInputs);
  return (
    isEmptyCanonicalHistoryWithoutCursor(raw) &&
    pending !== undefined &&
    pending.items.length === 0 &&
    pending.total === 0 &&
    (pending.queuedCount ?? 0) === 0 &&
    pending.nextBefore === undefined
  );
};

// A cursorless transcript has no generation fence. Confirm accepted-input
// membership/state separately before returning this request-local projection.
const pendingPageIdentity = (raw: Record<string, unknown>): string => {
  const page = parseNativePendingInputs(raw.pendingInputs);
  if (!page) throw new Error('Missing native pending page');
  return JSON.stringify([
    page.total, page.queuedCount ?? 0, page.nextBefore,
    page.items.map(item => [item.id, item.runId, item.acceptedAt, item.state, item.queued, item.message.display]),
  ]);
};

/** A request-local projection only: pending bodies never enter Main's history snapshot map. */
export async function fetchNativePendingHistory(
  client: Pick<GatewayClientLike, 'request'>,
  sessionKey: string,
  cached?: { messages: unknown[]; deltaCursor: string },
  publishCanonical?: (messages: unknown[], deltaCursor: string) => void,
) {
  for (let attempt = 0; attempt < FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const read = async (params: Record<string, unknown>) => {
        const result = await client.request('chat.history', { sessionKey, ...params });
        if (!record(result)) throw new Error('Invalid native history');
        return result;
      };
      const first = await read({ limit: cached && attempt === 0 ? 20 : FULL_HISTORY_SYNC_LIMIT });
      const sessionId = historySessionId(first);
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) {
        throw new Error('Invalid native history identity');
      }
      const checkIdentity = (page: Record<string, unknown>) => {
        if (historySessionId(page) !== sessionId) throw new Error('Native history session changed');
      };
      let page = parseChatHistoryResultV2026_9_8(first);
      // A product thread can be read before sessions.create or before its first
      // transcript exists. Native 9.8 then returns an empty page without a cursor
      // (and possibly without sessionId). Confirm it without publishing a cache.
      if (!page.deltaCursor && isEmptyHistoryWithoutCursor(first)) {
        const current = await read({ limit: 1 });
        checkIdentity(current);
        if (!isEmptyHistoryWithoutCursor(current)) throw new Error('Native history snapshot changed');
        return { sessionKey, messages: [], pendingInputs: [] };
      }
      if (sessionId === undefined) throw new Error('Missing native history identity');
      let messages = page.messages;
      let cursor = page.deltaCursor;
      const cursorlessPendingIdentity = !cursor && isEmptyCanonicalHistoryWithoutCursor(first)
        ? pendingPageIdentity(first)
        : undefined;
      if (!cursor && cursorlessPendingIdentity === undefined) throw new Error('Missing native history generation');
      const cursorlessPendingPages = cursorlessPendingIdentity === undefined ? undefined
        : new Map<number | undefined, string>([[undefined, cursorlessPendingIdentity]]);
      if (cursor && cached && attempt === 0) {
        const raw = await read({ cursor: cached.deltaCursor });
        checkIdentity(raw);
        const delta = parseChatHistoryCursorResultV2026_9_8(raw);
        if (delta.kind === 'reset') throw new Error('Native cached history generation changed');
        messages = mergeGatewayHistoryPages(cached.messages, delta.messages);
        cursor = delta.deltaCursor;
        page = { ...page, hasMore: false };
      }
      let offset = 0;
      const total = page.totalMessages;
      while (page.hasMore) {
        if (page.nextOffset === undefined || page.nextOffset <= offset) throw new Error('Invalid native history pagination');
        offset = page.nextOffset;
        const raw = await read({ limit: FULL_HISTORY_SYNC_LIMIT, offset });
        checkIdentity(raw);
        page = parseChatHistoryResultV2026_9_8(raw);
        if (page.totalMessages !== total) throw new Error('Native history snapshot changed');
        messages = mergeGatewayHistoryPages(page.messages, messages);
      }
      let pendingPage = parseNativePendingInputs(first.pendingInputs);
      let pending: NativePendingInput[] = [];
      const ids = new Set<string>();
      let before: number | undefined;
      while (pendingPage) {
        for (const item of pendingPage.items) {
          if (ids.has(item.id)) throw new Error('Native pending page overlapped');
          ids.add(item.id);
          pending.push(item);
        }
        const next = pendingPage.nextBefore;
        if (next === undefined) break;
        if (before !== undefined && next >= before) throw new Error('Invalid native pending pagination');
        before = next;
        const raw = await read({ limit: 20, pendingBefore: next });
        checkIdentity(raw);
        pendingPage = parseNativePendingInputs(raw.pendingInputs);
        if (!pendingPage) throw new Error('Missing native pending page');
        if (cursorlessPendingPages) {
          if (!isEmptyCanonicalHistoryWithoutCursor(raw)) throw new Error('Native history snapshot changed');
          cursorlessPendingPages.set(next, pendingPageIdentity(raw));
        }
      }
      for (const item of pending) {
        const metadata = record(item.message.__openclaw) ? item.message.__openclaw : undefined;
        if (metadata?.truncated !== true || typeof metadata.id !== 'string') continue;
        // Pending inputs are not transcript records. Never fall back to raw
        // transcript chunk readers for an unavailable/withdrawn accepted input.
        const full = await client.request('chat.message.get', {
          sessionKey, messageId: metadata.id, maxChars: 2_000_000,
        }).catch((): null => null);
        if (record(full) && full.ok === true && record(full.message) &&
            !(record(full.message.__openclaw) && full.message.__openclaw.truncated === true)) {
          item.message = full.message;
        } else if (record(full) && full.ok === false &&
            (full.unavailableReason === 'not_visible' || full.unavailableReason === 'not_found')) {
          item.message = { ...item.message, display: false };
        }
      }
      const runIds = [...new Set(pending.flatMap(item => item.runId ? [item.runId] : []))];
      // Exact custody receipts are independent of display pagination. Delta
      // catch-up in each request brings newly consumed user bodies into history.
      for (let index = 0; index < Math.max(1, runIds.length); index += 50) {
        const batch = runIds.slice(index, index + 50);
        const raw = await read({
          ...(cursor ? { cursor } : { limit: FULL_HISTORY_SYNC_LIMIT }),
          ...(batch.length ? { inputRunIds: batch } : {}),
        });
        checkIdentity(raw);
        if (cursor) {
          const delta = parseChatHistoryCursorResultV2026_9_8(raw);
          if (delta.kind === 'reset') throw new Error('Native history generation changed');
          messages = mergeGatewayHistoryPages(messages, delta.messages);
          cursor = delta.deltaCursor;
        } else if (!isEmptyCanonicalHistoryWithoutCursor(raw) ||
            pendingPageIdentity(raw) !== cursorlessPendingIdentity) {
          throw new Error('Native history snapshot changed');
        }
        if (batch.length) {
          pending = filterNativePendingInputsByReceipts(pending, raw.inputReceipts, batch);
          // A consumed receipt whose event is outside this history generation
          // requires another full snapshot, not silently dropping the input.
          for (const receipt of raw.inputReceipts as Array<Record<string, unknown>>) {
            if (receipt.state !== 'consumed') continue;
            const eventId = receipt.consumedByEventId;
            if (!messages.some(message => record(message) &&
              (message.id === eventId || message.messageId === eventId || message.eventId === eventId ||
                (record(message.__openclaw) && message.__openclaw.id === eventId)))) {
              throw new Error('Consumed native input requires refreshed history');
            }
          }
        }
      }
      // Native history pages/cursors use the active key; sessionId is only valid
      // with messageId. Confirm physical identity again before publishing.
      if (cursorlessPendingPages) {
        // Native cancellation/withdrawal changes neither the total nor the
        // newest page. Check every older page, including rows without runId.
        for (const [pendingBefore, identity] of cursorlessPendingPages) {
          if (pendingBefore === undefined) continue;
          const current = await read({ limit: 20, pendingBefore });
          checkIdentity(current);
          if (!isEmptyCanonicalHistoryWithoutCursor(current) || pendingPageIdentity(current) !== identity) {
            throw new Error('Native history snapshot changed');
          }
        }
      }
      const current = await read({ limit: cursor ? 1 : FULL_HISTORY_SYNC_LIMIT });
      checkIdentity(current);
      if (!cursor && (!isEmptyCanonicalHistoryWithoutCursor(current) ||
          pendingPageIdentity(current) !== cursorlessPendingIdentity)) {
        throw new Error('Native history snapshot changed');
      }
      if (cursor) publishCanonical?.(messages, cursor);
      return {
        sessionKey,
        messages,
        pendingInputs: pending.filter(item => item.message.display !== false && !messages.some(message => {
          if (!item.runId || !record(message) || message.role !== 'user') return false;
          const metadata = record(message.__openclaw) ? message.__openclaw : undefined;
          return message.idempotencyKey === `${item.runId}:user` || metadata?.idempotencyKey === `${item.runId}:user`;
        })),
      };
    } catch (error) {
      if (attempt + 1 === FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS) throw error;
    }
  }
  throw new Error('Unable to read native pending history');
}

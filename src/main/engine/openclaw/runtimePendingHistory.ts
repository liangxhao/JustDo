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
      const sessionId = first.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Missing native history identity');
      const checkIdentity = (page: Record<string, unknown>) => {
        if (page.sessionId !== sessionId) throw new Error('Native history session changed');
      };
      let page = parseChatHistoryResultV2026_9_8(first);
      let messages = page.messages;
      let cursor = page.deltaCursor;
      if (!cursor) throw new Error('Missing native history generation');
      if (cached && attempt === 0) {
        const delta = parseChatHistoryCursorResultV2026_9_8(await read({ sessionId, cursor: cached.deltaCursor }));
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
        const raw = await read({ sessionId, limit: FULL_HISTORY_SYNC_LIMIT, offset });
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
        const raw = await read({ sessionId, limit: 20, pendingBefore: next });
        checkIdentity(raw);
        pendingPage = parseNativePendingInputs(raw.pendingInputs);
        if (!pendingPage) throw new Error('Missing native pending page');
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
        const raw = await read({ sessionId, cursor, ...(batch.length ? { inputRunIds: batch } : {}) });
        const delta = parseChatHistoryCursorResultV2026_9_8(raw);
        if (delta.kind === 'reset') throw new Error('Native history generation changed');
        messages = mergeGatewayHistoryPages(messages, delta.messages);
        cursor = delta.deltaCursor;
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
      // Explicit sessionId reads can access archived generations. Confirm that
      // the active key still belongs to this physical session before publishing.
      const current = await read({ limit: 1 });
      checkIdentity(current);
      publishCanonical?.(messages, cursor);
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

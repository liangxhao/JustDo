import { isDeepStrictEqual } from 'node:util';

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
import { parseChatHistoryCursorResultV2026_10_6, parseChatHistoryResultV2026_10_6 } from './wire/v2026_10_6';

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const historySessionId = (page: Record<string, unknown>): unknown => {
  if (page.kind === 'delta') {
    return record(page.sessionInfo) ? page.sessionInfo.sessionId : undefined;
  }
  return page.sessionId;
};

const PendingHistoryStage = {
  Initial: 'initial',
  HistoryPage: 'history_page',
  PendingPage: 'pending_page',
  Receipts: 'receipts',
  Confirmation: 'confirmation',
} as const;
type PendingHistoryStage = (typeof PendingHistoryStage)[keyof typeof PendingHistoryStage];

const PendingHistoryFailureReason = {
  GatewayTimeout: 'gateway_timeout',
  GatewayRequestFailed: 'gateway_request_failed',
  GenerationUnavailable: 'generation_unavailable',
  InvalidSnapshot: 'invalid_snapshot',
} as const;
type PendingHistoryFailureReason = (typeof PendingHistoryFailureReason)[keyof typeof PendingHistoryFailureReason];

export type PendingHistoryFailure = {
  stage: PendingHistoryStage;
  reason: PendingHistoryFailureReason;
  attempts: number;
};

const sessionInfo = (raw: Record<string, unknown>) => record(raw.sessionInfo) ? raw.sessionInfo : undefined;

function canonicalDeltaMessage(entry: unknown): unknown {
  if (!record(entry) || typeof entry.role === 'string' || !('messageSeq' in entry)) return entry;
  if (!Number.isSafeInteger(entry.messageSeq) || !record(entry.message) ||
      typeof entry.message.role !== 'string') {
    throw new Error('Invalid native history delta message envelope');
  }
  // session.message envelopes carry a canonical row with its own native
  // transcript identity. Pending receipts refer to that row.
  return entry.message;
}

const isEmptyCanonicalHistoryWithoutCursor = (raw: Record<string, unknown>): boolean => {
  const page = parseChatHistoryResultV2026_10_6(raw);
  return (
    !page.deltaCursor &&
    !page.hasMore &&
    !page.windowReset &&
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
  onFailure?: (failure: PendingHistoryFailure) => void,
) {
  for (let attempt = 0; attempt < FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    const failure: PendingHistoryFailure = {
      stage: PendingHistoryStage.Initial,
      reason: PendingHistoryFailureReason.InvalidSnapshot,
      attempts: attempt + 1,
    };
    try {
      const read = async (phase: PendingHistoryStage, params: Record<string, unknown>) => {
        failure.stage = phase;
        const result = await client.request('chat.history', { sessionKey, ...params }).catch(error => {
          failure.reason = record(error) && error.code === 'CLIENT_TIMEOUT'
            ? PendingHistoryFailureReason.GatewayTimeout
            : PendingHistoryFailureReason.GatewayRequestFailed;
          throw error;
        });
        if (!record(result)) throw new Error('Invalid native history');
        return result;
      };
      const firstLimit = cached && attempt === 0 ? 20 : FULL_HISTORY_SYNC_LIMIT;
      const first = await read(PendingHistoryStage.Initial, { limit: firstLimit });
      const sessionId = historySessionId(first);
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) {
        throw new Error('Invalid native history identity');
      }
      const checkIdentity = (page: Record<string, unknown>) => {
        if (historySessionId(page) !== sessionId) throw new Error('Native history session changed');
      };
      let page = parseChatHistoryResultV2026_10_6(first);
      if (page.windowReset) throw new Error('Native history snapshot changed');
      // A product thread can be read before sessions.create or before its first
      // transcript exists. Native then returns an empty page without a cursor
      // (and possibly without sessionId). Confirm it without publishing a cache.
      if (!page.deltaCursor && isEmptyHistoryWithoutCursor(first)) {
        const current = await read(PendingHistoryStage.Confirmation, { limit: 1 });
        checkIdentity(current);
        if (!isEmptyHistoryWithoutCursor(current)) throw new Error('Native history snapshot changed');
        return { sessionKey, messages: [], pendingInputs: [] };
      }
      if (sessionId === undefined) throw new Error('Missing native history identity');
      let messages = page.messages;
      let cursor = page.deltaCursor;
      // Native can suppress the tail cursor while an assistant error is pending.
      // A single complete page can be checked by comparing the native projection
      // again, without stitching pages or publishing an incremental snapshot.
      if (!cursor && (page.hasMore || (page.messages.length === 0 && (page.totalMessages ?? 0) > 0))) {
        failure.reason = PendingHistoryFailureReason.GenerationUnavailable;
        throw new Error('Missing native history generation');
      }
      const firstInfo = sessionInfo(first);
      if (!cursor && page.messages.length &&
          (typeof firstInfo?.activeLeafEntryId !== 'string' || !firstInfo.activeLeafEntryId)) {
        failure.reason = PendingHistoryFailureReason.GenerationUnavailable;
        throw new Error('Missing native history active leaf');
      }
      const cursorlessPendingIdentity = cursor ? undefined : pendingPageIdentity(first);
      const firstPage = page;
      const matchesCursorlessHistory = (raw: Record<string, unknown>) => {
        const candidate = parseChatHistoryResultV2026_10_6(raw);
        return !candidate.deltaCursor && !candidate.hasMore && !candidate.windowReset &&
          candidate.totalMessages === firstPage.totalMessages &&
          sessionInfo(raw)?.activeLeafEntryId === firstInfo?.activeLeafEntryId &&
          sessionInfo(raw)?.lifecycleRevision === firstInfo?.lifecycleRevision &&
          isDeepStrictEqual(candidate.messages, firstPage.messages);
      };
      const cursorlessPendingPages = cursorlessPendingIdentity === undefined ? undefined
        : new Map<number | undefined, string>([[undefined, cursorlessPendingIdentity]]);
      if (cursor && cached && attempt === 0) {
        // The first receipt request also advances the cached cursor. The
        // initial full page supplies pending inputs and physical-session identity.
        messages = cached.messages;
        cursor = cached.deltaCursor;
        page = { ...page, hasMore: false };
      }
      let offset = 0;
      const total = page.totalMessages;
      while (page.hasMore) {
        if (page.nextOffset === undefined || page.nextOffset <= offset) throw new Error('Invalid native history pagination');
        offset = page.nextOffset;
        const raw = await read(PendingHistoryStage.HistoryPage, { limit: FULL_HISTORY_SYNC_LIMIT, offset });
        checkIdentity(raw);
        page = parseChatHistoryResultV2026_10_6(raw);
        if (page.windowReset || page.totalMessages !== total) throw new Error('Native history snapshot changed');
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
        const raw = await read(PendingHistoryStage.PendingPage, { limit: 20, pendingBefore: next });
        checkIdentity(raw);
        pendingPage = parseNativePendingInputs(raw.pendingInputs);
        if (!pendingPage) throw new Error('Missing native pending page');
        if (cursorlessPendingPages) {
          if (firstPage.messages.length === 0 && !isEmptyCanonicalHistoryWithoutCursor(raw)) {
            throw new Error('Native history snapshot changed');
          }
          cursorlessPendingPages.set(next, pendingPageIdentity(raw));
        }
      }
      for (const item of pending) {
        const metadata = record(item.message.__openclaw) ? item.message.__openclaw : undefined;
        if (metadata?.truncated !== true || typeof metadata.id !== 'string') continue;
        // Pending inputs are not transcript records. Never fall back to raw
        // transcript chunk readers for an unavailable/withdrawn accepted input.
        const full = await client.request('chat.message.get', {
          sessionKey, sessionId, messageId: metadata.id, maxChars: 2_000_000,
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
        const raw = await read(PendingHistoryStage.Receipts, {
          ...(cursor ? { cursor } : { limit: firstLimit }),
          ...(batch.length ? { inputRunIds: batch } : {}),
        });
        if (cursor) {
          const delta = parseChatHistoryCursorResultV2026_10_6(raw);
          if (delta.kind === 'reset') throw new Error('Native history generation changed');
          checkIdentity(raw);
          messages = mergeGatewayHistoryPages(messages, delta.messages.map(canonicalDeltaMessage));
          cursor = delta.deltaCursor;
        } else {
          checkIdentity(raw);
          if (!matchesCursorlessHistory(raw) || pendingPageIdentity(raw) !== cursorlessPendingIdentity) {
            throw new Error('Native history snapshot changed');
          }
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
          const current = await read(PendingHistoryStage.Confirmation, { limit: 20, pendingBefore });
          checkIdentity(current);
          if ((firstPage.messages.length === 0 && !isEmptyCanonicalHistoryWithoutCursor(current)) ||
              pendingPageIdentity(current) !== identity) {
            throw new Error('Native history snapshot changed');
          }
        }
      }
      const current = await read(PendingHistoryStage.Confirmation, { limit: cursor ? 1 : firstLimit });
      checkIdentity(current);
      if (!cursor && (!matchesCursorlessHistory(current) ||
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
      // A native request can spend half the side-panel request budget waiting.
      // Restart on consistency races, but leave a timed-out read for the next refresh.
      if (failure.reason === PendingHistoryFailureReason.GatewayTimeout || attempt + 1 === FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS) {
        onFailure?.(failure);
        throw error;
      }
    }
  }
  throw new Error('Unable to read native pending history');
}

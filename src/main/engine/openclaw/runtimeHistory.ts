import type { ScheduledTaskSessionHistory } from '../../../shared/scheduledTask/types';
import { readScheduledTaskSessionHistory } from '../../scheduler/scheduledTaskSessionHistory';
import type { GatewayClientLike } from '../gateway/types';
import {
  FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS,
  FULL_HISTORY_SYNC_LIMIT,
  HistorySnapshotChangedError,
  mergeGatewayHistoryPages,
  SESSION_HISTORY_SNAPSHOT_CACHE_LIMIT,
} from './runtimeAdapterSupport';
import {
  parseChatHistoryCursorResultV2026_9_2,
  parseChatHistoryResultV2026_9_2,
} from './wire/v2026_9_2';
export interface RuntimeHistoryContext {
  readonly gatewayClient: GatewayClientLike | null;
  readonly sessionHistorySnapshots: Map<string, { messages: unknown[]; deltaCursor: string }>;
  readonly setSessionHistorySnapshot: (
    sessionKey: string,
    messages: unknown[],
    deltaCursor: string,
  ) => void;
}

export async function fetchSessionHistoryByKey(
  this: RuntimeHistoryContext,
  sessionKey: string,
  fallbackSessionId?: string | null,
  options: { forceFullSnapshot?: boolean; scheduledTaskRun?: boolean } = {},
): Promise<ScheduledTaskSessionHistory | null> {
  const client = this.gatewayClient;
  if (!client) return null;
  if (options.scheduledTaskRun) {
    const runMatch = /^agent:[^:]+:cron:[^:]+:run:([^:]+)$/.exec(sessionKey);
    if (runMatch) {
      // The native key resolver only sees current session entries. Historical
      // cron windows need the physical run identity, even when the alias is gone.
      return readScheduledTaskSessionHistory(
        params => client.request('runtimeServices.scheduledTaskHistory', params),
        sessionKey,
        fallbackSessionId?.trim() || runMatch[1],
      );
    }
  }
  try {
    const fetchHistory = async (key: string): Promise<unknown[]> => {
      const cached = options.forceFullSnapshot ? undefined : this.sessionHistorySnapshots.get(key);
      if (cached) {
        const delta = parseChatHistoryCursorResultV2026_9_2(
          await client.request('chat.history', {
            sessionKey: key,
            cursor: cached.deltaCursor,
          }),
        );
        if (delta.kind === 'delta') {
          const messages = mergeGatewayHistoryPages(cached.messages, delta.messages);
          this.setSessionHistorySnapshot(key, messages, delta.deltaCursor);
          return messages;
        }
        this.sessionHistorySnapshots.delete(key);
      }

      for (let attempt = 1; attempt <= FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
        let messages: unknown[] = [];
        const seenOffsets = new Set<number>();
        let offset: number | undefined;
        let snapshotTotalMessages: number | undefined;
        let deltaCursor: string | undefined;

        try {
          while (true) {
            const raw = await client.request('chat.history', {
              sessionKey: key,
              limit: FULL_HISTORY_SYNC_LIMIT,
              ...(offset !== undefined ? { offset } : {}),
            });
            const page = parseChatHistoryResultV2026_9_2(raw);
            if (offset === undefined) deltaCursor = page.deltaCursor;
            if (page.totalMessages !== undefined) {
              if (snapshotTotalMessages === undefined) {
                snapshotTotalMessages = page.totalMessages;
              } else if (page.totalMessages !== snapshotTotalMessages) {
                throw new HistorySnapshotChangedError();
              }
            }
            // chat.history starts at the newest page; increasing offset walks
            // backward through the transcript. When the byte budget splits one
            // projected record, the next page intentionally replays that record;
            // replace the partial boundary group instead of counting it twice.
            messages = mergeGatewayHistoryPages(page.messages, messages);
            if (!page.hasMore) break;

            const nextOffset = page.nextOffset;
            if (
              nextOffset === undefined ||
              nextOffset <= (offset ?? 0) ||
              seenOffsets.has(nextOffset)
            ) {
              throw new Error('chat.history pagination cursor did not advance');
            }
            seenOffsets.add(nextOffset);
            offset = nextOffset;
          }

          // The cursor is tied to the physical transcript generation. It
          // detects equal-sized reset/compaction/branch changes that a count
          // alone cannot, and catches appends that land after the first page.
          if (deltaCursor !== undefined) {
            const delta = parseChatHistoryCursorResultV2026_9_2(
              await client.request('chat.history', {
                sessionKey: key,
                cursor: deltaCursor,
              }),
            );
            if (delta.kind === 'reset') throw new HistorySnapshotChangedError();
            messages = mergeGatewayHistoryPages(messages, delta.messages);
            deltaCursor = delta.deltaCursor;
            this.setSessionHistorySnapshot(key, messages, deltaCursor);
          } else {
            this.sessionHistorySnapshots.delete(key);
          }
          return messages;
        } catch (error) {
          if (
            !(error instanceof HistorySnapshotChangedError) ||
            attempt === FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS
          ) {
            throw error;
          }
        }
      }
      throw new HistorySnapshotChangedError();
    };
    let resolvedSessionKey = sessionKey;
    let history = await fetchHistory(resolvedSessionKey);

    if (history.length === 0 && fallbackSessionId?.trim()) {
      const resolved = await client
        .request<{ ok?: boolean; key?: string }>('sessions.resolve', {
          sessionId: fallbackSessionId.trim(),
          allowMissing: true,
          includeUnknown: true,
        })
        .catch((): null => null);
      const canonicalKey =
        resolved?.ok === true && typeof resolved.key === 'string' ? resolved.key.trim() : '';
      if (canonicalKey && canonicalKey !== resolvedSessionKey) {
        resolvedSessionKey = canonicalKey;
        history = await fetchHistory(resolvedSessionKey);
      }
    }

    if (history.length === 0) {
      const stored = await client.request<{ messages?: unknown[] }>('sessions.get', {
        key: resolvedSessionKey,
        limit: FULL_HISTORY_SYNC_LIMIT,
      });
      history = Array.isArray(stored?.messages) ? stored.messages : [];
    }
    return {
      sessionKey: resolvedSessionKey,
      messages: history,
    };
  } catch {
    return null;
  }
}

export function setSessionHistorySnapshot(
  this: RuntimeHistoryContext,
  sessionKey: string,
  messages: unknown[],
  deltaCursor: string,
): void {
  this.sessionHistorySnapshots.delete(sessionKey);
  this.sessionHistorySnapshots.set(sessionKey, { messages, deltaCursor });
  while (this.sessionHistorySnapshots.size > SESSION_HISTORY_SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = this.sessionHistorySnapshots.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    this.sessionHistorySnapshots.delete(oldestKey);
  }
}

import { OPENCLAW_HISTORY_DETAIL_MAX_IDS } from '@shared/openclaw/historyIpc';

import { isPersistedFailedAssistantMessage } from '../pipeline/history-display-normalizer';
import type { GatewayClient } from './client';

export const CHAT_HISTORY_INITIAL_LIMIT = 250;
export const CHAT_HISTORY_OLDER_PAGE_LIMIT = 250;
export const CHAT_HISTORY_MAX_CHARS = 500_000;

const CHAT_MESSAGE_GET_MAX_CHARS = 2_000_000;
const HISTORY_MESSAGE_CHUNK_CHARS = 512 * 1024;
const HISTORY_MESSAGE_HYDRATION_CONCURRENCY = 4;
const OFFSET_CURSOR_PREFIX = 'offset:';

type UnknownRecord = Record<string, unknown>;

export type ChatHistoryPage = {
  messages: unknown[];
  hasMore: boolean;
  nextCursor: string | null;
};

const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const readNonNegativeSafeInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const encodeHistoryOffsetCursor = (offset: number): string =>
  `${OFFSET_CURSOR_PREFIX}${offset}`;

export const decodeHistoryOffsetCursor = (cursor: string): number => {
  if (!cursor.startsWith(OFFSET_CURSOR_PREFIX)) throw new Error('Invalid history cursor');
  const offset = Number(cursor.slice(OFFSET_CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor');
  return offset;
};

export const parseChatHistoryPage = (value: unknown): ChatHistoryPage => {
  const result = asRecord(value);
  if (!result || !Array.isArray(result.messages)) {
    throw new Error('OpenClaw chat.history returned an invalid payload');
  }
  if (result.hasMore !== undefined && typeof result.hasMore !== 'boolean') {
    throw new Error('OpenClaw chat.history returned invalid pagination');
  }
  const hasMore = result.hasMore === true;
  const nextOffset = readNonNegativeSafeInteger(result.nextOffset);
  if (hasMore && nextOffset === null) {
    throw new Error('OpenClaw chat.history omitted nextOffset for a partial page');
  }
  return {
    messages: result.messages,
    hasMore,
    nextCursor: hasMore ? encodeHistoryOffsetCursor(nextOffset!) : null,
  };
};

export const isTruncatedHistoryMessage = (message: unknown): boolean => {
  const metadata = asRecord(asRecord(message)?.__openclaw);
  return metadata?.truncated === true;
};

const readHistoryMessageId = (message: unknown): string | null => {
  const metadata = asRecord(asRecord(message)?.__openclaw);
  return typeof metadata?.id === 'string' && metadata.id.trim() ? metadata.id.trim() : null;
};

const isCommentaryProjection = (message: unknown): boolean =>
  asRecord(asRecord(message)?.openclawStreamFallback)?.source === 'segment';

const hasMixedAssistantTextAndTools = (message: unknown): boolean => {
  const record = asRecord(message);
  if (record?.role !== 'assistant' || !Array.isArray(record.content)) return false;
  const types = record.content.map(block =>
    String(asRecord(block)?.type ?? '')
      .toLowerCase()
      .replace(/_/g, ''),
  );
  return (
    types.some(type => type === 'text' || type === 'outputtext') &&
    types.some(type => ['toolcall', 'tooluse', 'toolresult', 'functioncall'].includes(type))
  );
};

const needsFailureDetail = (message: unknown): boolean => {
  const raw = asRecord(message);
  return (
    raw !== null &&
    isPersistedFailedAssistantMessage(raw) &&
    !(typeof raw.errorMessage === 'string' && raw.errorMessage.trim())
  );
};

async function hydrateFailureDetails(
  client: GatewayClient,
  messages: unknown[],
  sessionKey: string,
  isCurrent: () => boolean,
): Promise<unknown[]> {
  const ids = [
    ...new Set(
      messages
        .filter(needsFailureDetail)
        .map(readHistoryMessageId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) return messages;
  const errors = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += OPENCLAW_HISTORY_DETAIL_MAX_IDS) {
    if (!isCurrent()) return messages;
    const batch = ids.slice(offset, offset + OPENCLAW_HISTORY_DETAIL_MAX_IDS);
    try {
      // Fetch only selected display-safe errors, in one visible-transcript read
      // per batch. Do not transfer raw provider diagnostics or response bodies.
      const response = asRecord(
        await client.request('runtimeServices.historyDetails', {
          sessionKey,
          failureMessageIds: batch,
        }),
      );
      const details = asRecord(response?.failureDetails);
      for (const id of batch) {
        const detail = asRecord(details?.[id]);
        if (typeof detail?.errorMessage === 'string' && detail.errorMessage.trim()) {
          errors.set(id, detail.errorMessage.trim());
        }
      }
    } catch {
      // Detail lookup is optional; keep the original history on failure.
    }
  }
  if (errors.size === 0) return messages;
  return messages.map(message => {
    if (!needsFailureDetail(message)) return message;
    const id = readHistoryMessageId(message);
    const errorMessage = id ? errors.get(id) : undefined;
    return errorMessage ? { ...asRecord(message), errorMessage } : message;
  });
}

const retainHistoryIdentity = (message: unknown, placeholder: unknown): unknown => {
  const full = asRecord(message);
  const original = asRecord(placeholder);
  if (!full || !asRecord(original?.__openclaw)) return message;
  const { truncated: _truncated, reason: _reason, ...identity } = asRecord(original?.__openclaw)!;
  const {
    truncated: _fullTruncated,
    reason: _fullReason,
    ...fullMetadata
  } = asRecord(full.__openclaw) ?? {};
  return { ...full, __openclaw: { ...fullMetadata, ...identity } };
};

async function readChunkedHistoryMessage(
  client: GatewayClient,
  sessionKey: string,
  messageId: string,
  isCurrent: () => boolean,
): Promise<unknown | null> {
  let cursor = 0;
  let transferId: string | undefined;
  const chunks: string[] = [];
  for (;;) {
    if (!isCurrent()) return null;
    const result = await client.request<{
      ok?: boolean;
      chunk?: string;
      nextCursor?: number;
      complete?: boolean;
      transferId?: string;
    }>('runtimeServices.historyMessage', {
      sessionKey,
      messageId,
      cursor,
      maxChars: HISTORY_MESSAGE_CHUNK_CHARS,
      ...(transferId ? { transferId } : {}),
    });
    if (!isCurrent() || !result?.ok || typeof result.chunk !== 'string') return null;
    chunks.push(result.chunk);
    if (typeof result.transferId === 'string') transferId = result.transferId;
    if (result.complete === true) break;
    const nextCursor = readNonNegativeSafeInteger(result.nextCursor);
    if (nextCursor === null || nextCursor <= cursor) {
      throw new Error('OpenClaw history message cursor did not advance');
    }
    cursor = nextCursor;
  }
  return JSON.parse(chunks.join('')) as unknown;
}

async function readCompleteHistoryMessage(
  client: GatewayClient,
  sessionKey: string,
  messageId: string,
  isCurrent: () => boolean,
  allowSourceFallback = true,
): Promise<unknown | null> {
  let native: { ok?: boolean; message?: unknown; unavailableReason?: string } | undefined;
  try {
    native = await client.request('chat.message.get', {
      sessionKey,
      messageId,
      maxChars: CHAT_MESSAGE_GET_MAX_CHARS,
    });
  } catch {
    // A response can exceed the WebSocket frame budget before OpenClaw is able
    // to return its explicit `oversized` result. The bounded bridge is also the
    // recovery path for that transport failure.
    return allowSourceFallback
      ? readChunkedHistoryMessage(client, sessionKey, messageId, isCurrent)
      : null;
  }
  if (!isCurrent()) return null;
  if (native?.ok && native.message !== undefined && !isTruncatedHistoryMessage(native.message)) {
    return native.message;
  }
  if (native?.unavailableReason !== 'oversized' && native?.ok !== true) return null;
  return allowSourceFallback
    ? readChunkedHistoryMessage(client, sessionKey, messageId, isCurrent)
    : null;
}

export async function hydrateTruncatedHistoryMessages(
  client: GatewayClient,
  messages: unknown[],
  sessionKey: string,
  isCurrent: () => boolean = () => true,
): Promise<unknown[]> {
  if (!isCurrent()) return messages;
  const candidates = new Map<string, number[]>();
  const commentarySourceIds = new Set<string>();
  const mixedSourceIds = new Set<string>();
  for (const message of messages) {
    const messageId = readHistoryMessageId(message);
    if (!messageId) continue;
    if (isCommentaryProjection(message)) {
      commentarySourceIds.add(messageId);
      continue;
    }
    if (hasMixedAssistantTextAndTools(message)) mixedSourceIds.add(messageId);
    if (isTruncatedHistoryMessage(message)) candidates.set(messageId, []);
  }
  // Patch 018 admits commentary in place among tools and removes its original
  // phase signatures. chat.message.get uses a different projection and may
  // omit that text. Without block identity, retain the admitted capped row.
  for (const messageId of mixedSourceIds) candidates.delete(messageId);
  // The native single-message projection covers main siblings, but not the
  // separate commentary projections admitted by history. Never consume those.
  messages.forEach((message, index) => {
    if (isCommentaryProjection(message)) return;
    const messageId = readHistoryMessageId(message);
    if (!messageId) return;
    candidates.get(messageId)?.push(index);
  });
  if (candidates.size === 0) return hydrateFailureDetails(client, messages, sessionKey, isCurrent);

  const replacements = new Map<number, unknown>();
  const duplicateProjectionIndices = new Set<number>();
  const pending = [...candidates];
  await Promise.all(
    Array.from(
      { length: Math.min(HISTORY_MESSAGE_HYDRATION_CONCURRENCY, pending.length) },
      async () => {
        for (;;) {
          if (!isCurrent()) return;
          const candidate = pending.shift();
          if (!candidate) return;
          const [messageId, indices] = candidate;
          try {
            const fullMessage = await readCompleteHistoryMessage(
              client,
              sessionKey,
              messageId,
              isCurrent,
              // A raw source can contain phased text suppressed by the native
              // display policy. It cannot safely replace a main projection
              // while its separately admitted commentary siblings remain.
              !commentarySourceIds.has(messageId),
            );
            if (fullMessage === null) continue;
            const firstIndex = indices[0];
            if (firstIndex !== undefined) {
              replacements.set(
                firstIndex,
                retainHistoryIdentity(fullMessage, messages[firstIndex]),
              );
              for (const duplicateIndex of indices.slice(1)) {
                duplicateProjectionIndices.add(duplicateIndex);
              }
            }
          } catch {
            // Keep the explicit OpenClaw placeholder. A later history refresh can
            // retry without making every other transcript row unavailable.
          }
        }
      },
    ),
  );
  const hydrated =
    replacements.size === 0
      ? messages
      : messages.flatMap((message, index) =>
          duplicateProjectionIndices.has(index) ? [] : [replacements.get(index) ?? message],
        );
  return hydrateFailureDetails(client, hydrated, sessionKey, isCurrent);
}

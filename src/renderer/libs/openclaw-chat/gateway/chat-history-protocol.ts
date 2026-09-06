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
): Promise<unknown | null> {
  let cursor = 0;
  let transferId: string | undefined;
  const chunks: string[] = [];
  for (;;) {
    const result = await client.request<{
      ok?: boolean;
      chunk?: string;
      nextCursor?: number;
      complete?: boolean;
      transferId?: string;
    }>('justdoRuntimeBridge.historyMessage', {
      sessionKey,
      messageId,
      cursor,
      maxChars: HISTORY_MESSAGE_CHUNK_CHARS,
      ...(transferId ? { transferId } : {}),
    });
    if (!result?.ok || typeof result.chunk !== 'string') return null;
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
    return readChunkedHistoryMessage(client, sessionKey, messageId);
  }
  if (native?.ok && native.message !== undefined && !isTruncatedHistoryMessage(native.message)) {
    return native.message;
  }
  if (native?.unavailableReason !== 'oversized' && native?.ok !== true) return null;
  return readChunkedHistoryMessage(client, sessionKey, messageId);
}

export async function hydrateTruncatedHistoryMessages(
  client: GatewayClient,
  messages: unknown[],
  sessionKey: string,
): Promise<unknown[]> {
  const candidates = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (!isTruncatedHistoryMessage(message)) return;
    const messageId = readHistoryMessageId(message);
    if (!messageId) return;
    const indices = candidates.get(messageId) ?? [];
    indices.push(index);
    candidates.set(messageId, indices);
  });
  if (candidates.size === 0) return messages;

  const replacements = new Map<number, unknown>();
  const duplicateProjectionIndices = new Set<number>();
  const pending = [...candidates];
  await Promise.all(
    Array.from(
      { length: Math.min(HISTORY_MESSAGE_HYDRATION_CONCURRENCY, pending.length) },
      async () => {
        for (;;) {
          const candidate = pending.shift();
          if (!candidate) return;
          const [messageId, indices] = candidate;
          try {
            const fullMessage = await readCompleteHistoryMessage(client, sessionKey, messageId);
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
  return replacements.size === 0
    ? messages
    : messages.flatMap((message, index) =>
        duplicateProjectionIndices.has(index) ? [] : [replacements.get(index) ?? message],
      );
}

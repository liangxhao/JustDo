import { createHash } from 'node:crypto';

import { isHiddenNativeMessage } from '../../../shared/openclaw/messageVisibility';
import { readHistoryRecordIdentity } from '../../engine/openclaw/runtimeAdapterSupport';
import {
  parseChatHistoryCursorResultV2026_10_6,
  parseChatHistoryResultV2026_10_6,
  parseHistoryDetailsResultV2026_10_6,
} from '../../engine/openclaw/wire/v2026_10_6';

type HistoryRecord = Record<string, unknown>;

export type SessionExportHistoryRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export class SessionExportHistoryError extends Error {
  constructor(readonly reason: 'history_changed' | 'history_unavailable' | 'running') {
    super(reason);
  }
}

const PAGE_LIMIT = 250;
const PAGE_BYTES = 512 * 1024;
const PAGE_CHARS = 500_000;
const MESSAGE_CHARS = 8_000_000;
const TRANSFER_CHARS = 512 * 1024;
const TOOL_DETAIL_BATCH_SIZE = 50;
const UNAVAILABLE_HISTORY_MESSAGE =
  '[chat.history unavailable: transcript too large to display; the full history is preserved on disk]';

const asRecord = (value: unknown): HistoryRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as HistoryRecord)
    : undefined;

const recordId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;

const metadata = (message: HistoryRecord | undefined) => asRecord(message?.__openclaw);

function verifySessionInfo(raw: HistoryRecord, sessionKey: string, sessionId: string | null): void {
  const session = asRecord(raw.sessionInfo);
  if (session?.hasActiveRun === true || recordId(asRecord(raw.inFlightRun)?.runId))
    throw new SessionExportHistoryError('running');
  if (
    (session?.key !== undefined && session.key !== sessionKey) ||
    (session?.sessionId != null && session.sessionId !== sessionId)
  )
    throw new SessionExportHistoryError('history_changed');
}

function verifyPageIdentity(
  page: ReturnType<typeof readPage>,
  first: ReturnType<typeof readPage>,
): void {
  const initial = asRecord(first.raw.sessionInfo);
  const current = asRecord(page.raw.sessionInfo);
  if (
    page.sessionId !== first.sessionId ||
    page.totalMessages !== first.totalMessages ||
    (initial?.lifecycleRevision != null && current?.lifecycleRevision !== initial.lifecycleRevision)
  )
    throw new SessionExportHistoryError('history_changed');
}

function readPage(value: unknown, sessionKey: string, offset: number) {
  const raw = asRecord(value);
  if (!raw || raw.sessionKey !== sessionKey || (raw.offset !== undefined && raw.offset !== offset))
    throw new SessionExportHistoryError('history_changed');
  if (raw.windowReset === true) throw new SessionExportHistoryError('history_changed');
  const page = parseChatHistoryResultV2026_10_6(raw);
  if (
    typeof raw.hasMore !== 'boolean' ||
    page.totalMessages === undefined ||
    offset > page.totalMessages ||
    (page.hasMore && (page.nextOffset! <= offset || page.nextOffset! >= page.totalMessages))
  )
    throw new SessionExportHistoryError('history_unavailable');
  const sessionId = recordId(raw.sessionId) ?? null;
  if (
    !sessionId &&
    (raw.sessionId != null || page.totalMessages !== 0 || page.messages.length || page.hasMore)
  )
    throw new SessionExportHistoryError('history_unavailable');
  verifySessionInfo(raw, sessionKey, sessionId);
  const messages = page.messages.map(value => {
    const message = asRecord(value);
    if (
      !message ||
      typeof message.role !== 'string' ||
      (message.role === 'assistant' &&
        !metadata(message) &&
        Array.isArray(message.content) &&
        message.content.length === 1 &&
        asRecord(message.content[0])?.text === UNAVAILABLE_HISTORY_MESSAGE)
    )
      throw new SessionExportHistoryError('history_unavailable');
    return message;
  });
  return { ...page, raw, sessionId, messages };
}

function pageFingerprint(page: ReturnType<typeof readPage>): string {
  const session = asRecord(page.raw.sessionInfo);
  return createHash('sha256')
    .update(
      JSON.stringify([
        page.sessionId,
        page.totalMessages,
        page.nextOffset,
        session?.activeLeafEntryId,
        session?.lifecycleRevision,
        session?.updatedAt,
        page.messages,
        page.activity,
      ]),
    )
    .digest('hex');
}

function boundaryIdentity(message: HistoryRecord | undefined): string | undefined {
  const row = readHistoryRecordIdentity(message);
  return row && JSON.stringify([asRecord(metadata(message)?.transcriptPosition)?.source, row]);
}

function isOversized(message: HistoryRecord): boolean {
  return metadata(message)?.truncated === true;
}

function removeReplayedBoundary(older: HistoryRecord[], newer: HistoryRecord[]): HistoryRecord[] {
  const boundary = boundaryIdentity(older.at(-1));
  if (!boundary || boundaryIdentity(newer[0]) !== boundary) return newer;
  const olderBoundary = older.slice(
    older.findLastIndex(row => boundaryIdentity(row) !== boundary) + 1,
  );
  const newerBoundaryEnd = newer.findIndex(row => boundaryIdentity(row) !== boundary);
  const end = newerBoundaryEnd === -1 ? newer.length : newerBoundaryEnd;
  // The byte boundary can replay the entire source row. Preserve distinct
  // native display siblings and keep the complete projection if one side caps it.
  const newerBoundary = newer.slice(0, end);
  const olderTruncated = olderBoundary.some(isOversized);
  const newerTruncated = newerBoundary.some(isOversized);
  if (
    (olderTruncated && !newerTruncated) ||
    (olderTruncated === newerTruncated && newerBoundary.length > olderBoundary.length)
  ) {
    older.splice(older.length - olderBoundary.length);
    return newer;
  }
  return newer.slice(end);
}

async function recoverInitialBoundary(
  request: SessionExportHistoryRequest,
  sessionKey: string,
  sessionId: string,
  first: ReturnType<typeof readPage>,
): Promise<void> {
  const oldest = first.messages[0];
  const messageId = recordId(metadata(oldest)?.id);
  if (!oldest || !messageId || first.messages.length !== PAGE_LIMIT) return;
  const boundary = boundaryIdentity(oldest);
  const raw = asRecord(
    await request('chat.history', {
      sessionId,
      messageId,
      limit: 1,
      maxBytes: PAGE_BYTES,
      maxChars: PAGE_CHARS,
      toolResultMaxChars: PAGE_CHARS,
    }),
  );
  if (
    !raw ||
    raw.sessionKey !== sessionKey ||
    raw.sessionId !== sessionId ||
    raw.windowReset === true
  )
    throw new SessionExportHistoryError('history_changed');
  verifySessionInfo(raw, sessionKey, sessionId);
  const anchor = parseChatHistoryResultV2026_10_6(raw);
  const siblings = anchor.messages
    .map(asRecord)
    .filter((row): row is HistoryRecord => row !== undefined && boundaryIdentity(row) === boundary);
  const through = first.messages.findIndex(row => boundaryIdentity(row) !== boundary);
  const existing = through === -1 ? first.messages.length : through;
  // The head page applies its count cap before grouping source-row siblings.
  // An exact anchor restores any missing leading siblings without reading
  // neighbors from another page or changing the numeric offset.
  if (siblings.length > existing) first.messages = [...siblings, ...first.messages.slice(existing)];
}

function isCommentary(message: HistoryRecord): boolean {
  return asRecord(message.openclawStreamFallback)?.source === 'segment';
}

function hasPublicTextOnly(content: unknown): boolean {
  return (
    typeof content === 'string' ||
    (Array.isArray(content) &&
      content.every(block => {
        const record = asRecord(block);
        return (
          record?.type === 'text' &&
          typeof record.text === 'string' &&
          Object.keys(record).length === 2
        );
      }))
  );
}

async function readChunkedMessage(request: SessionExportHistoryRequest, scope: HistoryRecord) {
  let cursor = 0;
  let transferId: string | undefined;
  const chunks: string[] = [];
  for (;;) {
    const result = asRecord(
      await request('runtimeServices.historyMessage', {
        ...scope,
        cursor,
        maxChars: TRANSFER_CHARS,
        ...(transferId ? { transferId } : {}),
      }),
    );
    const responseId = recordId(result?.transferId);
    if (
      result?.ok !== true ||
      typeof result.chunk !== 'string' ||
      !responseId ||
      (transferId && responseId !== transferId)
    )
      return undefined;
    chunks.push(result.chunk);
    if (result.complete === true) return asRecord(JSON.parse(chunks.join('')));
    if (!result.chunk.length || result.nextCursor !== cursor + result.chunk.length)
      return undefined;
    transferId = responseId;
    cursor += result.chunk.length;
  }
}

async function restoreMessage(
  request: SessionExportHistoryRequest,
  sessionKey: string,
  sessionId: string,
  message: HistoryRecord,
  sourceHasSiblings: boolean,
): Promise<HistoryRecord> {
  const original = metadata(message);
  const messageId = recordId(original?.id);
  if (!messageId || sourceHasSiblings || isCommentary(message))
    throw new SessionExportHistoryError('history_unavailable');
  const scope = { sessionKey, sessionId, messageId };
  let response: HistoryRecord | undefined;
  try {
    response = asRecord(await request('chat.message.get', { ...scope, maxChars: MESSAGE_CHARS }));
  } catch (error) {
    if (error instanceof SessionExportHistoryError) throw error;
    // Oversized transport failures can be recovered through the bounded bridge.
  }
  const full = asRecord(response?.message);
  if (
    response?.ok === true &&
    full?.role === message.role &&
    metadata(full)?.id === messageId &&
    metadata(full)?.truncated !== true &&
    (original?.runId === undefined || metadata(full)?.runId === original.runId)
  ) {
    const { truncated: _truncated, reason: _reason, ...identity } = original!;
    return { ...full, __openclaw: { ...metadata(full), ...identity } };
  }
  // The chunked transport exposes the source body. Avoid assigning raw
  // assistant text to an admitted display projection or reviving hidden input.
  const role = String(message.role).replaceAll('_', '').toLowerCase();
  if (
    (!response ||
      response.unavailableReason === 'oversized' ||
      metadata(full)?.truncated === true) &&
    ['user', 'tool', 'toolresult'].includes(role)
  ) {
    const chunked = await readChunkedMessage(request, scope);
    if (
      chunked?.role === message.role &&
      !isHiddenNativeMessage(chunked) &&
      hasPublicTextOnly(chunked.content) &&
      (metadata(chunked)?.id === undefined || metadata(chunked)?.id === messageId) &&
      (original?.runId === undefined ||
        metadata(chunked)?.runId === undefined ||
        metadata(chunked)?.runId === original.runId)
    ) {
      const { truncated: _truncated, reason: _reason, ...identity } = original!;
      return { ...message, content: chunked.content, __openclaw: identity };
    }
  }
  throw new SessionExportHistoryError('history_unavailable');
}

function readMissingToolInput(block: unknown) {
  const value = asRecord(block);
  const type = typeof value?.type === 'string' ? value.type.replace(/[_-]/g, '').toLowerCase() : '';
  if (
    !value ||
    !['toolcall', 'tooluse', 'functioncall'].includes(type) ||
    typeof value.name !== 'string' ||
    value.name === 'sessions_yield'
  )
    return;
  if (
    [value.arguments, value.input, value.args, value.partialArgs].some(input => {
      if (typeof input === 'string') return Boolean(input.trim()) && input.trim() !== '{}';
      if (input && typeof input === 'object') return Object.keys(input).length > 0;
      return input != null;
    })
  )
    return;
  const id = recordId(value.id ?? value.toolCallId ?? value.tool_call_id);
  return id ? { id, name: value.name } : undefined;
}

async function hydrateToolInputs(
  request: SessionExportHistoryRequest,
  sessionKey: string,
  sessionId: string,
  messages: HistoryRecord[],
): Promise<HistoryRecord[]> {
  const calls = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = readMissingToolInput(block);
      if (call) {
        if (calls.has(call.id)) ambiguous.add(call.id);
        else calls.set(call.id, call.name);
      }
    }
  }
  const ids = [...calls.keys()].filter(id => !ambiguous.has(id));
  const inputs = new Map<string, unknown>();
  for (let offset = 0; offset < ids.length; offset += TOOL_DETAIL_BATCH_SIZE) {
    const toolCallIds = ids.slice(offset, offset + TOOL_DETAIL_BATCH_SIZE);
    // Empty arguments are legal. Older services and sessions lacking input
    // details retain the native projection, never values from a different instance.
    const raw = asRecord(
      await request('runtimeServices.historyDetails', {
        sessionKey,
        sessionId,
        toolCallIds,
      }).catch((error): undefined => {
        if (error instanceof SessionExportHistoryError) throw error;
        return undefined;
      }),
    );
    if (raw?.status === 'changed' || (raw?.sessionId !== undefined && raw.sessionId !== sessionId))
      throw new SessionExportHistoryError('history_changed');
    if (raw?.sessionId !== sessionId) continue;
    const { toolInputs } = parseHistoryDetailsResultV2026_10_6(raw);
    for (const id of toolCallIds) {
      if (!Object.hasOwn(toolInputs, id)) continue;
      const entry = toolInputs[id];
      if (entry.name === calls.get(id)) inputs.set(id, entry.input);
    }
  }
  if (!inputs.size) return messages;
  return messages.map(message =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? {
          ...message,
          content: message.content.map(block => {
            const call = readMissingToolInput(block);
            return call && inputs.has(call.id)
              ? { ...asRecord(block), arguments: inputs.get(call.id) }
              : block;
          }),
        }
      : message,
  );
}

/** Read newest-to-oldest pages without changing the selected chat or retaining a transcript cache. */
export async function readSessionExportHistory({
  request,
  sessionKey,
  nativeSessionId,
  onPage,
  signal,
}: {
  request: SessionExportHistoryRequest;
  sessionKey: string;
  nativeSessionId?: string;
  onPage: (messages: readonly unknown[]) => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ runtimeSessionId: string | null; messageCount: number; model?: string }> {
  const scopedRequest: SessionExportHistoryRequest = async (method, params) => {
    signal?.throwIfAborted();
    const result = await request(method, { sessionKey, ...params });
    signal?.throwIfAborted();
    return result;
  };
  const requestPage = async (offset: number) =>
    readPage(
      await scopedRequest('chat.history', {
        offset,
        limit: PAGE_LIMIT,
        maxBytes: PAGE_BYTES,
        maxChars: PAGE_CHARS,
        toolResultMaxChars: PAGE_CHARS,
      }),
      sessionKey,
      offset,
    );
  const first = await requestPage(0);
  const { sessionId, deltaCursor } = first;
  const model =
    recordId(asRecord(first.raw.sessionInfo)?.model) ??
    recordId(asRecord(first.raw.defaults)?.model);
  if (nativeSessionId !== undefined && sessionId !== nativeSessionId)
    throw new SessionExportHistoryError('history_changed');
  const initialFingerprint = deltaCursor ? undefined : pageFingerprint(first);
  if (sessionId) await recoverInitialBoundary(scopedRequest, sessionKey, sessionId, first);
  let messageCount = 0;
  const deliver = async (messages: HistoryRecord[], activity?: unknown[]) => {
    const visible = messages.filter(message => !isHiddenNativeMessage(message));
    if (!visible.length || !sessionId) return;
    const activityById = new Map(
      (activity ?? []).map(item => {
        const record = asRecord(item)!;
        return [record.messageId, record.items] as const;
      }),
    );
    const ids = new Map<string, number>();
    for (const message of visible) {
      const id = recordId(metadata(message)?.id);
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    const full: HistoryRecord[] = [];
    for (const message of visible) {
      const id = recordId(metadata(message)?.id);
      const recovered = isOversized(message)
        ? await restoreMessage(
            scopedRequest,
            sessionKey,
            sessionId,
            message,
            Boolean(id && (ids.get(id) ?? 0) > 1),
          )
        : message;
      const items = activityById.get(id);
      if (!isHiddenNativeMessage(recovered)) {
        full.push(items === undefined ? recovered : { ...recovered, activity: items });
      }
    }
    const hydrated = await hydrateToolInputs(scopedRequest, sessionKey, sessionId, full);
    signal?.throwIfAborted();
    if (hydrated.length) await onPage(hydrated);
    messageCount += hydrated.length;
  };
  let page = first;
  while (page.hasMore) {
    const older = await requestPage(page.nextOffset!);
    verifyPageIdentity(older, first);
    await deliver(removeReplayedBoundary(older.messages, page.messages), page.activity);
    page = older;
  }
  await deliver(page.messages, page.activity);
  if (deltaCursor && sessionId) {
    const raw = asRecord(await scopedRequest('chat.history', { cursor: deltaCursor }));
    const delta = parseChatHistoryCursorResultV2026_10_6(raw);
    if (!raw || delta.kind === 'reset') throw new SessionExportHistoryError('history_changed');
    verifySessionInfo(raw, sessionKey, sessionId);
    const current = asRecord(raw.sessionInfo);
    const initial = asRecord(first.raw.sessionInfo);
    if (
      current?.sessionId !== sessionId ||
      delta.messages.length ||
      delta.activity?.length ||
      (initial?.lifecycleRevision != null &&
        current.lifecycleRevision !== initial.lifecycleRevision) ||
      (Object.hasOwn(initial ?? {}, 'activeLeafEntryId') &&
        current.activeLeafEntryId !== initial?.activeLeafEntryId)
    )
      throw new SessionExportHistoryError('history_changed');
  } else {
    // Archived or newly created empty conversations can omit the live cursor.
    // Recheck the exact head, its visible messages and the available revision.
    const current = await requestPage(0);
    if (pageFingerprint(current) !== initialFingerprint)
      throw new SessionExportHistoryError('history_changed');
  }
  signal?.throwIfAborted();
  return { runtimeSessionId: sessionId, messageCount, model };
}

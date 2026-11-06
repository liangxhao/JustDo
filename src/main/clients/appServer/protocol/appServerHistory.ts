import { createHash } from 'node:crypto';

import type { SessionRunTiming } from '../../../../shared/cowork/sessionRun';
import { OPENCLAW_NESTED_TOOL_CUSTOM_TYPE } from '../../../../shared/openclaw/constants';
import { isHiddenNativeMessage } from '../../../../shared/openclaw/messageVisibility';
import { PRODUCT_NAME } from '../../../../shared/productMetadata';
import { normalizeAppServerImageDataUrl } from './appServerInput';
import { invalidParams, optionalString } from './appServerPagination';
import { type AppServerParams, type AppServerResult, isAppServerRecord } from './appServerProtocol';
import type { AppServerThreadHistory } from './appServerTypes';
import { codexTurn, CodexTurnStatus } from './appServerWire';

const MAX_FRAME_BODY_BYTES = 6 * 1024 * 1024;
const MAX_PROJECTED_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 100_000;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const UNKNOWN_HISTORY_OUTCOME = 'EXECUTION_UNKNOWN: Historical execution outcome is unavailable.';
const UNKNOWN_ACTIVE_OUTCOME = 'EXECUTION_UNKNOWN: Native execution settlement could not be verified.';
const TOOL_CALL_TYPES = new Set(['toolcall', 'tool_call', 'tooluse', 'tool_use', 'functioncall', 'function_call']);
const TOOL_RESULT_TYPES = new Set(['toolresult', 'tool_result', 'tool', 'function']);

export interface CodexHistoryItem extends AppServerResult {
  id: string;
  type: string;
}

export interface CodexHistoryTurn extends AppServerResult {
  id: string;
  items: CodexHistoryItem[];
}

export interface CodexHistoryItemEntry extends AppServerResult {
  turnId: string;
  item: CodexHistoryItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface CodexHistorySnapshot {
  threadId: string;
  revision: string;
  turns: CodexHistoryTurn[];
  items: CodexHistoryItemEntry[];
}

interface TurnGroup {
  id: string;
  run?: SessionRunTiming;
  items: CodexHistoryItemEntry[];
  tools: Map<string, number>;
}

const record = (value: unknown): Record<string, unknown> => isAppServerRecord(value) ? value : {};
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const firstText = (...values: unknown[]): string | undefined =>
  values.map(text).find(value => value !== undefined && value.length > 0);
const timestamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Exact native stamps, never logical-ID suffixes or the latest-message position. */
export function appServerNativeMessageRunIds(raw: unknown): readonly string[] {
  const outer = record(raw);
  const message = typeof outer.role === 'string' ? outer : record(outer.message);
  const marker = record(message.__openclaw);
  return [...new Set([message.runId, marker.runId, marker.run_id, outer.runId]
    .filter((value): value is string => typeof value === 'string' && Boolean(value)))];
}

function unsupportedHistory(kind?: unknown): never {
  const label = typeof kind === 'string' && /^[a-z][a-z0-9_.-]{0,39}$/i.test(kind) ? kind : 'unrecognized';
  throw new Error(`Native history contains visible ${label} content that cannot be completely projected by this endpoint.`);
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content ?? message.text;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content === undefined || content === null) return [];
  if (!Array.isArray(content)) unsupportedHistory('message-body');
  return content.map(block => {
    if (!isAppServerRecord(block)) unsupportedHistory('content-block');
    return block;
  });
}

function imageUrl(block: Record<string, unknown>): string {
  const source = record(block.source);
  const image = record(block.image_url);
  const url = firstText(block.url, block.image_url, image.url, source.url);
  if (url) {
    if (url.startsWith('data:')) {
      try { return normalizeAppServerImageDataUrl(url); } catch { return unsupportedHistory(block.type); }
    }
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    if (parsed && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return url;
    return unsupportedHistory(block.type);
  }
  const data = firstText(source.data, block.data);
  const mediaType = firstText(source.mediaType, source.media_type, block.mimeType, block.mediaType);
  if (data && mediaType) {
    try { return normalizeAppServerImageDataUrl(`data:${mediaType};base64,${data}`); } catch { return unsupportedHistory(block.type); }
  }
  return unsupportedHistory(block.type);
}

function userInput(block: Record<string, unknown>): AppServerResult {
  const type = String(block.type ?? '').toLowerCase();
  if ((type === 'text' || type === 'input_text') && typeof block.text === 'string')
    return { type: 'text', text: block.text, text_elements: [] };
  if (['image', 'image_url', 'input_image'].includes(type)) return { type: 'image', url: imageUrl(block) };
  if (type === 'localimage' && typeof block.path === 'string' && block.path && !block.path.includes('\0'))
    return { type: 'localImage', path: block.path };
  return unsupportedHistory(block.type);
}

function userContent(message: Record<string, unknown>): AppServerResult[] {
  const blocks = contentBlocks(message);
  const metadata = record(message.__openclaw);
  const media = metadata.media;
  if (media === undefined) return blocks.map(userInput);
  if (!Array.isArray(media)) return unsupportedHistory('media');
  // These are alternative native carriers. Without an exact association, do
  // not duplicate or discard images from a mixed historical representation.
  if (media.length && blocks.some(block => ['image', 'image_url', 'input_image', 'localimage'].includes(String(block.type).toLowerCase())))
    return unsupportedHistory('mixed-image-carriers');
  const images = media.map(value => {
    if (!isAppServerRecord(value)) return unsupportedHistory('media');
    const type = firstText(value.contentType, value.mimeType)?.toLowerCase();
    if (!type || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) return unsupportedHistory('media');
    const url = firstText(value.url);
    if (url && (url.startsWith('data:') || /^https?:\/\//i.test(url))) return { type: 'image', url: imageUrl({ type: 'image', url }) };
    const file = firstText(value.path);
    if (file && !file.includes('\0')) return { type: 'localImage', path: file };
    return unsupportedHistory('media-reference');
  });
  return [...blocks.map(userInput).filter(block => !(images.length && block.type === 'text' &&
    typeof block.text === 'string' && !block.text.trim())), ...images];
}

function toolResult(source: Record<string, unknown>): AppServerResult {
  const raw = source.result ?? source.output ?? source.content ?? source.text;
  const output = record(raw);
  const content = Array.isArray(output.content)
    ? output.content
    : Array.isArray(raw)
      ? raw
      : raw === undefined || raw === null
        ? []
        : [{ type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }];
  return {
    content,
    structuredContent: output.structuredContent !== undefined
      ? output.structuredContent
      : source.structuredContent !== undefined
        ? source.structuredContent
        : output.details ?? source.details ??
          (isAppServerRecord(raw) && !Array.isArray(output.content) ? raw : null),
    _meta: output._meta ?? source._meta ?? null,
  };
}

function addTool(
  group: TurnGroup,
  source: Record<string, unknown>,
  id: string,
  complete: boolean,
  timing: Pick<CodexHistoryItemEntry, 'startedAtMs' | 'completedAtMs'>,
): void {
  const fn = record(source.function);
  const callId = firstText(source.toolCallId, source.tool_call_id, source.toolUseId, source.tool_use_id, source.id);
  const index = callId ? group.tools.get(callId) : undefined;
  const previous = index === undefined ? undefined : group.items[index];
  const output = record(source.result ?? source.output ?? source.content ?? source.text);
  const failed = source.isError === true || source.is_error === true ||
    output.isError === true || output.is_error === true;
  const item: CodexHistoryItem = {
    ...previous?.item,
    id: previous?.item.id ?? id,
    type: 'mcpToolCall',
    server: PRODUCT_NAME,
    tool: firstText(source.toolName, source.tool_name, source.name, fn.name) ?? previous?.item.tool ?? 'unknown',
    arguments: source.arguments ?? source.args ?? source.input ?? fn.arguments ?? previous?.item.arguments ?? null,
    status: complete ? failed ? 'failed' : 'completed' : 'inProgress',
    result: complete ? toolResult(source) : null,
    error: complete && failed ? {
      message: firstText(source.error, record(source.error).message, source.toolErrorSummary) ?? 'Tool execution failed.',
    } : null,
    durationMs: null,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
  };
  const entry: CodexHistoryItemEntry = {
    turnId: group.id,
    item,
    startedAtMs: previous?.startedAtMs ?? timing.startedAtMs,
    completedAtMs: complete ? timing.completedAtMs : null,
  };
  if (index === undefined) {
    if (callId) group.tools.set(callId, group.items.length);
    group.items.push(entry);
  } else {
    group.items[index] = entry;
  }
}

function projectMessage(group: TurnGroup, message: Record<string, unknown>, messageIdentity: string): void {
  const role = String(message.role ?? '').toLowerCase();
  const timing = {
    startedAtMs: timestamp(message.startedAtMs),
    completedAtMs: timestamp(message.completedAtMs),
  };
  const id = (ordinal: number) => `item:${digest([messageIdentity, ordinal])}`;
  const append = (item: CodexHistoryItem) => group.items.push({ turnId: group.id, item, ...timing });
  if (role === 'user') {
    append({ id: id(0), type: 'userMessage', content: userContent(message) });
    return;
  }
  if (TOOL_RESULT_TYPES.has(role)) {
    addTool(group, message, id(0), true, timing);
    return;
  }
  if (role === 'tool_use') {
    addTool(group, message, id(0), false, timing);
    return;
  }
  const nestedTools = role === 'custom' && message.customType === OPENCLAW_NESTED_TOOL_CUSTOM_TYPE;
  if (role !== 'assistant' && !nestedTools) return unsupportedHistory(role);
  const blocks = contentBlocks(message);
  if (!blocks.length && role === 'assistant')
    append({ id: id(0), type: 'agentMessage', text: '', phase: null });
  for (const [index, block] of blocks.entries()) {
    const type = String(block.type ?? '').toLowerCase();
    if (TOOL_CALL_TYPES.has(type)) {
      addTool(group, block, id(index), false, timing);
    } else if (TOOL_RESULT_TYPES.has(type)) {
      addTool(group, block, id(index), true, timing);
    } else if (type === 'thinking' || type === 'reasoning' || type === 'redacted_thinking') {
      const thinking = firstText(block.thinking, block.text, block.content);
      if (thinking === undefined && type !== 'redacted_thinking') return unsupportedHistory(type);
      append({ id: id(index), type: 'reasoning', summary: [], content: thinking === undefined ? [] : [thinking] });
    } else if ((type === 'text' || type === 'output_text') && typeof block.text === 'string') {
      append({
        id: id(index), type: 'agentMessage', text: block.text,
        phase: message.phase === 'commentary' || message.phase === 'final_answer' ? message.phase : null,
      });
    } else if (['image', 'image_url', 'output_image'].includes(type)) {
      append({ id: id(index), type: 'agentMessage', text: `![image](${imageUrl(block)})`, phase: null });
    } else {
      return unsupportedHistory(type);
    }
  }
}

function turnResult(group: TurnGroup, unknownRunIds: ReadonlySet<string>): CodexHistoryTurn {
  const run = group.run;
  const endedAt = timestamp(run?.endedAt);
  const unknown = !run || unknownRunIds.has(run.clientTurnId);
  const settled = !unknown && endedAt !== null && run && run.state !== 'running';
  const status = unknown
    ? CodexTurnStatus.Failed
    : !settled
      ? CodexTurnStatus.InProgress
      : run.state === 'completed'
        ? CodexTurnStatus.Completed
        : run.state === 'aborted'
          ? CodexTurnStatus.Interrupted
          : CodexTurnStatus.Failed;
  const error = unknown
    ? run ? UNKNOWN_ACTIVE_OUTCOME : UNKNOWN_HISTORY_OUTCOME
    : status === CodexTurnStatus.Failed ? 'Execution failed.' : undefined;
  return {
    ...codexTurn(group.id, status, {
      ...(error ? { error } : {}),
      ...(run ? { startedAt: run.startedAt } : {}),
      ...(settled ? { completedAt: endedAt } : {}),
    }),
    id: group.id,
    items: group.items.map(entry => entry.item),
    itemsView: 'full',
  };
}

/** A fresh projection only: message bodies remain owned by authenticated native history. */
export function projectCodexHistory(history: AppServerThreadHistory): CodexHistorySnapshot {
  if (history.messages.length > MAX_HISTORY_MESSAGES)
    throw new Error('Native history exceeds the supported projection size.');
  const receipts = new Map<string, SessionRunTiming>();
  const receiptByNativeRun = new Map<string, SessionRunTiming>();
  const receiptByInputKey = new Map<string, SessionRunTiming>();
  for (const run of history.runs) {
    if (!run.clientTurnId || receipts.has(run.clientTurnId))
      throw new Error('Native history execution receipts are ambiguous.');
    receipts.set(run.clientTurnId, run);
    // Native chat-user-turn-recorder constructs this complete key from the
    // client admission ID. It is a display join, never execution authorization.
    receiptByInputKey.set(`${run.clientTurnId}:user`, run);
    // Once the actual root is known, the logical admission ID is not a second
    // native execution alias. User input association remains a separate join.
    for (const id of [run.rootRunId || run.clientTurnId]) {
      const existing = receiptByNativeRun.get(id);
      if (existing && existing.clientTurnId !== run.clientTurnId)
        throw new Error('Native history execution receipts are ambiguous.');
      receiptByNativeRun.set(id, run);
    }
  }
  const groups = new Map<string, TurnGroup>();
  const identities = new Map<string, number>();
  let orphan: TurnGroup | undefined;
  for (const raw of history.messages) {
    if (isHiddenNativeMessage(raw)) continue;
    const outer = record(raw);
    const message = typeof outer.role === 'string' ? outer : record(outer.message);
    if (typeof message.role !== 'string') return unsupportedHistory('message-envelope');
    const marker = record(message.__openclaw);
    const nativeIdentity = firstText(marker.id, outer.messageId, message.id) ??
      (Number.isSafeInteger(marker.seq) ? `seq:${String(marker.seq)}` : `body:${digest(message)}`);
    const occurrence = identities.get(nativeIdentity) ?? 0;
    identities.set(nativeIdentity, occurrence + 1);
    const identity = JSON.stringify([history.threadId, nativeIdentity, occurrence]);
    const candidates = new Set(appServerNativeMessageRunIds(raw));
    const matched = new Map<string, SessionRunTiming>();
    for (const candidate of candidates) {
      const run = receiptByNativeRun.get(candidate);
      if (run) matched.set(run.clientTurnId, run);
    }
    if (matched.size && [...candidates].some(candidate => !receiptByNativeRun.has(candidate)))
      throw new Error('Native history message execution identity is ambiguous.');
    if (matched.size > 1) throw new Error('Native history message execution identity is ambiguous.');
    let run = matched.values().next().value as SessionRunTiming | undefined;
    if (message.role.toLowerCase() === 'user') {
      const inputKeys = new Set([message.idempotencyKey, marker.idempotencyKey]
        .filter((value): value is string => typeof value === 'string' && Boolean(value)));
      if (inputKeys.size > 1) throw new Error('Native history message execution identity is ambiguous.');
      const inputKey = inputKeys.values().next().value as string | undefined;
      const inputRun = inputKey ? receiptByInputKey.get(inputKey) : undefined;
      const target = firstText(marker.steerTargetRunId);
      if (target) {
        // Confirmed steering belongs to its recorded execution target. Its
        // input admission key intentionally names a different logical input.
        const targetRun = receiptByNativeRun.get(target);
        if (candidates.size && (!targetRun || [...candidates].some(candidate =>
          receiptByNativeRun.get(candidate)?.clientTurnId !== targetRun.clientTurnId)))
          throw new Error('Native history message execution identity is ambiguous.');
        run = targetRun;
      } else if (inputRun) {
        if (candidates.size && [...candidates].some(candidate =>
          receiptByNativeRun.get(candidate)?.clientTurnId !== inputRun.clientTurnId))
          throw new Error('Native history message execution identity is ambiguous.');
        run = inputRun;
      }
    }
    let group: TurnGroup;
    if (run) {
      orphan = undefined;
      group = groups.get(run.clientTurnId) ?? { id: run.clientTurnId, run, items: [], tools: new Map() };
    } else {
      if (!orphan || message.role.toLowerCase() === 'user') {
        const id = `history:${digest(identity)}`;
        orphan = { id, items: [], tools: new Map() };
      }
      group = orphan;
    }
    groups.set(group.id, group);
    projectMessage(group, message, identity);
  }
  // Generic product timing rows also include internal runtime recovery. Only an
  // explicit external execution pointer may add a turn without visible messages.
  const ordered = [...groups.values()];
  const receiptOnlyIds = new Set([history.latestExternalRunId, history.unknownRunId]);
  for (const run of history.runs) {
    if (groups.has(run.clientTurnId) || !receiptOnlyIds.has(run.clientTurnId)) continue;
    const group: TurnGroup = { id: run.clientTurnId, run, items: [], tools: new Map() };
    const next = ordered.findIndex(existing => existing.run && existing.run.startedAt > run.startedAt);
    if (next < 0) ordered.push(group);
    else ordered.splice(next, 0, group);
  }
  const unknownRunIds = new Set(history.unknownRunIds ?? []);
  if (history.unknownRunId) unknownRunIds.add(history.unknownRunId);
  const turns = ordered.map(group => turnResult(group, unknownRunIds));
  const items = ordered.flatMap(group => group.items);
  if (encodedBytes({ turns, items }) > MAX_PROJECTED_BYTES)
    throw new Error('Native history exceeds the supported projection size.');
  return {
    threadId: history.threadId,
    revision: digest([history.identityRevision ?? null, turns, items]),
    turns,
    items,
  };
}

/** A full response must fit below the shared transport's 8 MiB message budget. */
export function assertCodexHistoryFullSize(turns: readonly CodexHistoryTurn[]): void {
  if (encodedBytes(turns) > MAX_FRAME_BODY_BYTES)
    throw new Error('Full native history exceeds the response limit. Use thread/turns/list or thread/items/list.');
}

const pageLimit = (params: AppServerParams): number => {
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PAGE_SIZE)
    return invalidParams('History limit must be an integer between 0 and 200.');
  return limit;
};

const direction = (params: AppServerParams, fallback: string): string => {
  const value = optionalString(params, 'sortDirection') ?? fallback;
  if (value !== 'asc' && value !== 'desc') return invalidParams('Invalid history sortDirection.');
  return value;
};

function projectItemsView(turn: CodexHistoryTurn, view: string): CodexHistoryTurn {
  const firstUser = turn.items.find(item => item.type === 'userMessage');
  const lastAgent = [...turn.items].reverse().find(item => item.type === 'agentMessage');
  const items = view === 'full'
    ? turn.items
    : view === 'notLoaded'
      ? []
      : [firstUser, lastAgent].filter((item): item is CodexHistoryItem => Boolean(item));
  return { ...turn, items, itemsView: view };
}

function page<T>(
  snapshot: CodexHistorySnapshot,
  data: readonly T[],
  params: AppServerParams,
  kind: string,
  order: string,
  filter: unknown,
  id: (value: T) => string,
): AppServerResult {
  const limit = pageLimit(params);
  const query = digest([snapshot.threadId, kind, order, filter]);
  let after: string | undefined;
  if (params.cursor != null) {
    if (typeof params.cursor !== 'string' || params.cursor.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(params.cursor))
      return invalidParams('Invalid history pagination cursor.');
    let cursor: Record<string, unknown>;
    try {
      cursor = record(JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')));
    } catch {
      return invalidParams('Invalid history pagination cursor.');
    }
    if (cursor.query !== query || cursor.revision !== snapshot.revision || typeof cursor.after !== 'string')
      return invalidParams('History changed or the pagination cursor belongs to another query.');
    after = cursor.after;
  }
  const ordered = order === 'desc' ? [...data].reverse() : [...data];
  const index = after === undefined ? -1 : ordered.findIndex(entry => id(entry) === after);
  if (after !== undefined && index < 0) return invalidParams('The history cursor anchor is unavailable.');
  const remaining = ordered.slice(index + 1);
  const result: T[] = [];
  let bytes = 2;
  for (const entry of remaining.slice(0, limit)) {
    const entryBytes = encodedBytes(entry) + 1;
    if (bytes + entryBytes > MAX_FRAME_BODY_BYTES) {
      if (!result.length)
        throw new Error('A native history item or turn exceeds the response limit. Use a narrower history view.');
      break;
    }
    result.push(entry);
    bytes += entryBytes;
  }
  const cursor = result.length && result.length < remaining.length
    ? Buffer.from(JSON.stringify({ query, revision: snapshot.revision, after: id(result[result.length - 1]) })).toString('base64url')
    : null;
  return { data: result, nextCursor: cursor, backwardsCursor: null };
}

export function paginateCodexHistoryTurns(snapshot: CodexHistorySnapshot, params: AppServerParams): AppServerResult {
  if (params.threadId !== snapshot.threadId) return invalidParams('History threadId does not match.');
  const view = optionalString(params, 'itemsView') ?? 'summary';
  if (!['full', 'summary', 'notLoaded'].includes(view)) return invalidParams('Invalid history itemsView.');
  return page(snapshot, snapshot.turns.map(turn => projectItemsView(turn, view)), params,
    'history-turns', direction(params, 'desc'), view, turn => turn.id);
}

export function paginateCodexHistoryItems(snapshot: CodexHistorySnapshot, params: AppServerParams): AppServerResult {
  if (params.threadId !== snapshot.threadId) return invalidParams('History threadId does not match.');
  const turnId = optionalString(params, 'turnId');
  const data = snapshot.items.filter(entry => !turnId || entry.turnId === turnId);
  let query = params;
  if (isAppServerRecord(params.cursor)) {
    const anchor = params.cursor;
    if (!turnId || anchor.type !== 'item' || typeof anchor.itemId !== 'string')
      return invalidParams('An item cursor anchor requires turnId and itemId.');
    const match = data.find(entry => entry.item.id === anchor.itemId);
    if (!match) return invalidParams('The history item anchor is unavailable.');
    query = {
      ...params,
      cursor: Buffer.from(JSON.stringify({
        query: digest([snapshot.threadId, 'history-items', direction(params, 'asc'), turnId]),
        revision: snapshot.revision,
        after: JSON.stringify([match.turnId, match.item.id]),
      })).toString('base64url'),
    };
  }
  return page(snapshot, data, query, 'history-items', direction(params, 'asc'), turnId,
    entry => JSON.stringify([entry.turnId, entry.item.id]));
}

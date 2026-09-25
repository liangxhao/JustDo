/**
 * Chat controller — manages chat state and gateway interaction.
 * Simplified version of OpenClaw's controllers/chat.ts.
 *
 * This directly replicates the webchat's approach:
 * - Connects to gateway via GatewayClient
 * - Loads history via chat.history / chat.startup RPC
 * - Handles streaming events (delta, final, aborted, error)
 * - Sends messages via chat.send RPC
 *
 * No renderer-side transcript cache and no Redux. JustDo-specific Gateway
 * methods stay narrow: they only recover data that OpenClaw intentionally
 * omits from bounded history payloads.
 */

import { type NormalizedAgentEvent, type NormalizedChatEvent } from '@shared/openclaw/agentEvent';
import { type ProgressCard } from '@shared/openclaw/progressCard';

import { isTruncatedHistoryMessage } from '@/libs/openclaw-chat/gateway/chat-history-protocol';
import type { GatewayClient, GatewayHelloOk } from '@/libs/openclaw-chat/gateway/client';
import { readPreambleText, readToolProgressText } from '@/libs/openclaw-chat/model/agent-event-reducer';
import {
  type AssistantTurn,
  type ChatTranscriptState,
  type ToolItem,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { type EditorDraftPayload } from '@/libs/openclaw-chat/model/editor-draft';
import { isLocallyOptimisticHistoryTail } from '@/libs/openclaw-chat/model/optimistic-history-tail';
import { type RunActivity } from '@/libs/openclaw-chat/model/run-activity';
import {
  asToolRecord,
  attachedToolMessages,
  isToolCallRecord,
  isToolResultType,
  readToolCallId,
  unwrapToolMessage,
} from '@/libs/openclaw-chat/model/tool-message-adapter';
import { readTranscriptIdentity } from '@/libs/openclaw-chat/model/transcript-identity';
import { stripHeartbeatTokenForDisplay } from '@/libs/openclaw-chat/pipeline/heartbeat-display';
import { shouldHideMessage } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import { i18nService } from '@/services/i18n';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatState {
  client: GatewayClient | null;
  connected: boolean;
  transportStatus: 'disconnected' | 'connected' | 'reconnecting';
  sessionKey: string;
  /** Backing OpenClaw session id returned by chat.startup/chat.history. */
  currentSessionId: string | null;
  /** True after the selected session's first subscribed history snapshot settles. */
  initialHistoryReady: boolean;
  chatLoading: boolean;
  historyLoadingOlder: boolean;
  historyHasMore: boolean;
  historyNextCursor: string | null;
  /** Total messages reachable through the chunked loaded-history store. */
  loadedMessageCount: number;
  /** Recent authoritative snapshot used for reconciliation and live tail updates. */
  chatMessages: unknown[];
  visibleChatMessages: unknown[];
  historyWindowStart: number;
  historyWindowEnd: number;
  chatSending: boolean;
  compactionInFlight: boolean;
  chatRunId: string | null;
  lastError: string | null;
  hello: GatewayHelloOk | null;
  /** Ephemeral activity used only for delayed, non-persisted waiting notices. */
  runActivity: RunActivity | null;
  /** Selected Gateway session's authoritative context-window snapshot. */
  contextUsage: ChatContextUsageSnapshot | null;
  /** Gateway-owned durable status card for the selected session. */
  progressCard: ProgressCard | null;
  progressCardLoading: boolean;
  progressCardAvailable: boolean;
  progressCardError: 'access-denied' | 'unavailable' | null;
  /** Optimistic user message shown until gateway history loads */
  pendingUserMessage: {
    role: string;
    content: string | unknown[];
    text: string;
    timestamp: number;
  } | null;
  /** Canonical, sequence-ordered live display state. */
  transcript: ChatTranscriptState;
}

export interface ChatContextUsageSnapshot {
  sessionKey: string;
  sessionId: string | null;
  totalTokens: number;
  contextTokens: number | null;
  totalTokensFresh: boolean;
  updatedAt: number | null;
  modelRef: string | null;
}

export type RewindEditorDraft = EditorDraftPayload;

export type ChatStateListener = (state: ChatState) => void;

export type ChatStreamUpdateKind = 'stream' | 'tool-partial' | 'terminal';

export type ChatStreamListener = (kind: ChatStreamUpdateKind) => void;

export interface SideChatResult {
  runId: string;
  sessionKey: string;
  question: string;
  text: string;
  isError: boolean;
}

export type SideChatResultListener = (result: SideChatResult) => void;

export interface SideChatStreamUpdate {
  runId: string;
  sessionKey: string;
  turn: AssistantTurn | null;
  kind: ChatStreamUpdateKind;
}

export type SideChatStreamListener = (update: SideChatStreamUpdate) => void;

export interface ChatControllerOptions {
  /** Subagent transcripts are expected to contain their originating user/task turn. */
  expectInitialHistory?: boolean;
  /** Isolated external runs may use their first user row directly instead of a subagent envelope. */
  expectInitialUserMessage?: boolean;
  /** Maximum time to hold the first history snapshot behind message subscription setup. */
  initialMessageSubscriptionBarrierTimeoutMs?: number;
  /** Test seam and bounded persistence catch-up policy. */
  initialHistoryRetryDelaysMs?: readonly number[];
}

export type CompactionTranscriptReference = {
  leafId?: string;
  entryId?: string;
};

export type CompactionCheckpoint = {
  checkpointId?: string;
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  createdAt?: number;
  postCompaction?: CompactionTranscriptReference;
};

export type LocalCompactionStatus = {
  id: string;
  eventId?: string;
  authoritativeMarkerSeen?: boolean;
  markerFingerprintsBefore: Set<string>;
  message: {
    role: 'system';
    timestamp: number;
    __openclaw: {
      kind: 'compaction-status';
      id: string;
      phase: 'in-progress' | 'completed' | 'failed' | 'skipped' | 'aborted';
      reason?: string;
      summary?: string;
      tokensBefore?: number;
      tokensAfter?: number;
    };
  };
};

export type InFlightRunSnapshot = {
  runId: string;
  text?: string;
  startedAt?: number;
  sessionAbortable?: boolean;
  events?: Array<{
    runId: string;
    seq: number;
    stream: string;
    ts: number;
    sessionKey?: string;
    agentId?: string;
    data: Record<string, unknown>;
  }>;
};

export type ChatHistorySnapshot = {
  messages?: unknown[];
  hasMore?: boolean;
  nextOffset?: number;
  sessionId?: string;
  sessionInfo?: {
    key?: string;
    sessionId?: string;
    updatedAt?: number;
    totalTokens?: number;
    totalTokensFresh?: boolean;
    contextTokens?: number;
    modelProvider?: string;
    model?: string;
    hasActiveRun?: boolean;
    activeRunIds?: string[];
    activeLeafEntryId?: string | null;
    status?: string;
  };
  inFlightRun?: InFlightRunSnapshot;
};

export type SessionLiveState = Pick<
  ChatState,
  | 'currentSessionId'
  | 'chatSending'
  | 'compactionInFlight'
  | 'chatRunId'
  | 'lastError'
  | 'runActivity'
  | 'contextUsage'
  | 'pendingUserMessage'
  | 'transcript'
> & {
  terminalLifecycleSeen: boolean;
  assistantSnapshotRunId: string | null;
  ignoredDeltaAfterAssistantSnapshotCount: number;
};

export type PostFinalHistoryRecovery = {
  sessionKey: string;
  sessionId: string | null;
  historyGeneration: number;
  runId: string | null;
  baselineMessageSeq: number | null;
  baselineCompleteMessageCount: number;
  attempt: number;
};

export type SwitchSessionOptions = {
  promoteFromSessionKey?: string;
};

export function hasStableProgressOwner(event: NormalizedAgentEvent): boolean {
  // Independent delivery paths can overtake paced text. Only identified text
  // may bypass the run watermark; the reducer still enforces owner/run fences.
  if (event.stream === 'item') {
    return (
      (readPreambleText(event.data) !== null || readToolProgressText(event.data) !== null) &&
      typeof event.data.itemId === 'string' &&
      event.data.itemId.trim().length > 0
    );
  }
  if (event.stream !== 'thinking' && event.stream !== 'assistant') return false;
  const firstSeq = event.data.progressSegmentFirstSeq;
  return (
    typeof firstSeq === 'number' &&
    Number.isSafeInteger(firstSeq) &&
    firstSeq >= 0 &&
    firstSeq <= event.agentSeq
  );
}

export function cloneAssistantTurn(turn: AssistantTurn): AssistantTurn {
  const items = turn.items.map(item => ({ ...item }));
  const toolById = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.type === 'tool') toolById.set(item.toolCallId, item);
  }
  return {
    ...turn,
    items,
    toolById,
    ...(turn.activityEventSeqById
      ? { activityEventSeqById: new Map(turn.activityEventSeqById) }
      : {}),
  };
}

export function getContentImageUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  if (block.type === 'image' && typeof block.url === 'string') return block.url;
  if (
    block.type === 'attachment' &&
    block.attachment &&
    typeof block.attachment === 'object' &&
    !Array.isArray(block.attachment)
  ) {
    const attachment = block.attachment as Record<string, unknown>;
    if (attachment.kind === 'image' && typeof attachment.url === 'string') {
      return attachment.url;
    }
  }
  return null;
}

export function getImageUrlIdentity(url: string): string {
  const commaIndex = url.indexOf(',');
  if (
    commaIndex > 0 &&
    url.slice(0, commaIndex).toLowerCase().startsWith('data:image/') &&
    url.slice(0, commaIndex).toLowerCase().includes(';base64')
  ) {
    // The Gateway may normalize an image MIME (for example image/jpg to
    // image/jpeg) while preserving the exact bytes. Compare the payload so
    // the optimistic preview and durable media fact still occupy one slot.
    return `data:image;base64,${url.slice(commaIndex + 1)}`;
  }
  return url;
}

export const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

export const MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS = [100, 400, 1500, 3000] as const;

export const DEFERRED_HISTORY_RELOAD_DELAY_MS = 1200;

export const ACTIVE_TOOL_HISTORY_CATCHUP_DELAY_MS = 150;

export const MAX_DEFERRED_HISTORY_CATCHUP_ATTEMPTS = 5;

export const MAX_ACTIVE_TOOL_HISTORY_CATCHUP_ATTEMPTS = 4;

export const DEFAULT_INITIAL_MESSAGE_SUBSCRIPTION_BARRIER_TIMEOUT_MS = 3000;

export const MANUAL_COMPACTION_STOP_RETRY_WINDOW_MS = 30_000;

export const DEFAULT_INITIAL_HISTORY_RETRY_DELAYS_MS = [100, 300, 900] as const;

export const PROGRESS_CARD_GET_METHOD = 'progressCard.get';

export const PROGRESS_CARD_PUT_METHOD = 'progressCard.put';
export const PROGRESS_CARD_REFRESH_METHOD = 'progressCard.refresh';

export const PROGRESS_CARD_CACHE_LIMIT = 100;

export const DEBUG_CHAT_CONTROLLER =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_CHAT_CONTROLLER === 'true';

export function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function debugLog(...args: unknown[]): void {
  if (DEBUG_CHAT_CONTROLLER) {
    console.debug(...args);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readChatContextUsageSnapshot(
  value: unknown,
  fallbackSessionKey: string,
): ChatContextUsageSnapshot | null {
  const row = asRecord(value);
  const totalTokens = readNonNegativeFiniteNumber(row?.totalTokens);
  if (!row || totalTokens === null) return null;
  const sessionKey =
    (typeof row.sessionKey === 'string' && row.sessionKey.trim()) ||
    (typeof row.key === 'string' && row.key.trim()) ||
    fallbackSessionKey;
  const provider = typeof row.modelProvider === 'string' ? row.modelProvider.trim() : '';
  const model = typeof row.model === 'string' ? row.model.trim() : '';
  return {
    sessionKey,
    sessionId: normalizeSessionId(row.sessionId),
    totalTokens,
    contextTokens: readNonNegativeFiniteNumber(row.contextTokens),
    totalTokensFresh: row.totalTokensFresh !== false,
    updatedAt: readNonNegativeFiniteNumber(row.updatedAt),
    modelRef: model ? (provider ? `${provider}/${model}` : model) : null,
  };
}

export function contextUsageSnapshotsEqual(
  left: ChatContextUsageSnapshot | null,
  right: ChatContextUsageSnapshot,
): boolean {
  return (
    left !== null &&
    left.sessionKey === right.sessionKey &&
    left.sessionId === right.sessionId &&
    left.totalTokens === right.totalTokens &&
    left.contextTokens === right.contextTokens &&
    left.totalTokensFresh === right.totalTokensFresh &&
    left.updatedAt === right.updatedAt &&
    left.modelRef === right.modelRef
  );
}

export function isSubagentTaskHistoryMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (String(record?.role ?? '').toLowerCase() !== 'user') return false;
  const text = extractSnapshotText(message);
  return (
    typeof text === 'string' &&
    text.trimStart().startsWith('[Subagent Context] You are running as a subagent (depth ') &&
    /(?:^|\r?\n)\[Subagent Task\](?:\r?\n|$)/.test(text)
  );
}

export function sliceActiveSubagentHistoryPrefix(messages: unknown[]): unknown[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(asRecord(messages[index])?.role ?? '').toLowerCase() === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(0, lastUserIndex + 1) : messages;
}

export function readPositiveSafeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function readOpenClawMessageSeq(message: unknown): number | null {
  const record = asRecord(message);
  const marker = asRecord(record?.__openclaw);
  return readPositiveSafeInteger(marker?.seq) ?? readPositiveSafeInteger(record?.seq);
}

export function readLatestOpenClawMessageSeq(messages: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    const seq = readOpenClawMessageSeq(message);
    if (seq !== null && (latest === null || seq > latest)) latest = seq;
  }
  return latest;
}

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const normalized = readNonBlankString(item);
    return normalized ? [normalized] : [];
  });
}

export function readExplicitMessageRunId(value: unknown): string | undefined {
  const outer = asRecord(value);
  if (!outer) return undefined;
  const message = asRecord(outer.message) ?? outer;
  const messageMetadata = asRecord(message.metadata);
  const outerMetadata = asRecord(outer.metadata);
  const messageOpenClaw = asRecord(message.__openclaw);
  const outerOpenClaw = asRecord(outer.__openclaw);
  for (const candidate of [
    message.runId,
    message.run_id,
    messageOpenClaw?.runId,
    messageOpenClaw?.run_id,
    messageMetadata?.runId,
    messageMetadata?.run_id,
    outer.runId,
    outer.run_id,
    outerOpenClaw?.runId,
    outerOpenClaw?.run_id,
    outerMetadata?.runId,
    outerMetadata?.run_id,
  ]) {
    const runId = readNonBlankString(candidate);
    if (runId) return runId;
  }
  return undefined;
}

export function retainOriginalOpenClawIdentity(
  fullMessage: unknown,
  originalMessage: unknown,
): unknown {
  const full = asRecord(fullMessage);
  const original = asRecord(originalMessage);
  if (!full || asRecord(full.__openclaw) || !asRecord(original?.__openclaw)) {
    return fullMessage;
  }
  return {
    ...full,
    __openclaw: original?.__openclaw,
  };
}

export function mergeRefreshedHistoryWindow(current: unknown[], recent: unknown[]): unknown[] {
  if (current.length <= recent.length || recent.length === 0) return recent;
  const firstIdentity = readTranscriptIdentity(recent[0]);
  if (!firstIdentity) return recent;
  const overlapIndex = current.findIndex(message => {
    const identity = readTranscriptIdentity(message);
    return identity?.kind === firstIdentity.kind && identity.value === firstIdentity.value;
  });
  return overlapIndex > 0 ? [...current.slice(0, overlapIndex), ...recent] : recent;
}

export function readNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function formatI18n(key: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    i18nService.t(key),
  );
}

export function summarizeHistoryForDebug(messages: unknown[]): Record<string, unknown> {
  const roleCounts: Record<string, number> = {};
  let textLen = 0;
  let thinkingLen = 0;
  let toolBlockCount = 0;
  let localOptimisticTailCount = 0;
  let streamFallbackCount = 0;

  for (const message of messages) {
    const record = asRecord(message);
    const role = typeof record?.role === 'string' ? record.role : '?';
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    textLen += extractSnapshotText(message)?.length ?? 0;
    thinkingLen += thinkingLengthForDebug(message);
    toolBlockCount += toolBlockCountForDebug(message);
    if (isLocallyOptimisticHistoryTail(message)) localOptimisticTailCount += 1;
    if (record?.__openclawStreamFallback) streamFallbackCount += 1;
  }

  return {
    count: messages.length,
    roleCounts,
    textLen,
    thinkingLen,
    toolBlockCount,
    localOptimisticTailCount,
    streamFallbackCount,
    first: summarizeMessageForDebug(messages[0]),
    last: summarizeMessageForDebug(messages[messages.length - 1]),
    tail: summarizeMessagesForDebug(messages, 5),
  };
}

export function summarizeMessagesForDebug(messages: unknown[], count: number): unknown[] {
  return messages.slice(-count).map(message => summarizeMessageForDebug(message));
}

export function summarizeMessageForDebug(message: unknown): Record<string, unknown> | null {
  const record = asRecord(message);
  if (!record) return null;
  const text = extractSnapshotText(message) ?? '';
  const signature = messageDisplaySignature(message);
  return {
    role: typeof record.role === 'string' ? record.role : null,
    timestamp: messageTimestampMs(message),
    stopReason: typeof record.stopReason === 'string' ? record.stopReason : null,
    contentKind: Array.isArray(record.content) ? 'array' : typeof record.content,
    contentTypes: contentTypesForDebug(record.content),
    textLen: text.length,
    textPreview: previewForDebug(text),
    textHash: hashTextForDebug(text),
    thinkingLen: thinkingLengthForDebug(message),
    toolBlockCount: toolBlockCountForDebug(message),
    hidden: shouldHideMessage(message),
    localOptimisticTail: isLocallyOptimisticHistoryTail(message),
    streamFallback: Boolean(record.__openclawStreamFallback),
    signatureHash: signature ? hashTextForDebug(signature) : null,
  };
}

export function contentTypesForDebug(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map(block => {
    const record = asRecord(block);
    return typeof record?.type === 'string' ? record.type : typeof block;
  });
}

export function thinkingLengthForDebug(message: unknown): number {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    const record = asRecord(block);
    const thinking = typeof record?.thinking === 'string' ? record.thinking : '';
    const reasoning = typeof record?.reasoning === 'string' ? record.reasoning : '';
    return total + thinking.length + reasoning.length;
  }, 0);
}

export function precedingSegmentsByToolCallId(
  messages: unknown[],
): Map<string, Array<{ type: 'thinking' | 'content'; text: string }>> {
  const result = new Map<string, Array<{ type: 'thinking' | 'content'; text: string }>>();
  const append = (
    segments: Array<{ type: 'thinking' | 'content'; text: string }>,
    type: 'thinking' | 'content',
    text: string,
  ) => {
    const normalized = text.trim();
    if (!normalized) return;
    const tail = segments[segments.length - 1];
    if (tail?.type === type) {
      tail.text += type === 'thinking' ? `\n${normalized}` : normalized;
    } else {
      segments.push({ type, text: normalized });
    }
  };
  for (const value of messages) {
    const message = unwrapToolMessage(value);
    if (!message || String(message.role ?? '').toLowerCase() !== 'assistant') continue;
    if (typeof message.content === 'string' && message.content.trim()) {
      const toolCallId = firstAttachedToolCallId(value);
      if (toolCallId) result.set(toolCallId, [{ type: 'content', text: message.content.trim() }]);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const segments: Array<{ type: 'thinking' | 'content'; text: string }> = [];
    for (const value of message.content) {
      if (typeof value === 'string') {
        append(segments, 'content', value);
        continue;
      }
      const block = asToolRecord(value);
      if (!block) continue;
      if (isToolCallRecord(block)) {
        const toolCallId = readToolCallId(block);
        if (toolCallId && segments.length > 0) {
          result.set(
            toolCallId,
            segments.map(segment => ({ ...segment })),
          );
        }
        segments.length = 0;
        continue;
      }
      const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
      if (type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        append(segments, 'content', block.text);
      } else if (type === 'thinking' || type === 'reasoning') {
        const text = [block.thinking, block.text, block.reasoning].find(
          candidate => typeof candidate === 'string' && candidate.trim(),
        );
        if (typeof text === 'string') append(segments, 'thinking', text);
      }
    }
  }
  return result;
}

export function firstAttachedToolCallId(value: unknown): string | null {
  const outer = asToolRecord(value);
  const message = unwrapToolMessage(value);
  if (!outer || !message) return null;
  const attachments = [
    ...attachedToolMessages(message),
    ...(message === outer ? [] : attachedToolMessages(outer)),
  ];
  for (const attachment of attachments) {
    const source = unwrapToolMessage(attachment);
    if (!source) continue;
    if (isToolCallRecord(source)) return readToolCallId(source);
    if (!Array.isArray(source.content)) continue;
    for (const value of source.content) {
      const block = asToolRecord(value);
      if (block && isToolCallRecord(block)) return readToolCallId(block);
    }
  }
  return null;
}

export function toolResultCallIds(messages: unknown[]): Set<string> {
  const result = new Set<string>();
  for (const value of messages) {
    const message = unwrapToolMessage(value);
    if (!message) continue;
    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    if (role === 'tool' || role === 'toolresult' || role === 'tool_result' || role === 'function') {
      const toolCallId = readToolCallId(message);
      if (toolCallId) result.add(toolCallId);
    }
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const block = asToolRecord(value);
      if (!block || !isToolResultType(block.type)) continue;
      const toolCallId = readToolCallId(block);
      if (toolCallId) result.add(toolCallId);
    }
  }
  return result;
}

export function toolBlockCountForDebug(message: unknown): number {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter(block => {
    const type = asRecord(block)?.type;
    return type === 'toolcall' || type === 'toolresult';
  }).length;
}

export function previewForDebug(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 80)} ... ${normalized.slice(-32)}`;
}

export function hashTextForDebug(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function isTempJustDoSessionKey(sessionKey: string): boolean {
  return /:justdo:temp-[^:]+$/.test(sessionKey);
}

export function extractSnapshotText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  if (typeof m.text === 'string') return m.text;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    const texts = m.content
      .filter((b: unknown) => {
        const block = b as Record<string, unknown>;
        return block.type === 'text' && typeof block.text === 'string';
      })
      .map((b: unknown) => (b as Record<string, unknown>).text as string);
    return texts.length > 0 ? texts.join('') : null;
  }
  return null;
}

export function isChatTextRetraction(event: NormalizedChatEvent): boolean {
  return (
    event.state === 'delta' &&
    event.replace &&
    (extractSnapshotText(event.message) ?? event.deltaText) === ''
  );
}

export function collectActiveThinkingText(turn: AssistantTurn | null): string | null {
  const text = (turn?.items ?? [])
    .filter(item => item.type === 'thinking')
    .map(item => item.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

export function collectActiveContentText(turn: AssistantTurn | null): string | null {
  const text = (turn?.items ?? [])
    .filter(item => item.type === 'content')
    .map(item => item.text)
    .filter(Boolean)
    .join('')
    .trim();
  return text || null;
}

export const OPENCLAW_DISPLAY_TRUNCATION_SUFFIX = '\n...(truncated)...';

export function recoverTruncatedText(value: unknown, candidates: readonly string[]): unknown {
  if (typeof value !== 'string' || !value.endsWith(OPENCLAW_DISPLAY_TRUNCATION_SUFFIX)) {
    return value;
  }
  const prefix = value.slice(0, -OPENCLAW_DISPLAY_TRUNCATION_SUFFIX.length);
  return (
    [...candidates]
      .reverse()
      .find(candidate => candidate.length > prefix.length && candidate.startsWith(prefix)) ?? value
  );
}

export function containsDisplayTruncationMarker(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes('...(truncated)...');
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(candidate => containsDisplayTruncationMarker(candidate, seen));
}

export function completeTruncatedTerminalFromActiveTurn(
  message: unknown,
  turn: AssistantTurn | null,
): unknown {
  if (!isTruncatedHistoryMessage(message) || !message || typeof message !== 'object') {
    return message;
  }
  const contentCandidates = (turn?.items ?? [])
    .filter(item => item.type === 'content')
    .map(item => item.text);
  const thinkingCandidates = (turn?.items ?? [])
    .filter(item => item.type === 'thinking')
    .map(item => item.text);
  if (contentCandidates.length === 0 && thinkingCandidates.length === 0) return message;

  const record = message as Record<string, unknown>;
  const recoverBlock = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const block = value as Record<string, unknown>;
    return {
      ...block,
      ...(typeof block.text === 'string'
        ? { text: recoverTruncatedText(block.text, contentCandidates) }
        : {}),
      ...(typeof block.content === 'string'
        ? { content: recoverTruncatedText(block.content, contentCandidates) }
        : {}),
      ...(typeof block.thinking === 'string'
        ? { thinking: recoverTruncatedText(block.thinking, thinkingCandidates) }
        : {}),
    };
  };
  const recovered: Record<string, unknown> = {
    ...record,
    ...(typeof record.text === 'string'
      ? { text: recoverTruncatedText(record.text, contentCandidates) }
      : {}),
    ...(typeof record.content === 'string'
      ? { content: recoverTruncatedText(record.content, contentCandidates) }
      : Array.isArray(record.content)
        ? { content: record.content.map(recoverBlock) }
        : {}),
  };
  if (containsDisplayTruncationMarker(recovered)) return recovered;

  const metadata = asRecord(recovered.__openclaw);
  if (metadata) {
    const { truncated: _truncated, reason: _reason, ...completeMetadata } = metadata;
    recovered.__openclaw = completeMetadata;
  }
  return recovered;
}

export function buildInterruptedTurnMessage(
  thinkingText: string | null,
  contentText: string | null,
  runId: string | null,
): unknown | null {
  if (!thinkingText && !contentText) return null;
  return {
    role: 'assistant',
    content: [
      ...(thinkingText ? [{ type: 'thinking', thinking: thinkingText }] : []),
      ...(contentText ? [{ type: 'text', text: contentText, interrupted: true }] : []),
    ],
    timestamp: Date.now(),
    interrupted: true,
    ...(runId ? { runId } : {}),
  };
}

export function withThinkingContent(message: unknown, thinkingText: string): unknown {
  if (!message || typeof message !== 'object' || !thinkingText.trim()) return message;
  const record = message as Record<string, unknown>;
  const content = record.content;
  const thinkingBlock = { type: 'thinking', thinking: thinkingText.trim() };

  if (Array.isArray(content)) {
    const alreadyHasThinking = content.some(item => {
      const block = item as Record<string, unknown>;
      return (
        block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()
      );
    });
    return alreadyHasThinking
      ? message
      : {
          ...record,
          content: [thinkingBlock, ...content],
        };
  }

  if (typeof content === 'string') {
    return {
      ...record,
      content: [thinkingBlock, { type: 'text', text: content }],
    };
  }

  if (typeof record.text === 'string') {
    return {
      ...record,
      content: [thinkingBlock, { type: 'text', text: record.text }],
    };
  }

  return {
    ...record,
    content: [thinkingBlock],
  };
}

export function isCompactionMarker(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const marker = (message as Record<string, unknown>).__openclaw;
  return (
    Boolean(marker) &&
    typeof marker === 'object' &&
    (marker as Record<string, unknown>).kind === 'compaction'
  );
}

export function readCompactionMarkerFingerprint(message: unknown): string | null {
  if (!isCompactionMarker(message)) return null;
  const record = message as Record<string, unknown>;
  const marker = record.__openclaw as Record<string, unknown>;
  if (typeof marker.id === 'string' && marker.id) return `id:${marker.id}`;
  const timestamp =
    typeof record.timestamp === 'number' || typeof record.timestamp === 'string'
      ? String(record.timestamp)
      : '';
  return `legacy:${timestamp}`;
}

export function isLocalCompactionStatus(message: unknown, id: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const marker = (message as Record<string, unknown>).__openclaw;
  return (
    Boolean(marker) &&
    typeof marker === 'object' &&
    (marker as Record<string, unknown>).kind === 'compaction-status' &&
    (marker as Record<string, unknown>).id === id
  );
}

export function isHiddenOrPendingControlReplyText(text: string): boolean {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  return (
    SILENT_REPLY_PATTERN.test(trimmed) ||
    (upper.length > 0 && 'NO_REPLY'.startsWith(upper)) ||
    stripHeartbeatTokenForDisplay(trimmed).shouldSkip
  );
}

export function assistantEventText(data: Record<string, unknown>): string | null {
  const snapshot = typeof data.text === 'string' ? data.text : null;
  if (snapshot?.trim()) return snapshot;
  const delta = typeof data.delta === 'string' ? data.delta : null;
  return delta?.trim() ? delta : null;
}

export function isDormantAnnounceControlEvent(
  event: NormalizedAgentEvent,
  activeTurn: AssistantTurn | null,
): boolean {
  if (!event.runId.startsWith('announce:v1:')) return false;
  if (activeTurn?.runId === event.runId) return false;
  // A lifecycle-only announce can still resolve to NO_REPLY, so keep its
  // empty shell dormant. Thinking is user-visible output and must start the
  // same incremental rendering path as an ordinary run immediately.
  return event.stream === 'lifecycle';
}

export function isDormantAnnounceRun(runId: string, activeTurn: AssistantTurn | null): boolean {
  return runId.startsWith('announce:v1:') && activeTurn?.runId !== runId;
}

export function appendTerminalMessage(
  messages: unknown[],
  terminal: unknown,
  activeRunStartedAt: number | null = null,
): unknown[] {
  // Find and replace any stream-fallback message that matches
  const terminalText = extractSnapshotText(terminal);
  const result: unknown[] = [];

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    // Skip stream-fallback messages that the terminal replaces
    if ((m as Record<string, unknown>).__openclawStreamFallback) {
      const fallbackText = (m as Record<string, unknown>).replacementText as string | undefined;
      if (terminalText && fallbackText && terminalText.startsWith(fallbackText)) {
        continue; // Replace this fallback
      }
    }
    result.push(msg);
  }

  const last = result[result.length - 1];
  if (hasSameTerminalIdentity(last, terminal, activeRunStartedAt)) {
    return [...result.slice(0, -1), retainOriginalOpenClawIdentity(terminal, last)];
  }

  result.push(terminal);
  return result;
}

export function messageTimestampMs(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as { timestamp?: unknown; ts?: unknown };
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    return record.timestamp;
  }
  if (typeof record.ts === 'number' && Number.isFinite(record.ts)) {
    return record.ts;
  }
  return null;
}

export function messageDisplaySignature(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : '';
  if (!role) return null;
  const text = extractSnapshotText(message);
  if (typeof text === 'string' && text.trim()) {
    return `${role}:text:${text.trim()}`;
  }
  try {
    return `${role}:content:${JSON.stringify(record.content ?? record.text ?? null)}`;
  } catch {
    return null;
  }
}

export function messageRunId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const openClaw = asRecord(record.__openclaw);
  for (const value of [
    record.runId,
    record.run_id,
    openClaw?.runId,
    openClaw?.run_id,
    asRecord(record.metadata)?.runId,
    asRecord(record.metadata)?.run_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function hasSameTerminalIdentity(
  left: unknown,
  right: unknown,
  activeRunStartedAt: number | null,
): boolean {
  const leftRole = readNonBlankString(asRecord(left)?.role)?.toLowerCase();
  const rightRole = readNonBlankString(asRecord(right)?.role)?.toLowerCase();
  if (leftRole && rightRole && leftRole !== rightRole) return false;
  const leftIdentity = readTranscriptIdentity(left);
  const rightIdentity = readTranscriptIdentity(right);
  if (leftIdentity && rightIdentity && leftIdentity.kind === rightIdentity.kind) {
    return leftIdentity.value === rightIdentity.value;
  }
  if (leftIdentity && rightIdentity) return false;
  const leftRunId = messageRunId(left);
  const rightRunId = messageRunId(right);
  if (leftRunId && rightRunId) return leftRunId === rightRunId;
  const leftTimestamp = messageTimestampMs(left);
  const rightTimestamp = messageTimestampMs(right);
  const leftSignature = messageDisplaySignature(left);
  const rightSignature = messageDisplaySignature(right);
  const sameDisplaySignature =
    leftSignature !== null && rightSignature !== null && leftSignature === rightSignature;
  return (
    sameDisplaySignature &&
    ((leftTimestamp !== null && rightTimestamp !== null && leftTimestamp === rightTimestamp) ||
      (activeRunStartedAt !== null &&
        leftTimestamp !== null &&
        leftTimestamp >= activeRunStartedAt))
  );
}

export function isTerminalToolPhase(phase: string): boolean {
  return [
    'end',
    'complete',
    'completed',
    'done',
    'finish',
    'finished',
    'result',
    'error',
    'failed',
    'cancel',
    'cancelled',
    'canceled',
    'aborted',
  ].includes(phase.toLowerCase());
}

export function isNonTerminalToolPhase(phase: string): boolean {
  return ['start', 'delta', 'partial', 'progress', 'update', 'streaming'].includes(
    phase.toLowerCase(),
  );
}

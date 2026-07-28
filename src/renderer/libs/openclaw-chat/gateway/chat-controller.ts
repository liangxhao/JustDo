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
 * No JustDo adapter and no Redux. Electron-only filesystem/HTTP bridge calls
 * are kept narrow and only used where browser security blocks gateway REST.
 */

import {
  type CoworkAttachmentPayload,
  isImageMimeType,
  toGatewayAttachment,
} from '@shared/cowork/attachments';
import {
  normalizeAgentEvent,
  normalizeChatEvent,
  type NormalizedAgentEvent,
  type NormalizedChatEvent,
} from '@shared/openclaw/agentEvent';
import type {
  OpenClawPagedHistoryParams,
  OpenClawPagedHistoryResult,
} from '@shared/openclaw/historyIpc';
import {
  resolveSlashCommandBehavior,
  SlashCommandBeforeSendHook,
  SlashCommandExecution,
} from '@shared/slashCommands';

import { getTranscriptMedia, toAttachmentContentBlocks } from '@/libs/openclaw-chat/attachments';
import type {
  GatewayClient,
  GatewayEventFrame,
  GatewayHelloOk,
} from '@/libs/openclaw-chat/gateway/client';
import { reduceAgentEvent, reduceChatEvent } from '@/libs/openclaw-chat/model/agent-event-reducer';
import {
  type AssistantTurn,
  beginAssistantTurn,
  type ChatTranscriptState,
  createChatTranscriptState,
  type HistorySource,
  normalizeTranscriptSessionKey,
  resetChatTranscriptState,
  type TranscriptReducerDependencies,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/chunked-message-history';
import { reconcileHistory } from '@/libs/openclaw-chat/model/history-reconciler';
import {
  latestHistoryWindow,
  shiftHistoryWindowNewer,
  shiftHistoryWindowOlder,
} from '@/libs/openclaw-chat/model/history-window';
import {
  isLocallyOptimisticHistoryTail,
  markOptimisticHistoryTail,
} from '@/libs/openclaw-chat/model/optimistic-history-tail';
import { isPendingUserMessageMatch } from '@/libs/openclaw-chat/model/optimistic-user-message';
import { readTranscriptIdentity } from '@/libs/openclaw-chat/model/transcript-identity';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatState {
  client: GatewayClient | null;
  connected: boolean;
  transportStatus: 'disconnected' | 'connected' | 'reconnecting';
  sessionKey: string;
  /** Backing OpenClaw session id returned by chat.startup/chat.history. */
  currentSessionId: string | null;
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

export type ChatStateListener = (state: ChatState) => void;
export type ChatStreamUpdateKind = 'stream' | 'tool-partial' | 'terminal';
export type ChatStreamListener = (kind: ChatStreamUpdateKind) => void;

type CompactionTranscriptReference = {
  leafId?: string;
  entryId?: string;
};

type CompactionCheckpoint = {
  checkpointId?: string;
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  createdAt?: number;
  postCompaction?: CompactionTranscriptReference;
};

type LocalCompactionStatus = {
  id: string;
  markerFingerprintsBefore: Set<string>;
  completedAt?: number;
  message: {
    role: 'system';
    timestamp: number;
    __openclaw: {
      kind: 'compaction-status';
      id: string;
      phase: 'in-progress' | 'completed';
      tokensBefore?: number;
      tokensAfter?: number;
    };
  };
};

type OpenClawHistoryBridge = {
  getToolInputs?: (params: { sessionKey: string; toolCallIds: string[] }) => Promise<{
    success?: boolean;
    inputs?: Record<string, { name?: string; input?: unknown }>;
  }>;
  getPagedHistory?: (
    params: OpenClawPagedHistoryParams,
  ) => Promise<Partial<OpenClawPagedHistoryResult>>;
};

function getOpenClawHistoryBridge(): OpenClawHistoryBridge | undefined {
  return (
    globalThis as {
      electron?: {
        openclaw?: {
          history?: OpenClawHistoryBridge;
        };
      };
    }
  ).electron?.openclaw?.history;
}

function getContentImageUrl(value: unknown): string | null {
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

// ─── Constants ──────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 1000;
const HISTORY_PAGE_LIMIT = 250;
const MAX_EMPTY_HISTORY_PAGES_PER_BATCH = 8;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const AGENT_RUN_FAILED_BEFORE_REPLY = 'The agent run failed before producing a reply.';
const FAILED_RUN_STORAGE_KEY = 'justdo-openclaw-failed-runs';
const FAILED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const POST_FINAL_HISTORY_RELOAD_DELAY_MS = 1500;
const DEFERRED_HISTORY_RELOAD_DELAY_MS = 1200;
const MAX_DEFERRED_HISTORY_CATCHUP_ATTEMPTS = 5;
const DEBUG_CHAT_CONTROLLER =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_CHAT_CONTROLLER === 'true';

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isHistoryNotFoundError(value: unknown): boolean {
  return typeof value === 'string' && /\bhistory REST returned 404\b/i.test(value);
}

function debugLog(...args: unknown[]): void {
  if (DEBUG_CHAT_CONTROLLER) {
    console.debug(...args);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type HistoryPage = {
  messages: unknown[];
  hasMore: boolean;
  nextCursor: string | null;
};

function mergeRefreshedHistoryWindow(current: unknown[], recent: unknown[]): unknown[] {
  if (current.length <= recent.length || recent.length === 0) return recent;
  const firstIdentity = readTranscriptIdentity(recent[0]);
  if (!firstIdentity) return recent;
  const overlapIndex = current.findIndex(message => {
    const identity = readTranscriptIdentity(message);
    return identity?.kind === firstIdentity.kind && identity.value === firstIdentity.value;
  });
  return overlapIndex > 0 ? [...current.slice(0, overlapIndex), ...recent] : recent;
}

type FailedRunRecord = {
  sessionKey: string;
  runId: string | null;
  error: string;
  timestamp: number;
};

function readFailedRuns(): FailedRunRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(FAILED_RUN_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    const cutoff = Date.now() - FAILED_RUN_RETENTION_MS;
    return value.filter(
      (item): item is FailedRunRecord =>
        typeof item?.sessionKey === 'string' &&
        (typeof item.runId === 'string' || item.runId === null) &&
        typeof item.error === 'string' &&
        typeof item.timestamp === 'number' &&
        item.timestamp >= cutoff,
    );
  } catch {
    return [];
  }
}

function persistFailedRun(record: FailedRunRecord): void {
  if (typeof localStorage === 'undefined') return;
  const records = readFailedRuns().filter(
    item => !(record.runId && item.sessionKey === record.sessionKey && item.runId === record.runId),
  );
  try {
    localStorage.setItem(FAILED_RUN_STORAGE_KEY, JSON.stringify([...records, record].slice(-100)));
  } catch {
    // A storage failure must not interfere with chat error handling.
  }
}

function findFailedRunError(message: Record<string, unknown>, sessionKey: string): string | null {
  const runId = typeof message.runId === 'string' ? message.runId : null;
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
  const candidates = readFailedRuns().filter(item => item.sessionKey === sessionKey);
  const exact = runId ? candidates.find(item => item.runId === runId) : null;
  if (exact) return exact.error;
  if (timestamp === null) return candidates[candidates.length - 1]?.error ?? null;
  return (
    candidates
      .filter(item => Math.abs(item.timestamp - timestamp) < 60_000)
      .sort(
        (left, right) =>
          Math.abs(left.timestamp - timestamp) - Math.abs(right.timestamp - timestamp),
      )[0]?.error ?? null
  );
}

function normalizeFailedRunMessage(
  message: unknown,
  sessionKey: string,
  errorMessage: string | null,
): unknown {
  const raw = asRecord(message);
  if (
    raw?.role !== 'assistant' ||
    messageText(raw.content).trim() !== AGENT_RUN_FAILED_BEFORE_REPLY
  ) {
    return message;
  }

  return {
    ...raw,
    role: 'system',
    content:
      errorMessage?.trim() || findFailedRunError(raw, sessionKey) || AGENT_RUN_FAILED_BEFORE_REPLY,
    isError: true,
  };
}

function getToolResultId(message: unknown): string | null {
  const raw = asRecord(message);
  if (!raw) return null;
  const id = [raw.toolCallId, raw.tool_call_id, raw.toolUseId, raw.tool_use_id].find(
    value => typeof value === 'string' && value.trim(),
  );
  return typeof id === 'string' ? id : null;
}

function hasMessageToolInput(message: unknown): boolean {
  const raw = asRecord(message);
  if (!raw) return false;
  for (const value of [raw.toolInput, raw.tool_input, raw.arguments, raw.args, raw.input]) {
    if (hasMeaningfulToolInput(value)) return true;
  }
  return false;
}

async function hydrateMissingToolInputsFromLocalState(
  sessionKey: string,
  messages: unknown[],
): Promise<unknown[]> {
  const missingIds = Array.from(
    new Set(
      messages
        .filter(message => {
          const raw = asRecord(message);
          const role = typeof raw?.role === 'string' ? raw.role.toLowerCase() : '';
          return ['toolresult', 'tool_result', 'tool', 'function'].includes(role);
        })
        .filter(message => !hasMessageToolInput(message))
        .map(getToolResultId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (missingIds.length === 0) return messages;

  const result = await getOpenClawHistoryBridge()?.getToolInputs?.({
    sessionKey,
    toolCallIds: missingIds,
  });
  const inputs = result?.success && result.inputs ? result.inputs : {};
  if (Object.keys(inputs).length === 0) return messages;

  return messages.map(message => {
    const raw = asRecord(message);
    if (!raw || hasMessageToolInput(raw)) return message;
    const id = getToolResultId(raw);
    const hydrated = id ? inputs[id] : undefined;
    if (!hydrated || !hasMeaningfulToolInput(hydrated.input)) return message;
    return {
      ...raw,
      toolName: raw.toolName ?? raw.tool_name ?? hydrated.name,
      toolInput: hydrated.input,
    };
  });
}

function hasMeaningfulToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

// ─── ChatController ─────────────────────────────────────────────────────────

export class ChatController {
  private readonly localSlashCommandHandlers = new Map<
    string,
    (argumentsText: string) => Promise<void>
  >([['compact', argumentsText => this.compactSession(argumentsText)]]);

  private readonly slashCommandBeforeSendHandlers = new Map<
    string,
    (sessionKey: string) => Promise<void>
  >([
    [
      SlashCommandBeforeSendHook.EnsureSessionEntry,
      sessionKey => this.ensureSessionEntry(sessionKey),
    ],
  ]);

  private gatewayHttpBase = '';
  private gatewayToken = '';
  private chatMessagesBySession = new Map<string, ChunkedMessageHistory>();
  private historySourceBySession = new Map<string, HistorySource>();
  private currentMessageHistory = new ChunkedMessageHistory();
  private transcriptImageCache = new Map<string, Promise<string | null>>();
  private transcriptImageReadsActive = 0;
  private transcriptImageReadWaiters: Array<() => void> = [];
  readonly state: ChatState;
  private listeners: Set<ChatStateListener> = new Set();
  private streamListeners: Set<ChatStreamListener> = new Set();
  private lifecycleEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private postFinalHistoryReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredHistoryReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private olderHistoryContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredHistoryReloadAttempts = new Map<string, number>();
  private localCompactionStatusBySession = new Map<string, LocalCompactionStatus>();
  private assistantSnapshotRunId: string | null = null;
  private ignoredDeltaAfterAssistantSnapshotCount = 0;
  private historyLoadSeq = 0;
  private subscribedMessageSessionKey: string | null = null;
  private messageSubscriptionSeq = 0;
  private suspendedRunId: string | null = null;
  private terminalLifecycleSeen = false;
  private transcriptIdSequence = 0;
  private readonly transcriptDependencies: TranscriptReducerDependencies = {
    now: () => Date.now(),
    createId: prefix => `${prefix}-${++this.transcriptIdSequence}`,
  };

  /** Compact state snapshot for diagnostic logging */
  private _snap(): Record<string, unknown> {
    return {
      chatSending: this.state.chatSending,
      chatRunId: this.state.chatRunId,
      msgCount: this.currentMessageHistory.length,
      activeItemCount: this.state.transcript.activeTurn?.items.length ?? 0,
      activeTurnStatus: this.state.transcript.activeTurn?.status ?? null,
      hasPending: !!this.state.pendingUserMessage,
      pendingReload: this.pendingHistoryReload,
      chatLoading: this.state.chatLoading,
      connected: this.state.connected,
      msgRoles: (this.state.chatMessages as Array<Record<string, unknown>>)
        .slice(-5)
        .map(
          m =>
            `${m.role ?? '?'}${(m as Record<string, unknown>).__openclawStreamFallback ? '(fallback)' : ''}`,
        ),
      tail: summarizeMessagesForDebug(this.state.chatMessages, 3),
    };
  }

  constructor() {
    this.state = {
      client: null,
      connected: false,
      transportStatus: 'disconnected',
      sessionKey: '',
      currentSessionId: null,
      chatLoading: false,
      historyLoadingOlder: false,
      historyHasMore: false,
      historyNextCursor: null,
      loadedMessageCount: 0,
      chatMessages: [],
      visibleChatMessages: [],
      historyWindowStart: 0,
      historyWindowEnd: 0,
      chatSending: false,
      compactionInFlight: false,
      chatRunId: null,
      lastError: null,
      hello: null,
      pendingUserMessage: null,
      transcript: createChatTranscriptState(),
    };
  }

  /** Set an optimistic user message shown until the next loadHistory.
   *  Also marks chatSending=true so session.message events are deferred. */
  setPendingUserMessage(text: string, attachments: CoworkAttachmentPayload[] = []): void {
    debugLog('[ChatCtrl] setPendingUserMessage:', text.slice(0, 60));
    const attachmentBlocks = toAttachmentContentBlocks(attachments);
    this.state.pendingUserMessage = {
      role: 'user',
      content: attachmentBlocks.length > 0 ? [{ type: 'text', text }, ...attachmentBlocks] : text,
      text,
      timestamp: Date.now(),
    };
    this.state.chatSending = true;
    this.notify();
  }

  /** Clear sending state (e.g. when session start fails) */
  clearSending(): void {
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.state.pendingUserMessage = null;
    this.resetAssistantSnapshotSource();
    this.notify();
  }

  /** Subscribe to state changes */
  subscribe(listener: ChatStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to stream updates (for real-time rendering) */
  onStream(listener: ChatStreamListener): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  private notify(): void {
    debugLog('[ChatCtrl] ▶ notify', this._snap());
    for (const listener of this.listeners) listener(this.state);
  }

  private notifyStream(kind: ChatStreamUpdateKind = 'stream'): void {
    debugLog('[ChatCtrl] ▶ notifyStream', this._snap());
    for (const listener of this.streamListeners) listener(kind);
  }

  private cacheSessionMessages(
    sessionKey: string,
    history: ChunkedMessageHistory = this.currentMessageHistory,
  ): void {
    if (!sessionKey) return;
    this.chatMessagesBySession.delete(sessionKey);
    this.chatMessagesBySession.set(sessionKey, history);
    this.historySourceBySession.set(sessionKey, this.state.transcript.historySource);
    if (this.chatMessagesBySession.size > 20) {
      const oldestKey = this.chatMessagesBySession.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.chatMessagesBySession.delete(oldestKey);
        this.historySourceBySession.delete(oldestKey);
      }
    }
  }

  private setCurrentSessionMessages(messages: unknown[]): void {
    const previousMessages = this.state.chatMessages;
    if (this.currentMessageHistory.recentMessages !== previousMessages) {
      this.currentMessageHistory.reset(previousMessages);
    }
    const previousTotal = this.currentMessageHistory.length;
    const wasAtLatest = this.state.historyWindowEnd >= previousTotal;
    this.currentMessageHistory.replaceRecent(messages);
    const nextTotal = this.currentMessageHistory.length;
    const nextWindow = wasAtLatest
      ? latestHistoryWindow(nextTotal)
      : {
          start: Math.min(this.state.historyWindowStart, nextTotal),
          end: Math.min(this.state.historyWindowEnd, nextTotal),
        };
    this.state.chatMessages = messages;
    this.state.loadedMessageCount = nextTotal;
    this.state.historyWindowStart = nextWindow.start;
    this.state.historyWindowEnd = nextWindow.end;
    this.state.visibleChatMessages = this.currentMessageHistory.slice(
      nextWindow.start,
      nextWindow.end,
    );
    this.state.transcript.persistedMessages = messages;
    this.cacheSessionMessages(this.state.sessionKey);
  }

  private updateLocalCompactionMessage(
    sessionKey: string,
    statusId: string,
    replacement: unknown | null,
  ): void {
    const history =
      this.state.sessionKey === sessionKey
        ? this.state.chatMessages
        : this.chatMessagesBySession.get(sessionKey)?.recentMessages;
    if (!history) return;
    const nextMessages = history.flatMap(message =>
      isLocalCompactionStatus(message, statusId)
        ? replacement === null
          ? []
          : [replacement]
        : [message],
    );
    if (this.state.sessionKey === sessionKey) {
      this.setCurrentSessionMessages(nextMessages);
      return;
    }
    this.chatMessagesBySession.get(sessionKey)?.replaceRecent(nextMessages);
  }

  private projectLocalCompactionStatus(sessionKey: string, messages: unknown[]): unknown[] {
    const status = this.localCompactionStatusBySession.get(sessionKey);
    if (!status) return messages;
    const hasAuthoritativeMarker = messages.some(message => {
      const fingerprint = readCompactionMarkerFingerprint(message);
      return fingerprint !== null && !status.markerFingerprintsBefore.has(fingerprint);
    });
    if (hasAuthoritativeMarker) {
      this.localCompactionStatusBySession.delete(sessionKey);
      this.deferredHistoryReloadAttempts.delete(sessionKey);
      return messages;
    }
    return [...messages.filter(message => !isLocalCompactionStatus(message, status.id)), status.message];
  }

  private beginLocalCompactionStatus(
    sessionKey: string,
    options: { forceNew?: boolean } = {},
  ): LocalCompactionStatus {
    const existing = this.localCompactionStatusBySession.get(sessionKey);
    if (existing?.message.__openclaw.phase === 'in-progress') return existing;
    if (
      existing?.completedAt &&
      !options.forceNew &&
      Date.now() - existing.completedAt < 5000
    ) {
      return existing;
    }
    if (existing) {
      this.updateLocalCompactionMessage(sessionKey, existing.id, null);
    }
    const startedAt = Date.now();
    const id = `local-compaction-${startedAt}-${this.transcriptIdSequence++}`;
    const status: LocalCompactionStatus = {
      id,
      markerFingerprintsBefore: new Set(
        this.state.chatMessages
          .map(readCompactionMarkerFingerprint)
          .filter((fingerprint): fingerprint is string => fingerprint !== null),
      ),
      message: {
        role: 'system',
        timestamp: startedAt,
        __openclaw: {
          kind: 'compaction-status',
          id,
          phase: 'in-progress',
        },
      },
    };
    this.deferredHistoryReloadAttempts.delete(sessionKey);
    this.localCompactionStatusBySession.set(sessionKey, status);
    if (this.state.sessionKey === sessionKey) {
      this.setCurrentSessionMessages([...this.state.chatMessages, status.message]);
    }
    return status;
  }

  private completeLocalCompactionStatus(
    sessionKey: string,
    tokens?: { before?: number; after?: number },
  ): LocalCompactionStatus | null {
    const status = this.localCompactionStatusBySession.get(sessionKey);
    if (!status) return null;
    status.message = {
      ...status.message,
      __openclaw: {
        ...status.message.__openclaw,
        phase: 'completed',
        tokensBefore: tokens?.before ?? status.message.__openclaw.tokensBefore,
        tokensAfter: tokens?.after ?? status.message.__openclaw.tokensAfter,
      },
    };
    status.completedAt ??= Date.now();
    this.updateLocalCompactionMessage(sessionKey, status.id, status.message);
    return status;
  }

  private clearLocalCompactionStatus(sessionKey: string): void {
    const status = this.localCompactionStatusBySession.get(sessionKey);
    if (!status) return;
    this.localCompactionStatusBySession.delete(sessionKey);
    this.deferredHistoryReloadAttempts.delete(sessionKey);
    this.updateLocalCompactionMessage(sessionKey, status.id, null);
  }

  private applyHistoryWindow(window: { start: number; end: number }): boolean {
    if (
      window.start === this.state.historyWindowStart &&
      window.end === this.state.historyWindowEnd
    ) {
      return false;
    }
    this.state.historyWindowStart = window.start;
    this.state.historyWindowEnd = window.end;
    this.state.visibleChatMessages = this.currentMessageHistory.slice(window.start, window.end);
    this.state.transcript.revision += 1;
    this.notify();
    return true;
  }

  async showOlderHistory(): Promise<boolean> {
    const shifted = shiftHistoryWindowOlder(
      {
        start: this.state.historyWindowStart,
        end: this.state.historyWindowEnd,
      },
      this.currentMessageHistory.length,
    );
    if (this.applyHistoryWindow(shifted)) return true;
    return this.loadOlderHistory();
  }

  showNewerHistory(): boolean {
    return this.applyHistoryWindow(
      shiftHistoryWindowNewer(
        {
          start: this.state.historyWindowStart,
          end: this.state.historyWindowEnd,
        },
        this.currentMessageHistory.length,
      ),
    );
  }

  showLatestHistory(): boolean {
    return this.applyHistoryWindow(latestHistoryWindow(this.currentMessageHistory.length));
  }

  /** Materialize every loaded page only for explicit whole-history consumers such as export. */
  getLoadedMessages(): unknown[] {
    return this.currentMessageHistory.toArray();
  }

  /**
   * Admit the SQLite-backed Redux snapshot as an immediately renderable,
   * lower-authority history source. Gateway history always wins, while an
   * active live turn prevents the fallback from replacing its visible tail.
   */
  admitFallbackHistory(sessionKey: string, messages: unknown[]): boolean {
    if (!sessionKey) return false;
    const projectedMessages = messages
      .map(stripAssistantSilentReplySuffix)
      .filter(message => !shouldHideMessage(message))
      .filter(message => !asRecord(message)?.__openclawStreamFallback);

    if (sessionKey !== this.state.sessionKey) {
      const existingSource = this.historySourceBySession.get(sessionKey) ?? 'optimistic';
      if (existingSource === 'gateway') return false;
      const existingHistory = this.chatMessagesBySession.get(sessionKey);
      const fallbackState = createChatTranscriptState(sessionKey, null);
      fallbackState.historySource = existingSource;
      fallbackState.persistedMessages = existingHistory?.recentMessages ?? [];
      const reconciliation = reconcileHistory(fallbackState, {
        request: {
          sessionKey,
          sessionId: null,
          historyGeneration: fallbackState.historyGeneration,
        },
        source: 'sqlite-fallback',
        messages: projectedMessages,
        requestStartMessages: fallbackState.persistedMessages,
        currentMessages: fallbackState.persistedMessages,
        isVisibleMessage: message => !shouldHideMessage(message),
      });
      if (!reconciliation.accepted) return false;
      const history = new ChunkedMessageHistory();
      history.reset(reconciliation.messages);
      this.chatMessagesBySession.set(sessionKey, history);
      this.historySourceBySession.set(sessionKey, 'sqlite-fallback');
      return true;
    }

    this.ensureTranscriptSessionIdentity();
    const previousMessages = this.state.chatMessages;
    const reconciliation = reconcileHistory(this.state.transcript, {
      request: {
        sessionKey,
        sessionId: this.state.transcript.sessionId,
        historyGeneration: this.state.transcript.historyGeneration,
      },
      source: 'sqlite-fallback',
      messages: projectedMessages,
      requestStartMessages: previousMessages,
      currentMessages: this.state.chatMessages,
      activeRun:
        this.state.chatSending || this.state.transcript.activeTurn?.status === 'running',
      isVisibleMessage: message => !shouldHideMessage(message),
    });
    if (!reconciliation.accepted) return false;

    this.state.historyHasMore = false;
    this.state.historyNextCursor = null;
    this.setCurrentSessionMessages(reconciliation.messages);
    this.notify();
    return true;
  }

  private ensureTranscriptSessionIdentity(): void {
    if (this.state.transcript.sessionKey === this.state.sessionKey) return;
    resetChatTranscriptState(
      this.state.transcript,
      this.state.sessionKey,
      this.state.currentSessionId,
    );
    this.state.transcript.persistedMessages = this.state.chatMessages;
  }

  private async syncMessageSessionSubscription(sessionKey: string): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected || !sessionKey) return;

    const previousSessionKey = this.subscribedMessageSessionKey;
    if (previousSessionKey === sessionKey) return;
    const subscriptionSeq = ++this.messageSubscriptionSeq;

    if (previousSessionKey) {
      await client
        .request('sessions.messages.unsubscribe', { key: previousSessionKey })
        .catch(() => {});
    }
    if (
      this.state.client !== client ||
      !this.state.connected ||
      subscriptionSeq !== this.messageSubscriptionSeq
    ) {
      return;
    }
    try {
      await client.request('sessions.messages.subscribe', { key: sessionKey });
      if (
        this.state.client === client &&
        this.state.connected &&
        subscriptionSeq === this.messageSubscriptionSeq
      ) {
        this.subscribedMessageSessionKey = sessionKey;
      } else {
        // OpenClaw subscriptions are many-to-many. A stale subscribe can
        // succeed after a newer session transition, so undo it explicitly.
        await client.request('sessions.messages.unsubscribe', { key: sessionKey }).catch(() => {});
      }
    } catch {
      if (subscriptionSeq === this.messageSubscriptionSeq) {
        this.subscribedMessageSessionKey = null;
      }
    }
  }

  private acceptRunId(runId: string | undefined | null, allowProvisionalBinding = true): boolean {
    if (!runId || !this.state.chatRunId || runId === this.state.chatRunId) return true;
    if (
      allowProvisionalBinding &&
      this.state.chatSending &&
      this.state.chatRunId.startsWith('justdo-')
    ) {
      this.state.chatRunId = runId;
      return true;
    }
    return false;
  }

  private clearLifecycleEndFallback(): void {
    if (!this.lifecycleEndFallbackTimer) return;
    clearTimeout(this.lifecycleEndFallbackTimer);
    this.lifecycleEndFallbackTimer = null;
  }

  private scheduleChatLifecycleEndFallback(): void {
    if (!this.state.chatSending || this.state.compactionInFlight) return;
    const endingRunId = this.state.chatRunId;
    this.clearLifecycleEndFallback();
    this.lifecycleEndFallbackTimer = setTimeout(() => {
      this.lifecycleEndFallbackTimer = null;
      if (
        !this.state.chatSending ||
        this.state.compactionInFlight ||
        this.state.chatRunId !== endingRunId
      ) {
        return;
      }
      debugLog('[ChatCtrl] ▶ lifecycle:end fallback', this._snap());
      reduceChatEvent(
        this.state.transcript,
        {
          runId: endingRunId,
          sessionKey: this.state.sessionKey,
          sessionId: this.state.currentSessionId,
          lifecycleGeneration: this.state.transcript.activeTurn?.lifecycleGeneration ?? null,
          frameSeq: null,
          state: 'final',
          replace: false,
        },
        this.transcriptDependencies,
      );
      this.state.chatSending = false;
      this.state.chatRunId = null;
      this.terminalLifecycleSeen = false;
      this.flushPendingHistoryReload();
      this.notify();
    }, 1500);
    this.notifyStream();
  }

  private handleCompactionPhase(phase: string, sessionKey = this.state.sessionKey): void {
    const isCurrentSession = sessionKey === this.state.sessionKey;
    if (phase === 'start') {
      const status = this.beginLocalCompactionStatus(sessionKey);
      if (status.message.__openclaw.phase === 'completed' || !isCurrentSession) return;
      this.state.compactionInFlight = true;
      this.clearLifecycleEndFallback();
      this.notifyStream();
      this.notify();
      return;
    }
    if (phase === 'error' || phase === 'failed') {
      this.clearLocalCompactionStatus(sessionKey);
      if (!isCurrentSession) return;
      this.state.compactionInFlight = false;
      this.notifyStream();
      this.notify();
      return;
    }
    if (phase !== 'end') return;
    const wasInProgress =
      this.localCompactionStatusBySession.get(sessionKey)?.message.__openclaw.phase ===
      'in-progress';
    const status = this.completeLocalCompactionStatus(sessionKey);
    if (!isCurrentSession) return;
    this.state.compactionInFlight = false;
    if (this.terminalLifecycleSeen) this.scheduleChatLifecycleEndFallback();
    if (status && wasInProgress) {
      this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
    }
    this.notifyStream();
    this.notify();
  }

  private clearPostFinalHistoryReload(): void {
    if (!this.postFinalHistoryReloadTimer) return;
    clearTimeout(this.postFinalHistoryReloadTimer);
    this.postFinalHistoryReloadTimer = null;
  }

  private clearDeferredHistoryReload(): void {
    if (!this.deferredHistoryReloadTimer) return;
    clearTimeout(this.deferredHistoryReloadTimer);
    this.deferredHistoryReloadTimer = null;
  }

  private clearOlderHistoryContinuation(): void {
    if (this.olderHistoryContinuationTimer === null) return;
    clearTimeout(this.olderHistoryContinuationTimer);
    this.olderHistoryContinuationTimer = null;
  }

  private scheduleOlderHistoryContinuation(params: {
    sessionKey: string;
    sessionId: string | null;
    historyGeneration: number;
    cursor: string;
  }): void {
    if (this.olderHistoryContinuationTimer !== null) return;
    this.olderHistoryContinuationTimer = setTimeout(() => {
      this.olderHistoryContinuationTimer = null;
      if (
        this.state.sessionKey !== params.sessionKey ||
        this.state.transcript.sessionId !== params.sessionId ||
        this.state.transcript.historyGeneration !== params.historyGeneration ||
        !this.state.historyHasMore ||
        this.state.historyNextCursor !== params.cursor
      ) {
        return;
      }
      void this.loadOlderHistory();
    }, 0);
  }

  private scheduleDeferredHistoryReload(sessionKey: string, reason: string): void {
    if (reason === 'agent-item') {
      this.deferredHistoryReloadAttempts.delete(sessionKey);
    }
    if (reason === 'stale-history' || reason === 'regressive-history') {
      const attempts = (this.deferredHistoryReloadAttempts.get(sessionKey) ?? 0) + 1;
      if (attempts > MAX_DEFERRED_HISTORY_CATCHUP_ATTEMPTS) {
        debugLog('[ChatCtrl] deferred history reload suppressed after catchup limit', {
          sessionKey,
          reason,
          attempts,
          ...this._snap(),
        });
        return;
      }
      this.deferredHistoryReloadAttempts.set(sessionKey, attempts);
    }
    this.historyReloadRequested.add(sessionKey);
    if (this.deferredHistoryReloadTimer) {
      debugLog('[ChatCtrl] deferred history reload already scheduled', {
        sessionKey,
        reason,
        ...this._snap(),
      });
      return;
    }

    this.deferredHistoryReloadTimer = setTimeout(() => {
      this.deferredHistoryReloadTimer = null;
      if (this.state.sessionKey !== sessionKey || !this.state.connected) {
        this.historyReloadRequested.delete(sessionKey);
        this.deferredHistoryReloadAttempts.delete(sessionKey);
        debugLog('[ChatCtrl] deferred history reload skipped', {
          sessionKey,
          reason,
          ...this._snap(),
        });
        return;
      }
      if (this.state.chatSending || this.historyLoadsInFlight.has(sessionKey)) {
        debugLog('[ChatCtrl] deferred history reload waiting', {
          sessionKey,
          reason,
          ...this._snap(),
        });
        this.scheduleDeferredHistoryReload(sessionKey, reason);
        return;
      }

      if (reason === 'compaction-marker-pending') {
        const attempts = (this.deferredHistoryReloadAttempts.get(sessionKey) ?? 0) + 1;
        if (attempts > MAX_DEFERRED_HISTORY_CATCHUP_ATTEMPTS) {
          this.historyReloadRequested.delete(sessionKey);
          debugLog('[ChatCtrl] compaction marker reload suppressed after retry limit', {
            sessionKey,
            attempts,
            ...this._snap(),
          });
          return;
        }
        this.deferredHistoryReloadAttempts.set(sessionKey, attempts);
      }
      this.historyReloadRequested.delete(sessionKey);
      debugLog('[ChatCtrl] deferred history reload → loadHistory', {
        sessionKey,
        reason,
        ...this._snap(),
      });
      void this.loadHistory(true);
    }, DEFERRED_HISTORY_RELOAD_DELAY_MS);
  }

  private schedulePostFinalHistoryReload(sessionKey: string): void {
    this.clearPostFinalHistoryReload();
    this.postFinalHistoryReloadTimer = setTimeout(() => {
      this.postFinalHistoryReloadTimer = null;
      if (this.state.sessionKey !== sessionKey || !this.state.connected || this.state.chatSending) {
        debugLog('[ChatCtrl] post-final history reload skipped', {
          sessionKey,
          ...this._snap(),
        });
        return;
      }
      debugLog('[ChatCtrl] post-final history reload → loadHistory', {
        sessionKey,
        ...this._snap(),
      });
      void this.loadHistory(true);
    }, POST_FINAL_HISTORY_RELOAD_DELAY_MS);
  }

  private resetAssistantSnapshotSource(): void {
    this.assistantSnapshotRunId = null;
    this.ignoredDeltaAfterAssistantSnapshotCount = 0;
  }

  // ─── Connection ───────────────────────────────────────────────────────

  /**
   * Connect to the gateway and load chat history for the given session.
   * This replicates the webchat's connectGateway + loadChatHistory flow.
   */
  async connect(url: string, token: string, sessionKey: string): Promise<void> {
    this.gatewayHttpBase = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    this.gatewayToken = token;
    // Stop existing client
    this.state.client?.stop();
    this.messageSubscriptionSeq += 1;
    this.subscribedMessageSessionKey = null;
    this.clearOlderHistoryContinuation();

    this.state.sessionKey = sessionKey;
    this.state.currentSessionId = null;
    this.state.historyLoadingOlder = false;
    this.state.historyHasMore = false;
    this.state.historyNextCursor = null;
    resetChatTranscriptState(this.state.transcript, sessionKey, null);
    this.state.chatLoading = true;
    this.currentMessageHistory =
      this.chatMessagesBySession.get(sessionKey) ?? new ChunkedMessageHistory();
    this.state.chatMessages = this.currentMessageHistory.recentMessages;
    this.state.loadedMessageCount = this.currentMessageHistory.length;
    const initialWindow = latestHistoryWindow(this.currentMessageHistory.length);
    this.state.historyWindowStart = initialWindow.start;
    this.state.historyWindowEnd = initialWindow.end;
    this.state.visibleChatMessages = this.currentMessageHistory.slice(
      initialWindow.start,
      initialWindow.end,
    );
    this.state.transcript.persistedMessages = this.state.chatMessages;
    this.state.transcript.historySource =
      this.historySourceBySession.get(sessionKey) ?? 'optimistic';
    this.state.chatRunId = null;
    this.state.compactionInFlight = false;
    this.terminalLifecycleSeen = false;
    this.suspendedRunId = null;
    this.state.lastError = null;
    this.resetAssistantSnapshotSource();
    this.notify();

    const { GatewayClient } = await import('./client');
    const client = new GatewayClient({
      url,
      token,
      onHello: hello => this.handleHello(hello),
      onEvent: event => this.handleEvent(event),
      onClose: () => this.handleClose(),
    });

    this.state.client = client;
    client.start();
  }

  /** Switch to a different session */
  async switchSession(sessionKey: string): Promise<void> {
    const previousSessionKey = this.state.sessionKey;
    const isTempSessionPromotion =
      isTempJustDoSessionKey(previousSessionKey) && !isTempJustDoSessionKey(sessionKey);
    debugLog('[ChatCtrl] switchSession:', sessionKey, {
      hadPendingUserMsg: !!this.state.pendingUserMessage,
      chatSending: this.state.chatSending,
      msgCount: this.state.chatMessages.length,
      previousSessionKey,
      isTempSessionPromotion,
    });
    this.state.sessionKey = sessionKey;
    this.state.currentSessionId = null;
    this.state.historyLoadingOlder = false;
    this.state.historyHasMore = false;
    this.state.historyNextCursor = null;
    if (isTempSessionPromotion) {
      this.state.transcript.sessionKey = sessionKey;
      this.state.transcript.sessionId = null;
      this.state.transcript.historyGeneration += 1;
      if (this.state.transcript.activeTurn) {
        this.state.transcript.activeTurn.sessionKey = sessionKey;
        this.state.transcript.activeTurn.sessionId = null;
      }
      this.state.transcript.revision += 1;
    } else {
      resetChatTranscriptState(this.state.transcript, sessionKey, null);
    }
    // Only preserve the optimistic prompt while replacing the temporary UI
    // session with the persisted JustDo session. For normal user-initiated
    // switches, clear the active run state so the target session can load its
    // own history even while another session is still running.
    if (!isTempSessionPromotion) {
      this.state.chatSending = false;
      this.state.pendingUserMessage = null;
    }
    this.currentMessageHistory =
      this.chatMessagesBySession.get(sessionKey) ?? new ChunkedMessageHistory();
    this.state.chatMessages = this.currentMessageHistory.recentMessages;
    this.state.loadedMessageCount = this.currentMessageHistory.length;
    const initialWindow = latestHistoryWindow(this.currentMessageHistory.length);
    this.state.historyWindowStart = initialWindow.start;
    this.state.historyWindowEnd = initialWindow.end;
    this.state.visibleChatMessages = this.currentMessageHistory.slice(
      initialWindow.start,
      initialWindow.end,
    );
    this.state.transcript.persistedMessages = this.state.chatMessages;
    this.state.transcript.historySource =
      this.historySourceBySession.get(sessionKey) ?? 'optimistic';
    this.state.chatRunId = null;
    this.suspendedRunId = null;
    this.state.compactionInFlight = false;
    this.terminalLifecycleSeen = false;
    this.state.chatLoading = true;
    this.pendingHistoryReload = false;
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.clearOlderHistoryContinuation();
    this.resetAssistantSnapshotSource();
    this.notify();

    if (this.state.connected) {
      await this.syncMessageSessionSubscription(sessionKey);
      await this.loadHistory(false, { preferStartup: true });
    }
  }

  /** Disconnect and clean up */
  disconnect(): void {
    this.clearLifecycleEndFallback();
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.clearOlderHistoryContinuation();
    for (const sessionKey of [...this.localCompactionStatusBySession.keys()]) {
      this.clearLocalCompactionStatus(sessionKey);
    }
    this.state.client?.stop();
    this.state.client = null;
    this.state.connected = false;
    this.state.transportStatus = 'disconnected';
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.terminalLifecycleSeen = false;
    this.suspendedRunId = null;
    this.messageSubscriptionSeq += 1;
    this.subscribedMessageSessionKey = null;
    this.notify();
  }

  // ─── Gateway Callbacks ────────────────────────────────────────────────

  private handleHello(hello: GatewayHelloOk): void {
    debugLog('[ChatCtrl] handleHello — connected, sessionKey:', this.state.sessionKey);
    const resumedTransport = this.state.transportStatus === 'reconnecting';
    this.state.connected = true;
    this.state.transportStatus = 'connected';
    this.messageSubscriptionSeq += 1;
    this.subscribedMessageSessionKey = null;
    this.state.hello = hello;
    this.state.lastError = null;
    this.notify();

    // Subscribe to session events (matches webchat: subscribeSessions + syncSelectedSessionMessageSubscription)
    this.state.client?.request('sessions.subscribe', {}).catch(() => {});
    void this.syncMessageSessionSubscription(this.state.sessionKey);

    // Load startup metadata once after connection. Later history refreshes use
    // chat.history so post-run reconciliation does not touch startup surfaces.
    if (resumedTransport && this.suspendedRunId) {
      void this.reconcileSuspendedRun();
    } else {
      void this.loadHistory(false, { preferStartup: true });
    }
  }

  private handleClose(): void {
    this.suspendedRunId =
      this.state.transcript.activeTurn?.status === 'running'
        ? this.state.transcript.activeTurn.runId
        : null;
    this.state.connected = false;
    this.state.transportStatus =
      this.state.client && this.state.transcript.activeTurn?.status === 'running'
        ? 'reconnecting'
        : 'disconnected';
    // A transport interruption is not a terminal run event. Preserve the
    // active turn and sending state until history or Gateway events establish
    // the business outcome.
    this.state.compactionInFlight = false;
    this.terminalLifecycleSeen = false;
    this.messageSubscriptionSeq += 1;
    this.subscribedMessageSessionKey = null;
    this.notify();
  }

  private async reconcileSuspendedRun(): Promise<void> {
    const suspendedRunId = this.suspendedRunId;
    if (!suspendedRunId) return;
    await this.loadHistory(false, { preferStartup: true, reconcileSuspended: true });
    if (
      this.suspendedRunId !== suspendedRunId ||
      this.state.transcript.activeTurn?.runId !== suspendedRunId ||
      this.state.transcript.activeTurn.status !== 'running'
    ) {
      if (this.suspendedRunId === suspendedRunId && !this.state.transcript.activeTurn) {
        this.state.chatSending = false;
        this.state.chatRunId = null;
        this.notify();
      }
      this.suspendedRunId = null;
      return;
    }

    try {
      const result = await this.state.client?.request<{ sessions?: unknown[] }>(
        'sessions.list',
        {},
      );
      const selected = (result?.sessions ?? []).map(asRecord).find(row => {
        const key =
          typeof row?.key === 'string'
            ? row.key
            : typeof row?.sessionKey === 'string'
              ? row.sessionKey
              : '';
        return (
          normalizeTranscriptSessionKey(key) ===
          normalizeTranscriptSessionKey(this.state.sessionKey)
        );
      });
      if (selected?.hasActiveRun !== false) return;

      const event: NormalizedChatEvent = {
        runId: suspendedRunId,
        sessionKey: this.state.sessionKey,
        sessionId: this.state.currentSessionId,
        lifecycleGeneration: this.state.transcript.activeTurn.lifecycleGeneration,
        frameSeq: null,
        state: 'aborted',
        replace: false,
        errorMessage: i18nService.t('coworkConnectionInterrupted'),
      };
      if (
        reduceChatEvent(this.state.transcript, event, this.transcriptDependencies) === 'applied'
      ) {
        this.handleAborted(event);
      }
      this.suspendedRunId = null;
    } catch (error) {
      debugLog('[ChatCtrl] suspended run status unavailable after reconnect', {
        runId: suspendedRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleEvent(event: GatewayEventFrame): void {
    if (event.event === 'chat') {
      const payload = normalizeChatEvent({ payload: event.payload, frameSeq: event.seq });
      if (payload) {
        this.ensureTranscriptSessionIdentity();
        if (
          payload.state === 'delta' &&
          this.assistantSnapshotRunId &&
          (!payload.runId || payload.runId === this.assistantSnapshotRunId)
        ) {
          this.ignoredDeltaAfterAssistantSnapshotCount += 1;
          if (this.ignoredDeltaAfterAssistantSnapshotCount === 1) {
            debugLog('[ChatCtrl] chat.delta ignored after canonical assistant snapshot', {
              runId: payload.runId ?? null,
              assistantSnapshotRunId: this.assistantSnapshotRunId,
            });
          }
          return;
        }
        const matchesSelectedSession =
          normalizeTranscriptSessionKey(payload.sessionKey) ===
          normalizeTranscriptSessionKey(this.state.sessionKey);
        if (
          matchesSelectedSession &&
          !this.state.transcript.activeTurn &&
          this.state.chatSending &&
          this.state.chatRunId &&
          (!payload.runId || payload.runId === this.state.chatRunId)
        ) {
          beginAssistantTurn(
            this.state.transcript,
            {
              runId: payload.runId ?? this.state.chatRunId,
              sessionId: payload.sessionId,
              lifecycleGeneration: payload.lifecycleGeneration,
            },
            this.transcriptDependencies,
          );
        }
        const reduceResult = reduceChatEvent(
          this.state.transcript,
          payload,
          this.transcriptDependencies,
        );
        const externalFinal =
          reduceResult === 'ignored-run' &&
          payload.state === 'final' &&
          this.state.transcript.activeTurn === null &&
          this.state.chatRunId === null &&
          normalizeTranscriptSessionKey(payload.sessionKey) ===
            normalizeTranscriptSessionKey(this.state.sessionKey) &&
          (!payload.sessionId ||
            !this.state.currentSessionId ||
            payload.sessionId === this.state.currentSessionId);
        if (reduceResult === 'applied' || externalFinal) {
          this.handleChatEvent(payload);
        } else {
          debugLog('[ChatCtrl] chat event ignored by transcript reducer', {
            runId: payload.runId ?? null,
            state: payload.state,
            result: reduceResult,
          });
        }
      }
      return;
    }

    // Agent / session.tool events — handle tool streams AND assistant streaming
    if (event.event === 'agent' || event.event === 'session.tool') {
      this.ensureTranscriptSessionIdentity();
      const normalized = normalizeAgentEvent({
        deliveryEvent: event.event,
        payload: event.payload,
        frameSeq: event.seq,
      });
      if (!normalized.event) {
        debugLog('[ChatCtrl] Agent event rejected during normalization', {
          reason: normalized.reason,
          frameSeq: event.seq ?? null,
        });
        return;
      }
      if (
        normalized.event.stream === 'assistant' &&
        typeof normalized.event.data.text === 'string' &&
        isHiddenOrPendingControlReplyText(normalized.event.data.text)
      ) {
        debugLog('[ChatCtrl] hidden assistant snapshot ignored', {
          runId: normalized.event.runId,
          agentSeq: normalized.event.agentSeq,
        });
        return;
      }
      if (isDormantAnnounceControlEvent(normalized.event, this.state.transcript.activeTurn)) {
        debugLog('[ChatCtrl] dormant announce control event ignored', {
          runId: normalized.event.runId,
          agentSeq: normalized.event.agentSeq,
          stream: normalized.event.stream,
        });
        return;
      }
      const reduceResult = reduceAgentEvent(
        this.state.transcript,
        normalized.event,
        this.transcriptDependencies,
      );
      if (reduceResult === 'applied') {
        this.handleAgentEvent(normalized.event);
      } else {
        debugLog('[ChatCtrl] Agent event ignored by ordered reducer', {
          runId: normalized.event.runId.slice(0, 12),
          agentSeq: normalized.event.agentSeq,
          stream: normalized.event.stream,
          result: reduceResult,
        });
      }
      return;
    }

    // session.message — trigger history reload for the selected session.
    if (event.event === 'sessions.changed') {
      const payload = asRecord(event.payload);
      const eventSessionKey =
        typeof payload?.sessionKey === 'string' ? payload.sessionKey.trim() : '';
      if (
        !eventSessionKey ||
        normalizeTranscriptSessionKey(eventSessionKey) !==
          normalizeTranscriptSessionKey(this.state.sessionKey)
      ) {
        return;
      }
      const nextSessionId = normalizeSessionId(payload?.sessionId);
      const currentSessionId = this.state.currentSessionId ?? this.state.transcript.sessionId;
      if (nextSessionId && currentSessionId && nextSessionId !== currentSessionId) {
        resetChatTranscriptState(this.state.transcript, this.state.sessionKey, nextSessionId);
        this.state.currentSessionId = nextSessionId;
        this.state.chatRunId = null;
        this.state.chatSending = false;
        this.pendingHistoryReload = false;
        this.scheduleDeferredHistoryReload(this.state.sessionKey, 'session-identity-rotation');
      }
      return;
    }

    if (event.event === 'session.message') {
      const payload = asRecord(event.payload);
      const eventSessionKey =
        typeof payload?.sessionKey === 'string' ? payload.sessionKey.trim() : '';
      if (
        eventSessionKey &&
        normalizeTranscriptSessionKey(eventSessionKey) !==
          normalizeTranscriptSessionKey(this.state.sessionKey)
      ) {
        return;
      }
      if (this.state.chatSending || this.pendingHistoryReload) {
        debugLog('[ChatCtrl] session.message DEFERRED:', this.state.sessionKey, {
          eventKeys: Object.keys((event.payload as Record<string, unknown> | undefined) ?? {}),
          chatSending: this.state.chatSending,
          pendingReload: this.pendingHistoryReload,
          ...this._snap(),
        });
        this.pendingHistoryReload = true;
      } else {
        debugLog('[ChatCtrl] session.message → loadHistory:', this.state.sessionKey, {
          eventKeys: Object.keys((event.payload as Record<string, unknown> | undefined) ?? {}),
          ...this._snap(),
        });
        this.scheduleDeferredHistoryReload(this.state.sessionKey, 'session-message');
      }
      return;
    }

    if (event.event === 'session.operation') {
      const payload = asRecord(event.payload);
      if (payload?.operation !== 'compact') {
        return;
      }
      const eventSessionKey =
        typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
      const sessionKey = eventSessionKey || this.state.sessionKey;
      if (
        sessionKey !== this.state.sessionKey &&
        !this.localCompactionStatusBySession.has(sessionKey)
      ) {
        return;
      }
      const phase = typeof payload.phase === 'string' ? payload.phase : '';
      this.handleCompactionPhase(phase, sessionKey);
    }
  }

  private pendingHistoryReload = false;
  private historyLoadsInFlight = new Set<string>();
  private historyReloadRequested = new Set<string>();

  private async readTranscriptImageDataUrl(mediaPath: string): Promise<string | null> {
    const cached = this.transcriptImageCache.get(mediaPath);
    if (cached) return cached;

    const pending = (async () => {
      if (this.transcriptImageReadsActive >= 4) {
        await new Promise<void>(resolve => this.transcriptImageReadWaiters.push(resolve));
      }
      this.transcriptImageReadsActive += 1;
      try {
        const dialog = (
          window as unknown as {
            electron?: {
              dialog?: {
                readFileAsDataUrl?: (
                  path: string,
                ) => Promise<{ success: boolean; dataUrl?: string }>;
              };
            };
          }
        ).electron?.dialog;
        const result = await dialog?.readFileAsDataUrl?.(mediaPath);
        return result?.success && result.dataUrl ? result.dataUrl : null;
      } catch (error) {
        console.warn('[ChatCtrl] Failed to load transcript image', error);
        return null;
      } finally {
        this.transcriptImageReadsActive -= 1;
        this.transcriptImageReadWaiters.shift()?.();
      }
    })();

    this.transcriptImageCache.set(mediaPath, pending);
    void pending.then(value => {
      if (value === null && this.transcriptImageCache.get(mediaPath) === pending) {
        this.transcriptImageCache.delete(mediaPath);
      }
    });
    if (this.transcriptImageCache.size > 64) {
      const oldestPath = this.transcriptImageCache.keys().next().value;
      if (typeof oldestPath === 'string') this.transcriptImageCache.delete(oldestPath);
    }
    return pending;
  }

  private async resolveManagedHistoryImages(messages: unknown[]): Promise<unknown[]> {
    return Promise.all(
      messages.map(async message => {
        const record = message as Record<string, unknown>;
        const originalContent = Array.isArray(record.content)
          ? record.content
          : typeof record.content === 'string'
            ? [{ type: 'text', text: record.content }]
            : [];
        const content = await Promise.all(
          originalContent.map(async value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
            const block = value as Record<string, unknown>;
            const source = typeof block.url === 'string' ? block.url : '';
            if (block.type !== 'image' || !source.startsWith('/api/chat/media/outgoing/')) {
              return value;
            }
            try {
              const parts = source.split('/');
              const requesterSessionKey = parts[5] ? decodeURIComponent(parts[5]) : '';
              const headers = new Headers({ Accept: 'image/*' });
              if (this.gatewayToken) headers.set('Authorization', `Bearer ${this.gatewayToken}`);
              if (requesterSessionKey) {
                headers.set('x-openclaw-requester-session-key', requesterSessionKey);
              }
              const response = await fetch(`${this.gatewayHttpBase}${source}`, { headers });
              if (!response.ok) return value;
              const blob = await response.blob();
              if (!blob.type.startsWith('image/')) return value;
              const dataUrl = await blobToDataUrl(blob);
              return { ...block, url: dataUrl };
            } catch (error) {
              console.warn('[ChatCtrl] Failed to load managed outgoing image', error);
              return value;
            }
          }),
        );
        const transcriptImages = await Promise.all(
          getTranscriptMedia(record).map(async media => {
            if (!media.mimeType || !isImageMimeType(media.mimeType)) return null;
            try {
              const dataUrl = await this.readTranscriptImageDataUrl(media.path);
              if (!dataUrl) return null;
              return {
                type: 'image',
                url: dataUrl,
                alt: media.path.split(/[\\/]/).pop() || 'Image',
                mimeType: media.mimeType,
              };
            } catch (error) {
              console.warn('[ChatCtrl] Failed to load transcript image', error);
              return null;
            }
          }),
        );
        const imageBlocks = transcriptImages.filter(
          (value): value is NonNullable<typeof value> => value !== null,
        );
        const existingImageUrlCounts = new Map<string, number>();
        for (const url of content
          .map(getContentImageUrl)
          .filter((value): value is string => value !== null)) {
          existingImageUrlCounts.set(url, (existingImageUrlCounts.get(url) ?? 0) + 1);
        }
        const uniqueImageBlocks = imageBlocks.filter(block => {
          const existingCount = existingImageUrlCounts.get(block.url) ?? 0;
          if (existingCount > 0) {
            existingImageUrlCounts.set(block.url, existingCount - 1);
            return false;
          }
          return true;
        });
        if (uniqueImageBlocks.length === 0 && !Array.isArray(record.content)) return message;
        return { ...record, content: [...content, ...uniqueImageBlocks] };
      }),
    );
  }

  private async loadPagedHistoryFromIpc(
    sessionKey: string,
    cursor?: string,
  ): Promise<HistoryPage | null> {
    const getPagedHistory = getOpenClawHistoryBridge()?.getPagedHistory;
    if (!getPagedHistory) return null;

    const result = await getPagedHistory({ sessionKey, cursor, limit: HISTORY_PAGE_LIMIT });
    if (!result?.success || !Array.isArray(result.messages)) {
      const error = result?.error ?? 'unknown error';
      if (!isHistoryNotFoundError(error)) {
        debugLog('[ChatCtrl] paged IPC history unavailable', {
          sessionKey,
          error,
        });
      }
      return null;
    }
    debugLog('[ChatCtrl] paged IPC history done', {
      sessionKey,
      cursor: cursor ?? null,
      totalCount: result.messages.length,
      summary: summarizeHistoryForDebug(result.messages),
    });
    const nextCursor =
      result.hasMore === true && typeof result.nextCursor === 'string'
        ? result.nextCursor.trim() || null
        : null;
    return {
      messages: result.messages,
      hasMore: nextCursor !== null,
      nextCursor,
    };
  }

  private async loadPagedHistoryFromRest(
    sessionKey: string,
    cursor?: string,
  ): Promise<HistoryPage | null> {
    const ipcPage = await this.loadPagedHistoryFromIpc(sessionKey, cursor).catch(error => {
      debugLog('[ChatCtrl] paged IPC history request failed, trying REST', {
        sessionKey,
        cursor: cursor ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (ipcPage) return ipcPage;
    if (!this.gatewayHttpBase) {
      return null;
    }

    const headers = new Headers({ Accept: 'application/json' });
    if (this.gatewayToken) {
      headers.set('Authorization', `Bearer ${this.gatewayToken}`);
    }

    const params = new URLSearchParams({ limit: String(HISTORY_PAGE_LIMIT) });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(
      `${this.gatewayHttpBase}/sessions/${encodeURIComponent(sessionKey)}/history?${params}`,
      { headers },
    );
    if (!response.ok) {
      debugLog('[ChatCtrl] paged REST history non-ok', {
        sessionKey,
        status: response.status,
        cursor: cursor ?? null,
      });
      return null;
    }
    const body = (await response.json()) as {
      messages?: unknown[];
      hasMore?: boolean;
      nextCursor?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const nextCursor =
      body.hasMore && typeof body.nextCursor === 'string' ? body.nextCursor.trim() || null : null;
    debugLog('[ChatCtrl] paged REST history page', {
      sessionKey,
      cursor: cursor ?? null,
      totalCount: messages.length,
      nextCursor,
      summary: summarizeHistoryForDebug(messages),
    });
    return {
      messages,
      hasMore: nextCursor !== null,
      nextCursor,
    };
  }

  private async normalizeHistoryPage(messages: unknown[], sessionKey: string): Promise<unknown[]> {
    const projectedMessages = messages
      .map(stripAssistantSilentReplySuffix)
      .filter(message => !shouldHideMessage(message))
      .filter(message => !(message as Record<string, unknown>)?.__openclawStreamFallback);
    const messagesWithCompactionDetails = await this.enrichCompactionMarkers(
      projectedMessages,
      sessionKey,
    );
    const hydratedMessages = await hydrateMissingToolInputsFromLocalState(
      sessionKey,
      messagesWithCompactionDetails,
    );
    return hydratedMessages.map(message =>
      normalizeFailedRunMessage(message, sessionKey, this.state.lastError),
    );
  }

  async loadOlderHistory(): Promise<boolean> {
    const sessionKey = this.state.sessionKey;
    const initialCursor = this.state.historyNextCursor;
    if (!sessionKey || !initialCursor || this.state.historyLoadingOlder) return false;

    const historyGeneration = this.state.transcript.historyGeneration;
    const sessionId = this.state.transcript.sessionId;
    const seenCursors = new Set<string>();
    let cursor: string | null = initialCursor;
    let emptyPageCount = 0;
    this.state.historyLoadingOlder = true;
    this.notify();
    try {
      while (cursor && !seenCursors.has(cursor)) {
        seenCursors.add(cursor);
        const page = await this.loadPagedHistoryFromRest(sessionKey, cursor);
        if (
          !page ||
          this.state.sessionKey !== sessionKey ||
          this.state.transcript.historyGeneration !== historyGeneration ||
          this.state.transcript.sessionId !== sessionId
        ) {
          return false;
        }
        const normalized = await this.normalizeHistoryPage(page.messages, sessionKey);
        if (
          this.state.sessionKey !== sessionKey ||
          this.state.transcript.historyGeneration !== historyGeneration ||
          this.state.transcript.sessionId !== sessionId
        ) {
          return false;
        }
        const addedCount = this.currentMessageHistory.prepend(normalized);
        const changed = addedCount > 0;
        const repeatedCursor: boolean =
          page.nextCursor === cursor ||
          (page.nextCursor !== null && seenCursors.has(page.nextCursor));
        this.state.historyHasMore = page.hasMore && !repeatedCursor;
        this.state.historyNextCursor = this.state.historyHasMore ? page.nextCursor : null;
        if (!changed) {
          if (!this.state.historyHasMore || !this.state.historyNextCursor) {
            this.notify();
            return false;
          }
          cursor = this.state.historyNextCursor;
          emptyPageCount += 1;
          if (emptyPageCount >= MAX_EMPTY_HISTORY_PAGES_PER_BATCH) {
            this.scheduleOlderHistoryContinuation({
              sessionKey,
              sessionId,
              historyGeneration,
              cursor,
            });
            this.notify();
            return false;
          }
          continue;
        }

        this.state.loadedMessageCount = this.currentMessageHistory.length;
        const preservedWindow = {
          start: this.state.historyWindowStart + addedCount,
          end: this.state.historyWindowEnd + addedCount,
        };
        this.state.historyWindowStart = preservedWindow.start;
        this.state.historyWindowEnd = preservedWindow.end;
        this.applyHistoryWindow(
          shiftHistoryWindowOlder(preservedWindow, this.currentMessageHistory.length),
        );
        this.state.transcript.revision += 1;
        this.notify();
        return true;
      }
      this.state.historyHasMore = false;
      this.state.historyNextCursor = null;
      this.notify();
      return false;
    } catch (error) {
      debugLog('[ChatCtrl] older history page unavailable', {
        sessionKey,
        cursor,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (this.state.sessionKey === sessionKey) {
        this.state.historyLoadingOlder = false;
        this.notify();
      }
    }
  }

  // ─── History Loading ──────────────────────────────────────────────────

  async loadHistory(
    queueIfBusy = false,
    options: { preferStartup?: boolean; reconcileSuspended?: boolean } = {},
  ): Promise<boolean> {
    const client = this.state.client;
    if (!client || !this.state.connected) return false;

    const sessionKey = this.state.sessionKey;
    this.ensureTranscriptSessionIdentity();
    if (this.historyLoadsInFlight.has(sessionKey)) {
      if (queueIfBusy) this.historyReloadRequested.add(sessionKey);
      debugLog('[ChatCtrl] loadHistory SKIP busy', {
        sessionKey,
        queueIfBusy,
        queued: this.historyReloadRequested.has(sessionKey),
        inFlightSessions: [...this.historyLoadsInFlight],
        ...this._snap(),
      });
      return false;
    }
    const loadSeq = ++this.historyLoadSeq;
    let transcriptHistoryGeneration = this.state.transcript.historyGeneration;
    let requestedSessionId = this.state.transcript.sessionId;
    this.historyLoadsInFlight.add(sessionKey);
    const previousMessages = this.state.chatMessages;
    const previousHistoryHasMore = this.state.historyHasMore;
    const previousHistoryNextCursor = this.state.historyNextCursor;
    debugLog('[ChatCtrl] loadHistory START', {
      seq: loadSeq,
      sessionKey,
      chatSending: this.state.chatSending,
      pendingUserMsg: !!this.state.pendingUserMessage,
      chatRunId: this.state.chatRunId,
      previousSummary: summarizeHistoryForDebug(previousMessages),
      currentSummary: summarizeHistoryForDebug(this.state.chatMessages),
    });
    this.state.chatLoading = true;
    this.notify();

    try {
      // chat.startup includes metadata and agent list, but it is heavier than
      // chat.history. Use it only for initial connection/session switches;
      // ordinary post-run refreshes should stay read-only and lightweight.
      let result:
        | { messages?: unknown[]; sessionId?: string; sessionInfo?: { sessionId?: string } }
        | undefined;
      const primaryMethod = options.preferStartup ? 'chat.startup' : 'chat.history';
      const fallbackMethod = options.preferStartup ? 'chat.history' : 'chat.startup';
      try {
        result = await client.request(primaryMethod, { sessionKey, limit: HISTORY_LIMIT });
        debugLog('[ChatCtrl] loadHistory RPC OK', {
          seq: loadSeq,
          method: primaryMethod,
          sessionKey,
          rpcCount: Array.isArray(result?.messages) ? result.messages.length : null,
          rpcSessionId: result?.sessionId ?? null,
          rpcSummary: summarizeHistoryForDebug(result?.messages ?? []),
        });
      } catch (err: unknown) {
        if (isUnknownMethodError(err)) {
          result = await client.request(fallbackMethod, { sessionKey, limit: HISTORY_LIMIT });
          debugLog('[ChatCtrl] loadHistory RPC fallback OK', {
            seq: loadSeq,
            method: fallbackMethod,
            sessionKey,
            rpcCount: Array.isArray(result?.messages) ? result.messages.length : null,
            rpcSessionId: result?.sessionId ?? null,
            rpcSummary: summarizeHistoryForDebug(result?.messages ?? []),
          });
        } else {
          throw err;
        }
      }

      if (this.state.sessionKey !== sessionKey) {
        debugLog('[ChatCtrl] loadHistory ABORT session changed after RPC', {
          seq: loadSeq,
          requestedSessionKey: sessionKey,
          currentSessionKey: this.state.sessionKey,
        });
        return false;
      }

      const loadedSessionId = normalizeSessionId(
        result?.sessionInfo?.sessionId ?? result?.sessionId,
      );
      if (
        loadedSessionId &&
        this.state.transcript.sessionId &&
        loadedSessionId !== this.state.transcript.sessionId
      ) {
        resetChatTranscriptState(this.state.transcript, sessionKey, loadedSessionId);
        this.currentMessageHistory.reset();
        this.state.chatMessages = [];
        this.state.loadedMessageCount = 0;
        this.state.visibleChatMessages = [];
        this.state.historyWindowStart = 0;
        this.state.historyWindowEnd = 0;
        transcriptHistoryGeneration = this.state.transcript.historyGeneration;
        requestedSessionId = loadedSessionId;
      }
      const authoritativeSessionId = loadedSessionId ?? this.state.transcript.sessionId;
      requestedSessionId = authoritativeSessionId;
      this.state.currentSessionId = authoritativeSessionId;
      this.state.transcript.sessionId = authoritativeSessionId;
      const requestStillCurrent = (): boolean =>
        this.state.sessionKey === sessionKey &&
        this.state.transcript.historyGeneration === transcriptHistoryGeneration &&
        this.state.transcript.sessionId === requestedSessionId;

      const pagedHistory = await this.loadPagedHistoryFromRest(sessionKey).catch(error => {
        debugLog('[ChatCtrl] paged history unavailable, using RPC history', {
          seq: loadSeq,
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!requestStillCurrent()) {
        debugLog('[ChatCtrl] loadHistory ABORT identity changed during paged history', {
          seq: loadSeq,
          sessionKey,
        });
        return false;
      }
      const rawMessages = pagedHistory?.messages ?? result?.messages ?? [];
      debugLog('[ChatCtrl] loadHistory AFTER-AWAIT', {
        seq: loadSeq,
        sessionKey,
        source: pagedHistory ? 'paged' : 'rpc',
        rawMsgCount: rawMessages.length,
        rawSummary: summarizeHistoryForDebug(rawMessages),
        ...this._snap(),
      });
      // Remove stream-fallback messages — the real persisted message from the
      // gateway will replace them, preventing content duplication.
      const projectedMessages = rawMessages
        .map(stripAssistantSilentReplySuffix)
        .filter(m => !shouldHideMessage(m))
        .filter(m => !(m as Record<string, unknown>)?.__openclawStreamFallback);
      debugLog('[ChatCtrl] loadHistory PROJECTED', {
        seq: loadSeq,
        sessionKey,
        rawCount: rawMessages.length,
        projectedCount: projectedMessages.length,
        hiddenCount: rawMessages.length - projectedMessages.length,
        projectedSummary: summarizeHistoryForDebug(projectedMessages),
      });
      const messagesWithCompactionDetails = await this.enrichCompactionMarkers(
        projectedMessages,
        sessionKey,
      );
      const hydratedMessages = await hydrateMissingToolInputsFromLocalState(
        sessionKey,
        messagesWithCompactionDetails,
      );
      if (!requestStillCurrent()) {
        debugLog('[ChatCtrl] loadHistory ABORT identity changed during normalization', {
          seq: loadSeq,
          requestedSessionKey: sessionKey,
          currentSessionKey: this.state.sessionKey,
        });
        return false;
      }
      let messages = this.projectLocalCompactionStatus(
        sessionKey,
        hydratedMessages.map(message =>
          normalizeFailedRunMessage(message, sessionKey, this.state.lastError),
        ),
      );
      if (pagedHistory) {
        messages = mergeRefreshedHistoryWindow(previousMessages, messages);
      } else if (
        previousMessages.length > messages.length &&
        this.state.transcript.historySource === 'sqlite-fallback'
      ) {
        const mergedFallback = mergeRefreshedHistoryWindow(previousMessages, messages);
        if (mergedFallback.length < previousMessages.length) {
          debugLog('[ChatCtrl] limited RPC history cannot safely replace complete fallback', {
            seq: loadSeq,
            sessionKey,
            fallbackCount: previousMessages.length,
            rpcCount: messages.length,
          });
          this.state.chatLoading = false;
          this.notify();
          return false;
        }
        messages = mergedFallback;
      }
      debugLog('[ChatCtrl] loadHistory NORMALIZED', {
        seq: loadSeq,
        sessionKey,
        hydratedCount: hydratedMessages.length,
        normalizedSummary: summarizeHistoryForDebug(messages),
      });

      // Only clear pendingUserMessage if the user message is actually in the
      // loaded history.  For brand-new sessions the gateway may not have
      // persisted it yet — keep showing the optimistic bubble.
      let pendingUserMessageFoundIndex = -1;
      if (this.state.pendingUserMessage) {
        const p = this.state.pendingUserMessage;
        pendingUserMessageFoundIndex = messages.findIndex((message: unknown) =>
          isPendingUserMessageMatch(
            message as GatewayMessage,
            p as unknown as GatewayMessage,
          ),
        );
        if (pendingUserMessageFoundIndex >= 0) {
          if (Array.isArray(p.content)) {
            messages = messages.map((historyMessage, index) =>
              index === pendingUserMessageFoundIndex
                ? {
                    ...(historyMessage as Record<string, unknown>),
                    content: p.content,
                  }
                : historyMessage,
            );
          }
        }
      }

      const reconciliation = reconcileHistory(this.state.transcript, {
        request: {
          sessionKey,
          sessionId: requestedSessionId,
          historyGeneration: transcriptHistoryGeneration,
        },
        source: 'gateway',
        messages,
        requestStartMessages: previousMessages,
        currentMessages: this.state.chatMessages,
        activeRun: this.state.chatSending && !options.reconcileSuspended,
        isVisibleMessage: message => !shouldHideMessage(message),
      });
      if (!reconciliation.accepted) {
        debugLog('[ChatCtrl] loadHistory rejected by transcript reconciler', {
          seq: loadSeq,
          sessionKey,
          reason: reconciliation.reason,
          catchUp: reconciliation.catchUp,
          loadedSummary: summarizeHistoryForDebug(messages),
          previousSummary: summarizeHistoryForDebug(previousMessages),
          currentSummary: summarizeHistoryForDebug(this.state.chatMessages),
        });
        if (reconciliation.catchUp === 'deferred') {
          this.scheduleDeferredHistoryReload(
            sessionKey,
            reconciliation.reason ?? 'history-catch-up',
          );
        }
        this.state.chatLoading = false;
        this.notify();
        return false;
      }
      messages = reconciliation.messages;
      debugLog('[ChatCtrl] loadHistory APPLY', {
        seq: loadSeq,
        sessionKey,
        beforeSummary: summarizeHistoryForDebug(this.state.chatMessages),
        nextSummary: summarizeHistoryForDebug(messages),
        preservedOptimisticTailCount: reconciliation.preservedOptimisticTailCount,
        activeTurnTakeover: reconciliation.activeTurnTakeover,
      });
      this.state.chatLoading = false;
      this.state.historyHasMore = pagedHistory
        ? pagedHistory.hasMore
        : previousHistoryHasMore;
      this.state.historyNextCursor = this.state.historyHasMore
        ? (pagedHistory?.nextCursor ?? previousHistoryNextCursor)
        : null;
      if (this.state.pendingUserMessage && pendingUserMessageFoundIndex >= 0) {
        debugLog('[ChatCtrl] loadHistory OK — pendingUserMessage found in history, clearing', {
          seq: loadSeq,
          sessionKey,
          foundIndex: pendingUserMessageFoundIndex,
        });
        this.state.pendingUserMessage = null;
      }
      this.setCurrentSessionMessages(messages);
      const pendingCompaction = this.localCompactionStatusBySession.get(sessionKey);
      if (pendingCompaction?.message.__openclaw.phase === 'completed') {
        this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
      } else {
        this.deferredHistoryReloadAttempts.delete(sessionKey);
      }
      void this.resolveManagedHistoryImages(messages).then(resolvedMessages => {
        if (this.state.sessionKey !== sessionKey || this.state.chatMessages !== messages) return;
        this.setCurrentSessionMessages(resolvedMessages);
        this.notify();
      });
      this.notify();
      return true;
    } catch (err) {
      if (this.state.sessionKey !== sessionKey) return false;
      this.state.chatLoading = false;
      this.state.lastError = (err as Error).message;
      console.error('[ChatCtrl] loadHistory FAILED:', (err as Error).message);
      debugLog('[ChatCtrl] loadHistory FAILED', {
        seq: loadSeq,
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
        ...this._snap(),
      });
      if (
        this.localCompactionStatusBySession.get(sessionKey)?.message.__openclaw.phase ===
        'completed'
      ) {
        this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
      }
      this.notify();
      return false;
    } finally {
      this.historyLoadsInFlight.delete(sessionKey);
      if (this.historyReloadRequested.delete(sessionKey) && this.state.sessionKey === sessionKey) {
        debugLog('[ChatCtrl] loadHistory QUEUED reload starting', {
          seq: loadSeq,
          sessionKey,
          nextSeq: this.historyLoadSeq + 1,
        });
        this.scheduleDeferredHistoryReload(sessionKey, 'queued-history');
      } else {
        debugLog('[ChatCtrl] loadHistory FINISH', {
          seq: loadSeq,
          sessionKey,
          queued: this.historyReloadRequested.has(sessionKey),
          ...this._snap(),
        });
      }
    }
  }

  // ─── Chat Event Handling ──────────────────────────────────────────────

  private handleChatEvent(payload: NormalizedChatEvent): void {
    // Only handle events for our session
    if (payload.sessionKey !== this.state.sessionKey) return;
    if (!this.acceptRunId(payload.runId)) {
      debugLog('[ChatCtrl] chat event ignored (run mismatch)', {
        eventRunId: payload.runId ?? null,
        chatRunId: this.state.chatRunId,
        state: payload.state,
      });
      return;
    }

    switch (payload.state) {
      case 'delta':
        this.handleDelta(payload);
        break;
      case 'final':
        this.handleFinal(payload);
        break;
      case 'aborted':
        this.handleAborted(payload);
        break;
      case 'error':
        this.handleError(payload);
        break;
    }
  }

  private handleDelta(payload: NormalizedChatEvent): void {
    debugLog('[ChatCtrl] ▶ chat.delta admitted', {
      runId: payload.runId ?? null,
      textLen: payload.deltaText?.length ?? 0,
    });
    this.notifyStream();
  }

  private handleFinal(payload: NormalizedChatEvent): void {
    this.clearLifecycleEndFallback();
    const message = stripAssistantSilentReplySuffix(payload.message);
    const willAppend = message && !shouldHideMessage(message);
    const liveThinkingText = collectActiveThinkingText(this.state.transcript.activeTurn);
    debugLog('[ChatCtrl] ▶ chat.final', {
      hasMessage: !!message,
      willAppend,
      msgRole: (message as Record<string, unknown>)?.role,
      finalContentType: Array.isArray((message as Record<string, unknown>)?.content)
        ? 'array'
        : typeof (message as Record<string, unknown>)?.content,
      finalMessage: summarizeMessageForDebug(message),
      liveThinkingLen: liveThinkingText?.length ?? 0,
      ...this._snap(),
    });
    if (willAppend) {
      const terminalMessage = markOptimisticHistoryTail(
        liveThinkingText ? withThinkingContent(message, liveThinkingText) : message,
      );
      this.setCurrentSessionMessages(
        appendTerminalMessage(this.state.chatMessages, terminalMessage),
      );
      debugLog('[ChatCtrl] ▶ chat.final appended terminal', {
        terminalMessage: summarizeMessageForDebug(terminalMessage),
        afterSummary: summarizeHistoryForDebug(this.state.chatMessages),
      });
    }
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.suspendedRunId = null;
    this.terminalLifecycleSeen = false;
    this.resetAssistantSnapshotSource();
    if (willAppend) {
      // Match OpenClaw webchat: a renderable final message already reconciles
      // the visible turn. Replaying a deferred session.message reload here can
      // race with transcript persistence and briefly replace the final message
      // with stale history. A delayed guarded reload lets persisted history
      // catch up once the authoritative tail exists.
      this.pendingHistoryReload = false;
      this.schedulePostFinalHistoryReload(payload.sessionKey);
    } else {
      this.pendingHistoryReload = true;
      this.flushPendingHistoryReload();
    }
    debugLog('[ChatCtrl] ▶ chat.final (done)', this._snap());
    this.notify();
  }

  private handleAborted(payload: NormalizedChatEvent): void {
    this.clearLifecycleEndFallback();
    const message = payload.message;
    debugLog('[ChatCtrl] ▶ chat.aborted', { hasMessage: !!message, ...this._snap() });
    if (message && !shouldHideMessage(message)) {
      this.setCurrentSessionMessages([
        ...this.state.chatMessages,
        markOptimisticHistoryTail(message),
      ]);
    }
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.suspendedRunId = null;
    this.terminalLifecycleSeen = false;
    this.resetAssistantSnapshotSource();
    this.flushPendingHistoryReload();
    this.notify();
  }

  private handleError(payload: NormalizedChatEvent): void {
    this.clearLifecycleEndFallback();
    this.state.lastError = payload.errorMessage ?? 'Unknown error';
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.suspendedRunId = null;
    this.terminalLifecycleSeen = false;
    this.resetAssistantSnapshotSource();
    this.flushPendingHistoryReload();
    this.notify();
  }

  private flushPendingHistoryReload(): void {
    if (this.pendingHistoryReload) {
      debugLog('[ChatCtrl] flushPendingHistoryReload → loadHistory:', this.state.sessionKey, {
        ...this._snap(),
      });
      this.pendingHistoryReload = false;
      this.loadHistory();
    }
  }

  // ─── Agent Tool Events ─────────────────────────────────────────────────

  /** Apply controller effects after the canonical transcript admitted an Agent event. */
  private handleAgentEvent(payload: NormalizedAgentEvent): void {
    this.ensureTranscriptSessionIdentity();
    const sourceEvent = payload.deliveryEvent;
    const stream = payload.stream;
    const runId = payload.runId;
    const agentSeq = payload.agentSeq;
    const data = payload.data;

    const eventSession = payload.sessionKey ?? '';
    if (!this.acceptRunId(runId, Boolean(eventSession))) {
      debugLog('[ChatCtrl] ▶ event ignored (run mismatch)', {
        sourceEvent,
        stream,
        runId,
        chatRunId: this.state.chatRunId,
        eventSession,
      });
      return;
    }

    if (stream === 'thinking') {
      const wasSending = this.state.chatSending;
      if (!this.state.chatSending) {
        this.state.chatSending = true;
        this.state.chatRunId = runId;
      }
      debugLog('[ChatCtrl] ▶ thinking', {
        sourceEvent,
        runId,
        agentSeq,
        textLen: typeof data.text === 'string' ? data.text.length : 0,
        wasSending,
        ...this._snap(),
      });
      this.notifyStream();
      return;
    }

    if (stream === 'assistant') {
      const text = typeof data.text === 'string' ? data.text : null;
      if (!text) return;

      const wasSending = this.state.chatSending;
      if (!this.state.chatSending) {
        this.state.chatSending = true;
        this.state.chatRunId = runId;
      }

      this.assistantSnapshotRunId = runId ?? this.state.chatRunId;

      debugLog('[ChatCtrl] ▶ assistant', {
        sourceEvent,
        runId,
        agentSeq,
        wasSending,
        textLen: text.length,
        textTail: text.slice(-40),
        ...this._snap(),
      });
      this.notifyStream();
      return;
    }

    if (stream === 'item') {
      debugLog('[ChatCtrl] ▶ item → deferred history reload', {
        sourceEvent,
        runId,
        agentSeq,
        ...this._snap(),
      });
      this.scheduleDeferredHistoryReload(this.state.sessionKey, 'agent-item');
      return;
    }

    // ── Lifecycle events ─────────────────────────────────────────────────
    if (stream === 'lifecycle') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      debugLog('[ChatCtrl] lifecycle:', phase, this.state.sessionKey, {
        chatSending: this.state.chatSending,
        pendingReload: this.pendingHistoryReload,
      });
      if (phase === 'start') {
        this.terminalLifecycleSeen = false;
        this.clearLifecycleEndFallback();
        if (!this.state.chatSending) {
          this.state.chatSending = true;
        }
        if (runId && !this.state.chatRunId) {
          this.state.chatRunId = runId;
        }
        this.notifyStream();
      }
      if (phase === 'finishing') {
        // The gateway can emit lifecycle:finishing before the final chat event,
        // and sometimes before the last thinking/assistant deltas. Keep the
        // canonical active turn intact; chat.final or the fallback below will reconcile.
        if (runId && !this.state.chatRunId) {
          this.state.chatRunId = runId;
        }
        this.notifyStream();
      }
      if (phase === 'end') {
        this.terminalLifecycleSeen = true;
        // Do not retire the canonical active turn here. chat.final is the
        // authoritative terminal event; lifecycle:end may arrive while more
        // visible deltas are still in flight. Use a short fallback for older
        // gateways or interrupted streams that never send chat.final.
        if (this.state.chatSending && !this.state.compactionInFlight) {
          if (runId && !this.state.chatRunId) {
            this.state.chatRunId = runId;
          }
          this.scheduleChatLifecycleEndFallback();
        }
      }
      if (phase === 'error') {
        const errorMessage =
          typeof data.error === 'string' && data.error.trim() ? data.error.trim() : 'Unknown error';
        this.clearLifecycleEndFallback();
        this.state.lastError = errorMessage;
        persistFailedRun({
          sessionKey: this.state.sessionKey,
          runId,
          error: errorMessage,
          timestamp: Date.now(),
        });
        reduceChatEvent(
          this.state.transcript,
          {
            runId,
            sessionKey: this.state.sessionKey,
            sessionId: payload.sessionId,
            lifecycleGeneration: payload.lifecycleGeneration,
            frameSeq: payload.frameSeq,
            state: 'error',
            replace: false,
            errorMessage,
          },
          this.transcriptDependencies,
        );
        this.state.chatSending = false;
        this.state.compactionInFlight = false;
        this.clearLocalCompactionStatus(this.state.sessionKey);
        this.terminalLifecycleSeen = false;
        this.state.chatRunId = null;
        this.resetAssistantSnapshotSource();
        this.pendingHistoryReload = true;
        this.flushPendingHistoryReload();
        this.notify();
      }
      return;
    }

    if (stream === 'compaction') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      this.handleCompactionPhase(phase);
      return;
    }

    if (stream !== 'tool') return;

    const phase = typeof data.phase === 'string' ? data.phase : '';
    debugLog('[ChatCtrl] ▶ tool', {
      sourceEvent,
      runId,
      agentSeq,
      phase,
    });
    const hasPartialResult = data.partialResult !== undefined;
    const isNonTerminalToolEvent = isNonTerminalToolPhase(phase);
    const isTerminalToolEvent = !isNonTerminalToolEvent && isTerminalToolPhase(phase);
    this.notifyStream(hasPartialResult && !isTerminalToolEvent ? 'tool-partial' : 'terminal');
  }

  // ─── Send Message ─────────────────────────────────────────────────────

  async sendMessage(message: string, attachments: CoworkAttachmentPayload[] = []): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');
    if (this.state.chatSending) return;

    const slashCommand = resolveSlashCommandBehavior(message);
    if (slashCommand?.execution === SlashCommandExecution.Local) {
      const handler = this.localSlashCommandHandlers.get(slashCommand.name);
      if (!handler) {
        throw new Error(`No local handler registered for /${slashCommand.name}`);
      }
      await handler(slashCommand.argumentsText);
      return;
    }

    const sessionKey = this.state.sessionKey;
    this.ensureTranscriptSessionIdentity();

    try {
      for (const hook of slashCommand?.beforeSend ?? []) {
        const handler = this.slashCommandBeforeSendHandlers.get(hook);
        if (!handler) throw new Error(`No slash command hook registered for ${hook}`);
        await handler(sessionKey);
        if (this.state.sessionKey !== sessionKey) return;
      }
    } catch (error) {
      if (this.state.sessionKey !== sessionKey) return;
      const sessionError = error instanceof Error ? error : new Error(String(error));
      this.state.lastError = sessionError.message;
      this.notify();
      throw sessionError;
    }

    const runId = `justdo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    debugLog('[ChatCtrl] sendMessage:', message.slice(0, 60), {
      sessionKey,
      runId,
    });
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.historyReloadRequested.delete(sessionKey);
    this.pendingHistoryReload = false;

    // Optimistic: append user message immediately
    const attachmentBlocks = toAttachmentContentBlocks(attachments);
    const userMessage = {
      role: 'user',
      content:
        attachmentBlocks.length > 0
          ? [{ type: 'text', text: message }, ...attachmentBlocks]
          : message,
      timestamp: Date.now(),
    };
    this.setCurrentSessionMessages([...this.state.chatMessages, userMessage]);
    beginAssistantTurn(
      this.state.transcript,
      {
        runId,
        sessionId: this.state.currentSessionId,
        startedAt: Date.now(),
      },
      this.transcriptDependencies,
    );
    this.state.chatSending = true;
    this.state.chatRunId = runId;
    this.resetAssistantSnapshotSource();
    this.state.lastError = null;
    this.notify();

    try {
      const gatewayAttachments = attachments
        .filter(attachment => attachment.base64Data)
        .map(toGatewayAttachment);
      const ack = await client.request<{ runId?: string; status?: string }>('chat.send', {
        sessionKey,
        ...(this.state.currentSessionId ? { sessionId: this.state.currentSessionId } : {}),
        message,
        deliver: false,
        idempotencyKey: runId,
        ...(gatewayAttachments.length > 0 ? { attachments: gatewayAttachments } : {}),
      });

      if (ack?.runId && this.state.sessionKey === sessionKey && this.state.chatRunId === runId) {
        this.state.chatRunId = ack.runId;
      }

      // If status is "ok", the run already completed
      const ackMatchesActiveRun =
        this.state.chatRunId === runId ||
        (typeof ack?.runId === 'string' && this.state.chatRunId === ack.runId);
      if (ack?.status === 'ok' && this.state.sessionKey === sessionKey && ackMatchesActiveRun) {
        reduceChatEvent(
          this.state.transcript,
          {
            runId: ack.runId ?? runId,
            sessionKey,
            sessionId: this.state.currentSessionId,
            lifecycleGeneration: null,
            frameSeq: null,
            state: 'final',
            replace: false,
          },
          this.transcriptDependencies,
        );
        this.state.chatSending = false;
        this.state.chatRunId = null;
        this.resetAssistantSnapshotSource();
        this.notify();
      }
    } catch (err) {
      if (this.state.sessionKey !== sessionKey || this.state.chatRunId !== runId) return;
      reduceChatEvent(
        this.state.transcript,
        {
          runId,
          sessionKey,
          sessionId: this.state.currentSessionId,
          lifecycleGeneration: null,
          frameSeq: null,
          state: 'error',
          replace: false,
          errorMessage: (err as Error).message,
        },
        this.transcriptDependencies,
      );
      this.state.chatSending = false;
      this.state.chatRunId = null;
      this.resetAssistantSnapshotSource();
      this.state.lastError = (err as Error).message;
      // Add error as assistant message
      this.setCurrentSessionMessages([
        ...this.state.chatMessages,
        { role: 'assistant', content: `Error: ${(err as Error).message}`, timestamp: Date.now() },
      ]);
      this.notify();
    }
  }

  private async ensureSessionEntry(sessionKey: string): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');

    // Some Gateway commands persist state against an existing session entry.
    // sessions.create is idempotent, so it safely creates or reuses that entry.
    const created = await client.request<{
      sessionId?: string;
      entry?: { sessionId?: string };
    }>('sessions.create', { key: sessionKey });
    const sessionId = normalizeSessionId(created?.sessionId ?? created?.entry?.sessionId);
    if (!sessionId) throw new Error(i18nService.t('coworkGoalSessionCreateFailed'));
    if (this.state.sessionKey === sessionKey) this.state.currentSessionId = sessionId;
  }

  private async compactSession(_argumentsText = ''): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');
    const sessionKey = this.state.sessionKey;
    // OpenClaw v2026.6.11's sessions.compact RPC cannot carry custom instructions,
    // and its Control UI also ignores inline /compact arguments. Keep that behavior
    // intentionally for now. Re-check the RPC schema and upstream UI when upgrading
    // OpenClaw; if customInstructions becomes supported, forward _argumentsText here.
    const localStatus = this.beginLocalCompactionStatus(sessionKey, { forceNew: true });
    const statusId = localStatus.id;
    const markerFingerprintsBefore = localStatus.markerFingerprintsBefore;

    this.state.chatSending = true;
    this.state.compactionInFlight = true;
    this.state.lastError = null;
    this.notifyStream();
    this.notify();

    try {
      const result = await client.request<{
        compacted?: boolean;
        reason?: string;
        result?: { tokensBefore?: number; tokensAfter?: number };
      }>('sessions.compact', { key: sessionKey });
      const before = result?.result?.tokensBefore;
      const after = result?.result?.tokensAfter;
      if (result?.compacted) {
        this.completeLocalCompactionStatus(sessionKey, { before, after });
        if (this.state.sessionKey !== sessionKey) return;
        this.state.chatSending = false;
        this.state.compactionInFlight = false;
        this.notifyStream();
        this.notify();
        const historyLoaded = await this.loadHistory();
        if (this.state.sessionKey !== sessionKey) return;
        if (!historyLoaded) {
          this.localCompactionStatusBySession.delete(sessionKey);
          this.deferredHistoryReloadAttempts.delete(sessionKey);
          this.updateLocalCompactionMessage(sessionKey, statusId, null);
          this.notify();
          return;
        }
        let newMarkerIndex = -1;
        for (let index = this.state.chatMessages.length - 1; index >= 0; index--) {
          const message = this.state.chatMessages[index];
          if (!isCompactionMarker(message)) continue;
          const fingerprint = readCompactionMarkerFingerprint(message);
          if (fingerprint && !markerFingerprintsBefore.has(fingerprint)) {
            newMarkerIndex = index;
            break;
          }
        }
        if (newMarkerIndex < 0) {
          return;
        }
        this.setCurrentSessionMessages(
          this.state.chatMessages.map((message, index) => {
            if (index !== newMarkerIndex) return message;
            const record = message as Record<string, unknown>;
            const marker = record.__openclaw as Record<string, unknown>;
            return {
              ...record,
              __openclaw: {
                ...marker,
                tokensBefore: marker.tokensBefore ?? before,
                tokensAfter: marker.tokensAfter ?? after,
              },
            };
          }),
        );
        this.notify();
        return;
      }
      this.localCompactionStatusBySession.delete(sessionKey);
      this.deferredHistoryReloadAttempts.delete(sessionKey);
      const skippedMessage = {
        role: 'system',
        timestamp: localStatus.message.timestamp,
        __openclaw: {
          kind: 'compaction-skipped',
          reason: result?.reason,
        },
      };
      this.updateLocalCompactionMessage(sessionKey, statusId, skippedMessage);
      if (this.state.sessionKey !== sessionKey) return;
      this.state.chatSending = false;
      this.state.compactionInFlight = false;
      this.notifyStream();
      this.notify();
    } catch (err) {
      this.localCompactionStatusBySession.delete(sessionKey);
      this.deferredHistoryReloadAttempts.delete(sessionKey);
      const errorMessage = (err as Error).message;
      this.updateLocalCompactionMessage(sessionKey, statusId, {
        role: 'system',
        content: formatI18n('coworkCompactFailed', { error: errorMessage }),
        timestamp: localStatus.message.timestamp,
      });
      if (this.state.sessionKey !== sessionKey) return;
      this.state.chatSending = false;
      this.state.compactionInFlight = false;
      this.state.lastError = errorMessage;
      this.notifyStream();
      this.notify();
    }
  }

  private async loadCompactionCheckpoints(
    sessionKey = this.state.sessionKey,
  ): Promise<CompactionCheckpoint[]> {
    const client = this.state.client;
    if (!client) return [];
    try {
      const response = await client.request<{
        checkpoints?: CompactionCheckpoint[];
      }>('sessions.compaction.list', { key: sessionKey });
      return response?.checkpoints ?? [];
    } catch (err) {
      console.warn(
        '[ChatController] Failed to load compaction checkpoints',
        (err as Error).message,
      );
      return [];
    }
  }

  private async enrichCompactionMarkers(
    messages: unknown[],
    sessionKey = this.state.sessionKey,
  ): Promise<unknown[]> {
    const markerIndexes = messages.flatMap((message, index) =>
      isCompactionMarker(message) ? [index] : [],
    );
    if (markerIndexes.length === 0) return messages;

    const checkpoints = await this.loadCompactionCheckpoints(sessionKey);
    if (checkpoints.length === 0) return messages;
    const checkpointsByTranscriptId = new Map<string, CompactionCheckpoint>();
    const checkpointsById = new Map<string, CompactionCheckpoint>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.checkpointId) checkpointsById.set(checkpoint.checkpointId, checkpoint);
      for (const id of [checkpoint.postCompaction?.entryId, checkpoint.postCompaction?.leafId]) {
        if (id) checkpointsByTranscriptId.set(id, checkpoint);
      }
    }
    const checkpointsNewestFirst = [...checkpoints].sort(
      (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
    );
    const checkpointByMarkerIndex = new Map<number, (typeof checkpoints)[number]>();
    const assignedCheckpointIds = new Set<string>();

    for (const markerIndex of markerIndexes) {
      const marker = (messages[markerIndex] as Record<string, unknown>).__openclaw as Record<
        string,
        unknown
      >;
      const markerId = typeof marker.id === 'string' ? marker.id : undefined;
      const exactCheckpoint = markerId
        ? (checkpointsByTranscriptId.get(markerId) ?? checkpointsById.get(markerId))
        : undefined;
      if (!exactCheckpoint) continue;
      checkpointByMarkerIndex.set(markerIndex, exactCheckpoint);
      if (exactCheckpoint.checkpointId) assignedCheckpointIds.add(exactCheckpoint.checkpointId);
    }

    // OpenClaw transcript markers carry the compaction-entry id, while the
    // checkpoint API exposes a separately generated checkpoint UUID. Align the
    // remaining records newest-to-newest so each historical marker receives at
    // most one checkpoint instead of reusing the latest checkpoint for all of them.
    const unmatchedMarkerIndexesNewestFirst = markerIndexes
      .filter(markerIndex => !checkpointByMarkerIndex.has(markerIndex))
      .reverse();
    const unassignedCheckpointsNewestFirst = checkpointsNewestFirst.filter(checkpoint => {
      const hasTranscriptPosition = Boolean(
        checkpoint.postCompaction?.entryId || checkpoint.postCompaction?.leafId,
      );
      return (
        !hasTranscriptPosition &&
        (!checkpoint.checkpointId || !assignedCheckpointIds.has(checkpoint.checkpointId))
      );
    });
    for (
      let index = 0;
      index <
      Math.min(unmatchedMarkerIndexesNewestFirst.length, unassignedCheckpointsNewestFirst.length);
      index++
    ) {
      checkpointByMarkerIndex.set(
        unmatchedMarkerIndexesNewestFirst[index],
        unassignedCheckpointsNewestFirst[index],
      );
    }

    return messages.map((message, index) => {
      if (!isCompactionMarker(message)) return message;
      const record = message as Record<string, unknown>;
      const marker = record.__openclaw as Record<string, unknown>;
      const checkpoint = checkpointByMarkerIndex.get(index);
      if (!checkpoint) return message;
      return {
        ...record,
        __openclaw: {
          ...marker,
          checkpointId: checkpoint.checkpointId,
          summary: checkpoint.summary,
          tokensBefore: checkpoint.tokensBefore,
          tokensAfter: checkpoint.tokensAfter,
        },
      };
    });
  }

  /** Abort the current run */
  async abort(): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected || !this.state.chatRunId) return;
    try {
      await client.request('chat.abort', {
        sessionKey: this.state.sessionKey,
        runId: this.state.chatRunId,
      });
    } catch {
      // Ignore abort errors
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatI18n(key: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    i18nService.t(key),
  );
}

function summarizeHistoryForDebug(messages: unknown[]): Record<string, unknown> {
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

function summarizeMessagesForDebug(messages: unknown[], count: number): unknown[] {
  return messages.slice(-count).map(message => summarizeMessageForDebug(message));
}

function summarizeMessageForDebug(message: unknown): Record<string, unknown> | null {
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

function contentTypesForDebug(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map(block => {
    const record = asRecord(block);
    return typeof record?.type === 'string' ? record.type : typeof block;
  });
}

function thinkingLengthForDebug(message: unknown): number {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    const record = asRecord(block);
    const thinking = typeof record?.thinking === 'string' ? record.thinking : '';
    const reasoning = typeof record?.reasoning === 'string' ? record.reasoning : '';
    return total + thinking.length + reasoning.length;
  }, 0);
}

function toolBlockCountForDebug(message: unknown): number {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter(block => {
    const type = asRecord(block)?.type;
    return type === 'toolcall' || type === 'toolresult';
  }).length;
}

function previewForDebug(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 80)} ... ${normalized.slice(-32)}`;
}

function hashTextForDebug(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isTempJustDoSessionKey(sessionKey: string): boolean {
  return /:justdo:temp-[^:]+$/.test(sessionKey);
}

function extractSnapshotText(message: unknown): string | null {
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

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return '';
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

function stripSilentReplySuffixFromText(text: string): string {
  if (SILENT_REPLY_PATTERN.test(text.trim())) return text;
  return text.replace(/\s*NO_REPLY\s*$/i, '').trimEnd();
}

function stripAssistantSilentReplySuffix(message: unknown): unknown {
  const record = asRecord(message);
  if (!record || String(record.role ?? '').toLowerCase() !== 'assistant') return message;

  if (typeof record.content === 'string') {
    const stripped = stripSilentReplySuffixFromText(record.content);
    return stripped === record.content ? message : { ...record, content: stripped };
  }

  if (typeof record.text === 'string') {
    const stripped = stripSilentReplySuffixFromText(record.text);
    return stripped === record.text ? message : { ...record, text: stripped };
  }

  const originalContent = record.content;
  if (!Array.isArray(originalContent)) return message;

  let changed = false;
  const content = originalContent.map((item, index) => {
    const block = asRecord(item);
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return item;
    if (index !== originalContent.length - 1) return item;
    const stripped = stripSilentReplySuffixFromText(block.text);
    if (stripped === block.text) return item;
    changed = true;
    return { ...block, text: stripped };
  });

  return changed ? { ...record, content } : message;
}

function collectActiveThinkingText(turn: AssistantTurn | null): string | null {
  const text = (turn?.items ?? [])
    .filter(item => item.type === 'thinking')
    .map(item => item.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function withThinkingContent(message: unknown, thinkingText: string): unknown {
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

function shouldHideMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  const role = typeof m.role === 'string' ? m.role.toLowerCase() : '';

  // Hide NO_REPLY assistant messages
  if (role === 'assistant') {
    const text = extractSnapshotText(message);
    if (text && isPersistedSilentReplyArtifactText(text)) return true;
  }

  // Hide heartbeat messages
  if (role === 'assistant') {
    const text = extractSnapshotText(message);
    if (text && text.includes('HEARTBEAT_OK')) return true;
  }

  return false;
}

function isPersistedSilentReplyArtifactText(text: string): boolean {
  const trimmed = text.trim();
  if (SILENT_REPLY_PATTERN.test(trimmed)) return true;
  const upper = trimmed.toUpperCase();
  return upper.startsWith('NO_') && 'NO_REPLY'.startsWith(upper);
}

function isCompactionMarker(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const marker = (message as Record<string, unknown>).__openclaw;
  return (
    Boolean(marker) &&
    typeof marker === 'object' &&
    (marker as Record<string, unknown>).kind === 'compaction'
  );
}

function readCompactionMarkerFingerprint(message: unknown): string | null {
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

function isLocalCompactionStatus(message: unknown, id: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const marker = (message as Record<string, unknown>).__openclaw;
  return (
    Boolean(marker) &&
    typeof marker === 'object' &&
    (marker as Record<string, unknown>).kind === 'compaction-status' &&
    (marker as Record<string, unknown>).id === id
  );
}

function isHiddenOrPendingControlReplyText(text: string): boolean {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  return (
    SILENT_REPLY_PATTERN.test(trimmed) ||
    (upper.length > 0 && 'NO_REPLY'.startsWith(upper)) ||
    trimmed.includes('HEARTBEAT_OK')
  );
}

function isDormantAnnounceControlEvent(
  event: NormalizedAgentEvent,
  activeTurn: AssistantTurn | null,
): boolean {
  if (!event.runId.startsWith('announce:v1:')) return false;
  if (activeTurn?.runId === event.runId) return false;
  return event.stream === 'lifecycle' || event.stream === 'thinking';
}

function appendTerminalMessage(messages: unknown[], terminal: unknown): unknown[] {
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

  const terminalDisplay = messageRoleAndText(terminal);
  const last = result[result.length - 1];
  const lastDisplay = messageRoleAndText(last);
  if (
    terminalDisplay &&
    lastDisplay &&
    terminalDisplay.role === lastDisplay.role &&
    hasSimilarDisplayText(terminalDisplay.text, lastDisplay.text)
  ) {
    return [...result.slice(0, -1), terminal];
  }

  result.push(terminal);
  return result;
}

function messageTimestampMs(message: unknown): number | null {
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

function messageDisplaySignature(message: unknown): string | null {
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

function messageRoleAndText(message: unknown): { role: string; text: string } | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : '';
  if (!role) return null;
  const text = extractSnapshotText(message)?.trim();
  return text ? { role, text } : null;
}

function normalizeComparableText(text: string): string {
  return stripSilentReplySuffixFromText(text).replace(/\s+/g, ' ').trim();
}

function hasSimilarDisplayText(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }
  const shorterLength = Math.min(normalizedLeft.length, normalizedRight.length);
  if (shorterLength < 60) return false;
  const commonPrefixLength = [...normalizedLeft].findIndex(
    (char, index) => normalizedRight[index] !== char,
  );
  const prefixLength =
    commonPrefixLength >= 0
      ? commonPrefixLength
      : Math.min(normalizedLeft.length, normalizedRight.length);
  return prefixLength / shorterLength >= 0.8 || prefixLength >= 160;
}

function isTerminalToolPhase(phase: string): boolean {
  return ['end', 'complete', 'completed', 'finish', 'finished', 'result', 'error'].includes(
    phase.toLowerCase(),
  );
}

function isNonTerminalToolPhase(phase: string): boolean {
  return ['delta', 'partial', 'progress', 'update', 'streaming'].includes(phase.toLowerCase());
}

function isUnknownMethodError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.message.includes('unknown method') ||
      (err as { gatewayCode?: string }).gatewayCode === 'METHOD_NOT_FOUND'
    );
  }
  return false;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Failed to read image')),
    );
    reader.readAsDataURL(blob);
  });
}

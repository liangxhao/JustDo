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
  readTerminalGuardObservation,
} from '@shared/openclaw/agentEvent';
import type {
  OpenClawPagedHistoryParams,
  OpenClawPagedHistoryResult,
} from '@shared/openclaw/historyIpc';
import { normalizeModelRef } from '@shared/openclaw/modelRef';
import { extractGoalFollowUpRequest } from '@shared/prompts/goalFollowUpPrompt';
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
import {
  confirmRecoveredToolSequence,
  hydrateToolPrecedingSegments,
  reduceAgentEvent,
  reduceChatEvent,
} from '@/libs/openclaw-chat/model/agent-event-reducer';
import {
  type AssistantTurn,
  type AssistantTurnTiming,
  beginAssistantTurn,
  bindAssistantTurnRunId,
  type ChatTranscriptState,
  createChatTranscriptState,
  type HistorySource,
  normalizeTranscriptSessionKey,
  resetChatTranscriptState,
  type ToolItem,
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
import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';
import {
  normalizeRunRetryReason,
  RUN_PROBE_INTERVAL_MS,
  RUN_STALL_NOTICE_MS,
  type RunActivity,
  type RunProgressStage,
} from '@/libs/openclaw-chat/model/run-activity';
import {
  hasToolResultPayload,
  isSessionsYieldTool,
} from '@/libs/openclaw-chat/model/tool-lifecycle';
import {
  asToolRecord,
  attachedToolMessages,
  isToolCallRecord,
  isToolResultType,
  readToolCallId,
  unwrapToolMessage,
} from '@/libs/openclaw-chat/model/tool-message-adapter';
import { readTranscriptIdentity } from '@/libs/openclaw-chat/model/transcript-identity';
import {
  hydrateGatewayHistoryForDisplay,
  persistFailedRun,
  persistInterruptedMessage,
  projectGatewayHistoryForDisplay,
  shouldHideMessage,
  stripAssistantSilentReplySuffix,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
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

export interface ChatControllerOptions {
  /** Subagent transcripts are expected to contain their originating user/task turn. */
  expectInitialHistory?: boolean;
  /** Maximum time to hold the first history snapshot behind message subscription setup. */
  initialMessageSubscriptionBarrierTimeoutMs?: number;
  /** Test seam and bounded persistence catch-up policy. */
  initialHistoryRetryDelaysMs?: readonly number[];
}

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
      summary?: string;
      tokensBefore?: number;
      tokensAfter?: number;
    };
  };
};

type SessionLiveState = Pick<
  ChatState,
  | 'currentSessionId'
  | 'chatSending'
  | 'compactionInFlight'
  | 'chatRunId'
  | 'lastError'
  | 'runActivity'
  | 'pendingUserMessage'
  | 'transcript'
> & {
  terminalLifecycleSeen: boolean;
  assistantSnapshotRunId: string | null;
  ignoredDeltaAfterAssistantSnapshotCount: number;
};

type SwitchSessionOptions = {
  promoteFromSessionKey?: string;
};

type OpenClawHistoryBridge = {
  getToolInputs?: (params: { sessionKey: string; toolCallIds: string[] }) => Promise<{
    success?: boolean;
    inputs?: Record<string, { name?: string; input?: unknown }>;
  }>;
  getCompactionDetails?: (params: { sessionKey: string; entryIds: string[] }) => Promise<{
    success?: boolean;
    details?: Record<string, { summary?: string; tokensBefore?: number; tokensAfter?: number }>;
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
const FULL_HISTORY_MESSAGE_MAX_CHARS = 1_000_000;
const OPENCLAW_HISTORY_TRUNCATION_MARKER = '...(truncated)...';
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const POST_FINAL_HISTORY_RELOAD_DELAY_MS = 1500;
const DEFERRED_HISTORY_RELOAD_DELAY_MS = 1200;
const ACTIVE_TOOL_HISTORY_CATCHUP_DELAY_MS = 150;
const MAX_DEFERRED_HISTORY_CATCHUP_ATTEMPTS = 5;
const MAX_ACTIVE_TOOL_HISTORY_CATCHUP_ATTEMPTS = 4;
const DEFAULT_INITIAL_MESSAGE_SUBSCRIPTION_BARRIER_TIMEOUT_MS = 3000;
const DEFAULT_INITIAL_HISTORY_RETRY_DELAYS_MS = [100, 300, 900] as const;
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

function isSubagentTaskHistoryMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (String(record?.role ?? '').toLowerCase() !== 'user') return false;
  const text = extractSnapshotText(message);
  return (
    typeof text === 'string' &&
    text.trimStart().startsWith('[Subagent Context] You are running as a subagent (depth ') &&
    /(?:^|\r?\n)\[Subagent Task\](?:\r?\n|$)/.test(text)
  );
}

function sliceActiveSubagentHistoryPrefix(messages: unknown[]): unknown[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(asRecord(messages[index])?.role ?? '').toLowerCase() === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(0, lastUserIndex + 1) : messages;
}

function hasOpenClawHistoryTruncationMarker(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  const hasMarker = (value: unknown): boolean =>
    typeof value === 'string' && value.trimEnd().endsWith(OPENCLAW_HISTORY_TRUNCATION_MARKER);
  if (
    [record.text, record.content, record.thinking, record.partialJson, record.arguments].some(
      hasMarker,
    )
  ) {
    return true;
  }
  if (Array.isArray(record.content)) {
    return record.content.some(block => {
      const item = asRecord(block);
      return (
        item !== null &&
        [item.text, item.content, item.thinking, item.partialJson, item.arguments].some(hasMarker)
      );
    });
  }
  return false;
}

function readOpenClawMessageId(message: unknown): string | null {
  const marker = asRecord(asRecord(message)?.__openclaw);
  return typeof marker?.id === 'string' && marker.id.trim() ? marker.id.trim() : null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function readOpenClawMessageSeq(message: unknown): number | null {
  const record = asRecord(message);
  const marker = asRecord(record?.__openclaw);
  return readPositiveSafeInteger(marker?.seq) ?? readPositiveSafeInteger(record?.seq);
}

function readLatestOpenClawMessageSeq(messages: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    const seq = readOpenClawMessageSeq(message);
    if (seq !== null && (latest === null || seq > latest)) latest = seq;
  }
  return latest;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const normalized = readNonBlankString(item);
    return normalized ? [normalized] : [];
  });
}

function readExplicitMessageRunId(value: unknown): string | undefined {
  const outer = asRecord(value);
  if (!outer) return undefined;
  const message = asRecord(outer.message) ?? outer;
  const messageMetadata = asRecord(message.metadata);
  const outerMetadata = asRecord(outer.metadata);
  for (const candidate of [
    message.runId,
    message.run_id,
    messageMetadata?.runId,
    messageMetadata?.run_id,
    outer.runId,
    outer.run_id,
    outerMetadata?.runId,
    outerMetadata?.run_id,
  ]) {
    const runId = readNonBlankString(candidate);
    if (runId) return runId;
  }
  return undefined;
}

function retainOriginalOpenClawIdentity(fullMessage: unknown, originalMessage: unknown): unknown {
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

function readNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
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
  private liveStateBySession = new Map<string, SessionLiveState>();
  private turnTimingBySession = new Map<string, AssistantTurnTiming>();
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
  private activeToolHistoryCatchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private olderHistoryContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredHistoryReloadAttempts = new Map<string, number>();
  private observedSessionMessageSeqBySession = new Map<
    string,
    {
      sessionId: string | null;
      seq: number | null;
      pendingCatchUp: boolean;
      catchUpTargetSeq: number | null;
      catchUpAttempts: number;
      unsequencedCatchUpCompleted: boolean;
    }
  >();
  private localCompactionStatusBySession = new Map<string, LocalCompactionStatus>();
  private assistantSnapshotRunId: string | null = null;
  private ignoredDeltaAfterAssistantSnapshotCount = 0;
  private pendingAnnounceEvents = new Map<string, NormalizedAgentEvent[]>();
  private historyLoadSeq = 0;
  private newerHistoryNavigationRevision = 0;
  private connectionInitializationSeq = 0;
  private subscribedMessageSessionKey: string | null = null;
  private messageSubscriptionSeq = 0;
  private suspendedRunId: string | null = null;
  private runActivityTimer: ReturnType<typeof setTimeout> | null = null;
  private runProbeToken: symbol | null = null;
  private terminalLifecycleSeen = false;
  private transcriptIdSequence = 0;
  private readonly expectInitialHistory: boolean;
  private readonly initialMessageSubscriptionBarrierTimeoutMs: number;
  private readonly initialHistoryRetryDelaysMs: readonly number[];
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
      initialHistoryReady: this.state.initialHistoryReady,
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

  constructor(options: ChatControllerOptions = {}) {
    this.expectInitialHistory = options.expectInitialHistory === true;
    this.initialMessageSubscriptionBarrierTimeoutMs = Math.max(
      0,
      options.initialMessageSubscriptionBarrierTimeoutMs ??
        DEFAULT_INITIAL_MESSAGE_SUBSCRIPTION_BARRIER_TIMEOUT_MS,
    );
    this.initialHistoryRetryDelaysMs =
      options.initialHistoryRetryDelaysMs ?? DEFAULT_INITIAL_HISTORY_RETRY_DELAYS_MS;
    this.state = {
      client: null,
      connected: false,
      transportStatus: 'disconnected',
      sessionKey: '',
      currentSessionId: null,
      initialHistoryReady: false,
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
      runActivity: null,
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
    this.beginRunActivity(`justdo-pending-${Date.now()}`);
    this.notify();
  }

  /** Clear sending state (e.g. when session start fails) */
  clearSending(): void {
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.state.pendingUserMessage = null;
    this.resetAssistantSnapshotSource();
    this.clearRunActivity();
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

  private beginRunActivity(runId: string, startedAt = Date.now()): void {
    this.clearRunActivityTimer();
    this.runProbeToken = null;
    this.state.runActivity = {
      runId,
      stage: 'starting',
      startedAt,
      stageChangedAt: startedAt,
      lastAgentEventAt: startedAt,
      lastModelActivityAt: null,
      hasRunningTool: false,
      activeRunConfirmedAt: null,
      probeState: 'idle',
    };
    this.scheduleRunActivityCheck();
  }

  private updateRunActivity(
    runId: string,
    stage: RunProgressStage,
    options: {
      modelActivity?: boolean;
      provider?: string;
      model?: string;
      retryReason?: unknown;
      at?: number;
    } = {},
  ): void {
    const at = options.at ?? Date.now();
    let activity = this.state.runActivity;
    if (!activity) {
      this.beginRunActivity(runId, at);
      activity = this.state.runActivity;
    }
    if (!activity) return;
    if (activity.runId !== runId) {
      if (!activity.runId.startsWith('justdo-')) return;
      activity.runId = runId;
    }
    if (activity.stage !== stage) {
      activity.stage = stage;
      activity.stageChangedAt = at;
    }
    activity.lastAgentEventAt = at;
    activity.hasRunningTool = [...(this.state.transcript.activeTurn?.toolById.values() ?? [])].some(
      tool => tool.status === 'running',
    );
    if (options.provider) activity.provider = options.provider;
    if (options.model) activity.model = options.model;
    const modelRef = normalizeModelRef(activity.model, activity.provider);
    const activeTurn = this.state.transcript.activeTurn;
    if (
      modelRef &&
      activeTurn &&
      (activeTurn.runId === activity.runId || activeTurn.runId.startsWith('justdo-'))
    ) {
      activeTurn.modelRef = modelRef;
    }
    if (options.retryReason !== undefined) {
      activity.retryReason = normalizeRunRetryReason(options.retryReason);
    } else if (stage !== 'retrying') {
      delete activity.retryReason;
    }
    if (options.modelActivity) {
      activity.lastModelActivityAt = at;
      activity.probeState = 'idle';
      activity.activeRunConfirmedAt = null;
      this.scheduleRunActivityCheck();
    }
  }

  private scheduleRunActivityCheck(delayMs?: number): void {
    this.clearRunActivityTimer();
    const activity = this.state.runActivity;
    if (!activity || !this.state.chatSending) return;
    const quietSince = activity.lastModelActivityAt ?? activity.startedAt;
    const delay =
      delayMs ?? Math.max(0, RUN_STALL_NOTICE_MS - Math.max(0, Date.now() - quietSince));
    this.runActivityTimer = setTimeout(() => {
      this.runActivityTimer = null;
      if (!this.state.runActivity || !this.state.chatSending) return;
      const runId = this.state.runActivity.runId;
      const sessionKey = this.state.sessionKey;
      this.notify();
      void this.probeActiveRun().finally(() => {
        if (
          this.state.runActivity?.runId === runId &&
          this.state.sessionKey === sessionKey &&
          this.state.chatSending &&
          !this.runActivityTimer
        ) {
          this.scheduleRunActivityCheck(RUN_PROBE_INTERVAL_MS);
        }
      });
    }, delay);
  }

  private async probeActiveRun(): Promise<void> {
    const activity = this.state.runActivity;
    const client = this.state.client;
    if (!activity || !client || !this.state.connected || this.runProbeToken) return;
    const runId = activity.runId;
    const sessionKey = this.state.sessionKey;
    const modelActivityAt = activity.lastModelActivityAt;
    const probeToken = Symbol('run-probe');
    this.runProbeToken = probeToken;
    activity.probeState = 'checking';
    this.notify();
    try {
      const result = await client.request<{ session?: Record<string, unknown> | null }>(
        'sessions.describe',
        { key: sessionKey },
      );
      const current = this.state.runActivity;
      if (
        !current ||
        current.runId !== runId ||
        this.state.sessionKey !== sessionKey ||
        current.lastModelActivityAt !== modelActivityAt
      ) {
        return;
      }
      const session = result?.session;
      const active = session?.hasActiveRun === true;
      current.probeState = active ? 'active' : 'idle';
      current.activeRunConfirmedAt = active ? Date.now() : null;
      this.notify();
    } catch {
      const current = this.state.runActivity;
      if (
        !current ||
        current.runId !== runId ||
        this.state.sessionKey !== sessionKey ||
        current.lastModelActivityAt !== modelActivityAt
      ) {
        return;
      }
      current.probeState = 'failed';
      current.activeRunConfirmedAt = null;
      this.notify();
    } finally {
      if (this.runProbeToken === probeToken) this.runProbeToken = null;
    }
  }

  private clearRunActivityTimer(): void {
    if (!this.runActivityTimer) return;
    clearTimeout(this.runActivityTimer);
    this.runActivityTimer = null;
  }

  private clearRunActivity(): void {
    this.clearRunActivityTimer();
    this.runProbeToken = null;
    this.state.runActivity = null;
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

  private findLiveSessionState(
    sessionKey: string | null | undefined,
    sessionId?: string | null,
  ): [string, SessionLiveState] | null {
    if (sessionKey) {
      const exact = this.liveStateBySession.get(sessionKey);
      if (exact) return [sessionKey, exact];
      const normalized = normalizeTranscriptSessionKey(sessionKey);
      for (const entry of this.liveStateBySession) {
        if (normalizeTranscriptSessionKey(entry[0]) === normalized) return entry;
      }
    }
    if (sessionId) {
      for (const entry of this.liveStateBySession) {
        if (
          entry[1].currentSessionId === sessionId ||
          entry[1].transcript.sessionId === sessionId
        ) {
          return entry;
        }
      }
    }
    return null;
  }

  private cacheCurrentLiveState(sessionKey: string): void {
    if (!sessionKey) return;
    this.clearRunActivityTimer();
    this.runProbeToken = null;
    this.cacheCurrentTurnTiming();
    this.state.transcript.historyGeneration += 1;
    this.state.transcript.revision += 1;
    const hasUnsettledTurn =
      this.state.chatSending ||
      this.state.pendingUserMessage !== null ||
      this.state.transcript.activeTurn?.status === 'running';
    if (!hasUnsettledTurn && this.state.transcript.activeTurn) {
      this.state.transcript.activeTurn = null;
      this.state.transcript.revision += 1;
    }
    this.liveStateBySession.delete(sessionKey);
    this.liveStateBySession.set(sessionKey, {
      currentSessionId: this.state.currentSessionId,
      chatSending: this.state.chatSending,
      compactionInFlight: this.state.compactionInFlight,
      chatRunId: this.state.chatRunId,
      lastError: this.state.lastError,
      runActivity: this.state.runActivity,
      pendingUserMessage: this.state.pendingUserMessage,
      transcript: this.state.transcript,
      terminalLifecycleSeen: this.terminalLifecycleSeen,
      assistantSnapshotRunId: this.assistantSnapshotRunId,
      ignoredDeltaAfterAssistantSnapshotCount: this.ignoredDeltaAfterAssistantSnapshotCount,
    });
    if (this.liveStateBySession.size > 20) {
      const oldestSettledKey = [...this.liveStateBySession].find(
        ([, live]) => !live.chatSending && live.transcript.activeTurn?.status !== 'running',
      )?.[0];
      if (oldestSettledKey) this.liveStateBySession.delete(oldestSettledKey);
    }
  }

  private restoreLiveState(sessionKey: string): boolean {
    const cachedEntry = this.findLiveSessionState(sessionKey);
    if (!cachedEntry) {
      this.state.currentSessionId = null;
      this.state.chatSending = false;
      this.state.compactionInFlight = false;
      this.state.chatRunId = null;
      this.state.lastError = null;
      this.state.runActivity = null;
      this.state.pendingUserMessage = null;
      this.state.transcript = createChatTranscriptState(sessionKey, null);
      this.terminalLifecycleSeen = false;
      this.resetAssistantSnapshotSource();
      return false;
    }

    const [cachedKey, cached] = cachedEntry;
    if (cachedKey !== sessionKey) {
      this.liveStateBySession.delete(cachedKey);
      this.liveStateBySession.set(sessionKey, cached);
    }
    cached.transcript.sessionKey = sessionKey;
    if (cached.transcript.activeTurn) cached.transcript.activeTurn.sessionKey = sessionKey;
    this.state.currentSessionId = cached.currentSessionId;
    this.state.chatSending = cached.chatSending;
    this.state.compactionInFlight = cached.compactionInFlight;
    this.state.chatRunId = cached.chatRunId;
    this.state.lastError = cached.lastError;
    this.state.runActivity = cached.runActivity;
    this.state.pendingUserMessage = cached.pendingUserMessage;
    this.state.transcript = cached.transcript;
    this.terminalLifecycleSeen = cached.terminalLifecycleSeen;
    this.assistantSnapshotRunId = cached.assistantSnapshotRunId;
    this.ignoredDeltaAfterAssistantSnapshotCount = cached.ignoredDeltaAfterAssistantSnapshotCount;
    if (this.state.chatSending && this.state.runActivity) this.scheduleRunActivityCheck();
    if (this.terminalLifecycleSeen && this.state.chatSending && !this.state.compactionInFlight) {
      this.scheduleChatLifecycleEndFallback();
    }
    return true;
  }

  private isSelectedSession(sessionKey: string): boolean {
    return (
      normalizeTranscriptSessionKey(sessionKey) ===
      normalizeTranscriptSessionKey(this.state.sessionKey)
    );
  }

  private promoteCachedSessionState(sourceSessionKey: string, targetSessionKey: string): void {
    const sourceHistory = this.chatMessagesBySession.get(sourceSessionKey);
    this.chatMessagesBySession.delete(sourceSessionKey);
    if (sourceHistory) this.chatMessagesBySession.set(targetSessionKey, sourceHistory);

    const sourceHistorySource = this.historySourceBySession.get(sourceSessionKey);
    this.historySourceBySession.delete(sourceSessionKey);
    if (sourceHistorySource) {
      this.historySourceBySession.set(targetSessionKey, sourceHistorySource);
    }

    const sourceLiveEntry = this.findLiveSessionState(sourceSessionKey);
    if (!sourceLiveEntry) return;
    const [sourceLiveKey, sourceLiveState] = sourceLiveEntry;
    this.liveStateBySession.delete(sourceLiveKey);
    sourceLiveState.currentSessionId = null;
    sourceLiveState.transcript.sessionKey = targetSessionKey;
    sourceLiveState.transcript.sessionId = null;
    sourceLiveState.transcript.historyGeneration += 1;
    if (sourceLiveState.transcript.activeTurn) {
      sourceLiveState.transcript.activeTurn.sessionKey = targetSessionKey;
      sourceLiveState.transcript.activeTurn.sessionId = null;
    }
    sourceLiveState.transcript.revision += 1;
    this.liveStateBySession.set(targetSessionKey, sourceLiveState);
  }

  private getSessionRunId(sessionKey: string): string | null {
    if (this.isSelectedSession(sessionKey)) return this.state.chatRunId;
    return this.findLiveSessionState(sessionKey)?.[1].chatRunId ?? null;
  }

  private bindAcknowledgedRun(
    sessionKey: string,
    provisionalRunId: string,
    acknowledgedRunId: string,
  ): void {
    if (this.isSelectedSession(sessionKey)) {
      if (this.state.chatRunId !== provisionalRunId) return;
      this.state.chatRunId = acknowledgedRunId;
      if (this.state.runActivity?.runId === provisionalRunId) {
        this.state.runActivity.runId = acknowledgedRunId;
      }
      bindAssistantTurnRunId(this.state.transcript, provisionalRunId, acknowledgedRunId);
      return;
    }

    const cached = this.findLiveSessionState(sessionKey)?.[1];
    if (!cached || cached.chatRunId !== provisionalRunId) return;
    cached.chatRunId = acknowledgedRunId;
    if (cached.runActivity?.runId === provisionalRunId) {
      cached.runActivity.runId = acknowledgedRunId;
    }
    bindAssistantTurnRunId(cached.transcript, provisionalRunId, acknowledgedRunId);
  }

  private settleChatSend(
    sessionKey: string,
    runId: string,
    state: 'final' | 'error',
    errorMessage?: string,
  ): void {
    const sessionId = this.isSelectedSession(sessionKey)
      ? this.state.currentSessionId
      : (this.findLiveSessionState(sessionKey)?.[1].currentSessionId ?? null);
    const terminalMessage =
      state === 'error'
        ? {
            role: 'assistant',
            content: `Error: ${errorMessage ?? 'Unknown error'}`,
            timestamp: Date.now(),
          }
        : undefined;
    const event: NormalizedChatEvent = {
      runId,
      sessionKey,
      sessionId,
      lifecycleGeneration: null,
      frameSeq: null,
      state,
      replace: false,
      ...(terminalMessage ? { message: terminalMessage } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };

    if (!this.isSelectedSession(sessionKey)) {
      this.applyBackgroundChatEvent(event);
      return;
    }
    if (reduceChatEvent(this.state.transcript, event, this.transcriptDependencies) !== 'applied') {
      return;
    }
    this.finishTurnTimingForSession(sessionKey, state, runId);
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.clearRunActivity();
    this.resetAssistantSnapshotSource();
    if (state === 'error') {
      this.state.lastError = errorMessage ?? 'Unknown error';
      this.setCurrentSessionMessages([...this.state.chatMessages, terminalMessage]);
    }
    this.notify();
  }

  private settleCompactionRequest(sessionKey: string, errorMessage?: string): void {
    if (this.isSelectedSession(sessionKey)) {
      this.state.chatSending = false;
      this.state.compactionInFlight = false;
      if (errorMessage) this.state.lastError = errorMessage;
      return;
    }
    const cached = this.findLiveSessionState(sessionKey)?.[1];
    if (!cached) return;
    cached.chatSending = false;
    cached.compactionInFlight = false;
    if (errorMessage) cached.lastError = errorMessage;
  }

  private cacheCurrentTurnTiming(): void {
    const turn = this.state.transcript.activeTurn;
    const sessionKey = turn?.sessionKey || this.state.transcript.sessionKey;
    if (!turn || !sessionKey) return;
    const existing = this.turnTimingBySession.get(sessionKey);
    const startedAt =
      existing?.runId === turn.runId
        ? Math.min(existing.startedAt, turn.startedAt)
        : turn.startedAt;
    this.turnTimingBySession.delete(sessionKey);
    this.turnTimingBySession.set(sessionKey, {
      runId: turn.runId,
      status: turn.status,
      startedAt,
      ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
      ...(turn.modelRef || (existing?.runId === turn.runId && existing.modelRef)
        ? { modelRef: turn.modelRef ?? existing?.modelRef }
        : {}),
    });
    if (this.turnTimingBySession.size > 20) {
      const oldestSettledKey = [...this.turnTimingBySession].find(
        ([, timing]) => timing.status !== 'running',
      )?.[0];
      if (oldestSettledKey) this.turnTimingBySession.delete(oldestSettledKey);
    }
  }

  private resetTranscriptForSession(
    sessionKey: string,
    sessionId: string | null,
    preserveTiming = true,
  ): void {
    this.pendingAnnounceEvents.clear();
    this.observedSessionMessageSeqBySession.delete(
      normalizeTranscriptSessionKey(this.state.transcript.sessionKey || sessionKey),
    );
    if (preserveTiming) {
      this.cacheCurrentTurnTiming();
    } else {
      this.turnTimingBySession.delete(this.state.transcript.sessionKey || sessionKey);
      this.turnTimingBySession.delete(sessionKey);
    }
    resetChatTranscriptState(this.state.transcript, sessionKey, sessionId);
  }

  private finishCurrentTurnTiming(
    status: Exclude<AssistantTurnTiming['status'], 'running'>,
    runId?: string | null,
  ): void {
    const activeTurn = this.state.transcript.activeTurn;
    if (activeTurn?.status !== 'running') this.cacheCurrentTurnTiming();
    this.finishTurnTimingForSession(this.state.sessionKey, status, runId, activeTurn?.endedAt);
  }

  private finishTurnTimingForSession(
    sessionKey: string,
    status: Exclude<AssistantTurnTiming['status'], 'running'>,
    runId?: string | null,
    endedAt = Date.now(),
  ): void {
    const timingKey = this.turnTimingBySession.has(sessionKey)
      ? sessionKey
      : [...this.turnTimingBySession.keys()].find(
          key => normalizeTranscriptSessionKey(key) === normalizeTranscriptSessionKey(sessionKey),
        );
    if (!timingKey) return;
    const cached = this.turnTimingBySession.get(timingKey);
    if (!cached || cached.status !== 'running') return;
    if (runId && cached.runId !== runId && !cached.runId.startsWith('justdo-')) return;
    this.turnTimingBySession.set(timingKey, {
      ...cached,
      status,
      endedAt,
    });
  }

  getCurrentTurnTiming(): AssistantTurnTiming | null {
    const activeTurn = this.state.transcript.activeTurn;
    const cached = this.turnTimingBySession.get(this.state.sessionKey);
    if (!activeTurn) {
      if (!cached || this.state.historyWindowEnd < this.state.loadedMessageCount) return null;
      const latestUserTimestamp = this.state.chatMessages.reduce<number | null>(
        (latest, message) => {
          const record = asRecord(message);
          if (String(record?.role ?? '').toLowerCase() !== 'user') return latest;
          const timestamp = messageTimestampMs(message);
          return timestamp === null || (latest !== null && timestamp <= latest)
            ? latest
            : timestamp;
        },
        null,
      );
      if (
        cached.status !== 'running' &&
        cached.endedAt !== undefined &&
        latestUserTimestamp !== null &&
        latestUserTimestamp > cached.endedAt
      ) {
        return null;
      }
      return cached;
    }

    const canResumeCachedStart = cached?.status === 'running' && cached.runId === activeTurn.runId;
    return {
      runId: activeTurn.runId,
      status: activeTurn.status,
      startedAt: canResumeCachedStart
        ? Math.min(cached.startedAt, activeTurn.startedAt)
        : activeTurn.startedAt,
      ...(activeTurn.endedAt !== undefined ? { endedAt: activeTurn.endedAt } : {}),
      ...(activeTurn.modelRef || (canResumeCachedStart && cached.modelRef)
        ? { modelRef: activeTurn.modelRef ?? cached?.modelRef }
        : {}),
    };
  }

  private setCurrentSessionMessages(
    messages: unknown[],
    options: { resetLoadedHistory?: boolean } = {},
  ): void {
    if (options.resetLoadedHistory) {
      this.currentMessageHistory.reset(messages);
      const nextWindow = latestHistoryWindow(messages.length);
      this.state.chatMessages = messages;
      this.state.loadedMessageCount = messages.length;
      this.state.historyWindowStart = nextWindow.start;
      this.state.historyWindowEnd = nextWindow.end;
      this.state.visibleChatMessages = this.currentMessageHistory.slice(
        nextWindow.start,
        nextWindow.end,
      );
      this.state.transcript.persistedMessages = messages;
      this.cacheSessionMessages(this.state.sessionKey);
      return;
    }
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

  /**
   * A live run owns the visible timeline, so history reconciliation correctly
   * refuses to replace it. The transcript can still repair that timeline by a
   * stable Tool call ID: hydrate known cards plus their preceding Thinking and
   * visible content, and restore a Tool whose Agent start frame was missed.
   */
  private hydrateActiveToolItemsFromHistory(
    messages: unknown[],
    options: {
      backfillMissingSessionsYield?: boolean;
      backfillMissingToolsFromAppend?: boolean;
    } = {},
  ): boolean {
    const activeTurn = this.state.transcript.activeTurn;
    if (!activeTurn) return false;

    const activeRunMessages = messages.filter(message => {
      const explicitRunId = readExplicitMessageRunId(message);
      return !explicitRunId || explicitRunId === activeTurn.runId;
    });
    const persistedTools = new Map<string, ToolItem>(
      projectPersistedTimeline(activeRunMessages as GatewayMessage[])
        .flatMap(item =>
          item.kind === 'process-summary'
            ? item.items.filter(process => process.type === 'tool')
            : item.kind === 'live-process' && item.item.type === 'tool'
              ? [item.item]
              : item.kind === 'plan-update'
                ? [item.item]
                : [],
        )
        .map(tool => [tool.toolCallId, tool] as const),
    );
    const authoritativeSegmentsByToolId = precedingSegmentsByToolCallId(activeRunMessages);
    const authoritativeToolResultIds = toolResultCallIds(activeRunMessages);
    let changed = false;
    for (const [toolCallId, persistedTool] of persistedTools) {
      let liveTool = activeTurn.toolById.get(toolCallId);
      if (!liveTool) {
        const timestampMatchesActiveTurn =
          persistedTool.startedAt > 0 && persistedTool.startedAt >= activeTurn.startedAt;
        const canBackfillMissingTool =
          options.backfillMissingToolsFromAppend === true ||
          (options.backfillMissingSessionsYield === true &&
            isSessionsYieldTool(persistedTool.name));
        if (
          !canBackfillMissingTool ||
          activeTurn.status !== 'running' ||
          !this.state.chatSending ||
          !timestampMatchesActiveTurn
        ) {
          continue;
        }
        const now = this.transcriptDependencies.now();
        const startedAt = persistedTool.startedAt > 0 ? persistedTool.startedAt : now;
        liveTool = {
          ...persistedTool,
          id: this.transcriptDependencies.createId('history-tool'),
          runId: activeTurn.runId,
          firstSeq: activeTurn.lastAgentSeq,
          lastSeq: activeTurn.lastAgentSeq,
          startedAt,
          updatedAt: Math.max(startedAt, persistedTool.updatedAt || now),
          agentSequencePending: true,
        };
        // A transcript append can beat the corresponding Thinking and Tool
        // Agent frames across their independent delivery paths. Every restored
        // Tool starts as a live-tail boundary, even when the first observed row
        // is already terminal; terminal evidence below releases it immediately.
        activeTurn.items.push(liveTool);
        activeTurn.toolById.set(toolCallId, liveTool);
        changed = true;
      }
      const authoritativeSegments = authoritativeSegmentsByToolId.get(toolCallId);
      if (authoritativeSegments) {
        changed =
          hydrateToolPrecedingSegments(
            activeTurn,
            liveTool,
            authoritativeSegments,
            activeTurn.lastAgentSeq,
            persistedTool.updatedAt || this.transcriptDependencies.now(),
            this.transcriptDependencies,
          ) || changed;
      }
      if (liveTool.input === undefined && persistedTool.input !== undefined) {
        liveTool.input = persistedTool.input;
        changed = true;
      }
      if (liveTool.output === undefined && persistedTool.output !== undefined) {
        liveTool.output = persistedTool.output;
        changed = true;
      }
      if (liveTool.error === undefined && persistedTool.error !== undefined) {
        liveTool.error = persistedTool.error;
        changed = true;
      }
      const canApplyPersistedTerminalStatus =
        persistedTool.status !== 'running' &&
        (!isSessionsYieldTool(liveTool.name) ||
          hasToolResultPayload(persistedTool) ||
          persistedTool.status !== 'completed');
      if (
        liveTool.agentSequencePending === true &&
        (authoritativeToolResultIds.has(toolCallId) || canApplyPersistedTerminalStatus)
      ) {
        changed =
          confirmRecoveredToolSequence(
            activeTurn,
            liveTool,
            activeTurn.lastAgentSeq,
            persistedTool.updatedAt || this.transcriptDependencies.now(),
          ) || changed;
      }
      if (liveTool.status === 'running' && canApplyPersistedTerminalStatus) {
        liveTool.status = persistedTool.status;
        changed = true;
      }
    }
    if (changed) this.state.transcript.revision += 1;
    return changed;
  }

  private publishActiveToolHistoryRepair(): void {
    const activeTurn = this.state.transcript.activeTurn;
    if (!activeTurn) return;
    const hasRunningTool = [...activeTurn.toolById.values()].some(
      tool => tool.status === 'running',
    );
    this.updateRunActivity(activeTurn.runId, hasRunningTool ? 'running-tool' : 'waiting-model');
    // Tool starts and terminal history rows must bypass streaming throttling
    // so the repaired card and its waiting status change appear together.
    this.notifyStream('terminal');
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
    return [
      ...messages.filter(message => !isLocalCompactionStatus(message, status.id)),
      status.message,
    ];
  }

  private beginLocalCompactionStatus(
    sessionKey: string,
    options: { forceNew?: boolean } = {},
  ): LocalCompactionStatus {
    const existing = this.localCompactionStatusBySession.get(sessionKey);
    if (existing?.message.__openclaw.phase === 'in-progress') return existing;
    if (existing?.completedAt && !options.forceNew && Date.now() - existing.completedAt < 5000) {
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

  private updateLocalCompactionSummary(
    sessionKey: string,
    status: LocalCompactionStatus,
    data: Record<string, unknown>,
  ): void {
    const currentSummary = status.message.__openclaw.summary ?? '';
    const accumulated =
      typeof data.text === 'string'
        ? data.text
        : typeof data.summary === 'string'
          ? data.summary
          : undefined;
    const delta = typeof data.delta === 'string' ? data.delta : '';
    const summary = accumulated ?? `${currentSummary}${delta}`;
    if (!summary || summary === currentSummary) return;
    status.message = {
      ...status.message,
      __openclaw: {
        ...status.message.__openclaw,
        summary,
      },
    };
    this.updateLocalCompactionMessage(sessionKey, status.id, status.message);
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
    this.newerHistoryNavigationRevision += 1;
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
    this.newerHistoryNavigationRevision += 1;
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
    const projectedMessages = projectGatewayHistoryForDisplay(messages);

    if (sessionKey !== this.state.sessionKey) {
      const existingSource = this.historySourceBySession.get(sessionKey) ?? 'optimistic';
      if (existingSource === 'gateway') return false;
      const existingHistory = this.chatMessagesBySession.get(sessionKey);
      const cachedLiveState = this.findLiveSessionState(sessionKey)?.[1];
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
        activeRun:
          cachedLiveState?.chatSending === true ||
          cachedLiveState?.transcript.activeTurn?.status === 'running',
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
      activeRun: this.state.chatSending || this.state.transcript.activeTurn?.status === 'running',
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
    this.resetTranscriptForSession(this.state.sessionKey, this.state.currentSessionId);
    this.state.transcript.persistedMessages = this.state.chatMessages;
  }

  private async syncMessageSessionSubscription(sessionKey: string): Promise<boolean> {
    const client = this.state.client;
    if (!client || !this.state.connected || !sessionKey) return false;

    const previousSessionKey = this.subscribedMessageSessionKey;
    if (previousSessionKey === sessionKey) return true;
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
      return false;
    }
    try {
      await client.request('sessions.messages.subscribe', { key: sessionKey });
      if (
        this.state.client === client &&
        this.state.connected &&
        subscriptionSeq === this.messageSubscriptionSeq
      ) {
        this.subscribedMessageSessionKey = sessionKey;
        return true;
      } else {
        // OpenClaw subscriptions are many-to-many. A stale subscribe can
        // succeed after a newer session transition, so undo it explicitly.
        await client.request('sessions.messages.unsubscribe', { key: sessionKey }).catch(() => {});
        return false;
      }
    } catch {
      if (subscriptionSeq === this.messageSubscriptionSeq) {
        this.subscribedMessageSessionKey = null;
      }
      return false;
    }
  }

  private isConnectionInitializationCurrent(params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  }): boolean {
    return (
      this.state.client === params.client &&
      this.state.connected &&
      this.state.sessionKey === params.sessionKey &&
      this.connectionInitializationSeq === params.initializationSeq
    );
  }

  private async waitForInitialHistoryRetry(
    delayMs: number,
    params: { client: GatewayClient; sessionKey: string; initializationSeq: number },
  ): Promise<boolean> {
    if (delayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    } else {
      await Promise.resolve();
    }
    return this.isConnectionInitializationCurrent(params);
  }

  private async loadInitialHistory(params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  }): Promise<void> {
    let initialHistoryError: string | null = null;
    try {
      const initialLoadSucceeded = await this.loadHistory(false, { preferStartup: true });
      if (!initialLoadSucceeded) initialHistoryError = this.state.lastError;
      if (this.hasExpectedInitialHistory()) return;

      for (const delayMs of this.initialHistoryRetryDelaysMs) {
        if (!(await this.waitForInitialHistoryRetry(delayMs, params))) return;
        const retrySucceeded = await this.loadHistory(false);
        if (retrySucceeded) {
          if (initialHistoryError !== null && this.state.lastError === initialHistoryError) {
            this.state.lastError = null;
          }
          initialHistoryError = null;
        } else {
          initialHistoryError = this.state.lastError;
        }
        if (this.hasExpectedInitialHistory()) return;
      }
    } finally {
      if (this.isConnectionInitializationCurrent(params)) {
        this.state.initialHistoryReady = true;
        this.notify();
      }
    }
  }

  private hasExpectedInitialHistory(): boolean {
    if (!this.expectInitialHistory) return true;
    return this.findSubagentTaskHistoryIndex(this.state.chatMessages) >= 0;
  }

  private findSubagentTaskHistoryIndex(messages: readonly unknown[]): number {
    return messages.findIndex(isSubagentTaskHistoryMessage);
  }

  private admitSubagentTaskMessage(message: unknown): boolean {
    if (
      !this.expectInitialHistory ||
      this.hasExpectedInitialHistory() ||
      !isSubagentTaskHistoryMessage(message)
    ) {
      return false;
    }
    const projected = projectGatewayHistoryForDisplay([message]);
    if (projected.length !== 1 || !isSubagentTaskHistoryMessage(projected[0])) return false;

    // session.message is emitted after OpenClaw appends the transcript row and
    // carries that authoritative row. Admit the task immediately instead of
    // waiting for a second history read, which can still observe an older
    // paged snapshot. Forked parent context and assistant-only in-flight tails
    // are intentionally excluded from the subagent's own visible timeline.
    this.state.transcript.historySource = 'gateway';
    this.pendingHistoryReload = true;
    this.setCurrentSessionMessages(projected, { resetLoadedHistory: true });
    this.state.lastError = null;
    this.notify();
    return true;
  }

  private async initializeConnectedSession(params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
    resumedTransport: boolean;
  }): Promise<void> {
    // Establish the durable notification edge before taking the snapshot. Any
    // write racing the snapshot then either appears in history or queues a
    // session.message catch-up reload.
    const subscription = this.syncMessageSessionSubscription(params.sessionKey);
    let barrierTimer: ReturnType<typeof setTimeout> | null = null;
    const barrierTimedOut = Symbol('message-subscription-barrier-timeout');
    const subscriptionResult = await Promise.race([
      subscription,
      new Promise<typeof barrierTimedOut>(resolve => {
        barrierTimer = setTimeout(
          () => resolve(barrierTimedOut),
          this.initialMessageSubscriptionBarrierTimeoutMs,
        );
      }),
    ]);
    if (barrierTimer !== null) clearTimeout(barrierTimer);
    if (subscriptionResult === barrierTimedOut) {
      // A local Gateway should normally acknowledge immediately. Do not leave
      // the drawer blank for the client's full RPC timeout if it does not;
      // once the late subscription succeeds, force a catch-up snapshot to
      // close the temporary notification gap.
      void subscription.then(subscribed => {
        if (subscribed && this.isConnectionInitializationCurrent(params)) {
          void this.loadHistory(true);
        }
      });
    }
    if (!this.isConnectionInitializationCurrent(params)) return;

    if (params.resumedTransport && this.suspendedRunId) {
      await this.reconcileSuspendedRun();
      if (!this.state.initialHistoryReady && this.isConnectionInitializationCurrent(params)) {
        this.state.initialHistoryReady = true;
        this.notify();
      }
      return;
    }
    await this.loadInitialHistory(params);
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
      this.finishCurrentTurnTiming('final', endingRunId);
      this.state.chatSending = false;
      this.state.chatRunId = null;
      this.clearRunActivity();
      this.terminalLifecycleSeen = false;
      this.flushPendingHistoryReload();
      this.notify();
    }, 1500);
    this.notifyStream();
  }

  private handleCompactionPhase(
    phase: string,
    sessionKey = this.state.sessionKey,
    data: Record<string, unknown> = {},
  ): void {
    const isCurrentSession = this.isSelectedSession(sessionKey);
    if (phase === 'start' || phase === 'update') {
      const status = this.beginLocalCompactionStatus(sessionKey);
      if (status.message.__openclaw.phase === 'completed') return;
      this.updateLocalCompactionSummary(sessionKey, status, data);
      if (!isCurrentSession) {
        const cached = this.findLiveSessionState(sessionKey)?.[1];
        if (cached) cached.compactionInFlight = true;
        return;
      }
      this.state.compactionInFlight = true;
      this.clearLifecycleEndFallback();
      this.notifyStream();
      this.notify();
      return;
    }
    if (phase === 'error' || phase === 'failed') {
      this.clearLocalCompactionStatus(sessionKey);
      if (!isCurrentSession) {
        const cached = this.findLiveSessionState(sessionKey)?.[1];
        if (cached) cached.compactionInFlight = false;
        return;
      }
      this.state.compactionInFlight = false;
      if (this.terminalLifecycleSeen) this.scheduleChatLifecycleEndFallback();
      this.notifyStream();
      this.notify();
      return;
    }
    if (phase !== 'end') return;
    const wasInProgress =
      this.localCompactionStatusBySession.get(sessionKey)?.message.__openclaw.phase ===
      'in-progress';
    const inProgressStatus = this.localCompactionStatusBySession.get(sessionKey);
    if (inProgressStatus) this.updateLocalCompactionSummary(sessionKey, inProgressStatus, data);
    const status = this.completeLocalCompactionStatus(sessionKey, {
      before: typeof data.tokensBefore === 'number' ? data.tokensBefore : undefined,
      after: typeof data.tokensAfter === 'number' ? data.tokensAfter : undefined,
    });
    if (!isCurrentSession) {
      const cached = this.findLiveSessionState(sessionKey)?.[1];
      if (cached) cached.compactionInFlight = false;
      return;
    }
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

  private clearActiveToolHistoryCatchUp(): void {
    if (!this.activeToolHistoryCatchUpTimer) return;
    clearTimeout(this.activeToolHistoryCatchUpTimer);
    this.activeToolHistoryCatchUpTimer = null;
  }

  private resetActiveToolHistoryCatchUpForRun(sessionKey: string): void {
    this.clearActiveToolHistoryCatchUp();
    const entry = this.observedSessionMessageSeqBySession.get(
      normalizeTranscriptSessionKey(sessionKey),
    );
    if (!entry) return;
    entry.pendingCatchUp = false;
    entry.catchUpTargetSeq = null;
    entry.catchUpAttempts = 0;
    entry.unsequencedCatchUpCompleted = false;
  }

  private observeSessionMessageSeq(
    sessionKey: string,
    sessionId: string | null,
    incomingSeq: number | null,
    loadedSeq: number | null,
  ): boolean {
    const normalizedSessionKey = normalizeTranscriptSessionKey(sessionKey);
    const stored = this.observedSessionMessageSeqBySession.get(normalizedSessionKey);
    const previousMatchesSession =
      !stored?.sessionId || !sessionId || stored.sessionId === sessionId;
    const previous = previousMatchesSession ? stored : undefined;
    const previousSeq = previous?.seq ?? null;
    const baselineSeq =
      previousSeq === null
        ? loadedSeq
        : loadedSeq === null
          ? previousSeq
          : Math.max(previousSeq, loadedSeq);
    const gapDetected =
      incomingSeq !== null && baselineSeq !== null && incomingSeq > baselineSeq + 1;
    const cursorWasUninitialized = incomingSeq !== null && baselineSeq === null;
    const needsUnsequencedFallback =
      incomingSeq === null &&
      baselineSeq === null &&
      previous?.unsequencedCatchUpCompleted !== true;
    const startsCatchUp = gapDetected || cursorWasUninitialized || needsUnsequencedFallback;
    const incomingAdvancesCursor =
      incomingSeq !== null && (previousSeq === null || incomingSeq > previousSeq);
    const nextSeq =
      incomingSeq === null
        ? baselineSeq
        : baselineSeq === null
          ? incomingSeq
          : Math.max(baselineSeq, incomingSeq);
    const previousTarget = previous?.catchUpTargetSeq ?? null;
    const catchUpTargetSeq =
      gapDetected || cursorWasUninitialized
        ? previousTarget === null
          ? incomingSeq
          : incomingSeq === null
            ? previousTarget
            : Math.max(previousTarget, incomingSeq)
        : previousTarget;
    const pendingCatchUp = previous?.pendingCatchUp === true || startsCatchUp;
    this.observedSessionMessageSeqBySession.set(normalizedSessionKey, {
      sessionId: sessionId ?? previous?.sessionId ?? null,
      seq: nextSeq,
      pendingCatchUp,
      catchUpTargetSeq,
      catchUpAttempts:
        startsCatchUp || (pendingCatchUp && incomingAdvancesCursor)
          ? 0
          : (previous?.catchUpAttempts ?? 0),
      unsequencedCatchUpCompleted: previous?.unsequencedCatchUpCompleted === true,
    });
    return pendingCatchUp;
  }

  private recordLoadedSessionMessageSeq(
    sessionKey: string,
    sessionId: string | null,
    loadedSeq: number | null,
    resolvePendingCatchUp: boolean,
  ): void {
    const normalizedSessionKey = normalizeTranscriptSessionKey(sessionKey);
    const stored = this.observedSessionMessageSeqBySession.get(normalizedSessionKey);
    const storedMatchesSession = !stored?.sessionId || !sessionId || stored.sessionId === sessionId;
    const previous = storedMatchesSession ? stored : undefined;
    const nextSeq =
      previous?.seq === null || previous?.seq === undefined
        ? loadedSeq
        : loadedSeq === null
          ? previous.seq
          : Math.max(previous.seq, loadedSeq);
    const targetSatisfied =
      resolvePendingCatchUp &&
      previous?.pendingCatchUp === true &&
      (previous.catchUpTargetSeq === null ||
        (loadedSeq !== null && loadedSeq >= previous.catchUpTargetSeq));
    if (!previous && nextSeq === null) return;
    this.observedSessionMessageSeqBySession.set(normalizedSessionKey, {
      sessionId: sessionId ?? previous?.sessionId ?? null,
      seq: nextSeq,
      pendingCatchUp: targetSatisfied ? false : (previous?.pendingCatchUp ?? false),
      catchUpTargetSeq: targetSatisfied ? null : (previous?.catchUpTargetSeq ?? null),
      catchUpAttempts: targetSatisfied ? 0 : (previous?.catchUpAttempts ?? 0),
      unsequencedCatchUpCompleted:
        previous?.unsequencedCatchUpCompleted === true ||
        (targetSatisfied && previous?.catchUpTargetSeq === null),
    });
  }

  private claimActiveToolHistoryCatchUp(sessionKey: string, sessionId: string | null): boolean {
    const entry = this.observedSessionMessageSeqBySession.get(
      normalizeTranscriptSessionKey(sessionKey),
    );
    if (
      !entry?.pendingCatchUp ||
      (entry.sessionId && sessionId && entry.sessionId !== sessionId) ||
      entry.catchUpAttempts >= MAX_ACTIVE_TOOL_HISTORY_CATCHUP_ATTEMPTS
    ) {
      return false;
    }
    entry.catchUpAttempts += 1;
    return true;
  }

  private hasPendingActiveToolHistoryCatchUp(
    sessionKey: string,
    sessionId: string | null,
  ): boolean {
    const entry = this.observedSessionMessageSeqBySession.get(
      normalizeTranscriptSessionKey(sessionKey),
    );
    return Boolean(
      entry?.pendingCatchUp &&
      (!entry.sessionId || !sessionId || entry.sessionId === sessionId) &&
      entry.catchUpAttempts < MAX_ACTIVE_TOOL_HISTORY_CATCHUP_ATTEMPTS,
    );
  }

  private scheduleActiveToolHistoryCatchUp(sessionKey: string, runId: string): void {
    if (this.activeToolHistoryCatchUpTimer) return;
    this.activeToolHistoryCatchUpTimer = setTimeout(() => {
      this.activeToolHistoryCatchUpTimer = null;
      const activeTurn = this.state.transcript.activeTurn;
      if (
        this.state.sessionKey !== sessionKey ||
        !this.state.connected ||
        !this.state.chatSending ||
        activeTurn?.status !== 'running' ||
        activeTurn.runId !== runId
      ) {
        return;
      }
      if (this.historyLoadsInFlight.has(sessionKey)) {
        this.scheduleActiveToolHistoryCatchUp(sessionKey, runId);
        return;
      }
      const sessionId = this.state.currentSessionId ?? this.state.transcript.sessionId;
      if (!this.claimActiveToolHistoryCatchUp(sessionKey, sessionId)) return;
      void this.loadHistory(false, { backfillActiveSessionsYield: true }).finally(() => {
        if (this.hasPendingActiveToolHistoryCatchUp(sessionKey, sessionId)) {
          this.scheduleActiveToolHistoryCatchUp(sessionKey, runId);
        }
      });
    }, ACTIVE_TOOL_HISTORY_CATCHUP_DELAY_MS);
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
      // A subagent's originating task can be persisted after its live stream
      // has already started. Admit that missing history prefix without waiting
      // for the whole run to finish; ordinary active-run refreshes stay gated.
      const canCatchUpMissingInitialHistory = !this.hasExpectedInitialHistory();
      if (
        (this.state.chatSending && !canCatchUpMissingInitialHistory) ||
        this.historyLoadsInFlight.has(sessionKey)
      ) {
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
    this.connectionInitializationSeq += 1;
    this.subscribedMessageSessionKey = null;
    this.clearOlderHistoryContinuation();

    this.state.sessionKey = sessionKey;
    this.state.currentSessionId = null;
    this.state.initialHistoryReady = false;
    this.state.historyLoadingOlder = false;
    this.state.historyHasMore = false;
    this.state.historyNextCursor = null;
    this.resetTranscriptForSession(sessionKey, null);
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
    if (this.state.chatSending && this.state.pendingUserMessage) {
      this.beginRunActivity(`justdo-pending-${Date.now()}`);
    } else {
      this.clearRunActivity();
    }
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
  async switchSession(sessionKey: string, options: SwitchSessionOptions = {}): Promise<void> {
    const previousSessionKey = this.state.sessionKey;
    const promotionSource = options.promoteFromSessionKey?.trim() || null;
    const isTempSessionPromotion = Boolean(
      promotionSource &&
      isTempJustDoSessionKey(promotionSource) &&
      !isTempJustDoSessionKey(sessionKey),
    );
    debugLog('[ChatCtrl] switchSession:', sessionKey, {
      hadPendingUserMsg: !!this.state.pendingUserMessage,
      chatSending: this.state.chatSending,
      msgCount: this.state.chatMessages.length,
      previousSessionKey,
      promotionSource,
      isTempSessionPromotion,
    });
    this.clearLifecycleEndFallback();
    if (!isTempSessionPromotion || previousSessionKey !== promotionSource) {
      this.pendingAnnounceEvents.clear();
    }
    this.cacheCurrentLiveState(previousSessionKey);
    if (isTempSessionPromotion && promotionSource) {
      this.promoteCachedSessionState(promotionSource, sessionKey);
    }
    this.state.sessionKey = sessionKey;
    this.state.initialHistoryReady = false;
    this.state.historyLoadingOlder = false;
    this.state.historyHasMore = false;
    this.state.historyNextCursor = null;
    this.restoreLiveState(sessionKey);
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
    this.suspendedRunId = null;
    this.state.chatLoading = true;
    this.pendingHistoryReload = false;
    this.observedSessionMessageSeqBySession.clear();
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.clearActiveToolHistoryCatchUp();
    this.clearOlderHistoryContinuation();
    this.notify();

    const client = this.state.client;
    if (client && this.state.connected) {
      const initializationSeq = ++this.connectionInitializationSeq;
      await this.initializeConnectedSession({
        client,
        sessionKey,
        initializationSeq,
        resumedTransport: false,
      });
    }
  }

  /** Disconnect and clean up */
  disconnect(): void {
    this.clearLifecycleEndFallback();
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.clearActiveToolHistoryCatchUp();
    this.clearOlderHistoryContinuation();
    for (const sessionKey of [...this.localCompactionStatusBySession.keys()]) {
      this.clearLocalCompactionStatus(sessionKey);
    }
    this.state.client?.stop();
    this.state.client = null;
    this.state.connected = false;
    this.state.transportStatus = 'disconnected';
    this.state.chatSending = false;
    this.clearRunActivity();
    this.state.compactionInFlight = false;
    this.terminalLifecycleSeen = false;
    this.suspendedRunId = null;
    this.pendingAnnounceEvents.clear();
    this.observedSessionMessageSeqBySession.clear();
    this.connectionInitializationSeq += 1;
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
    const client = this.state.client;
    if (!client) return;
    const sessionKey = this.state.sessionKey;
    const initializationSeq = ++this.connectionInitializationSeq;
    void this.initializeConnectedSession({
      client,
      sessionKey,
      initializationSeq,
      resumedTransport,
    });
  }

  private handleClose(): void {
    const runInProgress =
      this.state.transcript.activeTurn?.status === 'running' ||
      (this.state.chatSending && this.state.runActivity !== null);
    this.suspendedRunId =
      this.state.transcript.activeTurn?.status === 'running'
        ? this.state.transcript.activeTurn.runId
        : null;
    this.state.connected = false;
    this.state.transportStatus =
      this.state.client && runInProgress ? 'reconnecting' : 'disconnected';
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
        this.clearRunActivity();
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

  private applyBackgroundChatEvent(payload: NormalizedChatEvent): void {
    const cachedEntry = this.findLiveSessionState(payload.sessionKey);
    if (!cachedEntry) {
      if (payload.state !== 'delta') {
        this.finishTurnTimingForSession(payload.sessionKey, payload.state, payload.runId);
      }
      return;
    }

    const [sessionKey, cached] = cachedEntry;
    if (
      payload.state === 'delta' &&
      cached.assistantSnapshotRunId &&
      (!payload.runId || payload.runId === cached.assistantSnapshotRunId)
    ) {
      cached.ignoredDeltaAfterAssistantSnapshotCount += 1;
      return;
    }
    const liveThinkingText = collectActiveThinkingText(cached.transcript.activeTurn);
    const liveContentText = collectActiveContentText(cached.transcript.activeTurn);
    const startedAt = cached.transcript.activeTurn?.startedAt ?? null;
    const reduceResult = reduceChatEvent(cached.transcript, payload, this.transcriptDependencies);
    if (reduceResult !== 'applied') return;
    if (payload.state === 'delta') return;

    this.finishTurnTimingForSession(sessionKey, payload.state, payload.runId);
    let terminalMessage =
      payload.state === 'final'
        ? stripAssistantSilentReplySuffix(payload.message)
        : payload.message;
    if (payload.state === 'aborted' && !terminalMessage) {
      terminalMessage = buildInterruptedTurnMessage(
        liveThinkingText,
        liveContentText,
        payload.runId,
      );
    }
    if (terminalMessage && !shouldHideMessage(terminalMessage)) {
      const runScopedMessage =
        payload.runId && typeof terminalMessage === 'object' && !Array.isArray(terminalMessage)
          ? { ...(terminalMessage as Record<string, unknown>), runId: payload.runId }
          : terminalMessage;
      const projectedMessage = markOptimisticHistoryTail(
        liveThinkingText
          ? withThinkingContent(runScopedMessage, liveThinkingText)
          : runScopedMessage,
      );
      const history = this.chatMessagesBySession.get(sessionKey) ?? new ChunkedMessageHistory();
      history.replaceRecent(
        appendTerminalMessage(history.recentMessages, projectedMessage, startedAt),
      );
      this.chatMessagesBySession.set(sessionKey, history);
      cached.transcript.persistedMessages = history.recentMessages;
    }
    cached.chatSending = false;
    cached.compactionInFlight = false;
    cached.chatRunId = null;
    cached.runActivity = null;
    cached.terminalLifecycleSeen = false;
    cached.assistantSnapshotRunId = null;
    cached.ignoredDeltaAfterAssistantSnapshotCount = 0;
    if (payload.state === 'error') {
      cached.lastError = payload.errorMessage ?? 'Unknown error';
    }
  }

  private applyBackgroundAgentEvent(event: NormalizedAgentEvent): void {
    const cachedEntry = this.findLiveSessionState(event.sessionKey, event.sessionId);
    if (!cachedEntry) return;
    const [sessionKey, cached] = cachedEntry;
    const backgroundAssistantText = assistantEventText(event.data);
    if (
      event.stream === 'assistant' &&
      backgroundAssistantText !== null &&
      isHiddenOrPendingControlReplyText(backgroundAssistantText)
    ) {
      return;
    }
    const reduceResult = reduceAgentEvent(cached.transcript, event, this.transcriptDependencies);
    if (reduceResult !== 'applied') return;

    const terminalGuardObservation =
      event.stream === 'assistant' ? readTerminalGuardObservation(event.data) : null;
    if (terminalGuardObservation?.action === 'rollback') {
      cached.assistantSnapshotRunId = null;
      cached.ignoredDeltaAfterAssistantSnapshotCount = 0;
      return;
    }
    if (terminalGuardObservation?.action === 'commit') return;

    if (
      event.stream === 'thinking' ||
      event.stream === 'assistant' ||
      event.stream === 'tool' ||
      (event.stream === 'lifecycle' && event.data.phase === 'start')
    ) {
      cached.chatSending = true;
      cached.chatRunId = event.runId;
    }
    if (event.stream === 'assistant') {
      cached.assistantSnapshotRunId = event.runId;
      cached.ignoredDeltaAfterAssistantSnapshotCount = 0;
    }
    if (event.stream !== 'lifecycle') return;

    const phase = typeof event.data.phase === 'string' ? event.data.phase : '';
    if (phase === 'start') cached.terminalLifecycleSeen = false;
    if (phase === 'end' && event.data.aborted === true) {
      this.applyBackgroundChatEvent({
        runId: event.runId,
        sessionKey,
        sessionId: event.sessionId,
        lifecycleGeneration: event.lifecycleGeneration,
        frameSeq: event.frameSeq,
        state: 'aborted',
        replace: false,
      });
      return;
    }
    if (phase === 'end') cached.terminalLifecycleSeen = true;
    if (phase === 'error') {
      const errorMessage =
        typeof event.data.error === 'string' && event.data.error.trim()
          ? event.data.error.trim()
          : 'Unknown error';
      this.applyBackgroundChatEvent({
        runId: event.runId,
        sessionKey,
        sessionId: event.sessionId,
        lifecycleGeneration: event.lifecycleGeneration,
        frameSeq: event.frameSeq,
        state: 'error',
        replace: false,
        errorMessage,
      });
    }
  }

  private handleEvent(event: GatewayEventFrame): void {
    if (event.event === 'tick') return;
    if (event.event === 'chat') {
      const payload = normalizeChatEvent({ payload: event.payload, frameSeq: event.seq });
      if (payload) {
        this.ensureTranscriptSessionIdentity();
        const matchesSelectedSession =
          normalizeTranscriptSessionKey(payload.sessionKey) ===
          normalizeTranscriptSessionKey(this.state.sessionKey);
        if (!matchesSelectedSession) {
          this.applyBackgroundChatEvent(payload);
          return;
        }
        if (
          matchesSelectedSession &&
          payload.runId &&
          isDormantAnnounceRun(payload.runId, this.state.transcript.activeTurn)
        ) {
          if (payload.state === 'delta') {
            const snapshotText = extractSnapshotText(payload.message) ?? payload.deltaText ?? '';
            if (!snapshotText || isHiddenOrPendingControlReplyText(snapshotText)) return;
            this.flushPendingAnnounceEvents(payload.runId);
          } else if (payload.state === 'final') {
            const message = stripAssistantSilentReplySuffix(payload.message);
            if (!message || shouldHideMessage(message)) {
              this.pendingAnnounceEvents.delete(payload.runId);
              return;
            }
            this.flushPendingAnnounceEvents(payload.runId);
          } else {
            this.pendingAnnounceEvents.delete(payload.runId);
          }
        }
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
      const cachedEventSession = this.findLiveSessionState(
        normalized.event.sessionKey,
        normalized.event.sessionId,
      );
      const eventTargetsBackgroundSession = normalized.event.sessionKey
        ? normalizeTranscriptSessionKey(normalized.event.sessionKey) !==
          normalizeTranscriptSessionKey(this.state.sessionKey)
        : cachedEventSession !== null &&
          normalizeTranscriptSessionKey(cachedEventSession[0]) !==
            normalizeTranscriptSessionKey(this.state.sessionKey);
      if (eventTargetsBackgroundSession) {
        this.applyBackgroundAgentEvent(normalized.event);
        return;
      }
      const normalizedAssistantText = assistantEventText(normalized.event.data);
      if (
        normalized.event.stream === 'assistant' &&
        normalizedAssistantText !== null &&
        isHiddenOrPendingControlReplyText(normalizedAssistantText)
      ) {
        if (
          isDormantAnnounceRun(normalized.event.runId, this.state.transcript.activeTurn) &&
          SILENT_REPLY_PATTERN.test(normalizedAssistantText.trim())
        ) {
          this.pendingAnnounceEvents.delete(normalized.event.runId);
        }
        debugLog('[ChatCtrl] hidden assistant snapshot ignored', {
          runId: normalized.event.runId,
          agentSeq: normalized.event.agentSeq,
        });
        return;
      }
      if (isDormantAnnounceControlEvent(normalized.event, this.state.transcript.activeTurn)) {
        const phase =
          normalized.event.stream === 'lifecycle' && typeof normalized.event.data.phase === 'string'
            ? normalized.event.data.phase
            : '';
        if (phase === 'end' && normalized.event.data.aborted !== true) {
          this.pendingAnnounceEvents.delete(normalized.event.runId);
        } else if (phase === 'error' || normalized.event.data.aborted === true) {
          this.flushPendingAnnounceEvents(normalized.event.runId);
          this.applyNormalizedAgentEvent(normalized.event);
        } else {
          this.bufferPendingAnnounceEvent(normalized.event);
        }
        debugLog('[ChatCtrl] dormant announce control event deferred', {
          runId: normalized.event.runId,
          agentSeq: normalized.event.agentSeq,
          stream: normalized.event.stream,
          phase,
        });
        return;
      }
      if (isDormantAnnounceRun(normalized.event.runId, this.state.transcript.activeTurn)) {
        this.flushPendingAnnounceEvents(normalized.event.runId);
      }
      this.applyNormalizedAgentEvent(normalized.event);
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
        const reason =
          typeof payload?.reason === 'string' ? payload.reason.trim().toLowerCase() : '';
        const explicitIdentityChange =
          reason === 'new' || reason === 'reset' || reason === 'delete';
        const managedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(this.state.sessionKey);
        if (managedSession && !explicitIdentityChange) {
          debugLog('[ChatCtrl] rejected unexpected managed session id rotation', {
            sessionKey: this.state.sessionKey,
            currentSessionId,
            nextSessionId,
            reason,
          });
          return;
        }
        this.resetTranscriptForSession(this.state.sessionKey, nextSessionId, false);
        this.state.currentSessionId = nextSessionId;
        this.state.chatRunId = null;
        this.state.chatSending = false;
        this.clearRunActivity();
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
      if (this.admitSubagentTaskMessage(payload?.message)) return;
      const sessionSnapshot = asRecord(payload?.session);
      const eventSessionId = normalizeSessionId(payload?.sessionId ?? sessionSnapshot?.sessionId);
      const activeTurn = this.state.transcript.activeTurn;
      const activeSessionId =
        this.state.currentSessionId ?? this.state.transcript.sessionId ?? activeTurn?.sessionId;
      const sessionIdentityMatches =
        !eventSessionId || !activeSessionId || eventSessionId === activeSessionId;
      const activeRunIds = readStringList(payload?.activeRunIds ?? sessionSnapshot?.activeRunIds);
      const expectedRunIds = new Set(
        [activeTurn?.runId, this.state.chatRunId].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      );
      const explicitMessageRunId = readExplicitMessageRunId(payload?.message);
      const runIdentityMatches =
        (explicitMessageRunId === undefined || expectedRunIds.has(explicitMessageRunId)) &&
        (activeRunIds.length === 0 || activeRunIds.some(runId => expectedRunIds.has(runId))) &&
        (payload?.hasActiveRun ?? sessionSnapshot?.hasActiveRun) !== false;
      const repairedActiveTail =
        payload?.message !== undefined &&
        sessionIdentityMatches &&
        runIdentityMatches &&
        this.hydrateActiveToolItemsFromHistory([payload.message], {
          backfillMissingSessionsYield: true,
          backfillMissingToolsFromAppend: true,
        });
      if (repairedActiveTail) this.publishActiveToolHistoryRepair();
      const messageSeq =
        readPositiveSafeInteger(payload?.messageSeq) ?? readOpenClawMessageSeq(payload?.message);
      const loadedMessageSeq = readLatestOpenClawMessageSeq(this.state.chatMessages);
      const activeTailCatchUpPending =
        sessionIdentityMatches &&
        this.observeSessionMessageSeq(
          this.state.sessionKey,
          eventSessionId ?? activeSessionId ?? null,
          messageSeq,
          loadedMessageSeq,
        );
      if (
        activeTurn?.status === 'running' &&
        this.state.chatSending &&
        sessionIdentityMatches &&
        activeTailCatchUpPending
      ) {
        // session.message is dropIfSlow. A later append and its messageSeq can
        // therefore be the first evidence that a Tool row was missed; fetch
        // the active tail without allowing history to replace the live turn.
        this.scheduleActiveToolHistoryCatchUp(this.state.sessionKey, activeTurn.runId);
      }
      if (this.state.chatSending || this.pendingHistoryReload) {
        debugLog('[ChatCtrl] session.message DEFERRED:', this.state.sessionKey, {
          eventKeys: Object.keys((event.payload as Record<string, unknown> | undefined) ?? {}),
          chatSending: this.state.chatSending,
          pendingReload: this.pendingHistoryReload,
          ...this._snap(),
        });
        this.pendingHistoryReload = true;
        if (!this.hasExpectedInitialHistory()) {
          this.scheduleDeferredHistoryReload(this.state.sessionKey, 'initial-history-missing');
        }
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
      this.handleCompactionPhase(phase, sessionKey, payload);
    }
  }

  private bufferPendingAnnounceEvent(event: NormalizedAgentEvent): void {
    let events = this.pendingAnnounceEvents.get(event.runId);
    if (!events) {
      if (this.pendingAnnounceEvents.size >= 8) {
        const oldestRunId = this.pendingAnnounceEvents.keys().next().value;
        if (typeof oldestRunId === 'string') this.pendingAnnounceEvents.delete(oldestRunId);
      }
      events = [];
      this.pendingAnnounceEvents.set(event.runId, events);
    }
    events.push(event);
    if (events.length > 100) events.splice(0, events.length - 100);
  }

  private flushPendingAnnounceEvents(runId: string): void {
    const events = this.pendingAnnounceEvents.get(runId);
    if (!events?.length) return;
    this.pendingAnnounceEvents.delete(runId);
    for (const event of [...events].sort((left, right) => left.agentSeq - right.agentSeq)) {
      this.applyNormalizedAgentEvent(event);
    }
  }

  private applyNormalizedAgentEvent(event: NormalizedAgentEvent): void {
    const reduceResult = reduceAgentEvent(
      this.state.transcript,
      event,
      this.transcriptDependencies,
    );
    if (reduceResult === 'applied') {
      this.handleAgentEvent(event);
      return;
    }
    debugLog('[ChatCtrl] Agent event ignored by ordered reducer', {
      runId: event.runId.slice(0, 12),
      agentSeq: event.agentSeq,
      stream: event.stream,
      result: reduceResult,
    });
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
    const projected = projectGatewayHistoryForDisplay(messages);
    const hydratedFullMessages = await this.hydrateTruncatedHistoryMessages(projected, sessionKey);
    return hydrateGatewayHistoryForDisplay(hydratedFullMessages, {
      sessionKey,
      lastError: this.state.lastError,
      includeInterruptedOverlays: false,
      enrichCompactionMarkers: (projectedMessages, key) =>
        this.enrichCompactionMarkers(projectedMessages, key),
    });
  }

  private async hydrateTruncatedHistoryMessages(
    messages: unknown[],
    sessionKey: string,
  ): Promise<unknown[]> {
    const client = this.state.client;
    if (!client) return messages;

    const candidatesById = new Map<string, { indices: number[] }>();
    messages.forEach((message, index) => {
      if (!hasOpenClawHistoryTruncationMarker(message)) return;
      const messageId = readOpenClawMessageId(message);
      if (!messageId) return;
      const existing = candidatesById.get(messageId);
      if (existing) {
        existing.indices.push(index);
      } else {
        candidatesById.set(messageId, { indices: [index] });
      }
    });
    const candidates = [...candidatesById.entries()].map(([messageId, value]) => ({
      messageId,
      indices: value.indices,
    }));
    if (candidates.length === 0) return messages;

    const replacements = new Map<number, unknown>();
    const batchSize = 8;
    for (let start = 0; start < candidates.length; start += batchSize) {
      await Promise.all(
        candidates.slice(start, start + batchSize).map(async candidate => {
          try {
            const result = await client.request<{
              ok?: boolean;
              message?: unknown;
            }>('chat.message.get', {
              sessionKey,
              messageId: candidate.messageId,
              maxChars: FULL_HISTORY_MESSAGE_MAX_CHARS,
            });
            const fullMessage = asRecord(result?.message);
            if (!result?.ok || !fullMessage) return;
            for (const index of candidate.indices) {
              replacements.set(
                index,
                retainOriginalOpenClawIdentity(result.message, messages[index]),
              );
            }
          } catch (error) {
            debugLog('[ChatCtrl] full history message unavailable', {
              sessionKey,
              messageId: candidate.messageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
    if (replacements.size === 0) return messages;
    return messages.map((message, index) => replacements.get(index) ?? message);
  }

  async loadOlderHistory(): Promise<boolean> {
    const sessionKey = this.state.sessionKey;
    const initialCursor = this.state.historyNextCursor;
    if (!sessionKey || !initialCursor || this.state.historyLoadingOlder) return false;

    const historyGeneration = this.state.transcript.historyGeneration;
    const sessionId = this.state.transcript.sessionId;
    const requestedWindow = {
      start: this.state.historyWindowStart,
      end: this.state.historyWindowEnd,
    };
    const requestedNewerNavigationRevision = this.newerHistoryNavigationRevision;
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
        const subagentTaskPageIndex = this.findSubagentTaskHistoryIndex(normalized);
        if (this.expectInitialHistory && subagentTaskPageIndex >= 0) {
          const taskBoundedPage = normalized.slice(subagentTaskPageIndex);
          const boundedHistory = [...taskBoundedPage, ...this.currentMessageHistory.recentMessages];
          const messages = this.state.chatSending
            ? sliceActiveSubagentHistoryPrefix(boundedHistory)
            : boundedHistory;
          this.state.transcript.historySource = 'gateway';
          this.state.historyHasMore = false;
          this.state.historyNextCursor = null;
          this.setCurrentSessionMessages(messages, { resetLoadedHistory: true });
          this.state.transcript.revision += 1;
          this.notify();
          return true;
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
        const shouldShiftRequestedWindowOlder =
          this.state.historyWindowStart === requestedWindow.start &&
          this.state.historyWindowEnd === requestedWindow.end &&
          this.newerHistoryNavigationRevision === requestedNewerNavigationRevision;
        const preservedWindow = {
          start: this.state.historyWindowStart + addedCount,
          end: this.state.historyWindowEnd + addedCount,
        };
        this.state.historyWindowStart = preservedWindow.start;
        this.state.historyWindowEnd = preservedWindow.end;
        this.applyHistoryWindow(
          shouldShiftRequestedWindowOlder
            ? shiftHistoryWindowOlder(preservedWindow, this.currentMessageHistory.length)
            : preservedWindow,
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
    options: {
      preferStartup?: boolean;
      reconcileSuspended?: boolean;
      backfillActiveSessionsYield?: boolean;
    } = {},
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
        this.resetTranscriptForSession(sessionKey, loadedSessionId, false);
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

      let pagedHistory = await this.loadPagedHistoryFromRest(sessionKey).catch(error => {
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
      let rawMessages = pagedHistory?.messages ?? result?.messages ?? [];
      if (options.backfillActiveSessionsYield && pagedHistory && Array.isArray(result?.messages)) {
        const pagedLatestSeq = readLatestOpenClawMessageSeq(pagedHistory.messages);
        const rpcLatestSeq = readLatestOpenClawMessageSeq(result.messages);
        if (rpcLatestSeq !== null && (pagedLatestSeq === null || rpcLatestSeq > pagedLatestSeq)) {
          // The REST window and RPC snapshot are read independently. During a
          // live catch-up, prefer whichever source has observed the newer
          // transcript append so a stale paged response cannot consume the
          // unresolved sequence gap.
          rawMessages = result.messages;
          pagedHistory = null;
        }
      }
      if (
        this.expectInitialHistory &&
        pagedHistory &&
        this.findSubagentTaskHistoryIndex(rawMessages) < 0 &&
        Array.isArray(result?.messages) &&
        this.findSubagentTaskHistoryIndex(result.messages) >= 0
      ) {
        // The recent paged window can omit the first subagent turn while the
        // wider RPC snapshot still contains it. Prefer the source that proves
        // the task boundary, then trim inherited fork context below.
        rawMessages = result.messages;
        pagedHistory = null;
      }
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
      const projectedMessages = projectGatewayHistoryForDisplay(rawMessages);
      debugLog('[ChatCtrl] loadHistory PROJECTED', {
        seq: loadSeq,
        sessionKey,
        rawCount: rawMessages.length,
        projectedCount: projectedMessages.length,
        hiddenCount: rawMessages.length - projectedMessages.length,
        projectedSummary: summarizeHistoryForDebug(projectedMessages),
      });
      const hydratedFullMessages = await this.hydrateTruncatedHistoryMessages(
        projectedMessages,
        sessionKey,
      );
      const hydratedMessages = await hydrateGatewayHistoryForDisplay(hydratedFullMessages, {
        sessionKey,
        lastError: this.state.lastError,
        enrichCompactionMarkers: (messages, key) => this.enrichCompactionMarkers(messages, key),
      });
      if (!requestStillCurrent()) {
        debugLog('[ChatCtrl] loadHistory ABORT identity changed during normalization', {
          seq: loadSeq,
          requestedSessionKey: sessionKey,
          currentSessionKey: this.state.sessionKey,
        });
        return false;
      }
      let messages = this.projectLocalCompactionStatus(sessionKey, hydratedMessages);
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
      const loadedMessageSeq = readLatestOpenClawMessageSeq(messages);
      this.recordLoadedSessionMessageSeq(
        sessionKey,
        authoritativeSessionId,
        loadedMessageSeq,
        false,
      );

      // During a live subagent run, history can already contain assistant/tool
      // artifacts from the same turn by the time its delayed first user turn
      // becomes readable. Only admit the authoritative prefix through that
      // user turn; the active transcript remains the sole owner of live output.
      const subagentTaskHistoryIndex = this.findSubagentTaskHistoryIndex(messages);
      const previousHasSubagentTask = this.findSubagentTaskHistoryIndex(previousMessages) >= 0;
      const currentHasSubagentTask =
        this.findSubagentTaskHistoryIndex(this.state.chatMessages) >= 0;
      if (currentHasSubagentTask && subagentTaskHistoryIndex < 0) {
        debugLog('[ChatCtrl] rejected history snapshot older than live subagent task event', {
          seq: loadSeq,
          sessionKey,
          ...this._snap(),
        });
        this.state.chatLoading = false;
        this.notify();
        return false;
      }
      if (this.expectInitialHistory && subagentTaskHistoryIndex > 0) {
        messages = messages.slice(subagentTaskHistoryIndex);
      }
      const catchesUpMissingInitialHistory =
        this.expectInitialHistory &&
        this.state.chatSending &&
        !previousHasSubagentTask &&
        subagentTaskHistoryIndex >= 0;
      if (catchesUpMissingInitialHistory) {
        messages = sliceActiveSubagentHistoryPrefix(messages);
      }

      // Active-run history is not allowed to replace the live timeline, but it
      // can safely hydrate the same Tool boundary by its stable call ID. This is
      // especially important for long sessions_yield joins whose live result
      // event may contain only a short summary or no renderable output.
      const repairedActiveTail = this.hydrateActiveToolItemsFromHistory(messages, {
        backfillMissingSessionsYield: options.backfillActiveSessionsYield,
      });
      if (repairedActiveTail) this.publishActiveToolHistoryRepair();
      if (options.backfillActiveSessionsYield) {
        // Resolve the transcript-level gap only after the same authoritative
        // snapshot has passed the identity/time-limited Tool hydration step.
        this.recordLoadedSessionMessageSeq(
          sessionKey,
          authoritativeSessionId,
          loadedMessageSeq,
          true,
        );
      }

      // Only clear pendingUserMessage if the user message is actually in the
      // loaded history.  For brand-new sessions the gateway may not have
      // persisted it yet — keep showing the optimistic bubble.
      let pendingUserMessageFoundIndex = -1;
      if (this.state.pendingUserMessage) {
        const p = this.state.pendingUserMessage;
        pendingUserMessageFoundIndex = messages.findIndex((message: unknown) =>
          isPendingUserMessageMatch(message as GatewayMessage, p as unknown as GatewayMessage),
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
        activeRun:
          this.state.chatSending && !options.reconcileSuspended && !catchesUpMissingInitialHistory,
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
      this.state.historyHasMore =
        this.expectInitialHistory && subagentTaskHistoryIndex >= 0
          ? false
          : pagedHistory
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
      this.setCurrentSessionMessages(messages, {
        resetLoadedHistory: this.expectInitialHistory && subagentTaskHistoryIndex >= 0,
      });
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
    if (payload.runId && payload.deltaText) {
      this.updateRunActivity(payload.runId, 'responding', { modelActivity: true });
    }
    this.notifyStream();
  }

  private handleFinal(payload: NormalizedChatEvent): void {
    this.clearLifecycleEndFallback();
    this.finishCurrentTurnTiming('final', payload.runId);
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
      const runScopedMessage =
        payload.runId && message && typeof message === 'object' && !Array.isArray(message)
          ? { ...(message as Record<string, unknown>), runId: payload.runId }
          : message;
      const terminalMessage = markOptimisticHistoryTail(
        liveThinkingText
          ? withThinkingContent(runScopedMessage, liveThinkingText)
          : runScopedMessage,
      );
      this.setCurrentSessionMessages(
        appendTerminalMessage(
          this.state.chatMessages,
          terminalMessage,
          this.state.transcript.activeTurn?.runId === payload.runId
            ? this.state.transcript.activeTurn.startedAt
            : null,
        ),
      );
      debugLog('[ChatCtrl] ▶ chat.final appended terminal', {
        terminalMessage: summarizeMessageForDebug(terminalMessage),
        afterSummary: summarizeHistoryForDebug(this.state.chatMessages),
      });
    }
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.clearRunActivity();
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
    const abortedRunId = payload.runId?.trim() || null;
    this.clearLifecycleEndFallback();
    this.finishCurrentTurnTiming('aborted', payload.runId);
    const liveThinkingText = collectActiveThinkingText(this.state.transcript.activeTurn);
    const liveContentText = collectActiveContentText(this.state.transcript.activeTurn);
    const interruptedMessage = payload.message
      ? liveThinkingText
        ? withThinkingContent(payload.message, liveThinkingText)
        : payload.message
      : buildInterruptedTurnMessage(liveThinkingText, liveContentText, abortedRunId);
    const message =
      interruptedMessage && abortedRunId && typeof interruptedMessage === 'object'
        ? { ...(interruptedMessage as Record<string, unknown>), runId: abortedRunId }
        : interruptedMessage;
    const renderable = Boolean(message && !shouldHideMessage(message));
    const persistedMessage = renderable
      ? persistInterruptedMessage(this.state.sessionKey, payload.runId, message)
      : null;
    const willAppend = Boolean(persistedMessage);
    debugLog('[ChatCtrl] ▶ chat.aborted', {
      hasMessage: !!message,
      liveThinkingLen: liveThinkingText?.length ?? 0,
      liveContentLen: liveContentText?.length ?? 0,
      ...this._snap(),
    });
    if (willAppend) {
      const retainedMessages = this.state.chatMessages.filter(existingMessage => {
        if (!abortedRunId || !existingMessage || typeof existingMessage !== 'object') return true;
        const existing = existingMessage as Record<string, unknown>;
        return !(
          existing.runId === abortedRunId &&
          (existing.__justdoOptimisticHistoryTail === true || existing.interrupted === true)
        );
      });
      this.setCurrentSessionMessages([
        ...retainedMessages,
        markOptimisticHistoryTail(persistedMessage),
      ]);
    }
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.clearRunActivity();
    this.suspendedRunId = null;
    this.terminalLifecycleSeen = false;
    this.resetAssistantSnapshotSource();
    if (willAppend) {
      // Gateway history often has no assistant message for an interrupted
      // thinking-only turn. Keep the optimistic truncated projection instead of
      // immediately replacing it with that shorter authoritative history.
      this.pendingHistoryReload = false;
    } else {
      this.flushPendingHistoryReload();
    }
    this.notify();
  }

  private handleError(payload: NormalizedChatEvent): void {
    this.clearLifecycleEndFallback();
    this.finishCurrentTurnTiming('error', payload.runId);
    this.state.lastError = payload.errorMessage ?? 'Unknown error';
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.clearRunActivity();
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
      if (!wasSending && !this.hasExpectedInitialHistory()) {
        this.scheduleDeferredHistoryReload(this.state.sessionKey, 'initial-history-missing');
      }
      this.updateRunActivity(runId, 'thinking', { modelActivity: true });
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
      const terminalGuardObservation = readTerminalGuardObservation(data);
      if (terminalGuardObservation?.action === 'rollback') {
        this.resetAssistantSnapshotSource();
        this.updateRunActivity(runId, 'waiting-model');
        this.notifyStream('terminal');
        return;
      }
      if (terminalGuardObservation?.action === 'commit') return;
      const text = assistantEventText(data);
      if (!text) return;

      const wasSending = this.state.chatSending;
      if (!this.state.chatSending) {
        this.state.chatSending = true;
        this.state.chatRunId = runId;
      }
      if (!wasSending && !this.hasExpectedInitialHistory()) {
        this.scheduleDeferredHistoryReload(this.state.sessionKey, 'initial-history-missing');
      }

      this.assistantSnapshotRunId = runId ?? this.state.chatRunId;
      this.updateRunActivity(runId, 'responding', { modelActivity: true });

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
        const wasSending = this.state.chatSending;
        if (!wasSending) this.resetActiveToolHistoryCatchUpForRun(this.state.sessionKey);
        this.terminalLifecycleSeen = false;
        this.clearLifecycleEndFallback();
        if (!this.state.chatSending) {
          this.state.chatSending = true;
        }
        if (runId && !this.state.chatRunId) {
          this.state.chatRunId = runId;
        }
        if (!wasSending && !this.hasExpectedInitialHistory()) {
          this.scheduleDeferredHistoryReload(this.state.sessionKey, 'initial-history-missing');
        }
        this.updateRunActivity(runId, 'starting', { at: payload.timestamp });
        this.notifyStream();
      }
      if (phase === 'progress') {
        const progressStage = typeof data.stage === 'string' ? data.stage : '';
        const mappedStage: RunProgressStage | null =
          progressStage === 'queued'
            ? 'queued'
            : progressStage === 'preparing'
              ? 'preparing'
              : progressStage === 'waiting_model'
                ? 'waiting-model'
                : progressStage === 'retrying'
                  ? 'retrying'
                  : null;
        if (mappedStage) {
          this.updateRunActivity(runId, mappedStage, {
            provider: typeof data.provider === 'string' ? data.provider : undefined,
            model: typeof data.model === 'string' ? data.model : undefined,
            retryReason: mappedStage === 'retrying' ? data.reason : undefined,
            at: typeof data.at === 'number' ? data.at : payload.timestamp,
          });
          this.notifyStream();
        }
      }
      if (phase === 'fallback_step' && data.fallbackStepFinalOutcome === 'next_fallback') {
        this.updateRunActivity(runId, 'retrying', {
          retryReason: data.fallbackStepFromFailureReason,
          at: payload.timestamp,
        });
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
        if (data.aborted === true) {
          const abortedEvent: NormalizedChatEvent = {
            runId,
            sessionKey: this.state.sessionKey,
            sessionId: this.state.currentSessionId,
            lifecycleGeneration: this.state.transcript.activeTurn?.lifecycleGeneration ?? null,
            frameSeq: null,
            state: 'aborted',
            replace: false,
          };
          reduceChatEvent(this.state.transcript, abortedEvent, this.transcriptDependencies);
          // The lifecycle reducer may already have marked the turn terminal.
          // Still reconcile the visible partial output: thinking-only aborted
          // runs do not necessarily produce a later chat.aborted frame.
          this.handleAborted(abortedEvent);
          return;
        }
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
        this.finishCurrentTurnTiming('error', runId);
        this.state.chatSending = false;
        this.state.compactionInFlight = false;
        this.clearLocalCompactionStatus(this.state.sessionKey);
        this.terminalLifecycleSeen = false;
        this.state.chatRunId = null;
        this.clearRunActivity();
        this.resetAssistantSnapshotSource();
        this.pendingHistoryReload = true;
        this.flushPendingHistoryReload();
        this.notify();
      }
      return;
    }

    if (stream === 'compaction') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      this.handleCompactionPhase(phase, this.state.sessionKey, data);
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
    const hasRunningTool = [...(this.state.transcript.activeTurn?.toolById.values() ?? [])].some(
      tool => tool.status === 'running',
    );
    this.updateRunActivity(runId, hasRunningTool ? 'running-tool' : 'waiting-model', {
      modelActivity: true,
    });
    this.notifyStream(hasPartialResult && !isTerminalToolEvent ? 'tool-partial' : 'terminal');
  }

  // ─── Send Message ─────────────────────────────────────────────────────

  async sendMessage(
    message: string,
    attachments: CoworkAttachmentPayload[] = [],
    gatewayMessage = message,
    options: {
      propagateRequestFailure?: boolean;
      clientTurnId?: string;
      onRunBound?: (runId: string) => void | Promise<void>;
    } = {},
  ): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');
    if (this.state.chatSending) throw new Error('A message is already being sent');

    const displayMessage = extractGoalFollowUpRequest(gatewayMessage) ?? message;
    const slashCommand = resolveSlashCommandBehavior(gatewayMessage);
    if (slashCommand?.execution === SlashCommandExecution.Blocked) {
      const error = new Error(
        `/${slashCommand.name} is managed by the application and cannot be sent as a chat command.`,
      );
      this.state.lastError = error.message;
      this.notify();
      throw error;
    }
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

    const runId =
      options.clientTurnId?.trim() ||
      `justdo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    debugLog('[ChatCtrl] sendMessage:', displayMessage.slice(0, 60), {
      sessionKey,
      runId,
    });
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.resetActiveToolHistoryCatchUpForRun(sessionKey);
    this.historyReloadRequested.delete(sessionKey);
    this.pendingHistoryReload = false;

    // Optimistic: append user message immediately
    const attachmentBlocks = toAttachmentContentBlocks(attachments);
    const userMessage = {
      role: 'user',
      content:
        attachmentBlocks.length > 0
          ? [{ type: 'text', text: displayMessage }, ...attachmentBlocks]
          : displayMessage,
      timestamp: Date.now(),
    };
    // A post-send history refresh can race Gateway transcript persistence,
    // especially when the run is stopped before the model replies. Protect
    // the prompt until chat.history contains its authoritative replacement.
    this.setCurrentSessionMessages([
      ...this.state.chatMessages,
      markOptimisticHistoryTail(userMessage),
    ]);
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
    this.beginRunActivity(runId);
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
        message: gatewayMessage,
        deliver: false,
        justdoUserInitiated: true,
        idempotencyKey: runId,
        ...(gatewayAttachments.length > 0 ? { attachments: gatewayAttachments } : {}),
      });
      try {
        await options.onRunBound?.(ack?.runId ?? runId);
      } catch (error) {
        debugLog('[ChatCtrl] failed to persist root run binding', error);
      }

      if (ack?.runId) this.bindAcknowledgedRun(sessionKey, runId, ack.runId);

      // If status is "ok", the run already completed
      const acknowledgedRunId = ack?.runId ?? runId;
      const activeRunId = this.getSessionRunId(sessionKey);
      const ackMatchesActiveRun = activeRunId === runId || activeRunId === acknowledgedRunId;
      if (ack?.status === 'ok' && ackMatchesActiveRun) {
        this.settleChatSend(sessionKey, acknowledgedRunId, 'final');
      }
    } catch (err) {
      if (this.getSessionRunId(sessionKey) !== runId) {
        if (options.propagateRequestFailure) throw err;
        return;
      }
      this.settleChatSend(sessionKey, runId, 'error', (err as Error).message);
      if (options.propagateRequestFailure) throw err;
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
        this.settleCompactionRequest(sessionKey);
        if (!this.isSelectedSession(sessionKey)) return;
        this.notifyStream();
        this.notify();
        const historyLoaded = await this.loadHistory();
        if (!this.isSelectedSession(sessionKey)) return;
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
      this.settleCompactionRequest(sessionKey);
      if (!this.isSelectedSession(sessionKey)) return;
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
      this.settleCompactionRequest(sessionKey, errorMessage);
      if (!this.isSelectedSession(sessionKey)) return;
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
          summary: readNonBlankString(checkpoint.summary) ?? readNonBlankString(marker.summary),
          tokensBefore: checkpoint.tokensBefore ?? marker.tokensBefore,
          tokensAfter: checkpoint.tokensAfter ?? marker.tokensAfter,
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

function precedingSegmentsByToolCallId(
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

function firstAttachedToolCallId(value: unknown): string | null {
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

function toolResultCallIds(messages: unknown[]): Set<string> {
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

function collectActiveThinkingText(turn: AssistantTurn | null): string | null {
  const text = (turn?.items ?? [])
    .filter(item => item.type === 'thinking')
    .map(item => item.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function collectActiveContentText(turn: AssistantTurn | null): string | null {
  const text = (turn?.items ?? [])
    .filter(item => item.type === 'content')
    .map(item => item.text)
    .filter(Boolean)
    .join('')
    .trim();
  return text || null;
}

function buildInterruptedTurnMessage(
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

function assistantEventText(data: Record<string, unknown>): string | null {
  const snapshot = typeof data.text === 'string' ? data.text : null;
  if (snapshot?.trim()) return snapshot;
  const delta = typeof data.delta === 'string' ? data.delta : null;
  return delta?.trim() ? delta : null;
}

function isDormantAnnounceControlEvent(
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

function isDormantAnnounceRun(runId: string, activeTurn: AssistantTurn | null): boolean {
  return runId.startsWith('announce:v1:') && activeTurn?.runId !== runId;
}

function appendTerminalMessage(
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

function messageRunId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  for (const value of [
    record.runId,
    record.run_id,
    asRecord(record.metadata)?.runId,
    asRecord(record.metadata)?.run_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function hasSameTerminalIdentity(
  left: unknown,
  right: unknown,
  activeRunStartedAt: number | null,
): boolean {
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

function isTerminalToolPhase(phase: string): boolean {
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

function isNonTerminalToolPhase(phase: string): boolean {
  return ['start', 'delta', 'partial', 'progress', 'update', 'streaming'].includes(
    phase.toLowerCase(),
  );
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

import { createPropertyContext } from '@shared/app/propertyContext';

import * as chatControllerCompaction from './chat-controller-compaction';
import { type ChatControllerCompactionContext } from './chat-controller-compaction';
import * as chatControllerHistory from './chat-controller-history';
import { type ChatControllerHistoryContext } from './chat-controller-history';
import * as chatControllerProgress from './chat-controller-progress';
import { type ChatControllerProgressContext } from './chat-controller-progress';
import * as chatControllerRecovery from './chat-controller-recovery';
import { type ChatControllerRecoveryContext } from './chat-controller-recovery';
import * as chatControllerSession from './chat-controller-session';
import { type ChatControllerSessionContext } from './chat-controller-session';
import {
  appendTerminalMessage,
  asRecord,
  assistantEventText,
  buildInterruptedTurnMessage,
  ChatControllerOptions,
  ChatHistorySnapshot,
  ChatState,
  ChatStateListener,
  ChatStreamListener,
  ChatStreamUpdateKind,
  cloneAssistantTurn,
  collectActiveContentText,
  collectActiveThinkingText,
  CompactionCheckpoint,
  contextUsageSnapshotsEqual,
  debugLog,
  DEFAULT_INITIAL_HISTORY_RETRY_DELAYS_MS,
  DEFAULT_INITIAL_MESSAGE_SUBSCRIPTION_BARRIER_TIMEOUT_MS,
  hasStableProgressOwner,
  InFlightRunSnapshot,
  isChatTextRetraction,
  isHiddenOrPendingControlReplyText,
  LocalCompactionStatus,
  normalizeSessionId,
  PostFinalHistoryRecovery,
  readChatContextUsageSnapshot,
  readNonBlankString,
  readStringList,
  RewindEditorDraft,
  SessionLiveState,
  SideChatResult,
  SideChatResultListener,
  SideChatStreamListener,
  SideChatStreamUpdate,
  summarizeMessagesForDebug,
  SwitchSessionOptions,
  withThinkingContent,
} from './chat-controller-support';
export type {
  ChatContextUsageSnapshot,
  ChatControllerOptions,
  ChatState,
  ChatStateListener,
  ChatStreamListener,
  ChatStreamUpdateKind,
  RewindEditorDraft,
  SideChatResult,
  SideChatResultListener,
  SideChatStreamListener,
  SideChatStreamUpdate,
} from './chat-controller-support';
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

import { parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import { type CoworkAttachmentPayload, toGatewayAttachment } from '@shared/cowork/attachments';
import {
  isDefinitiveSessionGoalGatewayError,
  normalizeSessionGoal,
  type SessionGoalMutationResult,
  SessionGoalStatus,
} from '@shared/cowork/sessionGoal';
import {
  parseGoalStartObjective,
  resolveSlashCommandBehavior,
  SlashCommandBeforeSendHook,
  SlashCommandExecution,
} from '@shared/cowork/slashCommands';
import {
  normalizeAgentEvent,
  type NormalizedAgentEvent,
  type NormalizedChatEvent,
  readTerminalGuardObservation,
} from '@shared/openclaw/agentEvent';
import { isInternalManagedSubagentHandoffError } from '@shared/openclaw/internalRunError';
import { modelRefFromIdentity } from '@shared/openclaw/modelRef';
import { type ProgressCard } from '@shared/openclaw/progressCard';
import { extractGoalFollowUpRequest } from '@shared/prompts/goalFollowUpPrompt';
import type { LocalTtsSpeakResult } from '@shared/speech/localTts';

import { toAttachmentContentBlocks } from '@/libs/openclaw-chat/attachments';
import { type ChatHistoryPage } from '@/libs/openclaw-chat/gateway/chat-history-protocol';
import type {
  GatewayClient,
  GatewayEventFrame,
  GatewayHelloOk,
} from '@/libs/openclaw-chat/gateway/client';
import {
  readPreambleText,
  readToolProgressText,
  reduceAgentEvent,
  reduceChatEvent,
  restoreInFlightContent,
} from '@/libs/openclaw-chat/model/agent-event-reducer';
import { traceTimelineController } from '@/libs/openclaw-chat/model/chat-timeline-trace';
import {
  type AssistantTurn,
  type AssistantTurnTiming,
  beginAssistantTurn,
  bindAssistantTurnRunId,
  type ChatTranscriptState,
  createChatTranscriptState,
  type HistorySource,
  isTerminalRun,
  normalizeTranscriptSessionKey,
  pruneRecentRuns,
  RECENT_RUN_RETENTION_MS,
  type TranscriptReducerDependencies,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/chunked-message-history';
import { markOptimisticHistoryTail } from '@/libs/openclaw-chat/model/optimistic-history-tail';
import {
  normalizeRunRetryReason,
  RUN_PROBE_INTERVAL_MS,
  RUN_STALL_NOTICE_MS,
  type RunProgressStage,
} from '@/libs/openclaw-chat/model/run-activity';
import {
  persistFailedRun,
  projectGatewayHistoryForDisplay,
  shouldHideMessage,
  stripAssistantSilentReplySuffix,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import { i18nService } from '@/services/i18n';

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
  private sideChatResultListeners: Set<SideChatResultListener> = new Set();
  private sideChatStreamListeners: Set<SideChatStreamListener> = new Set();
  private localSideChatRunIds = new Set<string>();
  private pendingSideChats = new Map<string, { question: string; sessionKey: string }>();
  private sideChatTranscripts = new Map<string, ChatTranscriptState>();
  private sideChatAssistantSnapshotRunIds = new Set<string>();
  private sideChatTombstoneOrder: string[] = [];
  private lifecycleEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private postFinalHistoryReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private postFinalHistoryRecovery: PostFinalHistoryRecovery | null = null;
  private deferredHistoryReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private activeToolHistoryCatchUpTimer: ReturnType<typeof setTimeout> | null = null;
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
  private settledCompactionEventIds = new Set<string>();
  private manualCompactionRequestIdsBySession = new Map<string, string>();
  private manualCompactionOperations = new Map<
    string,
    {
      sessionKey: string;
      client: NonNullable<ChatController['state']['client']>;
      cancelled: boolean;
      settled: boolean;
      error?: unknown;
    }
  >();
  private progressCardCache = new Map<string, ProgressCard | null>();
  private progressCardLoadGeneration = 0;
  private assistantSnapshotRunId: string | null = null;
  private ignoredDeltaAfterAssistantSnapshotCount = 0;
  private pendingAnnounceEvents = new Map<string, NormalizedAgentEvent[]>();
  private historyLoadSeq = 0;
  private historyPagingGeneration = 0;
  private historyPaginationAdvanced = false;
  private historyPaginationBySession = new Map<
    string,
    { hasMore: boolean; nextCursor: string | null; advanced: boolean }
  >();
  private displayedHistoryLeafBySession = new Map<string, string | null>();
  private newerHistoryNavigationRevision = 0;
  private connectionInitializationSeq = 0;
  private subscribedMessageSessionKey: string | null = null;
  private messageSubscriptionSeq = 0;
  private suspendedRunId: string | null = null;
  private runActivityTimer: ReturnType<typeof setTimeout> | null = null;
  private runProbeToken: symbol | null = null;
  private terminalLifecycleSeen = false;
  private transcriptIdSequence = 0;
  private expectedPlanImplementationReset: {
    requestId: string;
    sessionKey: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  } | null = null;
  private readonly retainedGoalStartOperations = new Map<
    string,
    {
      signature: string;
      operationId: string;
      issuedAtMs: number;
    }
  >();
  private readonly expectInitialHistory: boolean;
  private readonly expectInitialUserMessage: boolean;
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
    this.expectInitialUserMessage = options.expectInitialUserMessage === true;
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
      contextUsage: null,
      progressCard: null,
      progressCardLoading: false,
      progressCardAvailable: false,
      progressCardError: null,
      pendingUserMessage: null,
      transcript: createChatTranscriptState(),
    };
  }

  async speak(text: string): Promise<LocalTtsSpeakResult> {
    return window.electron.speechSynthesis.speak(text);
  }

  /** Set an optimistic user message shown until the next loadHistory.
   *  Also marks chatSending=true so fallback history reloads are deferred. */
  setPendingUserMessage(
    text: string,
    attachments: CoworkAttachmentPayload[] = [],
    gatewayMessage?: string,
  ): void {
    debugLog('[ChatCtrl] setPendingUserMessage:', text.slice(0, 60));
    const attachmentBlocks = toAttachmentContentBlocks(attachments);
    const displaySource =
      gatewayMessage && parseBrowserAnnotationPrompt(gatewayMessage) ? gatewayMessage : text;
    const rawPendingMessage = {
      role: 'user',
      content:
        attachmentBlocks.length > 0
          ? [{ type: 'text', text: displaySource }, ...attachmentBlocks]
          : displaySource,
      text,
      timestamp: Date.now(),
    };
    this.state.pendingUserMessage = (projectGatewayHistoryForDisplay([rawPendingMessage])[0] ??
      rawPendingMessage) as NonNullable<ChatState['pendingUserMessage']>;
    this.state.chatSending = true;
    this.beginRunActivity(`justdo-pending-${Date.now()}`);
    this.notify();
  }

  /** Clear sending state (e.g. when session start fails) */
  clearSending(expectedSessionKey?: string, expectedRunId?: string | null): void {
    if (expectedSessionKey && !this.isSelectedSession(expectedSessionKey)) {
      const cached = this.findLiveSessionState(expectedSessionKey)?.[1];
      if (!cached || (expectedRunId !== undefined && cached.chatRunId !== expectedRunId)) return;
      cached.chatSending = false;
      cached.chatRunId = null;
      cached.pendingUserMessage = null;
      cached.assistantSnapshotRunId = null;
      cached.ignoredDeltaAfterAssistantSnapshotCount = 0;
      cached.runActivity = null;
      return;
    }
    if (expectedRunId !== undefined && this.state.chatRunId !== expectedRunId) return;
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.state.pendingUserMessage = null;
    this.resetAssistantSnapshotSource();
    this.clearRunActivity();
    this.notify();
  }

  /** Apply a product receipt only to the same live run, including background sessions. */
  settleConfirmedRun(
    sessionKey: string,
    runId: string,
    state: 'completed' | 'failed' | 'aborted',
  ): void {
    const live = this.isSelectedSession(sessionKey)
      ? this.state
      : this.findLiveSessionState(sessionKey)?.[1];
    if (!live) return;
    const turn = live.transcript.activeTurn;
    // Sending can already be cleared while the transcript still awaits its
    // terminal frame. Never let an old receipt terminate a replacement run.
    if ((live.chatRunId ?? (turn?.status === 'running' ? turn.runId : null)) !== runId) {
      // A Main-started run can be stopped before its first stream frame. Keep
      // its terminal fence without creating a message or touching newer work.
      if (!isTerminalRun(live.transcript, runId)) {
        live.transcript.terminalRunIds.add(runId);
        live.transcript.recentRuns.set(runId, {
          runId,
          sessionId: live.currentSessionId,
          lifecycleGeneration: null,
          lastAgentSeq: -1,
          terminalStatus:
            state === 'completed' ? 'final' : state === 'failed' ? 'error' : 'aborted',
          expiresAt: this.transcriptDependencies.now() + RECENT_RUN_RETENTION_MS,
        });
        pruneRecentRuns(live.transcript, this.transcriptDependencies.now());
      }
      return;
    }
    const event: NormalizedChatEvent = {
      runId,
      sessionKey,
      sessionId: this.isSelectedSession(sessionKey)
        ? this.state.currentSessionId
        : (this.findLiveSessionState(sessionKey)?.[1].currentSessionId ?? null),
      lifecycleGeneration: turn?.lifecycleGeneration ?? null,
      frameSeq: null,
      replace: false,
      state: state === 'completed' ? 'final' : state === 'failed' ? 'error' : 'aborted',
    };
    if (!this.isSelectedSession(sessionKey)) {
      this.applyBackgroundChatEvent(event);
      return;
    }
    if (reduceChatEvent(this.state.transcript, event, this.transcriptDependencies) === 'applied') {
      this.handleChatEvent(event);
      this.notify();
    }
  }

  /** Adopt an accepted Goal resume before its first Gateway stream event arrives. */
  beginGoalResume(sessionKey: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (
      !normalizedRunId ||
      normalizeTranscriptSessionKey(sessionKey) !==
        normalizeTranscriptSessionKey(this.state.sessionKey)
    ) {
      return;
    }
    const activeTurn = this.state.transcript.activeTurn;
    // The lifecycle event can beat the IPC response. Never replace an already
    // observed copy of this run or discard content received during admission.
    if (activeTurn?.runId === normalizedRunId) return;

    beginAssistantTurn(
      this.state.transcript,
      {
        runId: normalizedRunId,
        sessionId: this.state.currentSessionId,
        startedAt: Date.now(),
      },
      this.transcriptDependencies,
    );
    this.state.chatSending = true;
    this.state.chatRunId = normalizedRunId;
    this.beginRunActivity(normalizedRunId);
    this.state.lastError = null;
    this.resetAssistantSnapshotSource();
    this.notify();
  }

  /** Safely dismiss an unchanged, fully completed progress card. */
  refreshProgressCard(): Promise<boolean> {
    return chatControllerProgress.refreshProgressCard.call(this.chatControllerProgressContext);
  }

  dismissProgressCard(): Promise<boolean> {
    return chatControllerProgress.dismissProgressCard.call(this.chatControllerProgressContext);
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

  /** Subscribe to ephemeral /btw replies, which never enter the main transcript. */
  onSideChatResult(listener: SideChatResultListener): () => void {
    this.sideChatResultListeners.add(listener);
    return () => this.sideChatResultListeners.delete(listener);
  }

  /** Subscribe to isolated /btw Thinking, Tool, and Content timeline updates. */
  onSideChatStream(listener: SideChatStreamListener): () => void {
    this.sideChatStreamListeners.add(listener);
    return () => this.sideChatStreamListeners.delete(listener);
  }

  private publishSideChatStream(
    runId: string,
    sessionKey: string,
    kind: ChatStreamUpdateKind = 'stream',
    turn: AssistantTurn | null = this.sideChatTranscripts.get(runId)?.activeTurn ?? null,
  ): void {
    const update: SideChatStreamUpdate = {
      runId,
      sessionKey,
      turn: turn ? cloneAssistantTurn(turn) : null,
      kind,
    };
    for (const listener of this.sideChatStreamListeners) listener(update);
  }

  private clearSideChatTranscript(
    runId: string,
    sessionKey: string,
    kind: ChatStreamUpdateKind = 'terminal',
  ): void {
    this.sideChatTranscripts.delete(runId);
    this.sideChatAssistantSnapshotRunIds.delete(runId);
    this.publishSideChatStream(runId, sessionKey, kind, null);
  }

  private publishSideChatFailure(runId: string, text = ''): void {
    const pending = this.pendingSideChats.get(runId);
    if (!pending) return;
    this.pendingSideChats.delete(runId);
    const result: SideChatResult = {
      runId,
      sessionKey: pending.sessionKey,
      question: pending.question,
      text,
      isError: true,
    };
    for (const listener of this.sideChatResultListeners) listener(result);
    this.clearSideChatTranscript(runId, pending.sessionKey);
  }

  private retainSideChatTombstone(runId: string): void {
    if (!this.sideChatTombstoneOrder.includes(runId)) this.sideChatTombstoneOrder.push(runId);
    while (this.sideChatTombstoneOrder.length > 256) {
      const expiredRunId = this.sideChatTombstoneOrder.shift();
      if (expiredRunId && !this.pendingSideChats.has(expiredRunId)) {
        this.localSideChatRunIds.delete(expiredRunId);
      }
    }
  }

  private clearSideChatRun(runId: string): void {
    this.localSideChatRunIds.delete(runId);
    this.pendingSideChats.delete(runId);
    this.sideChatTranscripts.delete(runId);
    this.sideChatAssistantSnapshotRunIds.delete(runId);
    this.sideChatTombstoneOrder = this.sideChatTombstoneOrder.filter(id => id !== runId);
  }

  private clearAllSideChatRuns(): void {
    this.sideChatTombstoneOrder = [];
    this.pendingSideChats.clear();
    this.sideChatTranscripts.clear();
    this.sideChatAssistantSnapshotRunIds.clear();
    this.localSideChatRunIds.clear();
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
    const modelRef = modelRefFromIdentity(activity.model, activity.provider);
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
    return chatControllerSession.cacheSessionMessages.call(
      this.chatControllerSessionContext,
      sessionKey,
      history,
    );
  }

  private findLiveSessionState(
    sessionKey: string | null | undefined,
    sessionId?: string | null,
  ): [string, SessionLiveState] | null {
    return chatControllerSession.findLiveSessionState.call(
      this.chatControllerSessionContext,
      sessionKey,
      sessionId,
    );
  }

  private cacheCurrentLiveState(sessionKey: string): void {
    return chatControllerSession.cacheCurrentLiveState.call(
      this.chatControllerSessionContext,
      sessionKey,
    );
  }

  private restoreLiveState(sessionKey: string): boolean {
    return chatControllerSession.restoreLiveState.call(
      this.chatControllerSessionContext,
      sessionKey,
    );
  }

  private isSelectedSession(sessionKey: string): boolean {
    return chatControllerSession.isSelectedSession.call(
      this.chatControllerSessionContext,
      sessionKey,
    );
  }

  private promoteCachedSessionState(sourceSessionKey: string, targetSessionKey: string): void {
    return chatControllerSession.promoteCachedSessionState.call(
      this.chatControllerSessionContext,
      sourceSessionKey,
      targetSessionKey,
    );
  }

  private getSessionRunId(sessionKey: string): string | null {
    return chatControllerSession.getSessionRunId.call(
      this.chatControllerSessionContext,
      sessionKey,
    );
  }

  private bindAcknowledgedRun(
    sessionKey: string,
    provisionalRunId: string,
    acknowledgedRunId: string,
  ): void {
    return chatControllerSession.bindAcknowledgedRun.call(
      this.chatControllerSessionContext,
      sessionKey,
      provisionalRunId,
      acknowledgedRunId,
    );
  }

  private persistRunFailure(
    sessionKey: string,
    sessionId: string | null,
    runId: string | null,
    error: string,
    timestamp = Date.now(),
  ): void {
    const liveState = this.isSelectedSession(sessionKey)
      ? this.state
      : this.findLiveSessionState(sessionKey, sessionId)?.[1];
    const activeTurn = liveState?.transcript.activeTurn;
    persistFailedRun({
      sessionKey,
      sessionId: sessionId ?? liveState?.currentSessionId ?? activeTurn?.sessionId ?? null,
      runId,
      error,
      timestamp,
      promptTimestamp:
        activeTurn && (!runId || activeTurn.runId === runId) ? activeTurn.startedAt : null,
    });
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
    if (state === 'error') {
      this.persistRunFailure(
        sessionKey,
        sessionId,
        runId,
        errorMessage ?? 'Unknown error',
        terminalMessage?.timestamp,
      );
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
    return chatControllerCompaction.settleCompactionRequest.call(
      this.chatControllerCompactionContext,
      sessionKey,
      errorMessage,
    );
  }

  private cacheCurrentTurnTiming(): void {
    return chatControllerSession.cacheCurrentTurnTiming.call(this.chatControllerSessionContext);
  }

  private rememberRunModel(message: unknown, runId?: string | null, terminal = false): void {
    return chatControllerSession.rememberRunModel.call(
      this.chatControllerSessionContext,
      message,
      runId,
      terminal,
    );
  }

  private resetTranscriptForSession(
    sessionKey: string,
    sessionId: string | null,
    preserveTiming = true,
  ): void {
    return chatControllerSession.resetTranscriptForSession.call(
      this.chatControllerSessionContext,
      sessionKey,
      sessionId,
      preserveTiming,
    );
  }

  private finishCurrentTurnTiming(
    status: Exclude<AssistantTurnTiming['status'], 'running'>,
    runId?: string | null,
  ): void {
    return chatControllerSession.finishCurrentTurnTiming.call(
      this.chatControllerSessionContext,
      status,
      runId,
    );
  }

  private finishTurnTimingForSession(
    sessionKey: string,
    status: Exclude<AssistantTurnTiming['status'], 'running'>,
    runId?: string | null,
    endedAt = Date.now(),
  ): void {
    return chatControllerSession.finishTurnTimingForSession.call(
      this.chatControllerSessionContext,
      sessionKey,
      status,
      runId,
      endedAt,
    );
  }

  getCurrentTurnTiming(): AssistantTurnTiming | null {
    return chatControllerSession.getCurrentTurnTiming.call(this.chatControllerSessionContext);
  }

  private setCurrentSessionMessages(
    messages: unknown[],
    options: { resetLoadedHistory?: boolean } = {},
  ): void {
    return chatControllerHistory.setCurrentSessionMessages.call(
      this.chatControllerHistoryContext,
      messages,
      options,
    );
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
    return chatControllerHistory.hydrateActiveToolItemsFromHistory.call(
      this.chatControllerHistoryContext,
      messages,
      options,
    );
  }

  private publishActiveToolHistoryRepair(): void {
    return chatControllerHistory.publishActiveToolHistoryRepair.call(
      this.chatControllerHistoryContext,
    );
  }

  private updateLocalCompactionMessage(
    sessionKey: string,
    statusId: string,
    replacement: unknown | null,
  ): void {
    return chatControllerCompaction.updateLocalCompactionMessage.call(
      this.chatControllerCompactionContext,
      sessionKey,
      statusId,
      replacement,
    );
  }

  private projectLocalCompactionStatus(sessionKey: string, messages: unknown[]): unknown[] {
    return chatControllerCompaction.projectLocalCompactionStatus.call(
      this.chatControllerCompactionContext,
      sessionKey,
      messages,
    );
  }

  private beginLocalCompactionStatus(
    sessionKey: string,
    options: { forceNew?: boolean; eventId?: string } = {},
  ): LocalCompactionStatus {
    return chatControllerCompaction.beginLocalCompactionStatus.call(
      this.chatControllerCompactionContext,
      sessionKey,
      options,
    );
  }

  private completeLocalCompactionStatus(
    sessionKey: string,
    tokens?: { before?: number; after?: number },
  ): LocalCompactionStatus | null {
    return chatControllerCompaction.completeLocalCompactionStatus.call(
      this.chatControllerCompactionContext,
      sessionKey,
      tokens,
    );
  }

  private updateLocalCompactionSummary(
    sessionKey: string,
    status: LocalCompactionStatus,
    data: Record<string, unknown>,
  ): void {
    return chatControllerCompaction.updateLocalCompactionSummary.call(
      this.chatControllerCompactionContext,
      sessionKey,
      status,
      data,
    );
  }

  private clearLocalCompactionStatus(sessionKey: string): void {
    return chatControllerCompaction.clearLocalCompactionStatus.call(
      this.chatControllerCompactionContext,
      sessionKey,
    );
  }

  private applyHistoryWindow(window: { start: number; end: number }): boolean {
    return chatControllerHistory.applyHistoryWindow.call(this.chatControllerHistoryContext, window);
  }

  private rememberHistoryPagination(sessionKey: string): void {
    return chatControllerHistory.rememberHistoryPagination.call(
      this.chatControllerHistoryContext,
      sessionKey,
    );
  }

  private restoreHistoryPagination(sessionKey: string): void {
    return chatControllerHistory.restoreHistoryPagination.call(
      this.chatControllerHistoryContext,
      sessionKey,
    );
  }

  private resetHistoryPagination(sessionKey: string): void {
    return chatControllerHistory.resetHistoryPagination.call(
      this.chatControllerHistoryContext,
      sessionKey,
    );
  }

  showOlderHistory(): Promise<boolean> {
    return chatControllerHistory.showOlderHistory.call(this.chatControllerHistoryContext);
  }

  showNewerHistory(): boolean {
    return chatControllerHistory.showNewerHistory.call(this.chatControllerHistoryContext);
  }

  showLatestHistory(): boolean {
    return chatControllerHistory.showLatestHistory.call(this.chatControllerHistoryContext);
  }

  /** Materialize every loaded page only for explicit whole-history consumers such as export. */
  getLoadedMessages(): unknown[] {
    return chatControllerHistory.getLoadedMessages.call(this.chatControllerHistoryContext);
  }

  preparePlanImplementationReset(request: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): void {
    this.expectedPlanImplementationReset = { ...request, sessionKey: this.state.sessionKey };
  }

  cancelPlanImplementationReset(requestId: string): void {
    if (this.expectedPlanImplementationReset?.requestId === requestId) {
      this.expectedPlanImplementationReset = null;
    }
  }

  /** Repoint the current transcript to the state before one persisted user message. */
  rewindToUserMessage(entryId: string): Promise<RewindEditorDraft> {
    return chatControllerHistory.rewindToUserMessage.call(
      this.chatControllerHistoryContext,
      entryId,
    );
  }

  private ensureTranscriptSessionIdentity(): void {
    return chatControllerSession.ensureTranscriptSessionIdentity.call(
      this.chatControllerSessionContext,
    );
  }

  private syncMessageSessionSubscription(sessionKey: string): Promise<boolean> {
    return chatControllerSession.syncMessageSessionSubscription.call(
      this.chatControllerSessionContext,
      sessionKey,
    );
  }

  private isConnectionInitializationCurrent(params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  }): boolean {
    return chatControllerSession.isConnectionInitializationCurrent.call(
      this.chatControllerSessionContext,
      params,
    );
  }

  private waitForInitialHistoryRetry(
    delayMs: number,
    params: { client: GatewayClient; sessionKey: string; initializationSeq: number },
  ): Promise<boolean> {
    return chatControllerSession.waitForInitialHistoryRetry.call(
      this.chatControllerSessionContext,
      delayMs,
      params,
    );
  }

  private loadInitialHistory(params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  }): Promise<void> {
    return chatControllerSession.loadInitialHistory.call(this.chatControllerSessionContext, params);
  }

  private hasExpectedInitialHistory(): boolean {
    return chatControllerSession.hasExpectedInitialHistory.call(this.chatControllerSessionContext);
  }

  private isExpectedInitialHistoryMessage(message: unknown): boolean {
    return chatControllerSession.isExpectedInitialHistoryMessage.call(
      this.chatControllerSessionContext,
      message,
    );
  }

  private findExpectedInitialHistoryIndex(messages: readonly unknown[]): number {
    return chatControllerSession.findExpectedInitialHistoryIndex.call(
      this.chatControllerSessionContext,
      messages,
    );
  }

  private admitExpectedInitialHistoryMessage(message: unknown): boolean {
    return chatControllerSession.admitExpectedInitialHistoryMessage.call(
      this.chatControllerSessionContext,
      message,
    );
  }

  private initializeConnectedSession(params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
    resumedTransport: boolean;
  }): Promise<void> {
    return chatControllerSession.initializeConnectedSession.call(
      this.chatControllerSessionContext,
      params,
    );
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
    return chatControllerCompaction.handleCompactionPhase.call(
      this.chatControllerCompactionContext,
      phase,
      sessionKey,
      data,
    );
  }

  private clearPostFinalHistoryReload(): void {
    return chatControllerRecovery.clearPostFinalHistoryReload.call(
      this.chatControllerRecoveryContext,
    );
  }

  private clearDeferredHistoryReload(): void {
    return chatControllerRecovery.clearDeferredHistoryReload.call(
      this.chatControllerRecoveryContext,
    );
  }

  private clearActiveToolHistoryCatchUp(): void {
    return chatControllerRecovery.clearActiveToolHistoryCatchUp.call(
      this.chatControllerRecoveryContext,
    );
  }

  private resetActiveToolHistoryCatchUpForRun(sessionKey: string): void {
    return chatControllerRecovery.resetActiveToolHistoryCatchUpForRun.call(
      this.chatControllerRecoveryContext,
      sessionKey,
    );
  }

  private observeSessionMessageSeq(
    sessionKey: string,
    sessionId: string | null,
    incomingSeq: number | null,
    loadedSeq: number | null,
  ): boolean {
    return chatControllerRecovery.observeSessionMessageSeq.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      sessionId,
      incomingSeq,
      loadedSeq,
    );
  }

  private recordLoadedSessionMessageSeq(
    sessionKey: string,
    sessionId: string | null,
    loadedSeq: number | null,
    resolvePendingCatchUp: boolean,
  ): void {
    return chatControllerRecovery.recordLoadedSessionMessageSeq.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      sessionId,
      loadedSeq,
      resolvePendingCatchUp,
    );
  }

  private claimActiveToolHistoryCatchUp(sessionKey: string, sessionId: string | null): boolean {
    return chatControllerRecovery.claimActiveToolHistoryCatchUp.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      sessionId,
    );
  }

  private hasPendingActiveToolHistoryCatchUp(
    sessionKey: string,
    sessionId: string | null,
  ): boolean {
    return chatControllerRecovery.hasPendingActiveToolHistoryCatchUp.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      sessionId,
    );
  }

  private scheduleActiveToolHistoryCatchUp(sessionKey: string, runId: string): void {
    return chatControllerRecovery.scheduleActiveToolHistoryCatchUp.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      runId,
    );
  }

  private scheduleDeferredHistoryReload(sessionKey: string, reason: string): void {
    return chatControllerRecovery.scheduleDeferredHistoryReload.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      reason,
    );
  }

  private postFinalHistoryHasCaughtUp(recovery: PostFinalHistoryRecovery): boolean {
    return chatControllerRecovery.postFinalHistoryHasCaughtUp.call(
      this.chatControllerRecoveryContext,
      recovery,
    );
  }

  private scheduleNextPostFinalHistoryReload(recovery: PostFinalHistoryRecovery): void {
    return chatControllerRecovery.scheduleNextPostFinalHistoryReload.call(
      this.chatControllerRecoveryContext,
      recovery,
    );
  }

  private schedulePostFinalHistoryReload(
    sessionKey: string,
    options: {
      runId: string | null;
      baselineMessageSeq: number | null;
      baselineCompleteMessageCount: number;
    },
  ): void {
    return chatControllerRecovery.schedulePostFinalHistoryReload.call(
      this.chatControllerRecoveryContext,
      sessionKey,
      options,
    );
  }

  private resetAssistantSnapshotSource(): void {
    this.assistantSnapshotRunId = null;
    this.ignoredDeltaAfterAssistantSnapshotCount = 0;
  }

  private isGatewayMethodAdvertised(method: string): boolean {
    const methods = this.state.hello?.features?.methods;
    return Array.isArray(methods) && methods.includes(method);
  }

  private rememberProgressCard(sessionKey: string, card: ProgressCard | null): void {
    return chatControllerProgress.rememberProgressCard.call(
      this.chatControllerProgressContext,
      sessionKey,
      card,
    );
  }

  private loadProgressCard(sessionKey: string, force = false): Promise<void> {
    return chatControllerProgress.loadProgressCard.call(
      this.chatControllerProgressContext,
      sessionKey,
      force,
    );
  }

  private handleProgressCardChanged(payload: unknown): void {
    return chatControllerProgress.handleProgressCardChanged.call(
      this.chatControllerProgressContext,
      payload,
    );
  }

  // ─── Connection ───────────────────────────────────────────────────────

  /**
   * Connect to the gateway and load chat history for the given session.
   * This replicates the webchat's connectGateway + loadChatHistory flow.
   */
  connect(url: string, token: string, sessionKey: string): Promise<void> {
    return chatControllerSession.connect.call(
      this.chatControllerSessionContext,
      url,
      token,
      sessionKey,
    );
  }

  /** Switch to a different session */
  switchSession(sessionKey: string, options: SwitchSessionOptions = {}): Promise<void> {
    return chatControllerSession.switchSession.call(
      this.chatControllerSessionContext,
      sessionKey,
      options,
    );
  }

  /** Disconnect and clean up */
  disconnect(): void {
    return chatControllerSession.disconnect.call(this.chatControllerSessionContext);
  }

  // ─── Gateway Callbacks ────────────────────────────────────────────────

  private handleHello(hello: GatewayHelloOk): void {
    return chatControllerSession.handleHello.call(this.chatControllerSessionContext, hello);
  }

  private handleClose(): void {
    return chatControllerSession.handleClose.call(this.chatControllerSessionContext);
  }

  private reconcileSuspendedRun(): Promise<void> {
    return chatControllerRecovery.reconcileSuspendedRun.call(this.chatControllerRecoveryContext);
  }

  private applyBackgroundChatEvent(
    payload: NormalizedChatEvent,
    suppressedErrorMessage?: string,
  ): void {
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
      !isChatTextRetraction(payload) &&
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
    const failedErrorMessage =
      suppressedErrorMessage ??
      (payload.state === 'error' ? (payload.errorMessage ?? 'Unknown error') : null);
    if (failedErrorMessage) {
      this.persistRunFailure(sessionKey, payload.sessionId, payload.runId, failedErrorMessage);
    }

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
    const reduceResult = reduceAgentEvent(cached.transcript, event, this.transcriptDependencies, {
      allowSequenceBackfill:
        event.deliveryEvent === 'session.tool' || hasStableProgressOwner(event),
    });
    if (reduceResult !== 'applied') return;

    if (event.stream === 'compaction') {
      const phase = typeof event.data.phase === 'string' ? event.data.phase : '';
      this.handleCompactionPhase(phase, sessionKey, event.data);
      return;
    }

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
      if (isInternalManagedSubagentHandoffError(errorMessage)) {
        this.applyBackgroundChatEvent(
          {
            runId: event.runId,
            sessionKey,
            sessionId: event.sessionId,
            lifecycleGeneration: event.lifecycleGeneration,
            frameSeq: event.frameSeq,
            state: 'final',
            replace: false,
          },
          errorMessage,
        );
        return;
      }
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

  /**
   * Gateway reports an internal Agent-stream sequence gap as an unsequenced
   * `stream:error` frame. It is transport recovery evidence, not a transcript
   * item, so only the exact selected-session/run owner may retire the socket.
   */
  private recoverFromInternalAgentSequenceGap(payloadValue: unknown): boolean {
    return chatControllerRecovery.recoverFromInternalAgentSequenceGap.call(
      this.chatControllerRecoveryContext,
      payloadValue,
    );
  }

  private handleEvent(event: GatewayEventFrame): void {
    traceTimelineController(event, this.state.transcript, 'before', this.state.chatRunId);
    try {
      this.handleTimelineEvent(event);
    } finally {
      traceTimelineController(event, this.state.transcript, 'after', this.state.chatRunId);
    }
  }

  private handleTimelineEvent(event: GatewayEventFrame): void {
    return chatControllerRecovery.handleTimelineEvent.call(
      this.chatControllerRecoveryContext,
      event,
    );
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

  private applyNormalizedAgentEvent(
    event: NormalizedAgentEvent,
    options: { replaySnapshot?: boolean } = {},
  ): void {
    const previousTurn = this.state.transcript.activeTurn;
    const previousHighWater = previousTurn?.runId === event.runId ? previousTurn.lastAgentSeq : -1;
    const reduceResult = reduceAgentEvent(
      this.state.transcript,
      event,
      this.transcriptDependencies,
      {
        allowSequenceBackfill:
          options.replaySnapshot === true ||
          event.deliveryEvent === 'session.tool' ||
          hasStableProgressOwner(event),
        replaySnapshot: options.replaySnapshot === true,
      },
    );
    if (reduceResult === 'applied') {
      // A bounded history snapshot can arrive after newer live activity. Its
      // missing owner still repairs the transcript, but must not rewind the
      // current run activity (for example responding -> thinking).
      if (event.agentSeq > previousHighWater) {
        this.handleAgentEvent(event);
      } else {
        this.notifyStream('terminal');
      }
      return;
    }
    debugLog('[ChatCtrl] Agent event ignored by ordered reducer', {
      runId: event.runId.slice(0, 12),
      agentSeq: event.agentSeq,
      stream: event.stream,
      result: reduceResult,
    });
  }

  private applySessionContextUsage(value: unknown, sessionKey: string): boolean {
    const next = readChatContextUsageSnapshot(value, sessionKey);
    if (!next) return false;
    const previous = this.state.contextUsage;
    const sameGeneration =
      previous !== null &&
      normalizeTranscriptSessionKey(previous.sessionKey) ===
        normalizeTranscriptSessionKey(next.sessionKey) &&
      (!previous.sessionId || !next.sessionId || previous.sessionId === next.sessionId);
    if (
      sameGeneration &&
      previous.updatedAt !== null &&
      next.updatedAt !== null &&
      next.updatedAt < previous.updatedAt
    ) {
      return false;
    }
    if (contextUsageSnapshotsEqual(previous, next)) return false;
    this.state.contextUsage = next;
    return true;
  }

  private applyInFlightRunSnapshot(
    snapshot: InFlightRunSnapshot | undefined,
    sessionKey: string,
    sessionId: string | null,
    requestRunId: string | null,
    sessionInfo: ChatHistorySnapshot['sessionInfo'],
  ): void {
    const runId = snapshot?.runId?.trim();
    if (!snapshot || !runId || this.state.sessionKey !== sessionKey) return;

    const currentRunId = this.state.chatRunId;
    const activeRunIds = sessionInfo?.activeRunIds;
    const terminalSnapshotRun = isTerminalRun(this.state.transcript, runId);
    const snapshotIsActive =
      sessionInfo?.hasActiveRun !== false &&
      (!Array.isArray(activeRunIds) || activeRunIds.includes(runId));
    const requestObservedRunRetirement = Boolean(requestRunId && !currentRunId);
    const canBindRequestedProvisionalRun = Boolean(
      currentRunId?.startsWith('justdo-') && currentRunId === requestRunId,
    );
    if (
      terminalSnapshotRun ||
      !snapshotIsActive ||
      requestObservedRunRetirement ||
      (currentRunId && currentRunId !== runId && !canBindRequestedProvisionalRun)
    ) {
      debugLog('[ChatCtrl] stale in-flight run snapshot ignored', {
        sessionKey,
        snapshotRunId: runId,
        requestRunId,
        currentRunId,
        terminalSnapshotRun: terminalSnapshotRun ?? null,
        hasActiveRun: sessionInfo?.hasActiveRun,
      });
      return;
    }

    const activeTurn = this.state.transcript.activeTurn;
    if (activeTurn && activeTurn.runId !== runId) {
      if (!canBindRequestedProvisionalRun || activeTurn.items.length > 0) return;
      this.bindAcknowledgedRun(sessionKey, activeTurn.runId, runId);
    }
    if (!this.state.transcript.activeTurn) {
      beginAssistantTurn(
        this.state.transcript,
        {
          runId,
          sessionId,
          startedAt:
            typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt)
              ? snapshot.startedAt
              : Date.now(),
        },
        this.transcriptDependencies,
      );
    }

    this.state.chatRunId = runId;
    this.state.chatSending = true;
    if (!this.state.runActivity || this.state.runActivity.runId !== runId) {
      this.beginRunActivity(
        runId,
        typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt)
          ? snapshot.startedAt
          : Date.now(),
      );
    }

    const replayEvents = Array.isArray(snapshot.events) ? [...snapshot.events] : [];
    replayEvents.sort((left, right) => left.seq - right.seq);
    for (const replayEvent of replayEvents) {
      if (!replayEvent || replayEvent.runId !== runId) continue;
      // Recovery is a sparse state snapshot, not a contiguous event log.
      // Replay only timeline owners; non-display state must not interfere
      // with queued live Thinking/Content or the separate live sequence fence.
      if (
        replayEvent.stream !== 'thinking' &&
        replayEvent.stream !== 'assistant' &&
        replayEvent.stream !== 'tool' &&
        !(
          replayEvent.stream === 'item' &&
          (readPreambleText(replayEvent.data ?? {}) !== null ||
            readToolProgressText(replayEvent.data ?? {}) !== null)
        )
      ) {
        continue;
      }
      const normalized = normalizeAgentEvent({
        deliveryEvent: 'agent',
        payload: {
          ...replayEvent,
          sessionKey: replayEvent.sessionKey ?? sessionKey,
        },
        allowAseqFallback: false,
      });
      if (normalized.event) {
        this.applyNormalizedAgentEvent(normalized.event, { replaySnapshot: true });
      }
    }

    // Native snapshots retain Tool/Preamble events; the Chat buffer owns reply
    // text. Restore that buffer without inventing an Agent event or consuming
    // its live sequence watermark. A suppression is not undone by an unversioned
    // buffer from a delayed read.
    const restoredTurn = this.state.transcript.activeTurn;
    const text = typeof snapshot.text === 'string' ? snapshot.text : '';
    if (
      restoredTurn &&
      restoredTurn.assistantSuppressionSeq === undefined &&
      (this.suspendedRunId === runId ||
        !restoredTurn.items.some(
          item => item.type === 'content' && item.preambleItemId === undefined &&
            item.text && item.recoveredSnapshotText !== item.text,
        )) &&
      text.trim() &&
      !isHiddenOrPendingControlReplyText(text) &&
      restoreInFlightContent(this.state.transcript, text, this.transcriptDependencies)
    ) {
      this.updateRunActivity(runId, 'responding', { modelActivity: true });
    }
    this.notifyStream();
  }

  private pendingHistoryReload = false;
  private historyLoadsInFlight = new Set<string>();
  private historyReloadRequested = new Set<string>();
  private immediateHistoryReloadRequested = new Set<string>();

  private resolveTranscriptImageUrl(mediaPath: string, sessionKey: string): Promise<string | null> {
    return chatControllerHistory.resolveTranscriptImageUrl.call(
      this.chatControllerHistoryContext,
      mediaPath,
      sessionKey,
    );
  }

  private resolveManagedHistoryImages(messages: unknown[], sessionKey: string): Promise<unknown[]> {
    return chatControllerHistory.resolveManagedHistoryImages.call(
      this.chatControllerHistoryContext,
      messages,
      sessionKey,
    );
  }

  private hydrateCurrentSessionImages(messages: unknown[], sessionKey: string): void {
    return chatControllerHistory.hydrateCurrentSessionImages.call(
      this.chatControllerHistoryContext,
      messages,
      sessionKey,
    );
  }

  private loadOlderHistoryPage(sessionKey: string, cursor: string): Promise<ChatHistoryPage> {
    return chatControllerHistory.loadOlderHistoryPage.call(
      this.chatControllerHistoryContext,
      sessionKey,
      cursor,
    );
  }

  private normalizeHistoryPage(messages: unknown[], sessionKey: string): Promise<unknown[]> {
    return chatControllerHistory.normalizeHistoryPage.call(
      this.chatControllerHistoryContext,
      messages,
      sessionKey,
    );
  }

  loadOlderHistory(): Promise<boolean> {
    return chatControllerHistory.loadOlderHistory.call(this.chatControllerHistoryContext);
  }

  // ─── History Loading ──────────────────────────────────────────────────

  loadHistory(
    queueIfBusy = false,
    options: {
      preferStartup?: boolean;
      reconcileSuspended?: boolean;
      backfillActiveSessionsYield?: boolean;
    } = {},
  ): Promise<boolean> {
    return chatControllerHistory.loadHistory.call(
      this.chatControllerHistoryContext,
      queueIfBusy,
      options,
    );
  }

  // ─── Chat Event Handling ──────────────────────────────────────────────

  private handleChatEvent(payload: NormalizedChatEvent): void {
    return chatControllerRecovery.handleChatEvent.call(this.chatControllerRecoveryContext, payload);
  }

  private handleDelta(payload: NormalizedChatEvent): void {
    return chatControllerRecovery.handleDelta.call(this.chatControllerRecoveryContext, payload);
  }

  private handleFinal(payload: NormalizedChatEvent): void {
    return chatControllerRecovery.handleFinal.call(this.chatControllerRecoveryContext, payload);
  }

  private handleAborted(payload: NormalizedChatEvent): void {
    return chatControllerRecovery.handleAborted.call(this.chatControllerRecoveryContext, payload);
  }

  private handleError(payload: NormalizedChatEvent): void {
    return chatControllerRecovery.handleError.call(this.chatControllerRecoveryContext, payload);
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
    return chatControllerRecovery.handleAgentEvent.call(
      this.chatControllerRecoveryContext,
      payload,
    );
  }

  // ─── Send Message ─────────────────────────────────────────────────────

  /** Send an isolated OpenClaw /btw turn without touching main chat state. */
  async sendSideQuestion(question: string, runId: string): Promise<string> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');
    const normalizedQuestion = question.trim().replace(/\s*[\r\n]+\s*/g, ' ');
    const proposedRunId = runId.trim();
    if (!normalizedQuestion) throw new Error('Side chat question is required');
    if (!proposedRunId) throw new Error('Side chat run id is required');

    const sessionKey = this.state.sessionKey;
    let trackedRunId = proposedRunId;
    let terminalAck = false;
    this.localSideChatRunIds.add(proposedRunId);
    this.pendingSideChats.set(proposedRunId, { question: normalizedQuestion, sessionKey });
    const transcript = createChatTranscriptState(sessionKey, this.state.currentSessionId);
    beginAssistantTurn(
      transcript,
      {
        runId: proposedRunId,
        sessionId: this.state.currentSessionId,
        startedAt: Date.now(),
      },
      this.transcriptDependencies,
    );
    this.sideChatTranscripts.set(proposedRunId, transcript);
    try {
      const ack = await client.request<{ runId?: string; status?: string }>('chat.send', {
        sessionKey,
        ...(this.state.currentSessionId ? { sessionId: this.state.currentSessionId } : {}),
        message: `/btw ${normalizedQuestion}`,
        deliver: false,
        justdoUserInitiated: true,
        idempotencyKey: proposedRunId,
      });
      const acceptedRunId = readNonBlankString(ack?.runId) ?? proposedRunId;
      if (acceptedRunId !== proposedRunId) {
        const pending = this.pendingSideChats.get(proposedRunId);
        const sideTranscript = this.sideChatTranscripts.get(proposedRunId);
        const hadAssistantSnapshot = this.sideChatAssistantSnapshotRunIds.has(proposedRunId);
        this.clearSideChatRun(proposedRunId);
        this.localSideChatRunIds.add(acceptedRunId);
        if (pending) this.pendingSideChats.set(acceptedRunId, pending);
        if (sideTranscript) {
          bindAssistantTurnRunId(sideTranscript, proposedRunId, acceptedRunId);
          this.sideChatTranscripts.set(acceptedRunId, sideTranscript);
        }
        if (hadAssistantSnapshot) this.sideChatAssistantSnapshotRunIds.add(acceptedRunId);
        trackedRunId = acceptedRunId;
      }
      if (ack?.status === 'error' || ack?.status === 'timeout') {
        terminalAck = true;
        this.clearSideChatRun(acceptedRunId);
        throw new Error(`Side chat ${ack.status}`);
      }
      return acceptedRunId;
    } catch (error) {
      this.pendingSideChats.delete(trackedRunId);
      this.sideChatTranscripts.delete(trackedRunId);
      this.sideChatAssistantSnapshotRunIds.delete(trackedRunId);
      if (!terminalAck) this.retainSideChatTombstone(trackedRunId);
      throw error;
    }
  }

  async sendMessage(
    message: string,
    attachments: CoworkAttachmentPayload[] = [],
    gatewayMessage = message,
    options: {
      propagateRequestFailure?: boolean;
      expectedSessionKey?: string;
      isCancelled?: () => boolean;
      onRequestUnknown?: (runId: string) => void | Promise<void>;
      clientTurnId?: string;
      onRunBound?: (runId: string) => void | Promise<void>;
    } = {},
  ): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');
    if (
      options.isCancelled?.() ||
      (options.expectedSessionKey && options.expectedSessionKey !== this.state.sessionKey)
    ) {
      throw new Error('The message submission context changed');
    }
    if (this.state.chatSending) throw new Error('A message is already being sent');

    const browserPrompt = parseBrowserAnnotationPrompt(gatewayMessage);
    const commandMessage = browserPrompt?.userText ?? gatewayMessage;
    const goalStartObjective = parseGoalStartObjective(commandMessage);
    const gatewayOutboundMessage = goalStartObjective ?? gatewayMessage;
    const displayMessage =
      extractGoalFollowUpRequest(commandMessage) ?? goalStartObjective ?? message;
    const slashCommand =
      goalStartObjective === null ? resolveSlashCommandBehavior(commandMessage) : null;
    if (slashCommand?.execution === SlashCommandExecution.Blocked) {
      const error = new Error(
        `The /${slashCommand.name} command is managed by the app and cannot be run from chat.`,
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
      const beforeSendHooks =
        goalStartObjective === null
          ? (slashCommand?.beforeSend ?? [])
          : [SlashCommandBeforeSendHook.EnsureSessionEntry];
      for (const hook of beforeSendHooks) {
        const handler = this.slashCommandBeforeSendHandlers.get(hook);
        if (!handler) throw new Error(`No slash command hook registered for ${hook}`);
        await handler(sessionKey);
        if (this.state.sessionKey !== sessionKey || options.isCancelled?.()) {
          throw new Error('The message submission context changed');
        }
      }
    } catch (error) {
      if (this.state.sessionKey !== sessionKey) throw error;
      const sessionError = error instanceof Error ? error : new Error(String(error));
      this.state.lastError = sessionError.message;
      this.notify();
      throw sessionError;
    }

    const goalStartSessionId =
      goalStartObjective === null ? null : this.state.currentSessionId?.trim();
    if (goalStartObjective !== null && !goalStartSessionId) {
      throw new Error('Gateway session identity is unavailable for Goal start');
    }

    const proposedRunId =
      options.clientTurnId?.trim() ||
      `justdo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const goalStartSignature =
      goalStartObjective === null
        ? null
        : JSON.stringify([
            sessionKey,
            goalStartSessionId,
            goalStartObjective,
            attachments.map(attachment => [
              attachment.name,
              attachment.mimeType,
              attachment.base64Data,
            ]),
          ]);
    let goalStartOperation = goalStartSignature
      ? (this.retainedGoalStartOperations.get(goalStartSignature) ?? null)
      : null;
    if (goalStartSignature && !goalStartOperation) {
      const encodedIssuedAtMs = /^justdo-(\d{10,16})-/.exec(proposedRunId)?.[1];
      goalStartOperation = {
        signature: goalStartSignature,
        operationId: proposedRunId,
        issuedAtMs: encodedIssuedAtMs ? Number(encodedIssuedAtMs) : Date.now(),
      };
      this.retainedGoalStartOperations.set(goalStartSignature, goalStartOperation);
    }
    const runId = goalStartOperation?.operationId ?? proposedRunId;
    debugLog('[ChatCtrl] sendMessage:', displayMessage.slice(0, 60), {
      sessionKey,
      runId,
    });
    this.clearPostFinalHistoryReload();
    this.clearDeferredHistoryReload();
    this.resetActiveToolHistoryCatchUpForRun(sessionKey);
    this.historyReloadRequested.delete(sessionKey);
    this.immediateHistoryReloadRequested.delete(sessionKey);
    this.pendingHistoryReload = false;

    // Optimistic: append user message immediately
    const attachmentBlocks = toAttachmentContentBlocks(attachments);
    const optimisticDisplayMessage =
      browserPrompt && goalStartObjective === null ? gatewayOutboundMessage : displayMessage;
    const rawUserMessage = {
      role: 'user',
      content:
        attachmentBlocks.length > 0
          ? [{ type: 'text', text: optimisticDisplayMessage }, ...attachmentBlocks]
          : optimisticDisplayMessage,
      timestamp: Date.now(),
      __openclaw: { idempotencyKey: runId, runId },
    };
    const userMessage = projectGatewayHistoryForDisplay([rawUserMessage])[0] ?? rawUserMessage;
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
      const ack = await client.request<
        SessionGoalMutationResult | { runId?: string; status?: string }
      >('chat.send', {
        sessionKey,
        ...(goalStartSessionId || this.state.currentSessionId
          ? { sessionId: goalStartSessionId || this.state.currentSessionId }
          : {}),
        message: gatewayOutboundMessage,
        ...(goalStartOperation
          ? {
              intent: {
                kind: 'session-goal-start',
                version: 1,
                issuedAtMs: goalStartOperation.issuedAtMs,
              },
            }
          : {}),
        deliver: false,
        justdoUserInitiated: true,
        idempotencyKey: runId,
        ...(gatewayAttachments.length > 0 ? { attachments: gatewayAttachments } : {}),
      });
      if (goalStartOperation) {
        const receipt = asRecord(ack);
        const receiptGoal = asRecord(receipt?.goal);
        if (
          receipt?.operationId !== runId ||
          receipt.action !== 'start' ||
          receipt.sessionId !== goalStartSessionId ||
          receipt.status !== 'started' ||
          receipt.runId !== runId ||
          typeof receipt.goalId !== 'string' ||
          !receipt.goalId.trim() ||
          (receipt.goal !== undefined && receiptGoal?.id !== receipt.goalId)
        ) {
          throw new Error('Gateway returned a mismatched Goal start receipt');
        }
      }
      try {
        await options.onRunBound?.(ack?.runId ?? runId);
      } catch (error) {
        debugLog('[ChatCtrl] failed to persist root run binding', error);
      }
      if (goalStartOperation && 'replayed' in ack && ack.replayed) {
        const [described, listed] = await Promise.all([
          client.request<{ session?: { goal?: unknown } | null }>('sessions.describe', {
            key: sessionKey,
          }),
          client.request<{ sessions?: unknown[] }>('sessions.list', {
            search: sessionKey,
            limit: 20,
          }),
        ]);
        const runtimeRow = (listed.sessions ?? []).map(asRecord).find(row => {
          const key = typeof row?.key === 'string' ? row.key : '';
          return normalizeTranscriptSessionKey(key) === normalizeTranscriptSessionKey(sessionKey);
        });
        const activeRunIds = readStringList(runtimeRow?.activeRunIds);
        const currentGoal = normalizeSessionGoal(described.session?.goal);
        const replayStillCurrent =
          activeRunIds.includes(runId) &&
          currentGoal?.id === ack.goalId &&
          currentGoal.status === SessionGoalStatus.Active;
        if (!replayStillCurrent) {
          if (
            goalStartSignature &&
            this.retainedGoalStartOperations.get(goalStartSignature) === goalStartOperation
          ) {
            this.retainedGoalStartOperations.delete(goalStartSignature);
          }
          this.settleChatSend(sessionKey, runId, 'final');
          void this.loadHistory(true);
          return;
        }
      }
      if (
        goalStartOperation &&
        goalStartSignature &&
        this.retainedGoalStartOperations.get(goalStartSignature) === goalStartOperation
      ) {
        this.retainedGoalStartOperations.delete(goalStartSignature);
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
      // A lost ACK does not prove rejection. Keep its operation identity live.
      const definitiveRejection = goalStartOperation
        ? isDefinitiveSessionGoalGatewayError(err)
        : typeof asRecord(err)?.gatewayCode === 'string';
      if (options.onRequestUnknown && !definitiveRejection) {
        await options.onRequestUnknown(runId);
        throw err;
      }
      if (
        goalStartOperation &&
        goalStartSignature &&
        this.retainedGoalStartOperations.get(goalStartSignature) === goalStartOperation &&
        isDefinitiveSessionGoalGatewayError(err)
      ) {
        this.retainedGoalStartOperations.delete(goalStartSignature);
      }
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

  cancelManualCompaction(sessionKey: string): Promise<void> {
    return chatControllerCompaction.cancelManualCompaction.call(
      this.chatControllerCompactionContext,
      sessionKey,
    );
  }

  private compactSession(_argumentsText = ''): Promise<void> {
    return chatControllerCompaction.compactSession.call(
      this.chatControllerCompactionContext,
      _argumentsText,
    );
  }

  private loadCompactionCheckpoints(
    sessionKey = this.state.sessionKey,
  ): Promise<CompactionCheckpoint[]> {
    return chatControllerCompaction.loadCompactionCheckpoints.call(
      this.chatControllerCompactionContext,
      sessionKey,
    );
  }

  private enrichCompactionMarkers(
    messages: unknown[],
    sessionKey = this.state.sessionKey,
  ): Promise<unknown[]> {
    return chatControllerCompaction.enrichCompactionMarkers.call(
      this.chatControllerCompactionContext,
      messages,
      sessionKey,
    );
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

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly chatControllerHistoryContext: ChatControllerHistoryContext =
    createPropertyContext<ChatControllerHistoryContext>({
      currentMessageHistory: { get: () => this.currentMessageHistory },
      state: { get: () => this.state },
      cacheSessionMessages: { get: () => this.cacheSessionMessages.bind(this) },
      transcriptDependencies: { get: () => this.transcriptDependencies },
      updateRunActivity: { get: () => this.updateRunActivity.bind(this) },
      notifyStream: { get: () => this.notifyStream.bind(this) },
      notify: { get: () => this.notify.bind(this) },
      historyPaginationBySession: { get: () => this.historyPaginationBySession },
      historyPaginationAdvanced: {
        get: () => this.historyPaginationAdvanced,
        set: value => {
          this.historyPaginationAdvanced = value;
        },
      },
      applyHistoryWindow: { get: () => this.applyHistoryWindow.bind(this) },
      loadOlderHistory: { get: () => this.loadOlderHistory.bind(this) },
      newerHistoryNavigationRevision: {
        get: () => this.newerHistoryNavigationRevision,
        set: value => {
          this.newerHistoryNavigationRevision = value;
        },
      },
      chatMessagesBySession: { get: () => this.chatMessagesBySession },
      historySourceBySession: { get: () => this.historySourceBySession },
      displayedHistoryLeafBySession: { get: () => this.displayedHistoryLeafBySession },
      historyPagingGeneration: {
        get: () => this.historyPagingGeneration,
        set: value => {
          this.historyPagingGeneration = value;
        },
      },
      resetHistoryPagination: { get: () => this.resetHistoryPagination.bind(this) },
      resetTranscriptForSession: { get: () => this.resetTranscriptForSession.bind(this) },
      setCurrentSessionMessages: { get: () => this.setCurrentSessionMessages.bind(this) },
      loadHistory: { get: () => this.loadHistory.bind(this) },
      scheduleDeferredHistoryReload: { get: () => this.scheduleDeferredHistoryReload.bind(this) },
      transcriptImageCache: { get: () => this.transcriptImageCache },
      transcriptImageReadsActive: {
        get: () => this.transcriptImageReadsActive,
        set: value => {
          this.transcriptImageReadsActive = value;
        },
      },
      transcriptImageReadWaiters: { get: () => this.transcriptImageReadWaiters },
      resolveTranscriptImageUrl: { get: () => this.resolveTranscriptImageUrl.bind(this) },
      resolveManagedHistoryImages: { get: () => this.resolveManagedHistoryImages.bind(this) },
      enrichCompactionMarkers: { get: () => this.enrichCompactionMarkers.bind(this) },
      loadOlderHistoryPage: { get: () => this.loadOlderHistoryPage.bind(this) },
      normalizeHistoryPage: { get: () => this.normalizeHistoryPage.bind(this) },
      findExpectedInitialHistoryIndex: {
        get: () => this.findExpectedInitialHistoryIndex.bind(this),
      },
      expectInitialHistory: { get: () => this.expectInitialHistory },
      rememberHistoryPagination: { get: () => this.rememberHistoryPagination.bind(this) },
      ensureTranscriptSessionIdentity: {
        get: () => this.ensureTranscriptSessionIdentity.bind(this),
      },
      historyLoadsInFlight: { get: () => this.historyLoadsInFlight },
      historyReloadRequested: { get: () => this.historyReloadRequested },
      immediateHistoryReloadRequested: { get: () => this.immediateHistoryReloadRequested },
      _snap: { get: () => this._snap.bind(this) },
      historyLoadSeq: {
        get: () => this.historyLoadSeq,
        set: value => {
          this.historyLoadSeq = value;
        },
      },
      applySessionContextUsage: { get: () => this.applySessionContextUsage.bind(this) },
      projectLocalCompactionStatus: { get: () => this.projectLocalCompactionStatus.bind(this) },
      recordLoadedSessionMessageSeq: { get: () => this.recordLoadedSessionMessageSeq.bind(this) },
      hydrateActiveToolItemsFromHistory: {
        get: () => this.hydrateActiveToolItemsFromHistory.bind(this),
      },
      publishActiveToolHistoryRepair: { get: () => this.publishActiveToolHistoryRepair.bind(this) },
      applyInFlightRunSnapshot: { get: () => this.applyInFlightRunSnapshot.bind(this) },
      rememberRunModel: { get: () => this.rememberRunModel.bind(this) },
      localCompactionStatusBySession: { get: () => this.localCompactionStatusBySession },
      deferredHistoryReloadAttempts: { get: () => this.deferredHistoryReloadAttempts },
      hydrateCurrentSessionImages: { get: () => this.hydrateCurrentSessionImages.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly chatControllerCompactionContext: ChatControllerCompactionContext =
    createPropertyContext<ChatControllerCompactionContext>({
      isSelectedSession: { get: () => this.isSelectedSession.bind(this) },
      state: { get: () => this.state },
      findLiveSessionState: { get: () => this.findLiveSessionState.bind(this) },
      chatMessagesBySession: { get: () => this.chatMessagesBySession },
      setCurrentSessionMessages: { get: () => this.setCurrentSessionMessages.bind(this) },
      localCompactionStatusBySession: { get: () => this.localCompactionStatusBySession },
      deferredHistoryReloadAttempts: { get: () => this.deferredHistoryReloadAttempts },
      updateLocalCompactionMessage: { get: () => this.updateLocalCompactionMessage.bind(this) },
      transcriptIdSequence: {
        get: () => this.transcriptIdSequence,
        set: value => {
          this.transcriptIdSequence = value;
        },
      },
      settledCompactionEventIds: { get: () => this.settledCompactionEventIds },
      beginLocalCompactionStatus: { get: () => this.beginLocalCompactionStatus.bind(this) },
      updateLocalCompactionSummary: { get: () => this.updateLocalCompactionSummary.bind(this) },
      clearLifecycleEndFallback: { get: () => this.clearLifecycleEndFallback.bind(this) },
      notifyStream: { get: () => this.notifyStream.bind(this) },
      notify: { get: () => this.notify.bind(this) },
      completeLocalCompactionStatus: { get: () => this.completeLocalCompactionStatus.bind(this) },
      projectLocalCompactionStatus: { get: () => this.projectLocalCompactionStatus.bind(this) },
      terminalLifecycleSeen: { get: () => this.terminalLifecycleSeen },
      scheduleChatLifecycleEndFallback: {
        get: () => this.scheduleChatLifecycleEndFallback.bind(this),
      },
      scheduleDeferredHistoryReload: { get: () => this.scheduleDeferredHistoryReload.bind(this) },
      manualCompactionOperations: { get: () => this.manualCompactionOperations },
      settleCompactionRequest: { get: () => this.settleCompactionRequest.bind(this) },
      manualCompactionRequestIdsBySession: { get: () => this.manualCompactionRequestIdsBySession },
      loadHistory: { get: () => this.loadHistory.bind(this) },
      loadCompactionCheckpoints: { get: () => this.loadCompactionCheckpoints.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly chatControllerRecoveryContext: ChatControllerRecoveryContext =
    createPropertyContext<ChatControllerRecoveryContext>({
      postFinalHistoryReloadTimer: {
        get: () => this.postFinalHistoryReloadTimer,
        set: value => {
          this.postFinalHistoryReloadTimer = value;
        },
      },
      postFinalHistoryRecovery: {
        get: () => this.postFinalHistoryRecovery,
        set: value => {
          this.postFinalHistoryRecovery = value;
        },
      },
      deferredHistoryReloadTimer: {
        get: () => this.deferredHistoryReloadTimer,
        set: value => {
          this.deferredHistoryReloadTimer = value;
        },
      },
      activeToolHistoryCatchUpTimer: {
        get: () => this.activeToolHistoryCatchUpTimer,
        set: value => {
          this.activeToolHistoryCatchUpTimer = value;
        },
      },
      clearActiveToolHistoryCatchUp: { get: () => this.clearActiveToolHistoryCatchUp.bind(this) },
      observedSessionMessageSeqBySession: { get: () => this.observedSessionMessageSeqBySession },
      state: { get: () => this.state },
      historyLoadsInFlight: { get: () => this.historyLoadsInFlight },
      scheduleActiveToolHistoryCatchUp: {
        get: () => this.scheduleActiveToolHistoryCatchUp.bind(this),
      },
      claimActiveToolHistoryCatchUp: { get: () => this.claimActiveToolHistoryCatchUp.bind(this) },
      loadHistory: { get: () => this.loadHistory.bind(this) },
      hasPendingActiveToolHistoryCatchUp: {
        get: () => this.hasPendingActiveToolHistoryCatchUp.bind(this),
      },
      deferredHistoryReloadAttempts: { get: () => this.deferredHistoryReloadAttempts },
      _snap: { get: () => this._snap.bind(this) },
      historyReloadRequested: { get: () => this.historyReloadRequested },
      hasExpectedInitialHistory: { get: () => this.hasExpectedInitialHistory.bind(this) },
      scheduleDeferredHistoryReload: { get: () => this.scheduleDeferredHistoryReload.bind(this) },
      postFinalHistoryHasCaughtUp: { get: () => this.postFinalHistoryHasCaughtUp.bind(this) },
      scheduleNextPostFinalHistoryReload: {
        get: () => this.scheduleNextPostFinalHistoryReload.bind(this),
      },
      clearPostFinalHistoryReload: { get: () => this.clearPostFinalHistoryReload.bind(this) },
      suspendedRunId: {
        get: () => this.suspendedRunId,
        set: value => {
          this.suspendedRunId = value;
        },
      },
      clearRunActivity: { get: () => this.clearRunActivity.bind(this) },
      notify: { get: () => this.notify.bind(this) },
      transcriptDependencies: { get: () => this.transcriptDependencies },
      handleAborted: { get: () => this.handleAborted.bind(this) },
      isSelectedSession: { get: () => this.isSelectedSession.bind(this) },
      localSideChatRunIds: { get: () => this.localSideChatRunIds },
      pendingSideChats: { get: () => this.pendingSideChats },
      sideChatResultListeners: { get: () => this.sideChatResultListeners },
      clearSideChatTranscript: { get: () => this.clearSideChatTranscript.bind(this) },
      handleProgressCardChanged: { get: () => this.handleProgressCardChanged.bind(this) },
      sideChatTranscripts: { get: () => this.sideChatTranscripts },
      sideChatAssistantSnapshotRunIds: { get: () => this.sideChatAssistantSnapshotRunIds },
      publishSideChatStream: { get: () => this.publishSideChatStream.bind(this) },
      publishSideChatFailure: { get: () => this.publishSideChatFailure.bind(this) },
      retainSideChatTombstone: { get: () => this.retainSideChatTombstone.bind(this) },
      ensureTranscriptSessionIdentity: {
        get: () => this.ensureTranscriptSessionIdentity.bind(this),
      },
      applyBackgroundChatEvent: { get: () => this.applyBackgroundChatEvent.bind(this) },
      flushPendingAnnounceEvents: { get: () => this.flushPendingAnnounceEvents.bind(this) },
      pendingAnnounceEvents: { get: () => this.pendingAnnounceEvents },
      assistantSnapshotRunId: {
        get: () => this.assistantSnapshotRunId,
        set: value => {
          this.assistantSnapshotRunId = value;
        },
      },
      ignoredDeltaAfterAssistantSnapshotCount: {
        get: () => this.ignoredDeltaAfterAssistantSnapshotCount,
        set: value => {
          this.ignoredDeltaAfterAssistantSnapshotCount = value;
        },
      },
      persistRunFailure: { get: () => this.persistRunFailure.bind(this) },
      handleChatEvent: { get: () => this.handleChatEvent.bind(this) },
      recoverFromInternalAgentSequenceGap: {
        get: () => this.recoverFromInternalAgentSequenceGap.bind(this),
      },
      findLiveSessionState: { get: () => this.findLiveSessionState.bind(this) },
      applyBackgroundAgentEvent: { get: () => this.applyBackgroundAgentEvent.bind(this) },
      applyNormalizedAgentEvent: { get: () => this.applyNormalizedAgentEvent.bind(this) },
      bufferPendingAnnounceEvent: { get: () => this.bufferPendingAnnounceEvent.bind(this) },
      resetTranscriptForSession: { get: () => this.resetTranscriptForSession.bind(this) },
      historyPagingGeneration: {
        get: () => this.historyPagingGeneration,
        set: value => {
          this.historyPagingGeneration = value;
        },
      },
      resetHistoryPagination: { get: () => this.resetHistoryPagination.bind(this) },
      displayedHistoryLeafBySession: { get: () => this.displayedHistoryLeafBySession },
      pendingHistoryReload: {
        get: () => this.pendingHistoryReload,
        set: value => {
          this.pendingHistoryReload = value;
        },
      },
      expectedPlanImplementationReset: {
        get: () => this.expectedPlanImplementationReset,
        set: value => {
          this.expectedPlanImplementationReset = value;
        },
      },
      currentMessageHistory: { get: () => this.currentMessageHistory },
      setCurrentSessionMessages: { get: () => this.setCurrentSessionMessages.bind(this) },
      applySessionContextUsage: { get: () => this.applySessionContextUsage.bind(this) },
      admitExpectedInitialHistoryMessage: {
        get: () => this.admitExpectedInitialHistoryMessage.bind(this),
      },
      hydrateActiveToolItemsFromHistory: {
        get: () => this.hydrateActiveToolItemsFromHistory.bind(this),
      },
      publishActiveToolHistoryRepair: { get: () => this.publishActiveToolHistoryRepair.bind(this) },
      rememberRunModel: { get: () => this.rememberRunModel.bind(this) },
      hydrateCurrentSessionImages: { get: () => this.hydrateCurrentSessionImages.bind(this) },
      observeSessionMessageSeq: { get: () => this.observeSessionMessageSeq.bind(this) },
      localCompactionStatusBySession: { get: () => this.localCompactionStatusBySession },
      handleCompactionPhase: { get: () => this.handleCompactionPhase.bind(this) },
      acceptRunId: { get: () => this.acceptRunId.bind(this) },
      handleDelta: { get: () => this.handleDelta.bind(this) },
      handleFinal: { get: () => this.handleFinal.bind(this) },
      handleError: { get: () => this.handleError.bind(this) },
      updateRunActivity: { get: () => this.updateRunActivity.bind(this) },
      notifyStream: { get: () => this.notifyStream.bind(this) },
      clearLifecycleEndFallback: { get: () => this.clearLifecycleEndFallback.bind(this) },
      finishCurrentTurnTiming: { get: () => this.finishCurrentTurnTiming.bind(this) },
      terminalLifecycleSeen: {
        get: () => this.terminalLifecycleSeen,
        set: value => {
          this.terminalLifecycleSeen = value;
        },
      },
      resetAssistantSnapshotSource: { get: () => this.resetAssistantSnapshotSource.bind(this) },
      messageSubscriptionSeq: { get: () => this.messageSubscriptionSeq },
      subscribedMessageSessionKey: { get: () => this.subscribedMessageSessionKey },
      schedulePostFinalHistoryReload: { get: () => this.schedulePostFinalHistoryReload.bind(this) },
      flushPendingHistoryReload: { get: () => this.flushPendingHistoryReload.bind(this) },
      resetActiveToolHistoryCatchUpForRun: {
        get: () => this.resetActiveToolHistoryCatchUpForRun.bind(this),
      },
      scheduleChatLifecycleEndFallback: {
        get: () => this.scheduleChatLifecycleEndFallback.bind(this),
      },
      clearLocalCompactionStatus: { get: () => this.clearLocalCompactionStatus.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly chatControllerSessionContext: ChatControllerSessionContext =
    createPropertyContext<ChatControllerSessionContext>({
      chatMessagesBySession: { get: () => this.chatMessagesBySession },
      historySourceBySession: { get: () => this.historySourceBySession },
      state: { get: () => this.state },
      liveStateBySession: { get: () => this.liveStateBySession },
      clearRunActivityTimer: { get: () => this.clearRunActivityTimer.bind(this) },
      runProbeToken: {
        get: () => this.runProbeToken,
        set: value => {
          this.runProbeToken = value;
        },
      },
      cacheCurrentTurnTiming: { get: () => this.cacheCurrentTurnTiming.bind(this) },
      terminalLifecycleSeen: {
        get: () => this.terminalLifecycleSeen,
        set: value => {
          this.terminalLifecycleSeen = value;
        },
      },
      assistantSnapshotRunId: {
        get: () => this.assistantSnapshotRunId,
        set: value => {
          this.assistantSnapshotRunId = value;
        },
      },
      ignoredDeltaAfterAssistantSnapshotCount: {
        get: () => this.ignoredDeltaAfterAssistantSnapshotCount,
        set: value => {
          this.ignoredDeltaAfterAssistantSnapshotCount = value;
        },
      },
      findLiveSessionState: { get: () => this.findLiveSessionState.bind(this) },
      resetAssistantSnapshotSource: { get: () => this.resetAssistantSnapshotSource.bind(this) },
      scheduleRunActivityCheck: { get: () => this.scheduleRunActivityCheck.bind(this) },
      scheduleChatLifecycleEndFallback: {
        get: () => this.scheduleChatLifecycleEndFallback.bind(this),
      },
      historyPaginationBySession: { get: () => this.historyPaginationBySession },
      displayedHistoryLeafBySession: { get: () => this.displayedHistoryLeafBySession },
      isSelectedSession: { get: () => this.isSelectedSession.bind(this) },
      turnTimingBySession: { get: () => this.turnTimingBySession },
      pendingAnnounceEvents: { get: () => this.pendingAnnounceEvents },
      observedSessionMessageSeqBySession: { get: () => this.observedSessionMessageSeqBySession },
      finishTurnTimingForSession: { get: () => this.finishTurnTimingForSession.bind(this) },
      resetTranscriptForSession: { get: () => this.resetTranscriptForSession.bind(this) },
      subscribedMessageSessionKey: {
        get: () => this.subscribedMessageSessionKey,
        set: value => {
          this.subscribedMessageSessionKey = value;
        },
      },
      messageSubscriptionSeq: {
        get: () => this.messageSubscriptionSeq,
        set: value => {
          this.messageSubscriptionSeq = value;
        },
      },
      connectionInitializationSeq: {
        get: () => this.connectionInitializationSeq,
        set: value => {
          this.connectionInitializationSeq = value;
        },
      },
      isConnectionInitializationCurrent: {
        get: () => this.isConnectionInitializationCurrent.bind(this),
      },
      loadHistory: { get: () => this.loadHistory.bind(this) },
      hasExpectedInitialHistory: { get: () => this.hasExpectedInitialHistory.bind(this) },
      loadOlderHistory: { get: () => this.loadOlderHistory.bind(this) },
      initialHistoryRetryDelaysMs: { get: () => this.initialHistoryRetryDelaysMs },
      waitForInitialHistoryRetry: { get: () => this.waitForInitialHistoryRetry.bind(this) },
      notify: { get: () => this.notify.bind(this) },
      expectInitialHistory: { get: () => this.expectInitialHistory },
      findExpectedInitialHistoryIndex: {
        get: () => this.findExpectedInitialHistoryIndex.bind(this),
      },
      expectInitialUserMessage: { get: () => this.expectInitialUserMessage },
      isExpectedInitialHistoryMessage: {
        get: () => this.isExpectedInitialHistoryMessage.bind(this),
      },
      pendingHistoryReload: {
        get: () => this.pendingHistoryReload,
        set: value => {
          this.pendingHistoryReload = value;
        },
      },
      setCurrentSessionMessages: { get: () => this.setCurrentSessionMessages.bind(this) },
      hydrateCurrentSessionImages: { get: () => this.hydrateCurrentSessionImages.bind(this) },
      loadProgressCard: { get: () => this.loadProgressCard.bind(this) },
      syncMessageSessionSubscription: { get: () => this.syncMessageSessionSubscription.bind(this) },
      initialMessageSubscriptionBarrierTimeoutMs: {
        get: () => this.initialMessageSubscriptionBarrierTimeoutMs,
      },
      suspendedRunId: {
        get: () => this.suspendedRunId,
        set: value => {
          this.suspendedRunId = value;
        },
      },
      reconcileSuspendedRun: { get: () => this.reconcileSuspendedRun.bind(this) },
      loadInitialHistory: { get: () => this.loadInitialHistory.bind(this) },
      manualCompactionRequestIdsBySession: { get: () => this.manualCompactionRequestIdsBySession },
      settleCompactionRequest: { get: () => this.settleCompactionRequest.bind(this) },
      clearLocalCompactionStatus: { get: () => this.clearLocalCompactionStatus.bind(this) },
      rememberHistoryPagination: { get: () => this.rememberHistoryPagination.bind(this) },
      progressCardLoadGeneration: {
        get: () => this.progressCardLoadGeneration,
        set: value => {
          this.progressCardLoadGeneration = value;
        },
      },
      progressCardCache: { get: () => this.progressCardCache },
      historyPagingGeneration: {
        get: () => this.historyPagingGeneration,
        set: value => {
          this.historyPagingGeneration = value;
        },
      },
      restoreHistoryPagination: { get: () => this.restoreHistoryPagination.bind(this) },
      currentMessageHistory: {
        get: () => this.currentMessageHistory,
        set: value => {
          this.currentMessageHistory = value;
        },
      },
      beginRunActivity: { get: () => this.beginRunActivity.bind(this) },
      clearRunActivity: { get: () => this.clearRunActivity.bind(this) },
      handleHello: { get: () => this.handleHello.bind(this) },
      handleEvent: { get: () => this.handleEvent.bind(this) },
      handleClose: { get: () => this.handleClose.bind(this) },
      expectedPlanImplementationReset: {
        get: () => this.expectedPlanImplementationReset,
        set: value => {
          this.expectedPlanImplementationReset = value;
        },
      },
      clearLifecycleEndFallback: { get: () => this.clearLifecycleEndFallback.bind(this) },
      cacheCurrentLiveState: { get: () => this.cacheCurrentLiveState.bind(this) },
      promoteCachedSessionState: { get: () => this.promoteCachedSessionState.bind(this) },
      restoreLiveState: { get: () => this.restoreLiveState.bind(this) },
      clearPostFinalHistoryReload: { get: () => this.clearPostFinalHistoryReload.bind(this) },
      clearDeferredHistoryReload: { get: () => this.clearDeferredHistoryReload.bind(this) },
      clearActiveToolHistoryCatchUp: { get: () => this.clearActiveToolHistoryCatchUp.bind(this) },
      initializeConnectedSession: { get: () => this.initializeConnectedSession.bind(this) },
      settledCompactionEventIds: { get: () => this.settledCompactionEventIds },
      localCompactionStatusBySession: { get: () => this.localCompactionStatusBySession },
      clearAllSideChatRuns: { get: () => this.clearAllSideChatRuns.bind(this) },
      historyReloadRequested: { get: () => this.historyReloadRequested },
      immediateHistoryReloadRequested: { get: () => this.immediateHistoryReloadRequested },
      isGatewayMethodAdvertised: { get: () => this.isGatewayMethodAdvertised.bind(this) },
      pendingSideChats: { get: () => this.pendingSideChats },
      publishSideChatFailure: { get: () => this.publishSideChatFailure.bind(this) },
      retainSideChatTombstone: { get: () => this.retainSideChatTombstone.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly chatControllerProgressContext: ChatControllerProgressContext =
    createPropertyContext<ChatControllerProgressContext>({
      state: { get: () => this.state },
      isGatewayMethodAdvertised: { get: () => this.isGatewayMethodAdvertised.bind(this) },
      progressCardLoadGeneration: {
        get: () => this.progressCardLoadGeneration,
        set: value => {
          this.progressCardLoadGeneration = value;
        },
      },
      rememberProgressCard: { get: () => this.rememberProgressCard.bind(this) },
      notify: { get: () => this.notify.bind(this) },
      progressCardCache: { get: () => this.progressCardCache },
      loadProgressCard: { get: () => this.loadProgressCard.bind(this) },
    });
}

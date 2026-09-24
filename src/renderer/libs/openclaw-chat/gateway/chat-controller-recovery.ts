import { isPresentPlanToolName } from '@shared/cowork/planPreview';
import {
  normalizeAgentEvent,
  normalizeChatEvent,
  type NormalizedAgentEvent,
  type NormalizedChatEvent,
  readTerminalGuardObservation,
} from '@shared/openclaw/agentEvent';
import { isInternalManagedSubagentHandoffError } from '@shared/openclaw/internalRunError';
import { readModelRef } from '@shared/openclaw/modelRef';

import { isTruncatedHistoryMessage } from '@/libs/openclaw-chat/gateway/chat-history-protocol';
import type { GatewayEventFrame } from '@/libs/openclaw-chat/gateway/client';
import {
  readPreambleText,
  reduceAgentEvent,
  reduceChatEvent,
} from '@/libs/openclaw-chat/model/agent-event-reducer';
import {
  type AssistantTurn,
  type AssistantTurnTiming,
  beginAssistantTurn,
  type ChatTranscriptState,
  isTerminalRun,
  normalizeTranscriptSessionKey,
  type TranscriptReducerDependencies,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/chunked-message-history';
import {
  isLocallyOptimisticHistoryTail,
  markOptimisticHistoryTail,
} from '@/libs/openclaw-chat/model/optimistic-history-tail';
import { isPendingUserMessageMatch } from '@/libs/openclaw-chat/model/optimistic-user-message';
import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';
import { type RunProgressStage } from '@/libs/openclaw-chat/model/run-activity';
import { applySessionMessagePayload } from '@/libs/openclaw-chat/model/session-message-apply';
import {
  persistInterruptedMessage,
  projectGatewayHistoryForDisplay,
  shouldHideMessage,
  stripAssistantSilentReplySuffix,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import {
  ACTIVE_TOOL_HISTORY_CATCHUP_DELAY_MS,
  appendTerminalMessage,
  asRecord,
  assistantEventText,
  buildInterruptedTurnMessage,
  ChatState,
  ChatStreamUpdateKind,
  collectActiveContentText,
  collectActiveThinkingText,
  completeTruncatedTerminalFromActiveTurn,
  debugLog,
  DEFERRED_HISTORY_RELOAD_DELAY_MS,
  extractSnapshotText,
  hasStableProgressOwner,
  isDormantAnnounceControlEvent,
  isDormantAnnounceRun,
  isHiddenOrPendingControlReplyText,
  isNonTerminalToolPhase,
  isTerminalToolPhase,
  LocalCompactionStatus,
  MAX_ACTIVE_TOOL_HISTORY_CATCHUP_ATTEMPTS,
  MAX_DEFERRED_HISTORY_CATCHUP_ATTEMPTS,
  MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS,
  normalizeSessionId,
  PostFinalHistoryRecovery,
  readExplicitMessageRunId,
  readLatestOpenClawMessageSeq,
  readNonBlankString,
  readOpenClawMessageSeq,
  readPositiveSafeInteger,
  readStringList,
  SessionLiveState,
  SideChatResult,
  SideChatResultListener,
  SILENT_REPLY_PATTERN,
  summarizeHistoryForDebug,
  summarizeMessageForDebug,
  withThinkingContent,
} from './chat-controller-support';
export interface ChatControllerRecoveryContext {
  postFinalHistoryReloadTimer: NodeJS.Timeout | null;
  postFinalHistoryRecovery: PostFinalHistoryRecovery | null;
  deferredHistoryReloadTimer: NodeJS.Timeout | null;
  activeToolHistoryCatchUpTimer: NodeJS.Timeout | null;
  readonly clearActiveToolHistoryCatchUp: () => void;
  readonly observedSessionMessageSeqBySession: Map<
    string,
    {
      sessionId: string | null;
      seq: number | null;
      pendingCatchUp: boolean;
      catchUpTargetSeq: number | null;
      catchUpAttempts: number;
      unsequencedCatchUpCompleted: boolean;
    }
  >;
  readonly state: ChatState;
  readonly historyLoadsInFlight: Set<string>;
  readonly scheduleActiveToolHistoryCatchUp: (sessionKey: string, runId: string) => void;
  readonly claimActiveToolHistoryCatchUp: (sessionKey: string, sessionId: string | null) => boolean;
  readonly loadHistory: (
    queueIfBusy?: boolean,
    options?: {
      preferStartup?: boolean;
      reconcileSuspended?: boolean;
      backfillActiveSessionsYield?: boolean;
    },
  ) => Promise<boolean>;
  readonly hasPendingActiveToolHistoryCatchUp: (
    sessionKey: string,
    sessionId: string | null,
  ) => boolean;
  readonly deferredHistoryReloadAttempts: Map<string, number>;
  readonly _snap: () => Record<string, unknown>;
  readonly historyReloadRequested: Set<string>;
  readonly hasExpectedInitialHistory: () => boolean;
  readonly scheduleDeferredHistoryReload: (sessionKey: string, reason: string) => void;
  readonly postFinalHistoryHasCaughtUp: (recovery: PostFinalHistoryRecovery) => boolean;
  readonly scheduleNextPostFinalHistoryReload: (recovery: PostFinalHistoryRecovery) => void;
  readonly clearPostFinalHistoryReload: () => void;
  suspendedRunId: string | null;
  readonly clearRunActivity: () => void;
  readonly notify: () => void;
  readonly transcriptDependencies: TranscriptReducerDependencies;
  readonly handleAborted: (payload: NormalizedChatEvent) => void;
  readonly isSelectedSession: (sessionKey: string) => boolean;
  readonly localSideChatRunIds: Set<string>;
  readonly pendingSideChats: Map<string, { question: string; sessionKey: string }>;
  readonly sideChatResultListeners: Set<SideChatResultListener>;
  readonly clearSideChatTranscript: (
    runId: string,
    sessionKey: string,
    kind?: ChatStreamUpdateKind,
  ) => void;
  readonly handleProgressCardChanged: (payload: unknown) => void;
  readonly sideChatTranscripts: Map<string, ChatTranscriptState>;
  readonly sideChatAssistantSnapshotRunIds: Set<string>;
  readonly publishSideChatStream: (
    runId: string,
    sessionKey: string,
    kind?: ChatStreamUpdateKind,
    turn?: AssistantTurn | null,
  ) => void;
  readonly publishSideChatFailure: (runId: string, text?: string) => void;
  readonly retainSideChatTombstone: (runId: string) => void;
  readonly ensureTranscriptSessionIdentity: () => void;
  readonly applyBackgroundChatEvent: (
    payload: NormalizedChatEvent,
    suppressedErrorMessage?: string,
  ) => void;
  readonly flushPendingAnnounceEvents: (runId: string) => void;
  readonly pendingAnnounceEvents: Map<string, NormalizedAgentEvent[]>;
  assistantSnapshotRunId: string | null;
  ignoredDeltaAfterAssistantSnapshotCount: number;
  readonly persistRunFailure: (
    sessionKey: string,
    sessionId: string | null,
    runId: string | null,
    error: string,
    timestamp?: number,
  ) => void;
  readonly handleChatEvent: (payload: NormalizedChatEvent) => void;
  readonly recoverFromInternalAgentSequenceGap: (payloadValue: unknown) => boolean;
  readonly findLiveSessionState: (
    sessionKey: string | null | undefined,
    sessionId?: string | null,
  ) => [string, SessionLiveState] | null;
  readonly applyBackgroundAgentEvent: (event: NormalizedAgentEvent) => void;
  readonly applyNormalizedAgentEvent: (
    event: NormalizedAgentEvent,
    options?: { replaySnapshot?: boolean },
  ) => void;
  readonly bufferPendingAnnounceEvent: (event: NormalizedAgentEvent) => void;
  readonly resetTranscriptForSession: (
    sessionKey: string,
    sessionId: string | null,
    preserveTiming?: boolean,
  ) => void;
  historyPagingGeneration: number;
  readonly resetHistoryPagination: (sessionKey: string) => void;
  readonly displayedHistoryLeafBySession: Map<string, string | null>;
  pendingHistoryReload: boolean;
  expectedPlanImplementationReset: {
    requestId: string;
    sessionKey: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  } | null;
  readonly currentMessageHistory: ChunkedMessageHistory;
  readonly setCurrentSessionMessages: (
    messages: unknown[],
    options?: { resetLoadedHistory?: boolean },
  ) => void;
  readonly applySessionContextUsage: (value: unknown, sessionKey: string) => boolean;
  readonly admitExpectedInitialHistoryMessage: (message: unknown) => boolean;
  readonly hydrateActiveToolItemsFromHistory: (
    messages: unknown[],
    options?: { backfillMissingSessionsYield?: boolean; backfillMissingToolsFromAppend?: boolean },
  ) => boolean;
  readonly publishActiveToolHistoryRepair: () => void;
  readonly rememberRunModel: (message: unknown, runId?: string | null, terminal?: boolean) => void;
  readonly hydrateCurrentSessionImages: (messages: unknown[], sessionKey: string) => void;
  readonly observeSessionMessageSeq: (
    sessionKey: string,
    sessionId: string | null,
    incomingSeq: number | null,
    loadedSeq: number | null,
  ) => boolean;
  readonly localCompactionStatusBySession: Map<string, LocalCompactionStatus>;
  readonly handleCompactionPhase: (
    phase: string,
    sessionKey?: string,
    data?: Record<string, unknown>,
  ) => void;
  readonly acceptRunId: (
    runId: string | undefined | null,
    allowProvisionalBinding?: boolean,
  ) => boolean;
  readonly handleDelta: (payload: NormalizedChatEvent) => void;
  readonly handleFinal: (payload: NormalizedChatEvent) => void;
  readonly handleError: (payload: NormalizedChatEvent) => void;
  readonly updateRunActivity: (
    runId: string,
    stage: RunProgressStage,
    options?: {
      modelActivity?: boolean;
      provider?: string;
      model?: string;
      retryReason?: unknown;
      at?: number;
    },
  ) => void;
  readonly notifyStream: (kind?: ChatStreamUpdateKind) => void;
  readonly clearLifecycleEndFallback: () => void;
  readonly finishCurrentTurnTiming: (
    status: Exclude<AssistantTurnTiming['status'], 'running'>,
    runId?: string | null,
  ) => void;
  terminalLifecycleSeen: boolean;
  readonly resetAssistantSnapshotSource: () => void;
  readonly messageSubscriptionSeq: number;
  readonly subscribedMessageSessionKey: string | null;
  readonly schedulePostFinalHistoryReload: (
    sessionKey: string,
    options: {
      runId: string | null;
      baselineMessageSeq: number | null;
      baselineCompleteMessageCount: number;
    },
  ) => void;
  readonly flushPendingHistoryReload: () => void;
  readonly resetActiveToolHistoryCatchUpForRun: (sessionKey: string) => void;
  readonly scheduleChatLifecycleEndFallback: () => void;
  readonly clearLocalCompactionStatus: (sessionKey: string) => void;
}

export function clearPostFinalHistoryReload(this: ChatControllerRecoveryContext): void {
  if (this.postFinalHistoryReloadTimer) {
    clearTimeout(this.postFinalHistoryReloadTimer);
    this.postFinalHistoryReloadTimer = null;
  }
  this.postFinalHistoryRecovery = null;
}

export function clearDeferredHistoryReload(this: ChatControllerRecoveryContext): void {
  if (!this.deferredHistoryReloadTimer) return;
  clearTimeout(this.deferredHistoryReloadTimer);
  this.deferredHistoryReloadTimer = null;
}

export function clearActiveToolHistoryCatchUp(this: ChatControllerRecoveryContext): void {
  if (!this.activeToolHistoryCatchUpTimer) return;
  clearTimeout(this.activeToolHistoryCatchUpTimer);
  this.activeToolHistoryCatchUpTimer = null;
}

export function resetActiveToolHistoryCatchUpForRun(
  this: ChatControllerRecoveryContext,
  sessionKey: string,
): void {
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

export function observeSessionMessageSeq(
  this: ChatControllerRecoveryContext,
  sessionKey: string,
  sessionId: string | null,
  incomingSeq: number | null,
  loadedSeq: number | null,
): boolean {
  const normalizedSessionKey = normalizeTranscriptSessionKey(sessionKey);
  const stored = this.observedSessionMessageSeqBySession.get(normalizedSessionKey);
  const previousMatchesSession = !stored?.sessionId || !sessionId || stored.sessionId === sessionId;
  const previous = previousMatchesSession ? stored : undefined;
  const previousSeq = previous?.seq ?? null;
  const baselineSeq =
    previousSeq === null
      ? loadedSeq
      : loadedSeq === null
        ? previousSeq
        : Math.max(previousSeq, loadedSeq);
  const gapDetected = incomingSeq !== null && baselineSeq !== null && incomingSeq > baselineSeq + 1;
  const cursorWasUninitialized = incomingSeq !== null && baselineSeq === null;
  const needsUnsequencedFallback =
    incomingSeq === null && baselineSeq === null && previous?.unsequencedCatchUpCompleted !== true;
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

export function recordLoadedSessionMessageSeq(
  this: ChatControllerRecoveryContext,
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

export function claimActiveToolHistoryCatchUp(
  this: ChatControllerRecoveryContext,
  sessionKey: string,
  sessionId: string | null,
): boolean {
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

export function hasPendingActiveToolHistoryCatchUp(
  this: ChatControllerRecoveryContext,
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

export function scheduleActiveToolHistoryCatchUp(
  this: ChatControllerRecoveryContext,
  sessionKey: string,
  runId: string,
): void {
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

export function scheduleDeferredHistoryReload(
  this: ChatControllerRecoveryContext,
  sessionKey: string,
  reason: string,
): void {
  if (reason === 'agent-item') {
    this.deferredHistoryReloadAttempts.delete(sessionKey);
  }
  if (
    reason === 'stale-history' ||
    reason === 'regressive-history' ||
    reason === 'empty-history-snapshot'
  ) {
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

export function postFinalHistoryHasCaughtUp(
  this: ChatControllerRecoveryContext,
  recovery: PostFinalHistoryRecovery,
): boolean {
  const messages = this.state.chatMessages.filter(
    message => !isLocallyOptimisticHistoryTail(message) && !isTruncatedHistoryMessage(message),
  );
  if (
    recovery.runId &&
    messages.some(message => readExplicitMessageRunId(message) === recovery.runId)
  ) {
    return true;
  }
  const latestMessageSeq = readLatestOpenClawMessageSeq(messages);
  if (
    recovery.baselineMessageSeq !== null &&
    latestMessageSeq !== null &&
    latestMessageSeq > recovery.baselineMessageSeq
  ) {
    return true;
  }
  return messages.length > recovery.baselineCompleteMessageCount;
}

export function scheduleNextPostFinalHistoryReload(
  this: ChatControllerRecoveryContext,
  recovery: PostFinalHistoryRecovery,
): void {
  const delay = MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS[recovery.attempt];
  if (delay === undefined) {
    if (this.postFinalHistoryRecovery === recovery) this.postFinalHistoryRecovery = null;
    return;
  }
  this.postFinalHistoryReloadTimer = setTimeout(() => {
    this.postFinalHistoryReloadTimer = null;
    const currentSessionId = this.state.currentSessionId ?? this.state.transcript.sessionId;
    if (
      this.postFinalHistoryRecovery !== recovery ||
      this.state.sessionKey !== recovery.sessionKey ||
      this.state.transcript.historyGeneration !== recovery.historyGeneration ||
      (recovery.sessionId && currentSessionId && recovery.sessionId !== currentSessionId) ||
      !this.state.connected ||
      this.state.chatSending
    ) {
      debugLog('[ChatCtrl] post-final history reload skipped', {
        sessionKey: recovery.sessionKey,
        runId: recovery.runId,
        attempt: recovery.attempt + 1,
        ...this._snap(),
      });
      if (this.postFinalHistoryRecovery === recovery) this.postFinalHistoryRecovery = null;
      return;
    }
    if (this.postFinalHistoryHasCaughtUp(recovery)) {
      this.postFinalHistoryRecovery = null;
      return;
    }
    debugLog('[ChatCtrl] post-final history reload → loadHistory', {
      sessionKey: recovery.sessionKey,
      runId: recovery.runId,
      attempt: recovery.attempt + 1,
      ...this._snap(),
    });
    void this.loadHistory(true).finally(() => {
      if (this.postFinalHistoryRecovery !== recovery) return;
      if (this.postFinalHistoryHasCaughtUp(recovery)) {
        this.postFinalHistoryRecovery = null;
        return;
      }
      recovery.attempt += 1;
      this.scheduleNextPostFinalHistoryReload(recovery);
    });
  }, delay);
}

export function schedulePostFinalHistoryReload(
  this: ChatControllerRecoveryContext,
  sessionKey: string,
  options: {
    runId: string | null;
    baselineMessageSeq: number | null;
    baselineCompleteMessageCount: number;
  },
): void {
  this.clearPostFinalHistoryReload();
  const recovery: PostFinalHistoryRecovery = {
    sessionKey,
    sessionId: this.state.currentSessionId ?? this.state.transcript.sessionId,
    historyGeneration: this.state.transcript.historyGeneration,
    runId: options.runId,
    baselineMessageSeq: options.baselineMessageSeq,
    baselineCompleteMessageCount: options.baselineCompleteMessageCount,
    attempt: 0,
  };
  this.postFinalHistoryRecovery = recovery;
  this.scheduleNextPostFinalHistoryReload(recovery);
}

export async function reconcileSuspendedRun(this: ChatControllerRecoveryContext): Promise<void> {
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
    const result = await this.state.client?.request<{ sessions?: unknown[] }>('sessions.list', {});
    const selected = (result?.sessions ?? []).map(asRecord).find(row => {
      const key =
        typeof row?.key === 'string'
          ? row.key
          : typeof row?.sessionKey === 'string'
            ? row.sessionKey
            : '';
      return (
        normalizeTranscriptSessionKey(key) === normalizeTranscriptSessionKey(this.state.sessionKey)
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
    if (reduceChatEvent(this.state.transcript, event, this.transcriptDependencies) === 'applied') {
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

export function recoverFromInternalAgentSequenceGap(
  this: ChatControllerRecoveryContext,
  payloadValue: unknown,
): boolean {
  const payload = asRecord(payloadValue);
  const data = asRecord(payload?.data);
  if (
    payload?.stream !== 'error' ||
    readNonBlankString(data?.reason)?.toLowerCase() !== 'seq gap'
  ) {
    return false;
  }
  const runId = readNonBlankString(payload?.runId ?? payload?.run_id);
  const sessionKey = readNonBlankString(payload?.sessionKey ?? payload?.session);
  const sessionId = normalizeSessionId(payload?.sessionId ?? payload?.session_id);
  const lifecycleGeneration = readNonBlankString(
    payload?.lifecycleGeneration ?? payload?.lifecycle_generation,
  );
  const activeTurn = this.state.transcript.activeTurn;
  const activeSessionId =
    this.state.currentSessionId ?? this.state.transcript.sessionId ?? activeTurn?.sessionId;
  const ownsGap = Boolean(
    runId &&
    sessionKey &&
    this.isSelectedSession(sessionKey) &&
    this.state.chatSending &&
    activeTurn?.status === 'running' &&
    activeTurn.runId === runId &&
    (!this.state.chatRunId || this.state.chatRunId === runId) &&
    (!sessionId || !activeSessionId || sessionId === activeSessionId) &&
    (!lifecycleGeneration ||
      !activeTurn.lifecycleGeneration ||
      lifecycleGeneration === activeTurn.lifecycleGeneration),
  );
  if (!ownsGap) return false;

  debugLog('[ChatCtrl] recovering selected run after internal Agent sequence gap', {
    sessionKey,
    runId,
    expected: data?.expected ?? null,
    received: data?.received ?? null,
  });
  this.state.client?.recoverFromGap('agent stream sequence gap');
  return true;
}

export function handleTimelineEvent(
  this: ChatControllerRecoveryContext,
  event: GatewayEventFrame,
): void {
  if (event.event === 'tick') return;
  if (event.event === 'chat.side_result') {
    const payload = asRecord(event.payload);
    const runId = readNonBlankString(payload?.runId);
    const sessionKey = readNonBlankString(payload?.sessionKey);
    const question = readNonBlankString(payload?.question);
    const text = readNonBlankString(payload?.text);
    if (
      payload?.kind !== 'btw' ||
      !runId ||
      !sessionKey ||
      !question ||
      !text ||
      !this.localSideChatRunIds.has(runId) ||
      !this.pendingSideChats.has(runId) ||
      normalizeTranscriptSessionKey(sessionKey) !==
        normalizeTranscriptSessionKey(this.state.sessionKey)
    ) {
      return;
    }
    const result: SideChatResult = {
      runId,
      sessionKey,
      question,
      text,
      isError: payload.isError === true,
    };
    for (const listener of this.sideChatResultListeners) listener(result);
    this.pendingSideChats.delete(runId);
    this.clearSideChatTranscript(runId, sessionKey);
    return;
  }
  if (event.event === 'progressCard.changed') {
    this.handleProgressCardChanged(event.payload);
    return;
  }
  if (event.event === 'chat') {
    const normalizedPayload = normalizeChatEvent({ payload: event.payload, frameSeq: event.seq });
    if (normalizedPayload) {
      if (normalizedPayload.runId && this.localSideChatRunIds.has(normalizedPayload.runId)) {
        const pending = this.pendingSideChats.get(normalizedPayload.runId);
        const transcript = this.sideChatTranscripts.get(normalizedPayload.runId);
        if (
          normalizedPayload.state === 'delta' &&
          this.sideChatAssistantSnapshotRunIds.has(normalizedPayload.runId)
        ) {
          return;
        }
        if (pending && transcript) {
          const reduceResult = reduceChatEvent(
            transcript,
            normalizedPayload,
            this.transcriptDependencies,
          );
          if (reduceResult === 'applied') {
            this.publishSideChatStream(
              normalizedPayload.runId,
              pending.sessionKey,
              normalizedPayload.state === 'delta' ? 'stream' : 'terminal',
            );
          }
        }
        if (
          normalizedPayload.state === 'final' ||
          normalizedPayload.state === 'aborted' ||
          normalizedPayload.state === 'error'
        ) {
          this.publishSideChatFailure(
            normalizedPayload.runId,
            normalizedPayload.errorMessage ?? '',
          );
          this.pendingSideChats.delete(normalizedPayload.runId);
          this.retainSideChatTombstone(normalizedPayload.runId);
        }
        return;
      }
      let payload = normalizedPayload;
      const failedErrorMessage =
        normalizedPayload.state === 'error'
          ? (normalizedPayload.errorMessage ?? 'Unknown error')
          : null;
      if (
        normalizedPayload.state === 'error' &&
        isInternalManagedSubagentHandoffError(normalizedPayload.errorMessage)
      ) {
        payload = {
          runId: normalizedPayload.runId,
          sessionKey: normalizedPayload.sessionKey,
          sessionId: normalizedPayload.sessionId,
          lifecycleGeneration: normalizedPayload.lifecycleGeneration,
          frameSeq: normalizedPayload.frameSeq,
          state: 'final',
          replace: false,
        };
        debugLog('[ChatCtrl] suppressed internal managed handoff run error', {
          runId: payload.runId,
          sessionKey: payload.sessionKey,
        });
      }
      this.ensureTranscriptSessionIdentity();
      const matchesSelectedSession =
        normalizeTranscriptSessionKey(payload.sessionKey) ===
        normalizeTranscriptSessionKey(this.state.sessionKey);
      if (!matchesSelectedSession) {
        this.applyBackgroundChatEvent(payload, failedErrorMessage ?? undefined);
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
      // Both chat.final delivery paths use OpenClaw's display projection and
      // can therefore carry only an 8K preview. Do not let that preview
      // rewind the complete assistant snapshot already accumulated live.
      const reducerPayload =
        payload.state === 'final' && isTruncatedHistoryMessage(payload.message)
          ? { ...payload, message: undefined }
          : payload;
      const reduceResult = reduceChatEvent(
        this.state.transcript,
        reducerPayload,
        this.transcriptDependencies,
      );
      const externalFinal =
        reduceResult === 'ignored-run' &&
        payload.state === 'final' &&
        !(payload.runId && isTerminalRun(this.state.transcript, payload.runId)) &&
        this.state.transcript.activeTurn === null &&
        this.state.chatRunId === null &&
        normalizeTranscriptSessionKey(payload.sessionKey) ===
          normalizeTranscriptSessionKey(this.state.sessionKey) &&
        (!payload.sessionId ||
          !this.state.currentSessionId ||
          payload.sessionId === this.state.currentSessionId);
      if (reduceResult === 'applied' || externalFinal) {
        if (failedErrorMessage) {
          this.persistRunFailure(
            this.state.sessionKey,
            normalizedPayload.sessionId,
            normalizedPayload.runId,
            failedErrorMessage,
          );
        }
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
      if (
        normalized.reason === 'missing-sequence' &&
        this.recoverFromInternalAgentSequenceGap(event.payload)
      ) {
        return;
      }
      debugLog('[ChatCtrl] Agent event rejected during normalization', {
        reason: normalized.reason,
        frameSeq: event.seq ?? null,
      });
      return;
    }
    if (normalized.event.runId && this.localSideChatRunIds.has(normalized.event.runId)) {
      const pending = this.pendingSideChats.get(normalized.event.runId);
      const transcript = this.sideChatTranscripts.get(normalized.event.runId);
      if (pending && transcript) {
        const reduceResult = reduceAgentEvent(
          transcript,
          normalized.event,
          this.transcriptDependencies,
          {
            allowSequenceBackfill:
              normalized.event.deliveryEvent === 'session.tool' ||
              hasStableProgressOwner(normalized.event),
          },
        );
        if (reduceResult === 'applied') {
          if (normalized.event.stream === 'assistant') {
            const observation = readTerminalGuardObservation(normalized.event.data);
            if (observation?.action === 'rollback') {
              this.sideChatAssistantSnapshotRunIds.delete(normalized.event.runId);
            } else {
              this.sideChatAssistantSnapshotRunIds.add(normalized.event.runId);
            }
          }
          const phase = normalized.event.data.phase;
          const terminal =
            normalized.event.stream === 'lifecycle' && (phase === 'end' || phase === 'error');
          const toolPartial =
            normalized.event.stream === 'tool' &&
            normalized.event.data.partialResult !== undefined &&
            !terminal;
          this.publishSideChatStream(
            normalized.event.runId,
            pending.sessionKey,
            terminal ? 'terminal' : toolPartial ? 'tool-partial' : 'stream',
          );
        }
      }
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

  // Session metadata and durable transcript notifications for the selected session.
  if (event.event === 'sessions.changed') {
    const payload = asRecord(event.payload);
    const sessionSnapshot = asRecord(payload?.session);
    const eventSessionKey =
      typeof payload?.sessionKey === 'string'
        ? payload.sessionKey.trim()
        : typeof sessionSnapshot?.key === 'string'
          ? sessionSnapshot.key.trim()
          : '';
    if (
      !eventSessionKey ||
      normalizeTranscriptSessionKey(eventSessionKey) !==
        normalizeTranscriptSessionKey(this.state.sessionKey)
    ) {
      return;
    }
    const reason = typeof payload?.reason === 'string' ? payload.reason.trim().toLowerCase() : '';
    const nextSessionId = normalizeSessionId(payload?.sessionId ?? sessionSnapshot?.sessionId);
    const currentSessionId = this.state.currentSessionId ?? this.state.transcript.sessionId;
    const rotatesSessionIdentity = Boolean(
      nextSessionId && currentSessionId && nextSessionId !== currentSessionId,
    );
    if (rotatesSessionIdentity) {
      const explicitIdentityChange = reason === 'new' || reason === 'reset' || reason === 'delete';
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
      this.historyPagingGeneration += 1;
      this.resetHistoryPagination(this.state.sessionKey);
      this.displayedHistoryLeafBySession.delete(
        normalizeTranscriptSessionKey(this.state.sessionKey),
      );
      this.state.currentSessionId = nextSessionId;
      this.state.chatRunId = null;
      this.state.chatSending = false;
      this.clearRunActivity();
      this.pendingHistoryReload = false;
      this.scheduleDeferredHistoryReload(this.state.sessionKey, 'session-identity-rotation');
    } else if (reason === 'reset') {
      const managedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(this.state.sessionKey);
      const resetSessionId = nextSessionId ?? currentSessionId;
      const planImplementation = this.expectedPlanImplementationReset;
      this.expectedPlanImplementationReset = null;
      this.historyPagingGeneration += 1;
      this.resetHistoryPagination(this.state.sessionKey);
      this.displayedHistoryLeafBySession.delete(
        normalizeTranscriptSessionKey(this.state.sessionKey),
      );
      if (managedSession) {
        // OpenClaw keeps the same public session identity for the Plan handoff.
        // Preserve the loaded display transcript while retiring the planning
        // turn, and project an immediate reset boundary. Patch 022 makes the
        // authoritative history snapshot return the same pre-reset rows later.
        let loadedMessages = this.currentMessageHistory.toArray();
        let latestResetIndex = -1;
        loadedMessages.forEach((message, index) => {
          if (asRecord(asRecord(message)?.__openclaw)?.kind === 'reset') {
            latestResetIndex = index;
          }
        });
        const hasPersistedPlan = projectPersistedTimeline(
          loadedMessages.slice(latestResetIndex + 1) as GatewayMessage[],
        ).some(item => item.kind === 'plan-presentation');
        if (planImplementation && !hasPersistedPlan) {
          const livePlanTool = this.state.transcript.activeTurn?.items.find(
            item => item.type === 'tool' && isPresentPlanToolName(item.name),
          );
          loadedMessages = [
            ...loadedMessages,
            {
              role: 'assistant',
              runId: this.state.transcript.activeTurn?.runId,
              timestamp: livePlanTool?.startedAt ?? Date.now(),
              content: [
                {
                  type: 'toolcall',
                  toolCallId:
                    livePlanTool?.type === 'tool'
                      ? livePlanTool.toolCallId
                      : `plan-${planImplementation.requestId}`,
                  name: planImplementation.toolName,
                  input: planImplementation.toolInput,
                },
              ],
            },
          ];
        }
        const tailMarker = asRecord(loadedMessages[loadedMessages.length - 1])?.__openclaw;
        const tailMarkerRecord = asRecord(tailMarker);
        const messages =
          tailMarkerRecord?.kind === 'reset'
            ? loadedMessages
            : [
                ...loadedMessages,
                {
                  role: 'system',
                  content: 'Reset',
                  timestamp: Date.now(),
                  __openclaw: {
                    kind: 'reset',
                    id: `justdo-live-reset-${Date.now()}`,
                    ...(planImplementation ? { planImplementation: true } : {}),
                  },
                },
              ];
        this.resetTranscriptForSession(this.state.sessionKey, resetSessionId, false);
        this.setCurrentSessionMessages(messages, { resetLoadedHistory: true });
      } else {
        // Native sessions retain OpenClaw's normal reset behavior.
        this.resetTranscriptForSession(this.state.sessionKey, resetSessionId, false);
        this.setCurrentSessionMessages([], { resetLoadedHistory: true });
      }
      this.state.chatRunId = null;
      this.state.chatSending = false;
      this.clearRunActivity();
      this.pendingHistoryReload = false;
      this.scheduleDeferredHistoryReload(this.state.sessionKey, 'session-reset');
    }
    if (this.applySessionContextUsage(sessionSnapshot ?? payload, eventSessionKey)) this.notify();
    if (payload?.phase === 'message') {
      // New OpenClaw emits this invalidation when a committed batch,
      // rewrite, or suppressed row has no single session.message payload.
      // During a run the snapshot may repair Tool boundaries but cannot
      // replace the live turn; terminal reconciliation will finish it.
      this.pendingHistoryReload = true;
      if (this.state.chatSending && this.state.transcript.activeTurn?.status === 'running') {
        void this.loadHistory(true, { backfillActiveSessionsYield: true });
      } else {
        this.scheduleDeferredHistoryReload(this.state.sessionKey, 'sessions-changed-message');
      }
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
    if (this.admitExpectedInitialHistoryMessage(payload?.message)) return;
    const sessionSnapshot = asRecord(payload?.session);
    if (
      this.applySessionContextUsage(
        sessionSnapshot ?? payload,
        eventSessionKey || this.state.sessionKey,
      )
    ) {
      this.notify();
    }
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
    const explicitMessageRunId = readExplicitMessageRunId(payload);
    const runActiveValue = payload?.hasActiveRun ?? sessionSnapshot?.hasActiveRun;
    const runActive = typeof runActiveValue === 'boolean' ? runActiveValue : undefined;
    const runIdentityMatches =
      (explicitMessageRunId === undefined || expectedRunIds.has(explicitMessageRunId)) &&
      (activeRunIds.length === 0 || activeRunIds.some(runId => expectedRunIds.has(runId))) &&
      runActive !== false;
    const repairedActiveTail =
      payload?.message !== undefined &&
      !isTruncatedHistoryMessage(payload.message) &&
      sessionIdentityMatches &&
      runIdentityMatches &&
      this.hydrateActiveToolItemsFromHistory([payload.message], {
        backfillMissingSessionsYield: true,
        backfillMissingToolsFromAppend: true,
      });
    if (repairedActiveTail) this.publishActiveToolHistoryRepair();
    const loadedMessageSeq = readLatestOpenClawMessageSeq(this.state.chatMessages);
    const projectedAppend =
      payload?.message === undefined ? [] : projectGatewayHistoryForDisplay([payload.message]);
    const appendIsTruncated =
      projectedAppend.length === 1 && isTruncatedHistoryMessage(projectedAppend[0]);
    const directApply =
      sessionIdentityMatches && projectedAppend.length === 1 && !appendIsTruncated
        ? applySessionMessagePayload(
            this.state.chatMessages,
            { ...payload, message: projectedAppend[0] },
            {
              activeRunId:
                activeTurn?.status === 'running' ? activeTurn.runId : this.state.chatRunId,
              runActive,
              isRecentTerminalRun: runId => isTerminalRun(this.state.transcript, runId),
            },
          )
        : null;
    if (directApply?.kind === 'applied') {
      this.rememberRunModel(directApply.message, explicitMessageRunId);
      this.state.transcript.historySource = 'gateway';
      this.setCurrentSessionMessages(directApply.messages);
      if (
        directApply.role === 'user' &&
        this.state.pendingUserMessage &&
        isPendingUserMessageMatch(
          directApply.message as GatewayMessage,
          this.state.pendingUserMessage as unknown as GatewayMessage,
        )
      ) {
        this.state.pendingUserMessage = null;
      }
      this.notify();
      this.hydrateCurrentSessionImages(directApply.messages, this.state.sessionKey);
    }
    const messageSeq =
      readPositiveSafeInteger(payload?.messageSeq) ?? readOpenClawMessageSeq(payload?.message);
    // Compare against the snapshot that preceded this append. Including the
    // just-applied row in the baseline would hide a real dropped-message gap.
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
      // A targeted append can be absent while a later append/messageSeq is
      // the first evidence that a Tool row was missed. Fetch the active tail
      // without allowing history to replace the live turn.
      this.scheduleActiveToolHistoryCatchUp(this.state.sessionKey, activeTurn.runId);
    }
    const appendWasHidden = payload?.message !== undefined && projectedAppend.length === 0;
    const needsHistoryFallback =
      !sessionIdentityMatches ||
      (!appendWasHidden && directApply?.kind !== 'applied') ||
      activeTailCatchUpPending ||
      (directApply?.kind === 'applied' && isTruncatedHistoryMessage(directApply.message));
    if (!needsHistoryFallback && !this.pendingHistoryReload) return;
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
    const eventSessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    const targetsSelectedSession = !eventSessionKey || this.isSelectedSession(eventSessionKey);
    const sessionKey = targetsSelectedSession ? this.state.sessionKey : eventSessionKey;
    if (!targetsSelectedSession && !this.localCompactionStatusBySession.has(sessionKey)) {
      return;
    }
    const phase = typeof payload.phase === 'string' ? payload.phase : '';
    this.handleCompactionPhase(phase, sessionKey, payload);
  }
}

export function handleChatEvent(
  this: ChatControllerRecoveryContext,
  payload: NormalizedChatEvent,
): void {
  // Only handle events for our session
  if (!this.isSelectedSession(payload.sessionKey)) return;
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

export function handleDelta(
  this: ChatControllerRecoveryContext,
  payload: NormalizedChatEvent,
): void {
  debugLog('[ChatCtrl] ▶ chat.delta admitted', {
    runId: payload.runId ?? null,
    textLen: payload.deltaText?.length ?? 0,
  });
  if (payload.runId && payload.deltaText) {
    this.updateRunActivity(payload.runId, 'responding', { modelActivity: true });
  }
  this.notifyStream();
}

export function handleFinal(
  this: ChatControllerRecoveryContext,
  payload: NormalizedChatEvent,
): void {
  this.clearLifecycleEndFallback();
  for (const message of this.state.chatMessages) {
    if (!isLocallyOptimisticHistoryTail(message)) {
      this.rememberRunModel(message, readExplicitMessageRunId(message), true);
    }
  }
  this.rememberRunModel(payload.message, payload.runId, true);
  this.finishCurrentTurnTiming('final', payload.runId);
  const baselineMessageSeq = readLatestOpenClawMessageSeq(this.state.chatMessages);
  const baselineCompleteMessageCount = this.state.chatMessages.filter(
    candidate =>
      !isLocallyOptimisticHistoryTail(candidate) && !isTruncatedHistoryMessage(candidate),
  ).length;
  const projectedMessage = stripAssistantSilentReplySuffix(payload.message);
  const terminalNeedsHydration = isTruncatedHistoryMessage(projectedMessage);
  const message = terminalNeedsHydration
    ? completeTruncatedTerminalFromActiveTurn(projectedMessage, this.state.transcript.activeTurn)
    : projectedMessage;
  const willAppend = message && !isTruncatedHistoryMessage(message) && !shouldHideMessage(message);
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
    // chat.final may omit model metadata. Keep the Gateway model on the
    // optimistic message itself before the next run replaces live timing.
    const turn = this.state.transcript.activeTurn;
    const modelRef =
      readModelRef(message) ?? (turn?.runId === payload.runId ? turn.modelRef : undefined);
    const runScopedMessage =
      payload.runId && message && typeof message === 'object' && !Array.isArray(message)
        ? {
            ...(message as Record<string, unknown>),
            runId: payload.runId,
            ...(modelRef ? { modelName: modelRef } : {}),
          }
        : message;
    const terminalMessage = markOptimisticHistoryTail(
      liveThinkingText ? withThinkingContent(runScopedMessage, liveThinkingText) : runScopedMessage,
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
  // A visible final is already complete and its subscribed session.message
  // row will replace the optimistic tail. Only message-less finals need the
  // bounded persistence catch-up used by the current OpenClaw UI.
  const needsPersistenceRecovery =
    !willAppend ||
    terminalNeedsHydration ||
    this.pendingHistoryReload ||
    (this.messageSubscriptionSeq > 0 && this.subscribedMessageSessionKey !== this.state.sessionKey);
  this.pendingHistoryReload = false;
  if (!needsPersistenceRecovery) {
    this.clearPostFinalHistoryReload();
  } else {
    this.schedulePostFinalHistoryReload(this.state.sessionKey, {
      runId: payload.runId?.trim() || null,
      baselineMessageSeq,
      baselineCompleteMessageCount,
    });
  }
  debugLog('[ChatCtrl] ▶ chat.final (done)', this._snap());
  this.notify();
}

export function handleAborted(
  this: ChatControllerRecoveryContext,
  payload: NormalizedChatEvent,
): void {
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

export function handleError(
  this: ChatControllerRecoveryContext,
  payload: NormalizedChatEvent,
): void {
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

export function handleAgentEvent(
  this: ChatControllerRecoveryContext,
  payload: NormalizedAgentEvent,
): void {
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
      textLen:
        typeof data.thinking === 'string'
          ? data.thinking.length
          : typeof data.text === 'string'
            ? data.text.length
            : 0,
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
    if (readPreambleText(data) !== null) {
      const wasSending = this.state.chatSending;
      this.state.chatSending = true;
      this.state.chatRunId = runId;
      if (!wasSending && !this.hasExpectedInitialHistory()) {
        this.scheduleDeferredHistoryReload(this.state.sessionKey, 'initial-history-missing');
      }
      this.updateRunActivity(runId, 'responding', { modelActivity: true });
      this.notifyStream();
      return;
    }
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
      this.persistRunFailure(this.state.sessionKey, payload.sessionId, runId, errorMessage);
      if (isInternalManagedSubagentHandoffError(errorMessage)) {
        const finalEvent: NormalizedChatEvent = {
          runId,
          sessionKey: this.state.sessionKey,
          sessionId: payload.sessionId,
          lifecycleGeneration: payload.lifecycleGeneration,
          frameSeq: payload.frameSeq,
          state: 'final',
          replace: false,
        };
        reduceChatEvent(this.state.transcript, finalEvent, this.transcriptDependencies);
        this.handleFinal(finalEvent);
        return;
      }
      this.clearLifecycleEndFallback();
      this.state.lastError = errorMessage;
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

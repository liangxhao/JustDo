import { type NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { isGatewayInjectedModelRef, readModelRef } from '@shared/openclaw/modelRef';
import { type ProgressCard } from '@shared/openclaw/progressCard';

import type {
  GatewayClient,
  GatewayEventFrame,
  GatewayHelloOk,
} from '@/libs/openclaw-chat/gateway/client';
import {
  type AssistantTurnTiming,
  bindAssistantTurnRunId,
  createChatTranscriptState,
  type HistorySource,
  normalizeTranscriptSessionKey,
  resetChatTranscriptState,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/chunked-message-history';
import { latestHistoryWindow } from '@/libs/openclaw-chat/model/history-window';
import { isPendingUserMessageMatch } from '@/libs/openclaw-chat/model/optimistic-user-message';
import { projectGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import {
  asRecord,
  ChatState,
  debugLog,
  isSubagentTaskHistoryMessage,
  isTempJustDoSessionKey,
  LocalCompactionStatus,
  messageTimestampMs,
  PROGRESS_CARD_GET_METHOD,
  SessionLiveState,
  SwitchSessionOptions,
} from './chat-controller-support';
export interface ChatControllerSessionContext {
  readonly chatMessagesBySession: Map<string, ChunkedMessageHistory>;
  readonly historySourceBySession: Map<string, HistorySource>;
  readonly state: ChatState;
  readonly liveStateBySession: Map<string, SessionLiveState>;
  readonly clearRunActivityTimer: () => void;
  runProbeToken: symbol | null;
  readonly cacheCurrentTurnTiming: () => void;
  terminalLifecycleSeen: boolean;
  assistantSnapshotRunId: string | null;
  ignoredDeltaAfterAssistantSnapshotCount: number;
  readonly findLiveSessionState: (
    sessionKey: string | null | undefined,
    sessionId?: string | null,
  ) => [string, SessionLiveState] | null;
  readonly resetAssistantSnapshotSource: () => void;
  readonly scheduleRunActivityCheck: (delayMs?: number) => void;
  readonly scheduleChatLifecycleEndFallback: () => void;
  readonly historyPaginationBySession: Map<
    string,
    { hasMore: boolean; nextCursor: string | null; advanced: boolean }
  >;
  readonly displayedHistoryLeafBySession: Map<string, string | null>;
  readonly isSelectedSession: (sessionKey: string) => boolean;
  readonly turnTimingBySession: Map<string, AssistantTurnTiming>;
  readonly pendingAnnounceEvents: Map<string, NormalizedAgentEvent[]>;
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
  readonly finishTurnTimingForSession: (
    sessionKey: string,
    status: Exclude<AssistantTurnTiming['status'], 'running'>,
    runId?: string | null,
    endedAt?: number,
  ) => void;
  readonly resetTranscriptForSession: (
    sessionKey: string,
    sessionId: string | null,
    preserveTiming?: boolean,
  ) => void;
  subscribedMessageSessionKey: string | null;
  messageSubscriptionSeq: number;
  connectionInitializationSeq: number;
  readonly isConnectionInitializationCurrent: (params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  }) => boolean;
  readonly loadHistory: (
    queueIfBusy?: boolean,
    options?: {
      preferStartup?: boolean;
      reconcileSuspended?: boolean;
      backfillActiveSessionsYield?: boolean;
    },
  ) => Promise<boolean>;
  readonly hasExpectedInitialHistory: () => boolean;
  readonly loadOlderHistory: () => Promise<boolean>;
  readonly initialHistoryRetryDelaysMs: readonly number[];
  readonly waitForInitialHistoryRetry: (
    delayMs: number,
    params: { client: GatewayClient; sessionKey: string; initializationSeq: number },
  ) => Promise<boolean>;
  readonly notify: () => void;
  readonly expectInitialHistory: boolean;
  readonly findExpectedInitialHistoryIndex: (messages: readonly unknown[]) => number;
  readonly expectInitialUserMessage: boolean;
  readonly isExpectedInitialHistoryMessage: (message: unknown) => boolean;
  pendingHistoryReload: boolean;
  readonly setCurrentSessionMessages: (
    messages: unknown[],
    options?: { resetLoadedHistory?: boolean },
  ) => void;
  readonly hydrateCurrentSessionImages: (messages: unknown[], sessionKey: string) => void;
  readonly loadProgressCard: (sessionKey: string, force?: boolean) => Promise<void>;
  readonly syncMessageSessionSubscription: (sessionKey: string) => Promise<boolean>;
  readonly initialMessageSubscriptionBarrierTimeoutMs: number;
  suspendedRunId: string | null;
  readonly reconcileSuspendedRun: () => Promise<void>;
  readonly loadInitialHistory: (params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  }) => Promise<void>;
  readonly manualCompactionRequestIdsBySession: Map<string, string>;
  readonly settleCompactionRequest: (sessionKey: string, errorMessage?: string) => void;
  readonly clearLocalCompactionStatus: (sessionKey: string) => void;
  readonly rememberHistoryPagination: (sessionKey: string) => void;
  progressCardLoadGeneration: number;
  readonly progressCardCache: Map<string, ProgressCard | null>;
  historyPagingGeneration: number;
  readonly restoreHistoryPagination: (sessionKey: string) => void;
  currentMessageHistory: ChunkedMessageHistory;
  readonly beginRunActivity: (runId: string, startedAt?: number) => void;
  readonly clearRunActivity: () => void;
  readonly handleHello: (hello: GatewayHelloOk) => void;
  readonly handleEvent: (event: GatewayEventFrame) => void;
  readonly handleClose: () => void;
  expectedPlanImplementationReset: {
    requestId: string;
    sessionKey: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  } | null;
  readonly clearLifecycleEndFallback: () => void;
  readonly cacheCurrentLiveState: (sessionKey: string) => void;
  readonly promoteCachedSessionState: (sourceSessionKey: string, targetSessionKey: string) => void;
  readonly restoreLiveState: (sessionKey: string) => boolean;
  readonly clearPostFinalHistoryReload: () => void;
  readonly clearDeferredHistoryReload: () => void;
  readonly clearActiveToolHistoryCatchUp: () => void;
  readonly initializeConnectedSession: (params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
    resumedTransport: boolean;
  }) => Promise<void>;
  readonly settledCompactionEventIds: Set<string>;
  readonly localCompactionStatusBySession: Map<string, LocalCompactionStatus>;
  readonly clearAllSideChatRuns: () => void;
  readonly historyReloadRequested: Set<string>;
  readonly immediateHistoryReloadRequested: Set<string>;
  readonly isGatewayMethodAdvertised: (method: string) => boolean;
  readonly pendingSideChats: Map<string, { question: string; sessionKey: string }>;
  readonly publishSideChatFailure: (runId: string, text?: string) => void;
  readonly retainSideChatTombstone: (runId: string) => void;
}

export function cacheSessionMessages(
  this: ChatControllerSessionContext,
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

export function findLiveSessionState(
  this: ChatControllerSessionContext,
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
      if (entry[1].currentSessionId === sessionId || entry[1].transcript.sessionId === sessionId) {
        return entry;
      }
    }
  }
  return null;
}

export function cacheCurrentLiveState(
  this: ChatControllerSessionContext,
  sessionKey: string,
): void {
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
    contextUsage: this.state.contextUsage,
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

export function restoreLiveState(this: ChatControllerSessionContext, sessionKey: string): boolean {
  const cachedEntry = this.findLiveSessionState(sessionKey);
  if (!cachedEntry) {
    this.state.currentSessionId = null;
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    this.state.chatRunId = null;
    this.state.lastError = null;
    this.state.runActivity = null;
    this.state.contextUsage = null;
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
  this.state.contextUsage = cached.contextUsage;
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

export function isSelectedSession(this: ChatControllerSessionContext, sessionKey: string): boolean {
  return (
    normalizeTranscriptSessionKey(sessionKey) ===
    normalizeTranscriptSessionKey(this.state.sessionKey)
  );
}

export function promoteCachedSessionState(
  this: ChatControllerSessionContext,
  sourceSessionKey: string,
  targetSessionKey: string,
): void {
  const sourceHistory = this.chatMessagesBySession.get(sourceSessionKey);
  this.chatMessagesBySession.delete(sourceSessionKey);
  if (sourceHistory) this.chatMessagesBySession.set(targetSessionKey, sourceHistory);

  const sourceHistorySource = this.historySourceBySession.get(sourceSessionKey);
  this.historySourceBySession.delete(sourceSessionKey);
  if (sourceHistorySource) {
    this.historySourceBySession.set(targetSessionKey, sourceHistorySource);
  }

  const sourcePagination = this.historyPaginationBySession.get(sourceSessionKey);
  this.historyPaginationBySession.delete(sourceSessionKey);
  if (sourcePagination) {
    this.historyPaginationBySession.set(targetSessionKey, sourcePagination);
  }
  const sourceLeafKey = normalizeTranscriptSessionKey(sourceSessionKey);
  const targetLeafKey = normalizeTranscriptSessionKey(targetSessionKey);
  if (this.displayedHistoryLeafBySession.has(sourceLeafKey)) {
    const sourceLeaf = this.displayedHistoryLeafBySession.get(sourceLeafKey) ?? null;
    this.displayedHistoryLeafBySession.delete(sourceLeafKey);
    this.displayedHistoryLeafBySession.set(targetLeafKey, sourceLeaf);
  }

  const sourceLiveEntry = this.findLiveSessionState(sourceSessionKey);
  if (!sourceLiveEntry) return;
  const [sourceLiveKey, sourceLiveState] = sourceLiveEntry;
  this.liveStateBySession.delete(sourceLiveKey);
  sourceLiveState.currentSessionId = null;
  if (sourceLiveState.contextUsage) {
    sourceLiveState.contextUsage = {
      ...sourceLiveState.contextUsage,
      sessionKey: targetSessionKey,
      sessionId: null,
    };
  }
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

export function getSessionRunId(
  this: ChatControllerSessionContext,
  sessionKey: string,
): string | null {
  if (this.isSelectedSession(sessionKey)) return this.state.chatRunId;
  return this.findLiveSessionState(sessionKey)?.[1].chatRunId ?? null;
}

export function bindAcknowledgedRun(
  this: ChatControllerSessionContext,
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

export function cacheCurrentTurnTiming(this: ChatControllerSessionContext): void {
  const turn = this.state.transcript.activeTurn;
  const sessionKey = turn?.sessionKey || this.state.transcript.sessionKey;
  if (!turn || !sessionKey) return;
  const existing = this.turnTimingBySession.get(sessionKey);
  const startedAt =
    existing?.runId === turn.runId ? Math.min(existing.startedAt, turn.startedAt) : turn.startedAt;
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

export function rememberRunModel(
  this: ChatControllerSessionContext,
  message: unknown,
  runId?: string | null,
  terminal = false,
): void {
  if (asRecord(message)?.role !== 'assistant' || !runId) return;
  const modelRef = readModelRef(message);
  if (!modelRef || isGatewayInjectedModelRef(modelRef)) return;
  const activity = this.state.runActivity;
  const turn = this.state.transcript.activeTurn;
  // An append can describe an earlier model attempt within this same run.
  // Live progress stays authoritative until the run reaches its terminal event.
  if (!terminal && this.state.chatSending && turn?.modelRef) return;
  if (activity?.runId === runId) {
    activity.model = modelRef;
    delete activity.provider;
  }
  if (turn?.runId === runId) turn.modelRef = modelRef;
  const cached = this.turnTimingBySession.get(this.state.sessionKey);
  if (cached?.runId === runId) {
    this.turnTimingBySession.set(this.state.sessionKey, { ...cached, modelRef });
  }
}

export function resetTranscriptForSession(
  this: ChatControllerSessionContext,
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

export function finishCurrentTurnTiming(
  this: ChatControllerSessionContext,
  status: Exclude<AssistantTurnTiming['status'], 'running'>,
  runId?: string | null,
): void {
  const activeTurn = this.state.transcript.activeTurn;
  if (activeTurn?.status !== 'running') this.cacheCurrentTurnTiming();
  this.finishTurnTimingForSession(this.state.sessionKey, status, runId, activeTurn?.endedAt);
}

export function finishTurnTimingForSession(
  this: ChatControllerSessionContext,
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

export function getCurrentTurnTiming(
  this: ChatControllerSessionContext,
): AssistantTurnTiming | null {
  const activeTurn = this.state.transcript.activeTurn;
  const cached = this.turnTimingBySession.get(this.state.sessionKey);
  if (!activeTurn) {
    if (!cached || this.state.historyWindowEnd < this.state.loadedMessageCount) return null;
    const latestUserTimestamp = this.state.chatMessages.reduce<number | null>((latest, message) => {
      const record = asRecord(message);
      if (String(record?.role ?? '').toLowerCase() !== 'user') return latest;
      const timestamp = messageTimestampMs(message);
      return timestamp === null || (latest !== null && timestamp <= latest) ? latest : timestamp;
    }, null);
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

export function ensureTranscriptSessionIdentity(this: ChatControllerSessionContext): void {
  if (this.state.transcript.sessionKey === this.state.sessionKey) return;
  this.resetTranscriptForSession(this.state.sessionKey, this.state.currentSessionId);
  this.state.transcript.persistedMessages = this.state.chatMessages;
}

export async function syncMessageSessionSubscription(
  this: ChatControllerSessionContext,
  sessionKey: string,
): Promise<boolean> {
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

export function isConnectionInitializationCurrent(
  this: ChatControllerSessionContext,
  params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  },
): boolean {
  return (
    this.state.client === params.client &&
    this.state.connected &&
    this.state.sessionKey === params.sessionKey &&
    this.connectionInitializationSeq === params.initializationSeq
  );
}

export async function waitForInitialHistoryRetry(
  this: ChatControllerSessionContext,
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

export async function loadInitialHistory(
  this: ChatControllerSessionContext,
  params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
  },
): Promise<void> {
  let initialHistoryError: string | null = null;
  try {
    const initialLoadSucceeded = await this.loadHistory(true, { preferStartup: true });
    if (!initialLoadSucceeded) initialHistoryError = this.state.lastError;
    if (this.hasExpectedInitialHistory()) return;

    // A subagent's originating task can be older than the recent startup
    // page. Follow the native offset chain before treating the missing row
    // as a persistence race and retrying the tail snapshot.
    while (this.state.historyHasMore && this.state.historyNextCursor) {
      const cursor = this.state.historyNextCursor;
      await this.loadOlderHistory();
      if (this.hasExpectedInitialHistory()) return;
      if (this.state.historyNextCursor === cursor) break;
    }

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
    if (this.isConnectionInitializationCurrent(params) && !this.state.chatLoading) {
      this.state.initialHistoryReady = true;
      this.notify();
    }
  }
}

export function hasExpectedInitialHistory(this: ChatControllerSessionContext): boolean {
  if (!this.expectInitialHistory) return true;
  return this.findExpectedInitialHistoryIndex(this.state.chatMessages) >= 0;
}

export function isExpectedInitialHistoryMessage(
  this: ChatControllerSessionContext,
  message: unknown,
): boolean {
  if (isSubagentTaskHistoryMessage(message)) return true;
  return (
    this.expectInitialUserMessage && String(asRecord(message)?.role ?? '').toLowerCase() === 'user'
  );
}

export function findExpectedInitialHistoryIndex(
  this: ChatControllerSessionContext,
  messages: readonly unknown[],
): number {
  return messages.findIndex(message => this.isExpectedInitialHistoryMessage(message));
}

export function admitExpectedInitialHistoryMessage(
  this: ChatControllerSessionContext,
  message: unknown,
): boolean {
  if (
    !this.expectInitialHistory ||
    this.hasExpectedInitialHistory() ||
    !this.isExpectedInitialHistoryMessage(message)
  ) {
    return false;
  }
  const projected = projectGatewayHistoryForDisplay([message]);
  if (projected.length !== 1 || !this.isExpectedInitialHistoryMessage(projected[0])) return false;
  const authoritativeMessage = projected[0] as GatewayMessage;
  const pendingMessage = this.state.pendingUserMessage;
  const admittedMessage =
    pendingMessage &&
    Array.isArray(pendingMessage.content) &&
    isPendingUserMessageMatch(authoritativeMessage, pendingMessage as unknown as GatewayMessage)
      ? { ...authoritativeMessage, content: pendingMessage.content }
      : authoritativeMessage;
  const admittedMessages = [admittedMessage];

  // session.message is emitted after OpenClaw appends the transcript row and
  // carries that authoritative row. Admit the task immediately instead of
  // waiting for a second history read, which can still observe an older
  // paged snapshot. Keep the optimistic attachment blocks until canonical
  // media hydration finishes, so the first durable row cannot flash the
  // image away. Forked parent context and assistant-only in-flight tails are
  // intentionally excluded from the subagent's own visible timeline.
  this.state.transcript.historySource = 'gateway';
  this.pendingHistoryReload = true;
  this.setCurrentSessionMessages(admittedMessages, { resetLoadedHistory: true });
  this.state.lastError = null;
  this.state.initialHistoryReady = true;
  this.notify();
  this.hydrateCurrentSessionImages(admittedMessages, this.state.sessionKey);
  return true;
}

export async function initializeConnectedSession(
  this: ChatControllerSessionContext,
  params: {
    client: GatewayClient;
    sessionKey: string;
    initializationSeq: number;
    resumedTransport: boolean;
  },
): Promise<void> {
  void this.loadProgressCard(params.sessionKey, true);
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

  // Main can start a run while the renderer transport is offline. A close
  // observed while idle has no suspended ID, so capture the current owner at
  // initialization as well instead of trusting the old transport label.
  const pendingRunId =
    this.state.transcript.activeTurn?.status === 'running'
      ? this.state.transcript.activeTurn.runId
      : this.state.chatSending
        ? (this.state.chatRunId ?? this.state.runActivity?.runId ?? null)
        : null;
  if (pendingRunId || (params.resumedTransport && this.suspendedRunId)) {
    this.suspendedRunId = pendingRunId ?? this.suspendedRunId;
    await this.reconcileSuspendedRun();
    for (const delayMs of this.initialHistoryRetryDelaysMs) {
      if (!this.suspendedRunId || !this.state.chatSending) break;
      if (!(await this.waitForInitialHistoryRetry(delayMs, params))) return;
      await this.reconcileSuspendedRun();
    }
    if (!this.state.initialHistoryReady && this.isConnectionInitializationCurrent(params)) {
      this.state.initialHistoryReady = true;
      this.notify();
    }
    return;
  }
  await this.loadInitialHistory(params);
}

export async function connect(
  this: ChatControllerSessionContext,
  url: string,
  token: string,
  sessionKey: string,
): Promise<void> {
  for (const key of this.manualCompactionRequestIdsBySession.keys()) {
    this.settleCompactionRequest(key);
    this.clearLocalCompactionStatus(key);
  }
  this.manualCompactionRequestIdsBySession.clear();
  this.rememberHistoryPagination(this.state.sessionKey);
  // Stop existing client
  this.state.client?.stop();
  this.messageSubscriptionSeq += 1;
  this.connectionInitializationSeq += 1;
  this.subscribedMessageSessionKey = null;
  this.progressCardLoadGeneration += 1;
  this.progressCardCache.clear();

  this.state.sessionKey = sessionKey;
  this.historyPagingGeneration += 1;
  this.state.currentSessionId = null;
  this.state.initialHistoryReady = false;
  this.state.historyReadFailed = false;
  this.state.historyLoadingOlder = false;
  this.restoreHistoryPagination(sessionKey);
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
  this.state.transcript.historySource = this.historySourceBySession.get(sessionKey) ?? 'optimistic';
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
  this.state.progressCard = null;
  this.state.progressCardLoading = false;
  this.state.progressCardAvailable = false;
  this.state.progressCardError = null;
  this.resetAssistantSnapshotSource();
  this.notify();

  const { GatewayClient } = await import('./client');
  const client = new GatewayClient({
    url,
    token,
    onHello: hello => this.handleHello(hello),
    onEvent: event => this.handleEvent(event),
    onGap: ({ expected, received }) => {
      debugLog('[ChatCtrl] Gateway event sequence gap; reconnecting for history recovery', {
        expected,
        received,
        sessionKey: this.state.sessionKey,
      });
    },
    onClose: () => this.handleClose(),
  });

  this.state.client = client;
  client.start();
}

export async function switchSession(
  this: ChatControllerSessionContext,
  sessionKey: string,
  options: SwitchSessionOptions = {},
): Promise<void> {
  const previousSessionKey = this.state.sessionKey;
  if (
    this.expectedPlanImplementationReset &&
    normalizeTranscriptSessionKey(this.expectedPlanImplementationReset.sessionKey) !==
      normalizeTranscriptSessionKey(sessionKey)
  ) {
    this.expectedPlanImplementationReset = null;
  }
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
  this.rememberHistoryPagination(previousSessionKey);
  if (isTempSessionPromotion && promotionSource) {
    this.promoteCachedSessionState(promotionSource, sessionKey);
  }
  this.state.sessionKey = sessionKey;
  this.historyPagingGeneration += 1;
  this.progressCardLoadGeneration += 1;
  this.state.progressCard = this.progressCardCache.get(sessionKey) ?? null;
  this.state.progressCardLoading = false;
  this.state.progressCardError = null;
  this.state.initialHistoryReady = false;
  this.state.historyReadFailed = false;
  this.state.historyLoadingOlder = false;
  this.restoreHistoryPagination(sessionKey);
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
  this.state.transcript.historySource = this.historySourceBySession.get(sessionKey) ?? 'optimistic';
  this.suspendedRunId = null;
  this.state.chatLoading = true;
  this.pendingHistoryReload = false;
  this.observedSessionMessageSeqBySession.clear();
  this.clearPostFinalHistoryReload();
  this.clearDeferredHistoryReload();
  this.clearActiveToolHistoryCatchUp();
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

export function disconnect(this: ChatControllerSessionContext): void {
  this.manualCompactionRequestIdsBySession.clear();
  this.settledCompactionEventIds.clear();
  this.clearLifecycleEndFallback();
  this.clearPostFinalHistoryReload();
  this.clearDeferredHistoryReload();
  this.clearActiveToolHistoryCatchUp();
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
  this.clearAllSideChatRuns();
  this.observedSessionMessageSeqBySession.clear();
  this.historyReloadRequested.clear();
  this.immediateHistoryReloadRequested.clear();
  this.connectionInitializationSeq += 1;
  this.messageSubscriptionSeq += 1;
  this.subscribedMessageSessionKey = null;
  this.progressCardLoadGeneration += 1;
  this.progressCardCache.clear();
  this.state.progressCard = null;
  this.state.progressCardLoading = false;
  this.state.progressCardAvailable = false;
  this.state.progressCardError = null;
  this.notify();
}

export function handleHello(this: ChatControllerSessionContext, hello: GatewayHelloOk): void {
  debugLog('[ChatCtrl] handleHello — connected, sessionKey:', this.state.sessionKey);
  const resumedTransport = this.state.transportStatus === 'reconnecting';
  this.state.connected = true;
  this.state.transportStatus = 'connected';
  this.messageSubscriptionSeq += 1;
  this.subscribedMessageSessionKey = null;
  this.state.hello = hello;
  this.state.lastError = null;
  this.state.progressCardAvailable = this.isGatewayMethodAdvertised(PROGRESS_CARD_GET_METHOD);
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

export function handleClose(this: ChatControllerSessionContext): void {
  // A reconnected socket must establish authoritative history again. Invalidate
  // requests on this transport even when GatewayClient reuses its identity.
  this.state.initialHistoryReady = false;
  this.connectionInitializationSeq += 1;
  this.historyPagingGeneration += 1;
  for (const runId of this.pendingSideChats.keys()) {
    this.publishSideChatFailure(runId);
    this.retainSideChatTombstone(runId);
  }
  // Progress observed on the lost transport is no longer an active fact.
  // Fresh native events/history can restore it; an unobserved failure must
  // not leave a permanent local "compacting" card after reconnection.
  for (const [sessionKey, status] of this.localCompactionStatusBySession) {
    if (status.message.__openclaw.phase !== 'in-progress') continue;
    this.clearLocalCompactionStatus(sessionKey);
    const cached = this.findLiveSessionState(sessionKey)?.[1];
    if (cached) cached.compactionInFlight = false;
  }
  const runInProgress =
    this.state.transcript.activeTurn?.status === 'running' ||
    (this.state.chatSending && this.state.runActivity !== null);
  this.suspendedRunId =
    this.state.transcript.activeTurn?.status === 'running'
      ? this.state.transcript.activeTurn.runId
      : this.state.chatSending
        ? (this.state.chatRunId ?? this.state.runActivity?.runId ?? null)
        : null;
  this.state.connected = false;
  this.state.transportStatus = this.state.client && runInProgress ? 'reconnecting' : 'disconnected';
  // A transport interruption is not a terminal run event. Preserve the
  // active turn and sending state until history or Gateway events establish
  // the business outcome.
  this.state.compactionInFlight = false;
  this.terminalLifecycleSeen = false;
  this.messageSubscriptionSeq += 1;
  this.subscribedMessageSessionKey = null;
  this.progressCardLoadGeneration += 1;
  this.state.progressCard = null;
  this.state.progressCardLoading = false;
  this.state.progressCardAvailable = false;
  this.notify();
}

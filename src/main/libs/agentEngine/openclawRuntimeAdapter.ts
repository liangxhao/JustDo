import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';


import type {
  CoworkExecutionMode,
  CoworkMessage,
  CoworkSession,
  CoworkSessionStatus,
  CoworkStore,
} from '../../coworkStore';
import { t } from '../../i18n';
import { resolveRawApiConfig } from '../claudeSettings';
import { getCommandDangerLevel, isDeleteCommand } from '../commandSafety';
import { setCoworkProxySessionId } from '../coworkOpenAICompatProxy';

import {
  buildManagedSessionKey,
  isCronSessionKey,
  isManagedSessionKey,
  type OpenClawChannelSessionSync,
  parseManagedSessionKey,
} from '../openclawChannelSessionSync';
import { OPENCLAW_AGENT_TIMEOUT_SECONDS } from '../openclawConfigSync';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../openclawEngineManager';
import { extractGatewayHistoryEntries } from '../openclawHistory';
import type { PermissionResult } from './types';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  PermissionRequest,
} from './types';

// Shared gateway types
import type {
  GatewayEventFrame,
  GatewayClientLike,
  GatewayClientCtor,
  ChatEventPayload,
  AgentEventPayload,
  ExecApprovalRequestedPayload,
  ExecApprovalResolvedPayload,
  ChannelHistorySyncEntry,
  ActiveTurn,
} from './gateway/types';
import type { PendingApprovalEntry } from './eventHandlers/approvalHandler';
import { AgentToolEventHandler } from './eventHandlers/agentToolEvent';
import { AgentEventProcessor } from './eventHandlers/agentEventProcessor';
import { ChatEventProcessor } from './eventHandlers/chatEventProcessor';
import { SubagentManager } from './subagent/subagentManager';
import { HistoryReconciler } from './history/historyReconciler';
import { SubtaskHistory } from './history/subtaskHistory';
import { SkillRpcHandler } from './rpc/skillRpc';

// Shared utility functions and constants
import {
  isRecord,
  stripDiscordMentions,
  waitWithTimeout,
  extractMessageText,
  isSameChannelHistoryEntry,
  OPENCLAW_GATEWAY_TOOL_EVENTS_CAP,
  GATEWAY_READY_TIMEOUT_MS,
  FINAL_HISTORY_SYNC_LIMIT,
  CHANNEL_SESSION_DISCOVERY_LIMIT,
} from './utils/gatewayHelpers';

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly pendingAgentEventsByRunId = new Map<string, AgentEventPayload[]>();
  private readonly lastChatSeqByRunId = new Map<string, number>();
  /** Track processed announce runId finals to prevent duplicate message creation. */
  private readonly processedAnnounceRunIds = new Set<string>();
  /** Accumulated thinking content from subagent announce runs, keyed by runId. */
  private readonly subagentThinkingByRunId = new Map<string, string>();
  /** Accumulated chat text from announce runIds (different from main turn.runId).
   *  Delta events from announce runs carry accumulated text; we store it here
   *  and create streaming messages so the UI shows announce text progressively
   *  instead of only when the final event arrives. */
  private readonly announceTextByRunId = new Map<string, string>();
  private readonly lastAgentSeqByRunId = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly pendingTurns = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly gatewayHistoryCountBySession = new Map<string, number>();
  private readonly latestTurnTokenBySession = new Map<string, number>();

  /**
   * Sessions that were manually stopped by the user via stopSession().
   * Maps sessionId → timestamp of when stop was requested.
   * Used to suppress automatic ActiveTurn re-creation from late-arriving
   * OpenClaw Gateway events (e.g. POPO/Telegram channel events that arrive
   * after the user clicked Stop).  Entries expire after STOP_COOLDOWN_MS.
   */
  private readonly stoppedSessions = new Map<string, number>();
  private static readonly STOP_COOLDOWN_MS = 10_000; // 10 seconds

  /**
   * Sessions waiting for subagent completion after main agent's handleChatFinal.
   * These sessions should NOT have ActiveTurn re-created by ensureActiveTurn
   * when late-arriving announce events (thinking/assistant) from completed subagents arrive.
   * Prevents the "hasNewTurn=true" infinite loop in delayed check.
   */
  private readonly pendingSubagentCompletionSessions = new Set<string>();

  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  /** Holds the client between start() and onHelloOk so stopGatewayClient can clean it up. */
  private pendingGatewayClient: GatewayClientLike | null = null;
  private gatewayReadyPromise: Promise<void> | null = null;
  /** Serializes concurrent calls to ensureGatewayClientReady to prevent duplicate clients. */
  private gatewayClientInitLock: Promise<void> | null = null;
  private channelSessionSync: OpenClawChannelSessionSync | null = null;
  private readonly knownChannelSessionIds = new Set<string>();
  private readonly fullySyncedSessions = new Set<string>();
  /** Per-session cursor: number of gateway history entries (user+assistant) already synced locally. */
  private readonly channelSyncCursor = new Map<string, number>();
  /** Sessions re-created after user deletion — use latestOnly sync to avoid replaying old history. */
  private readonly reCreatedChannelSessionIds = new Set<string>();
  /** Channel sessionKeys explicitly deleted by the user. Polling will not re-create these. */
  private readonly deletedChannelKeys = new Set<string>();
  /** Sessions that were manually stopped by the user. Used to suppress the timeout hint
   *  when the gateway sends back a late 'aborted' event after stopSession() already cleaned up the turn. */
  private readonly manuallyStoppedSessions = new Set<string>();
  /** Session keys whose origin is "heartbeat" — discovered via polling, used to filter real-time events. */
  private readonly heartbeatSessionKeys = new Set<string>();
  private channelPollingTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly CHANNEL_POLL_INTERVAL_MS = 10_000;
  private static readonly FULL_HISTORY_SYNC_LIMIT = 50;
  private browserPrewarmAttempted = false;

  /** Gateway WS auto-reconnect state */
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;
  /** Set to true before intentionally stopping the client (e.g. version upgrade) to suppress auto-reconnect. */
  private gatewayStoppingIntentionally = false;
  private static readonly GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
  private static readonly GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000]; // ms

  /** Gateway tick heartbeat watchdog state */
  private lastTickTimestamp = 0;
  /** Last time we received any agent event — used to detect false tick timeout during heavy activity. */
  private lastAgentActivityTimestamp = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly TICK_WATCHDOG_INTERVAL_MS = 60_000; // check every 60s
  private static readonly TICK_TIMEOUT_MS = 90_000; // 3 tick cycles (30s each) without response → dead
  /** Agent activity within this window proves connection is alive even without tick. */
  private static readonly AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000; // 60s

  /** Throttle state for messageUpdate IPC emissions during streaming */
  private lastMessageUpdateEmitTime: Map<string, number> = new Map();
  private pendingMessageUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly MESSAGE_UPDATE_THROTTLE_MS = 200;

  /**
   * Server-side agent timeout in seconds (mirrors agents.defaults.timeoutSeconds in openclaw config).
   * Used to set a client-side fallback timer that fires slightly after the server timeout,
   * so GucciAI can recover even when the gateway fails to deliver the abort event.
   */
  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;
  private static readonly CLIENT_TIMEOUT_GRACE_MS = 30_000;

  /** 子 Agent 消息历史: agentId/label → 消息数组 */
  private readonly subagentMessages = new Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >();

  // Track which non-thinking stream types we've already logged (avoid spam)
  private readonly _loggedThinkingStreamTypes = new Set<string>();
  /** Dedup set for tool events: same (phase + toolCallId) arriving via stream=tool and stream=item. */
  private readonly _processedToolEvents = new Set<string>();
  /** Track toolUseIds created from subagent handler to avoid duplicate messages in main session */
  private readonly _announceToolMessages = new Set<string>();
  /** 子 Agent 完成状态: agentId/label → 'pending' | 'running' | 'done' | 'failed' */
  private readonly subagentStatus = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
  /** 失败的子 Agent toolCallId 集合（启动失败，应从显示列表中移除） */
  private readonly failedSubagentIds = new Set<string>();
  /** 成功 spawn 的子 Agent toolCallId 集合（spawn 返回 isError=false），生命周期 error 不标记这些为失败 */
  private readonly successfulSpawnToolCallIds = new Set<string>();
  /** Per-session orchestration tracking: sessionId -> true. Replaces single-value orchestrationParentSessionId to support concurrent sessions. */
  private readonly orchestrationSessionIds = new Set<string>();
  /** @deprecated Use orchestrationSessionIds instead. Kept for backward compat with getSubagentStatuses caller. */
  private orchestrationParentSessionId: string | null = null;
  /** 主 agent 生命周期是否已结束（用于不同 runId final 事件后的完成检查） */
  private mainAgentLifecycleEnded = false;
  /** childSessionKey → label 反向映射（用于显示） */
  private readonly sessionKeyToLabel = new Map<string, string>();
  /** toolCallId → childSessionKey 映射，用于通过 toolUseId 查找子会话 */
  private readonly toolCallIdToSessionKey = new Map<string, string>();
  /** childSessionKey → toolCallId 反向映射 */
  private readonly sessionKeyToToolCallId = new Map<string, string>();
  /** toolCallId → parentSessionId 映射，用于判断subagent属于哪个主session */
  private readonly toolCallIdToParentSessionId = new Map<string, string>();
  /** toolCallId → args 映射，用于在 result 阶段获取 sessions_spawn 的参数 */
  private readonly toolCallArgs = new Map<string, Record<string, unknown>>();
  /** toolCallId → label 映射，用于显示名称 */
  private readonly toolCallIdToLabel = new Map<string, string>();
  /** subagent UUID → label mapping (for nested subagents identified by sessionKey UUID) */
  private readonly subagentUuidToLabel = new Map<string, string>();
  /** 正在等待 sessionKey 的 toolCallId 集合 */
  private readonly pendingToolCallIds = new Set<string>();
  /** Pending subagent timeout: toolCallId → timestamp when it entered pending state */
  private readonly pendingEntryTimestamps = new Map<string, number>();
  private static readonly PENDING_TIMEOUT_MS = 30_000; // 30s without lifecycle events → failed
  /** Subagent idle timeout: if a subagent in 'running' state has no activity for this duration,
   *  mark it as failed. This catches cases where the gateway stops sending events (e.g. quota
   *  exceeded as the last event) but the subagent internally completed. 10 minutes is conservative
   *  enough to avoid false positives for legitimate long-running tasks with intermittent activity. */

  /** Cross-reference: UUID → call_... toolCallId.
   *  Nested lifecycle phase=start uses sessionKey UUID as key, but context messages
   *  are stored under call_... keys by the sessions_spawn handler. This map bridges
   *  the gap so getSubTaskHistory can find context when queried by UUID. */
  private readonly uuidToToolCallId = new Map<string, string>();

  private sweeperStarted = false;

  private subagentManager!: SubagentManager;
  private historyReconciler!: HistoryReconciler;
  private subtaskHistory!: SubtaskHistory;
  private agentToolEventHandler!: AgentToolEventHandler;
  private agentEventProcessor!: AgentEventProcessor;
  private chatEventProcessor!: ChatEventProcessor;
  private skillRpcHandler!: SkillRpcHandler;

  constructor(store: CoworkStore, engineManager: OpenClawEngineManager) {
    super();
    this.store = store;
    this.engineManager = engineManager;
    this.subagentManager = new SubagentManager({
      store: this.store,
      gatewayClient: null, // will be set via updateGatewayClientReference
      emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      subagentStatus: this.subagentStatus,
      failedSubagentIds: this.failedSubagentIds,
      successfulSpawnToolCallIds: this.successfulSpawnToolCallIds,
      toolCallIdToSessionKey: this.toolCallIdToSessionKey,
      sessionKeyToToolCallId: this.sessionKeyToToolCallId,
      toolCallIdToLabel: this.toolCallIdToLabel,
      toolCallIdToParentSessionId: this.toolCallIdToParentSessionId,
      toolCallArgs: this.toolCallArgs,
      subagentUuidToLabel: this.subagentUuidToLabel,
      sessionKeyToLabel: this.sessionKeyToLabel,
      uuidToToolCallId: this.uuidToToolCallId,
      pendingToolCallIds: this.pendingToolCallIds,
      pendingEntryTimestamps: this.pendingEntryTimestamps,
      subagentMessages: this.subagentMessages,
      orchestrationSessionIds: this.orchestrationSessionIds,
      orchestrationParentSessionId: this.orchestrationParentSessionId,
      activeTurns: this.activeTurns,
      mainAgentLifecycleEnded: this.mainAgentLifecycleEnded,
      resolveSubagentParentSessionId: (agentId: string) =>
        this.resolveSubagentParentSessionId(agentId),
      _announceToolMessages: this._announceToolMessages,
      _processedToolEvents: this._processedToolEvents,
      subagentThinkingByRunId: this.subagentThinkingByRunId,
      announceTextByRunId: this.announceTextByRunId,
      lastAgentSeqByRunId: this.lastAgentSeqByRunId,
      pendingAgentEventsByRunId: this.pendingAgentEventsByRunId,
      processedAnnounceRunIds: this.processedAnnounceRunIds,
    });
    this.historyReconciler = new HistoryReconciler({
      getSession: (id: string) => this.store.getSession(id),
      getAgent: (id: string) => this.store.getAgent(id),
      addMessage: (id: string, msg: Parameters<CoworkStore['addMessage']>[1]) =>
        this.store.addMessage(id, msg),
      updateMessage: (
        id: string,
        msgId: string,
        patch: Parameters<CoworkStore['updateMessage']>[2],
      ) => this.store.updateMessage(id, msgId, patch),
      deleteMessage: (id: string, msgId: string) => this.store.deleteMessage(id, msgId),
      replaceConversationMessages: (
        id: string,
        entries: Parameters<CoworkStore['replaceConversationMessages']>[1],
      ) => this.store.replaceConversationMessages(id, entries),
      getGatewayClient: () => this.gatewayClient,
      getGatewayHistoryCount: (id: string) => this.gatewayHistoryCountBySession.get(id),
      setGatewayHistoryCount: (id: string, count: number) => {
        this.gatewayHistoryCountBySession.set(id, count);
      },
      hasGatewayHistoryCount: (id: string) => this.gatewayHistoryCountBySession.has(id),
      setChannelSyncCursor: (id: string, cursor: number) => {
        this.channelSyncCursor.set(id, cursor);
      },
      emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      isCurrentTurnToken: (id: string, token: number) => this.isCurrentTurnToken(id, token),
      resolveAssistantSegmentText: (turn: ActiveTurn, text: string) =>
        this.resolveAssistantSegmentText(turn, text),
      reuseFinalAssistantMessage: (id: string, content: string) =>
        this.reuseFinalAssistantMessage(id, content),
      isChannelSessionKey: (key: string) =>
        this.channelSessionSync?.isChannelSessionKey(key) ?? false,
      isReCreatedChannelSession: (id: string) => this.reCreatedChannelSessionIds.has(id),
      syncChannelUserMessages: (
        id: string,
        msgs: unknown[],
        latestOnly: boolean,
        isDiscord: boolean,
      ) => this.syncChannelUserMessages(id, msgs, latestOnly, isDiscord),
      getFullHistorySyncLimit: () => OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT,
    });
    this.skillRpcHandler = new SkillRpcHandler({
      ensureGatewayClientReady: () => this.ensureGatewayClientReady(),
      requireGatewayClient: () => this.requireGatewayClient(),
      getGatewayClient: () => this.gatewayClient,
      store: this.store,
    });
    this.subtaskHistory = new SubtaskHistory({
      ensureGatewayClientReady: () => this.ensureGatewayClientReady(),
      getGatewayClient: () => this.gatewayClient,
      historyReconciler: this.historyReconciler,
      sessionKeyToLabel: this.sessionKeyToLabel,
      store: this.store,
      subagentMessages: this.subagentMessages,
      toolCallIdToSessionKey: this.toolCallIdToSessionKey,
      uuidToToolCallId: this.uuidToToolCallId,
    });
    this.agentToolEventHandler = new AgentToolEventHandler({
      processedToolEvents: this._processedToolEvents,
      toolCallArgs: this.toolCallArgs,
      subagentStatus: this.subagentStatus,
      pendingToolCallIds: this.pendingToolCallIds,
      pendingEntryTimestamps: this.pendingEntryTimestamps,
      toolCallIdToSessionKey: this.toolCallIdToSessionKey,
      toolCallIdToParentSessionId: this.toolCallIdToParentSessionId,
      toolCallIdToLabel: this.toolCallIdToLabel,
      subagentMessages: this.subagentMessages,
      successfulSpawnToolCallIds: this.successfulSpawnToolCallIds,
      sessionKeyToToolCallId: this.sessionKeyToToolCallId,
      sessionKeyToLabel: this.sessionKeyToLabel,
      subagentUuidToLabel: this.subagentUuidToLabel,
      failedSubagentIds: this.failedSubagentIds,
      orchestrationParentSessionId: this.orchestrationParentSessionId,
      store: this.store,
      subagentManager: this.subagentManager,
      resolveSubagentParentSessionId: (agentId: string) =>
        this.resolveSubagentParentSessionId(agentId),
      emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      splitAssistantSegmentBeforeTool: (sessionId: string, turn: ActiveTurn) =>
        this.splitAssistantSegmentBeforeTool(sessionId, turn),
      getGatewayConnectionInfo: () => this.engineManager.getGatewayConnectionInfo(),
    });
    this.agentEventProcessor = new AgentEventProcessor({
      _announceToolMessages: this._announceToolMessages,
      activeTurns: this.activeTurns,
      deletedChannelKeys: this.deletedChannelKeys,
      emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      ensureActiveTurn: (sessionId: string, sessionKey: string, runId: string) =>
        this.ensureActiveTurn(sessionId, sessionKey, runId),
      failedSubagentIds: this.failedSubagentIds,
      fullySyncedSessions: this.fullySyncedSessions,
      handleAgentToolEvent: (sessionId: string, turn: ActiveTurn, data: unknown) =>
        this.handleAgentToolEvent(sessionId, turn, data),
      heartbeatSessionKeys: this.heartbeatSessionKeys,
      lastAgentSeqByRunId: this.lastAgentSeqByRunId,
      latestTurnTokenBySession: this.latestTurnTokenBySession,
      mainAgentLifecycleEnded: this.mainAgentLifecycleEnded,
      orchestrationParentSessionId: this.orchestrationParentSessionId,
      pendingAgentEventsByRunId: this.pendingAgentEventsByRunId,
      pendingEntryTimestamps: this.pendingEntryTimestamps,
      pendingToolCallIds: this.pendingToolCallIds,
      reCreatedChannelSessionIds: this.reCreatedChannelSessionIds,
      resolveSubagentParentSessionId: (agentId: string) =>
        this.resolveSubagentParentSessionId(agentId),
      sessionIdByRunId: this.sessionIdByRunId,
      sessionIdBySessionKey: this.sessionIdBySessionKey,
      sessionKeyToLabel: this.sessionKeyToLabel,
      sessionKeyToToolCallId: this.sessionKeyToToolCallId,
      store: this.store,
      subagentManager: this.subagentManager,
      subagentMessages: this.subagentMessages,
      subagentStatus: this.subagentStatus,
      subagentUuidToLabel: this.subagentUuidToLabel,
      successfulSpawnToolCallIds: this.successfulSpawnToolCallIds,
      toSessionKey: (sessionId: string, agentId?: string) => this.toSessionKey(sessionId, agentId),
      toolCallArgs: this.toolCallArgs,
      toolCallIdToLabel: this.toolCallIdToLabel,
      toolCallIdToParentSessionId: this.toolCallIdToParentSessionId,
      toolCallIdToSessionKey: this.toolCallIdToSessionKey,
      uuidToToolCallId: this.uuidToToolCallId,
    });
    this.chatEventProcessor = new ChatEventProcessor({
      _loggedThinkingStreamTypes: this._loggedThinkingStreamTypes,
      activeTurns: this.activeTurns,
      announceTextByRunId: this.announceTextByRunId,
      cleanupSessionTurn: (sessionId: string) => this.cleanupSessionTurn(sessionId),
      clearPendingMessageUpdate: (messageId: string) => this.clearPendingMessageUpdate(messageId),
      emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      ensureActiveTurn: (sessionId: string, sessionKey: string, runId: string) =>
        this.ensureActiveTurn(sessionId, sessionKey, runId),
      finalizeThinkingMessage: (sessionId: string, messageId: string, content: string) =>
        this.finalizeThinkingMessage(sessionId, messageId, content),
      gatewayClient: null as GatewayClientLike | null,
      handleAgentThinkingEvent: (sessionId: string, turn: ActiveTurn, data: unknown) =>
        this.handleAgentThinkingEvent(sessionId, turn, data),
      heartbeatSessionKeys: this.heartbeatSessionKeys,
      historyReconciler: this.historyReconciler,
      lastChatSeqByRunId: this.lastChatSeqByRunId,
      manuallyStoppedSessions: this.manuallyStoppedSessions,
      pendingEntryTimestamps: this.pendingEntryTimestamps,
      pendingToolCallIds: this.pendingToolCallIds,
      processedAnnounceRunIds: this.processedAnnounceRunIds,
      rejectTurn: (sessionId: string, error: Error) => this.rejectTurn(sessionId, error),
      rememberSessionKey: (sessionId: string, sessionKey: string) =>
        this.rememberSessionKey(sessionId, sessionKey),
      resolveSessionIdBySessionKey: (sessionKey: string) =>
        this.resolveSessionIdBySessionKey(sessionKey),
      resolveSessionIdFromChatPayload: (payload: ChatEventPayload) =>
        this.resolveSessionIdFromChatPayload(payload),
      resolveTurn: (sessionId: string) => this.resolveTurn(sessionId),
      reuseFinalAssistantMessage: (sessionId: string, content: string) =>
        this.reuseFinalAssistantMessage(sessionId, content),
      sessionIdByRunId: this.sessionIdByRunId,
      sessionKeyToToolCallId: this.sessionKeyToToolCallId,
      store: this.store,
      subagentManager: this.subagentManager,
      subagentMessages: this.subagentMessages,
      subagentStatus: this.subagentStatus,
      subagentThinkingByRunId: this.subagentThinkingByRunId,
      throttledEmitMessageUpdate: (sessionId: string, messageId: string, content: string) =>
        this.throttledEmitMessageUpdate(sessionId, messageId, content),
      toolCallIdToParentSessionId: this.toolCallIdToParentSessionId,
      uuidToToolCallId: this.uuidToToolCallId,
      markPendingSubagentCompletion: (sessionId: string) =>
        this.markPendingSubagentCompletion(sessionId),
      clearPendingSubagentCompletion: (sessionId: string) =>
        this.clearPendingSubagentCompletion(sessionId),
    });
  }

  setChannelSessionSync(sync: OpenClawChannelSessionSync): void {
    this.channelSessionSync = sync;
    this.chatEventProcessor.setChannelSessionSync(sync);
  }

  /**
   * Resolve the correct parent session ID for a subagent.
   * Uses per-subagent mapping (toolCallIdToParentSessionId) when available,
   * falling back to orchestrationParentSessionId for compatibility.
   * This prevents cross-session message leakage when multiple sessions
   * have active subagents concurrently.
   */
  private resolveSubagentParentSessionId(agentId: string): string | null {
    // Prefer per-subagent mapping — this is the authoritative source
    const mappedParent = this.toolCallIdToParentSessionId.get(agentId);
    if (mappedParent) return mappedParent;
    // Fallback: if only one orchestration session exists, use it safely
    if (this.orchestrationSessionIds.size === 1) {
      return Array.from(this.orchestrationSessionIds)[0];
    }
    // Multiple concurrent sessions — do NOT guess, return null
    return this.orchestrationParentSessionId;
  }

  /**
   * Fetch session history from OpenClaw by sessionKey and return a transient
   * CoworkSession object (not persisted to local database).
   * First checks if a local session already exists via channel sync.
   * Returns a CoworkSession if successful, or null.
   */
  async fetchSessionByKey(sessionKey: string): Promise<CoworkSession | null> {
    const managedSession = parseManagedSessionKey(sessionKey);
    if (managedSession) {
      return this.store.getSession(managedSession.sessionId) ?? null;
    }

    // 1. Try existing local session via channel/main-agent resolution
    if (this.channelSessionSync) {
      const existingId = this.channelSessionSync.resolveSession(sessionKey);
      if (existingId) {
        const session = this.store.getSession(existingId);
        if (session && session.messages.length > 0) {
          return session;
        }
      }
    }

    // 2. Fetch history from OpenClaw server and build a transient session object
    const client = this.gatewayClient;
    if (!client) return null;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        return this.readFromDeletedTranscript(sessionKey);
      }

      const now = Date.now();
      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const entry of extractGatewayHistoryEntries(history.messages)) {
        messages.push({
          id: `transient-${msgIndex++}`,
          type: entry.role,
          content: entry.text,
          timestamp: now,
          metadata: entry.role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
        });
      }

      if (messages.length === 0) return null;

      // Return a transient session (not saved to database)
      return {
        id: `transient-${sessionKey}`,
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        agentId: 'main',
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      console.error('[OpenClawRuntime] fetchSessionByKey: failed to fetch history:', error);
      return null;
    }
  }

  /**
   * Fallback for fetchSessionByKey when chat.history returns no messages.
   *
   * openclaw's maintenance logic may archive a session transcript by renaming
   * `{sessionId}.jsonl` → `{sessionId}.jsonl.deleted.{timestamp}` while the
   * session entry remains in sessions.json. In that case chat.history cannot
   * find the file (it only looks for the plain `.jsonl` path) and returns [].
   * This method reads the archived file directly from disk.
   */
  private async readFromDeletedTranscript(sessionKey: string): Promise<CoworkSession | null> {
    try {
      // Extract agentId from "agent:{agentId}:..." pattern
      const agentMatch = sessionKey.match(/^agent:([^:]+):/);
      const agentId = agentMatch?.[1] ?? 'main';

      // Extract sessionId from "...run:{uuid}" pattern (runId equals sessionId)
      const runMatch = sessionKey.match(/(?:^|:)run:([0-9a-f-]{36})(?:$|:)/i);
      const sessionId = runMatch?.[1];
      if (!sessionId) return null;

      const stateDir = this.engineManager.getStateDir();
      const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions');

      const files = await fs.promises.readdir(sessionsDir).catch(() => [] as string[]);
      const deletedFile = files.find(f => f.startsWith(`${sessionId}.jsonl.deleted.`));
      if (!deletedFile) {
        console.log(
          '[OpenClawRuntime] readFromDeletedTranscript: no archived transcript found for sessionId:',
          sessionId,
        );
        return null;
      }

      console.log(
        '[OpenClawRuntime] readFromDeletedTranscript: reading archived transcript:',
        deletedFile,
      );
      const filePath = path.join(sessionsDir, deletedFile);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed?.type !== 'message' || !parsed.message) continue;
          const msg = parsed.message as { role?: string; content?: unknown; timestamp?: number };
          const role = msg.role;
          if (role !== 'user' && role !== 'assistant') continue;

          const msgContent = msg.content;
          const text = Array.isArray(msgContent)
            ? (msgContent as Array<Record<string, unknown>>)
                .filter(b => b?.type === 'text')
                .map(b => b.text as string)
                .join('\n')
            : typeof msgContent === 'string'
              ? msgContent
              : '';

          if (!text.trim()) continue;

          const timestamp =
            typeof msg.timestamp === 'number'
              ? msg.timestamp
              : typeof parsed.timestamp === 'string'
                ? Date.parse(parsed.timestamp)
                : Date.now();

          messages.push({
            id: `transient-${msgIndex++}`,
            type: role as 'user' | 'assistant',
            content: text,
            timestamp,
            metadata: role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
          });
        } catch {
          // skip malformed lines
        }
      }

      if (messages.length === 0) return null;

      const firstTimestamp = messages[0]?.timestamp ?? Date.now();
      return {
        id: `transient-${sessionKey}`,
        agentId: '',
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        createdAt: firstTimestamp,
        updatedAt: firstTimestamp,
      };
    } catch (error) {
      console.warn('[OpenClawRuntime] readFromDeletedTranscript failed:', error);
      return null;
    }
  }

  /**
   * Ensure the gateway WebSocket client is connected.
   * Called when IM channels (e.g. Telegram) are enabled in OpenClaw mode
   * so that channel-originated events can be received without waiting
   * for a GucciAI-initiated session.
   */
  async connectGatewayIfNeeded(): Promise<void> {
    if (this.gatewayClient) {
      console.log('[ChannelSync] connectGatewayIfNeeded: gateway client already exists, skipping');
      return;
    }
    console.log('[ChannelSync] connectGatewayIfNeeded: no gateway client, initializing...');
    try {
      await this.ensureGatewayClientReady();
      console.log(
        '[ChannelSync] connectGatewayIfNeeded: gateway client ready, starting channel polling',
      );
      this.startChannelPolling();
    } catch (error) {
      console.error(
        '[ChannelSync] connectGatewayIfNeeded: failed to initialize gateway client:',
        error,
      );
      throw error;
    }
  }

  /**
   * Force-reconnect the gateway WebSocket client.
   * Used after the OpenClaw gateway process has been restarted (e.g. after config sync).
   * Unlike `connectGatewayIfNeeded`, this always tears down the old client first
   * to avoid a race where the old client's `onClose` fires after a new client is created.
   */
  async reconnectGateway(): Promise<void> {
    console.log('[ChannelSync] reconnectGateway: tearing down old client and reconnecting...');
    this.stopGatewayClient();
    try {
      await this.ensureGatewayClientReady();
      console.log('[ChannelSync] reconnectGateway: gateway client ready, starting channel polling');
      this.startChannelPolling();
    } catch (error) {
      console.error('[ChannelSync] reconnectGateway: failed to initialize gateway client:', error);
      throw error;
    }
  }

  /**
   * Explicitly disconnect the gateway WebSocket client.
   * Called before the OpenClaw gateway process is restarted so that the old
   * client's async `onClose` handler cannot interfere with a subsequently
   * created client.
   */
  disconnectGatewayClient(): void {
    console.log('[ChannelSync] disconnectGatewayClient: explicitly tearing down gateway client');
    this.stopGatewayClient();
  }

  /**
   * Start periodic polling for channel-originated sessions (e.g. Telegram).
   * Uses the gateway `sessions.list` RPC to discover sessions that may not
   * have been delivered via WebSocket events.
   */
  startChannelPolling(): void {
    if (!this.channelSessionSync) {
      console.warn('[ChannelSync] startChannelPolling: no channelSessionSync set, skipping');
      return;
    }
    // Already running
    if (this.channelPollingTimer) {
      console.log('[ChannelSync] startChannelPolling: already running, skipping');
      return;
    }

    console.log('[ChannelSync] startChannelPolling: starting periodic channel session discovery');
    // Run once immediately, then at interval
    void this.pollChannelSessions();
    this.channelPollingTimer = setInterval(() => {
      void this.pollChannelSessions();
    }, OpenClawRuntimeAdapter.CHANNEL_POLL_INTERVAL_MS);
  }

  stopChannelPolling(): void {
    if (this.channelPollingTimer) {
      clearInterval(this.channelPollingTimer);
      this.channelPollingTimer = null;
    }
  }

  private async pollChannelSessions(): Promise<void> {
    if (!this.gatewayClient || !this.channelSessionSync) {
      console.warn(
        '[ChannelSync] pollChannelSessions: skipped — gatewayClient:',
        !!this.gatewayClient,
        'channelSessionSync:',
        !!this.channelSessionSync,
      );
      return;
    }
    try {
      const params = { activeMinutes: 60, limit: CHANNEL_SESSION_DISCOVERY_LIMIT };
      const result = await this.gatewayClient.request('sessions.list', params);
      const sessions = (result as Record<string, unknown>)?.sessions;
      if (!Array.isArray(sessions)) {
        console.warn(
          '[ChannelSync] pollChannelSessions: sessions.list returned non-array sessions:',
          typeof sessions,
          'full result keys:',
          Object.keys(result as Record<string, unknown>),
        );
        return;
      }
      let hasNew = false;
      let channelCount = 0;
      const newSessionsToSync: Array<{ sessionId: string; sessionKey: string }> = [];
      for (const row of sessions) {
        const key = typeof row?.key === 'string' ? row.key : '';
        if (!key) continue;
        // Skip heartbeat-originated sessions (origin.label === 'heartbeat')
        if (isRecord(row)) {
          const rowOrigin = (row as Record<string, unknown>).origin;
          if (isRecord(rowOrigin) && (rowOrigin as Record<string, unknown>).label === 'heartbeat') {
            this.heartbeatSessionKeys.add(key);
            continue;
          }
        }
        const isChannel = this.channelSessionSync.isChannelSessionKey(key);
        if (!isChannel) continue;
        // Skip keys that were explicitly deleted by the user — only real-time events re-create them
        if (this.deletedChannelKeys.has(key)) continue;
        // Skip gateway sessions belonging to a previously-bound agent.
        // After an agent binding change, the gateway retains old sessions under the old agentId.
        // Only process sessions matching the current platformAgentBindings.
        if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
        channelCount++;
        // Use resolveOrCreateSession so new channel sessions are auto-created
        const sessionId = this.channelSessionSync.resolveOrCreateSession(key);
        if (sessionId && !this.knownChannelSessionIds.has(sessionId)) {
          this.knownChannelSessionIds.add(sessionId);
          this.rememberSessionKey(sessionId, key);
          hasNew = true;
          // Queue full history sync for newly discovered sessions
          if (!this.fullySyncedSessions.has(sessionId)) {
            newSessionsToSync.push({ sessionId, sessionKey: key });
          }
        }
      }
      if (hasNew) {
        let notified = 0;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('cowork:sessions:changed');
            notified++;
          }
        }
        console.log(
          '[ChannelSync] discovered',
          channelCount,
          'channel sessions, notified',
          notified,
          'windows',
        );
      }
      // Sync full history for newly discovered sessions
      for (const { sessionId, sessionKey } of newSessionsToSync) {
        await this.syncFullChannelHistory(sessionId, sessionKey);
      }

      // Incremental sync for already-known sessions: check if the gateway has messages
      // that weren't picked up during initial sync or real-time events.
      if (channelCount > 0) {
        const syncedThisCycle = new Set<string>();
        for (const row of sessions) {
          const key = typeof row?.key === 'string' ? row.key : '';
          if (!key) continue;
          if (!this.channelSessionSync.isChannelSessionKey(key)) continue;
          if (this.deletedChannelKeys.has(key)) continue;
          if (this.heartbeatSessionKeys.has(key)) continue;
          // Skip sessions belonging to a previously-bound agent
          if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
          const sessionId = this.sessionIdBySessionKey.get(key);
          if (!sessionId || !this.fullySyncedSessions.has(sessionId)) continue;
          // Safety net: only sync each sessionId once per poll cycle
          if (syncedThisCycle.has(sessionId)) continue;
          syncedThisCycle.add(sessionId);
          // Skip sessions with an active turn (they handle their own sync)
          if (this.activeTurns.has(sessionId)) continue;
          try {
            await this.incrementalChannelSync(sessionId, key);
          } catch (err) {
            console.warn('[ChannelSync] incremental sync failed for', key, err);
          }
        }
      }
    } catch (error) {
      console.error('[ChannelSync] pollChannelSessions: error during polling:', error);
    }
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(
    sessionId: string,
    prompt: string,
    options: CoworkStartOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: options.skipInitialUserMessage,
      skillIds: options.skillIds,
      confirmationMode: options.confirmationMode,
      imageAttachments: options.imageAttachments,
      agentId: options.agentId,
    });
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: CoworkContinueOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: false,
      skillIds: options.skillIds,
      imageAttachments: options.imageAttachments,
    });
  }

  stopSession(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
      this.manuallyStoppedSessions.add(sessionId);
      // Clear pending subagent completion marker since we're manually stopping
      this.clearPendingSubagentCompletion(sessionId);
      const client = this.gatewayClient;
      if (client) {
        void client
          .request('chat.abort', {
            sessionKey: turn.sessionKey,
            runId: turn.runId,
          })
          .catch(error => {
            console.warn('[OpenClawRuntime] Failed to abort chat run:', error);
          });
      }
    }

    // Record the stop timestamp so that late-arriving gateway events
    // (e.g. from POPO/Telegram channels) don't re-create the ActiveTurn.
    this.stoppedSessions.set(sessionId, Date.now());

    // 清理编排状态（per-session tracking）
    this.orchestrationSessionIds.delete(sessionId);
    if (this.orchestrationParentSessionId === sessionId) {
      this.orchestrationParentSessionId =
        this.orchestrationSessionIds.size > 0 ? Array.from(this.orchestrationSessionIds)[0] : null;
      this.subagentManager.setOrchestrationParentSessionId(this.orchestrationParentSessionId);
      // 保留消息和状态一段时间供 UI 查询，延迟清理
      // CRITICAL: Only clear transient data, keep subagentStatus and mappings
      // for other sessions to display their subagent status correctly
      setTimeout(() => {
        this.subagentMessages.clear();
        // Keep: subagentStatus, toolCallIdToSessionKey, sessionKeyToToolCallId, toolCallIdToLabel
        // These are needed for other sessions' subagent status display
        this.sessionKeyToLabel.clear();
        this.toolCallArgs.clear();
        this._announceToolMessages.clear();
        // Keep: subagentStatus, toolCallIdToSessionKey, sessionKeyToToolCallId, toolCallIdToLabel
      }, 60000);
    }

    this.cleanupSessionTurn(sessionId);
    this.clearPendingApprovalsBySession(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  stopAllSessions(): void {
    const activeSessionIds = Array.from(this.activeTurns.keys());
    activeSessionIds.forEach(sessionId => {
      this.stopSession(sessionId);
    });
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    const decision =
      result.behavior !== 'allow' ? 'deny' : pending.allowAlways ? 'allow-always' : 'allow-once';
    const client = this.gatewayClient;
    if (!client) {
      this.pendingApprovals.delete(requestId);
      return;
    }

    const sessionId = pending.sessionId;
    // Only schedule continuation for user-initiated approvals (desktop modal),
    // not for auto-approved commands (allowAlways).
    const needsContinuation = !pending.allowAlways;

    void client
      .request('exec.approval.resolve', {
        id: requestId,
        decision,
      })
      .then(() => {
        if (!needsContinuation) return;
        // Continue the session so the model can see the command result.
        const prompt = decision !== 'deny' ? t('execApprovalApproved') : t('execApprovalDenied');
        const tryContinue = (retries: number) => {
          if (!this.store.getSession(sessionId)) return; // session deleted
          if (!this.isSessionActive(sessionId)) {
            void this.continueSession(sessionId, prompt).catch(error => {
              console.warn('[OpenClawRuntime] failed to continue session after approval:', error);
            });
            return;
          }
          // Session still active (user approved before run ended). Retry after delay.
          if (retries > 0) {
            setTimeout(() => tryContinue(retries - 1), 1000);
          }
        };
        tryContinue(10);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', sessionId, `Failed to resolve OpenClaw approval: ${message}`);
      })
      .finally(() => {
        this.pendingApprovals.delete(requestId);
      });
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasActiveSessions(): boolean {
    return this.activeTurns.size > 0;
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.confirmationModeBySession.get(sessionId) ?? null;
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      skipInitialUserMessage?: boolean;
      skillIds?: string[];
      confirmationMode?: 'modal' | 'text';
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
      agentId?: string;
    },
  ): Promise<void> {
    if (!prompt.trim() && (!options.imageAttachments || options.imageAttachments.length === 0)) {
      throw new Error('Prompt is required.');
    }
    // Clear stop cooldown when user explicitly starts/continues a session
    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);

    // 设置编排父会话 ID（per-session tracking）
    // 注意：不清空之前的子 Agent 数据，因为同一会话可能有多个 turn，
    // 每个 turn 可能启动新的 subagent，之前的 subagent 状态应保留
    this.orchestrationSessionIds.add(sessionId);
    this.orchestrationParentSessionId = sessionId; // backward compat for getSubagentStatuses
    this.subagentManager.setOrchestrationParentSessionId(sessionId);

    // CRITICAL: Do NOT clear subagentStatus, toolCallIdToSessionKey, toolCallIdToLabel, toolCallIdToParentSessionId
    // These mappings are needed by getSubagentStatuses to filter subagents by session.
    // Clearing them would cause other sessions' subagents to lose their 'done' status
    // and default to 'running' when displayed.
    //
    // Only clear transient data used for real-time message streaming:
    // - subagentMessages: only for streaming new messages
    // - sessionKeyToLabel: for routing messages to subagent sessions
    // - toolCallArgs: temporary args storage
    // Only clear if there are other tracked sessions (switching between concurrent sessions)
    if (this.orchestrationSessionIds.size > 1) {
      this.subagentMessages.clear();
      this.sessionKeyToLabel.clear();
      this.toolCallArgs.clear();
      // Keep: subagentStatus, toolCallIdToSessionKey, sessionKeyToToolCallId, toolCallIdToLabel, toolCallIdToParentSessionId
      // These are needed to correctly display subagent status for OTHER sessions
    }

    if (this.activeTurns.has(sessionId)) {
      // If the main agent lifecycle has ended and all subagents are done,
      // the turn is stale (leftover from a previous run). Clean it up
      // instead of throwing, so the user can start a new turn.
      if (this.mainAgentLifecycleEnded) {
        console.log(
          '[OpenClawRuntime] runTurn: cleaning up stale activeTurn for session with ended lifecycle, sessionId=' +
            sessionId,
        );
        this.cleanupSessionTurn(sessionId);
      } else {
        throw new Error(`Session ${sessionId} is still running.`);
      }
    }

    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const confirmationMode =
      options.confirmationMode ?? this.confirmationModeBySession.get(sessionId) ?? 'modal';
    this.confirmationModeBySession.set(sessionId, confirmationMode);

    if (!options.skipInitialUserMessage) {
      const metadata =
        options.skillIds?.length || options.imageAttachments?.length
          ? {
              ...(options.skillIds?.length ? { skillIds: options.skillIds } : {}),
              ...(options.imageAttachments?.length
                ? { imageAttachments: options.imageAttachments }
                : {}),
            }
          : undefined;
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata,
      });
      this.emit('message', sessionId, userMessage);
    }

    const agentId = options.agentId || session.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    let modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    // Fallback to config default model if agent model is empty
    if (!modelName) {
      const apiResolution = resolveRawApiConfig();
      const configModel = apiResolution.config?.model;
      const providerMetadata = apiResolution.providerMetadata;
      if (configModel) {
        modelName = providerMetadata?.modelName || configModel;
      }
    }
    const sessionKey = this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, sessionKey);

    this.store.updateSession(sessionId, { status: 'running' });
    setCoworkProxySessionId(sessionId);
    await this.ensureGatewayClientReady();
    this.startChannelPolling();

    const runId = randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const outboundMessage = await this.buildOutboundPrompt(sessionId, prompt, agentId);
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(sessionId, { resolve, reject });
    });
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId,
      turnToken,
      knownRunIds: new Set([runId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
      pendingUserSync: false,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
      currentThinkingMessageId: null,
      currentThinkingContent: '',
      thinkingStreamEnded: false,
      modelName,
    });
    this.sessionIdByRunId.set(runId, sessionId);

    // Start client-side timeout watchdog.
    // OpenClaw gateway has a known issue where embedded run timeouts may not
    // produce a WS abort/final event (the subscription is torn down before the
    // lifecycle event fires). This timer fires slightly after the server-side
    // timeout to recover the UI from a stuck "running" state.
    this.startTurnTimeoutWatchdog(sessionId);

    const client = this.requireGatewayClient();
    try {
      console.log('[OpenClawRuntime] chat.send params:', {
        sessionKey,
        messageLength: outboundMessage.length,
        runId,
      });
      console.log(
        '[OpenClawRuntime] chat.send message content (first 500 chars):',
        outboundMessage.slice(0, 500),
      );
      const attachments = options.imageAttachments?.length
        ? options.imageAttachments.map(img => ({
            type: 'image',
            mimeType: img.mimeType,
            content: img.base64Data,
          }))
        : undefined;
      if (attachments) {
        console.log(
          '[OpenClawRuntime] chat.send with attachments:',
          attachments.length,
          'images,',
          attachments.map(a => ({
            type: a.type,
            mimeType: a.mimeType,
            contentLength: a.content?.length ?? 0,
          })),
        );
      }
      const sendResult = await client.request<Record<string, unknown>>('chat.send', {
        sessionKey,
        message: outboundMessage,
        deliver: false,
        idempotencyKey: runId,
        ...(attachments ? { attachments } : {}),
      });
      // OpenClaw: runId is set only at send time, never changed by returned value
    } catch (error) {
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      this.rejectTurn(sessionId, new Error(message));
      throw error;
    }

    await completionPromise;
  }

  private async buildOutboundPrompt(
    _sessionId: string,
    prompt: string,
    _agentId?: string,
  ): Promise<string> {
    // 纯透传：直接返回用户消息，不注入任何 GucciAI 上下文
    return prompt.trim();
  }

  private async ensureGatewayClientReady(): Promise<void> {
    // Serialize concurrent calls: if another init is already in progress, wait for it.
    if (this.gatewayClientInitLock) {
      await this.gatewayClientInitLock;
      return;
    }
    this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
    try {
      await this.gatewayClientInitLock;
    } finally {
      this.gatewayClientInitLock = null;
    }
  }

  private async _ensureGatewayClientReadyImpl(): Promise<void> {
    console.log('[ChannelSync] ensureGatewayClientReady: starting engine gateway...');
    const engineStatus = await this.engineManager.startGateway();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: engine phase=',
      engineStatus.phase,
      'message=',
      engineStatus.message,
    );
    if (engineStatus.phase !== 'running') {
      const message = engineStatus.message || 'OpenClaw engine is not running.';
      throw new Error(message);
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: connection info — url=',
      connection.url ? '✓' : '✗',
      'token=',
      connection.token ? '✓' : '✗',
      'version=',
      connection.version,
      'clientEntryPath=',
      connection.clientEntryPath ? '✓' : '✗',
    );
    const missing: string[] = [];
    if (!connection.url) missing.push('url');
    if (!connection.token) missing.push('token');
    if (!connection.version) missing.push('version');
    if (!connection.clientEntryPath) missing.push('clientEntryPath');
    if (missing.length > 0) {
      throw new Error(
        `OpenClaw gateway connection info is incomplete (missing: ${missing.join(', ')})`,
      );
    }

    const needsNewClient =
      !this.gatewayClient ||
      this.gatewayClientVersion !== connection.version ||
      this.gatewayClientEntryPath !== connection.clientEntryPath;
    console.log(
      '[ChannelSync] ensureGatewayClientReady: needsNewClient=',
      needsNewClient,
      'hasExistingClient=',
      !!this.gatewayClient,
    );
    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    this.stopGatewayClient();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: creating gateway client, url=',
      connection.url,
    );
    await this.createGatewayClient(connection);
    console.log(
      '[ChannelSync] ensureGatewayClientReady: createGatewayClient returned, waiting for handshake...',
    );
    if (this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    }
    console.log('[ChannelSync] ensureGatewayClientReady: gateway client created and ready');

    // Browser pre-warm disabled: the empty browser window is disruptive.
    // The browser will start on-demand when the AI agent first calls the browser tool.
    // this.prewarmBrowserIfNeeded(connection);
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const clientEntryPath = connection.clientEntryPath;
    if (!clientEntryPath) {
      throw new Error('Gateway client entry path is not available');
    }
    const GatewayClient = await this.loadGatewayClientCtor(clientEntryPath);

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    let settled = false;

    this.gatewayReadyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolveReady?.();
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectReady?.(error);
    };

    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientDisplayName: 'GucciAI',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        console.log('[ChannelSync] GatewayClient: onHelloOk — handshake succeeded');
        // Expose the client only after the connect handshake completes.
        // Setting gatewayClient earlier would let concurrent code send
        // request frames before the connect frame, causing 1008 rejection.
        this.gatewayClient = client;
        this.subagentManager.setGatewayClient(client);
        this.chatEventProcessor.setGatewayClient(client);
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        settleResolve();
        this.lastTickTimestamp = Date.now();
        this.startTickWatchdog();
      },
      onConnectError: (error: Error) => {
        console.error('[ChannelSync] GatewayClient: onConnectError —', error.message);
        settleReject(error);
      },
      onClose: (_code: number, reason: string) => {
        console.log(
          '[ChannelSync] GatewayClient: onClose — code:',
          _code,
          'reason:',
          reason,
          'settled:',
          settled,
        );
        if (!settled) {
          // Handshake never completed — clean up the pending client so the next
          // ensureGatewayClientReady call creates a fresh one instead of reusing
          // this broken instance forever.
          this.pendingGatewayClient = null;
          settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
          return;
        }

        // If stopGatewayClient() triggered this onClose, don't do anything —
        // the caller is already handling cleanup and may be creating a new client.
        if (this.gatewayStoppingIntentionally) {
          return;
        }

        console.warn('[OpenClawRuntime] gateway WS disconnected — code:', _code, 'reason:', reason);
        const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
        const activeSessionIds = Array.from(this.activeTurns.keys());
        activeSessionIds.forEach(sessionId => {
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('error', sessionId, disconnectedError.message);
          this.cleanupSessionTurn(sessionId);
          this.rejectTurn(sessionId, disconnectedError);
        });
        this.stopGatewayClient();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {
          // suppress unhandled rejection noise; auto-reconnect will re-establish
        });

        // Auto-reconnect after unexpected disconnect
        this.scheduleGatewayReconnect();
      },
      onEvent: (event: GatewayEventFrame) => {
        this.handleGatewayEvent(event);
      },
    });

    // gatewayClient/version/entryPath are now set inside onHelloOk,
    // after the connect handshake succeeds. We only keep a local ref
    // for stopGatewayClient() cleanup if start() fails synchronously.
    this.pendingGatewayClient = client;
    client.start();
  }

  private stopGatewayClient(): void {
    this.gatewayStoppingIntentionally = true;
    this.stopChannelPolling();
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    // Stop whichever client exists — the promoted one or the pending one.
    const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
    try {
      clientToStop?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.subagentManager.setGatewayClient(null);
    this.chatEventProcessor.setGatewayClient(null);
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.channelSessionSync?.clearCache();
    this.knownChannelSessionIds.clear();
    this.heartbeatSessionKeys.clear();
    this.stoppedSessions.clear();
    this.browserPrewarmAttempted = false;
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
    // Clear messageUpdate throttle state
    for (const timer of this.pendingMessageUpdateTimer.values()) {
      clearTimeout(timer);
    }
    this.pendingMessageUpdateTimer.clear();
    this.lastMessageUpdateEmitTime.clear();
    this.gatewayStoppingIntentionally = false;
  }

  private cancelGatewayReconnect(): void {
    if (this.gatewayReconnectTimer) {
      clearTimeout(this.gatewayReconnectTimer);
      this.gatewayReconnectTimer = null;
    }
  }

  /**
   * Throttled emit for messageUpdate during streaming.
   * OpenClaw sends full-replacement deltas, so intermediate updates can be safely skipped.
   * Uses leading + trailing pattern: emit immediately if enough time has passed,
   * otherwise schedule a trailing emit to deliver the latest content.
   */
  private throttledEmitMessageUpdate(sessionId: string, messageId: string, content: string): void {
    const now = Date.now();
    const lastEmit = this.lastMessageUpdateEmitTime.get(messageId) ?? 0;
    const elapsed = now - lastEmit;

    if (elapsed >= OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS) {
      this.clearPendingMessageUpdate(messageId);
      this.lastMessageUpdateEmitTime.set(messageId, now);
      this.emit('messageUpdate', sessionId, messageId, content);
      return;
    }

    // Schedule a trailing emit to ensure the latest content is delivered
    this.clearPendingMessageUpdate(messageId);
    this.pendingMessageUpdateTimer.set(
      messageId,
      setTimeout(() => {
        this.pendingMessageUpdateTimer.delete(messageId);
        this.lastMessageUpdateEmitTime.set(messageId, Date.now());
        this.emit('messageUpdate', sessionId, messageId, content);
      }, OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS - elapsed),
    );
  }

  private clearPendingMessageUpdate(messageId: string): void {
    const timer = this.pendingMessageUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingMessageUpdateTimer.delete(messageId);
    }
  }

  private startTickWatchdog(): void {
    this.stopTickWatchdog();
    console.log('[TickWatchdog] started');
    this.tickWatchdogTimer = setInterval(() => {
      this.checkTickHealth();
    }, OpenClawRuntimeAdapter.TICK_WATCHDOG_INTERVAL_MS);
  }

  private stopTickWatchdog(): void {
    if (this.tickWatchdogTimer) {
      clearInterval(this.tickWatchdogTimer);
      this.tickWatchdogTimer = null;
    }
  }

  private checkTickHealth(): void {
    if (this.lastTickTimestamp <= 0) return;
    const now = Date.now();
    const tickElapsed = now - this.lastTickTimestamp;
    const agentElapsed = now - this.lastAgentActivityTimestamp;

    // If we received agent events recently, the connection is alive even without tick.
    // This handles the case where tick events are dropped due to dropIfSlow during heavy activity.
    if (agentElapsed <= OpenClawRuntimeAdapter.AGENT_ACTIVITY_ALIVE_WINDOW_MS) {
      // Connection is alive — update tick timestamp to prevent false timeout trigger
      this.lastTickTimestamp = now;
      console.log(
        `[TickWatchdog] tick missing for ${Math.round(tickElapsed / 1000)}s but agent activity detected (${Math.round(agentElapsed / 1000)}s ago) — connection is alive, suppressing reconnect`,
      );
      return;
    }

    if (tickElapsed <= OpenClawRuntimeAdapter.TICK_TIMEOUT_MS) return;

    console.warn(
      `[TickWatchdog] no tick received for ${Math.round(tickElapsed / 1000)}s (threshold: ${OpenClawRuntimeAdapter.TICK_TIMEOUT_MS / 1000}s) and no agent activity for ${Math.round(agentElapsed / 1000)}s — connection is likely dead, triggering reconnect`,
    );
    this.cancelGatewayReconnect();
    this.stopGatewayClient();
    this.gatewayReconnectAttempt = 0;
    this.scheduleGatewayReconnect();
  }

  /**
   * Called when the system resumes from sleep/suspend.
   * Resets the reconnect counter and triggers an immediate reconnect or health check.
   */
  onSystemResume(): void {
    console.log('[GatewayReconnect] system resumed from sleep');
    this.cancelGatewayReconnect();
    this.gatewayReconnectAttempt = 0;
    if (!this.gatewayClient) {
      void this.attemptGatewayReconnect();
    } else {
      this.checkTickHealth();
    }
  }

  /**
   * Schedule an automatic gateway WS reconnection attempt with exponential backoff.
   * Called from onClose when the connection drops unexpectedly after a successful handshake.
   */
  private scheduleGatewayReconnect(): void {
    if (this.gatewayReconnectAttempt >= OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS) {
      console.error(
        '[GatewayReconnect] max attempts reached (' +
          OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS +
          '), giving up. Restart the app to reconnect.',
      );
      return;
    }

    const delays = OpenClawRuntimeAdapter.GATEWAY_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
    this.gatewayReconnectAttempt++;

    console.log(
      `[GatewayReconnect] scheduling reconnect attempt ${this.gatewayReconnectAttempt}/${OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS} in ${delay}ms`,
    );

    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = null;
      void this.attemptGatewayReconnect();
    }, delay);
  }

  private async attemptGatewayReconnect(): Promise<void> {
    console.log(
      `[GatewayReconnect] attempting reconnect (attempt ${this.gatewayReconnectAttempt})`,
    );
    try {
      // connectGatewayIfNeeded checks if client already exists, so safe to call
      await this.connectGatewayIfNeeded();
      console.log('[GatewayReconnect] reconnected successfully');
      this.gatewayReconnectAttempt = 0; // reset counter on success
    } catch (error) {
      console.warn('[GatewayReconnect] reconnect failed:', error);
      this.scheduleGatewayReconnect(); // retry with next backoff
    }
  }

  private prewarmBrowserIfNeeded(connection: OpenClawGatewayConnectionInfo): void {
    if (this.browserPrewarmAttempted) return;
    if (!connection.port || !connection.token) return;
    this.browserPrewarmAttempted = true;

    const browserControlPort = connection.port + 2;
    const token = connection.token;
    console.log(
      `[OpenClawRuntime] browser pre-warm: gatewayPort=${connection.port}, browserControlPort=${browserControlPort}`,
    );
    void this.prewarmBrowserWithRetry(browserControlPort, token);
  }

  private async prewarmBrowserWithRetry(
    port: number,
    token: string,
    maxRetries = 5,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/start?profile=openclaw`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.log(
        `[OpenClawRuntime] browser pre-warm attempt ${attempt}/${maxRetries} → POST http://127.0.0.1:${port}/start?profile=openclaw`,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();
        if (response.ok) {
          console.log(
            `[OpenClawRuntime] browser pre-warm succeeded (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
          );
          return;
        }
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} returned HTTP ${response.status} (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} failed (${Date.now() - startTime}ms): ${message}`,
        );
      }

      if (attempt < maxRetries) {
        const delayMs = Math.min(5000, 2000 * attempt);
        console.log(`[OpenClawRuntime] browser pre-warm retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    console.warn(
      '[OpenClawRuntime] browser pre-warm exhausted all retries (non-fatal, browser will start on first tool use)',
    );
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    // Use require() with file path directly. TypeScript's CJS output downgrades
    // dynamic import() to require(), which doesn't support file:// URLs.
    const loaded = require(clientEntryPath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') {
      return direct as GatewayClientCtor;
    }

    const exportedValues = Object.values(loaded);
    for (const candidate of exportedValues) {
      if (typeof candidate !== 'function') {
        continue;
      }
      const maybeCtor = candidate as {
        name?: string;
        prototype?: {
          start?: unknown;
          stop?: unknown;
          request?: unknown;
        };
      };
      if (maybeCtor.name === 'GatewayClient') {
        return candidate as GatewayClientCtor;
      }
      const proto = maybeCtor.prototype;
      if (
        proto &&
        typeof proto.start === 'function' &&
        typeof proto.stop === 'function' &&
        typeof proto.request === 'function'
      ) {
        return candidate as GatewayClientCtor;
      }
    }

    const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
    throw new Error(
      `Invalid OpenClaw gateway client module: ${clientEntryPath} (exports: ${exportKeysPreview || 'none'})`,
    );
  }

  private handleGatewayEvent(event: GatewayEventFrame): void {
    if (!this.sweeperStarted) {
      this.sweeperStarted = true;
      this.subagentManager.startSweeper();
    }

    if (event.event === 'tick') {
      this.lastTickTimestamp = Date.now();
      return;
    }

    if (event.event === 'chat') {
      this.handleChatEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'agent') {
      // Agent events prove the connection is alive even when tick is dropped due to dropIfSlow.
      this.lastAgentActivityTimestamp = Date.now();
      // Process thinking events first (before assistant text) to ensure correct display order.
      // Thinking should appear in UI before or alongside the reply text.
      this.processAgentThinkingEvent(event.payload);
      // Process assistant text updates (may be enqueued if session not ready).
      this.processAgentAssistantText(event.payload);
      // Handle other agent events (tool, lifecycle, etc.)
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      this.handleApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.handleApprovalResolved(event.payload);
    }

    // session.tool events are mirror of agent stream=tool events for late-joining subscribers.
    // They have the same payload format: runId, stream='tool', sessionKey, data.
    // Handle announce runId sessions_spawn that don't trigger agent stream=tool events.
    if (event.event === 'session.tool') {
      // Update activity timestamp since this proves the connection is alive
      this.lastAgentActivityTimestamp = Date.now();
      // Process the tool event using the same handler as agent stream=tool
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'cron') {
      console.debug('[OpenClawRuntime] received cron event:', JSON.stringify(event));
    }
  }

  private handleAgentEvent(payload: unknown, seq?: number): void {
    this.agentEventProcessor.handleAgentEvent(payload, seq);
  }

  private handleAgentThinkingEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    this.agentEventProcessor.handleAgentThinkingEvent(sessionId, turn, data);
  }

  private finalizeThinkingMessage(sessionId: string, messageId: string, content: string): void {
    this.agentEventProcessor.finalizeThinkingMessage(sessionId, messageId, content);
  }

  private flushPendingAgentEvents(sessionId: string, runId: string): void {
    this.agentEventProcessor.flushPendingAgentEvents(sessionId, runId);
  }

  private rememberSessionKey(sessionId: string, sessionKey: string): void {
    this.agentEventProcessor.rememberSessionKey(sessionId, sessionKey);
  }

  private resolveSessionIdBySessionKey(sessionKey: string): string | null {
    return this.agentEventProcessor.resolveSessionIdBySessionKey(sessionKey);
  }

  private nextTurnToken(sessionId: string): number {
    return this.agentEventProcessor.nextTurnToken(sessionId);
  }

  private isCurrentTurnToken(sessionId: string, turnToken: number): boolean {
    return this.agentEventProcessor.isCurrentTurnToken(sessionId, turnToken);
  }

  private reuseFinalAssistantMessage(sessionId: string, content: string): string | null {
    return this.agentEventProcessor.reuseFinalAssistantMessage(sessionId, content);
  }

  private handleAgentToolEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    this.agentToolEventHandler.handleAgentToolEvent(sessionId, turn, data);
  }

  private handleChatEvent(payload: unknown, seq?: number): void {
    this.chatEventProcessor.handleChatEvent(payload, seq);
  }

  private processAgentThinkingEvent(payload: unknown): void {
    this.chatEventProcessor.processAgentThinkingEvent(payload);
  }

  private processAgentAssistantText(payload: unknown): void {
    this.chatEventProcessor.processAgentAssistantText(payload);
  }

  private resolveAssistantSegmentText(turn: ActiveTurn, fullText: string): string {
    return this.chatEventProcessor.resolveAssistantSegmentText(turn, fullText);
  }

  private splitAssistantSegmentBeforeTool(sessionId: string, turn: ActiveTurn): void {
    this.chatEventProcessor.splitAssistantSegmentBeforeTool(sessionId, turn);
  }

  private handleChatAborted(sessionId: string, turn: ActiveTurn): void {
    this.chatEventProcessor.handleChatAborted(sessionId, turn);
  }

  private handleApprovalRequested(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalRequestedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    if (!typedPayload.request || !isRecord(typedPayload.request)) return;

    const request = typedPayload.request;
    const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
    let sessionId = sessionKey
      ? (this.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;

    // Try to resolve channel-originated sessions for approval requests
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
      }
    }

    if (!sessionId) {
      return;
    }

    const command = typeof request.command === 'string' ? request.command : '';
    const isChannelSession = this.channelSessionSync?.isChannelSessionKey(sessionKey) ?? false;

    // Auto-approve: channel sessions always, local sessions for non-delete commands.
    // Intentionally allows non-delete dangerous commands (git push, kill, chmod) without
    // prompting — this is a deliberate trade-off to avoid the approval-pending timing
    // issue on fresh installs.  Only file-deletion commands warrant a blocking modal.
    // The allow-always decision adds the command to the gateway allowlist so subsequent
    // calls skip the approval flow entirely.
    if (isChannelSession || !isDeleteCommand(command)) {
      this.pendingApprovals.set(requestId, { requestId, sessionId, allowAlways: true });
      this.respondToPermission(requestId, { behavior: 'allow', updatedInput: {} });
    }
    // Suppress approval popups for sessions in stop cooldown — the user
    // already stopped the session, so showing a new permission dialog
    // would be confusing.  The Gateway-side run will time out on its own.
    if (this.isSessionInStopCooldown(sessionId)) {
      return;
    }

    this.pendingApprovals.set(requestId, { requestId, sessionId });

    const { level: dangerLevel, reason: dangerReason } = getCommandDangerLevel(command);

    const permissionRequest: PermissionRequest = {
      requestId,
      toolName: 'Bash',
      toolInput: {
        command,
        dangerLevel,
        dangerReason,
        cwd: request.cwd ?? null,
        host: request.host ?? null,
        security: request.security ?? null,
        ask: request.ask ?? null,
        resolvedPath: request.resolvedPath ?? null,
        sessionKey: request.sessionKey ?? null,
        agentId: request.agentId ?? null,
      },
      toolUseId: requestId,
    };

    this.emit('permissionRequest', sessionId, permissionRequest);
  }

  private handleApprovalResolved(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalResolvedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    this.pendingApprovals.delete(requestId);
  }

  private resolveSessionIdFromChatPayload(payload: ChatEventPayload): string | null {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    if (runId && this.sessionIdByRunId.has(runId)) {
      const sid = this.sessionIdByRunId.get(runId) ?? null;
      return sid;
    }

    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (sessionKey) {
      const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (sessionId) {
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.ensureActiveTurn(sessionId, sessionKey, '');
        return sessionId;
      }
    }

    // Try to resolve channel-originated sessions
    if (sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.debug(
            '[resolveSessionId] re-created after delete, skipping history sync for:',
            sessionKey,
          );
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.ensureActiveTurn(channelSessionId, sessionKey, '');
        return channelSessionId;
      }
    }

    console.warn('[resolveSessionId] failed — runId:', runId, 'sessionKey:', sessionKey);
    return null;
  }

  private collectChannelHistoryEntries(
    historyMessages: unknown[],
    isDiscord: boolean,
  ): ChannelHistorySyncEntry[] {
    const historyEntries: ChannelHistorySyncEntry[] = [];
    for (const message of historyMessages) {
      if (!isRecord(message)) continue;
      const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
      if (role !== 'user' && role !== 'assistant') continue;
      let text = extractMessageText(message).trim();
      if (isDiscord) text = stripDiscordMentions(text);
      if (text) {
        historyEntries.push({ role: role as 'user' | 'assistant', text });
      }
    }
    return historyEntries;
  }

  private collectLocalChannelEntries(sessionId: string): ChannelHistorySyncEntry[] {
    const session = this.store.getSession(sessionId);
    if (!session) return [];

    const localEntries: ChannelHistorySyncEntry[] = [];
    for (const msg of session.messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;
      const text = msg.content.trim();
      if (!text) continue;
      localEntries.push({ role: msg.type, text });
    }
    return localEntries;
  }

  private computeChannelHistoryFirstNewIndex(
    localEntries: ChannelHistorySyncEntry[],
    historyEntries: ChannelHistorySyncEntry[],
    cursor: number,
  ): { firstNewIdx: number; strategy: string } {
    if (localEntries.length === 0) {
      return { firstNewIdx: 0, strategy: 'empty-local' };
    }

    // `chat.history` is byte-bounded in OpenClaw, so the returned window can slide
    // long before it reaches our requested count. Match the local tail against the
    // current history prefix to find the continuation point without trusting length.
    const maxOverlap = Math.min(localEntries.length, historyEntries.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matched = true;
      for (let idx = 0; idx < overlap; idx += 1) {
        const localEntry = localEntries[localEntries.length - overlap + idx];
        const historyEntry = historyEntries[idx];
        if (!isSameChannelHistoryEntry(localEntry, historyEntry)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { firstNewIdx: overlap, strategy: 'tail-overlap' };
      }
    }

    let lastLocalUserIdx = -1;
    for (let idx = localEntries.length - 1; idx >= 0; idx -= 1) {
      if (localEntries[idx].role === 'user') {
        lastLocalUserIdx = idx;
        break;
      }
    }

    if (lastLocalUserIdx >= 0) {
      const lastLocalUser = localEntries[lastLocalUserIdx];
      let prevLocalUserText: string | undefined;
      for (let idx = lastLocalUserIdx - 1; idx >= 0; idx -= 1) {
        if (localEntries[idx].role === 'user') {
          prevLocalUserText = localEntries[idx].text;
          break;
        }
      }

      for (let idx = historyEntries.length - 1; idx >= 0; idx -= 1) {
        if (
          historyEntries[idx].role !== 'user' ||
          historyEntries[idx].text !== lastLocalUser.text
        ) {
          continue;
        }
        if (prevLocalUserText !== undefined && idx > 0) {
          let prevHistUserText: string | undefined;
          for (let histIdx = idx - 1; histIdx >= 0; histIdx -= 1) {
            if (historyEntries[histIdx].role === 'user') {
              prevHistUserText = historyEntries[histIdx].text;
              break;
            }
          }
          if (prevHistUserText !== prevLocalUserText) {
            continue;
          }
        }
        return { firstNewIdx: idx + 1, strategy: 'last-user-anchor' };
      }
    }

    // When cursor > 0, tail-overlap and last-user-anchor (above) are the correct
    // content-based strategies for detecting a sliding history window.  If both
    // failed the mismatch is caused by duplicates in the local store, not by
    // genuinely new gateway messages.  Trust the cursor — it was set to
    // historyEntries.length at the end of the previous sync — instead of falling
    // through to forward-match, which can produce wildly wrong firstNewIdx values
    // when local entries are polluted (causing either an infinite re-sync loop
    // when cursor == historyEntries.length, or a burst of old messages being
    // re-synced when cursor < historyEntries.length).
    //
    // forward-match is still used when cursor == 0 (initial sync / after restart)
    // because there is no cursor history to rely on.
    if (cursor > 0) {
      if (cursor >= historyEntries.length) {
        return { firstNewIdx: historyEntries.length, strategy: 'cursor-stable' };
      }
      return { firstNewIdx: cursor, strategy: 'cursor-fallback' };
    }

    let localIdx = 0;
    let forwardFirstNewIdx = 0;
    for (let idx = 0; idx < historyEntries.length; idx += 1) {
      if (
        localIdx < localEntries.length &&
        isSameChannelHistoryEntry(historyEntries[idx], localEntries[localIdx])
      ) {
        localIdx += 1;
        forwardFirstNewIdx = idx + 1;
      }
    }
    if (forwardFirstNewIdx > 0) {
      return { firstNewIdx: forwardFirstNewIdx, strategy: 'forward-match' };
    }

    if (historyEntries.length < cursor) {
      return { firstNewIdx: 0, strategy: 'history-rewrite' };
    }

    return {
      firstNewIdx: Math.min(cursor, historyEntries.length),
      strategy: 'cursor-fallback',
    };
  }

  /**
   * Sync user messages from gateway chat.history that haven't been added to the local store yet.
   * Used for channel-originated sessions (e.g. Telegram) where user messages arrive via the
   * gateway rather than the GucciAI UI.
   *
   * Called at the start of a new turn (via prefetchChannelUserMessages) so that user messages
   * appear before the assistant's streaming response. Both chat and agent events are buffered
   * during prefetch, so the replay order matches direct cowork sessions.
   *
   * Reconciles against the local tail instead of trusting history length/cursor alone,
   * because OpenClaw's `chat.history` window can slide due to byte limits well before
   * the requested message count is reached.
   */
  private syncChannelUserMessages(
    sessionId: string,
    historyMessages: unknown[],
    latestOnly = false,
    isDiscord = false,
  ): void {
    const historyEntries = this.collectChannelHistoryEntries(historyMessages, isDiscord);

    const cursor = this.channelSyncCursor.get(sessionId) ?? 0;

    // When latestOnly is true (e.g. session re-created after deletion),
    // only sync the last user message — the one that triggered this turn.
    // Advance cursor to end so subsequent syncs don't replay old history.
    if (latestOnly) {
      if (historyEntries.length > 0) {
        const lastUser = [...historyEntries].reverse().find(entry => entry.role === 'user');
        if (lastUser) {
          // Dedup: skip if this message already exists locally
          const session = this.store.getSession(sessionId);
          const alreadyExists =
            session?.messages.some(
              (m: CoworkMessage) => m.type === 'user' && m.content.trim() === lastUser.text,
            ) ?? false;
          if (!alreadyExists) {
            const userMessage = this.store.addMessage(sessionId, {
              type: 'user',
              content: lastUser.text,
              metadata: {},
            });
            this.emit('message', sessionId, userMessage);
          }
        }
      }
      this.channelSyncCursor.set(sessionId, historyEntries.length);
      return;
    }

    const localEntries = this.collectLocalChannelEntries(sessionId);
    const { firstNewIdx } = this.computeChannelHistoryFirstNewIndex(
      localEntries,
      historyEntries,
      cursor,
    );

    // Sync user messages from gateway history.
    // Only sync user messages here — assistant messages are already added by the
    // real-time streaming pipeline (handleChatDelta / handleAgentEvent) and by
    // syncFinalAssistantWithHistory's own addMessage/updateMessage logic.
    //
    // When syncing a user message, check whether the corresponding assistant response
    // was already created locally (e.g. due to prefetch timeout where the assistant
    // streamed before user messages were synced). If so, use insertMessageBeforeId
    // to place the user message before the assistant — preserving correct chronological
    // order. This handles the race condition where gateway chat.history lags behind
    // the real-time streaming events.
    let syncedCount = 0;

    // Collect all user message indices that need syncing:
    // 1. Normal: user messages from firstNewIdx onwards
    // 2. Repair: user messages before firstNewIdx that are missing locally
    //    (can happen when computeChannelHistoryFirstNewIndex's forward-match
    //    strategy matches the assistant but skips the preceding user message)
    const currentSession = this.store.getSession(sessionId);
    const localUserTexts = new Set<string>();
    if (currentSession) {
      for (const msg of currentSession.messages) {
        if (msg.type === 'user') {
          localUserTexts.add(msg.content.trim());
        }
      }
    }

    const userIndicesToSync: number[] = [];
    // Normal range: from firstNewIdx onwards, with dedup against local messages
    for (let i = firstNewIdx; i < historyEntries.length; i++) {
      if (historyEntries[i].role === 'user' && !localUserTexts.has(historyEntries[i].text)) {
        userIndicesToSync.push(i);
      }
    }
    // Repair range: before firstNewIdx, missing locally
    for (let i = 0; i < firstNewIdx; i++) {
      if (historyEntries[i].role === 'user' && !localUserTexts.has(historyEntries[i].text)) {
        userIndicesToSync.push(i);
      }
    }

    for (const idx of userIndicesToSync) {
      const entry = historyEntries[idx];

      // Find the next assistant entry in history after this user entry, then
      // look for a matching local assistant message. If found, insert the user
      // message before it to maintain correct chronological order.
      let insertBeforeId: string | null = null;
      if (currentSession) {
        for (let j = idx + 1; j < historyEntries.length; j++) {
          if (historyEntries[j].role !== 'assistant') continue;
          const assistantText = historyEntries[j].text;
          // Match by content prefix — local text may be segmented or truncated
          const matchPrefix = assistantText.slice(0, 100);
          const localMatch = currentSession.messages.find(
            (m: CoworkMessage) =>
              m.type === 'assistant' && m.content.trim().startsWith(matchPrefix),
          );
          if (localMatch) {
            insertBeforeId = localMatch.id;
          }
          break;
        }
      }

      let userMessage;
      if (insertBeforeId) {
        userMessage = this.store.insertMessageBeforeId(sessionId, insertBeforeId, {
          type: 'user',
          content: entry.text,
          metadata: {},
        });
        console.debug(
          '[syncChannelUserMessages] inserted user message before assistant, sessionId:',
          sessionId,
        );
      } else {
        userMessage = this.store.addMessage(sessionId, {
          type: 'user',
          content: entry.text,
          metadata: {},
        });
      }
      this.emit('message', sessionId, userMessage);
      localUserTexts.add(entry.text);
      syncedCount++;
    }

    this.channelSyncCursor.set(sessionId, historyEntries.length);
  }

  private getUserMessageCount(sessionId: string): number {
    const session = this.store.getSession(sessionId);
    if (!session) return 0;
    return session.messages.filter((m: CoworkMessage) => m.type === 'user').length;
  }

  /**
   * Sync full conversation history for a newly discovered channel session.
   * Adds both user and assistant messages to the local CoworkStore in order.
   * Skipped if the session has already been fully synced.
   *
   * Uses position-based matching to avoid false dedup of identical-content messages.
   */

  private async syncFullChannelHistory(sessionId: string, sessionKey: string): Promise<void> {
    if (this.fullySyncedSessions.has(sessionId)) return;
    this.fullySyncedSessions.add(sessionId);

    try {
      await this.historyReconciler.reconcileWithHistory(sessionId, sessionKey, {
        isFullSync: true,
      });
    } catch (error) {
      console.error('[ChannelSync] syncFullChannelHistory: error:', error);
      // Remove from synced set so retry is possible
      this.fullySyncedSessions.delete(sessionId);
    }
  }

  /**
   * Incremental sync for an already-known channel session.
   * Delegates to reconcileWithHistory which handles diff and update.
   */
  private async incrementalChannelSync(sessionId: string, sessionKey: string): Promise<void> {
    await this.historyReconciler.reconcileWithHistory(sessionId, sessionKey);
  }

  /**
   * Trigger an immediate incremental sync after a channel session turn completes,
   * so that the renderer sees the latest messages without waiting for the next poll.
   */
  private syncChannelAfterTurn(sessionId: string, sessionKey: string): void {
    if (!this.channelSessionSync || !sessionKey) return;
    if (!this.channelSessionSync.isChannelSessionKey(sessionKey)) return;
    if (!this.fullySyncedSessions.has(sessionId)) return;

    void this.historyReconciler.reconcileWithHistory(sessionId, sessionKey).catch(err => {
      console.warn('[ChannelSync] post-turn incremental sync failed for', sessionKey, err);
    });
  }

  private clearPendingApprovalsBySession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  private cleanupSessionTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      // Clear client-side timeout watchdog
      if (turn.timeoutTimer) {
        clearTimeout(turn.timeoutTimer);
        turn.timeoutTimer = undefined;
      }
      // Cancel any pending throttled messageUpdate timer for this turn
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.lastMessageUpdateEmitTime.delete(turn.assistantMessageId);
      }
      turn.knownRunIds.forEach(knownRunId => {
        this.sessionIdByRunId.delete(knownRunId);
        this.pendingAgentEventsByRunId.delete(knownRunId);
        this.lastChatSeqByRunId.delete(knownRunId);
        this.lastAgentSeqByRunId.delete(knownRunId);
      });
    }
    this.activeTurns.delete(sessionId);
    setCoworkProxySessionId(null);
    this.reCreatedChannelSessionIds.delete(sessionId);
  }

  /**
   * Start a client-side timeout watchdog for a turn.
   * Fires after the server-side timeout + grace period, recovering the UI
   * if the gateway fails to deliver the abort/final event.
   */
  private startTurnTimeoutWatchdog(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    const timeoutMs =
      this.agentTimeoutSeconds * 1000 + OpenClawRuntimeAdapter.CLIENT_TIMEOUT_GRACE_MS;
    turn.timeoutTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turn.turnToken) return;
      console.warn(
        `[OpenClawRuntime] Client-side timeout watchdog fired for session ${sessionId}, ` +
          `runId=${currentTurn.runId} after ${timeoutMs}ms — gateway did not deliver abort event`,
      );
      this.handleChatAborted(sessionId, currentTurn);
    }, timeoutMs);
  }

  /**
   * Called when a session is deleted from the store.
   * Purges all in-memory references so that new channel messages
   * with the same sessionKey can create a fresh session.
   */
  onSessionDeleted(sessionId: string, agentId?: string): void {
    // Remove sessionIdBySessionKey entries pointing to this session
    // IMPORTANT: Save removedKeys BEFORE deleting for OpenClaw sync
    const removedKeys: string[] = [];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) {
        removedKeys.push(key);
        this.sessionIdBySessionKey.delete(key);
      }
    }

    // If removedKeys is empty, build sessionKey from agentId parameter or default to 'main'
    if (removedKeys.length === 0) {
      const effectiveAgentId = agentId || 'main';
      const sessionKey = this.toSessionKey(sessionId, effectiveAgentId);
      removedKeys.push(sessionKey);
    }

    console.log(
      `[OpenClaw] onSessionDeleted: sessionId=${sessionId}, agentId=${agentId}, removedKeys=${JSON.stringify(removedKeys)}, totalKeysInMap=${this.sessionIdBySessionKey.size}`,
    );

    // Sync deletion to OpenClaw Gateway FIRST (using saved removedKeys)
    // Wait for gatewayClient to be ready before attempting deletion
    this.deleteOpenClawSessionByKeysWithRetry(sessionId, removedKeys).catch(err => {
      console.warn(`[OpenClaw] deleteOpenClawSessionByKeysWithRetry error for ${sessionId}:`, err);
    });
    // Suppress polling re-creation for deleted channel keys.
    // Only real-time events (new IM messages) will re-create the session.
    for (const key of removedKeys) {
      this.deletedChannelKeys.add(key);
    }

    // Allow polling to rediscover channel sessions
    this.knownChannelSessionIds.delete(sessionId);

    // Allow full history re-sync when session is re-created
    this.fullySyncedSessions.delete(sessionId);
    this.channelSyncCursor.delete(sessionId);
    this.reCreatedChannelSessionIds.delete(sessionId);
    this.gatewayHistoryCountBySession.delete(sessionId);
    this.latestTurnTokenBySession.delete(sessionId);
    this.stoppedSessions.delete(sessionId);

    // Clean up active turn and related run-id mappings
    this.cleanupSessionTurn(sessionId);

    // Clean up pending approvals, confirmation mode
    this.clearPendingApprovalsBySession(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);

    // Propagate to channel session sync
    if (this.channelSessionSync) {
      this.channelSessionSync.onSessionDeleted(sessionId);
    }
  }

  /**
   * Sync deletion to OpenClaw Gateway by calling sessions.delete API.
   * Deletes the remote session and all its related sessions (subagents, title sessions, etc).
   */
  private async deleteOpenClawSessionByKeys(sessionKeys: string[]): Promise<void> {
    const client = this.gatewayClient;
    if (!client || sessionKeys.length === 0) {
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeys: skipped, client=${!!client}, keys=${sessionKeys.length}`,
      );
      return;
    }

    console.log(
      `[OpenClaw] deleteOpenClawSessionByKeys: starting with keys=${JSON.stringify(sessionKeys)}`,
    );

    // Extract agentId from the first sessionKey (format: agent:{agentId}:gucciai:{sessionId})
    const agentId = this.extractAgentIdFromSessionKey(sessionKeys[0]);

    // Delete all related sessions in parallel for efficiency
    const deletePromises: Promise<void>[] = [];

    for (const sessionKey of sessionKeys) {
      deletePromises.push(this.deleteSessionTree(client, sessionKey));
    }

    // Also delete orphan subagent and title sessions at agent level
    if (agentId) {
      deletePromises.push(this.deleteAgentLevelSessions(client, agentId));
    }

    await Promise.allSettled(deletePromises);
    console.log(`[OpenClaw] deleteOpenClawSessionByKeys: completed`);
  }

  /**
   * Delete orphan subagent and title sessions at agent level.
   * These sessions have keys like: agent:{agentId}:subagent:{uuid}, agent:{agentId}:title:{uuid}
   * They are not spawnedBy the GucciAI session, but should be cleaned up when the session is deleted.
   */
  private async deleteAgentLevelSessions(
    client: GatewayClientLike,
    agentId: string,
  ): Promise<void> {
    try {
      // Query all sessions for this agent
      const listResult = await client.request<{
        sessions?: Array<{ key: string; spawnedBy?: string }>;
      }>('sessions.list', { agentId, limit: 200 });

      console.log(
        `[OpenClaw] deleteAgentLevelSessions: agentId=${agentId}, found ${listResult.sessions?.length ?? 0} sessions`,
      );

      for (const session of listResult.sessions ?? []) {
        // Delete sessions that are:
        // 1. Not spawnedBy a GucciAI session (no spawnedBy or spawnedBy doesn't contain 'gucciai')
        // 2. Are subagent or title sessions (contain :subagent: or :title:)
        const isSubagentOrTitle =
          session.key.includes(':subagent:') || session.key.includes(':title:');
        const isNotSpawnedByGucciAI = !session.spawnedBy || !session.spawnedBy.includes('gucciai');

        if (isSubagentOrTitle && isNotSpawnedByGucciAI) {
          try {
            await client.request('sessions.delete', {
              key: session.key,
              deleteTranscript: true,
            });
            console.log(`[OpenClaw] deleteAgentLevelSessions: deleted ${session.key}`);
          } catch (err) {
            console.warn(
              `[OpenClaw] deleteAgentLevelSessions: failed to delete ${session.key}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[OpenClaw] deleteAgentLevelSessions: error querying agent ${agentId}:`, err);
    }
  }

  /**
   * Extract agentId from session key format: agent:{agentId}:gucciai:{sessionId}
   */
  private extractAgentIdFromSessionKey(sessionKey: string): string | null {
    const match = /^agent:([^:]+):/.exec(sessionKey);
    return match ? match[1] : null;
  }

  /**
   * Delete OpenClaw sessions with retry - waits for gatewayClient to be ready.
   */
  private async deleteOpenClawSessionByKeysWithRetry(
    sessionId: string,
    sessionKeys: string[],
  ): Promise<void> {
    if (sessionKeys.length === 0) {
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry: no keys to delete for sessionId=${sessionId}`,
      );
      return;
    }

    // Wait for gatewayClient to be ready (with timeout)
    const maxWaitMs = 5000;
    const startTime = Date.now();
    while (!this.gatewayClient && Date.now() - startTime < maxWaitMs) {
      try {
        await this.ensureGatewayClientReady();
      } catch (err) {
        console.warn(
          `[OpenClaw] deleteOpenClawSessionByKeysWithRetry: waiting for gatewayClient...`,
          err,
        );
      }
      if (!this.gatewayClient) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    try {
      await this.deleteOpenClawSessionByKeys(sessionKeys);
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry completed for sessionId=${sessionId}`,
      );
    } catch (err) {
      console.warn(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry failed for sessionId=${sessionId}:`,
        err,
      );
    }
  }

  /**
   * Delete a session and all sessions spawned by it (recursively).
   */
  private async deleteSessionTree(client: GatewayClientLike, sessionKey: string): Promise<void> {
    try {
      // Query sessions spawned by this session (includes subagents and possibly title sessions)
      const listResult = await client.request<{
        sessions?: Array<{ key: string; spawnedBy?: string }>;
      }>('sessions.list', { spawnedBy: sessionKey, limit: 100 });

      // Recursively delete child sessions first (depth-first)
      for (const childSession of listResult.sessions ?? []) {
        await this.deleteSessionTree(client, childSession.key);
      }

      // Delete this session (if not a main session like agent:xxx:main)
      if (!this.isMainSessionKey(sessionKey)) {
        await client.request('sessions.delete', {
          key: sessionKey,
          deleteTranscript: true,
        });
      }
    } catch (err) {
      console.warn(`[OpenClaw] Error deleting session tree ${sessionKey}:`, err);
    }
  }

  /**
   * Check if a sessionKey is a main session (e.g., agent:{agentId}:main).
   * Main sessions cannot be deleted via sessions.delete API.
   */
  private isMainSessionKey(key: string): boolean {
    return key.endsWith(':main');
  }

  /**
   * Ensure an ActiveTurn exists for a session. Used for channel-originated sessions
   * where new turns arrive after the previous turn was cleaned up.
   */
  private isSessionInStopCooldown(sessionId: string): boolean {
    const stoppedAt = this.stoppedSessions.get(sessionId);
    if (stoppedAt === undefined) return false;
    if (Date.now() - stoppedAt < OpenClawRuntimeAdapter.STOP_COOLDOWN_MS) {
      return true;
    }
    // Cooldown expired, remove the entry
    this.stoppedSessions.delete(sessionId);
    return false;
  }

  /**
   * Mark session as waiting for subagent completion.
   * Called by handleChatFinal when main agent finishes but subagents are still running.
   * Prevents ensureActiveTurn from re-creating turn on late-arriving announce events.
   */
  private markPendingSubagentCompletion(sessionId: string): void {
    this.pendingSubagentCompletionSessions.add(sessionId);
    console.log(
      '[OpenClawRuntime] markPendingSubagentCompletion: sessionId=',
      sessionId,
      'pendingSubagentCompletionSessions.size=',
      this.pendingSubagentCompletionSessions.size,
    );
  }

  /**
   * Clear pending subagent completion marker when session truly completes.
   * Called by delayed check when all subagents finish and session is marked completed.
   */
  private clearPendingSubagentCompletion(sessionId: string): void {
    const existed = this.pendingSubagentCompletionSessions.has(sessionId);
    this.pendingSubagentCompletionSessions.delete(sessionId);
    if (existed) {
      console.log(
        '[OpenClawRuntime] clearPendingSubagentCompletion: sessionId=',
        sessionId,
        'pendingSubagentCompletionSessions.size=',
        this.pendingSubagentCompletionSessions.size,
      );
    }
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    // Suppress automatic turn re-creation for sessions that are still within
    // the stop cooldown window.  This prevents late-arriving OpenClaw events
    // (e.g. from POPO/Telegram) from restarting a stopped session.
    if (this.isSessionInStopCooldown(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] suppressed — session in stop cooldown, sessionId:',
        sessionId,
      );
      return;
    }
    // Suppress turn re-creation when session is waiting for subagent completion.
    // Late-arriving announce events (thinking/assistant) from completed subagents
    // should not create new turn after handleChatFinal deleted it.
    if (this.pendingSubagentCompletionSessions.has(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] suppressed — session pending subagent completion, sessionId:',
        sessionId,
        'event runId:',
        runId?.slice(0, 12),
      );
      return;
    }
    // Once the cooldown has expired, clear the manual-stop marker so that
    // genuinely new channel messages can create a fresh turn.  Without this,
    // `manuallyStoppedSessions` (a permanent Set) would block all future
    // channel events for this session until `runTurn` or `onSessionDeleted`
    // happens to clear it.
    if (this.manuallyStoppedSessions.has(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] cooldown expired, clearing manuallyStoppedSessions for channel re-activation, sessionId:',
        sessionId,
      );
      this.manuallyStoppedSessions.delete(sessionId);
    }
    const turnRunId = runId || randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const isChannel =
      this.channelSessionSync &&
      !isManagedSessionKey(sessionKey) &&
      this.channelSessionSync.isChannelSessionKey(sessionKey);
    const session = this.store.getSession(sessionId);
    const agentId = session?.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    let modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    // Fallback to config default model if agent model is empty
    if (!modelName) {
      const apiResolution = resolveRawApiConfig();
      const configModel = apiResolution.config?.model;
      const providerMetadata = apiResolution.providerMetadata;
      if (configModel) {
        modelName = providerMetadata?.modelName || configModel;
      }
    }
    console.log(
      '[Debug:ensureActiveTurn] creating turn — sessionId:',
      sessionId,
      'sessionKey:',
      sessionKey,
      'runId:',
      turnRunId,
      'isChannel:',
      !!isChannel,
      'pendingUserSync:',
      !!isChannel,
    );
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId: turnRunId,
      turnToken,
      knownRunIds: new Set(runId ? [runId] : [turnRunId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
      pendingUserSync: !!isChannel,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
      currentThinkingMessageId: null,
      currentThinkingContent: '',
      thinkingStreamEnded: false,
      modelName,
    });
    if (runId) {
      this.sessionIdByRunId.set(runId, sessionId);
    }
    this.store.updateSession(sessionId, { status: 'running' });
    this.startTurnTimeoutWatchdog(sessionId);

    // For channel sessions, prefetch user messages before streaming starts
    if (isChannel) {
      void this.prefetchChannelUserMessages(sessionId, sessionKey);
    }
  }

  /**
   * Prefetch user messages from gateway history at the start of a channel session turn.
   * This ensures user messages appear before the assistant's streaming response.
   * Delta/final events are buffered until this completes.
   */
  private async prefetchChannelUserMessages(sessionId: string, sessionKey: string): Promise<void> {
    console.log('[Debug:prefetch] start — sessionId:', sessionId, 'sessionKey:', sessionKey);

    // Best-effort prefetch with 2 attempts. Final correctness is ensured by
    // reconcileWithHistory after the turn completes.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const client = this.gatewayClient;
        if (!client) {
          console.log('[Debug:prefetch] no gateway client available');
          break;
        }

        const history = await client.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey,
          limit: FINAL_HISTORY_SYNC_LIMIT,
        });
        const msgCount = Array.isArray(history?.messages) ? history.messages.length : 0;
        console.log(
          '[Debug:prefetch] chat.history returned',
          msgCount,
          'messages (attempt',
          attempt,
          ')',
        );

        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          this.historyReconciler.markGatewayHistoryWindowConsumed(sessionId, history.messages);
          const latestOnly = this.reCreatedChannelSessionIds.has(sessionId);
          const beforeCount = this.getUserMessageCount(sessionId);
          this.syncChannelUserMessages(
            sessionId,
            history.messages,
            latestOnly,
            sessionKey.includes(':discord:'),
          );
          const afterCount = this.getUserMessageCount(sessionId);
          const newUserMessages = afterCount - beforeCount;
          console.log(
            '[Debug:prefetch] synced user messages:',
            newUserMessages,
            '(before:',
            beforeCount,
            'after:',
            afterCount,
            ')',
          );

          if (newUserMessages > 0) {
            break;
          }

          // Retry once if buffered events suggest history hasn't caught up yet
          if (attempt < MAX_ATTEMPTS - 1) {
            const turn = this.activeTurns.get(sessionId);
            if (
              turn &&
              (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)
            ) {
              console.log(
                '[Debug:prefetch] no new user messages but have buffered events, retrying after 500ms...',
              );
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
          }
          break;
        } else {
          // Retry once if buffered events suggest history hasn't caught up yet
          if (attempt < MAX_ATTEMPTS - 1) {
            const turn = this.activeTurns.get(sessionId);
            if (
              turn &&
              (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)
            ) {
              console.log(
                '[Debug:prefetch] empty history but have buffered events, retrying after 500ms...',
              );
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
          }
          break;
        }
      } catch (error) {
        console.warn(
          '[OpenClawRuntime] prefetchChannelUserMessages attempt',
          attempt,
          'failed:',
          error,
        );
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log(
        '[Debug:prefetch] turn was removed during prefetch, cannot replay. sessionId:',
        sessionId,
      );
      return;
    }
    turn.pendingUserSync = false;

    const chatBuffered = turn.bufferedChatPayloads.length;
    const agentBuffered = turn.bufferedAgentPayloads.length;
    console.log(
      '[Debug:prefetch] replaying buffered events — chat:',
      chatBuffered,
      'agent:',
      agentBuffered,
    );

    // Merge and replay both chat and agent events in sequence order
    // so that tool use/result messages are interleaved with assistant text segments
    // just like in direct cowork sessions.
    const allBuffered: Array<{
      type: 'chat' | 'agent';
      payload: unknown;
      seq?: number;
      bufferedAt: number;
      idx: number;
    }> = [];
    let bufIdx = 0;
    for (const event of turn.bufferedChatPayloads) {
      allBuffered.push({
        type: 'chat',
        payload: event.payload,
        seq: event.seq,
        bufferedAt: event.bufferedAt,
        idx: bufIdx++,
      });
    }
    for (const event of turn.bufferedAgentPayloads) {
      allBuffered.push({
        type: 'agent',
        payload: event.payload,
        seq: event.seq,
        bufferedAt: event.bufferedAt,
        idx: bufIdx++,
      });
    }
    turn.bufferedChatPayloads = [];
    turn.bufferedAgentPayloads = [];

    allBuffered.sort((a, b) => {
      // Primary: sort by seq if both have it
      const hasSeqA = typeof a.seq === 'number';
      const hasSeqB = typeof b.seq === 'number';
      if (hasSeqA && hasSeqB) return a.seq! - b.seq!;
      // Events with seq come before events without
      if (hasSeqA !== hasSeqB) return hasSeqA ? -1 : 1;
      // Fallback: preserve arrival order via bufferedAt, then insertion index
      if (a.bufferedAt !== b.bufferedAt) return a.bufferedAt - b.bufferedAt;
      return a.idx - b.idx;
    });

    for (const event of allBuffered) {
      if (event.type === 'chat') {
        this.handleChatEvent(event.payload, event.seq);
      } else {
        this.handleAgentEvent(event.payload, event.seq);
      }
    }
    console.log('[Debug:prefetch] replay complete, sessionId:', sessionId);
  }

  private bindRunIdToTurn(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    // Check if this is a new runId (not already in knownRunIds)
    // If so, reset text-related state to avoid false "text reset" detection
    // that could cause incorrect message splitting
    const isNewRunId = !turn.knownRunIds.has(normalizedRunId);

    if (isNewRunId) {
      // Finalize any pending streaming message before resetting state
      // This ensures the old message is properly marked as final
      // NOTE: Do NOT call flushPendingStoreUpdate here because it would write
      // currentAssistantSegmentText (which may be truncated) to the store,
      // overwriting the complete content. Instead, just mark metadata as final.
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        const session = this.store.getSession(sessionId);
        const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);

        if (existingMsg && existingMsg.metadata?.isStreaming) {
          // Mark the old message as final without changing content
          // This preserves whatever content was already in the store
          this.store.updateMessage(sessionId, turn.assistantMessageId, {
            metadata: { isStreaming: false, isFinal: true },
          });
          if (existingMsg.content) {
            this.emit('messageUpdate', sessionId, turn.assistantMessageId, existingMsg.content);
          }
        }
      }

      // Finalize any pending thinking message
      if (turn.currentThinkingMessageId) {
        this.finalizeThinkingMessage(
          sessionId,
          turn.currentThinkingMessageId,
          turn.currentThinkingContent,
        );
      }

      // Reset text tracking state for new run
      turn.agentAssistantTextLength = 0;
      turn.committedAssistantText = '';
      turn.currentAssistantSegmentText = '';
      turn.currentText = '';
      turn.currentThinkingMessageId = null;
      turn.currentThinkingContent = '';
      turn.thinkingStreamEnded = false;
      turn.assistantMessageId = null;
    }

    turn.knownRunIds.add(normalizedRunId);
    this.sessionIdByRunId.set(normalizedRunId, sessionId);
    this.flushPendingAgentEvents(sessionId, normalizedRunId);
  }

  private resolveTurn(sessionId: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.resolve();
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.reject(error);
  }

  private toSessionKey(sessionId: string, agentId?: string): string {
    return buildManagedSessionKey(sessionId, agentId);
  }

  private requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return this.gatewayClient;
  }

  /**
   * Return the current gateway client instance, or null if not yet connected.
   * Used by CronJobService to call cron.* APIs on the same gateway.
   */
  getGatewayClient(): GatewayClientLike | null {
    return this.gatewayClient;
  }

  getSessionKeysForSession(sessionId: string): string[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return [];
    }

    const keys: string[] = [];
    for (const [key, mappedSessionId] of this.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === normalizedSessionId) {
        keys.push(key);
      }
    }

    const session = this.store.getSession(normalizedSessionId);
    const managedKey = this.toSessionKey(normalizedSessionId, session?.agentId);
    if (!keys.includes(managedKey)) {
      keys.push(managedKey);
    }

    keys.sort((left, right) => {
      const leftManaged = isManagedSessionKey(left);
      const rightManaged = isManagedSessionKey(right);
      if (leftManaged !== rightManaged) {
        return leftManaged ? 1 : -1;
      }
      return left.localeCompare(right);
    });

    return keys;
  }

  /**
   * Ensure the gateway client is connected and ready.
   * Resolves when the WebSocket connection is established and authenticated.
   */
  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }

  /**
   * Delegate to SubagentManager for external callers (main.ts IPC).
   */
  async getSubagentStatuses(sessionId?: string): Promise<{
    statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'>;
    displayLabels: Record<string, string>;
  }> {
    return this.subagentManager.getSubagentStatuses(sessionId);
  }

  /**
   * 获取子 Agent 消息历史
   */
  async getSubTaskHistory(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ): Promise<CoworkMessage[]> {
    return this.subtaskHistory.getSubTaskHistory(parentSessionId, agentId, sessionKey);
  }

  /**
   * 获取失败的子 Agent 错误信息
   * 优先从父 session 的 tool_result 消息中提取错误信息
   */
  async getSubagentErrorInfo(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ): Promise<{
    state?: string;
    status?: string;
    outcome?: string;
    endedAt?: number;
    errorMessage?: string;
    lastMessage?: string;
  } | null> {
    // 1. First try to get error from tool_result message in parent session
    const parentSession = this.store.getSession(parentSessionId);
    if (parentSession?.messages) {
      // Find the tool_result for this agentId (toolCallId)
      for (const msg of parentSession.messages) {
        if (
          msg.type === 'tool_result' &&
          msg.metadata?.toolName === 'sessions_spawn' &&
          msg.metadata?.toolUseId === agentId
        ) {
          const toolResult = msg.metadata?.toolResult;
          if (toolResult) {
            // Parse toolResult - could be object or string
            let resultObj: Record<string, unknown> | null = null;
            if (isRecord(toolResult)) {
              resultObj = toolResult;
            } else if (typeof toolResult === 'string') {
              try {
                const parsed = JSON.parse(toolResult);
                if (isRecord(parsed)) {
                  resultObj = parsed;
                }
              } catch {
                // Not JSON, use as raw error message
                if (toolResult.toLowerCase().includes('error') ||
                    toolResult.toLowerCase().includes('failed') ||
                    toolResult.toLowerCase().includes('forbidden')) {
                  return { errorMessage: toolResult.slice(0, 500) };
                }
              }
            }

            if (resultObj) {
              // Check for error status
              const status = typeof resultObj.status === 'string' ? resultObj.status : '';
              const error = typeof resultObj.error === 'string' ? resultObj.error : '';
              if (status === 'forbidden' || status === 'error' || status === 'failed' || error) {
                console.log(
                  '[OpenClawRuntime] getSubagentErrorInfo: found error in tool_result for agentId=' +
                    agentId +
                    ' status=' +
                    (status || '(none)') +
                    ' error=' +
                    (error || '(none)'),
                );
                return {
                  status: status,
                  errorMessage: error || `Spawn failed with status: ${status}`,
                };
              }
            }
          }
          // Also check isError flag
          if (msg.metadata?.isError) {
            const content = typeof msg.content === 'string' ? msg.content : '';
            return {
              errorMessage: content.slice(0, 500) || 'Tool call failed',
            };
          }
        }
      }
    }

    // 2. Fallback: try gateway sessions.get for session state info
    let childSessionKey = sessionKey;
    if (!childSessionKey) {
      childSessionKey = this.toolCallIdToSessionKey.get(agentId);
    }
    if (!childSessionKey && /^[a-f0-9-]{36}$/i.test(agentId)) {
      childSessionKey = `agent:main:subagent:${agentId}`;
    }

    if (!childSessionKey || !this.gatewayClient) {
      return null;
    }

    try {
      const sessionInfo = await this.gatewayClient.request<{
        state?: string;
        status?: string;
        outcome?: string;
        endedAt?: number;
        active?: boolean;
        error?: string;
        lastError?: string;
      }>('sessions.get', { sessionKey: childSessionKey });

      if (!sessionInfo) {
        return null;
      }

      // Get last message from subagent history
      let lastMessage: string | undefined;
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>(
          'chat.history',
          { sessionKey: childSessionKey, limit: 5 },
        );
        const messages = history?.messages;
        if (Array.isArray(messages) && messages.length > 0) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (!isRecord(msg)) continue;
            const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
            if (role === 'assistant' || role === 'system') {
              const text = extractMessageText(msg).trim();
              if (text) {
                lastMessage = text.slice(0, 500);
                break;
              }
            }
          }
        }
      } catch {
        // Ignore history errors
      }

      return {
        state: sessionInfo.state || sessionInfo.status,
        status: sessionInfo.status,
        outcome: sessionInfo.outcome,
        endedAt: sessionInfo.endedAt,
        errorMessage: sessionInfo.error || sessionInfo.lastError,
        lastMessage,
      };
    } catch (err) {
      console.warn('[OpenClawRuntime] getSubagentErrorInfo gateway query failed:', err);
      return null;
    }
  }

  // ─── Skill RPC Delegates ─────────────────────────────────────────────────

  async generateTitle(userIntent: string | null, timeoutMs = 8000): Promise<string> {
    return this.skillRpcHandler.generateTitle(userIntent, timeoutMs);
  }

  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.skillRpcHandler.patchSessionModel(sessionId, model, agentId);
  }

  async getSkillsStatus(agentId?: string): Promise<import('./types').GatewaySkillStatus> {
    return this.skillRpcHandler.getSkillsStatus(agentId);
  }

  async installSkill(
    params: import('./types').SkillInstallParams,
  ): Promise<import('./types').SkillRpcResult> {
    return this.skillRpcHandler.installSkill(params);
  }

  async updateSkillConfig(
    params: import('./types').SkillUpdateParams,
  ): Promise<import('./types').SkillRpcResult> {
    return this.skillRpcHandler.updateSkillConfig(params);
  }

  async searchClawHubSkills(
    query?: string,
    limit?: number,
  ): Promise<import('./types').ClawHubSearchResult[]> {
    return this.skillRpcHandler.searchClawHubSkills(query, limit);
  }

  async getClawHubSkillDetail(slug: string): Promise<import('./types').ClawHubDetail | null> {
    return this.skillRpcHandler.getClawHubSkillDetail(slug);
  }
}

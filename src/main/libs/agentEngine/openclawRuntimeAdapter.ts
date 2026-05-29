import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';

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
  type OpenClawChannelSessionSync,
} from '../openclawChannelSessionSync';
import { OPENCLAW_AGENT_TIMEOUT_SECONDS } from '../openclawConfigSync';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../openclawEngineManager';
import { extractGatewayHistoryEntries } from '../openclawHistory';
import type {
  AgentEventPayload,
  ChatEventPayload,
  ExecApprovalRequestedPayload,
  ExecApprovalResolvedPayload,
  GatewayClientCtor,
  GatewayClientLike,
  GatewayEventFrame,
  SessionTurn,
  ToolStreamEntry,
} from './gateway/types';
import { HistoryReconciler } from './history/historyReconciler';
import { SubtaskHistory } from './history/subtaskHistory';
import { SkillRpcHandler } from './rpc/skillRpc';
import type { PermissionResult } from './types';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  PermissionRequest,
} from './types';
import {
  CHANNEL_SESSION_DISCOVERY_LIMIT,
  extractMessageText,
  extractSubagentCompletionMessages,
  GATEWAY_READY_TIMEOUT_MS,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  isRecord,
  OPENCLAW_GATEWAY_TOOL_EVENTS_CAP,
  waitWithTimeout,
} from './utils/gatewayHelpers';

// ─── Constants ──────────────────────────────────────────────────────────────

const NO_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const STOP_COOLDOWN_MS = 10_000;
const RACE_RESOLUTION_MS = 1_000;
const FULL_HISTORY_SYNC_LIMIT = 50;
const TICK_WATCHDOG_INTERVAL_MS = 60_000;
const TICK_TIMEOUT_MS = 90_000;
const AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000;
const MESSAGE_UPDATE_THROTTLE_MS = 200;
const CLIENT_TIMEOUT_GRACE_MS = 30_000;
const SUBAGENT_STATUS_CACHE_TTL_MS = 2_000;
const GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
const GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000];
const GATEWAY_CONNECT_RETRY_DELAYS = [500, 1_500, 3_000];

// ─── Utilities ──────────────────────────────────────────────────────────────

const isNoReply = (text: string): boolean => NO_REPLY_PATTERN.test(text);

const extractAssistantText = (message: unknown): string => {
  if (!isRecord(message)) return '';
  if (typeof message.text === 'string') return message.text;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is Record<string, unknown> =>
          isRecord(b) && b.type === 'text' && typeof b.text === 'string',
      )
      .map(b => b.text as string)
      .join('');
  }
  return '';
};

// ─── Adapter ────────────────────────────────────────────────────────────────

type PendingApprovalEntryLocal = {
  requestId: string;
  sessionId: string;
  allowAlways?: boolean;
};

type SubagentStreamState = {
  parentSessionId: string;
  agentId: string;
  assistantMessageId: string | null;
  thinkingMessageId: string | null;
  thinkingContent: string;
};

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;

  // Per-session turn state (replaces 25+ scattered Maps)
  private readonly activeTurns = new Map<string, SessionTurn>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly pendingTurns = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly stoppedSessions = new Map<string, number>();
  private readonly manuallyStoppedSessions = new Set<string>();
  private readonly pendingSubagentCompletionSessions = new Set<string>();

  // Approval
  private readonly pendingApprovals = new Map<string, PendingApprovalEntryLocal>();

  // Gateway connection
  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  private pendingGatewayClient: GatewayClientLike | null = null;
  private readonly intentionallyStoppedGatewayClients = new WeakSet<object>();
  private gatewayReadyPromise: Promise<void> | null = null;
  private gatewayClientInitLock: Promise<void> | null = null;
  private gatewayStoppingIntentionally = false;
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;

  // Tick watchdog
  private lastTickTimestamp = 0;
  private lastAgentActivityTimestamp = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // MessageUpdate throttle
  private lastMessageUpdateEmitTime = new Map<string, number>();
  private pendingMessageUpdateTimer = new Map<string, ReturnType<typeof setTimeout>>();

  // Channel session sync
  private channelSessionSync: OpenClawChannelSessionSync | null = null;
  private readonly knownChannelSessionIds = new Set<string>();
  private readonly fullySyncedSessions = new Set<string>();
  private readonly channelSyncCursor = new Map<string, number>();
  private readonly reCreatedChannelSessionIds = new Set<string>();
  private readonly deletedChannelKeys = new Set<string>();
  private readonly heartbeatSessionKeys = new Set<string>();
  private readonly gatewayHistoryCountBySession = new Map<string, number>();
  private readonly latestTurnTokenBySession = new Map<string, number>();

  // Subagent status tracking (simplified)
  private readonly subagentStatus = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
  private readonly toolCallIdToLabel = new Map<string, string>();
  private readonly toolCallIdToSessionKey = new Map<string, string>();
  private readonly sessionKeyToLabel = new Map<string, string>();
  private readonly toolCallIdToParentSessionId = new Map<string, string>();
  private readonly subagentMessages = new Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >();
  private readonly subagentGatewayStatusCache = new Map<
    string,
    {
      expiresAt: number;
      subagents: Array<{
        id: string;
        sessionKey: string;
        label: string;
        status: 'pending' | 'running' | 'done' | 'failed';
      }>;
    }
  >();
  private readonly subagentStreamByRunId = new Map<string, SubagentStreamState>();
  private readonly orchestrationSessionIds = new Set<string>();
  private readonly mainAgentLifecycleEnded = new Set<string>();
  private readonly toolCallArgs = new Map<string, Record<string, unknown>>();

  // Collaborators
  private historyReconciler!: HistoryReconciler;
  private subtaskHistory!: SubtaskHistory;
  private skillRpcHandler!: SkillRpcHandler;

  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;

  constructor(store: CoworkStore, engineManager: OpenClawEngineManager) {
    super();
    this.store = store;
    this.engineManager = engineManager;

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
      setGatewayHistoryCount: (id: string, count: number) =>
        this.gatewayHistoryCountBySession.set(id, count),
      hasGatewayHistoryCount: (id: string) => this.gatewayHistoryCountBySession.has(id),
      setChannelSyncCursor: (id: string, cursor: number) => this.channelSyncCursor.set(id, cursor),
      emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      isCurrentTurnToken: () => true,
      resolveAssistantSegmentText: (_turn: unknown, text: string) => text,
      reuseFinalAssistantMessage: () => null,
      isChannelSessionKey: (key: string) =>
        this.channelSessionSync?.isChannelSessionKey(key) ?? false,
      isReCreatedChannelSession: (id: string) => this.reCreatedChannelSessionIds.has(id),
      syncChannelUserMessages: (
        id: string,
        msgs: unknown[],
        latestOnly: boolean,
        isDiscord: boolean,
      ) => this.syncChannelUserMessages(id, msgs, latestOnly, isDiscord),
      getFullHistorySyncLimit: () => FULL_HISTORY_SYNC_LIMIT,
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
      uuidToToolCallId: new Map(),
    });
  }

  setChannelSessionSync(sync: OpenClawChannelSessionSync): void {
    this.channelSessionSync = sync;
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────

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
      this.pendingSubagentCompletionSessions.delete(sessionId);
      const client = this.gatewayClient;
      if (client) {
        void client
          .request('chat.abort', { sessionKey: turn.sessionKey, runId: turn.runId })
          .catch(error => console.warn('[OpenClawRuntime] Failed to abort chat run:', error));
      }
    }
    this.stoppedSessions.set(sessionId, Date.now());
    this.orchestrationSessionIds.delete(sessionId);
    this.mainAgentLifecycleEnded.delete(sessionId);
    this.cleanupSessionTurn(sessionId);
    this.clearPendingApprovalsBySession(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  stopAllSessions(): void {
    for (const sessionId of this.activeTurns.keys()) {
      this.stopSession(sessionId);
    }
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;

    const decision =
      result.behavior !== 'allow' ? 'deny' : pending.allowAlways ? 'allow-always' : 'allow-once';
    const client = this.gatewayClient;
    if (!client) {
      this.pendingApprovals.delete(requestId);
      return;
    }

    const sessionId = pending.sessionId;
    const needsContinuation = !pending.allowAlways;

    void client
      .request('exec.approval.resolve', { id: requestId, decision })
      .then(() => {
        if (!needsContinuation) return;
        const prompt = decision !== 'deny' ? t('execApprovalApproved') : t('execApprovalDenied');
        const tryContinue = (retries: number) => {
          if (!this.store.getSession(sessionId)) return;
          if (!this.isSessionActive(sessionId)) {
            void this.continueSession(sessionId, prompt).catch(error =>
              console.warn('[OpenClawRuntime] failed to continue session after approval:', error),
            );
            return;
          }
          if (retries > 0) setTimeout(() => tryContinue(retries - 1), 1000);
        };
        tryContinue(10);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', sessionId, `Failed to resolve OpenClaw approval: ${message}`);
      })
      .finally(() => this.pendingApprovals.delete(requestId));
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

  // ─── Run Turn ───────────────────────────────────────────────────────────

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

    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.orchestrationSessionIds.add(sessionId);

    // Resolve stale activeTurns
    if (this.activeTurns.has(sessionId)) {
      await this.resolveActiveTurnConflict(sessionId);
    }

    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

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
    if (!modelName) {
      const apiResolution = resolveRawApiConfig();
      const configModel = apiResolution.config?.model;
      const providerMetadata = apiResolution.providerMetadata;
      if (configModel) modelName = providerMetadata?.modelName || configModel;
    }

    const sessionKey = this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, sessionKey);
    this.store.updateSession(sessionId, { status: 'running' });
    setCoworkProxySessionId(sessionId);
    await this.ensureGatewayClientReady();

    const runId = randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(sessionId, { resolve, reject });
    });

    // Create SessionTurn (replaces 22-field ActiveTurn)
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId,
      turnToken,
      chatStream: '',
      chatStreamStartedAt: 0,
      toolStreamById: new Map(),
      toolStreamOrder: [],
      chatStreamSegments: [],
      thinkingContent: '',
      thinkingMessageId: null,
      stopRequested: false,
      assistantMessageId: null,
      modelName,
      knownRunIds: new Set([runId]),
    });
    this.sessionIdByRunId.set(runId, sessionId);
    this.startTurnTimeoutWatchdog(sessionId);
    this.lastAgentActivityTimestamp = Date.now();

    const client = this.requireGatewayClient();
    try {
      const attachments = options.imageAttachments?.length
        ? options.imageAttachments.map(img => ({
            type: 'image',
            mimeType: img.mimeType,
            content: img.base64Data,
          }))
        : undefined;
      await client.request('chat.send', {
        sessionKey,
        message: prompt.trim(),
        deliver: false,
        idempotencyKey: runId,
        ...(attachments ? { attachments } : {}),
      });
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

  // ─── Gateway Event Routing ──────────────────────────────────────────────

  private handleGatewayEvent(event: GatewayEventFrame): void {
    if (event.event === 'tick') {
      this.lastTickTimestamp = Date.now();
      return;
    }

    if (event.event === 'chat') {
      this.handleChatEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'agent') {
      this.lastAgentActivityTimestamp = Date.now();
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      this.handleApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.handleApprovalResolved(event.payload);
      return;
    }

    if (event.event === 'session.tool') {
      this.lastAgentActivityTimestamp = Date.now();
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }
  }

  // ─── Chat Event Handling (aligned with webchat) ─────────────────────────

  private handleChatEvent(payload: unknown, _seq?: number): void {
    if (!isRecord(payload)) return;
    const p = payload as ChatEventPayload;
    const sessionKey = typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '';
    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    const state = p.state;

    // Resolve sessionId from runId or sessionKey
    let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (sessionId && runId) {
        this.ensureActiveTurn(sessionId, sessionKey, runId);
      }
    }
    if (!sessionId) {
      // Try channel session resolution
      if (sessionKey && this.channelSessionSync) {
        const channelSessionId =
          this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey) ||
          this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          null;
        if (channelSessionId) {
          this.rememberSessionKey(channelSessionId, sessionKey);
          this.ensureActiveTurn(channelSessionId, sessionKey, runId);
          sessionId = channelSessionId;
        }
      }
      if (!sessionId) return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    // Foreign run (subagent announce): stream to the subagent drawer and don't touch active run.
    if (runId && turn.runId !== runId && !turn.knownRunIds.has(runId) && this.isAnnounceRunId(runId)) {
      this.adoptAnnounceRun(sessionId, sessionKey, runId, turn);
    }

    if (runId && turn.runId !== runId && !turn.knownRunIds.has(runId)) {
      const agentId = this.resolveSubagentToolCallId(sessionId, runId, sessionKey);
      const text = extractAssistantText(p.message);
      if (state === 'delta') {
        this.emitSubagentAssistantSnapshot(sessionId, runId, agentId, text, false);
      } else if (state === 'final' || state === 'aborted') {
        let resolvedAgentId = agentId;
        if (text && !isNoReply(text)) {
          this.emitSubagentAssistantSnapshot(sessionId, runId, agentId, text, true);
          const messages = text.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN)
            ? extractSubagentCompletionMessages(text, Date.now(), 0)
            : [{ type: 'assistant' as const, content: text, timestamp: Date.now() }];

          for (const msg of messages) {
            resolvedAgentId = this.resolveSubagentToolCallIdFromMetadata(
              sessionId,
              resolvedAgentId,
              msg.metadata,
            );
            this.updateSubagentStatusFromCompletion(resolvedAgentId, msg.metadata);
            const savedMsg = this.store.addMessage(sessionId, {
              type: msg.type as CoworkMessage['type'],
              content: msg.content,
              metadata: 'metadata' in msg ? msg.metadata : undefined,
            });
            this.emit('message', sessionId, savedMsg);
            if (msg.type !== 'assistant') {
              this.emit('subagentMessage', sessionId, resolvedAgentId, savedMsg);
            }
          }
          if (resolvedAgentId !== agentId) {
            this.subagentStatus.delete(agentId);
          }
        }
        this.finalizeSubagentStream(runId);
        if (this.subagentStatus.get(resolvedAgentId) !== 'failed') {
          this.subagentStatus.set(resolvedAgentId, 'done');
        }
        turn.knownRunIds.add(runId);
      } else if (state === 'error') {
        this.subagentStatus.set(agentId, 'failed');
        this.finalizeSubagentStream(runId);
      }
      return;
    }

    // Terminal event helper (aligned with webchat reconcileTerminalRun)
    const reconcileTerminalRun = (sessionStatus: 'idle' | 'completed' | 'error') => {
      this.cleanupSessionTurn(sessionId!);
      this.store.updateSession(sessionId!, { status: sessionStatus });
      this.mainAgentLifecycleEnded.add(sessionId!);
      this.resolveTurn(sessionId!);
      // Notify renderer of turn completion
      const session = this.store.getSession(sessionId!);
      this.emit('complete', sessionId!, session?.claudeSessionId ?? null, sessionStatus);
      // Post-turn sync: patch tool results/args/usage from chat.history
      if (sessionKey) {
        void this.historyReconciler.reconcileWithHistory(sessionId!, sessionKey).catch(() => {});
      }
    };

    if (state === 'delta') {
      const text = extractAssistantText(p.message);
      if (text && !isNoReply(text)) {
        turn.chatStream = text; // Full replacement (webchat pattern)
        if (!turn.chatStreamStartedAt) turn.chatStreamStartedAt = Date.now();
        // Emit streaming update
        if (turn.assistantMessageId) {
          this.throttledEmitMessageUpdate(sessionId, turn.assistantMessageId, text);
        } else {
          // Create streaming message on first delta
          const msg = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: text,
            metadata: { isStreaming: true, isFinal: false, modelName: turn.modelName },
          });
          turn.assistantMessageId = msg.id;
          this.emit('message', sessionId, msg);
        }
      }
    } else if (state === 'final') {
      const text = extractAssistantText(p.message);
      const finalText = text || turn.chatStream;
      if (finalText && !isNoReply(finalText)) {
        if (turn.assistantMessageId) {
          // Finalize existing streaming message
          this.store.updateMessage(sessionId, turn.assistantMessageId, {
            content: finalText,
            metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
          });
          this.emit('messageUpdate', sessionId, turn.assistantMessageId, finalText);
        } else {
          const duplicate = this.findRecentAssistantByContent(sessionId, finalText);
          if (duplicate) {
            this.store.updateMessage(sessionId, duplicate.id, {
              content: finalText,
              metadata: {
                ...duplicate.metadata,
                isStreaming: false,
                isFinal: true,
                modelName: turn.modelName,
              },
            });
            this.emit('messageMetadataUpdate', sessionId, duplicate.id, {
              ...duplicate.metadata,
              isStreaming: false,
              isFinal: true,
              modelName: turn.modelName,
            });
            reconcileTerminalRun('idle');
            return;
          }
          // Create final message
          const msg = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: finalText,
            metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
          });
          this.emit('message', sessionId, msg);
        }
      }
      reconcileTerminalRun('idle');
    } else if (state === 'aborted') {
      const text = extractAssistantText(p.message) || turn.chatStream;
      if (text && !isNoReply(text)) {
        if (turn.assistantMessageId) {
          this.store.updateMessage(sessionId, turn.assistantMessageId, {
            content: text,
            metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
          });
          this.emit('messageUpdate', sessionId, turn.assistantMessageId, text);
        } else {
          const msg = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: text,
            metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
          });
          this.emit('message', sessionId, msg);
        }
      }
      reconcileTerminalRun('idle');
    } else if (state === 'error') {
      reconcileTerminalRun('error');
      this.emit('error', sessionId, p.errorMessage ?? 'chat error');
    }
  }

  // ─── Agent Event Handling (tool stream) ─────────────────────────────────

  private handleAgentEvent(payload: unknown, _seq?: number): void {
    if (!isRecord(payload)) return;
    const p = payload as AgentEventPayload;
    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    const sessionKey =
      typeof p.sessionKey === 'string'
        ? p.sessionKey.trim()
        : typeof p.session === 'string'
          ? p.session.trim()
          : '';
    const stream = typeof p.stream === 'string' ? p.stream : '';

    // Resolve sessionId
    let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    }
    if (!sessionId) {
      this.handleDetachedSubagentAgentEvent(runId, sessionKey, stream, p.data);
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      this.handleDetachedSubagentAgentEvent(runId, sessionKey, stream, p.data);
      return;
    }

    if (runId && turn.runId !== runId && !turn.knownRunIds.has(runId) && this.isAnnounceRunId(runId)) {
      this.adoptAnnounceRun(sessionId, sessionKey, runId, turn);
    }

    if (runId && turn.runId !== runId && !turn.knownRunIds.has(runId)) {
      const data = isRecord(p.data) ? p.data : {};
      const agentId = this.resolveSubagentToolCallId(sessionId, runId, sessionKey);
      if (stream === 'thinking') {
        this.emitSubagentThinkingSnapshot(sessionId, runId, agentId, data);
      } else if (stream === 'assistant') {
        const text = typeof data.text === 'string' ? data.text : '';
        this.emitSubagentAssistantSnapshot(sessionId, runId, agentId, text, false);
      } else if (stream === 'lifecycle') {
        const phase = typeof data.phase === 'string' ? data.phase : '';
        if (phase === 'end') {
          if (this.subagentStatus.get(agentId) !== 'failed')
            this.subagentStatus.set(agentId, 'done');
          this.finalizeSubagentStream(runId);
        } else if (phase === 'error') {
          this.subagentStatus.set(agentId, 'failed');
          this.finalizeSubagentStream(runId);
        }
      }
      return;
    }

    // Register runId if new
    if (runId && !turn.knownRunIds.has(runId)) {
      turn.knownRunIds.add(runId);
      this.sessionIdByRunId.set(runId, sessionId);
    }

    const data = isRecord(p.data) ? p.data : {};

    // Thinking stream — OpenClaw's `text` is the reliable accumulated snapshot.
    // Its `delta` can be provider-shaped, so compute our own UI delta from the snapshot.
    if (stream === 'thinking') {
      const thinkingSnapshot =
        typeof data.thinking === 'string'
          ? data.thinking
          : typeof data.text === 'string'
            ? data.text
            : '';
      const fallbackDelta = typeof data.delta === 'string' ? data.delta : '';
      const nextThinkingContent = thinkingSnapshot || `${turn.thinkingContent}${fallbackDelta}`;
      const thinkingDelta =
        thinkingSnapshot && thinkingSnapshot.startsWith(turn.thinkingContent)
          ? thinkingSnapshot.slice(turn.thinkingContent.length)
          : !thinkingSnapshot && fallbackDelta
            ? fallbackDelta
            : nextThinkingContent;

      if (nextThinkingContent) {
        turn.thinkingContent = nextThinkingContent;
        if (!turn.thinkingMessageId) {
          const msg = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: '',
            thinkingContent: turn.thinkingContent,
            metadata: { isStreaming: true, isThinking: true },
          });
          turn.thinkingMessageId = msg.id;
          this.emit('message', sessionId, msg);
        } else {
          this.store.updateMessage(sessionId, turn.thinkingMessageId, {
            content: '',
            thinkingContent: turn.thinkingContent,
            metadata: { isStreaming: true, isThinking: true },
          });
          if (thinkingDelta) {
            this.emit('thinkingUpdate', sessionId, turn.thinkingMessageId, thinkingDelta);
          }
        }
      }
      return;
    }

    // Assistant text stream
    if (stream === 'assistant') {
      this.finalizeThinkingSegment(sessionId, turn);
      const text = typeof data.text === 'string' ? data.text : '';
      if (text && !isNoReply(text)) {
        turn.chatStream = text;
        if (!turn.chatStreamStartedAt) turn.chatStreamStartedAt = Date.now();
        if (turn.assistantMessageId) {
          this.throttledEmitMessageUpdate(sessionId, turn.assistantMessageId, text);
        } else {
          const msg = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: text,
            metadata: { isStreaming: true, isFinal: false, modelName: turn.modelName },
          });
          turn.assistantMessageId = msg.id;
          this.emit('message', sessionId, msg);
        }
      }
      return;
    }

    // Tool stream
    if (stream === 'tool') {
      this.handleToolStreamEvent(sessionId, turn, data);
      return;
    }

    // Lifecycle events
    if (stream === 'lifecycle') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      if (phase === 'end' || phase === 'error') {
        this.mainAgentLifecycleEnded.add(sessionId);
      }
      return;
    }

    // Item stream (mirror of tool, skip)
    if (stream === 'item') return;
  }

  private handleDetachedSubagentAgentEvent(
    runId: string,
    sessionKey: string,
    stream: string,
    data: unknown,
  ): void {
    const resolved = this.resolveDetachedSubagent(runId, sessionKey);
    if (!resolved) return;
    this.toolCallIdToParentSessionId.set(resolved.subagentId, resolved.parentSessionId);
    const eventData = isRecord(data) ? data : {};

    if (stream === 'thinking') {
      this.emitSubagentThinkingSnapshot(
        resolved.parentSessionId,
        runId,
        resolved.subagentId,
        eventData,
      );
      return;
    }

    if (stream === 'assistant') {
      const text = typeof eventData.text === 'string' ? eventData.text : '';
      this.emitSubagentAssistantSnapshot(
        resolved.parentSessionId,
        runId,
        resolved.subagentId,
        text,
        false,
      );
      return;
    }

    if (stream !== 'lifecycle') return;
    const phase = typeof eventData.phase === 'string' ? eventData.phase : '';
    if (phase === 'end') {
      if (this.subagentStatus.get(resolved.subagentId) !== 'failed') {
        this.subagentStatus.set(resolved.subagentId, 'done');
      }
      this.finalizeSubagentStream(runId);
    } else if (phase === 'error') {
      this.subagentStatus.set(resolved.subagentId, 'failed');
      this.finalizeSubagentStream(runId);
    }
  }

  private resolveDetachedSubagent(
    runId: string,
    sessionKey: string,
  ): { parentSessionId: string; subagentId: string } | null {
    const stream = runId ? this.subagentStreamByRunId.get(runId) : null;
    if (stream) {
      return { parentSessionId: stream.parentSessionId, subagentId: stream.agentId };
    }

    const normalizedSessionKey = this.normalizeSubagentSessionKey(sessionKey);
    if (!normalizedSessionKey) return null;

    for (const [toolCallId, mappedSessionKey] of this.toolCallIdToSessionKey.entries()) {
      if (this.normalizeSubagentSessionKey(mappedSessionKey) !== normalizedSessionKey) continue;
      const parentSessionId = this.toolCallIdToParentSessionId.get(toolCallId);
      if (parentSessionId) return { parentSessionId, subagentId: normalizedSessionKey };
    }

    return null;
  }

  private normalizeSubagentSessionKey(sessionKey: string): string {
    const key = sessionKey.trim();
    if (!key) return '';
    if (key.startsWith('subagent:')) return `agent:main:${key}`;
    if (!key.includes(':subagent:')) return '';
    return key;
  }

  private finalizeThinkingSegment(sessionId: string, turn: SessionTurn): void {
    if (!turn.thinkingMessageId) return;
    this.store.updateMessage(sessionId, turn.thinkingMessageId, {
      metadata: { isStreaming: false, isThinking: true },
    });
    this.emit('messageMetadataUpdate', sessionId, turn.thinkingMessageId, {
      isStreaming: false,
      isThinking: true,
    });
    turn.thinkingMessageId = null;
    turn.thinkingContent = '';
  }

  private findRecentAssistantByContent(sessionId: string, content: string): CoworkMessage | null {
    const normalized = content.trim();
    if (!normalized) return null;
    const session = this.store.getSession(sessionId);
    if (!session) return null;
    for (let index = session.messages.length - 1; index >= 0; index--) {
      const message = session.messages[index];
      if (message.type !== 'assistant') continue;
      if (message.metadata?.isThinking) continue;
      if (message.content.trim() === normalized) return message;
    }
    return null;
  }

  private isAnnounceRunId(runId: string): boolean {
    return runId.startsWith('announce:v1:');
  }

  private adoptAnnounceRun(
    sessionId: string,
    sessionKey: string,
    runId: string,
    turn: SessionTurn,
  ): void {
    this.finalizeThinkingSegment(sessionId, turn);
    if (turn.assistantMessageId) {
      this.clearPendingMessageUpdate(turn.assistantMessageId);
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
      });
      this.emit('messageMetadataUpdate', sessionId, turn.assistantMessageId, {
        isStreaming: false,
        isFinal: true,
        modelName: turn.modelName,
      });
    }
    turn.runId = runId;
    turn.sessionKey = sessionKey || turn.sessionKey;
    turn.chatStream = '';
    turn.chatStreamStartedAt = 0;
    turn.toolStreamById = new Map();
    turn.toolStreamOrder = [];
    turn.chatStreamSegments = [];
    turn.thinkingContent = '';
    turn.thinkingMessageId = null;
    turn.assistantMessageId = null;
    turn.knownRunIds.add(runId);
    this.sessionIdByRunId.set(runId, sessionId);
  }

  private commitAssistantSegmentBeforeTool(
    sessionId: string,
    turn: SessionTurn,
    timestamp: number,
  ): void {
    const content = turn.chatStream.trim();
    if (!content) return;

    if (turn.assistantMessageId) {
      this.clearPendingMessageUpdate(turn.assistantMessageId);
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content,
        metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
      });
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, content);
      this.emit('messageMetadataUpdate', sessionId, turn.assistantMessageId, {
        isStreaming: false,
        isFinal: true,
        modelName: turn.modelName,
      });
    } else if (!this.findRecentAssistantByContent(sessionId, content)) {
      const msg = this.store.addMessage(sessionId, {
        type: 'assistant',
        content,
        metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
      });
      this.emit('message', sessionId, msg);
    }

    turn.chatStreamSegments.push({ text: content, timestamp });
    turn.chatStream = '';
    turn.chatStreamStartedAt = 0;
    turn.assistantMessageId = null;
  }

  private handleToolStreamEvent(
    sessionId: string,
    turn: SessionTurn,
    data: Record<string, unknown>,
  ): void {
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
    if (!toolCallId) return;

    const name = typeof data.name === 'string' ? data.name : 'tool';
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const args = phase === 'start' ? data.args : undefined;
    const output =
      phase === 'result'
        ? this.formatToolOutput(data.result)
        : phase === 'update'
          ? this.formatToolOutput(data.partialResult)
          : undefined;

    const now = Date.now();
    let entry = turn.toolStreamById.get(toolCallId);

    if (!entry) {
      this.finalizeThinkingSegment(sessionId, turn);

      this.commitAssistantSegmentBeforeTool(sessionId, turn, now);

      entry = {
        toolCallId,
        runId: turn.runId,
        name,
        args,
        output: output || undefined,
        startedAt: now,
        updatedAt: now,
      };
      turn.toolStreamById.set(toolCallId, entry);
      turn.toolStreamOrder.push(toolCallId);
    } else {
      entry.name = name;
      if (args !== undefined) entry.args = args;
      if (output !== undefined) entry.output = output || undefined;
      entry.updatedAt = now;
    }

    // On result: emit tool_use + tool_result messages
    if (phase === 'result') {
      this.emitToolMessages(sessionId, turn, entry);
    }
  }

  private emitToolMessages(sessionId: string, _turn: SessionTurn, entry: ToolStreamEntry): void {
    // Track subagent spawns first so isSubagentTool check works
    if (entry.name === 'sessions_spawn' && entry.args) {
      this.trackSubagentSpawn(sessionId, entry);
    }

    const isSubagentTool = this.toolCallIdToParentSessionId.has(entry.toolCallId);

    // Emit tool_use message
    const toolUseMsg = this.store.addMessage(sessionId, {
      type: 'tool_use',
      content: typeof entry.args === 'string' ? entry.args : JSON.stringify(entry.args ?? {}),
      metadata: {
        toolName: entry.name,
        toolUseId: entry.toolCallId,
        toolInput: isRecord(entry.args) ? entry.args : undefined,
        isStreaming: false,
      },
    });
    this.emit('message', sessionId, toolUseMsg);
    if (isSubagentTool) {
      this.emit('subagentMessage', sessionId, entry.toolCallId, toolUseMsg);
    }

    // Emit tool_result message
    if (entry.output) {
      const toolResult = this.parseToolOutputObject(entry.output) ?? undefined;
      if (entry.name === 'sessions_spawn') {
        this.updateSubagentFromSpawnResult(sessionId, entry.toolCallId, entry.output);
      }
      const toolResultMsg = this.store.addMessage(sessionId, {
        type: 'tool_result',
        content: entry.output,
        metadata: {
          toolName: entry.name,
          toolUseId: entry.toolCallId,
          toolResult,
          isError:
            entry.name === 'sessions_spawn' &&
            this.subagentStatus.get(entry.toolCallId) === 'failed',
          isStreaming: false,
        },
      });
      this.emit('message', sessionId, toolResultMsg);
      if (isSubagentTool) {
        this.emit('subagentMessage', sessionId, entry.toolCallId, toolResultMsg);
      }
    }
  }

  private trackSubagentSpawn(sessionId: string, entry: ToolStreamEntry): void {
    const args = entry.args;
    if (!isRecord(args)) return;
    const label = this.getSubagentDisplayLabelFromToolInput(args);
    const toolCallId = entry.toolCallId;
    if (!toolCallId) return;

    this.toolCallIdToParentSessionId.set(toolCallId, sessionId);
    if (label) {
      this.toolCallIdToLabel.set(toolCallId, label);
    }
    this.subagentStatus.set(toolCallId, 'pending');
    this.toolCallArgs.set(toolCallId, args as Record<string, unknown>);
  }

  private resolveSubagentToolCallId(
    parentSessionId: string,
    runId: string,
    sessionKey: string,
  ): string {
    const normalizedSessionKey = this.normalizeSubagentSessionKey(sessionKey);
    if (normalizedSessionKey) return normalizedSessionKey;
    if (this.toolCallIdToParentSessionId.get(runId) === parentSessionId) return runId;
    if (normalizedSessionKey) {
      for (const [toolCallId, mappedSessionKey] of this.toolCallIdToSessionKey.entries()) {
        if (
          this.normalizeSubagentSessionKey(mappedSessionKey) === normalizedSessionKey &&
          this.toolCallIdToParentSessionId.get(toolCallId) === parentSessionId
        ) {
          return normalizedSessionKey;
        }
      }
    }
    return runId;
  }

  private resolveSubagentToolCallIdFromMetadata(
    parentSessionId: string,
    fallbackToolCallId: string,
    metadata: Record<string, unknown> | undefined,
  ): string {
    const sessionKey = typeof metadata?.sessionKey === 'string' ? metadata.sessionKey : '';
    if (sessionKey) {
      const normalizedSessionKey = this.normalizeSubagentSessionKey(sessionKey);
      if (normalizedSessionKey) return normalizedSessionKey;
      for (const [toolCallId, mappedSessionKey] of this.toolCallIdToSessionKey.entries()) {
        if (
          mappedSessionKey === sessionKey &&
          this.toolCallIdToParentSessionId.get(toolCallId) === parentSessionId
        ) {
          return this.normalizeSubagentSessionKey(mappedSessionKey) || mappedSessionKey;
        }
      }
    }

    const taskLabel = typeof metadata?.taskLabel === 'string' ? metadata.taskLabel : '';
    if (taskLabel) {
      for (const [toolCallId, label] of this.toolCallIdToLabel.entries()) {
        if (
          label === taskLabel &&
          this.toolCallIdToParentSessionId.get(toolCallId) === parentSessionId
        ) {
          return this.toolCallIdToSessionKey.get(toolCallId) || toolCallId;
        }
      }
    }

    return fallbackToolCallId;
  }

  private emitSubagentAssistantSnapshot(
    parentSessionId: string,
    runId: string,
    agentId: string,
    content: string,
    isFinal: boolean,
  ): void {
    if (!content || isNoReply(content)) return;
    let stream = this.subagentStreamByRunId.get(runId);
    if (!stream) {
      stream = {
        parentSessionId,
        agentId,
        assistantMessageId: `subagent-stream-${runId}`,
        thinkingMessageId: null,
        thinkingContent: '',
      };
      this.subagentStreamByRunId.set(runId, stream);
      this.subagentStatus.set(agentId, 'running');
      this.emit('subagentMessage', parentSessionId, agentId, {
        id: stream.assistantMessageId,
        type: 'assistant',
        content,
        timestamp: Date.now(),
        metadata: { isStreaming: !isFinal, isFinal },
      });
      return;
    }
    if (!stream.assistantMessageId) {
      stream.assistantMessageId = `subagent-stream-${runId}`;
      this.emit('subagentMessage', parentSessionId, agentId, {
        id: stream.assistantMessageId,
        type: 'assistant',
        content,
        timestamp: Date.now(),
        metadata: { isStreaming: !isFinal, isFinal },
      });
      return;
    }
    this.emit(
      'subagentMessageUpdate',
      parentSessionId,
      agentId,
      stream.assistantMessageId,
      content,
    );
    if (isFinal) {
      this.emit(
        'subagentMessageMetadataUpdate',
        parentSessionId,
        agentId,
        stream.assistantMessageId,
        {
          isStreaming: false,
          isFinal: true,
        },
      );
    }
  }

  private emitSubagentThinkingSnapshot(
    parentSessionId: string,
    runId: string,
    agentId: string,
    data: Record<string, unknown>,
  ): void {
    const stream = this.subagentStreamByRunId.get(runId) ?? {
      parentSessionId,
      agentId,
      assistantMessageId: null,
      thinkingMessageId: `subagent-thinking-${runId}`,
      thinkingContent: '',
    };
    this.subagentStreamByRunId.set(runId, stream);
    this.subagentStatus.set(agentId, 'running');

    const thinkingSnapshot =
      typeof data.thinking === 'string'
        ? data.thinking
        : typeof data.text === 'string'
          ? data.text
          : '';
    const fallbackDelta = typeof data.delta === 'string' ? data.delta : '';
    const nextThinkingContent = thinkingSnapshot || `${stream.thinkingContent}${fallbackDelta}`;
    const thinkingDelta =
      thinkingSnapshot && thinkingSnapshot.startsWith(stream.thinkingContent)
        ? thinkingSnapshot.slice(stream.thinkingContent.length)
        : !thinkingSnapshot && fallbackDelta
          ? fallbackDelta
          : nextThinkingContent;

    if (!nextThinkingContent) return;
    stream.thinkingContent = nextThinkingContent;
    if (!stream.thinkingMessageId) {
      stream.thinkingMessageId = `subagent-thinking-${runId}`;
    }
    if (thinkingDelta === nextThinkingContent) {
      this.emit('subagentMessage', parentSessionId, agentId, {
        id: stream.thinkingMessageId,
        type: 'assistant',
        content: '',
        thinkingContent: nextThinkingContent,
        timestamp: Date.now(),
        metadata: { isStreaming: true, isThinking: true },
      });
    } else if (thinkingDelta) {
      this.emit(
        'subagentThinkingUpdate',
        parentSessionId,
        agentId,
        stream.thinkingMessageId,
        thinkingDelta,
      );
    }
  }

  private finalizeSubagentStream(runId: string): void {
    const stream = this.subagentStreamByRunId.get(runId);
    if (!stream) return;
    if (stream.assistantMessageId) {
      this.emit(
        'subagentMessageMetadataUpdate',
        stream.parentSessionId,
        stream.agentId,
        stream.assistantMessageId,
        { isStreaming: false, isFinal: true },
      );
    }
    if (stream.thinkingMessageId) {
      this.emit(
        'subagentMessageMetadataUpdate',
        stream.parentSessionId,
        stream.agentId,
        stream.thinkingMessageId,
        { isStreaming: false, isThinking: true },
      );
    }
    this.subagentStreamByRunId.delete(runId);
  }

  private updateSubagentFromSpawnResult(
    parentSessionId: string,
    toolCallId: string,
    output: string,
  ): void {
    this.toolCallIdToParentSessionId.set(toolCallId, parentSessionId);
    const parsed = this.parseToolOutputObject(output);
    const status = typeof parsed?.status === 'string' ? parsed.status.toLowerCase() : '';
    const outcome = typeof parsed?.outcome === 'string' ? parsed.outcome.toLowerCase() : '';
    const error = typeof parsed?.error === 'string' ? parsed.error : '';
    const failed =
      Boolean(error) ||
      ['error', 'failed', 'forbidden', 'cancelled'].includes(status) ||
      outcome === 'failed';
    this.subagentStatus.set(toolCallId, failed ? 'failed' : 'running');
    const sessionKey = this.extractSpawnedSessionKey(parsed);
    if (sessionKey) {
      this.toolCallIdToSessionKey.set(toolCallId, sessionKey);
      this.sessionKeyToLabel.set(sessionKey, this.toolCallIdToLabel.get(toolCallId) || toolCallId);
      const normalizedSessionKey = this.normalizeSubagentSessionKey(sessionKey) || sessionKey;
      this.toolCallIdToParentSessionId.set(normalizedSessionKey, parentSessionId);
      this.subagentStatus.set(
        normalizedSessionKey,
        failed ? 'failed' : 'running',
      );
    }
  }

  private updateSubagentStatusFromCompletion(
    toolCallId: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    if (!metadata?.isSubagentCompletion) return;
    const sessionKey = typeof metadata.sessionKey === 'string' ? metadata.sessionKey : '';
    if (sessionKey) {
      this.toolCallIdToSessionKey.set(toolCallId, sessionKey);
      this.sessionKeyToLabel.set(sessionKey, this.toolCallIdToLabel.get(toolCallId) || toolCallId);
    }
    const status = typeof metadata.status === 'string' ? metadata.status.toLowerCase() : '';
    const normalizedStatus: 'done' | 'failed' = ['error', 'failed', 'cancelled'].includes(status)
      ? 'failed'
      : 'done';
    this.subagentStatus.set(toolCallId, normalizedStatus);
    if (sessionKey) {
      this.subagentStatus.set(
        this.normalizeSubagentSessionKey(sessionKey) || sessionKey,
        normalizedStatus,
      );
    }
  }

  private parseToolOutputObject(output: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(output);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private extractSpawnedSessionKey(parsed: Record<string, unknown> | null): string | null {
    if (!parsed) return null;
    const directKeys = ['childSessionKey', 'sessionKey', 'key'];
    for (const key of directKeys) {
      const value = parsed[key];
      if (typeof value === 'string' && value) return value;
    }
    const session = parsed.session;
    if (isRecord(session)) {
      const value = session.key ?? session.sessionKey;
      if (typeof value === 'string' && value) return value;
    }
    return null;
  }

  private formatToolOutput(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isRecord(value)) {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.output === 'string') return value.output;
      if (Array.isArray(value.content)) {
        const parts = value.content
          .filter(
            (b): b is Record<string, unknown> =>
              isRecord(b) && b.type === 'text' && typeof b.text === 'string',
          )
          .map(b => b.text as string);
        if (parts.length > 0) return parts.join('\n');
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  // ─── Approval ───────────────────────────────────────────────────────────

  private handleApprovalRequested(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalRequestedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId || !typedPayload.request || !isRecord(typedPayload.request)) return;

    const request = typedPayload.request;
    const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
    let sessionId = sessionKey
      ? (this.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;

    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
      }
    }
    if (!sessionId) return;

    const command = typeof request.command === 'string' ? request.command : '';
    const isChannelSession = this.channelSessionSync?.isChannelSessionKey(sessionKey) ?? false;

    // Auto-approve for channel sessions and non-delete commands
    if (isChannelSession || !isDeleteCommand(command)) {
      this.pendingApprovals.set(requestId, { requestId, sessionId, allowAlways: true });
      this.respondToPermission(requestId, { behavior: 'allow', updatedInput: {} });
      return;
    }
    if (this.isSessionInStopCooldown(sessionId)) return;

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
    if (requestId) this.pendingApprovals.delete(requestId);
  }

  // ─── Turn Lifecycle Helpers ─────────────────────────────────────────────

  private cleanupSessionTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      if (turn.thinkingMessageId) {
        this.store.updateMessage(sessionId, turn.thinkingMessageId, {
          metadata: { isStreaming: false, isThinking: true },
        });
      }
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.lastMessageUpdateEmitTime.delete(turn.assistantMessageId);
      }
      for (const runId of turn.knownRunIds) {
        this.sessionIdByRunId.delete(runId);
      }
    }
    this.activeTurns.delete(sessionId);
    setCoworkProxySessionId(null);
    this.reCreatedChannelSessionIds.delete(sessionId);
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    if (this.isSessionInStopCooldown(sessionId)) return;
    if (this.pendingSubagentCompletionSessions.has(sessionId)) return;
    if (this.manuallyStoppedSessions.has(sessionId)) {
      this.manuallyStoppedSessions.delete(sessionId);
    }

    const turnRunId = runId || randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const session = this.store.getSession(sessionId);
    const agentId = session?.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    let modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    if (!modelName) {
      const apiResolution = resolveRawApiConfig();
      const configModel = apiResolution.config?.model;
      const providerMetadata = apiResolution.providerMetadata;
      if (configModel) modelName = providerMetadata?.modelName || configModel;
    }

    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId: turnRunId,
      turnToken,
      chatStream: '',
      chatStreamStartedAt: 0,
      toolStreamById: new Map(),
      toolStreamOrder: [],
      chatStreamSegments: [],
      thinkingContent: '',
      thinkingMessageId: null,
      stopRequested: false,
      assistantMessageId: null,
      modelName,
      knownRunIds: runId ? new Set([runId]) : new Set([turnRunId]),
    });
    if (runId) this.sessionIdByRunId.set(runId, sessionId);
    this.store.updateSession(sessionId, { status: 'running' });
    this.startTurnTimeoutWatchdog(sessionId);
  }

  private async resolveActiveTurnConflict(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      this.cleanupSessionTurn(sessionId);
      return;
    }

    const isTerminalStatus =
      session.status === 'completed' || session.status === 'idle' || session.status === 'error';
    if (this.mainAgentLifecycleEnded.has(sessionId) || isTerminalStatus) {
      this.cleanupSessionTurn(sessionId);
      return;
    }

    await new Promise(resolve => setTimeout(resolve, RACE_RESOLUTION_MS));
    if (!this.activeTurns.has(sessionId)) return;
    this.stopSession(sessionId);
  }

  private startTurnTimeoutWatchdog(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    const timeoutMs = this.agentTimeoutSeconds * 1000 + CLIENT_TIMEOUT_GRACE_MS;
    setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turn.turnToken) return;
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'idle' });
      this.mainAgentLifecycleEnded.add(sessionId);
      this.resolveTurn(sessionId);
    }, timeoutMs);
  }

  private isSessionInStopCooldown(sessionId: string): boolean {
    const stoppedAt = this.stoppedSessions.get(sessionId);
    if (stoppedAt === undefined) return false;
    if (Date.now() - stoppedAt < STOP_COOLDOWN_MS) return true;
    this.stoppedSessions.delete(sessionId);
    return false;
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

  private rememberSessionKey(sessionId: string, sessionKey: string): void {
    this.sessionIdBySessionKey.set(sessionKey, sessionId);
  }

  private resolveSessionIdBySessionKey(sessionKey: string): string | null {
    return this.sessionIdBySessionKey.get(sessionKey) ?? null;
  }

  private nextTurnToken(sessionId: string): number {
    const current = this.latestTurnTokenBySession.get(sessionId) ?? 0;
    const next = current + 1;
    this.latestTurnTokenBySession.set(sessionId, next);
    return next;
  }

  private toSessionKey(sessionId: string, agentId?: string): string {
    return buildManagedSessionKey(sessionId, agentId);
  }

  private requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) throw new Error('OpenClaw gateway client is unavailable.');
    return this.gatewayClient;
  }

  // ─── MessageUpdate Throttle ─────────────────────────────────────────────

  private throttledEmitMessageUpdate(sessionId: string, messageId: string, content: string): void {
    const now = Date.now();
    const lastEmit = this.lastMessageUpdateEmitTime.get(messageId) ?? 0;
    const elapsed = now - lastEmit;

    if (elapsed >= MESSAGE_UPDATE_THROTTLE_MS) {
      this.clearPendingMessageUpdate(messageId);
      this.lastMessageUpdateEmitTime.set(messageId, now);
      this.emit('messageUpdate', sessionId, messageId, content);
      return;
    }

    this.clearPendingMessageUpdate(messageId);
    this.pendingMessageUpdateTimer.set(
      messageId,
      setTimeout(() => {
        this.pendingMessageUpdateTimer.delete(messageId);
        this.lastMessageUpdateEmitTime.set(messageId, Date.now());
        this.emit('messageUpdate', sessionId, messageId, content);
      }, MESSAGE_UPDATE_THROTTLE_MS - elapsed),
    );
  }

  private clearPendingMessageUpdate(messageId: string): void {
    const timer = this.pendingMessageUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingMessageUpdateTimer.delete(messageId);
    }
  }

  // ─── Gateway Connection Management ──────────────────────────────────────

  async connectGatewayIfNeeded(): Promise<void> {
    if (this.gatewayClient) return;
    await this.ensureGatewayClientReady();
    void this.discoverChannelSessions();
  }

  async reconnectGateway(): Promise<void> {
    this.stopGatewayClient();
    await this.ensureGatewayClientReady();
    void this.discoverChannelSessions();
  }

  disconnectGatewayClient(): void {
    this.stopGatewayClient();
  }

  private async ensureGatewayClientReady(): Promise<void> {
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
    const engineStatus = await this.engineManager.startGateway();
    if (engineStatus.phase !== 'running') {
      throw new Error(engineStatus.message || 'OpenClaw engine is not running.');
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
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

    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < GATEWAY_CONNECT_RETRY_DELAYS.length; attempt++) {
      this.stopGatewayClient();
      try {
        await this.createGatewayClient(connection);
        if (this.gatewayReadyPromise) {
          await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
        }
        return;
      } catch (error) {
        lastError = error;
        const delay = GATEWAY_CONNECT_RETRY_DELAYS[attempt];
        if (attempt < GATEWAY_CONNECT_RETRY_DELAYS.length - 1) {
          console.warn(
            `[OpenClawRuntime] Gateway client handshake failed; retrying in ${delay}ms:`,
            error,
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const clientEntryPath = connection.clientEntryPath;
    if (!clientEntryPath) throw new Error('Gateway client entry path is not available');
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
        this.gatewayClient = client;
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        settleResolve();
        this.lastTickTimestamp = Date.now();
        this.startTickWatchdog();
      },
      onConnectError: (error: Error) => settleReject(error),
      onClose: (_code: number, reason: string) => {
        const isCurrentClient =
          this.gatewayClient === client || this.pendingGatewayClient === client;
        if (!isCurrentClient || this.intentionallyStoppedGatewayClients.has(client)) {
          return;
        }
        if (!settled) {
          this.pendingGatewayClient = null;
          settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
          if (!this.gatewayStoppingIntentionally) {
            this.scheduleGatewayReconnect();
          }
          return;
        }
        if (this.gatewayStoppingIntentionally) return;

        const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
        for (const sessionId of this.activeTurns.keys()) {
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('error', sessionId, disconnectedError.message);
          this.cleanupSessionTurn(sessionId);
          this.rejectTurn(sessionId, disconnectedError);
        }
        // Connection is already closed — don't call client.stop() which would
        // reject all pending requests with "gateway client stopped" noise.
        // Just clean up internal state and schedule reconnect.
        this.cleanupGatewayClientState();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {});
        this.scheduleGatewayReconnect();
      },
      onEvent: (event: GatewayEventFrame) => this.handleGatewayEvent(event),
    });

    this.pendingGatewayClient = client;
    client.start();
  }

  private stopGatewayClient(): void {
    this.gatewayStoppingIntentionally = true;
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
    if (clientToStop) {
      this.intentionallyStoppedGatewayClients.add(clientToStop);
    }
    try {
      clientToStop?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.channelSessionSync?.clearCache();
    this.knownChannelSessionIds.clear();
    this.heartbeatSessionKeys.clear();
    this.stoppedSessions.clear();
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
    for (const timer of this.pendingMessageUpdateTimer.values()) clearTimeout(timer);
    this.pendingMessageUpdateTimer.clear();
    this.lastMessageUpdateEmitTime.clear();
    this.gatewayStoppingIntentionally = false;
  }

  /** Clean up internal gateway client state without calling client.stop().
   *  Used when the connection is already closed (onClose) — calling stop()
   *  on a closed connection would reject all pending requests with
   *  "gateway client stopped" noise. */
  private cleanupGatewayClientState(): void {
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.channelSessionSync?.clearCache();
    this.knownChannelSessionIds.clear();
    this.heartbeatSessionKeys.clear();
    this.stoppedSessions.clear();
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
    for (const timer of this.pendingMessageUpdateTimer.values()) clearTimeout(timer);
    this.pendingMessageUpdateTimer.clear();
    this.lastMessageUpdateEmitTime.clear();
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    const loaded = require(clientEntryPath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') return direct as GatewayClientCtor;

    for (const candidate of Object.values(loaded)) {
      if (typeof candidate !== 'function') continue;
      const maybeCtor = candidate as {
        name?: string;
        prototype?: { start?: unknown; stop?: unknown; request?: unknown };
      };
      if (maybeCtor.name === 'GatewayClient') return candidate as GatewayClientCtor;
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

    throw new Error(`Invalid OpenClaw gateway client module: ${clientEntryPath}`);
  }

  // ─── Tick Watchdog ──────────────────────────────────────────────────────

  private startTickWatchdog(): void {
    this.stopTickWatchdog();
    this.tickWatchdogTimer = setInterval(() => this.checkTickHealth(), TICK_WATCHDOG_INTERVAL_MS);
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
    if (this.activeTurns.size > 0) {
      this.lastTickTimestamp = now;
      return;
    }
    if (now - this.lastAgentActivityTimestamp <= AGENT_ACTIVITY_ALIVE_WINDOW_MS) {
      this.lastTickTimestamp = now;
      return;
    }
    if (now - this.lastTickTimestamp <= TICK_TIMEOUT_MS) return;
    this.cancelGatewayReconnect();
    this.stopGatewayClient();
    this.gatewayReconnectAttempt = 0;
    this.scheduleGatewayReconnect();
  }

  onSystemResume(): void {
    this.cancelGatewayReconnect();
    this.gatewayReconnectAttempt = 0;
    if (!this.gatewayClient) {
      void this.attemptGatewayReconnect();
    } else {
      this.checkTickHealth();
    }
  }

  // ─── Gateway Reconnect ──────────────────────────────────────────────────

  private cancelGatewayReconnect(): void {
    if (this.gatewayReconnectTimer) {
      clearTimeout(this.gatewayReconnectTimer);
      this.gatewayReconnectTimer = null;
    }
  }

  private scheduleGatewayReconnect(): void {
    if (this.gatewayReconnectAttempt >= GATEWAY_RECONNECT_MAX_ATTEMPTS) return;
    const delays = GATEWAY_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
    this.gatewayReconnectAttempt++;
    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = null;
      void this.attemptGatewayReconnect();
    }, delay);
  }

  private async attemptGatewayReconnect(): Promise<void> {
    try {
      await this.connectGatewayIfNeeded();
      this.gatewayReconnectAttempt = 0;
    } catch {
      this.scheduleGatewayReconnect();
    }
  }

  // ─── Channel Session Discovery (one-shot on gateway connect) ───────────

  private async discoverChannelSessions(): Promise<void> {
    if (!this.gatewayClient || !this.channelSessionSync) return;
    try {
      const result = await this.gatewayClient.request('sessions.list', {
        activeMinutes: 60,
        limit: CHANNEL_SESSION_DISCOVERY_LIMIT,
      });
      const sessions = (result as Record<string, unknown>)?.sessions;
      if (!Array.isArray(sessions)) return;

      let hasNew = false;
      for (const row of sessions) {
        const key = typeof row?.key === 'string' ? row.key : '';
        if (!key) continue;
        if (isRecord(row)) {
          const rowOrigin = (row as Record<string, unknown>).origin;
          if (isRecord(rowOrigin) && (rowOrigin as Record<string, unknown>).label === 'heartbeat') {
            this.heartbeatSessionKeys.add(key);
            continue;
          }
        }
        if (!this.channelSessionSync.isChannelSessionKey(key)) continue;
        if (this.deletedChannelKeys.has(key)) continue;
        if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;

        const sessionId = this.channelSessionSync.resolveOrCreateSession(key);
        if (sessionId && !this.knownChannelSessionIds.has(sessionId)) {
          this.knownChannelSessionIds.add(sessionId);
          this.rememberSessionKey(sessionId, key);
          hasNew = true;
          if (!this.fullySyncedSessions.has(sessionId)) {
            await this.syncFullChannelHistory(sessionId, key);
          }
        }
      }

      if (hasNew) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('cowork:sessions:changed');
        }
      }
    } catch (error) {
      console.error('[ChannelSync] discoverChannelSessions error:', error);
    }
  }

  private async syncFullChannelHistory(sessionId: string, sessionKey: string): Promise<void> {
    if (this.fullySyncedSessions.has(sessionId)) return;
    this.fullySyncedSessions.add(sessionId);
    try {
      await this.historyReconciler.reconcileWithHistory(sessionId, sessionKey, {
        isFullSync: true,
      });
    } catch {
      this.fullySyncedSessions.delete(sessionId);
    }
  }

  private syncChannelUserMessages(
    sessionId: string,
    historyMessages: unknown[],
    latestOnly = false,
    _isDiscord = false,
  ): void {
    // Simplified: delegate to store for user message sync
    const session = this.store.getSession(sessionId);
    if (!session) return;

    for (const message of historyMessages) {
      if (!isRecord(message)) continue;
      const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
      if (role !== 'user') continue;
      const text = extractMessageText(message).trim();
      if (!text) continue;
      const alreadyExists = session.messages.some(
        (m: CoworkMessage) => m.type === 'user' && m.content.trim() === text,
      );
      if (!alreadyExists) {
        const userMessage = this.store.addMessage(sessionId, {
          type: 'user',
          content: text,
          metadata: {},
        });
        this.emit('message', sessionId, userMessage);
      }
      if (latestOnly) break;
    }
  }

  private clearPendingApprovalsBySession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) this.pendingApprovals.delete(requestId);
    }
  }

  // ─── Session Deletion ───────────────────────────────────────────────────

  onSessionDeleted(sessionId: string, agentId?: string): void {
    const removedKeys: string[] = [];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) {
        removedKeys.push(key);
        this.sessionIdBySessionKey.delete(key);
      }
    }
    if (removedKeys.length === 0) {
      const effectiveAgentId = agentId || 'main';
      removedKeys.push(this.toSessionKey(sessionId, effectiveAgentId));
    }

    for (const key of removedKeys) this.deletedChannelKeys.add(key);
    this.knownChannelSessionIds.delete(sessionId);
    this.fullySyncedSessions.delete(sessionId);
    this.channelSyncCursor.delete(sessionId);
    this.reCreatedChannelSessionIds.delete(sessionId);
    this.gatewayHistoryCountBySession.delete(sessionId);
    this.latestTurnTokenBySession.delete(sessionId);
    this.stoppedSessions.delete(sessionId);
    this.cleanupSessionTurn(sessionId);
    this.clearPendingApprovalsBySession(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.channelSessionSync?.onSessionDeleted(sessionId);

    // Delete remote sessions
    this.deleteOpenClawSessionByKeysWithRetry(sessionId, removedKeys).catch(() => {});
  }

  private async deleteOpenClawSessionByKeysWithRetry(
    _sessionId: string,
    sessionKeys: string[],
  ): Promise<void> {
    if (sessionKeys.length === 0) return;
    const maxWaitMs = 5000;
    const startTime = Date.now();
    while (!this.gatewayClient && Date.now() - startTime < maxWaitMs) {
      try {
        await this.ensureGatewayClientReady();
      } catch {
        // Gateway may still be booting; retry until the short deletion grace window expires.
      }
      if (!this.gatewayClient) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!this.gatewayClient) return;
    try {
      await Promise.allSettled(
        sessionKeys.map(key => this.deleteSessionTree(this.gatewayClient!, key)),
      );
    } catch {
      // Best-effort cleanup only; local session deletion has already completed.
    }
  }

  private async deleteSessionTree(client: GatewayClientLike, sessionKey: string): Promise<void> {
    try {
      const listResult = await client.request<{ sessions?: Array<{ key: string }> }>(
        'sessions.list',
        { spawnedBy: sessionKey, limit: 100 },
      );
      for (const child of listResult.sessions ?? [])
        await this.deleteSessionTree(client, child.key);
      if (!sessionKey.endsWith(':main')) {
        await client.request('sessions.delete', { key: sessionKey, deleteTranscript: true });
      }
    } catch {
      // Keep recursive cleanup best-effort so a missing child transcript does not abort siblings.
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  getGatewayClient(): GatewayClientLike | null {
    return this.gatewayClient;
  }

  getSessionKeysForSession(sessionId: string): string[] {
    const keys: string[] = [];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) keys.push(key);
    }
    const session = this.store.getSession(sessionId);
    const managedKey = this.toSessionKey(sessionId, session?.agentId);
    if (!keys.includes(managedKey)) keys.push(managedKey);
    return keys;
  }

  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }

  async getSubagentStatuses(sessionId?: string): Promise<{
    statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'>;
    displayLabels: Record<string, string>;
    sessionKeys: Record<string, string>;
    subagents: Array<{
      id: string;
      sessionKey: string;
      label: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    }>;
  }> {
    const statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'> = {};
    const displayLabels: Record<string, string> = {};
    const sessionKeys: Record<string, string> = {};
    const subagents: Array<{
      id: string;
      sessionKey: string;
      label: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    }> = [];

    if (sessionId) {
      const gatewaySubagents = await this.listSubagentsFromGateway(sessionId);
      if (gatewaySubagents.length > 0) {
        for (const subagent of gatewaySubagents) {
          statuses[subagent.id] = subagent.status;
          displayLabels[subagent.id] = subagent.label;
          sessionKeys[subagent.id] = subagent.sessionKey;
        }
        return { statuses, displayLabels, sessionKeys, subagents: gatewaySubagents };
      }
    }

    for (const [toolCallId, status] of this.subagentStatus.entries()) {
      const parentSessionId = this.toolCallIdToParentSessionId.get(toolCallId);
      if (sessionId && parentSessionId !== sessionId) continue;
      const mappedSessionKey = this.toolCallIdToSessionKey.get(toolCallId);
      const normalizedMappedSessionKey = mappedSessionKey
        ? this.normalizeSubagentSessionKey(mappedSessionKey)
        : '';
      if (normalizedMappedSessionKey && this.subagentStatus.has(normalizedMappedSessionKey)) {
        continue;
      }
      statuses[toolCallId] = status;
      const label = this.toolCallIdToLabel.get(toolCallId) || this.sessionKeyToLabel.get(toolCallId);
      if (label) displayLabels[toolCallId] = label;
      const sessionKey = this.toolCallIdToSessionKey.get(toolCallId) || this.normalizeSubagentSessionKey(toolCallId);
      if (sessionKey) sessionKeys[toolCallId] = sessionKey;
      subagents.push({
        id: sessionKey || toolCallId,
        sessionKey: sessionKey || '',
        label: label || sessionKey || toolCallId,
        status,
      });
    }

    return { statuses, displayLabels, sessionKeys, subagents };
  }

  private async listSubagentsFromGateway(sessionId: string): Promise<
    Array<{
      id: string;
      sessionKey: string;
      label: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    }>
  > {
    const cached = this.subagentGatewayStatusCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.subagents;
    }

    try {
      await this.ensureGatewayClientReady();
    } catch {
      return [];
    }
    const client = this.gatewayClient;
    if (!client) return [];

    const parentKeys = this.getSessionKeysForSession(sessionId);
    const byKey = new Map<
      string,
      {
        id: string;
        sessionKey: string;
        label: string;
        status: 'pending' | 'running' | 'done' | 'failed';
      }
    >();

    for (const parentKey of parentKeys) {
      try {
        const result = await client.request<{
          sessions?: Array<Record<string, unknown>>;
        }>('sessions.list', {
          spawnedBy: parentKey,
          limit: 100,
          includeLastMessage: true,
        });

        for (const row of result.sessions ?? []) {
          const sessionKey = typeof row.key === 'string' ? row.key : '';
          if (!sessionKey) continue;
          const gatewayLabel =
            (typeof row.label === 'string' && row.label.trim()) ||
            (typeof row.displayName === 'string' && row.displayName.trim()) ||
            '';
          const label = this.getSubagentDisplayLabel(sessionId, sessionKey, gatewayLabel);
          byKey.set(sessionKey, {
            id: sessionKey,
            sessionKey,
            label,
            status: this.normalizeGatewaySubagentStatus(row),
          });
        }
      } catch (error) {
        console.warn('[OpenClawRuntime] sessions.list for subagents failed:', error);
      }
    }

    const subagents = Array.from(byKey.values());
    if (subagents.length > 0) {
      this.subagentGatewayStatusCache.set(sessionId, {
        expiresAt: Date.now() + SUBAGENT_STATUS_CACHE_TTL_MS,
        subagents,
      });
    }
    return subagents;
  }

  private getSubagentDisplayLabel(
    parentSessionId: string,
    sessionKey: string,
    fallbackLabel?: string,
  ): string {
    const mappedLabel = this.sessionKeyToLabel.get(sessionKey);
    if (mappedLabel && !this.isOpaqueSubagentLabel(mappedLabel)) return mappedLabel;

    const parentSession = this.store.getSession(parentSessionId);
    const spawnToolUses =
      parentSession?.messages.filter(
        message => message.type === 'tool_use' && message.metadata?.toolName === 'sessions_spawn',
      ) ?? [];

    for (const toolUse of spawnToolUses) {
      const toolUseId = typeof toolUse.metadata?.toolUseId === 'string' ? toolUse.metadata.toolUseId : '';
      const mappedSessionKey = toolUseId ? this.toolCallIdToSessionKey.get(toolUseId) : '';
      if (
        mappedSessionKey &&
        this.normalizeSubagentSessionKey(mappedSessionKey) ===
          this.normalizeSubagentSessionKey(sessionKey)
      ) {
        const label = this.getSubagentDisplayLabelFromToolInput(toolUse.metadata?.toolInput);
        if (label) return label;
      }
    }

    for (const toolUse of spawnToolUses) {
      const toolUseId = typeof toolUse.metadata?.toolUseId === 'string' ? toolUse.metadata.toolUseId : '';
      if (!toolUseId) continue;
      const toolResult = parentSession?.messages.find(
        message =>
          message.type === 'tool_result' &&
          message.metadata?.toolName === 'sessions_spawn' &&
          message.metadata?.toolUseId === toolUseId,
      );
      const parsed =
        typeof toolResult?.content === 'string' ? this.parseToolOutputObject(toolResult.content) : null;
      const spawnedSessionKey = this.extractSpawnedSessionKey(parsed);
      if (
        spawnedSessionKey &&
        this.normalizeSubagentSessionKey(spawnedSessionKey) ===
          this.normalizeSubagentSessionKey(sessionKey)
      ) {
        const label = this.getSubagentDisplayLabelFromToolInput(toolUse.metadata?.toolInput);
        if (label) return label;
      }
    }

    if (fallbackLabel && !this.isOpaqueSubagentLabel(fallbackLabel)) return fallbackLabel;
    return sessionKey.split(':').pop() || sessionKey;
  }

  private getSubagentDisplayLabelFromToolInput(input: unknown): string {
    if (!isRecord(input)) return '';
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (label && !this.isOpaqueSubagentLabel(label)) return label;
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (task) return this.truncateSubagentTaskLabel(task);
    return '';
  }

  private truncateSubagentTaskLabel(task: string): string {
    const normalized = task.replace(/\s+/g, ' ').trim();
    return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized;
  }

  private isOpaqueSubagentLabel(label: string): boolean {
    const value = label.trim();
    if (!value) return true;
    if (value.includes(':subagent:')) return true;
    if (/^webchat:g-agent-main-subagent-[0-9a-f-]{36}$/i.test(value)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return true;
    }
    return false;
  }

  private normalizeGatewaySubagentStatus(
    row: Record<string, unknown>,
  ): 'pending' | 'running' | 'done' | 'failed' {
    const status = typeof row.status === 'string' ? row.status.toLowerCase() : '';
    const runState = typeof row.subagentRunState === 'string' ? row.subagentRunState.toLowerCase() : '';
    const active = row.hasActiveSubagentRun === true;
    const endedAt =
      (typeof row.endedAt === 'number' && Number.isFinite(row.endedAt)) ||
      (typeof row.endedAt === 'string' && row.endedAt.trim() !== '');
    const startedAt =
      (typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)) ||
      (typeof row.startedAt === 'string' && row.startedAt.trim() !== '');

    if (active || status === 'running' || runState === 'active') return 'running';
    if (
      endedAt &&
      ['failed', 'error', 'killed', 'timeout', 'timed_out', 'cancelled'].includes(status)
    ) {
      return 'failed';
    }
    if (
      endedAt ||
      ['done', 'ok', 'completed', 'complete'].includes(status) ||
      runState === 'historical'
    ) {
      return 'done';
    }
    return startedAt ? 'running' : 'pending';
  }

  async getSubTaskHistory(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ): Promise<CoworkMessage[]> {
    return this.subtaskHistory.getSubTaskHistory(parentSessionId, agentId, sessionKey);
  }

  async getSubagentErrorInfo(
    parentSessionId: string,
    agentId: string,
    _sessionKey?: string,
  ): Promise<{
    state?: string;
    status?: string;
    outcome?: string;
    endedAt?: number;
    errorMessage?: string;
    lastMessage?: string;
  } | null> {
    // Check tool_result in parent session
    const parentSession = this.store.getSession(parentSessionId);
    if (parentSession?.messages) {
      for (const msg of parentSession.messages) {
        if (
          msg.type === 'tool_result' &&
          msg.metadata?.toolName === 'sessions_spawn' &&
          msg.metadata?.toolUseId === agentId
        ) {
          const toolResult = msg.metadata?.toolResult;
          if (isRecord(toolResult)) {
            const status = typeof toolResult.status === 'string' ? toolResult.status : '';
            const error = typeof toolResult.error === 'string' ? toolResult.error : '';
            if (status === 'forbidden' || status === 'error' || status === 'failed' || error) {
              return { status, errorMessage: error || `Spawn failed with status: ${status}` };
            }
          }
          if (msg.metadata?.isError) {
            return {
              errorMessage:
                typeof msg.content === 'string' ? msg.content.slice(0, 500) : 'Tool call failed',
            };
          }
        }
      }
    }
    return null;
  }

  async fetchSessionByKey(sessionKey: string): Promise<CoworkSession | null> {
    if (sessionKey.startsWith('managed:')) {
      const parts = sessionKey.split(':');
      if (parts.length >= 2) {
        const session = this.store.getSession(parts[1]);
        if (session) return session;
      }
    }

    if (this.channelSessionSync) {
      const existingId = this.channelSessionSync.resolveSession(sessionKey);
      if (existingId) {
        const session = this.store.getSession(existingId);
        if (session && session.messages.length > 0) return session;
      }
    }

    const client = this.gatewayClient;
    if (!client) return null;
    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: FULL_HISTORY_SYNC_LIMIT,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) return null;

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
    } catch {
      return null;
    }
  }

  // ─── Skill RPC Delegates ────────────────────────────────────────────────

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

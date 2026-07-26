import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';

import { type CoworkAttachmentPayload, toGatewayAttachment } from '../../../shared/cowork/attachments';
import {
  normalizeAgentEvent,
  normalizeChatEvent,
  type NormalizedAgentEvent,
} from '../../../shared/openclaw/agentEvent';
import {
  classifyAgentEvent,
  classifyChatEvent,
  normalizeMessageSessionKey,
  normalizeToolEvent,
} from '../../../shared/openclaw/messageDomain';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  hasSlashCommandBeforeSendHook,
  SlashCommandBeforeSendHook,
} from '../../../shared/slashCommands';
import { coworkLog } from '../../cowork/coworkLogger';
import { resolveRawApiConfig } from '../../cowork/providerApiConfig';
import {
  type SessionTitleFetch,
  SessionTitleGenerator,
} from '../../cowork/sessionTitleGenerator';
import type {
  CoworkExecutionMode,
  CoworkMessage,
  CoworkSession,
  CoworkSessionStatus,
  CoworkStore,
} from '../../data/coworkStore';
import { OPENCLAW_AGENT_TIMEOUT_SECONDS } from '../../openclaw/config/openclawConfigSync';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../../openclaw/runtime/openclawEngineManager';
import {
  buildManagedSessionKey,
  type OpenClawChannelSessionSync,
} from '../../openclaw/sessions/openclawChannelSessionSync';
import { extractGatewayHistoryEntries } from '../../openclaw/sessions/openclawHistory';
import {
  CHANNEL_SESSION_DISCOVERY_LIMIT,
  extractMessageText,
  GATEWAY_READY_TIMEOUT_MS,
  isRecord,
  OPENCLAW_GATEWAY_TOOL_EVENTS_CAP,
  waitWithTimeout,
} from '../gateway/helpers';
import { SessionRpc } from '../gateway/sessionRpc';
import type {
  GatewayClientCtor,
  GatewayClientLike,
  GatewayEventFrame,
  SessionTurn,
  ToolStreamEntry,
} from '../gateway/types';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  CoworkStopOptions,
} from '../types';
import { HistoryReconciler } from './historyReconciler';
import {
  type GatewaySubagent,
  listGatewaySubagents,
  SUBAGENT_STATUSES,
  type SubagentStatus,
} from './subagentGateway';
import {
  resetWebchatToolStream,
  syncWebchatToolStreamMessages,
} from './webchatToolStream';

// ─── Constants ──────────────────────────────────────────────────────────────

const NO_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const STOP_COOLDOWN_MS = 10_000;
const RACE_RESOLUTION_MS = 1_000;
const FULL_HISTORY_SYNC_LIMIT = 1000;
const TICK_WATCHDOG_INTERVAL_MS = 60_000;
const TICK_TIMEOUT_MS = 90_000;
const AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000;
const MESSAGE_UPDATE_THROTTLE_MS = 200;
const CLIENT_TIMEOUT_GRACE_MS = 30_000;
const GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
const GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000];
const GATEWAY_CONNECT_RETRY_DELAYS = [500, 1_500, 3_000];
const SUBAGENT_STATUS_CACHE_TTL_MS = 8_000;
const RUNTIME_SESSION_SNAPSHOT_TTL_MS = 2_000;
const LIFECYCLE_END_FALLBACK_MS = 1_500;
const ERROR_TERMINAL_SESSION_STATUSES = new Set([
  'aborted',
  'cancelled',
  'error',
  'failed',
  'killed',
  'timed_out',
  'timeout',
]);

type SessionAbortResponse = {
  ok?: boolean;
  abortedRunId?: string | null;
  status?: 'aborted' | 'no-active-run';
};
const RUNTIME_STATUS_WARNING_INTERVAL_MS = 30_000;

// ─── Utilities ──────────────────────────────────────────────────────────────

const isNoReply = (text: string): boolean => NO_REPLY_PATTERN.test(text);

export const ensureSlashCommandSession = async (
  client: GatewayClientLike,
  sessionKey: string,
  prompt: string,
): Promise<string | undefined> => {
  if (
    !hasSlashCommandBeforeSendHook(prompt, SlashCommandBeforeSendHook.EnsureSessionEntry)
  ) {
    return undefined;
  }

  const created = await client.request<{
    sessionId?: string;
    entry?: { sessionId?: string };
  }>('sessions.create', { key: sessionKey });
  const sessionId = created?.sessionId ?? created?.entry?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('OpenClaw sessions.create returned no sessionId');
  }
  return sessionId.trim();
};

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

type VisibleRunStreamState = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  assistantMessageId: string | null;
  assistantText: string;
  committedAssistantSegments: string[];
  thinkingMessageId: string | null;
  thinkingContent: string;
  toolStreamById: Map<string, ToolStreamEntry>;
  modelName: string;
};

type PendingSessionModelPatch = {
  model: string;
  agentId?: string;
};

type SessionRuntimeStatus = {
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
};

type RuntimeSessionSnapshot = {
  known: boolean;
  sessions: Array<Record<string, unknown>>;
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
  private readonly pendingSessionModelPatches = new Map<string, PendingSessionModelPatch>();
  private readonly visibleRunStreams = new Map<string, VisibleRunStreamState>();
  private readonly terminalLifecycleSessionIds = new Set<string>();
  private readonly recentTerminalRunIds = new Map<string, number>();
  private readonly compactionInFlightSessionIds = new Set<string>();
  private readonly lifecycleEndFallbackTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // Gateway connection
  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  private pendingGatewayClient: GatewayClientLike | null = null;
  private readonly intentionallyStoppedGatewayClients = new WeakSet<object>();
  private gatewayReadyPromise: Promise<void> | null = null;
  private gatewayClientInitLock: Promise<void> | null = null;
  private gatewayClientGeneration = 0;
  private gatewayStoppingIntentionally = false;
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;

  // Tick watchdog
  private lastTickTimestamp = 0;
  private lastAgentActivityTimestamp = 0;
  private legacyAgentSequence = 0;
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
  private readonly pendingSessionMessageReloadSessionIds = new Set<string>();
  private readonly subagentStatusCache = new Map<
    string,
    {
      expiresAt: number;
      subagents: GatewaySubagent[];
    }
  >();
  private runtimeSessionSnapshot: (RuntimeSessionSnapshot & { expiresAt: number }) | null = null;
  private runtimeSessionSnapshotPromise: Promise<RuntimeSessionSnapshot> | null = null;
  private lastRuntimeStatusWarningAt = 0;

  // Collaborators
  private historyReconciler!: HistoryReconciler;
  private sessionRpc!: SessionRpc;
  private titleGenerator!: SessionTitleGenerator;

  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;

  constructor(
    store: CoworkStore,
    engineManager: OpenClawEngineManager,
    titleFetch?: SessionTitleFetch,
  ) {
    super();
    this.store = store;
    this.engineManager = engineManager;

    this.historyReconciler = new HistoryReconciler({
      getSession: (id: string) => this.store.getSession(id),
      addMessage: (id: string, msg: Parameters<CoworkStore['addMessage']>[1]) =>
        this.store.addMessage(id, msg),
      updateMessage: (
        id: string,
        msgId: string,
        patch: Parameters<CoworkStore['updateMessage']>[2],
      ) => this.store.updateMessage(id, msgId, patch),
      deleteMessage: (id: string, msgId: string) => this.store.deleteMessage(id, msgId),
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

    this.titleGenerator = new SessionTitleGenerator({
      resolveApiConfig: () => resolveRawApiConfig(),
      fetch: titleFetch,
    });
    this.sessionRpc = new SessionRpc({
      getGatewayClient: () => this.gatewayClient,
      store: this.store,
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
      attachments: options.attachments,
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
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
      attachments: options.attachments,
    });
  }

  async stopSession(sessionId: string, options: CoworkStopOptions = {}): Promise<void> {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
    }
    this.manuallyStoppedSessions.add(sessionId);

    try {
      await this.abortSessionAndSubagents(sessionId, turn);
    } catch (error) {
      if (turn && this.activeTurns.get(sessionId) === turn) {
        turn.stopRequested = false;
      }
      this.manuallyStoppedSessions.delete(sessionId);
      if (!options.bestEffort) throw error;
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to confirm session stop', {
        error: String(error),
        sessionId,
      });
    }

    this.stoppedSessions.set(sessionId, Date.now());
    this.terminalLifecycleSessionIds.delete(sessionId);
    this.cleanupSessionTurn(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  async stopAllSessions(): Promise<void> {
    const sessionIds = [...this.activeTurns.keys()];
    await Promise.all(
      sessionIds.map(sessionId => this.stopSession(sessionId, { bestEffort: true })),
    );
  }

  private async abortSessionAndSubagents(
    sessionId: string,
    turn?: SessionTurn,
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      if (!turn && !this.store.getSession(sessionId)) return;
      throw new Error('OpenClaw Gateway is not connected; the session stop was not confirmed.');
    }

    const parentKeys = [...new Set([
      ...(turn ? [turn.sessionKey] : []),
      ...this.getSessionKeysForSession(sessionId),
    ])];
    let subagentKeys: string[] = [];
    let subagentDiscoveryError: unknown;
    try {
      subagentKeys = await this.collectRunningSubagentSessionKeys(client, parentKeys);
    } catch (error) {
      subagentDiscoveryError = error;
    }
    const abortTargets: Array<{ key: string; runId?: string }> = [
      ...(turn ? [{ key: turn.sessionKey, runId: turn.runId }] : parentKeys.map(key => ({ key }))),
      ...subagentKeys.map(key => ({ key })),
    ];
    const uniqueTargets = [
      ...new Map(abortTargets.map(target => [`${target.key}\0${target.runId ?? ''}`, target])).values(),
    ];
    const results = await Promise.allSettled(
      uniqueTargets.map(async target => {
        const response = await client.request<SessionAbortResponse>('sessions.abort', target);
        if (
          response.ok !== true ||
          (response.status !== 'aborted' && response.status !== 'no-active-run')
        ) {
          throw new Error(`Gateway did not confirm abort for session ${target.key}.`);
        }
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
    if (subagentDiscoveryError) throw subagentDiscoveryError;
    this.subagentStatusCache.delete(sessionId);
  }

  private async collectRunningSubagentSessionKeys(
    client: GatewayClientLike,
    parentKeys: string[],
  ): Promise<string[]> {
    const pendingParentKeys = [...parentKeys];
    const visitedParentKeys = new Set<string>();
    const runningKeys = new Set<string>();

    while (pendingParentKeys.length > 0) {
      const parentKey = pendingParentKeys.shift();
      if (!parentKey || visitedParentKeys.has(parentKey)) continue;
      visitedParentKeys.add(parentKey);
      const subagents = await listGatewaySubagents({
        client,
        parentKeys: [parentKey],
        includePersistedHistory: false,
        includeStructuredTool: false,
      });
      for (const subagent of subagents) {
        if (subagent.status !== SUBAGENT_STATUSES.RUNNING) continue;
        if (!runningKeys.has(subagent.sessionKey)) {
          runningKeys.add(subagent.sessionKey);
          pendingParentKeys.push(subagent.sessionKey);
        }
      }
    }

    return [...runningKeys];
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
      attachments?: CoworkAttachmentPayload[];
      agentId?: string;
      workspaceRoot?: string;
    },
  ): Promise<void> {
    if (!prompt.trim()) {
      throw new Error('Prompt is required.');
    }

    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
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
        options.skillIds?.length || options.attachments?.length
          ? {
              ...(options.skillIds?.length ? { skillIds: options.skillIds } : {}),
              ...(options.attachments?.length ? { attachments: options.attachments } : {}),
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
    await this.ensureGatewayClientReady();
    try {
      await this.syncAgentWorkspaceIfNeeded(agentId, options.workspaceRoot);
    } catch (error) {
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      throw error;
    }

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
      gatewaySessionId: null,
      lifecycleGeneration: null,
      lastAgentSeq: -1,
      status: 'running',
      turnToken,
      chatStream: '',
      agentAssistantStreamSeen: false,
      committedAssistantSegments: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      chatToolMessages: [],
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
      const attachments = options.attachments?.length
        ? options.attachments.map(toGatewayAttachment)
        : undefined;
      const commandSessionId = await ensureSlashCommandSession(client, sessionKey, prompt);
      await client.request('chat.send', {
        sessionKey,
        ...(commandSessionId ? { sessionId: commandSessionId } : {}),
        message: prompt.trim(),
        deliver: false,
        timeoutMs: this.agentTimeoutSeconds * 1000,
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

  private async syncAgentWorkspaceIfNeeded(agentId: string, workspaceRoot?: string): Promise<void> {
    const workspace = workspaceRoot?.trim();
    if (!workspace) return;
    const client = this.requireGatewayClient();
    try {
      await client.request('agents.update', {
        agentId,
        workspace,
      });
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to sync agent workspace before chat turn', {
        agentId,
        workspace,
        error: String(error),
      });
      throw error;
    }
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
      this.handleAgentEvent('agent', event.payload, event.seq);
      return;
    }

    if (event.event === 'session.tool') {
      this.lastAgentActivityTimestamp = Date.now();
      this.handleAgentEvent('session.tool', event.payload, event.seq);
      return;
    }

    if (event.event === 'session.message') {
      this.handleSessionMessageEvent(event.payload);
      return;
    }

    if (event.event === 'session.operation') {
      this.handleSessionOperationEvent(event.payload);
      return;
    }

    if (event.event === 'sessions.changed') {
      this.handleSessionsChangedEvent(event.payload);
      return;
    }
  }

  // ─── Chat Event Handling (aligned with webchat) ─────────────────────────

  private handleChatEvent(payload: unknown, frameSeq?: number): void {
    const p = normalizeChatEvent({ payload, frameSeq });
    if (!p) return;
    const sessionKey = p.sessionKey;
    const runId = p.runId ?? '';
    const state = p.state;

    // Resolve sessionId from runId or sessionKey
    let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (sessionId && runId && !this.isAnnounceRunId(runId)) {
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
    if (!turn) {
      if (state === 'final' && (!runId || !this.isRecentTerminalRun(runId))) {
        this.appendExternalFinalAssistantMessage(
          sessionId,
          this.resolveSessionModelName(sessionId),
          p.message,
        );
      }
      return;
    }

    const admission = classifyChatEvent({
      selected: { sessionKey: turn.sessionKey, sessionId: turn.gatewaySessionId },
      activeRun: turn,
      event: p,
    });
    if (admission === 'ignored-session') return;

    if (runId && turn.runId !== runId && this.isAnnounceRunId(runId)) {
      // OpenClaw webchat ignores deltas from non-active announce runs and only
      // appends their final assistant payload once.
      if (state === 'final' || state === 'aborted' || state === 'error') {
        if (state === 'final') {
          const stream = this.visibleRunStreams.get(runId);
          if (stream) {
            const text = extractAssistantText(p.message);
            this.handleVisibleRunAssistantSnapshot(
              sessionId,
              sessionKey,
              runId,
              turn.modelName,
              text,
              true,
            );
          } else if (!turn.knownRunIds.has(runId)) {
            this.appendExternalFinalAssistantMessage(
              sessionId,
              turn.modelName,
              p.message,
              sessionKey,
            );
          }
        }
        turn.knownRunIds.add(runId);
      }
      return;
    }

    if (turn.runId && !runId) {
      if (state === 'final') {
        if (
          turn.agentAssistantStreamSeen &&
          this.mergeUnscopedFinalIntoActiveAssistant(sessionId, turn, p.message)
        ) {
          return;
        }
        this.appendExternalFinalAssistantMessage(sessionId, turn.modelName, p.message, sessionKey);
      }
      return;
    }

    if (admission === 'ignored-run') return;
    if (admission === 'bind-provisional-run' && runId) {
      this.sessionIdByRunId.delete(turn.runId);
      turn.runId = runId;
      turn.knownRunIds.add(runId);
      this.sessionIdByRunId.set(runId, sessionId);
    }
    if (!turn.gatewaySessionId && p.sessionId) turn.gatewaySessionId = p.sessionId;
    if (!turn.lifecycleGeneration && p.lifecycleGeneration) {
      turn.lifecycleGeneration = p.lifecycleGeneration;
    }

    // Terminal event helper (aligned with webchat reconcileTerminalRun)
    const reconcileTerminalRun = (sessionStatus: 'idle' | 'completed' | 'error') => {
      const hadToolStream = turn.toolStreamOrder.length > 0;
      this.rememberTerminalRun(turn.runId);
      this.cleanupSessionTurn(sessionId!);
      this.store.updateSession(sessionId!, { status: sessionStatus });
      this.terminalLifecycleSessionIds.add(sessionId!);
      this.resolveTurn(sessionId!);
      this.replayDeferredSessionMessageReload(sessionId!);
      // Notify renderer of turn completion
      this.emit('complete', sessionId!, sessionStatus);
      // OpenClaw Gateway history is authoritative; local messages are only a UI cache.
      if (sessionKey) {
        void this.historyReconciler
          .reconcileWithHistory(sessionId!, sessionKey)
          .finally(() => {
            if (hadToolStream) {
              resetWebchatToolStream(turn);
            }
          })
          .catch(() => {});
      }
    };

    if (state === 'delta') {
      if (turn.agentAssistantStreamSeen && (!runId || runId === turn.runId)) {
        return;
      }
      const rawText = extractAssistantText(p.message);
      const text = this.prepareAssistantSnapshot(turn, rawText);
      if (text && !isNoReply(text)) {
        turn.chatStream = text; // Full replacement (webchat pattern)
        // Emit streaming update
        if (turn.assistantMessageId) {
          this.throttledEmitMessageUpdate(sessionId, turn.assistantMessageId, text);
        } else if (
          this.promoteThinkingSegmentToAssistantMessage(sessionId, turn, text, {
            isStreaming: true,
            isFinal: false,
            isThinking: false,
            modelName: turn.modelName,
          })
        ) {
          // The thinking-only row is now the live assistant row.
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
      const rawText = extractAssistantText(p.message);
      const text =
        turn.agentAssistantStreamSeen && (!runId || runId === turn.runId)
          ? turn.chatStream
          : this.prepareAssistantSnapshot(turn, rawText);
      const finalText = text || turn.chatStream;
      if (finalText && !isNoReply(finalText)) {
        if (turn.assistantMessageId) {
          // Finalize existing streaming message
          this.clearPendingMessageUpdate(turn.assistantMessageId);
          this.store.updateMessage(sessionId, turn.assistantMessageId, {
            content: finalText,
            metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
          });
          this.emit('messageUpdate', sessionId, turn.assistantMessageId, finalText);
        } else if (
          this.promoteThinkingSegmentToAssistantMessage(sessionId, turn, finalText, {
            isStreaming: false,
            isFinal: true,
            isThinking: false,
            modelName: turn.modelName,
          })
        ) {
          // The thinking-only row is now the finalized assistant row.
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
      const rawText = extractAssistantText(p.message);
      const text = this.prepareAssistantSnapshot(turn, rawText) || turn.chatStream;
      if (text && !isNoReply(text)) {
        if (turn.assistantMessageId) {
          this.clearPendingMessageUpdate(turn.assistantMessageId);
          this.store.updateMessage(sessionId, turn.assistantMessageId, {
            content: text,
            metadata: { isStreaming: false, isFinal: true, modelName: turn.modelName },
          });
          this.emit('messageUpdate', sessionId, turn.assistantMessageId, text);
        } else if (
          this.promoteThinkingSegmentToAssistantMessage(sessionId, turn, text, {
            isStreaming: false,
            isFinal: true,
            isThinking: false,
            modelName: turn.modelName,
          })
        ) {
          // The thinking-only row is now the aborted assistant row.
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

  private handleAgentEvent(
    deliveryEvent: 'agent' | 'session.tool',
    payload: unknown,
    frameSeq?: number,
  ): void {
    let normalized = normalizeAgentEvent({ deliveryEvent, payload, frameSeq });
    if (normalized.reason === 'missing-sequence' && isRecord(payload)) {
      // Older Gateway builds omitted the inner agent seq. Preserve compatibility
      // while still routing the event through the canonical normalizer.
      normalized = normalizeAgentEvent({
        deliveryEvent,
        payload: {
          ...payload,
          seq: frameSeq ?? ++this.legacyAgentSequence,
        },
        frameSeq,
      });
    }
    const p = normalized.event;
    if (!p) return;
    const runId = p.runId;
    const sessionKey = p.sessionKey ?? '';
    const stream = p.stream;

    // Resolve sessionId
    let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    }
    if (!sessionId) return;

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      if (runId && this.isAnnounceRunId(runId)) {
        this.handleDetachedVisibleRunAgentEvent(sessionId, sessionKey, runId, stream, p.data);
        return;
      }
      return;
    }

    if (runId && turn.runId !== runId && this.isAnnounceRunId(runId)) {
      const data = p.data;
      if (stream === 'thinking') {
        this.handleVisibleRunThinkingSnapshot(sessionId, sessionKey, runId, turn.modelName, data);
      } else if (stream === 'assistant') {
        const text = typeof data.text === 'string' ? data.text : '';
        this.handleVisibleRunAssistantSnapshot(
          sessionId,
          sessionKey,
          runId,
          turn.modelName,
          text,
          false,
        );
      } else if (stream === 'tool') {
        this.handleVisibleRunToolEvent(sessionId, sessionKey, runId, turn.modelName, data);
      } else if (stream === 'item' || stream === 'command_output') {
        this.handleVisibleRunToolItemEvent(sessionId, sessionKey, runId, turn.modelName, data);
      } else if (stream === 'lifecycle') {
        const phase = typeof data.phase === 'string' ? data.phase : '';
        if (phase === 'end' || phase === 'error') {
          this.finalizeVisibleRun(runId);
          turn.knownRunIds.add(runId);
        }
      }
      return;
    }

    const admission = this.classifyMainAgentEvent(turn, p);
    if (
      admission === 'ignored-session' ||
      admission === 'ignored-run' ||
      admission === 'ignored-sequence' ||
      admission === 'ignored-terminal'
    ) {
      return;
    }
    if (admission === 'bind-provisional-run') {
      this.sessionIdByRunId.delete(turn.runId);
      turn.runId = runId;
    }
    if (!turn.gatewaySessionId && p.sessionId) turn.gatewaySessionId = p.sessionId;
    if (!turn.lifecycleGeneration && p.lifecycleGeneration) {
      turn.lifecycleGeneration = p.lifecycleGeneration;
    }
    turn.lastAgentSeq = p.agentSeq;
    turn.knownRunIds.add(runId);
    this.sessionIdByRunId.set(runId, sessionId);

    const data = p.data;

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
      turn.agentAssistantStreamSeen = true;
      const rawText = typeof data.text === 'string' ? data.text : '';
      const text = this.prepareAssistantSnapshot(turn, rawText);
      if (text && !isNoReply(text)) {
        turn.chatStream = text;
        if (turn.assistantMessageId) {
          this.throttledEmitMessageUpdate(sessionId, turn.assistantMessageId, text);
        } else if (
          this.promoteThinkingSegmentToAssistantMessage(sessionId, turn, text, {
            isStreaming: true,
            isFinal: false,
            isThinking: false,
            modelName: turn.modelName,
          })
        ) {
          // The thinking-only row is now the live assistant row.
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

    if (stream === 'item' || stream === 'command_output') {
      this.handleToolItemEvent(sessionId, turn, data);
      return;
    }

    if (stream === 'compaction') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      this.handleCompactionPhase(sessionId, phase, turn);
      return;
    }

    // Lifecycle events
    if (stream === 'lifecycle') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      if (phase === 'end' || phase === 'error') {
        this.terminalLifecycleSessionIds.add(sessionId);
      }
      if (phase === 'end') {
        this.scheduleLifecycleEndFallback(sessionId, turn);
      }
      return;
    }

    // Other item-like streams are currently UI-only in OpenClaw webchat.
    if (stream === 'item') return;
  }

  private handleDetachedVisibleRunAgentEvent(
    sessionId: string,
    sessionKey: string,
    runId: string,
    stream: string,
    data: unknown,
  ): void {
    const eventData = isRecord(data) ? data : {};
    const modelName = this.resolveSessionModelName(sessionId);

    if (stream === 'thinking' || stream === 'assistant') {
      if (stream === 'thinking') {
        this.handleVisibleRunThinkingSnapshot(sessionId, sessionKey, runId, modelName, eventData);
      } else {
        const text = typeof eventData.text === 'string' ? eventData.text : '';
        this.handleVisibleRunAssistantSnapshot(
          sessionId,
          sessionKey,
          runId,
          modelName,
          text,
          false,
        );
      }
      return;
    }

    if (stream === 'tool') {
      this.handleVisibleRunToolEvent(sessionId, sessionKey, runId, modelName, eventData);
      return;
    }

    if (stream === 'item' || stream === 'command_output') {
      this.handleVisibleRunToolItemEvent(sessionId, sessionKey, runId, modelName, eventData);
      return;
    }

    if (stream === 'lifecycle') {
      const phase = typeof eventData.phase === 'string' ? eventData.phase : '';
      if (phase === 'end' || phase === 'error') {
        this.finalizeVisibleRun(runId);
      }
    }
  }

  private handleSessionMessageEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (!sessionKey) return;
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (!sessionId) return;

    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      this.pendingSessionMessageReloadSessionIds.add(sessionId);
      return;
    }

    this.pendingSessionMessageReloadSessionIds.delete(sessionId);
    void this.historyReconciler.reconcileWithHistory(sessionId, sessionKey).catch(() => {});
  }

  private handleSessionOperationEvent(payload: unknown): void {
    if (!isRecord(payload) || payload.operation !== 'compact') return;
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (!sessionKey) return;
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (!sessionId) return;
    const phase = typeof payload.phase === 'string' ? payload.phase : '';
    this.handleCompactionPhase(sessionId, phase, this.activeTurns.get(sessionId));
  }

  private handleCompactionPhase(
    sessionId: string,
    phase: string,
    turn: SessionTurn | undefined,
  ): void {
    if (phase === 'start') {
      this.compactionInFlightSessionIds.add(sessionId);
      const timer = this.lifecycleEndFallbackTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.lifecycleEndFallbackTimers.delete(sessionId);
      }
      return;
    }
    if (phase !== 'end') return;
    this.compactionInFlightSessionIds.delete(sessionId);
    if (turn && this.terminalLifecycleSessionIds.has(sessionId)) {
      this.scheduleLifecycleEndFallback(sessionId, turn);
    }
  }

  private handleSessionsChangedEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const source = isRecord(payload.session) ? payload.session : payload;
    const sessionKey =
      (typeof source.key === 'string' && source.key.trim()) ||
      (typeof payload.sessionKey === 'string' && payload.sessionKey.trim()) ||
      (typeof payload.key === 'string' && payload.key.trim()) ||
      '';
    if (!sessionKey) return;
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (!sessionId) return;

    const turn = this.activeTurns.get(sessionId);
    const hasActiveRun = source.hasActiveRun === true;
    const status = typeof source.status === 'string' ? source.status.trim().toLowerCase() : '';
    const shouldClearRun = Boolean(turn) && !hasActiveRun && status && status !== 'running';
    if (!shouldClearRun) return;

    this.cleanupSessionTurn(sessionId);
    const terminalStatus: CoworkSessionStatus = ERROR_TERMINAL_SESSION_STATUSES.has(status)
      ? 'error'
      : 'idle';
    this.store.updateSession(sessionId, { status: terminalStatus });
    this.resolveTurn(sessionId);
    this.replayDeferredSessionMessageReload(sessionId);
    this.emit('complete', sessionId, terminalStatus);
  }

  private replayDeferredSessionMessageReload(sessionId: string): void {
    if (!this.pendingSessionMessageReloadSessionIds.delete(sessionId)) return;
    const sessionKey = this.findSessionKeyBySessionId(sessionId);
    if (!sessionKey) return;
    void this.historyReconciler.reconcileWithHistory(sessionId, sessionKey).catch(() => {});
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

  private promoteThinkingSegmentToAssistantMessage(
    sessionId: string,
    turn: SessionTurn,
    content: string,
    metadata: Record<string, unknown>,
  ): boolean {
    if (!turn.thinkingMessageId || !turn.thinkingContent) return false;

    const messageId = turn.thinkingMessageId;
    this.store.updateMessage(sessionId, messageId, {
      content,
      thinkingContent: turn.thinkingContent,
      metadata,
    });
    this.emit('messageUpdate', sessionId, messageId, content);
    this.emit('messageMetadataUpdate', sessionId, messageId, metadata);

    turn.assistantMessageId = messageId;
    turn.thinkingMessageId = null;
    turn.thinkingContent = '';
    return true;
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

  private mergeUnscopedFinalIntoActiveAssistant(
    sessionId: string,
    turn: SessionTurn,
    message: unknown,
  ): boolean {
    const content = extractAssistantText(message).trim();
    if (!content || isNoReply(content)) return false;

    const normalizedFinal = content.replace(/\s+/g, ' ').trim();
    const session = this.store.getSession(sessionId);
    if (!session) return false;

    const activeMessage = turn.assistantMessageId
      ? session.messages.find(candidate => candidate.id === turn.assistantMessageId)
      : [...session.messages]
          .reverse()
          .find(
            candidate =>
              candidate.type === 'assistant' &&
              candidate.metadata?.isStreaming === true &&
              !candidate.metadata?.isThinking,
          );
    if (!activeMessage || activeMessage.type !== 'assistant') return false;

    const normalizedActive = activeMessage.content.replace(/\s+/g, ' ').trim();
    if (!normalizedActive) return false;
    const isExactMatch = normalizedFinal === normalizedActive;
    const isSubstantialExpansion =
      normalizedActive.length >= 24 && normalizedFinal.startsWith(normalizedActive);
    if (!isExactMatch && !isSubstantialExpansion) return false;

    const metadata = {
      ...activeMessage.metadata,
      isStreaming: false,
      isFinal: true,
      ...(turn.modelName ? { modelName: turn.modelName } : {}),
    };
    this.clearPendingMessageUpdate(activeMessage.id);
    this.store.updateMessage(sessionId, activeMessage.id, { content, metadata });
    this.emit('messageUpdate', sessionId, activeMessage.id, content);
    this.emit('messageMetadataUpdate', sessionId, activeMessage.id, metadata);
    turn.assistantMessageId = activeMessage.id;
    turn.chatStream = content;
    return true;
  }

  private isRecentAssistantSegmentComposite(sessionId: string, content: string): boolean {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    const session = this.store.getSession(sessionId);
    if (!session) return false;

    const recentAssistantContents = session.messages
      .filter(message => message.type === 'assistant' && !message.metadata?.isThinking)
      .map((message: CoworkMessage) => message.content.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(-6);

    for (let start = 0; start < recentAssistantContents.length - 1; start++) {
      const segments = recentAssistantContents.slice(start);
      const joinedTight = segments.join('');
      const joinedSpaced = segments.join(' ');
      if (joinedTight === normalized || joinedSpaced === normalized) return true;
      if (
        normalized.startsWith(segments[0]) &&
        normalized.endsWith(segments[segments.length - 1]) &&
        segments.every((segment: string) => normalized.includes(segment))
      ) {
        return true;
      }
    }

    return false;
  }

  private appendExternalFinalAssistantMessage(
    sessionId: string,
    modelName: string,
    message: unknown,
    sessionKey?: string,
  ): void {
    const content = extractAssistantText(message).trim();
    if (!content || isNoReply(content)) {
      if (sessionKey) {
        void this.historyReconciler.reconcileWithHistory(sessionId, sessionKey).catch(() => {});
      }
      return;
    }

    if (this.isRecentAssistantSegmentComposite(sessionId, content)) {
      return;
    }

    const duplicate = this.findRecentAssistantByContent(sessionId, content);
    if (duplicate) {
      this.store.updateMessage(sessionId, duplicate.id, {
        content,
        metadata: {
          ...duplicate.metadata,
          isStreaming: false,
          isFinal: true,
          modelName,
        },
      });
      this.emit('messageMetadataUpdate', sessionId, duplicate.id, {
        ...duplicate.metadata,
        isStreaming: false,
        isFinal: true,
        modelName,
      });
      return;
    }

    const msg = this.store.addMessage(sessionId, {
      type: 'assistant',
      content,
      metadata: { isStreaming: false, isFinal: true, modelName },
    });
    this.emit('message', sessionId, msg);
  }

  private resolveSessionModelName(sessionId: string): string {
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
    return modelName;
  }

  private isAnnounceRunId(runId: string): boolean {
    return runId.startsWith('announce:v1:');
  }

  private getVisibleRunStream(
    sessionId: string,
    sessionKey: string,
    runId: string,
    modelName: string,
  ): VisibleRunStreamState {
    const existing = this.visibleRunStreams.get(runId);
    if (existing) return existing;
    const stream: VisibleRunStreamState = {
      sessionId,
      sessionKey,
      runId,
      assistantMessageId: null,
      assistantText: '',
      committedAssistantSegments: [],
      thinkingMessageId: null,
      thinkingContent: '',
      toolStreamById: new Map(),
      modelName,
    };
    this.visibleRunStreams.set(runId, stream);
    this.sessionIdByRunId.set(runId, sessionId);
    return stream;
  }

  private hasVisibleRunForSession(sessionId: string): boolean {
    for (const stream of this.visibleRunStreams.values()) {
      if (stream.sessionId === sessionId) return true;
    }
    return false;
  }

  private handleVisibleRunAssistantSnapshot(
    sessionId: string,
    sessionKey: string,
    runId: string,
    modelName: string,
    snapshot: string,
    final: boolean,
  ): void {
    if (!snapshot || isNoReply(snapshot)) {
      if (final) this.finalizeVisibleRun(runId);
      return;
    }

    const stream = this.getVisibleRunStream(sessionId, sessionKey, runId, modelName);
    const text = this.prepareVisibleAssistantSnapshot(stream, snapshot);
    if (!text || isNoReply(text)) return;

    const metadata = { isStreaming: !final, isFinal: final, modelName: stream.modelName };
    if (stream.assistantMessageId) {
      this.finalizeVisibleRunThinking(stream);
      this.store.updateMessage(sessionId, stream.assistantMessageId, { content: text, metadata });
      this.emit('messageUpdate', sessionId, stream.assistantMessageId, text);
      if (final) {
        this.emit('messageMetadataUpdate', sessionId, stream.assistantMessageId, metadata);
      }
    } else if (
      this.promoteVisibleRunThinkingToAssistantMessage(stream, text, {
        ...metadata,
        isThinking: false,
      })
    ) {
      // The visible announce run's thinking row is now its live assistant row.
    } else {
      this.finalizeVisibleRunThinking(stream);
      const msg = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: text,
        metadata,
      });
      stream.assistantMessageId = msg.id;
      this.emit('message', sessionId, msg);
    }

    stream.assistantText = text;
    if (final) this.commitVisibleAssistantSegment(stream);
  }

  private promoteVisibleRunThinkingToAssistantMessage(
    stream: VisibleRunStreamState,
    content: string,
    metadata: Record<string, unknown>,
  ): boolean {
    if (!stream.thinkingMessageId || !stream.thinkingContent) return false;

    const messageId = stream.thinkingMessageId;
    this.store.updateMessage(stream.sessionId, messageId, {
      content,
      thinkingContent: stream.thinkingContent,
      metadata,
    });
    this.emit('messageUpdate', stream.sessionId, messageId, content);
    this.emit('messageMetadataUpdate', stream.sessionId, messageId, metadata);

    stream.assistantMessageId = messageId;
    stream.thinkingMessageId = null;
    stream.thinkingContent = '';
    return true;
  }

  private prepareVisibleAssistantSnapshot(stream: VisibleRunStreamState, snapshot: string): string {
    return this.stripCommittedAssistantSegments(stream.committedAssistantSegments, snapshot);
  }

  private stripCommittedAssistantSegments(segments: string[], snapshot: string): string {
    let text = snapshot;
    for (const segment of segments) {
      const committed = segment.trim();
      if (!committed) continue;
      const trimmed = text.trimStart();
      if (trimmed.startsWith(committed)) {
        text = trimmed.slice(committed.length).trimStart();
      }
    }
    return text;
  }

  private prepareAssistantSnapshot(turn: SessionTurn, snapshot: string): string {
    if (!snapshot) return '';
    if (!turn.chatStream) {
      return this.stripCommittedAssistantSegments(turn.committedAssistantSegments, snapshot);
    }
    if (snapshot.startsWith(turn.chatStream) || turn.chatStream.startsWith(snapshot)) {
      return this.stripCommittedAssistantSegments(turn.committedAssistantSegments, snapshot);
    }

    this.commitAssistantSegmentBeforeTool(turn.sessionId, turn);
    return this.stripCommittedAssistantSegments(turn.committedAssistantSegments, snapshot);
  }

  private commitVisibleAssistantSegment(stream: VisibleRunStreamState): void {
    const content = stream.assistantText.trim();
    if (!content) return;
    if (stream.assistantMessageId) {
      this.clearPendingMessageUpdate(stream.assistantMessageId);
      this.store.updateMessage(stream.sessionId, stream.assistantMessageId, {
        content,
        metadata: { isStreaming: false, isFinal: true, modelName: stream.modelName },
      });
      this.emit('messageUpdate', stream.sessionId, stream.assistantMessageId, content);
      this.emit('messageMetadataUpdate', stream.sessionId, stream.assistantMessageId, {
        isStreaming: false,
        isFinal: true,
        modelName: stream.modelName,
      });
    } else if (!this.findRecentAssistantByContent(stream.sessionId, content)) {
      const msg = this.store.addMessage(stream.sessionId, {
        type: 'assistant',
        content,
        metadata: { isStreaming: false, isFinal: true, modelName: stream.modelName },
      });
      this.emit('message', stream.sessionId, msg);
    }
    if (!stream.committedAssistantSegments.includes(content)) {
      stream.committedAssistantSegments.push(content);
    }
    stream.assistantMessageId = null;
    stream.assistantText = '';
  }

  private handleVisibleRunThinkingSnapshot(
    sessionId: string,
    sessionKey: string,
    runId: string,
    modelName: string,
    data: Record<string, unknown>,
  ): void {
    const stream = this.getVisibleRunStream(sessionId, sessionKey, runId, modelName);
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
      const msg = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: '',
        thinkingContent: stream.thinkingContent,
        metadata: { isStreaming: true, isThinking: true },
      });
      stream.thinkingMessageId = msg.id;
      this.emit('message', sessionId, msg);
    } else {
      this.store.updateMessage(sessionId, stream.thinkingMessageId, {
        content: '',
        thinkingContent: stream.thinkingContent,
        metadata: { isStreaming: true, isThinking: true },
      });
      if (thinkingDelta) {
        this.emit('thinkingUpdate', sessionId, stream.thinkingMessageId, thinkingDelta);
      }
    }
  }

  private finalizeVisibleRunThinking(stream: VisibleRunStreamState): void {
    if (!stream.thinkingMessageId) return;
    this.store.updateMessage(stream.sessionId, stream.thinkingMessageId, {
      metadata: { isStreaming: false, isThinking: true },
    });
    this.emit('messageMetadataUpdate', stream.sessionId, stream.thinkingMessageId, {
      isStreaming: false,
      isThinking: true,
    });
    stream.thinkingMessageId = null;
    stream.thinkingContent = '';
  }

  private handleVisibleRunToolEvent(
    sessionId: string,
    sessionKey: string,
    runId: string,
    modelName: string,
    data: Record<string, unknown>,
  ): void {
    const normalized = normalizeToolEvent(data);
    const toolCallId = normalized.toolCallId ?? '';
    if (!toolCallId) return;

    const stream = this.getVisibleRunStream(sessionId, sessionKey, runId, modelName);
    const name = normalized.name;
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const args = normalized.input;
    const output = normalized.output ?? undefined;
    const now = Date.now();
    let entry = stream.toolStreamById.get(toolCallId);

    if (!entry) {
      this.finalizeVisibleRunThinking(stream);
      this.commitVisibleAssistantSegment(stream);
      entry = {
        toolCallId,
        runId,
        sessionKey,
        name,
        args,
        output: output || undefined,
        startedAt: now,
        updatedAt: now,
      };
      stream.toolStreamById.set(toolCallId, entry);
    } else {
      entry.name = name;
      if (args !== undefined) entry.args = args;
      if (output !== undefined) entry.output = output || undefined;
      entry.updatedAt = now;
    }

    if (phase === 'result') {
      this.emitToolMessages(sessionId, entry);
    }
  }

  private handleVisibleRunToolItemEvent(
    sessionId: string,
    sessionKey: string,
    runId: string,
    modelName: string,
    data: Record<string, unknown>,
  ): void {
    const stream = this.getVisibleRunStream(sessionId, sessionKey, runId, modelName);
    this.handleToolItemEventForMap({
      sessionId,
      runId,
      sessionKey,
      data,
      toolStreamById: stream.toolStreamById,
      beforeFirstTool: () => {
        this.finalizeVisibleRunThinking(stream);
        this.commitVisibleAssistantSegment(stream);
      },
    });
  }

  private finalizeVisibleRun(runId: string): void {
    const stream = this.visibleRunStreams.get(runId);
    if (!stream) return;
    this.finalizeVisibleRunThinking(stream);
    this.commitVisibleAssistantSegment(stream);
    this.visibleRunStreams.delete(runId);
    this.sessionIdByRunId.delete(runId);
  }

  private commitAssistantSegmentBeforeTool(sessionId: string, turn: SessionTurn): void {
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

    if (!turn.committedAssistantSegments.includes(content)) {
      turn.committedAssistantSegments.push(content);
    }
    turn.chatStream = '';
    turn.assistantMessageId = null;
  }

  private handleToolStreamEvent(
    sessionId: string,
    turn: SessionTurn,
    data: Record<string, unknown>,
  ): void {
    const normalized = normalizeToolEvent(data);
    const toolCallId = normalized.toolCallId ?? '';
    if (!toolCallId) return;

    const name = normalized.name;
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const args = normalized.input;
    const output = normalized.output ?? undefined;

    const now = Date.now();
    let entry = turn.toolStreamById.get(toolCallId);

    if (!entry) {
      this.finalizeThinkingSegment(sessionId, turn);

      this.commitAssistantSegmentBeforeTool(sessionId, turn);

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
    } else {
      entry.name = name;
      if (args !== undefined) entry.args = args;
      if (output !== undefined) entry.output = output || undefined;
      entry.updatedAt = now;
    }

    entry.message = {
      role: 'assistant',
      toolCallId: entry.toolCallId,
      runId: entry.runId,
      content: [
        { type: 'toolcall', name: entry.name, arguments: entry.args ?? {} },
        ...(entry.output ? [{ type: 'toolresult', name: entry.name, text: entry.output }] : []),
      ],
      timestamp: entry.startedAt,
    };
    if (!turn.toolStreamOrder.includes(toolCallId)) {
      turn.toolStreamOrder.push(toolCallId);
    }
    syncWebchatToolStreamMessages(turn);

    if (phase === 'result') {
      this.emitToolMessages(sessionId, entry);
    }
  }

  private handleToolItemEvent(
    sessionId: string,
    turn: SessionTurn,
    data: Record<string, unknown>,
  ): void {
    this.handleToolItemEventForMap({
      sessionId,
      runId: turn.runId,
      data,
      toolStreamById: turn.toolStreamById,
      beforeFirstTool: () => {
        this.finalizeThinkingSegment(sessionId, turn);
        this.commitAssistantSegmentBeforeTool(sessionId, turn);
      },
    });
  }

  private handleToolItemEventForMap(options: {
    sessionId: string;
    runId: string;
    sessionKey?: string;
    data: Record<string, unknown>;
    toolStreamById: Map<string, ToolStreamEntry>;
    beforeFirstTool: () => void;
  }): void {
    const { sessionId, runId, sessionKey, data, toolStreamById, beforeFirstTool } = options;
    const normalized = normalizeToolEvent(data);
    const toolCallId = normalized.toolCallId ?? '';
    if (!toolCallId) return;

    const kind = typeof data.kind === 'string' ? data.kind : '';
    if (kind && kind !== 'tool' && kind !== 'command' && kind !== 'patch' && kind !== 'exec')
      return;

    const phase = typeof data.phase === 'string' ? data.phase : '';
    const now = Date.now();
    const name =
      normalized.name !== 'tool'
        ? normalized.name
        : kind === 'command'
          ? 'exec'
          : kind === 'patch'
            ? 'apply_patch'
            : 'tool';
    const output =
      normalized.output ??
      normalized.error ??
      (phase === 'end' && typeof data.status === 'string' ? data.status : undefined);
    let entry = toolStreamById.get(toolCallId);

    if (!entry) {
      beforeFirstTool();
      entry = {
        toolCallId,
        runId,
        sessionKey,
        name,
        output: output || undefined,
        startedAt: now,
        updatedAt: now,
      };
      toolStreamById.set(toolCallId, entry);
    } else {
      entry.name = entry.name === 'tool' ? name : entry.name;
      if (output !== undefined) entry.output = output || undefined;
      entry.updatedAt = now;
    }

    entry.message = {
      role: 'assistant',
      toolCallId: entry.toolCallId,
      runId: entry.runId,
      content: [
        { type: 'toolcall', name: entry.name, arguments: entry.args ?? {} },
        ...(entry.output ? [{ type: 'toolresult', name: entry.name, text: entry.output }] : []),
      ],
      timestamp: entry.startedAt,
    };
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn && toolStreamById === activeTurn.toolStreamById) {
      if (!activeTurn.toolStreamOrder.includes(toolCallId)) {
        activeTurn.toolStreamOrder.push(toolCallId);
      }
      syncWebchatToolStreamMessages(activeTurn);
    }

    if (phase === 'end' && !entry.emitted && entry.output !== undefined) {
      this.emitToolMessages(sessionId, entry);
    }
  }

  private emitToolMessages(sessionId: string, entry: ToolStreamEntry): void {
    if (entry.emitted) return;
    entry.emitted = true;

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
    // Emit tool_result message
    if (entry.output) {
      const toolResult = this.parseToolOutputObject(entry.output) ?? undefined;
      const toolResultMsg = this.store.addMessage(sessionId, {
        type: 'tool_result',
        content: entry.output,
        metadata: {
          toolName: entry.name,
          toolUseId: entry.toolCallId,
          toolResult,
          isStreaming: false,
        },
      });
      this.emit('message', sessionId, toolResultMsg);
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

  // ─── Approval ───────────────────────────────────────────────────────────

  // ─── Turn Lifecycle Helpers ─────────────────────────────────────────────

  private classifyMainAgentEvent(turn: SessionTurn, event: NormalizedAgentEvent) {
    return classifyAgentEvent({
      selected: { sessionKey: turn.sessionKey, sessionId: turn.gatewaySessionId },
      activeRun: turn,
      event,
      terminalRun: this.isRecentTerminalRun(event.runId),
    });
  }

  private rememberTerminalRun(runId: string): void {
    if (!runId) return;
    const now = Date.now();
    for (const [knownRunId, expiresAt] of this.recentTerminalRunIds) {
      if (expiresAt <= now) this.recentTerminalRunIds.delete(knownRunId);
    }
    this.recentTerminalRunIds.set(runId, now + 5 * 60 * 1000);
    while (this.recentTerminalRunIds.size > 24) {
      const oldest = this.recentTerminalRunIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentTerminalRunIds.delete(oldest);
    }
  }

  private isRecentTerminalRun(runId: string): boolean {
    const expiresAt = this.recentTerminalRunIds.get(runId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.recentTerminalRunIds.delete(runId);
      return false;
    }
    return true;
  }

  private cleanupSessionTurn(sessionId: string): void {
    const lifecycleEndFallbackTimer = this.lifecycleEndFallbackTimers.get(sessionId);
    if (lifecycleEndFallbackTimer) {
      clearTimeout(lifecycleEndFallbackTimer);
      this.lifecycleEndFallbackTimers.delete(sessionId);
    }
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      if (turn.thinkingMessageId) {
        this.store.updateMessage(sessionId, turn.thinkingMessageId, {
          metadata: { isStreaming: false, isThinking: true },
        });
      }
      if (turn.assistantMessageId) {
        this.persistStreamingAssistantSnapshot(sessionId, turn.assistantMessageId, turn.chatStream);
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.lastMessageUpdateEmitTime.delete(turn.assistantMessageId);
      }
      for (const runId of turn.knownRunIds) {
        this.sessionIdByRunId.delete(runId);
      }
    }
    for (const [runId, stream] of this.visibleRunStreams) {
      if (stream.sessionId !== sessionId) continue;
      this.finalizeVisibleRun(runId);
    }
    this.activeTurns.delete(sessionId);
    this.compactionInFlightSessionIds.delete(sessionId);
    this.reCreatedChannelSessionIds.delete(sessionId);
    this.flushPendingSessionModelPatch(sessionId);
  }

  private scheduleLifecycleEndFallback(sessionId: string, turn: SessionTurn): void {
    if (this.compactionInFlightSessionIds.has(sessionId)) return;
    const existingTimer = this.lifecycleEndFallbackTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.lifecycleEndFallbackTimers.delete(sessionId);
      if (this.activeTurns.get(sessionId) !== turn) return;
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'idle' });
      this.resolveTurn(sessionId);
      this.replayDeferredSessionMessageReload(sessionId);
      this.emit('complete', sessionId, 'idle');
    }, LIFECYCLE_END_FALLBACK_MS);
    this.lifecycleEndFallbackTimers.set(sessionId, timer);
  }

  private flushPendingSessionModelPatch(sessionId: string): void {
    const pendingPatch = this.pendingSessionModelPatches.get(sessionId);
    if (!pendingPatch) return;
    this.pendingSessionModelPatches.delete(sessionId);
    if (!this.store.getSession(sessionId)) return;

    void this.sessionRpc
      .patchModel(sessionId, pendingPatch.model, pendingPatch.agentId)
      .catch(error =>
        coworkLog('WARN', 'OpenClawRuntime', 'Deferred patchSessionModel failed', {
          error: String(error),
          sessionId,
        }),
      );
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    if (this.isSessionInStopCooldown(sessionId)) return;
    if (this.manuallyStoppedSessions.has(sessionId)) {
      this.manuallyStoppedSessions.delete(sessionId);
    }
    this.terminalLifecycleSessionIds.delete(sessionId);
    this.compactionInFlightSessionIds.delete(sessionId);

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
      gatewaySessionId: null,
      lifecycleGeneration: null,
      lastAgentSeq: -1,
      status: 'running',
      turnToken,
      chatStream: '',
      agentAssistantStreamSeen: false,
      committedAssistantSegments: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      chatToolMessages: [],
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
    if (this.terminalLifecycleSessionIds.has(sessionId) || isTerminalStatus) {
      this.cleanupSessionTurn(sessionId);
      return;
    }

    await new Promise(resolve => setTimeout(resolve, RACE_RESOLUTION_MS));
    if (!this.activeTurns.has(sessionId)) return;
    await this.stopSession(sessionId);
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
      this.terminalLifecycleSessionIds.add(sessionId);
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
    const exact = this.sessionIdBySessionKey.get(sessionKey);
    if (exact) return exact;
    const normalized = normalizeMessageSessionKey(sessionKey);
    for (const [knownKey, sessionId] of this.sessionIdBySessionKey) {
      if (normalizeMessageSessionKey(knownKey) === normalized) return sessionId;
    }
    return null;
  }

  private findSessionKeyBySessionId(sessionId: string): string {
    for (const [sessionKey, mappedSessionId] of this.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) return sessionKey;
    }
    const session = this.store.getSession(sessionId);
    return session ? this.toSessionKey(sessionId, session.agentId || 'main') : '';
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
    this.persistStreamingAssistantSnapshot(sessionId, messageId, content);

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

  private persistStreamingAssistantSnapshot(
    sessionId: string,
    messageId: string,
    content: string,
  ): void {
    if (!content) return;
    this.store.updateMessage(sessionId, messageId, { content });
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
          coworkLog(
            'WARN',
            'OpenClawRuntime',
            `Gateway client handshake failed; retrying in ${delay}ms`,
            { error: String(error) },
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const generation = this.gatewayClientGeneration;
    const clientEntryPath = connection.clientEntryPath;
    if (!clientEntryPath) throw new Error('Gateway client entry path is not available');
    const GatewayClient = await this.loadGatewayClientCtor(clientEntryPath);
    if (generation !== this.gatewayClientGeneration) {
      throw new Error('Gateway client initialization was superseded');
    }

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
      clientDisplayName: PRODUCT_NAME,
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
      role: 'operator',
      scopes: ['operator.admin'],
      // JustDo authenticates this loopback backend client with the managed
      // gateway token. Avoid OpenClaw creating a second device identity under
      // the Electron main process's default ~/.openclaw state directory.
      deviceIdentity: null,
      onHelloOk: () => {
        const isExpectedClient =
          generation === this.gatewayClientGeneration &&
          this.pendingGatewayClient === client &&
          !this.intentionallyStoppedGatewayClients.has(client);
        if (!isExpectedClient) {
          this.intentionallyStoppedGatewayClients.add(client);
          client.stop();
          return;
        }
        this.gatewayClient = client;
        this.pendingGatewayClient = null;
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        settleResolve();
        this.lastTickTimestamp = Date.now();
        this.startTickWatchdog();
        void this.subscribeGatewaySessions();
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
    this.gatewayClientGeneration++;
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
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to stop gateway client', {
        error: String(error),
      });
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

  private async subscribeGatewaySessions(): Promise<void> {
    const client = this.gatewayClient;
    if (!client) return;
    try {
      await client.request('sessions.subscribe', {});
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to subscribe to Gateway session events', {
        error: String(error),
      });
    }
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
    this.pendingSessionModelPatches.delete(sessionId);
    this.cleanupSessionTurn(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.terminalLifecycleSessionIds.delete(sessionId);
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
    subagents: Array<{
      id: string;
      sessionKey: string;
      label: string;
      status: SubagentStatus;
      task?: string;
      model?: string;
      startedAt?: number;
      endedAt?: number;
      runtimeMs?: number;
      totalTokens?: number;
    }>;
  }> {
    if (!sessionId) return { subagents: [] };
    const cached = this.subagentStatusCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) {
      return { subagents: cached.subagents };
    }

    await this.ensureGatewayClientReady();
    if (!this.gatewayClient) return { subagents: [] };
    const subagents = await listGatewaySubagents({
      client: this.gatewayClient,
      parentKeys: this.getSessionKeysForSession(sessionId),
    });
    this.subagentStatusCache.set(sessionId, {
      expiresAt: Date.now() + SUBAGENT_STATUS_CACHE_TTL_MS,
      subagents,
    });
    return {
      subagents,
    };
  }

  async getSessionRuntimeStatus(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean },
  ): Promise<{
    known: boolean;
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
  }> {
    if (!sessionId) {
      return { known: true, mainRunning: false, subagentRunning: false, running: false };
    }
    const statuses = await this.getSessionRuntimeStatuses([sessionId], options);
    return statuses[sessionId] ?? {
      known: false,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    };
  }

  async getSessionRuntimeStatuses(
    sessionIds: string[],
    options?: { includeSubagents?: boolean; forceRefresh?: boolean },
  ): Promise<Record<string, SessionRuntimeStatus>> {
    const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
    const localMainRunning = new Map(
      uniqueSessionIds.map(sessionId => [
        sessionId,
        this.isSessionActive(sessionId) || this.hasVisibleRunForSession(sessionId),
      ]),
    );
    const statuses: Record<string, SessionRuntimeStatus> = {};
    if (uniqueSessionIds.every(sessionId => localMainRunning.get(sessionId) === true)) {
      for (const sessionId of uniqueSessionIds) {
        statuses[sessionId] = {
          known: true,
          mainRunning: true,
          subagentRunning: false,
          running: true,
        };
      }
      return statuses;
    }

    const snapshot = await this.getRuntimeSessionSnapshot(options?.forceRefresh === true);
    const parentByKey = new Map<string, string>();
    for (const row of snapshot.sessions) {
      const key = this.runtimeRowString(row.key);
      const parent = this.runtimeRowString(row.spawnedBy) || this.runtimeRowString(row.parentSessionKey);
      if (key && parent) parentByKey.set(key, parent);
    }

    for (const sessionId of uniqueSessionIds) {
      const localRunning = localMainRunning.get(sessionId) === true;
      if (!snapshot.known && !localRunning) {
        statuses[sessionId] = {
          known: false,
          mainRunning: false,
          subagentRunning: false,
          running: false,
        };
        continue;
      }

      const sessionKeys = new Set(this.getSessionKeysForSession(sessionId));
      const mainRunning =
        localRunning ||
        snapshot.sessions.some(row => {
          const key = this.runtimeRowString(row.key);
          return sessionKeys.has(key) && this.isRuntimeSessionRowActive(row);
        });
      let subagentRunning = false;
      if (options?.includeSubagents && !mainRunning) {
        subagentRunning = snapshot.sessions.some(row => {
          if (!this.isRuntimeSessionRowActive(row)) return false;
          let parent = parentByKey.get(this.runtimeRowString(row.key));
          const visited = new Set<string>();
          while (parent && !visited.has(parent)) {
            if (sessionKeys.has(parent)) return true;
            visited.add(parent);
            parent = parentByKey.get(parent);
          }
          return false;
        });
        const cachedSubagents = this.subagentStatusCache.get(sessionId);
        if (cachedSubagents && cachedSubagents.expiresAt > Date.now()) {
          subagentRunning ||= cachedSubagents.subagents.some(
            subagent => subagent.status === SUBAGENT_STATUSES.RUNNING,
          );
        }
      }
      statuses[sessionId] = {
        known: true,
        mainRunning,
        subagentRunning,
        running: mainRunning || subagentRunning,
      };
    }
    return statuses;
  }

  private runtimeRowString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private isRuntimeSessionRowActive(row: Record<string, unknown>): boolean {
    return (
      row.hasActiveRun === true ||
      row.hasActiveSubagentRun === true ||
      row.status === 'running' ||
      row.runState === 'active' ||
      row.subagentRunState === 'active'
    );
  }

  private async getRuntimeSessionSnapshot(forceRefresh = false): Promise<RuntimeSessionSnapshot> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.runtimeSessionSnapshot &&
      this.runtimeSessionSnapshot.expiresAt > now
    ) {
      return this.runtimeSessionSnapshot;
    }
    if (this.runtimeSessionSnapshotPromise) {
      const pendingSnapshot = await this.runtimeSessionSnapshotPromise;
      return forceRefresh ? this.getRuntimeSessionSnapshot(true) : pendingSnapshot;
    }
    const client = this.gatewayClient;
    if (!client) return { known: false, sessions: [] };

    this.runtimeSessionSnapshotPromise = client
      .request<{ sessions?: Array<Record<string, unknown>> }>('sessions.list', { limit: 500 })
      .then(result => ({ known: true, sessions: result.sessions ?? [] }))
      .catch((error): RuntimeSessionSnapshot => {
        if (now - this.lastRuntimeStatusWarningAt >= RUNTIME_STATUS_WARNING_INTERVAL_MS) {
          this.lastRuntimeStatusWarningAt = now;
          console.warn('[OpenClawRuntime] Failed to query session runtime snapshot', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { known: false, sessions: [] };
      })
      .then(snapshot => {
        this.runtimeSessionSnapshot = {
          ...snapshot,
          expiresAt: Date.now() + RUNTIME_SESSION_SNAPSHOT_TTL_MS,
        };
        return snapshot;
      })
      .finally(() => {
        this.runtimeSessionSnapshotPromise = null;
      });
    return this.runtimeSessionSnapshotPromise;
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

  // ─── Public API ────────────────────────────────────────────────────────

  async generateTitle(userIntent: string | null, timeoutMs?: number): Promise<string> {
    return this.titleGenerator.generateTitle(userIntent, timeoutMs);
  }

  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.isSessionActive(sessionId)) {
      this.pendingSessionModelPatches.set(sessionId, { model, agentId });
      coworkLog('INFO', 'OpenClawRuntime', 'patchSessionModel: deferred active session', {
        sessionId,
        model,
      });
      return { ok: true };
    }
    return this.sessionRpc.patchModel(sessionId, model, agentId);
  }

  async requestGateway<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureGatewayClientReady();
    return this.requireGatewayClient().request<T>(method, params);
  }
}

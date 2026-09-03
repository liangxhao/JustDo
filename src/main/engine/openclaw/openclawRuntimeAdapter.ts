import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { type CoworkAttachmentPayload, toGatewayAttachment } from '../../../shared/cowork/attachments';
import {
  normalizeAgentEvent,
  normalizeChatEvent,
  type NormalizedAgentEvent,
} from '../../../shared/openclaw/agentEvent';
import {
  ApprovalDecision,
  type ApprovalDecision as ApprovalDecisionValue,
  ApprovalKind,
  type ApprovalRequest,
  ExecApprovalDecision,
  type ExecApprovalRequest,
  OpenClawApprovalIpc,
  type PermissionMode,
  type PluginApprovalRequest,
  toOpenClawSessionPermissionMode,
} from '../../../shared/openclaw/approvals';
import {
  type AskUserInteractionEnvelope,
  AskUserQuestionGateway,
  type AskUserRequest,
  CoworkInteractionIpc,
  CoworkInteractionKind,
  OpenClawToolName,
  parseAskUserAnswers,
  parseAskUserRequest,
} from '../../../shared/openclaw/extensions';
import { isInternalManagedSubagentHandoffError } from '../../../shared/openclaw/internalRunError';
import {
  classifyAgentEvent,
  classifyChatEvent,
  normalizeMessageSessionKey,
  normalizeToolEvent,
} from '../../../shared/openclaw/messageDomain';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  GoalExecutionIpc,
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  type GoalFeedbackPreparationResult,
  normalizeSessionGoal,
  type SessionGoal,
  SessionGoalIpc,
  SessionGoalStatus,
} from '../../../shared/sessionGoal';
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
  CoworkSessionStatus,
  CoworkStore,
} from '../../data/coworkStore';
import {
  OPENCLAW_AGENT_TIMEOUT_SECONDS,
  OPENCLAW_COMPACTION_TIMEOUT_SECONDS,
} from '../../openclaw/config/openclawConfigSync';
import { GoalContinuationCoordinator } from '../../openclaw/goals/goalContinuationCoordinator';
import {
  buildSessionExecApprovalFingerprint,
  SessionExecApprovalGrants,
} from '../../openclaw/permissions/sessionExecApprovalGrants';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../../openclaw/runtime/openclawEngineManager';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  isManagedSessionKey,
  parseManagedSessionKey,
} from '../../openclaw/sessions/openclawSessionKeys';
import {
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
} from '../gateway/types';
import type {
  CoworkGenerateTitleOptions,
  CoworkPreparedSession,
  CoworkPrepareSessionOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  CoworkStopOptions,
} from '../types';
import {
  type GatewaySubagent,
  listGatewaySubagents,
  listGatewaySubagentsWithMetadata,
  mergeGatewaySubagentSnapshots,
  SUBAGENT_STATUSES,
  type SubagentLabelSource,
  type SubagentStatus,
} from './subagentGateway';
import {
  parseChatHistoryResultV2026_8_2,
  parseTaskEventV2026_8_2,
} from './wire/v2026_8_2';

// ─── Constants ──────────────────────────────────────────────────────────────

const STOP_COOLDOWN_MS = 10_000;
const STOP_CANCEL_EXEC_APPROVAL_DECISION = 'deny-justdo-stop';
const RACE_RESOLUTION_MS = 1_000;
const FULL_HISTORY_SYNC_LIMIT = 1000;
const TICK_WATCHDOG_INTERVAL_MS = 60_000;
const TICK_TIMEOUT_MS = 90_000;
const AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000;
const CLIENT_TIMEOUT_GRACE_MS = 30_000;
const GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000];
const GATEWAY_CONNECT_RETRY_DELAYS = [500, 1_500, 3_000];
const SUBAGENT_STATUS_CACHE_TTL_MS = 8_000;
const SUBAGENT_DETAIL_CACHE_TTL_MS = 60_000;
const RUNTIME_SESSION_SNAPSHOT_TTL_MS = 2_000;
const ASK_USER_TERMINAL_CACHE_SIZE = 256;
const TITLE_SESSION_ID_RESOLUTION_TIMEOUT_MS = 30_000;
const TITLE_SESSION_ID_POLL_INTERVAL_MS = 100;
const TITLE_SESSION_ID_SNAPSHOT_INTERVAL_MS = 2_000;
const LIFECYCLE_END_FALLBACK_MS = 1_500;
const AUTOMATION_PERMISSION_POLICY_ID = 'native-session-automation-permission';
const COMPACTION_IN_FLIGHT_TIMEOUT_MS = OPENCLAW_COMPACTION_TIMEOUT_SECONDS * 1_000 + 60_000;
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

// ─── Adapter ────────────────────────────────────────────────────────────────

type SessionRuntimeStatus = {
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
  rootRunId?: string;
};

type RuntimeSessionSnapshot = {
  known: boolean;
  sessions: Array<Record<string, unknown>>;
  hasMore: boolean;
};

type PendingTurnStart = {
  cancelled: boolean;
  cancellationAbortError?: unknown;
  phase: 'preparing' | 'sending' | 'settled';
  settled: Promise<void>;
  resolveSettled: () => void;
  turn?: SessionTurn;
};

const normalizeWorkspacePath = (workspace: string): string => {
  const normalized = path.normalize(path.resolve(workspace));
  try {
    // Preserve per-directory case-sensitive semantics on Windows while still
    // collapsing aliases, junctions, and ordinary case-only spelling changes.
    return fs.realpathSync.native(normalized);
  } catch {
    // A missing/unreadable path is not safe to case-fold: updating the Gateway
    // again is preferable to treating two distinct paths as equivalent.
    return normalized;
  }
};

const areWorkspacePathsEquivalent = (left: string, right: string): boolean =>
  normalizeWorkspacePath(left) === normalizeWorkspacePath(right);

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;

  // Per-session turn state (replaces 25+ scattered Maps)
  private readonly activeTurns = new Map<string, SessionTurn>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly rootRunIdBySession = new Map<string, string>();
  private readonly pendingTurns = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly pendingTurnStarts = new Map<string, PendingTurnStart>();
  private readonly stopSessionPromises = new Map<string, Promise<void>>();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly stoppedSessions = new Map<string, number>();
  private readonly manuallyStoppedSessions = new Set<string>();
  private readonly terminalLifecycleSessionIds = new Set<string>();
  private readonly terminalLifecycleErrorSessionIds = new Set<string>();
  private readonly recentTerminalRunIds = new Map<string, number>();
  private readonly compactionInFlightSessionIds = new Set<string>();
  private readonly compactionInFlightTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  private automationPermissionVerifiedGeneration = -1;
  private continuationPermissionPreparer: ((sessionId: string) => Promise<void>) | null = null;
  private gatewayStoppingIntentionally = false;
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;
  private goalRecoveryGeneration: number | null = null;
  private goalRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly appStartedAtMs: number;
  private initialGatewayGoalRecoveryPending = true;
  private readonly goalIdsActivatedThisApp = new Set<string>();
  private readonly goalSessionsActivatingThisApp = new Set<string>();
  private readonly goalReplacementPromises = new Map<
    string,
    Promise<GoalFeedbackPreparationResult>
  >();
  private readonly goalsAwaitingResumeInput = new Map<string, string>();

  // Tick watchdog
  private lastTickTimestamp = 0;
  private lastAgentActivityTimestamp = 0;
  private legacyAgentSequence = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Channel session sync
  private readonly latestTurnTokenBySession = new Map<string, number>();
  private readonly sessionExecApprovalGrants = new SessionExecApprovalGrants();
  private readonly approvalResolutionByKey = new Map<string, Promise<void>>();
  private approvalReconciliation: {
    generation: number;
    events: Array<{ channel: string; payload: Record<string, unknown> }>;
  } | null = null;
  private readonly pendingAskUserRequests = new Map<string, AskUserRequest>();
  private readonly terminalAskUserIds = new Set<string>();
  private readonly subagentStatusCache = new Map<
    string,
    {
      expiresAt: number;
      subagents: GatewaySubagent[];
    }
  >();
  private readonly subagentDetailCache = new Map<
    string,
    {
      expiresAt: number;
      subagents: GatewaySubagent[];
    }
  >();
  private readonly subagentStatusRefreshes = new Map<string, Promise<GatewaySubagent[]>>();
  private readonly subagentStatusGenerations = new Map<string, number>();
  private runtimeSessionSnapshot: (RuntimeSessionSnapshot & { expiresAt: number }) | null = null;
  private runtimeSessionSnapshotPromise: Promise<RuntimeSessionSnapshot> | null = null;
  private runtimeSessionSnapshotGeneration = 0;
  private lastRuntimeStatusWarningAt = 0;

  // Collaborators
  private sessionRpc!: SessionRpc;
  private titleGenerator!: SessionTitleGenerator;
  private readonly goalContinuationCoordinator: GoalContinuationCoordinator;

  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;

  constructor(
    store: CoworkStore,
    engineManager: OpenClawEngineManager,
    titleFetch?: SessionTitleFetch,
  ) {
    super();
    this.store = store;
    this.engineManager = engineManager;
    const readAppStartedAtMs = (
      engineManager as OpenClawEngineManager & { getAppStartedAtMs?: () => number }
    ).getAppStartedAtMs;
    this.appStartedAtMs =
      typeof readAppStartedAtMs === 'function'
        ? readAppStartedAtMs.call(engineManager)
        : Date.now();
    this.goalContinuationCoordinator = new GoalContinuationCoordinator({
      getClient: () => this.gatewayClient,
      resolveSessionId: sessionKey => this.resolveSessionIdBySessionKey(sessionKey),
      resolveAgentId: sessionId => this.store.getSession(sessionId)?.agentId || 'main',
      getMaxContinuationTurns: () => this.store.getConfig().maxGoalContinuationTurns,
      onRunAccepted: (sessionId, sessionKey, runId) => {
        if (this.terminalLifecycleSessionIds.has(sessionId)) {
          this.cleanupSessionTurn(sessionId);
        }
        this.ensureActiveTurn(sessionId, sessionKey, runId);
      },
      onRunFailed: sessionId => this.cleanupSessionTurn(sessionId),
      onSnapshot: snapshot => {
        if (
          snapshot.phase === GoalExecutionPhase.AwaitingConfirmation ||
          snapshot.phase === GoalExecutionPhase.AwaitingInput ||
          snapshot.phase === GoalExecutionPhase.Stopped
        ) {
          if (snapshot.identityPending === false) {
            this.store.setGoalExecutionSnapshot?.(snapshot);
          } else {
            this.store.setGoalExecutionSnapshot?.({ ...snapshot, identityPending: true });
            void this.persistTerminalGoalSnapshot(snapshot);
          }
        } else if (
          snapshot.phase === GoalExecutionPhase.Running ||
          snapshot.phase === GoalExecutionPhase.Continuing ||
          snapshot.phase === GoalExecutionPhase.Retrying
        ) {
          this.store.clearGoalExecutionSnapshot?.(snapshot.sessionId);
        }
        this.broadcastGoalExecution(snapshot);
      },
      prepareSessionForContinuation: async sessionId => {
        if (this.continuationPermissionPreparer) {
          await this.continuationPermissionPreparer(sessionId);
          return;
        }
        await this.prepareSession(sessionId);
      },
      waitBeforeAutomaticContinuation: () =>
        new Promise(resolve => setTimeout(resolve, 1_600)),
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
      skillIds: options.skillIds,
      confirmationMode: options.confirmationMode,
      attachments: options.attachments,
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
      clientTurnId: options.clientTurnId,
    });
  }

  async prepareSession(
    sessionId: string,
    options: CoworkPrepareSessionOptions = {},
  ): Promise<CoworkPreparedSession> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const agentId = options.agentId || session.agentId || DEFAULT_MANAGED_AGENT_ID;
    return this.prepareSessionKey(sessionId, this.toSessionKey(sessionId, agentId), options);
  }

  setContinuationPermissionPreparer(
    preparer: ((sessionId: string) => Promise<void>) | null,
  ): void {
    this.continuationPermissionPreparer = preparer;
  }

  private async prepareSessionKey(
    sessionId: string,
    sessionKey: string,
    options: CoworkPrepareSessionOptions = {},
  ): Promise<CoworkPreparedSession> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const workspaceRoot = (options.workspaceRoot || session.cwd).trim();
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new Error('The session workspace must be an absolute path.');
    }
    const permissionMode: PermissionMode = options.permissionMode ?? session.permissionMode;
    const nativePermissionMode = toOpenClawSessionPermissionMode(permissionMode);

    await this.ensureGatewayClientReady();
    const result = await this.requireGatewayClient().request<{
      key?: unknown;
      sessionId?: unknown;
      entry?: {
        sessionId?: unknown;
        permissionMode?: unknown;
        sessionRoot?: unknown;
      };
    }>('sessions.create', {
      key: sessionKey,
      cwd: workspaceRoot,
      permissionMode: nativePermissionMode,
    });
    const gatewaySessionId =
      typeof result.sessionId === 'string'
        ? result.sessionId.trim()
        : typeof result.entry?.sessionId === 'string'
          ? result.entry.sessionId.trim()
          : '';
    if (!gatewaySessionId) {
      throw new Error('OpenClaw sessions.create returned no sessionId.');
    }
    if (result.entry?.permissionMode !== nativePermissionMode) {
      throw new Error('OpenClaw did not persist the requested session permission mode.');
    }
    if (
      typeof result.entry.sessionRoot !== 'string' ||
      !areWorkspacePathsEquivalent(result.entry.sessionRoot, workspaceRoot)
    ) {
      throw new Error('OpenClaw did not persist the requested session workspace boundary.');
    }

    this.rememberSessionKey(sessionId, sessionKey);
    return { sessionKey, gatewaySessionId };
  }

  async stopSession(sessionId: string, options: CoworkStopOptions = {}): Promise<void> {
    const existing = this.stopSessionPromises.get(sessionId);
    if (existing) return existing;
    const stopping = this.stopSessionInternal(sessionId, options, true);
    this.stopSessionPromises.set(sessionId, stopping);
    try {
      await stopping;
    } finally {
      if (this.stopSessionPromises.get(sessionId) === stopping) {
        this.stopSessionPromises.delete(sessionId);
      }
    }
  }

  private async stopSessionInternal(
    sessionId: string,
    options: CoworkStopOptions,
    cancelPendingStart: boolean,
  ): Promise<void> {
    const pendingStart = cancelPendingStart ? this.pendingTurnStarts.get(sessionId) : undefined;
    const pendingStartWasSending = pendingStart?.phase === 'sending';
    if (pendingStart) pendingStart.cancelled = true;
    this.goalContinuationCoordinator.stop(sessionId);
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
    }
    this.manuallyStoppedSessions.add(sessionId);
    const canCancelPreparationLocally =
      pendingStart?.phase === 'preparing' && (!turn || pendingStart.turn === turn);

    if (!canCancelPreparationLocally) {
      try {
        await this.abortSessionAndSubagents(sessionId, turn);
      } catch (error) {
        if (pendingStartWasSending) {
          coworkLog('WARN', 'OpenClawRuntime', 'Initial abort raced a pending chat.send', {
            error: String(error),
            sessionId,
          });
        } else {
          if (turn && this.activeTurns.get(sessionId) === turn) {
            turn.stopRequested = false;
          }
          this.manuallyStoppedSessions.delete(sessionId);
          if (!options.bestEffort) {
            this.goalContinuationCoordinator.rollbackStop(sessionId);
            throw error;
          }
          coworkLog('WARN', 'OpenClawRuntime', 'Failed to confirm session stop', {
            error: String(error),
            sessionId,
          });
        }
      }
    }

    if (pendingStartWasSending) {
      await pendingStart.settled;
    }
    if (pendingStart?.cancellationAbortError) {
      if (turn && this.activeTurns.get(sessionId) === turn) {
        turn.stopRequested = false;
      }
      this.manuallyStoppedSessions.delete(sessionId);
      if (!options.bestEffort) {
        this.goalContinuationCoordinator.rollbackStop(sessionId);
        throw pendingStart.cancellationAbortError;
      }
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to confirm a cancelled turn start', {
        error: String(pendingStart.cancellationAbortError),
        sessionId,
      });
    }

    this.goalContinuationCoordinator.confirmStop(sessionId);

    this.stoppedSessions.set(sessionId, Date.now());
    this.terminalLifecycleSessionIds.delete(sessionId);
    this.terminalLifecycleErrorSessionIds.delete(sessionId);
    if (turn) this.rememberTerminalTurn(turn);
    this.cleanupSessionTurn(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  getGoalExecution(sessionId: string): GoalExecutionSnapshot | null {
    return (
      this.goalContinuationCoordinator.getSnapshot(sessionId) ??
      this.store.getGoalExecutionSnapshot?.(sessionId)
    );
  }

  async continueGoal(sessionId: string): Promise<GoalExecutionSnapshot> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const client = this.requireGatewayClient();
    const candidateKeys = [
      ...this.getSessionKeysForSession(sessionId),
      buildManagedSessionKey(sessionId, session.agentId || DEFAULT_MANAGED_AGENT_ID),
      buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
    ];
    let sessionKey = '';
    let goalId = '';
    for (const candidateKey of new Set(candidateKeys)) {
      const result = await client.request<{
        session?: { key?: string; goal?: unknown } | null;
      }>('sessions.describe', { key: candidateKey });
      const described = result.session;
      if (!described || !isRecord(described.goal)) continue;
      if (described.goal.status !== SessionGoalStatus.Active) continue;
      sessionKey = described.key?.trim() || candidateKey;
      goalId = typeof described.goal.id === 'string' ? described.goal.id.trim() : '';
      this.rememberSessionKey(sessionId, sessionKey);
      break;
    }
    if (!sessionKey) throw new Error('The session does not have an active goal');
    await this.prepareSessionKey(sessionId, sessionKey);
    // Explicit user intent transfers this Goal to the current app lifecycle.
    // Keep that ownership across Gateway reconnects, but not app restarts.
    if (goalId) this.goalIdsActivatedThisApp.add(`${sessionId}:${goalId}`);
    const continued = await this.goalContinuationCoordinator.continue(sessionId, sessionKey);
    if (continued.goalId) {
      this.goalIdsActivatedThisApp.add(`${sessionId}:${continued.goalId}`);
    }
    return continued;
  }

  private async persistTerminalGoalSnapshot(snapshot: GoalExecutionSnapshot): Promise<void> {
    const generation = this.gatewayClientGeneration;
    const session = this.store.getSession(snapshot.sessionId);
    const client = this.gatewayClient;
    let canonicalGoal: SessionGoal | null = null;
    if (session && client) {
      const candidateKeys = [
        ...this.getSessionKeysForSession(snapshot.sessionId),
        buildManagedSessionKey(
          snapshot.sessionId,
          session.agentId || DEFAULT_MANAGED_AGENT_ID,
        ),
        buildManagedSessionKey(snapshot.sessionId, DEFAULT_MANAGED_AGENT_ID),
      ];
      for (const delayMs of [0, 100, 250, 500, 1_000] as const) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (generation !== this.gatewayClientGeneration || this.gatewayClient !== client) return;
        for (const candidateKey of new Set(candidateKeys)) {
          try {
            const result = await client.request<{ session?: { goal?: unknown } | null }>(
              'sessions.describe',
              { key: candidateKey },
            );
            const goal = normalizeSessionGoal(result.session?.goal);
            if (goal) canonicalGoal = goal;
          } catch {
            // A later retry or reconnect recovery can converge the snapshot.
          }
          if (canonicalGoal) break;
        }
      }
    }
    const current = this.goalContinuationCoordinator.getSnapshot(snapshot.sessionId);
    if (
      current?.phase !== snapshot.phase ||
      current.runId !== snapshot.runId ||
      current.updatedAt !== snapshot.updatedAt
    ) {
      return;
    }
    const persisted = {
      ...snapshot,
      ...(canonicalGoal ? { goalId: canonicalGoal.id } : {}),
      identityPending: !canonicalGoal,
    };
    if (persisted.goalId !== snapshot.goalId || persisted.identityPending !== true) {
      this.goalContinuationCoordinator.restoreSnapshot(persisted);
    } else {
      this.store.setGoalExecutionSnapshot?.(persisted);
    }
  }

  async resumeGoalForUserInput(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const client = this.requireGatewayClient();
    const generation = this.gatewayClientGeneration;
    const candidateKeys = [
      ...this.getSessionKeysForSession(sessionId),
      buildManagedSessionKey(sessionId, session.agentId || DEFAULT_MANAGED_AGENT_ID),
      buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
    ];
    let sessionKey = '';
    let blockedGoalId = '';
    for (const candidateKey of new Set(candidateKeys)) {
      const result = await client.request<{ session?: { key?: string; goal?: unknown } | null }>(
        'sessions.describe',
        { key: candidateKey },
      );
      if (!result.session || !isRecord(result.session.goal)) continue;
      const status = result.session.goal.status;
      if (status === SessionGoalStatus.Active) return;
      if (
        status !== SessionGoalStatus.Blocked &&
        status !== SessionGoalStatus.UsageLimited &&
        status !== SessionGoalStatus.BudgetLimited
      ) {
        continue;
      }
      sessionKey = result.session.key?.trim() || candidateKey;
      blockedGoalId =
        typeof result.session.goal.id === 'string' ? result.session.goal.id.trim() : '';
      break;
    }
    if (!sessionKey || !blockedGoalId) throw new Error('The session does not have a blocked goal');
    await this.prepareSessionKey(sessionId, sessionKey);
    this.goalIdsActivatedThisApp.add(`${sessionId}:${blockedGoalId}`);

    const runId = `justdo-goal-resume-input-${randomUUID()}`;
    this.rememberSessionKey(sessionId, sessionKey);
    this.sessionIdByRunId.set(runId, sessionId);
    this.goalContinuationCoordinator.registerControlRun(runId);
    let commandAccepted = false;
    try {
      const result = await client.request<{ runId?: string }>('chat.send', {
        sessionKey,
        message: '/goal resume',
        deliver: false,
        justdoUserInitiated: true,
        idempotencyKey: runId,
      });
      commandAccepted = true;
      this.goalsAwaitingResumeInput.set(sessionId, blockedGoalId);
      if (result.runId && result.runId !== runId) {
        this.sessionIdByRunId.set(result.runId, sessionId);
        this.goalContinuationCoordinator.registerControlRun(result.runId);
      }
      let resumed = false;
      for (const delayMs of [0, 100, 250, 500, 1_000] as const) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (generation !== this.gatewayClientGeneration) {
          throw new Error('OpenClaw Gateway connection changed');
        }
        const described = await client.request<{ session?: { goal?: unknown } | null }>(
          'sessions.describe',
          { key: sessionKey },
        );
        if (isRecord(described.session?.goal) && described.session.goal.status === 'active') {
          resumed = true;
          break;
        }
      }
      if (!resumed) throw new Error('The blocked goal could not be resumed');
    } catch (error) {
      if (!commandAccepted) this.goalContinuationCoordinator.unregisterControlRun(runId);
      throw error;
    }
  }

  async restartCompletedGoalForFeedback(
    sessionId: string,
    expectedGoalId: string,
    preparedObjective?: string,
  ): Promise<GoalFeedbackPreparationResult> {
    const existing = this.goalReplacementPromises.get(sessionId);
    if (existing) return existing;
    const replacement = this.performCompletedGoalReplacement(
      sessionId,
      expectedGoalId,
      preparedObjective,
    );
    this.goalReplacementPromises.set(sessionId, replacement);
    try {
      return await replacement;
    } finally {
      if (this.goalReplacementPromises.get(sessionId) === replacement) {
        this.goalReplacementPromises.delete(sessionId);
      }
    }
  }

  private async performCompletedGoalReplacement(
    sessionId: string,
    expectedGoalId: string,
    preparedObjective?: string,
  ): Promise<GoalFeedbackPreparationResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const client = this.requireGatewayClient();
    const generation = this.gatewayClientGeneration;
    const candidateKeys = [
      ...this.getSessionKeysForSession(sessionId),
      buildManagedSessionKey(sessionId, session.agentId || DEFAULT_MANAGED_AGENT_ID),
      buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
    ];
    let sessionKey = '';
    let completedGoal: SessionGoal | null = null;
    let observedGoal: SessionGoal | null = null;
    const convergenceDelays = [0, 100, 250, 500] as const;
    for (const delayMs of convergenceDelays) {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      let expectedGoalStillActive = false;
      for (const candidateKey of new Set(candidateKeys)) {
        const result = await client.request<{ session?: { key?: string; goal?: unknown } | null }>(
          'sessions.describe',
          { key: candidateKey },
        );
        const goal = normalizeSessionGoal(result.session?.goal);
        if (!goal) {
          sessionKey ||= result.session?.key?.trim() || candidateKey;
          continue;
        }
        observedGoal = goal;
        if (goal.id !== expectedGoalId) continue;
        if (goal.status === SessionGoalStatus.Active) expectedGoalStillActive = true;
        const execution = this.goalContinuationCoordinator.getSnapshot(sessionId);
        const completionLatched =
          goal.status === SessionGoalStatus.Active &&
          execution?.phase === GoalExecutionPhase.AwaitingConfirmation &&
          (!execution.goalId || execution.goalId === expectedGoalId);
        if (goal.status !== SessionGoalStatus.Complete && !completionLatched) continue;
        sessionKey = result.session?.key?.trim() || candidateKey;
        completedGoal = goal;
        break;
      }
      if (completedGoal) break;
      if (
        !expectedGoalStillActive ||
        this.goalContinuationCoordinator.getSnapshot(sessionId)?.phase !==
          GoalExecutionPhase.AwaitingConfirmation
      ) {
        break;
      }
      if (generation !== this.gatewayClientGeneration) {
        throw new Error('OpenClaw Gateway connection changed');
      }
    }
    if (!sessionKey || !completedGoal) {
      const fallbackObjective = preparedObjective?.trim();
      if (!observedGoal && fallbackObjective) {
        return { objective: fallbackObjective };
      }
      throw new Error('The completed goal changed before feedback could be submitted');
    }
    this.rememberSessionKey(sessionId, sessionKey);
    const objective = completedGoal.objective.trim() || preparedObjective?.trim();
    if (!objective) throw new Error('The completed goal does not have an objective');

    await client.request<{ ok: boolean; cleared: boolean; key: string }>('sessions.goal.clear', {
      key: sessionKey,
    });

    let cleared = false;
    for (const delayMs of [0, 100, 250, 500, 1_000, 2_000] as const) {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (generation !== this.gatewayClientGeneration) {
        throw new Error('OpenClaw Gateway connection changed');
      }
      const described = await client.request<{ session?: { goal?: unknown } | null }>(
        'sessions.describe',
        { key: sessionKey },
      );
      const goal = normalizeSessionGoal(described.session?.goal);
      if (!goal) {
        cleared = true;
        break;
      }
      if (goal.id !== expectedGoalId) {
        throw new Error('The completed goal changed while it was being cleared');
      }
    }
    if (!cleared) throw new Error('The completed goal could not be cleared');

    this.goalContinuationCoordinator.restoreSnapshot({
      sessionId,
      phase: GoalExecutionPhase.Waiting,
      continuationCount: 0,
      updatedAt: Date.now(),
    });
    return { objective };
  }

  async stopAllSessions(): Promise<void> {
    const sessionIds = [...new Set([
      ...this.activeTurns.keys(),
      ...this.pendingTurnStarts.keys(),
    ])];
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
    let approvalCleanupError: unknown;
    try {
      await this.denyPendingApprovalsForSessionKeys(client, [
        ...parentKeys,
        ...subagentKeys,
      ]);
    } catch (error) {
      approvalCleanupError = error;
    }
    if (failure) throw failure.reason;
    if (subagentDiscoveryError) throw subagentDiscoveryError;
    if (approvalCleanupError) throw approvalCleanupError;
    this.invalidateSubagentStatus(sessionId);
  }

  private async denyPendingApprovalsForSessionKeys(
    client: GatewayClientLike,
    sessionKeys: string[],
  ): Promise<void> {
    const targetKeys = new Set(sessionKeys.filter(Boolean));
    if (targetKeys.size === 0) return;
    const listMatching = async () => {
      const [execRequests, pluginRequests] = await Promise.all([
        client.request<ExecApprovalRequest[]>('exec.approval.list'),
        client.request<PluginApprovalRequest[]>('plugin.approval.list'),
      ]);
      return [
        ...(Array.isArray(execRequests)
          ? execRequests.map(request => ({ kind: ApprovalKind.Exec, request }))
          : []),
        ...(Array.isArray(pluginRequests)
          ? pluginRequests.map(request => ({ kind: ApprovalKind.Plugin, request }))
          : []),
      ].filter(({ request }) => {
        const sessionKey = request.request.sessionKey;
        return typeof sessionKey === 'string' && targetKeys.has(sessionKey);
      });
    };
    const denyAll = (pending: Awaited<ReturnType<typeof listMatching>>) =>
      Promise.allSettled(
        pending.map(({ kind, request }) =>
          client.request(
            kind === ApprovalKind.Plugin ? 'plugin.approval.resolve' : 'exec.approval.resolve',
            {
              id: request.id,
              decision:
                kind === ApprovalKind.Exec
                  ? STOP_CANCEL_EXEC_APPROVAL_DECISION
                  : ExecApprovalDecision.Deny,
            },
          ),
        ),
      );

    await denyAll(await listMatching());
    let remaining = await listMatching();
    if (remaining.length > 0) {
      await denyAll(remaining);
      remaining = await listMatching();
    }
    if (remaining.length > 0) {
      throw new Error(
        `Gateway still has ${remaining.length} pending approval(s) for the stopped session.`,
      );
    }
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
        hydrateDetails: false,
        includeMalformedForRuntimeControl: true,
      });
      for (const subagent of subagents) {
        if (!visitedParentKeys.has(subagent.sessionKey)) {
          pendingParentKeys.push(subagent.sessionKey);
        }
        if (
          (subagent.status === SUBAGENT_STATUSES.PENDING ||
            subagent.status === SUBAGENT_STATUSES.RUNNING) &&
          !runningKeys.has(subagent.sessionKey)
        ) {
          runningKeys.add(subagent.sessionKey);
        }
      }
    }

    return [...runningKeys];
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId) || this.pendingTurnStarts.has(sessionId);
  }

  hasActiveSessions(): boolean {
    return this.activeTurns.size > 0 || this.pendingTurnStarts.size > 0;
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.confirmationModeBySession.get(sessionId) ?? null;
  }

  // ─── Run Turn ───────────────────────────────────────────────────────────

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      skillIds?: string[];
      confirmationMode?: 'modal' | 'text';
      attachments?: CoworkAttachmentPayload[];
      agentId?: string;
      workspaceRoot?: string;
      clientTurnId?: string;
    },
  ): Promise<void> {
    if (!prompt.trim()) {
      throw new Error('Prompt is required.');
    }

    const previousStart = this.pendingTurnStarts.get(sessionId);
    if (previousStart) previousStart.cancelled = true;
    let resolveSettled!: () => void;
    const pendingStart: PendingTurnStart = {
      cancelled: false,
      phase: 'preparing',
      settled: new Promise<void>(resolve => {
        resolveSettled = resolve;
      }),
      resolveSettled: () => resolveSettled(),
    };
    this.pendingTurnStarts.set(sessionId, pendingStart);
    const isStartCancelled = () =>
      pendingStart.cancelled || this.pendingTurnStarts.get(sessionId) !== pendingStart;
    let completionPromise: Promise<void> | null = null;
    let turn: SessionTurn | null = null;
    let failureReported = false;

    try {
      // A user-initiated turn is current-app work even when it continues a Goal
      // whose immutable createdAt predates this app process.
      if (this.initialGatewayGoalRecoveryPending) {
        this.goalSessionsActivatingThisApp.add(sessionId);
      }

      await this.sessionRpc.waitForModelUpdate(sessionId);
      if (isStartCancelled()) return;

      this.stoppedSessions.delete(sessionId);
      this.manuallyStoppedSessions.delete(sessionId);
      // Resolve stale activeTurns
      if (this.activeTurns.has(sessionId)) {
        await this.resolveActiveTurnConflict(sessionId);
        if (isStartCancelled()) return;
      }

      const session = this.store.getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

      const confirmationMode =
        options.confirmationMode ?? this.confirmationModeBySession.get(sessionId) ?? 'modal';
      this.confirmationModeBySession.set(sessionId, confirmationMode);

      const agentId = options.agentId || session.agentId || 'main';
      this.store.updateSession(sessionId, { status: 'running' });
      this.emit('activity', sessionId, 'user', Date.now());
      const preparedSession = await this.prepareSession(sessionId, {
        permissionMode: session.permissionMode,
        workspaceRoot: options.workspaceRoot,
        agentId,
      });
      if (isStartCancelled()) return;
      const sessionKey = preparedSession.sessionKey;

      const runId = options.clientTurnId?.trim() || randomUUID();
      this.rootRunIdBySession.set(sessionId, runId);
      const turnToken = this.nextTurnToken(sessionId);
      completionPromise = new Promise<void>((resolve, reject) => {
        this.pendingTurns.set(sessionId, { resolve, reject });
      });
      // chat.send can fail before execution reaches the final await below. Keep
      // the original promise rejectable for active-turn failures, but attach a
      // handler immediately so an admission/send exception cannot create an
      // unhandled rejection alongside the error propagated by runTurn itself.
      void completionPromise.catch((): void => undefined);

      // Create SessionTurn (replaces 22-field ActiveTurn)
      turn = {
        sessionId,
        sessionKey,
        runId,
        gatewaySessionId: null,
        lifecycleGeneration: null,
        lastAgentSeq: -1,
        status: 'running',
        turnToken,
        stopRequested: false,
        knownRunIds: new Set([runId]),
      };
      pendingStart.turn = turn;
      this.activeTurns.set(sessionId, turn);
      this.sessionIdByRunId.set(runId, sessionId);
      this.startTurnTimeoutWatchdog(sessionId);
      this.lastAgentActivityTimestamp = Date.now();

      const client = this.requireGatewayClient();
      try {
        const attachments = options.attachments?.length
          ? options.attachments.map(toGatewayAttachment)
          : undefined;
        const commandSessionId = hasSlashCommandBeforeSendHook(
          prompt,
          SlashCommandBeforeSendHook.EnsureSessionEntry,
        )
          ? preparedSession.gatewaySessionId
          : undefined;
        if (isStartCancelled()) return;
        pendingStart.phase = 'sending';
        const result = await client.request<{ runId?: string }>('chat.send', {
          sessionKey,
          ...(commandSessionId ? { sessionId: commandSessionId } : {}),
          message: prompt.trim(),
          deliver: false,
          justdoUserInitiated: true,
          // Gateway timeout 0 means timer-safe "no timeout". JustDo owns the
          // user-turn watchdog below so it can suspend that deadline while
          // managed subagents are still running in an in-place sessions_yield.
          timeoutMs: 0,
          idempotencyKey: runId,
          ...(attachments ? { attachments } : {}),
        });
        const rootRunId = result.runId?.trim() || turn.runId || runId;
        this.rootRunIdBySession.set(sessionId, rootRunId);
        this.sessionIdByRunId.set(rootRunId, sessionId);
        turn.knownRunIds.add(rootRunId);
        turn.runId = rootRunId;
        if (isStartCancelled()) {
          try {
            await this.abortSessionAndSubagents(sessionId, { ...turn, runId: rootRunId });
          } catch (error) {
            pendingStart.cancellationAbortError = error;
          }
          if (!pendingStart.cancellationAbortError) return;
        } else {
          const timing = options.clientTurnId
            ? this.store.getSessionRunByClientTurnId(options.clientTurnId)
            : undefined;
          if (timing?.state === 'running') {
            this.store.bindSessionRunRootRun(timing.id, rootRunId);
          }
          if (!prompt.trimStart().startsWith('/')) {
            this.goalsAwaitingResumeInput.delete(sessionId);
          }
        }
      } catch (error) {
        if (isStartCancelled()) {
          try {
            await this.abortSessionAndSubagents(sessionId);
          } catch (abortError) {
            pendingStart.cancellationAbortError = abortError;
          }
          if (!pendingStart.cancellationAbortError) return;
        } else {
          this.cleanupSessionTurn(sessionId);
          this.store.updateSession(sessionId, { status: 'error' });
          const message = error instanceof Error ? error.message : String(error);
          this.emit('error', sessionId, message);
          this.rejectTurn(sessionId, new Error(message));
          failureReported = true;
          throw error;
        }
      }
    } catch (error) {
      if (!isStartCancelled()) {
        if (!failureReported) {
          this.cleanupSessionTurn(sessionId);
          this.store.updateSession(sessionId, { status: 'error' });
          const message = error instanceof Error ? error.message : String(error);
          this.emit('error', sessionId, message);
          this.rejectTurn(sessionId, new Error(message));
        }
        throw error;
      }
      return;
    } finally {
      if (
        isStartCancelled() &&
        turn &&
        this.activeTurns.get(sessionId) === turn &&
        !pendingStart.cancellationAbortError
      ) {
        this.cleanupSessionTurn(sessionId);
        this.store.updateSession(sessionId, { status: 'idle' });
        this.resolveTurn(sessionId);
      }
      pendingStart.phase = 'settled';
      pendingStart.resolveSettled();
      if (this.pendingTurnStarts.get(sessionId) === pendingStart) {
        this.pendingTurnStarts.delete(sessionId);
      }
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

    if (event.event === AskUserQuestionGateway.REQUESTED_EVENT) {
      this.handleAskUserRequested(event.payload);
      return;
    }

    if (event.event === AskUserQuestionGateway.RESOLVED_EVENT) {
      this.handleAskUserResolved(event.payload);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      void this.handleExecApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.broadcastApproval(OpenClawApprovalIpc.Resolved, ApprovalKind.Exec, event.payload);
      return;
    }

    if (event.event === 'plugin.approval.requested') {
      void this.handlePluginApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'plugin.approval.resolved') {
      this.broadcastApproval(OpenClawApprovalIpc.Resolved, ApprovalKind.Plugin, event.payload);
      return;
    }

    if (event.event === 'cron') {
      this.emit('cronChanged', event.payload);
      return;
    }

    if (event.event === 'task') {
      this.handleTaskEvent(event.payload);
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

  private handleTaskEvent(payload: unknown): void {
    try {
      const event = parseTaskEventV2026_8_2(payload);
      if (event.action === 'upserted') {
        const sessionIds = new Set<string>();
        for (const sessionKey of [
          event.task.sessionKey,
          event.task.childSessionKey,
          event.task.ownerKey,
        ]) {
          if (sessionKey) {
            const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
            if (sessionId) sessionIds.add(sessionId);
          }
        }
        if (sessionIds.size > 0) {
          for (const sessionId of sessionIds) {
            this.invalidateSubagentStatusSnapshot(sessionId);
            this.emit('taskChanged', { sessionId });
          }
          return;
        }
      }
      // Deleted events intentionally expose only taskId, while a restored ledger can affect
      // every requester. Invalidate all known parent snapshots for both event shapes.
      for (const sessionId of new Set([
        ...this.subagentStatusCache.keys(),
        ...this.subagentDetailCache.keys(),
        ...this.subagentStatusRefreshes.keys(),
      ])) {
        if (event.action === 'upserted') {
          this.invalidateSubagentStatusSnapshot(sessionId);
        } else {
          this.invalidateSubagentStatus(sessionId);
        }
      }
      this.emit('taskChanged', {});
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed v2026.8.2 task event', {
        error: String(error),
      });
    }
  }

  // ─── Chat Event Handling (aligned with webchat) ─────────────────────────

  private handleChatEvent(payload: unknown, frameSeq?: number): void {
    const event = normalizeChatEvent({ payload, frameSeq });
    if (!event) return;
    const sessionKey = event.sessionKey;
    const runId = event.runId ?? '';

    let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    }
    if (!sessionId) return;
    // Gateway reconnects can replay a terminal run. Reject it before creating
    // local lifecycle state; otherwise a late delta/start can strand the
    // session in running even though its final event was already accepted.
    if (runId && this.isRecentTerminalRun(runId)) return;
    if (sessionKey && runId && !this.isAnnounceRunId(runId)) {
      this.ensureActiveTurn(sessionId, sessionKey, runId);
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    const admission = classifyChatEvent({
      selected: { sessionKey: turn.sessionKey, sessionId: turn.gatewaySessionId },
      activeRun: turn,
      event,
    });
    if (admission === 'ignored-session') return;

    if (runId && turn.runId !== runId && this.isAnnounceRunId(runId)) {
      if (event.state !== 'delta') turn.knownRunIds.add(runId);
      return;
    }
    if (turn.runId && !runId) return;
    if (admission === 'ignored-run') return;
    if (admission === 'bind-provisional-run' && runId) {
      this.sessionIdByRunId.delete(turn.runId);
      turn.runId = runId;
      turn.knownRunIds.add(runId);
      this.sessionIdByRunId.set(runId, sessionId);
    }
    if (!turn.gatewaySessionId && event.sessionId) turn.gatewaySessionId = event.sessionId;
    if (!turn.lifecycleGeneration && event.lifecycleGeneration) {
      turn.lifecycleGeneration = event.lifecycleGeneration;
    }

    if (event.state === 'delta') return;

    const finish = (status: 'idle' | 'error'): void => {
      this.rememberTerminalTurn(turn);
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status });
      this.terminalLifecycleSessionIds.add(sessionId);
      if (status === 'error') {
        this.terminalLifecycleErrorSessionIds.add(sessionId);
      } else {
        this.terminalLifecycleErrorSessionIds.delete(sessionId);
      }
      this.resolveTurn(sessionId);
      this.emit('complete', sessionId, status);
    };

    if (event.state === 'final' || event.state === 'aborted') {
      finish('idle');
      return;
    }
    if (event.state !== 'error') return;
    if (isInternalManagedSubagentHandoffError(event.errorMessage)) {
      coworkLog('WARN', 'OpenClawRuntime', 'Suppressed internal managed handoff run error', {
        sessionId,
        runId,
      });
      finish('idle');
      return;
    }
    finish('error');
    this.emit('error', sessionId, event.errorMessage ?? 'chat error');
  }
  // ─── Agent Event Handling (tool stream) ─────────────────────────────────

  private handleAgentEvent(
    deliveryEvent: 'agent' | 'session.tool',
    payload: unknown,
    frameSeq?: number,
  ): void {
    let normalized = normalizeAgentEvent({ deliveryEvent, payload, frameSeq });
    if (normalized.reason === 'missing-sequence' && isRecord(payload)) {
      normalized = normalizeAgentEvent({
        deliveryEvent,
        payload: {
          ...payload,
          seq: frameSeq ?? ++this.legacyAgentSequence,
        },
        frameSeq,
      });
    }
    const event = normalized.event;
    if (!event) return;

    const { runId, stream } = event;
    const sessionKey = event.sessionKey ?? '';
    const data = event.data;
    if (stream === 'tool' && sessionKey) {
      const tool = normalizeToolEvent(data);
      this.goalContinuationCoordinator.handleToolEvent({
        runId,
        sessionKey,
        spawnedBy: event.spawnedBy,
        name: tool.name,
        toolCallId: tool.toolCallId,
        ...(tool.input === undefined ? {} : { input: tool.input }),
        ...(tool.output === null ? {} : { output: tool.output }),
        status: tool.status,
        failed: tool.failed,
      });
    }
    if (stream === 'lifecycle' && sessionKey) {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      if (phase === 'start' || phase === 'end' || phase === 'error') {
        if (
          phase === 'start' &&
          !event.spawnedBy &&
          this.goalContinuationCoordinator.isUserInputRun(runId)
        ) {
          const inputSessionId =
            this.sessionIdByRunId.get(runId) ?? this.resolveSessionIdBySessionKey(sessionKey);
          if (inputSessionId && this.goalsAwaitingResumeInput.has(inputSessionId)) {
            this.goalsAwaitingResumeInput.delete(inputSessionId);
          }
        }
        void this.goalContinuationCoordinator.handleLifecycle({
          runId,
          sessionKey,
          spawnedBy: event.spawnedBy,
          phase,
          ...(typeof data.aborted === 'boolean' ? { aborted: data.aborted } : {}),
          ...(typeof data.error === 'string' ? { error: data.error } : {}),
        });
      }
    }

    // Goal continuation consumes the complete tool/lifecycle sequence even
    // when chat final already settled the local UI lifecycle. Only suppress
    // replay before it can recreate an active Main-process turn.
    if (this.isRecentTerminalRun(runId)) return;

    let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    }
    if (!sessionId || event.spawnedBy || this.isAnnounceRunId(runId)) return;

    if (!this.activeTurns.has(sessionId) && stream === 'lifecycle' && data.phase === 'start') {
      this.ensureActiveTurn(sessionId, sessionKey, runId);
    }
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    const admission = this.classifyMainAgentEvent(turn, event);
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
      this.rootRunIdBySession.set(sessionId, runId);
      const timing = this.store.getLatestSessionRun(sessionId);
      if (timing?.state === 'running') this.store.bindSessionRunRootRun(timing.id, runId);
    }
    if (!turn.gatewaySessionId && event.sessionId) turn.gatewaySessionId = event.sessionId;
    if (!turn.lifecycleGeneration && event.lifecycleGeneration) {
      turn.lifecycleGeneration = event.lifecycleGeneration;
    }
    turn.lastAgentSeq = event.agentSeq;
    turn.knownRunIds.add(runId);
    this.sessionIdByRunId.set(runId, sessionId);

    if (stream === 'compaction') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      this.handleCompactionPhase(sessionId, phase, turn);
      return;
    }
    if (stream !== 'lifecycle') return;

    const phase = typeof data.phase === 'string' ? data.phase : '';
    const internalManagedHandoffError =
      phase === 'error' && isInternalManagedSubagentHandoffError(data.error);
    if (phase === 'end' || phase === 'error') {
      this.terminalLifecycleSessionIds.add(sessionId);
    }
    if (phase === 'error') {
      if (internalManagedHandoffError) {
        this.terminalLifecycleErrorSessionIds.delete(sessionId);
      } else {
        this.terminalLifecycleErrorSessionIds.add(sessionId);
      }
      this.scheduleLifecycleEndFallback(sessionId, turn);
    } else if (phase === 'end') {
      this.terminalLifecycleErrorSessionIds.delete(sessionId);
      this.scheduleLifecycleEndFallback(sessionId, turn);
    }
  }
  private handleSessionMessageEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (!sessionKey) return;
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (!sessionId) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(SessionGoalIpc.Changed, { sessionId });
      }
    }
  }

  private resolveAskUserSessionId(request: AskUserRequest): string {
    return request.sessionKey
      ? (this.resolveSessionIdBySessionKey(request.sessionKey) ?? '__askuser__')
      : '__askuser__';
  }

  private toAskUserInteraction(request: AskUserRequest): AskUserInteractionEnvelope {
    const sessionId = this.resolveAskUserSessionId(request);
    return {
      sessionId,
      request: {
        requestId: request.requestId,
        toolName: OpenClawToolName.ASK_USER_QUESTION,
        interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
        toolInput: {
          questions: request.questions,
          waitPolicy: request.waitPolicy,
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
          ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
          sessionId,
        },
      },
    };
  }

  private parseAskUserInteractionRequest(
    interaction: AskUserInteractionEnvelope,
  ): AskUserRequest | null {
    return parseAskUserRequest({
      requestId: interaction.request.requestId,
      ...interaction.request.toolInput,
    });
  }

  private sendAskUserInteraction(interaction: AskUserInteractionEnvelope): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(CoworkInteractionIpc.Stream, interaction);
      }
    }
  }

  private sendAskUserDismiss(requestId: string): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(CoworkInteractionIpc.Dismiss, { requestId });
      }
    }
  }

  private rememberTerminalAskUser(requestId: string): void {
    this.terminalAskUserIds.add(requestId);
    while (this.terminalAskUserIds.size > ASK_USER_TERMINAL_CACHE_SIZE) {
      const oldestRequestId = this.terminalAskUserIds.values().next().value;
      if (typeof oldestRequestId !== 'string') break;
      this.terminalAskUserIds.delete(oldestRequestId);
    }
  }

  private handleAskUserRequested(payload: unknown): void {
    const request = parseAskUserRequest(payload);
    if (!request) {
      coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed AskUserQuestion request');
      return;
    }
    if (this.terminalAskUserIds.has(request.requestId)) return;
    this.pendingAskUserRequests.set(request.requestId, request);
    this.sendAskUserInteraction(this.toAskUserInteraction(request));
  }

  private handleAskUserResolved(payload: unknown): void {
    if (
      !isRecord(payload) ||
      typeof payload.requestId !== 'string' ||
      !payload.requestId.trim() ||
      !['answered', 'cancelled', 'timeout'].includes(String(payload.status))
    ) {
      return;
    }
    const requestId = payload.requestId.trim();
    this.rememberTerminalAskUser(requestId);
    if (!this.pendingAskUserRequests.delete(requestId)) return;
    this.sendAskUserDismiss(requestId);
  }

  private async readPendingAskUserInteractions(
    client: GatewayClientLike,
  ): Promise<AskUserInteractionEnvelope[]> {
    const result = await client.request(AskUserQuestionGateway.LIST, {});
    if (!isRecord(result) || !Array.isArray(result.requests)) {
      throw new Error('AskUserQuestion list returned an invalid payload.');
    }
    const interactions: AskUserInteractionEnvelope[] = [];
    for (const [index, rawRequest] of result.requests.entries()) {
      const request = parseAskUserRequest(rawRequest);
      if (!request) {
        coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed AskUserQuestion list entry', {
          index,
        });
        continue;
      }
      if (this.terminalAskUserIds.has(request.requestId)) continue;
      interactions.push(this.toAskUserInteraction(request));
    }
    return interactions;
  }

  async listPendingAskUserInteractions(): Promise<AskUserInteractionEnvelope[]> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const generation = this.gatewayClientGeneration;
    const interactions = await this.readPendingAskUserInteractions(client);
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
    for (const interaction of interactions) {
      const request = this.parseAskUserInteractionRequest(interaction);
      if (request) this.pendingAskUserRequests.set(request.requestId, request);
    }
    return interactions;
  }

  async resolveAskUserInteraction(
    requestId: string,
    response: { behavior: 'submit'; answers: unknown } | { behavior: 'cancel' },
  ): Promise<{ sessionId: string }> {
    const normalizedRequestId = requestId.trim();
    const pending = this.pendingAskUserRequests.get(normalizedRequestId);
    if (!normalizedRequestId || !pending) {
      throw new Error('This question is not an active JustDo AskUserQuestion interaction.');
    }
    const answers =
      response.behavior === 'submit'
        ? parseAskUserAnswers(response.answers, pending.questions)
        : undefined;
    if (response.behavior === 'submit' && !answers) {
      throw new Error('The submitted answers do not match the pending question.');
    }
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request(AskUserQuestionGateway.RESOLVE, {
      requestId: normalizedRequestId,
      behavior: response.behavior,
      ...(answers ? { answers } : {}),
    });
    if (
      !isRecord(result) ||
      result.requestId !== normalizedRequestId ||
      !['answered', 'cancelled'].includes(String(result.status))
    ) {
      throw new Error('AskUserQuestion resolve returned an invalid payload.');
    }
    this.rememberTerminalAskUser(normalizedRequestId);
    if (this.pendingAskUserRequests.delete(normalizedRequestId)) {
      this.sendAskUserDismiss(normalizedRequestId);
    }
    return { sessionId: this.resolveAskUserSessionId(pending) };
  }

  private async reconcilePendingAskUserInteractions(generation: number): Promise<void> {
    const client = this.gatewayClient;
    if (!client) return;
    try {
      const interactions = await this.readPendingAskUserInteractions(client);
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return;
      for (const interaction of interactions) {
        if (!this.terminalAskUserIds.has(interaction.request.requestId)) {
          const request = this.parseAskUserInteractionRequest(interaction);
          if (!request) continue;
          this.pendingAskUserRequests.set(request.requestId, request);
          this.sendAskUserInteraction(interaction);
        }
      }
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to recover pending AskUserQuestion requests', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dismissAllAskUserInteractions(): void {
    for (const requestId of this.pendingAskUserRequests.keys()) {
      this.sendAskUserDismiss(requestId);
    }
    this.pendingAskUserRequests.clear();
    this.terminalAskUserIds.clear();
  }

  private broadcastApproval(channel: string, kind: ApprovalKind, payload: unknown): void {
    if (!isRecord(payload)) return;
    const normalizedPayload = { ...payload, kind };
    const reconciliation = this.approvalReconciliation;
    if (reconciliation?.generation === this.gatewayClientGeneration) {
      reconciliation.events.push({ channel, payload: normalizedPayload });
      return;
    }
    this.sendApprovalPayload(channel, normalizedPayload);
  }

  private sendApprovalPayload(channel: string, payload: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  private broadcastGoalExecution(snapshot: GoalExecutionSnapshot): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(GoalExecutionIpc.Changed, snapshot);
      }
    }
  }

  private normalizeExecApprovalRequest(payload: unknown): ExecApprovalRequest | null {
    if (!isRecord(payload) || typeof payload.id !== 'string' || !isRecord(payload.request)) {
      return null;
    }
    return payload as unknown as ExecApprovalRequest;
  }

  private async tryAutoResolveSessionApproval(request: ExecApprovalRequest): Promise<boolean> {
    if (!this.sessionExecApprovalGrants.matches(request)) return false;
    try {
      await this.resolveApprovalAllowOnce(ApprovalKind.Exec, request.id);
      return true;
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to apply session exec approval grant', {
        approvalId: request.id,
        sessionKey: request.request.sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private resolveApprovalAllowOnce(kind: ApprovalKind, id: string): Promise<void> {
    const key = `${kind}:${id}`;
    const current = this.approvalResolutionByKey.get(key);
    if (current) return current;
    const client = this.gatewayClient;
    if (!client) return Promise.reject(new Error('OpenClaw Gateway is unavailable.'));
    const resolving = client
      .request(kind === ApprovalKind.Plugin ? 'plugin.approval.resolve' : 'exec.approval.resolve', {
        id,
        decision: ExecApprovalDecision.AllowOnce,
      })
      .then((): void => undefined)
      .finally((): void => {
        this.approvalResolutionByKey.delete(key);
      });
    this.approvalResolutionByKey.set(key, resolving);
    return resolving;
  }

  private async handleExecApprovalRequested(payload: unknown): Promise<void> {
    const request = this.normalizeExecApprovalRequest(payload);
    if (!request || !(await this.tryAutoResolveSessionApproval(request))) {
      this.broadcastApproval(OpenClawApprovalIpc.Requested, ApprovalKind.Exec, payload);
    }
  }

  private handlePluginApprovalRequested(payload: unknown): void {
    this.broadcastApproval(OpenClawApprovalIpc.Requested, ApprovalKind.Plugin, payload);
  }

  async listPendingApprovals(): Promise<ApprovalRequest[]> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const [execRequests, pluginRequests] = await Promise.all([
      client.request<ExecApprovalRequest[]>('exec.approval.list'),
      client.request<PluginApprovalRequest[]>('plugin.approval.list'),
    ]);
    const requests: ApprovalRequest[] = [];
    for (const request of Array.isArray(execRequests) ? execRequests : []) {
      if (!(await this.tryAutoResolveSessionApproval(request))) {
        requests.push({ ...request, kind: ApprovalKind.Exec });
      }
    }
    for (const request of Array.isArray(pluginRequests) ? pluginRequests : []) {
      requests.push({ ...request, kind: ApprovalKind.Plugin });
    }
    return requests.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  async resolveApproval(
    id: string,
    decision: ApprovalDecisionValue,
    kind: ApprovalKind,
  ): Promise<void> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    if (decision !== ApprovalDecision.AllowForSession) {
      if (decision === ApprovalDecision.AllowOnce) {
        await this.resolveApprovalAllowOnce(kind, id);
        return;
      }
      await client.request(
        kind === ApprovalKind.Plugin ? 'plugin.approval.resolve' : 'exec.approval.resolve',
        { id, decision },
      );
      return;
    }
    if (kind !== ApprovalKind.Exec) {
      throw new Error('Session approval is only available for host commands.');
    }

    const pending = await client.request<ExecApprovalRequest[]>('exec.approval.list');
    const request = Array.isArray(pending) ? pending.find(item => item.id === id) : undefined;
    if (!request || !buildSessionExecApprovalFingerprint(request)) {
      throw new Error('The pending command cannot be granted for this session.');
    }
    await this.resolveApprovalAllowOnce(ApprovalKind.Exec, id);
    this.sessionExecApprovalGrants.grant(request);
  }

  clearSessionExecApprovalGrants(sessionKey: string): void {
    this.sessionExecApprovalGrants.clearSession(sessionKey);
  }

  private async reconcilePendingApprovals(
    expectedGeneration = this.gatewayClientGeneration,
  ): Promise<void> {
    const reconciliation = { generation: expectedGeneration, events: [] as Array<{
      channel: string;
      payload: Record<string, unknown>;
    }> };
    this.approvalReconciliation = reconciliation;
    try {
      const requests = await this.listPendingApprovals();
      if (expectedGeneration !== this.gatewayClientGeneration) return;
      this.sendApprovalPayload(OpenClawApprovalIpc.Snapshot, requests);
      if (this.approvalReconciliation === reconciliation) {
        this.approvalReconciliation = null;
        for (const event of reconciliation.events) {
          this.sendApprovalPayload(event.channel, event.payload);
        }
      }
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to reconcile pending approvals', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.approvalReconciliation === reconciliation) {
        this.approvalReconciliation = null;
        if (expectedGeneration === this.gatewayClientGeneration) {
          for (const event of reconciliation.events) {
            this.sendApprovalPayload(event.channel, event.payload);
          }
        }
      }
    }
  }

  private handleSessionOperationEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (!sessionKey) return;
    if (payload.operation === 'reset' || payload.operation === 'delete') {
      this.sessionExecApprovalGrants.clearSession(sessionKey);
      return;
    }
    if (payload.operation !== 'compact') return;
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
      this.clearCompactionInFlight(sessionId);
      this.compactionInFlightSessionIds.add(sessionId);
      const compactionTimer = setTimeout(() => {
        if (this.compactionInFlightTimers.get(sessionId) !== compactionTimer) return;
        this.compactionInFlightTimers.delete(sessionId);
        this.compactionInFlightSessionIds.delete(sessionId);
        const activeTurn = this.activeTurns.get(sessionId);
        if (activeTurn && this.terminalLifecycleSessionIds.has(sessionId)) {
          this.scheduleLifecycleEndFallback(sessionId, activeTurn);
        }
      }, COMPACTION_IN_FLIGHT_TIMEOUT_MS);
      compactionTimer.unref?.();
      this.compactionInFlightTimers.set(sessionId, compactionTimer);
      const timer = this.lifecycleEndFallbackTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.lifecycleEndFallbackTimers.delete(sessionId);
      }
      return;
    }
    if (phase !== 'end' && phase !== 'error' && phase !== 'failed') return;
    this.clearCompactionInFlight(sessionId);
    if (turn && this.terminalLifecycleSessionIds.has(sessionId)) {
      this.scheduleLifecycleEndFallback(sessionId, turn);
    }
  }

  private clearCompactionInFlight(sessionId: string): void {
    const timer = this.compactionInFlightTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.compactionInFlightTimers.delete(sessionId);
    this.compactionInFlightSessionIds.delete(sessionId);
  }

  private clearAllCompactionInFlight(): void {
    for (const timer of this.compactionInFlightTimers.values()) clearTimeout(timer);
    this.compactionInFlightTimers.clear();
    this.compactionInFlightSessionIds.clear();
  }

  private handleSessionsChangedEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    this.invalidateRuntimeSessionSnapshot();
    const source = isRecord(payload.session) ? payload.session : payload;
    const sessionKey =
      (typeof source.key === 'string' && source.key.trim()) ||
      (typeof payload.sessionKey === 'string' && payload.sessionKey.trim()) ||
      (typeof payload.key === 'string' && payload.key.trim()) ||
      '';
    if (!sessionKey) return;
    const reason = typeof payload.reason === 'string' ? payload.reason.trim().toLowerCase() : '';
    if (reason === 'delete' || reason === 'reset' || reason === 'new') {
      this.sessionExecApprovalGrants.clearSession(sessionKey);
    }
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (!sessionId) return;

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(SessionGoalIpc.Changed, { sessionId });
      }
    }

    const turn = this.activeTurns.get(sessionId);
    const hasActiveRun = source.hasActiveRun === true;
    const status = typeof source.status === 'string' ? source.status.trim().toLowerCase() : '';
    const shouldClearRun = Boolean(turn) && !hasActiveRun && status && status !== 'running';
    if (!shouldClearRun) return;

    const terminalStatus: CoworkSessionStatus = ERROR_TERMINAL_SESSION_STATUSES.has(status)
      ? 'error'
      : 'idle';
    this.rememberTerminalTurn(turn);
    this.cleanupSessionTurn(sessionId);
    this.store.updateSession(sessionId, { status: terminalStatus });
    this.resolveTurn(sessionId);
    this.emit('complete', sessionId, terminalStatus);
  }

  private isAnnounceRunId(runId: string): boolean {
    return runId.startsWith('announce:v1:');
  }

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

  private rememberTerminalTurn(turn: SessionTurn): void {
    for (const runId of turn.knownRunIds) this.rememberTerminalRun(runId);
    this.rememberTerminalRun(turn.runId);
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
      for (const runId of turn.knownRunIds) {
        this.sessionIdByRunId.delete(runId);
      }
    }
    this.activeTurns.delete(sessionId);
    this.clearCompactionInFlight(sessionId);
  }

  private scheduleLifecycleEndFallback(sessionId: string, turn: SessionTurn): void {
    if (this.compactionInFlightSessionIds.has(sessionId)) return;
    const existingTimer = this.lifecycleEndFallbackTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.lifecycleEndFallbackTimers.delete(sessionId);
      if (this.activeTurns.get(sessionId) !== turn) return;
      const terminalStatus = this.terminalLifecycleErrorSessionIds.has(sessionId)
        ? 'error'
        : 'idle';
      this.rememberTerminalTurn(turn);
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: terminalStatus });
      this.resolveTurn(sessionId);
      this.emit('complete', sessionId, terminalStatus);
    }, LIFECYCLE_END_FALLBACK_MS);
    this.lifecycleEndFallbackTimers.set(sessionId, timer);
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    if (this.isSessionInStopCooldown(sessionId)) return;
    if (this.manuallyStoppedSessions.has(sessionId)) {
      this.manuallyStoppedSessions.delete(sessionId);
    }
    this.terminalLifecycleSessionIds.delete(sessionId);
    this.terminalLifecycleErrorSessionIds.delete(sessionId);
    this.clearCompactionInFlight(sessionId);

    const turnRunId = runId || randomUUID();
    const turnToken = this.nextTurnToken(sessionId);

    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId: turnRunId,
      gatewaySessionId: null,
      lifecycleGeneration: null,
      lastAgentSeq: -1,
      status: 'running',
      turnToken,
      stopRequested: false,
      knownRunIds: runId ? new Set([runId]) : new Set([turnRunId]),
    });
    if (runId) this.sessionIdByRunId.set(runId, sessionId);
    this.store.updateSession(sessionId, { status: 'running' });
    this.emit('activity', sessionId, 'user', Date.now());
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
    await this.stopSessionInternal(sessionId, {}, false);
  }

  private startTurnTimeoutWatchdog(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    const timeoutMs = this.agentTimeoutSeconds * 1000 + CLIENT_TIMEOUT_GRACE_MS;
    setTimeout(() => {
      void this.handleTurnTimeoutWatchdog(sessionId, turn);
    }, timeoutMs);
  }

  private async handleTurnTimeoutWatchdog(sessionId: string, turn: SessionTurn): Promise<void> {
    const currentTurn = this.activeTurns.get(sessionId);
    if (!currentTurn || currentTurn.turnToken !== turn.turnToken) return;

    const client = this.gatewayClient;
    if (isManagedSessionKey(turn.sessionKey)) {
      try {
        if (client) await this.collectRunningSubagentSessionKeys(client, [turn.sessionKey]);
      } catch (error) {
        coworkLog('WARN', 'OpenClawRuntime', 'Failed to inspect subagents at turn timeout', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const latestTurn = this.activeTurns.get(sessionId);
      if (!latestTurn || latestTurn.turnToken !== turn.turnToken) return;
      // Managed chat.send has no Gateway deadline. Its local watchdog must not
      // manufacture a terminal state while the same run is between incremental
      // joins, processing a Tool Result, waiting on a child, or temporarily
      // unable to query Gateway state. Explicit Stop and lifecycle terminal
      // events remain authoritative.
      this.startTurnTimeoutWatchdog(sessionId);
      return;
    }

    this.rememberTerminalTurn(turn);
    this.cleanupSessionTurn(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.terminalLifecycleSessionIds.add(sessionId);
    this.terminalLifecycleErrorSessionIds.delete(sessionId);
    this.resolveTurn(sessionId);
    this.emit('complete', sessionId, 'idle');
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

    // Managed keys embed the local session ID. Recover the mapping after a
    // reconnect or other in-memory cache gap so a terminal lifecycle event
    // cannot strand an otherwise active Goal. The store and agent checks keep
    // arbitrary or cross-agent Gateway keys out of local sessions.
    const managedKey = parseManagedSessionKey(sessionKey);
    if (managedKey) {
      const managedSession = this.store.getSession(managedKey.sessionId);
      const managedAgentId = managedSession?.agentId?.trim() || DEFAULT_MANAGED_AGENT_ID;
      if (!managedSession || (managedKey.agentId && managedKey.agentId !== managedAgentId)) {
        return null;
      }
      this.rememberSessionKey(managedKey.sessionId, sessionKey);
      return managedKey.sessionId;
    }

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

  // ─── Gateway Connection Management ──────────────────────────────────────

  async connectGatewayIfNeeded(): Promise<void> {
    if (this.gatewayClient) return;
    await this.ensureGatewayClientReady();
  }

  private async ensureAutomationPermissionPolicyReady(): Promise<void> {
    if (this.automationPermissionVerifiedGeneration === this.gatewayClientGeneration) return;
    const generation = this.gatewayClientGeneration;
    const client = this.requireGatewayClient();
    const result = await client.request<{ loaded?: unknown; policyId?: unknown }>(
      'automationPermission.info',
    );
    if (result.loaded !== true || result.policyId !== AUTOMATION_PERMISSION_POLICY_ID) {
      throw new Error('OpenClaw automation permission policy is unavailable.');
    }
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
      throw new Error('OpenClaw Gateway connection changed');
    }
    this.automationPermissionVerifiedGeneration = generation;
  }

  async reconnectGateway(): Promise<void> {
    this.stopGatewayClient();
    try {
      await this.ensureGatewayClientReady();
      this.gatewayReconnectAttempt = 0;
    } catch (error) {
      this.scheduleGatewayReconnect();
      throw error;
    }
  }

  disconnectGatewayClient(): void {
    this.stopGatewayClient();
  }

  private async ensureGatewayClientReady(): Promise<void> {
    if (this.gatewayClient) {
      await this.ensureAutomationPermissionPolicyReady();
      return;
    }

    if (this.gatewayClientInitLock) {
      await this.gatewayClientInitLock;
      await this.ensureAutomationPermissionPolicyReady();
      return;
    }
    this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
    try {
      await this.gatewayClientInitLock;
      await this.ensureAutomationPermissionPolicyReady();
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
      scopes: ['operator.admin', 'operator.approvals', 'operator.questions'],
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
        void this.handleGatewayReady(generation);
        void this.reconcilePendingApprovals(generation);
        void this.reconcilePendingAskUserInteractions(generation);
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
    this.goalContinuationCoordinator.clear();
    this.cancelGoalRecovery();
    this.dismissAllAskUserInteractions();
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
    this.invalidateRuntimeSessionSnapshot();
    this.stoppedSessions.clear();
    this.clearAllCompactionInFlight();
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
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

  private async handleGatewayReady(generation: number): Promise<void> {
    await this.subscribeGatewaySessions();
    await this.recoverActiveGoals(generation, {
      stopGoalsCreatedBeforeMs: this.initialGatewayGoalRecoveryPending
        ? this.appStartedAtMs
        : undefined,
    });
  }

  private async recoverActiveGoals(
    generation: number,
    options: { stopGoalsCreatedBeforeMs?: number } = {},
  ): Promise<void> {
    if (generation !== this.gatewayClientGeneration || this.goalRecoveryGeneration === generation) {
      return;
    }
    if (this.goalRecoveryTimer) {
      clearTimeout(this.goalRecoveryTimer);
      this.goalRecoveryTimer = null;
    }
    this.goalRecoveryGeneration = generation;
    try {
      const runtimeSnapshot = await this.getRuntimeSessionSnapshot(true);
      if (generation !== this.gatewayClientGeneration || !this.gatewayClient) return;
      if (!runtimeSnapshot.known) {
        this.goalRecoveryGeneration = null;
        this.scheduleGoalRecovery(generation, options);
        return;
      }
      let hadInspectionFailure = false;
      const runtimeRowsByKey = new Map(
        runtimeSnapshot.sessions
          .map(row => [this.runtimeRowString(row.key), row] as const)
          .filter(([key]) => Boolean(key)),
      );
      for (const session of this.store.listSessions()) {
        if (generation !== this.gatewayClientGeneration || !this.gatewayClient) return;
        const candidateKeys = [
          ...this.getSessionKeysForSession(session.id),
          buildManagedSessionKey(session.id, session.agentId || DEFAULT_MANAGED_AGENT_ID),
          buildManagedSessionKey(session.id, DEFAULT_MANAGED_AGENT_ID),
        ];
        for (const candidateKey of new Set(candidateKeys)) {
          let result: { session?: { key?: string; goal?: unknown } | null };
          const listedSession = runtimeRowsByKey.get(candidateKey);
          if (listedSession) {
            result = { session: listedSession };
          } else {
            // A complete sessions.list response is authoritative. Only fall back to
            // per-key inspection when the Gateway reports that the list was truncated.
            if (!runtimeSnapshot.hasMore) continue;
            try {
              result = await this.gatewayClient.request('sessions.describe', {
                key: candidateKey,
              });
            } catch (error) {
              hadInspectionFailure = true;
              coworkLog('WARN', 'GoalContinuation', 'Failed to inspect a goal during recovery', {
                sessionId: session.id,
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
          }
          if (generation !== this.gatewayClientGeneration || !this.gatewayClient) return;
          if (!result.session || !isRecord(result.session.goal)) continue;
          if (result.session.goal.status !== SessionGoalStatus.Active) continue;
          const goalId =
            typeof result.session.goal.id === 'string' ? result.session.goal.id.trim() : '';
          if (!goalId) continue;
          const sessionKey = result.session.key?.trim() || candidateKey;
          this.rememberSessionKey(session.id, sessionKey);
          const persistedExecution = this.store.getGoalExecutionSnapshot?.(session.id) ?? null;
          if (
            persistedExecution &&
            (persistedExecution.identityPending === true ||
              persistedExecution.goalId === goalId) &&
            (persistedExecution.phase === GoalExecutionPhase.AwaitingConfirmation ||
              persistedExecution.phase === GoalExecutionPhase.AwaitingInput ||
              persistedExecution.phase === GoalExecutionPhase.Stopped)
          ) {
            this.goalContinuationCoordinator.restoreSnapshot({
              ...persistedExecution,
              goalId,
              identityPending: false,
            });
            break;
          }
          if (this.goalsAwaitingResumeInput.get(session.id) === goalId) break;
          const activeTurn = this.activeTurns.get(session.id);
          if (activeTurn) {
            this.goalIdsActivatedThisApp.add(`${session.id}:${goalId}`);
            this.goalContinuationCoordinator.restoreRunning(
              session.id,
              goalId,
              activeTurn.runId,
            );
            break;
          }
          const runtimeRow = runtimeRowsByKey.get(sessionKey);
          if (runtimeRow?.hasActiveRun === true) {
            const runId = this.runtimeRowString(runtimeRow.runId);
            this.goalIdsActivatedThisApp.add(`${session.id}:${goalId}`);
            this.goalContinuationCoordinator.restoreRunning(
              session.id,
              goalId,
              runId || undefined,
            );
            break;
          }
          // A user turn can pass readiness before chat.send has established
          // activeTurns. Do not auto-continue an older Goal in that window.
          if (this.goalSessionsActivatingThisApp.has(session.id)) break;
          const goalCreatedAt = result.session.goal.createdAt;
          const belongsToPriorApp =
            options.stopGoalsCreatedBeforeMs !== undefined &&
            !this.goalIdsActivatedThisApp.has(`${session.id}:${goalId}`) &&
            (typeof goalCreatedAt !== 'number' ||
              !Number.isFinite(goalCreatedAt) ||
              goalCreatedAt < options.stopGoalsCreatedBeforeMs);
          if (belongsToPriorApp) {
            this.goalContinuationCoordinator.restoreSnapshot({
              sessionId: session.id,
              goalId,
              phase: GoalExecutionPhase.Stopped,
              continuationCount: persistedExecution?.continuationCount ?? 0,
              updatedAt: Date.now(),
            });
            break;
          }
          if (runtimeRow && this.isRuntimeSessionRowActive(runtimeRow)) {
            const runId = this.runtimeRowString(runtimeRow.runId);
            this.goalContinuationCoordinator.restoreRunning(
              session.id,
              goalId,
              runId || undefined,
            );
          } else {
            await this.prepareSessionKey(session.id, sessionKey);
            await this.goalContinuationCoordinator.continue(session.id, sessionKey);
          }
          break;
        }
      }
      if (generation !== this.gatewayClientGeneration || !this.gatewayClient) return;
      if (hadInspectionFailure && generation === this.gatewayClientGeneration) {
        this.goalRecoveryGeneration = null;
        this.scheduleGoalRecovery(generation, options);
      } else if (options.stopGoalsCreatedBeforeMs !== undefined) {
        this.initialGatewayGoalRecoveryPending = false;
        this.goalSessionsActivatingThisApp.clear();
      }
    } catch (error) {
      if (generation === this.gatewayClientGeneration) {
        this.goalRecoveryGeneration = null;
        this.scheduleGoalRecovery(generation, options);
        coworkLog('WARN', 'GoalContinuation', 'Failed to recover active goals after reconnect', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private scheduleGoalRecovery(
    generation: number,
    options: { stopGoalsCreatedBeforeMs?: number } = {},
  ): void {
    if (this.goalRecoveryTimer || generation !== this.gatewayClientGeneration) return;
    this.goalRecoveryTimer = setTimeout(() => {
      this.goalRecoveryTimer = null;
      void this.recoverActiveGoals(generation, options);
    }, 2_000);
  }

  private cancelGoalRecovery(): void {
    if (this.goalRecoveryTimer) clearTimeout(this.goalRecoveryTimer);
    this.goalRecoveryTimer = null;
    this.goalRecoveryGeneration = null;
  }

  /** Clean up internal gateway client state without calling client.stop().
   *  Used when the connection is already closed (onClose) — calling stop()
   *  on a closed connection would reject all pending requests with
   *  "gateway client stopped" noise. */
  private cleanupGatewayClientState(): void {
    this.goalContinuationCoordinator.clear();
    this.cancelGoalRecovery();
    this.dismissAllAskUserInteractions();
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.invalidateRuntimeSessionSnapshot();
    this.stoppedSessions.clear();
    this.clearAllCompactionInFlight();
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
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
    if (this.gatewayReconnectTimer) return;
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

    for (const key of removedKeys) {
      this.sessionExecApprovalGrants.clearSession(key);
    }
    this.latestTurnTokenBySession.delete(sessionId);
    this.stoppedSessions.delete(sessionId);
    this.cleanupSessionTurn(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.rootRunIdBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.goalsAwaitingResumeInput.delete(sessionId);
    this.terminalLifecycleSessionIds.delete(sessionId);
    this.terminalLifecycleErrorSessionIds.delete(sessionId);
    this.invalidateSubagentStatus(sessionId);
    this.subagentStatusRefreshes.delete(sessionId);
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
        this.sessionExecApprovalGrants.clearSession(sessionKey);
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

  async getSubagentStatuses(sessionId?: string, forceRefresh = false): Promise<{
    subagents: Array<{
      id: string;
      taskName: string;
      sessionKey: string;
      sessionId?: string;
      label: string;
      labelSource: SubagentLabelSource;
      status: SubagentStatus;
      task?: string;
      model?: string;
      startedAt?: number;
      updatedAt?: number;
      endedAt?: number;
      runtimeMs?: number;
      totalTokens?: number;
      progressSummary?: string;
      terminalSummary?: string;
      error?: string;
      lastActivity?: string;
      lastToolName?: string;
      toolUseCount?: number;
    }>;
  }> {
    if (!sessionId) return { subagents: [] };
    if (forceRefresh) this.invalidateSubagentStatusSnapshot(sessionId);
    const cached = this.subagentStatusCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) {
      return { subagents: cached.subagents };
    }

    let refresh = this.subagentStatusRefreshes.get(sessionId);
    if (!refresh) {
      refresh = this.refreshSubagentStatuses(sessionId);
      this.subagentStatusRefreshes.set(sessionId, refresh);
      const clearRefresh = () => {
        if (this.subagentStatusRefreshes.get(sessionId) === refresh) {
          this.subagentStatusRefreshes.delete(sessionId);
        }
      };
      void refresh.then(clearRefresh, clearRefresh);
    }
    const subagents = await refresh;
    return {
      subagents,
    };
  }

  private async refreshSubagentStatuses(sessionId: string): Promise<GatewaySubagent[]> {
    await this.ensureGatewayClientReady();
    if (!this.gatewayClient) return [];

    const now = Date.now();
    const refreshGeneration = this.subagentStatusGenerations.get(sessionId) ?? 0;
    const retained = this.subagentDetailCache.get(sessionId);
    let detailHydrationRequested = !retained || retained.expiresAt <= now;
    const listing = await listGatewaySubagentsWithMetadata({
      client: this.gatewayClient,
      parentKeys: this.getSessionKeysForSession(sessionId),
      hydrateDetails: detailHydrationRequested,
      hydrateTaskDetails: false,
    });
    let current = listing.subagents;
    let taskLedgerComplete = !detailHydrationRequested || listing.taskLedgerComplete;
    const currentKeys = new Set(current.map(subagent => subagent.sessionKey));
    const retainedActiveMissing = retained?.subagents.some(
      subagent =>
        (subagent.status === SUBAGENT_STATUSES.PENDING ||
          subagent.status === SUBAGENT_STATUSES.RUNNING) &&
        !currentKeys.has(subagent.sessionKey),
    );
    if (!detailHydrationRequested && retainedActiveMissing) {
      const hydrated = await listGatewaySubagentsWithMetadata({
        client: this.gatewayClient,
        parentKeys: this.getSessionKeysForSession(sessionId),
        hydrateTaskDetails: false,
      });
      current = mergeGatewaySubagentSnapshots(hydrated.subagents, current);
      detailHydrationRequested = true;
      taskLedgerComplete = hydrated.taskLedgerComplete;
    }
    const replaceRetainedDetails = detailHydrationRequested && taskLedgerComplete;
    const currentWithRetainedDetails = retained
      ? current.map(subagent => {
          const previous = retained.subagents.find(candidate => candidate.id === subagent.id);
          return previous
            ? mergeGatewaySubagentSnapshots([previous], [subagent])[0] ?? subagent
            : subagent;
        })
      : current;
    const subagents =
      replaceRetainedDetails || !retained
        ? currentWithRetainedDetails
        : mergeGatewaySubagentSnapshots(retained.subagents, current);
    if (
      (this.subagentStatusGenerations.get(sessionId) ?? 0) !== refreshGeneration ||
      !this.store.getSession(sessionId)
    ) {
      return subagents;
    }
    this.subagentDetailCache.set(sessionId, {
      expiresAt: replaceRetainedDetails
        ? now + SUBAGENT_DETAIL_CACHE_TTL_MS
        : (retained?.expiresAt ?? now),
      subagents,
    });
    this.subagentStatusCache.set(sessionId, {
      expiresAt: now + SUBAGENT_STATUS_CACHE_TTL_MS,
      subagents,
    });
    return subagents;
  }

  private invalidateSubagentStatusSnapshot(sessionId: string): void {
    this.subagentStatusCache.delete(sessionId);
    // Let the next caller start an authoritative read even if an older snapshot
    // is still in flight. The generation guard prevents that stale request from
    // repopulating either cache when it eventually resolves.
    this.subagentStatusRefreshes.delete(sessionId);
    this.subagentStatusGenerations.set(
      sessionId,
      (this.subagentStatusGenerations.get(sessionId) ?? 0) + 1,
    );
  }

  private invalidateSubagentStatus(sessionId: string): void {
    this.invalidateSubagentStatusSnapshot(sessionId);
    this.subagentDetailCache.delete(sessionId);
  }

  async getSessionRuntimeStatus(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<{
    known: boolean;
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
    rootRunId?: string;
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
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<Record<string, SessionRuntimeStatus>> {
    const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
    const localMainRunning = new Map(
      uniqueSessionIds.map(sessionId => [
        sessionId,
        this.isSessionActive(sessionId) || this.compactionInFlightSessionIds.has(sessionId),
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
          ...(this.rootRunIdBySession.get(sessionId)
            ? { rootRunId: this.rootRunIdBySession.get(sessionId) }
            : {}),
        };
      }
      return statuses;
    }

    const snapshot = await this.getRuntimeSessionSnapshot(
      options?.forceRefresh === true,
      options?.fullScan === true,
    );
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
      const hasMainSessionRow = snapshot.sessions.some(row =>
        sessionKeys.has(this.runtimeRowString(row.key)),
      );
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
            subagent =>
              subagent.status === SUBAGENT_STATUSES.PENDING ||
              subagent.status === SUBAGENT_STATUSES.RUNNING,
          );
        }
      }
      const requestedStateIsCovered =
        mainRunning ||
        !snapshot.hasMore ||
        (hasMainSessionRow && options?.includeSubagents !== true) ||
        subagentRunning;
      const known = localRunning || (snapshot.known && requestedStateIsCovered);
      statuses[sessionId] = {
        known,
        mainRunning,
        subagentRunning,
        running: mainRunning || subagentRunning,
        ...(mainRunning || subagentRunning
          ? (() => {
              const rootRunId = this.rootRunIdBySession.get(sessionId);
              return rootRunId ? { rootRunId } : {};
            })()
          : {}),
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
      row.status === 'pending' ||
      row.status === 'running' ||
      row.runState === 'active' ||
      row.subagentRunState === 'active' ||
      row.subagentRunState === 'pending'
    );
  }

  private invalidateRuntimeSessionSnapshot(): void {
    this.runtimeSessionSnapshot = null;
    this.runtimeSessionSnapshotGeneration += 1;
  }

  private async getRuntimeSessionSnapshot(
    forceRefresh = false,
    fullScan = false,
  ): Promise<RuntimeSessionSnapshot> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.runtimeSessionSnapshot &&
      this.runtimeSessionSnapshot.expiresAt > now &&
      (!fullScan || !this.runtimeSessionSnapshot.hasMore)
    ) {
      return this.runtimeSessionSnapshot;
    }
    if (this.runtimeSessionSnapshotPromise) {
      const pendingSnapshot = await this.runtimeSessionSnapshotPromise;
      return forceRefresh || (fullScan && pendingSnapshot.hasMore)
        ? this.getRuntimeSessionSnapshot(forceRefresh, fullScan)
        : pendingSnapshot;
    }
    const client = this.gatewayClient;
    if (!client) return { known: false, sessions: [], hasMore: false };
    const snapshotGeneration = this.runtimeSessionSnapshotGeneration;

    this.runtimeSessionSnapshotPromise = (async (): Promise<RuntimeSessionSnapshot> => {
      const sessions: Array<Record<string, unknown>> = [];
      let offset = 0;
      while (true) {
        const result = await client.request<{
          sessions?: Array<Record<string, unknown>>;
          hasMore?: boolean;
        }>('sessions.list', {
          limit: 500,
          ...(offset > 0 ? { offset } : {}),
        });
        const page = result.sessions ?? [];
        sessions.push(...page);
        const hasMore =
          result.hasMore === true || (result.hasMore === undefined && page.length >= 500);
        if (!fullScan || !hasMore) {
          return { known: true, sessions, hasMore };
        }
        if (page.length === 0) {
          return { known: true, sessions, hasMore: true };
        }
        offset += page.length;
      }
    })()
      .catch((error): RuntimeSessionSnapshot => {
        if (now - this.lastRuntimeStatusWarningAt >= RUNTIME_STATUS_WARNING_INTERVAL_MS) {
          this.lastRuntimeStatusWarningAt = now;
          console.warn('[OpenClawRuntime] Failed to query session runtime snapshot', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { known: false, sessions: [], hasMore: false };
      })
      .then(snapshot => {
        if (snapshotGeneration !== this.runtimeSessionSnapshotGeneration) {
          return { known: false, sessions: [], hasMore: false };
        }

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

  async fetchSessionHistoryByKey(
    sessionKey: string,
    fallbackSessionId?: string | null,
  ): Promise<{ sessionKey: string; messages: unknown[] } | null> {
    const client = this.gatewayClient;
    if (!client) return null;
    try {
      const fetchHistory = async (key: string): Promise<unknown[]> => {
        const pages: unknown[][] = [];
        const seenOffsets = new Set<number>();
        let offset: number | undefined;

        while (true) {
          const raw = await client.request('chat.history', {
            sessionKey: key,
            limit: FULL_HISTORY_SYNC_LIMIT,
            ...(offset !== undefined ? { offset } : {}),
          });
          const page = parseChatHistoryResultV2026_8_2(raw);
          // chat.history starts at the newest page; increasing offset walks
          // backward through the transcript. Prepend every older page so
          // whole-history consumers receive the canonical oldest-first order.
          pages.unshift(page.messages);
          if (!page.hasMore) return pages.flat();

          const nextOffset = page.nextOffset;
          if (
            nextOffset === undefined ||
            nextOffset <= (offset ?? 0) ||
            seenOffsets.has(nextOffset)
          ) {
            throw new Error('chat.history pagination cursor did not advance');
          }
          seenOffsets.add(nextOffset);
          offset = nextOffset;
        }
      };
      let resolvedSessionKey = sessionKey;
      let history = await fetchHistory(resolvedSessionKey);

      if (history.length === 0 && fallbackSessionId?.trim()) {
        const resolved = await client
          .request<{ ok?: boolean; key?: string }>('sessions.resolve', {
            sessionId: fallbackSessionId.trim(),
            allowMissing: true,
            includeUnknown: true,
          })
          .catch((): null => null);
        const canonicalKey =
          resolved?.ok === true && typeof resolved.key === 'string' ? resolved.key.trim() : '';
        if (canonicalKey && canonicalKey !== resolvedSessionKey) {
          resolvedSessionKey = canonicalKey;
          history = await fetchHistory(resolvedSessionKey);
        }
      }

      if (history.length === 0) {
        const stored = await client
          .request<{ messages?: unknown[] }>('sessions.get', {
            key: resolvedSessionKey,
            limit: FULL_HISTORY_SYNC_LIMIT,
          })
          .catch((): null => null);
        history = Array.isArray(stored?.messages) ? stored.messages : [];
      }
      if (history.length === 0) return null;

      return {
        sessionKey: resolvedSessionKey,
        messages: history,
      };
    } catch {
      return null;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  async generateTitle(
    userIntent: string | null,
    options: CoworkGenerateTitleOptions = {},
  ): Promise<string> {
    const localSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    if (!localSessionId) {
      return this.titleGenerator.getFallbackTitle(userIntent);
    }
    const gatewaySessionId = await this.resolveGatewaySessionIdForTitle(localSessionId);
    if (!gatewaySessionId) {
      console.warn(
        '[OpenClawRuntime] Gateway session ID unavailable; using fallback session title',
        { sessionId: localSessionId },
      );
      return this.titleGenerator.getFallbackTitle(userIntent);
    }
    return this.titleGenerator.generateTitle(userIntent, {
      sessionId: gatewaySessionId,
      timeoutMs: options.timeoutMs,
    });
  }

  private async resolveGatewaySessionIdForTitle(
    localSessionId: string,
  ): Promise<string | undefined> {
    try {
      await this.ensureGatewayClientReady();
    } catch {
      return undefined;
    }

    const sessionKey = this.findSessionKeyBySessionId(localSessionId);
    if (!sessionKey) return undefined;

    const deadline = Date.now() + TITLE_SESSION_ID_RESOLUTION_TIMEOUT_MS;
    let nextSnapshotAt = 0;
    while (Date.now() <= deadline) {
      const activeSessionId = this.runtimeRowString(
        this.activeTurns.get(localSessionId)?.gatewaySessionId,
      );
      if (activeSessionId) return activeSessionId;

      const now = Date.now();
      if (now >= nextSnapshotAt) {
        const snapshot = await this.getRuntimeSessionSnapshot(true);
        const session = snapshot.sessions.find(
          row => this.runtimeRowString(row.key) === sessionKey,
        );
        if (session) {
          const snapshotSessionId =
            this.runtimeRowString(session.sessionId) || this.runtimeRowString(session.id);
          if (snapshotSessionId) return snapshotSessionId;
        }
        nextSnapshotAt = Date.now() + TITLE_SESSION_ID_SNAPSHOT_INTERVAL_MS;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(TITLE_SESSION_ID_POLL_INTERVAL_MS, remainingMs)),
      );
    }
    return undefined;
  }

  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ) {
    return this.sessionRpc.patchModel(
      sessionId,
      model,
      agentId,
      this.isSessionActive(sessionId) ? 'subsequent-calls' : 'next-turn',
    );
  }

  async getSessionModel(sessionId: string, agentId?: string) {
    return this.sessionRpc.getModel(sessionId, agentId);
  }

  async requestGateway<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureGatewayClientReady();
    return this.requireGatewayClient().request<T>(method, params);
  }
}

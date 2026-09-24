import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import path from 'path';

import { createPropertyContext } from '../../../shared/app/propertyContext';
import {
  areWorkspacePathsEquivalent,
  CLIENT_TIMEOUT_GRACE_MS,
  LIFECYCLE_END_FALLBACK_MS,
  PendingTurnStart,
  RACE_RESOLUTION_MS,
  readActiveRunIds,
  RetainedSessionGoalMutation,
  RuntimeSessionSnapshot,
  SessionAbortResponse,
  SessionRuntimeStatus,
  STOP_COOLDOWN_MS,
  TITLE_SESSION_ID_POLL_INTERVAL_MS,
  TITLE_SESSION_ID_RESOLUTION_TIMEOUT_MS,
  TITLE_SESSION_ID_SNAPSHOT_INTERVAL_MS,
} from './runtimeAdapterSupport';
import * as runtimeGatewayConnection from './runtimeGatewayConnection';
import { type RuntimeGatewayConnectionContext } from './runtimeGatewayConnection';
import * as runtimeGatewayEvents from './runtimeGatewayEvents';
import { type RuntimeGatewayEventsContext } from './runtimeGatewayEvents';
import * as runtimeGoalOperations from './runtimeGoalOperations';
import { type RuntimeGoalOperationsContext } from './runtimeGoalOperations';
import * as runtimeHistory from './runtimeHistory';
import { type RuntimeHistoryContext } from './runtimeHistory';
import * as runtimePlanInteractions from './runtimePlanInteractions';
import { type RuntimePlanInteractionsContext } from './runtimePlanInteractions';
import * as runtimeSessionStatus from './runtimeSessionStatus';
import { type RuntimeSessionStatusContext } from './runtimeSessionStatus';
export { mergeGatewayHistoryPages } from './runtimeAdapterSupport';

import { parseBrowserAnnotationPrompt } from '../../../shared/browser/browser';
import {
  type CoworkAttachmentPayload,
  toGatewayAttachment,
} from '../../../shared/cowork/attachments';
import { hasMessageInput } from '../../../shared/cowork/messageInput';
import {
  type CoworkPlanArtifactReference,
  type CoworkPlanHandoff,
} from '../../../shared/cowork/planHandoff';
import {
  GoalExecutionIpc,
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  type GoalFeedbackPreparationResult,
  normalizeSessionGoal,
  SessionGoalIpc,
  type SessionGoalMutationOutcome,
  type SessionGoalMutationRequest,
  type SessionGoalMutationResult,
  SessionGoalStatus,
} from '../../../shared/cowork/sessionGoal';
import {
  hasSlashCommandBeforeSendHook,
  parseGoalStartObjective,
  SlashCommandBeforeSendHook,
} from '../../../shared/cowork/slashCommands';
import { type NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
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
  type AskUserRequest,
  type CoworkInteractionEnvelope,
  type PlanModeInteractionEnvelope,
  type PlanModeRequest,
  type PlanModeState,
} from '../../../shared/openclaw/extensions';
import { isGatewayRequestOutcomeUnknown } from '../../../shared/openclaw/gatewayRequestOutcome';
import {
  classifyAgentEvent,
  normalizeMessageSessionKey,
} from '../../../shared/openclaw/messageDomain';
import { normalizeModelRef, readModelRef } from '../../../shared/openclaw/modelRef';
import type { ScheduledTaskSessionHistory } from '../../../shared/scheduledTask/types';
import type { ApprovedPlanArtifactStore } from '../../cowork/approvedPlans/approvedPlanArtifactStore';
import { coworkLog } from '../../cowork/coworkLogger';
import { type SessionTitleFetch, SessionTitleGenerator } from '../../cowork/sessionTitleGenerator';
import type { CoworkStore } from '../../data/coworkStore';
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
import { resolveRawApiConfig } from '../../providers/providerApiConfig';
import { isRecord } from '../gateway/helpers';
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
import { type GatewaySubagent, listGatewaySubagents, SUBAGENT_STATUSES } from './subagentGateway';

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
  private readonly disconnectedSessionIds = new Set<string>();
  private readonly unknownSessionRuns = new Map<
    string,
    { runId: string; cancelled: boolean; onConfirmed?: () => void }
  >();
  private readonly disconnectedRecoveryPromises = new Map<string, Promise<void>>();
  private readonly terminalLifecycleSessionIds = new Set<string>();
  private readonly terminalLifecycleErrorSessionIds = new Set<string>();
  private readonly recentTerminalRunIds = new Map<string, number>();
  private readonly compactionInFlightSessionIds = new Set<string>();
  private readonly lifecycleEndFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  private readonly goalMutationOperations = new Map<string, RetainedSessionGoalMutation>();

  // Tick watchdog
  private lastTickTimestamp = 0;
  private lastAgentActivityTimestamp = 0;
  private legacyAgentSequence = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Channel session sync
  private readonly latestTurnTokenBySession = new Map<string, number>();
  private readonly sessionExecApprovalGrants = new SessionExecApprovalGrants();
  private readonly approvalResolutionByKey = new Map<string, Promise<void>>();
  private readonly planResolutionByRequestId = new Map<string, Promise<{ sessionId: string }>>();
  private approvalReconciliation: {
    generation: number;
    events: Array<{ channel: string; payload: Record<string, unknown> }>;
  } | null = null;
  private readonly pendingAskUserRequests = new Map<string, AskUserRequest>();
  private readonly pendingPlanModeRequests = new Map<string, PlanModeRequest>();
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
  private readonly sessionHistorySnapshots = new Map<
    string,
    { messages: unknown[]; deltaCursor: string }
  >();

  // Collaborators
  private sessionRpc!: SessionRpc;
  private titleGenerator!: SessionTitleGenerator;
  private readonly goalContinuationCoordinator: GoalContinuationCoordinator;

  get agentTimeoutSeconds(): number {
    return this.store.getAgentRuntimeSettings().agent.runTimeoutSeconds;
  }

  constructor(
    store: CoworkStore,
    engineManager: OpenClawEngineManager,
    titleFetch?: SessionTitleFetch,
    private readonly approvedPlanArtifactStore?: Pick<
      ApprovedPlanArtifactStore,
      'publish' | 'readVerified'
    > &
      Partial<
        Pick<ApprovedPlanArtifactStore, 'cleanupStaleTemporaryFiles' | 'removeSessionArtifacts'>
      >,
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
      waitBeforeAutomaticContinuation: () => new Promise(resolve => setTimeout(resolve, 1_600)),
    });

    this.titleGenerator = new SessionTitleGenerator({
      resolveApiConfig: () => resolveRawApiConfig(),
      fetch: titleFetch,
    });
    this.sessionRpc = new SessionRpc({
      getGatewayClient: () => this.gatewayClient,
      store: this.store,
      resolveSessionKey: (sessionId, agentId) => this.toSessionKey(sessionId, agentId),
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
      planMode: options.planMode,
      untrustedContext: options.untrustedContext,
      onAccepted: options.onAccepted,
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

  setContinuationPermissionPreparer(preparer: ((sessionId: string) => Promise<void>) | null): void {
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
    this.assertPreparedSessionEntry(result.entry, nativePermissionMode, workspaceRoot);

    this.rememberSessionKey(sessionId, sessionKey);
    return { sessionKey, gatewaySessionId };
  }

  private assertPreparedSessionEntry(
    entry: Record<string, unknown> | undefined,
    permissionMode: string,
    workspaceRoot: string,
    expectedModelRef?: string,
  ): void {
    if (entry?.permissionMode !== permissionMode) {
      throw new Error('OpenClaw did not persist the requested session permission mode.');
    }
    if (
      typeof entry.sessionRoot !== 'string' ||
      !areWorkspacePathsEquivalent(entry.sessionRoot, workspaceRoot)
    ) {
      throw new Error('OpenClaw did not persist the requested session workspace boundary.');
    }
    if (!expectedModelRef) return;
    const persistedModelRef =
      normalizeModelRef(entry.modelOverride, entry.providerOverride) ?? readModelRef(entry);
    if (persistedModelRef !== expectedModelRef) {
      throw new Error('OpenClaw did not persist the requested session model.');
    }
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

  registerUnknownSessionRun(
    sessionId: string,
    runId: string,
    options: { cancelled?: boolean; onConfirmed?: () => void } = {},
  ): void {
    const existing = this.unknownSessionRuns.get(sessionId);
    const current = this.activeTurns.get(sessionId);
    if (current && current.runId !== runId) return;
    const session = this.store.getSession(sessionId);
    if (!session || !runId.trim()) return;
    // A very short run can finish while chat.send is still waiting for an ACK.
    // Its terminal event is authoritative admission evidence; do not reopen a
    // completed turn and wait forever for an event that has already arrived.
    if (this.isRecentTerminalRun(runId)) {
      options.onConfirmed?.();
      return;
    }
    // A stop ACK may have retired local state before the lost-send-ACK report
    // arrives. Reopen only tracking, never dispatch; agent.wait revalidates truth.
    const stoppedLocally = this.stoppedSessions.has(sessionId);
    this.stoppedSessions.delete(sessionId);
    const sessionKey =
      current?.sessionKey ??
      buildManagedSessionKey(sessionId, session.agentId || DEFAULT_MANAGED_AGENT_ID);
    this.ensureActiveTurn(sessionId, sessionKey, runId);
    if (existing?.runId === runId) {
      existing.cancelled ||= options.cancelled === true || stoppedLocally;
      existing.onConfirmed ??= options.onConfirmed;
    } else {
      this.unknownSessionRuns.set(sessionId, {
        runId,
        cancelled: options.cancelled === true || stoppedLocally,
        ...(options.onConfirmed ? { onConfirmed: options.onConfirmed } : {}),
      });
    }
    this.disconnectedSessionIds.add(sessionId);
  }

  private confirmUnknownSessionRunAdmission(sessionId: string, turn: SessionTurn): void {
    const unknownRun = this.unknownSessionRuns.get(sessionId);
    if (!unknownRun || !turn.knownRunIds.has(unknownRun.runId)) return;
    const onConfirmed = unknownRun.onConfirmed;
    unknownRun.onConfirmed = undefined;
    onConfirmed?.();
  }

  private async stopSessionInternal(
    sessionId: string,
    options: CoworkStopOptions,
    cancelPendingStart: boolean,
  ): Promise<void> {
    const pendingStart = cancelPendingStart ? this.pendingTurnStarts.get(sessionId) : undefined;
    const unknownRun = this.unknownSessionRuns.get(sessionId);
    if (cancelPendingStart && unknownRun) unknownRun.cancelled = true;
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
        await this.abortSessionAndSubagents(sessionId, turn, cancelPendingStart);
        if (unknownRun?.cancelled) {
          await this.reconcileDisconnectedTurn(sessionId);
          if (this.unknownSessionRuns.get(sessionId) === unknownRun) {
            throw new Error(
              'The submitted run is still unconfirmed; cancellation remains pending.',
            );
          }
        }
      } catch (error) {
        if (unknownRun?.cancelled && this.unknownSessionRuns.get(sessionId) === unknownRun) {
          if (options.bestEffort) return;
          throw error;
        }
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
          this.goalContinuationCoordinator.rollbackStop(sessionId);
          if (!options.bestEffort) {
            throw error;
          }
          coworkLog('WARN', 'OpenClawRuntime', 'Failed to confirm session stop', {
            error: String(error),
            sessionId,
          });
          return;
        }
      }
    }

    if (pendingStartWasSending) {
      await pendingStart.settled;
    }
    if (pendingStart?.cancellationAbortError) {
      if (this.unknownSessionRuns.get(sessionId)?.cancelled) {
        if (options.bestEffort) return;
        throw pendingStart.cancellationAbortError;
      }
      if (turn && this.activeTurns.get(sessionId) === turn) {
        turn.stopRequested = false;
      }
      this.manuallyStoppedSessions.delete(sessionId);
      this.goalContinuationCoordinator.rollbackStop(sessionId);
      if (!options.bestEffort) {
        throw pendingStart.cancellationAbortError;
      }
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to confirm a cancelled turn start', {
        error: String(pendingStart.cancellationAbortError),
        sessionId,
      });
      return;
    }

    // Renderer may report a lost ACK while the stop RPC itself is pending.
    // Re-read admission uncertainty before any terminal cleanup.
    const lateUnknownRun = this.unknownSessionRuns.get(sessionId);
    if (cancelPendingStart && lateUnknownRun) {
      lateUnknownRun.cancelled = true;
      await this.reconcileDisconnectedTurn(sessionId);
      if (this.unknownSessionRuns.get(sessionId) === lateUnknownRun) {
        if (options.bestEffort) return;
        throw new Error('The submitted run is still unconfirmed; cancellation remains pending.');
      }
    }
    // A delayed acknowledgement must never retire a replacement run.
    const currentTurn = this.activeTurns.get(sessionId);
    if (currentTurn && currentTurn !== turn && currentTurn !== pendingStart?.turn) return;

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

  private persistTerminalGoalSnapshot(snapshot: GoalExecutionSnapshot): Promise<void> {
    return runtimeGoalOperations.persistTerminalGoalSnapshot.call(
      this.runtimeGoalOperationsContext,
      snapshot,
    );
  }

  mutateSessionGoal(
    sessionId: string,
    request: SessionGoalMutationRequest,
  ): Promise<SessionGoalMutationOutcome> {
    return runtimeGoalOperations.mutateSessionGoal.call(
      this.runtimeGoalOperationsContext,
      sessionId,
      request,
    );
  }

  private executeSessionGoalMutation(
    sessionId: string,
    operation: RetainedSessionGoalMutation,
  ): Promise<SessionGoalMutationOutcome> {
    return runtimeGoalOperations.executeSessionGoalMutation.call(
      this.runtimeGoalOperationsContext,
      sessionId,
      operation,
    );
  }

  private performSessionGoalMutation(
    sessionId: string,
    request: SessionGoalMutationRequest,
    params: Record<string, unknown>,
  ): Promise<SessionGoalMutationOutcome> {
    return runtimeGoalOperations.performSessionGoalMutation.call(
      this.runtimeGoalOperationsContext,
      sessionId,
      request,
      params,
    );
  }

  restartCompletedGoalForFeedback(
    sessionId: string,
    expectedGoalId: string,
    preparedObjective?: string,
  ): Promise<GoalFeedbackPreparationResult> {
    return runtimeGoalOperations.restartCompletedGoalForFeedback.call(
      this.runtimeGoalOperationsContext,
      sessionId,
      expectedGoalId,
      preparedObjective,
    );
  }

  private performCompletedGoalReplacement(
    sessionId: string,
    expectedGoalId: string,
    preparedObjective?: string,
  ): Promise<GoalFeedbackPreparationResult> {
    return runtimeGoalOperations.performCompletedGoalReplacement.call(
      this.runtimeGoalOperationsContext,
      sessionId,
      expectedGoalId,
      preparedObjective,
    );
  }

  async stopAllSessions(): Promise<void> {
    const sessionIds = [...new Set([...this.activeTurns.keys(), ...this.pendingTurnStarts.keys()])];
    await Promise.all(
      sessionIds.map(sessionId => this.stopSession(sessionId, { bestEffort: true })),
    );
  }

  private async abortSessionAndSubagents(
    sessionId: string,
    turn?: SessionTurn,
    fullSession = false,
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      if (!turn && !this.store.getSession(sessionId)) return;
      throw new Error('OpenClaw Gateway is not connected; the session stop was not confirmed.');
    }

    const parentKeys = [
      ...new Set([...(turn ? [turn.sessionKey] : []), ...this.getSessionKeysForSession(sessionId)]),
    ];
    // OpenClaw owns queue clearing, descendant cancellation (including idle
    // ancestors), and run-bound approval revocation. Send Stop immediately;
    // display inventories and approval list RPCs are not cancellation barriers.
    // Native partial-cascade failures still reject this request.
    const targets =
      turn && !fullSession
        ? [{ key: turn.sessionKey, runId: turn.runId }]
        : parentKeys.map(key => ({ key, clearQueued: true }));
    const results = await Promise.allSettled(
      targets.map(async target => {
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
    this.invalidateSubagentStatus(sessionId);
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
        requireComplete: true,
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
      planMode?: boolean;
      untrustedContext?: string;
      hiddenUserMessage?: boolean;
      onAccepted?: () => void;
    },
  ): Promise<void> {
    if (!hasMessageInput({ prompt, attachments: options.attachments })) {
      throw new Error('Prompt is required.');
    }
    if (this.stopSessionPromises.has(sessionId)) {
      throw new Error('The session is still stopping. Retry after it has stopped.');
    }
    if (this.unknownSessionRuns.has(sessionId)) {
      throw new Error('The previous submission is still awaiting confirmation.');
    }
    const browserPrompt = parseBrowserAnnotationPrompt(prompt);
    const commandPrompt = browserPrompt?.userText ?? prompt;
    const goalStartObjective = parseGoalStartObjective(commandPrompt);

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

      if (options.planMode !== undefined) {
        await this.patchPlanModeState(this.requireGatewayClient(), sessionKey, agentId, {
          enabled: options.planMode,
          updatedAt: Date.now(),
        });
      }

      const runId = options.clientTurnId?.trim() || randomUUID();
      const encodedIssuedAtMs = /^justdo-(\d{10,16})-/.exec(runId)?.[1];
      const persistedStartedAt = options.clientTurnId
        ? this.store.getSessionRunByClientTurnId(options.clientTurnId)?.startedAt
        : undefined;
      const goalIssuedAtMs =
        typeof persistedStartedAt === 'number' && Number.isSafeInteger(persistedStartedAt)
          ? persistedStartedAt
          : encodedIssuedAtMs
            ? Number(encodedIssuedAtMs)
            : Date.now();
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
        const commandSessionId =
          goalStartObjective !== null ||
          hasSlashCommandBeforeSendHook(
            commandPrompt,
            SlashCommandBeforeSendHook.EnsureSessionEntry,
          )
            ? preparedSession.gatewaySessionId
            : undefined;
        if (isStartCancelled()) return;
        pendingStart.phase = 'sending';
        const result = await client.request<SessionGoalMutationResult | { runId?: string }>(
          'chat.send',
          {
            sessionKey,
            ...(commandSessionId ? { sessionId: commandSessionId } : {}),
            message: goalStartObjective ?? prompt.trim(),
            ...(goalStartObjective !== null
              ? {
                  intent: {
                    kind: 'session-goal-start',
                    version: 1,
                    issuedAtMs: goalIssuedAtMs,
                  },
                }
              : {}),
            deliver: false,
            justdoUserInitiated: true,
            ...(options.untrustedContext?.trim()
              ? { justdoUntrustedContext: options.untrustedContext.trim() }
              : {}),
            ...(options.hiddenUserMessage ? { justdoHideUserMessage: true } : {}),
            // Structured Goal admission rejects transient timeout overrides because
            // recovery must use only durable session settings.
            ...(goalStartObjective === null ? { timeoutMs: 0 } : {}),
            idempotencyKey: runId,
            ...(attachments ? { attachments } : {}),
          },
        );
        if (goalStartObjective !== null) {
          const receipt = result as Partial<SessionGoalMutationResult>;
          const receiptGoal = normalizeSessionGoal(receipt.goal);
          if (
            receipt.operationId !== runId ||
            receipt.action !== 'start' ||
            receipt.sessionId !== preparedSession.gatewaySessionId ||
            receipt.status !== 'started' ||
            receipt.runId?.trim() !== runId ||
            typeof receipt.goalId !== 'string' ||
            !receipt.goalId.trim() ||
            (receipt.goal !== undefined && receiptGoal?.id !== receipt.goalId)
          ) {
            throw new Error('Gateway returned a mismatched Goal start receipt');
          }
        }
        options.onAccepted?.();
        if ('replayed' in result && result.replayed) {
          const described = await client.request<{
            session?: { goal?: unknown } | null;
          }>('sessions.describe', { key: sessionKey });
          const replayRunId = result.runId?.trim();
          const currentGoal = normalizeSessionGoal(described.session?.goal);
          const listed = await client.request<{
            sessions?: Array<{ key?: unknown; activeRunIds?: unknown }>;
          }>('sessions.list', {
            search: sessionKey,
            limit: 20,
            agentId,
          });
          const runtimeRow = listed.sessions?.find(row => row.key === sessionKey);
          const activeRunIds = readActiveRunIds(runtimeRow?.activeRunIds);
          const replayStillCurrent =
            !!replayRunId &&
            activeRunIds.includes(replayRunId) &&
            currentGoal?.id === result.goalId &&
            currentGoal.status === SessionGoalStatus.Active;
          if (replayStillCurrent) {
            this.rootRunIdBySession.set(sessionId, replayRunId);
            this.sessionIdByRunId.set(replayRunId, sessionId);
            turn.knownRunIds.add(replayRunId);
            turn.runId = replayRunId;
            this.goalContinuationCoordinator.restoreRunning(sessionId, currentGoal.id, replayRunId);
          } else {
            this.cleanupSessionTurn(sessionId);
            this.rootRunIdBySession.delete(sessionId);
            this.store.updateSession(sessionId, { status: 'idle' });
            this.resolveTurn(sessionId);
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) {
                window.webContents.send(SessionGoalIpc.Changed, { sessionId });
              }
            }
            return;
          }
        }
        const rootRunId = result.runId?.trim() || turn.runId || runId;
        this.rootRunIdBySession.set(sessionId, rootRunId);
        this.sessionIdByRunId.set(rootRunId, sessionId);
        turn.knownRunIds.add(rootRunId);
        turn.runId = rootRunId;
        if (isStartCancelled()) {
          try {
            await this.abortSessionAndSubagents(
              sessionId,
              { ...turn, runId: rootRunId },
              this.stopSessionPromises.has(sessionId),
            );
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
        }
      } catch (error) {
        if (isStartCancelled()) {
          if (this.disconnectedSessionIds.has(sessionId) || isGatewayRequestOutcomeUnknown(error)) {
            this.registerUnknownSessionRun(sessionId, turn.runId, { cancelled: true });
            pendingStart.cancellationAbortError = new Error(
              'The submitted run is still unconfirmed; cancellation remains pending.',
            );
            await this.reconcileDisconnectedTurn(sessionId);
            if (!this.unknownSessionRuns.has(sessionId))
              pendingStart.cancellationAbortError = undefined;
            return;
          }
          try {
            await this.abortSessionAndSubagents(sessionId);
          } catch (abortError) {
            pendingStart.cancellationAbortError = abortError;
          }
          if (!pendingStart.cancellationAbortError) return;
        } else if (
          this.disconnectedSessionIds.has(sessionId) ||
          isGatewayRequestOutcomeUnknown(error)
        ) {
          this.registerUnknownSessionRun(sessionId, turn.runId, {
            onConfirmed: options.onAccepted,
          });
          coworkLog(
            'WARN',
            'OpenClawRuntime',
            'chat.send outcome is unknown; awaiting authoritative recovery',
            {
              sessionId,
            },
          );
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
    return runtimeGatewayEvents.handleGatewayEvent.call(this.runtimeGatewayEventsContext, event);
  }

  private handleTaskEvent(payload: unknown): void {
    return runtimeGatewayEvents.handleTaskEvent.call(this.runtimeGatewayEventsContext, payload);
  }

  // ─── Chat Event Handling (aligned with webchat) ─────────────────────────

  private handleChatEvent(payload: unknown, frameSeq?: number): void {
    return runtimeGatewayEvents.handleChatEvent.call(
      this.runtimeGatewayEventsContext,
      payload,
      frameSeq,
    );
  }
  // ─── Agent Event Handling (tool stream) ─────────────────────────────────

  private handleAgentEvent(
    deliveryEvent: 'agent' | 'session.tool',
    payload: unknown,
    frameSeq?: number,
  ): void {
    return runtimeGatewayEvents.handleAgentEvent.call(
      this.runtimeGatewayEventsContext,
      deliveryEvent,
      payload,
      frameSeq,
    );
  }
  private handleSessionMessageEvent(payload: unknown): void {
    return runtimeGatewayEvents.handleSessionMessageEvent.call(
      this.runtimeGatewayEventsContext,
      payload,
    );
  }

  private resolveAskUserSessionId(request: AskUserRequest): string {
    return runtimePlanInteractions.resolveAskUserSessionId.call(
      this.runtimePlanInteractionsContext,
      request,
    );
  }

  private resolvePlanModeSessionId(request: PlanModeRequest): string {
    return runtimePlanInteractions.resolvePlanModeSessionId.call(
      this.runtimePlanInteractionsContext,
      request,
    );
  }

  private toPlanModeInteraction(request: PlanModeRequest): PlanModeInteractionEnvelope {
    return runtimePlanInteractions.toPlanModeInteraction.call(
      this.runtimePlanInteractionsContext,
      request,
    );
  }

  private isPlanModeInteraction(
    interaction: CoworkInteractionEnvelope,
  ): interaction is PlanModeInteractionEnvelope {
    return runtimePlanInteractions.isPlanModeInteraction.call(
      this.runtimePlanInteractionsContext,
      interaction,
    );
  }

  private toAskUserInteraction(request: AskUserRequest): AskUserInteractionEnvelope {
    return runtimePlanInteractions.toAskUserInteraction.call(
      this.runtimePlanInteractionsContext,
      request,
    );
  }

  private parseAskUserInteractionRequest(
    interaction: AskUserInteractionEnvelope,
  ): AskUserRequest | null {
    return runtimePlanInteractions.parseAskUserInteractionRequest.call(
      this.runtimePlanInteractionsContext,
      interaction,
    );
  }

  private sendCoworkInteraction(interaction: CoworkInteractionEnvelope): void {
    return runtimePlanInteractions.sendCoworkInteraction.call(
      this.runtimePlanInteractionsContext,
      interaction,
    );
  }

  private sendAskUserDismiss(requestId: string): void {
    return runtimePlanInteractions.sendAskUserDismiss.call(
      this.runtimePlanInteractionsContext,
      requestId,
    );
  }

  private rememberTerminalAskUser(requestId: string): void {
    return runtimePlanInteractions.rememberTerminalAskUser.call(
      this.runtimePlanInteractionsContext,
      requestId,
    );
  }

  private handleAskUserRequested(payload: unknown): void {
    return runtimePlanInteractions.handleAskUserRequested.call(
      this.runtimePlanInteractionsContext,
      payload,
    );
  }

  private handleAskUserResolved(payload: unknown): void {
    return runtimePlanInteractions.handleAskUserResolved.call(
      this.runtimePlanInteractionsContext,
      payload,
    );
  }

  private handlePlanModeRequested(payload: unknown): Promise<void> {
    return runtimePlanInteractions.handlePlanModeRequested.call(
      this.runtimePlanInteractionsContext,
      payload,
    );
  }

  private cancelUnpersistedPlanRequest(
    client: GatewayClientLike,
    generation: number,
    request: PlanModeRequest,
  ): Promise<boolean> {
    return runtimePlanInteractions.cancelUnpersistedPlanRequest.call(
      this.runtimePlanInteractionsContext,
      client,
      generation,
      request,
    );
  }

  private handlePlanModeResolved(payload: unknown): Promise<void> {
    return runtimePlanInteractions.handlePlanModeResolved.call(
      this.runtimePlanInteractionsContext,
      payload,
    );
  }

  private readPendingAskUserInteractions(
    client: GatewayClientLike,
  ): Promise<AskUserInteractionEnvelope[]> {
    return runtimePlanInteractions.readPendingAskUserInteractions.call(
      this.runtimePlanInteractionsContext,
      client,
    );
  }

  private readPendingPlanModeInteractions(
    client: GatewayClientLike,
    generation: number,
  ): Promise<PlanModeInteractionEnvelope[]> {
    return runtimePlanInteractions.readPendingPlanModeInteractions.call(
      this.runtimePlanInteractionsContext,
      client,
      generation,
    );
  }

  private persistAndVerifyPresentedPlan(
    sessionId: string,
    request: PlanModeRequest,
  ): { handoff: CoworkPlanHandoff; markdown: string } {
    return runtimePlanInteractions.persistAndVerifyPresentedPlan.call(
      this.runtimePlanInteractionsContext,
      sessionId,
      request,
    );
  }

  private buildPlanImplementationPrompt(
    approvedPlanMarkdown: string,
    approvedPlanRelativePath: string,
  ): string {
    return runtimePlanInteractions.buildPlanImplementationPrompt.call(
      this.runtimePlanInteractionsContext,
      approvedPlanMarkdown,
      approvedPlanRelativePath,
    );
  }

  private buildPlanRevisionPrompt(
    request: PlanModeRequest,
    approvedPlanMarkdown: string,
    feedback: string | undefined,
  ): string {
    return runtimePlanInteractions.buildPlanRevisionPrompt.call(
      this.runtimePlanInteractionsContext,
      request,
      approvedPlanMarkdown,
      feedback,
    );
  }

  private startRecoveredPlanRevision(
    sessionId: string,
    request: PlanModeRequest,
    approvedPlanMarkdown: string,
    feedback: string | undefined,
  ): void {
    return runtimePlanInteractions.startRecoveredPlanRevision.call(
      this.runtimePlanInteractionsContext,
      sessionId,
      request,
      approvedPlanMarkdown,
      feedback,
    );
  }

  private stopPlanningTurnForImplementation(
    sessionId: string,
    planningTurn: SessionTurn | undefined,
  ): Promise<void> {
    return runtimePlanInteractions.stopPlanningTurnForImplementation.call(
      this.runtimePlanInteractionsContext,
      sessionId,
      planningTurn,
    );
  }

  private startApprovedPlanImplementation(
    client: GatewayClientLike,
    sessionId: string,
    request: PlanModeRequest,
    approvedPlanMarkdown: string,
    artifact: CoworkPlanArtifactReference,
  ): Promise<void> {
    return runtimePlanInteractions.startApprovedPlanImplementation.call(
      this.runtimePlanInteractionsContext,
      client,
      sessionId,
      request,
      approvedPlanMarkdown,
      artifact,
    );
  }

  private completePlanHandoffResolution(planId: string): void {
    return runtimePlanInteractions.completePlanHandoffResolution.call(
      this.runtimePlanInteractionsContext,
      planId,
    );
  }

  private isPlanRequestMissing(
    client: GatewayClientLike,
    generation: number,
    requestId: string,
  ): Promise<boolean> {
    return runtimePlanInteractions.isPlanRequestMissing.call(
      this.runtimePlanInteractionsContext,
      client,
      generation,
      requestId,
    );
  }

  private resolvePlanModeInteraction(
    pendingPlan: PlanModeRequest,
    response: { behavior: 'plan'; decision: 'implement' | 'revise' | 'cancel'; feedback?: string },
  ): Promise<{ sessionId: string }> {
    return runtimePlanInteractions.resolvePlanModeInteraction.call(
      this.runtimePlanInteractionsContext,
      pendingPlan,
      response,
    );
  }

  listPendingAskUserInteractions(): Promise<
    Array<AskUserInteractionEnvelope | PlanModeInteractionEnvelope>
  > {
    return runtimePlanInteractions.listPendingAskUserInteractions.call(
      this.runtimePlanInteractionsContext,
    );
  }

  resolveAskUserInteraction(
    requestId: string,
    response:
      | { behavior: 'submit'; answers: unknown }
      | { behavior: 'cancel' }
      | { behavior: 'plan'; decision: 'implement' | 'revise' | 'cancel'; feedback?: string },
  ): Promise<{ sessionId: string }> {
    return runtimePlanInteractions.resolveAskUserInteraction.call(
      this.runtimePlanInteractionsContext,
      requestId,
      response,
    );
  }

  private reconcilePendingAskUserInteractions(generation: number): Promise<void> {
    return runtimePlanInteractions.reconcilePendingAskUserInteractions.call(
      this.runtimePlanInteractionsContext,
      generation,
    );
  }

  private dismissAllAskUserInteractions(): void {
    return runtimePlanInteractions.dismissAllAskUserInteractions.call(
      this.runtimePlanInteractionsContext,
    );
  }

  private patchPlanModeState(
    client: GatewayClientLike,
    sessionKey: string,
    agentId: string | undefined,
    state: PlanModeState,
  ): Promise<void> {
    return runtimePlanInteractions.patchPlanModeState.call(
      this.runtimePlanInteractionsContext,
      client,
      sessionKey,
      agentId,
      state,
    );
  }

  private persistPlanReviewAdmission(
    client: GatewayClientLike,
    sessionId: string,
    request: PlanModeRequest,
  ): Promise<void> {
    return runtimePlanInteractions.persistPlanReviewAdmission.call(
      this.runtimePlanInteractionsContext,
      client,
      sessionId,
      request,
    );
  }

  setPlanMode(sessionId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    return runtimePlanInteractions.setPlanMode.call(
      this.runtimePlanInteractionsContext,
      sessionId,
      enabled,
    );
  }

  getPlanMode(sessionId: string): Promise<{ enabled: boolean }> {
    return runtimePlanInteractions.getPlanMode.call(this.runtimePlanInteractionsContext, sessionId);
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
    const reconciliation = {
      generation: expectedGeneration,
      events: [] as Array<{
        channel: string;
        payload: Record<string, unknown>;
      }>,
    };
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
    return runtimeGatewayEvents.handleSessionOperationEvent.call(
      this.runtimeGatewayEventsContext,
      payload,
    );
  }

  private handleCompactionPhase(
    sessionId: string,
    phase: string,
    turn: SessionTurn | undefined,
  ): void {
    return runtimeGatewayEvents.handleCompactionPhase.call(
      this.runtimeGatewayEventsContext,
      sessionId,
      phase,
      turn,
    );
  }

  private clearCompactionInFlight(sessionId: string): void {
    return runtimeGatewayEvents.clearCompactionInFlight.call(
      this.runtimeGatewayEventsContext,
      sessionId,
    );
  }

  private clearAllCompactionInFlight(): void {
    return runtimeGatewayEvents.clearAllCompactionInFlight.call(this.runtimeGatewayEventsContext);
  }

  private handleSessionsChangedEvent(payload: unknown): void {
    return runtimeGatewayEvents.handleSessionsChangedEvent.call(
      this.runtimeGatewayEventsContext,
      payload,
    );
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
    this.disconnectedSessionIds.delete(sessionId);
    this.unknownSessionRuns.delete(sessionId);
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
    const timeoutSeconds = this.agentTimeoutSeconds;
    if (timeoutSeconds === 0) return;
    const timeoutMs = timeoutSeconds * 1000 + CLIENT_TIMEOUT_GRACE_MS;
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
    if (session?.external?.sessionKey) return session.external.sessionKey;
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

  connectGatewayIfNeeded(): Promise<void> {
    return runtimeGatewayConnection.connectGatewayIfNeeded.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private ensureAutomationPermissionPolicyReady(): Promise<void> {
    return runtimeGatewayConnection.ensureAutomationPermissionPolicyReady.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  reconnectGateway(): Promise<void> {
    return runtimeGatewayConnection.reconnectGateway.call(this.runtimeGatewayConnectionContext);
  }

  disconnectGatewayClient(): void {
    return runtimeGatewayConnection.disconnectGatewayClient.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private ensureGatewayClientReady(): Promise<void> {
    return runtimeGatewayConnection.ensureGatewayClientReady.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private _ensureGatewayClientReadyImpl(): Promise<void> {
    return runtimeGatewayConnection._ensureGatewayClientReadyImpl.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    return runtimeGatewayConnection.createGatewayClient.call(
      this.runtimeGatewayConnectionContext,
      connection,
    );
  }

  private stopGatewayClient(): void {
    return runtimeGatewayConnection.stopGatewayClient.call(this.runtimeGatewayConnectionContext);
  }

  private subscribeGatewaySessions(): Promise<void> {
    return runtimeGatewayConnection.subscribeGatewaySessions.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private handleGatewayReady(generation: number): Promise<void> {
    return runtimeGatewayConnection.handleGatewayReady.call(
      this.runtimeGatewayConnectionContext,
      generation,
    );
  }

  private recoverActiveGoals(
    generation: number,
    options: { stopGoalsCreatedBeforeMs?: number } = {},
  ): Promise<void> {
    return runtimeGoalOperations.recoverActiveGoals.call(
      this.runtimeGoalOperationsContext,
      generation,
      options,
    );
  }

  private scheduleGoalRecovery(
    generation: number,
    options: { stopGoalsCreatedBeforeMs?: number } = {},
  ): void {
    return runtimeGoalOperations.scheduleGoalRecovery.call(
      this.runtimeGoalOperationsContext,
      generation,
      options,
    );
  }

  private cancelGoalRecovery(): void {
    return runtimeGoalOperations.cancelGoalRecovery.call(this.runtimeGoalOperationsContext);
  }

  /** Clean up internal gateway client state without calling client.stop().
   *  Used when the connection is already closed (onClose) — calling stop()
   *  on a closed connection would reject all pending requests with
   *  "gateway client stopped" noise. */
  private cleanupGatewayClientState(): void {
    return runtimeGatewayConnection.cleanupGatewayClientState.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    return runtimeGatewayConnection.loadGatewayClientCtor.call(
      this.runtimeGatewayConnectionContext,
      clientEntryPath,
    );
  }

  // ─── Tick Watchdog ──────────────────────────────────────────────────────

  private startTickWatchdog(): void {
    return runtimeGatewayConnection.startTickWatchdog.call(this.runtimeGatewayConnectionContext);
  }

  private stopTickWatchdog(): void {
    return runtimeGatewayConnection.stopTickWatchdog.call(this.runtimeGatewayConnectionContext);
  }

  private checkTickHealth(): void {
    return runtimeGatewayConnection.checkTickHealth.call(this.runtimeGatewayConnectionContext);
  }

  onSystemResume(): void {
    return runtimeGatewayConnection.onSystemResume.call(this.runtimeGatewayConnectionContext);
  }

  // ─── Gateway Reconnect ──────────────────────────────────────────────────

  private cancelGatewayReconnect(): void {
    return runtimeGatewayConnection.cancelGatewayReconnect.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private scheduleGatewayReconnect(): void {
    return runtimeGatewayConnection.scheduleGatewayReconnect.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  private attemptGatewayReconnect(): Promise<void> {
    return runtimeGatewayConnection.attemptGatewayReconnect.call(
      this.runtimeGatewayConnectionContext,
    );
  }

  // ─── Session Deletion ───────────────────────────────────────────────────

  onSessionDeleted(
    sessionId: string,
    agentId?: string,
    persistedSessionKeys: string[] = [],
    workspaceRoots: string[] = [],
  ): void {
    const removedKeys: string[] = [
      ...new Set(persistedSessionKeys.map(key => key.trim()).filter(Boolean)),
    ];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) {
        if (!removedKeys.includes(key)) removedKeys.push(key);
        this.sessionIdBySessionKey.delete(key);
      }
    }
    if (removedKeys.length === 0) {
      const effectiveAgentId = agentId || 'main';
      removedKeys.push(buildManagedSessionKey(sessionId, effectiveAgentId));
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
    this.goalMutationOperations.delete(sessionId);
    this.terminalLifecycleSessionIds.delete(sessionId);
    this.terminalLifecycleErrorSessionIds.delete(sessionId);
    this.invalidateSubagentStatus(sessionId);
    this.subagentStatusRefreshes.delete(sessionId);
    for (const workspaceRoot of new Set(workspaceRoots.filter(path.isAbsolute))) {
      try {
        this.approvedPlanArtifactStore?.removeSessionArtifacts?.(workspaceRoot, sessionId);
      } catch (error) {
        coworkLog('WARN', 'OpenClawRuntime', 'Failed to remove approved-plan artifacts', {
          sessionId,
          workspaceRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
    if (session?.external?.sessionKey && !keys.includes(session.external.sessionKey)) {
      keys.push(session.external.sessionKey);
    }
    const managedKey = buildManagedSessionKey(sessionId, session?.agentId);
    if (!keys.includes(managedKey)) keys.push(managedKey);
    return keys;
  }

  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }

  getSubagentStatuses(
    sessionId?: string,
    forceRefresh = false,
  ): Promise<{
    subagents: GatewaySubagent[];
  }> {
    return runtimeSessionStatus.getSubagentStatuses.call(
      this.runtimeSessionStatusContext,
      sessionId,
      forceRefresh,
    );
  }

  private refreshSubagentStatuses(sessionId: string): Promise<GatewaySubagent[]> {
    return runtimeSessionStatus.refreshSubagentStatuses.call(
      this.runtimeSessionStatusContext,
      sessionId,
    );
  }

  private invalidateSubagentStatusSnapshot(sessionId: string): void {
    return runtimeSessionStatus.invalidateSubagentStatusSnapshot.call(
      this.runtimeSessionStatusContext,
      sessionId,
    );
  }

  private invalidateSubagentStatus(sessionId: string): void {
    return runtimeSessionStatus.invalidateSubagentStatus.call(
      this.runtimeSessionStatusContext,
      sessionId,
    );
  }

  getSessionRuntimeStatus(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<{
    known: boolean;
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
    rootRunId?: string;
  }> {
    return runtimeSessionStatus.getSessionRuntimeStatus.call(
      this.runtimeSessionStatusContext,
      sessionId,
      options,
    );
  }

  getSessionRuntimeStatuses(
    sessionIds: string[],
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<Record<string, SessionRuntimeStatus>> {
    return runtimeSessionStatus.getSessionRuntimeStatuses.call(
      this.runtimeSessionStatusContext,
      sessionIds,
      options,
    );
  }

  private runtimeRowString(value: unknown): string {
    return runtimeSessionStatus.runtimeRowString.call(this.runtimeSessionStatusContext, value);
  }

  private isRuntimeSessionRowMainActive(row: Record<string, unknown>): boolean {
    return runtimeSessionStatus.isRuntimeSessionRowMainActive.call(
      this.runtimeSessionStatusContext,
      row,
    );
  }

  private isRuntimeSessionRowActive(row: Record<string, unknown>): boolean {
    return runtimeSessionStatus.isRuntimeSessionRowActive.call(
      this.runtimeSessionStatusContext,
      row,
    );
  }

  private reconcileDisconnectedTurn(sessionId: string): Promise<void> {
    const existing = this.disconnectedRecoveryPromises.get(sessionId);
    if (existing) return existing;
    const pending = this.performDisconnectedTurnRecovery(sessionId).finally(() => {
      if (this.disconnectedRecoveryPromises.get(sessionId) === pending) {
        this.disconnectedRecoveryPromises.delete(sessionId);
      }
    });
    this.disconnectedRecoveryPromises.set(sessionId, pending);
    return pending;
  }

  private async performDisconnectedTurnRecovery(sessionId: string): Promise<void> {
    if (!this.disconnectedSessionIds.has(sessionId)) return;
    const client = this.gatewayClient;
    const turn = this.activeTurns.get(sessionId);
    if (!client || !turn?.runId) return;
    try {
      const unknownRun = this.unknownSessionRuns.get(sessionId);
      if (unknownRun?.cancelled && unknownRun.runId === turn.runId) {
        // Precise identity also cancels native pre-registered admission. Never
        // use a broad stop here: an old cancelled request must not kill a successor.
        await client.request('sessions.abort', { key: turn.sessionKey, runId: unknownRun.runId });
        if (this.activeTurns.get(sessionId) !== turn) return;
      }
      const result = await client.request<{
        runId?: string;
        status?: string;
        endedAt?: number;
        stopReason?: string;
        error?: string;
        yielded?: boolean;
      }>('agent.wait', { runId: turn.runId, timeoutMs: 0 });
      if (this.gatewayClient !== client || this.activeTurns.get(sessionId) !== turn) return;
      if (result.runId && result.runId !== turn.runId) return;
      if (result.yielded) {
        this.confirmUnknownSessionRunAdmission(sessionId, turn);
        // Yield proves admission, but not whole-session completion. Release the
        // old request identity to normal parent/descendant activity aggregation.
        // Cancelled admission still owns its session fence until queued and
        // descendant work has received the explicit full-session stop.
        if (unknownRun?.cancelled) {
          await this.abortSessionAndSubagents(sessionId, turn, true);
          if (this.gatewayClient !== client || this.activeTurns.get(sessionId) !== turn) return;
          this.goalContinuationCoordinator.confirmStop(sessionId);
        }
        this.cleanupSessionTurn(sessionId);
        this.resolveTurn(sessionId);
        return;
      }
      // A plain timeout means no terminal receipt was found, not a failed run.
      if (
        result.status !== 'ok' &&
        result.status !== 'error' &&
        !(result.status === 'timeout' && typeof result.endedAt === 'number')
      )
        return;
      const aborted = result.stopReason === 'aborted' || result.stopReason === 'rpc';
      this.confirmUnknownSessionRunAdmission(sessionId, turn);
      this.handleChatEvent({
        sessionKey: turn.sessionKey,
        runId: turn.runId,
        state: aborted ? 'aborted' : result.status === 'ok' ? 'final' : 'error',
        ...(result.error ? { errorMessage: result.error } : {}),
      });
      // The lifecycle event may have been lost with the connection as well.
      // Reconcile the Goal before exposing idle so an automatic continuation
      // cannot disappear from the aggregate between root runs.
      await this.goalContinuationCoordinator.handleLifecycle({
        sessionKey: turn.sessionKey,
        runId: turn.runId,
        phase: result.status === 'ok' ? 'end' : 'error',
        aborted,
        ...(result.error ? { error: result.error } : {}),
      });
    } catch {
      // Keep execution outcome unknown when the authority cannot be queried.
    }
  }

  private invalidateRuntimeSessionSnapshot(): void {
    return runtimeSessionStatus.invalidateRuntimeSessionSnapshot.call(
      this.runtimeSessionStatusContext,
    );
  }

  private getRuntimeSessionSnapshot(
    forceRefresh = false,
    fullScan = false,
  ): Promise<RuntimeSessionSnapshot> {
    return runtimeSessionStatus.getRuntimeSessionSnapshot.call(
      this.runtimeSessionStatusContext,
      forceRefresh,
      fullScan,
    );
  }

  fetchSessionHistoryByKey(
    sessionKey: string,
    fallbackSessionId?: string | null,
    options: { forceFullSnapshot?: boolean; scheduledTaskRun?: boolean } = {},
  ): Promise<ScheduledTaskSessionHistory | null> {
    return runtimeHistory.fetchSessionHistoryByKey.call(
      this.runtimeHistoryContext,
      sessionKey,
      fallbackSessionId,
      options,
    );
  }

  private setSessionHistorySnapshot(
    sessionKey: string,
    messages: unknown[],
    deltaCursor: string,
  ): void {
    return runtimeHistory.setSessionHistorySnapshot.call(
      this.runtimeHistoryContext,
      sessionKey,
      messages,
      deltaCursor,
    );
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

  async patchSessionModel(sessionId: string, model: string, agentId?: string) {
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

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly runtimePlanInteractionsContext: RuntimePlanInteractionsContext =
    createPropertyContext<RuntimePlanInteractionsContext>({
      resolveSessionIdBySessionKey: { get: () => this.resolveSessionIdBySessionKey.bind(this) },
      resolvePlanModeSessionId: { get: () => this.resolvePlanModeSessionId.bind(this) },
      resolveAskUserSessionId: { get: () => this.resolveAskUserSessionId.bind(this) },
      terminalAskUserIds: { get: () => this.terminalAskUserIds },
      pendingAskUserRequests: { get: () => this.pendingAskUserRequests },
      sendCoworkInteraction: { get: () => this.sendCoworkInteraction.bind(this) },
      toAskUserInteraction: { get: () => this.toAskUserInteraction.bind(this) },
      rememberTerminalAskUser: { get: () => this.rememberTerminalAskUser.bind(this) },
      sendAskUserDismiss: { get: () => this.sendAskUserDismiss.bind(this) },
      gatewayClient: { get: () => this.gatewayClient },
      gatewayClientGeneration: { get: () => this.gatewayClientGeneration },
      cancelUnpersistedPlanRequest: { get: () => this.cancelUnpersistedPlanRequest.bind(this) },
      persistAndVerifyPresentedPlan: { get: () => this.persistAndVerifyPresentedPlan.bind(this) },
      persistPlanReviewAdmission: { get: () => this.persistPlanReviewAdmission.bind(this) },
      store: { get: () => this.store },
      patchPlanModeState: { get: () => this.patchPlanModeState.bind(this) },
      completePlanHandoffResolution: { get: () => this.completePlanHandoffResolution.bind(this) },
      pendingPlanModeRequests: { get: () => this.pendingPlanModeRequests },
      toPlanModeInteraction: { get: () => this.toPlanModeInteraction.bind(this) },
      planResolutionByRequestId: { get: () => this.planResolutionByRequestId },
      isPlanRequestMissing: { get: () => this.isPlanRequestMissing.bind(this) },
      approvedPlanArtifactStore: { get: () => this.approvedPlanArtifactStore },
      startSession: { get: () => this.startSession.bind(this) },
      buildPlanRevisionPrompt: { get: () => this.buildPlanRevisionPrompt.bind(this) },
      activeTurns: { get: () => this.activeTurns },
      stopSessionInternal: { get: () => this.stopSessionInternal.bind(this) },
      invalidateRuntimeSessionSnapshot: {
        get: () => this.invalidateRuntimeSessionSnapshot.bind(this),
      },
      stopPlanningTurnForImplementation: {
        get: () => this.stopPlanningTurnForImplementation.bind(this),
      },
      runTurn: { get: () => this.runTurn.bind(this) },
      buildPlanImplementationPrompt: { get: () => this.buildPlanImplementationPrompt.bind(this) },
      ensureGatewayClientReady: { get: () => this.ensureGatewayClientReady.bind(this) },
      requireGatewayClient: { get: () => this.requireGatewayClient.bind(this) },
      startApprovedPlanImplementation: {
        get: () => this.startApprovedPlanImplementation.bind(this),
      },
      startRecoveredPlanRevision: { get: () => this.startRecoveredPlanRevision.bind(this) },
      readPendingAskUserInteractions: { get: () => this.readPendingAskUserInteractions.bind(this) },
      readPendingPlanModeInteractions: {
        get: () => this.readPendingPlanModeInteractions.bind(this),
      },
      isPlanModeInteraction: { get: () => this.isPlanModeInteraction.bind(this) },
      parseAskUserInteractionRequest: { get: () => this.parseAskUserInteractionRequest.bind(this) },
      resolvePlanModeInteraction: { get: () => this.resolvePlanModeInteraction.bind(this) },
      isSessionActive: { get: () => this.isSessionActive.bind(this) },
      toSessionKey: { get: () => this.toSessionKey.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly runtimeGatewayConnectionContext: RuntimeGatewayConnectionContext =
    createPropertyContext<RuntimeGatewayConnectionContext>({
      gatewayClient: {
        get: () => this.gatewayClient,
        set: value => {
          this.gatewayClient = value;
        },
      },
      ensureGatewayClientReady: { get: () => this.ensureGatewayClientReady.bind(this) },
      automationPermissionVerifiedGeneration: {
        get: () => this.automationPermissionVerifiedGeneration,
        set: value => {
          this.automationPermissionVerifiedGeneration = value;
        },
      },
      gatewayClientGeneration: {
        get: () => this.gatewayClientGeneration,
        set: value => {
          this.gatewayClientGeneration = value;
        },
      },
      requireGatewayClient: { get: () => this.requireGatewayClient.bind(this) },
      stopGatewayClient: { get: () => this.stopGatewayClient.bind(this) },
      gatewayReconnectAttempt: {
        get: () => this.gatewayReconnectAttempt,
        set: value => {
          this.gatewayReconnectAttempt = value;
        },
      },
      scheduleGatewayReconnect: { get: () => this.scheduleGatewayReconnect.bind(this) },
      ensureAutomationPermissionPolicyReady: {
        get: () => this.ensureAutomationPermissionPolicyReady.bind(this),
      },
      gatewayClientInitLock: {
        get: () => this.gatewayClientInitLock,
        set: value => {
          this.gatewayClientInitLock = value;
        },
      },
      _ensureGatewayClientReadyImpl: { get: () => this._ensureGatewayClientReadyImpl.bind(this) },
      engineManager: { get: () => this.engineManager },
      gatewayClientVersion: {
        get: () => this.gatewayClientVersion,
        set: value => {
          this.gatewayClientVersion = value;
        },
      },
      gatewayClientEntryPath: {
        get: () => this.gatewayClientEntryPath,
        set: value => {
          this.gatewayClientEntryPath = value;
        },
      },
      gatewayReadyPromise: {
        get: () => this.gatewayReadyPromise,
        set: value => {
          this.gatewayReadyPromise = value;
        },
      },
      createGatewayClient: { get: () => this.createGatewayClient.bind(this) },
      loadGatewayClientCtor: { get: () => this.loadGatewayClientCtor.bind(this) },
      pendingGatewayClient: {
        get: () => this.pendingGatewayClient,
        set: value => {
          this.pendingGatewayClient = value;
        },
      },
      intentionallyStoppedGatewayClients: { get: () => this.intentionallyStoppedGatewayClients },
      emit: { get: () => this.emit.bind(this) },
      lastTickTimestamp: {
        get: () => this.lastTickTimestamp,
        set: value => {
          this.lastTickTimestamp = value;
        },
      },
      startTickWatchdog: { get: () => this.startTickWatchdog.bind(this) },
      handleGatewayReady: { get: () => this.handleGatewayReady.bind(this) },
      reconcilePendingApprovals: { get: () => this.reconcilePendingApprovals.bind(this) },
      reconcilePendingAskUserInteractions: {
        get: () => this.reconcilePendingAskUserInteractions.bind(this),
      },
      gatewayStoppingIntentionally: {
        get: () => this.gatewayStoppingIntentionally,
        set: value => {
          this.gatewayStoppingIntentionally = value;
        },
      },
      activeTurns: { get: () => this.activeTurns },
      disconnectedSessionIds: { get: () => this.disconnectedSessionIds },
      cleanupGatewayClientState: { get: () => this.cleanupGatewayClientState.bind(this) },
      handleGatewayEvent: { get: () => this.handleGatewayEvent.bind(this) },
      goalContinuationCoordinator: { get: () => this.goalContinuationCoordinator },
      cancelGoalRecovery: { get: () => this.cancelGoalRecovery.bind(this) },
      dismissAllAskUserInteractions: { get: () => this.dismissAllAskUserInteractions.bind(this) },
      cancelGatewayReconnect: { get: () => this.cancelGatewayReconnect.bind(this) },
      stopTickWatchdog: { get: () => this.stopTickWatchdog.bind(this) },
      invalidateRuntimeSessionSnapshot: {
        get: () => this.invalidateRuntimeSessionSnapshot.bind(this),
      },
      stoppedSessions: { get: () => this.stoppedSessions },
      clearAllCompactionInFlight: { get: () => this.clearAllCompactionInFlight.bind(this) },
      lastAgentActivityTimestamp: {
        get: () => this.lastAgentActivityTimestamp,
        set: value => {
          this.lastAgentActivityTimestamp = value;
        },
      },
      subscribeGatewaySessions: { get: () => this.subscribeGatewaySessions.bind(this) },
      recoverActiveGoals: { get: () => this.recoverActiveGoals.bind(this) },
      initialGatewayGoalRecoveryPending: { get: () => this.initialGatewayGoalRecoveryPending },
      appStartedAtMs: { get: () => this.appStartedAtMs },
      tickWatchdogTimer: {
        get: () => this.tickWatchdogTimer,
        set: value => {
          this.tickWatchdogTimer = value;
        },
      },
      checkTickHealth: { get: () => this.checkTickHealth.bind(this) },
      attemptGatewayReconnect: { get: () => this.attemptGatewayReconnect.bind(this) },
      gatewayReconnectTimer: {
        get: () => this.gatewayReconnectTimer,
        set: value => {
          this.gatewayReconnectTimer = value;
        },
      },
      connectGatewayIfNeeded: { get: () => this.connectGatewayIfNeeded.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly runtimeHistoryContext: RuntimeHistoryContext =
    createPropertyContext<RuntimeHistoryContext>({
      gatewayClient: { get: () => this.gatewayClient },
      sessionHistorySnapshots: { get: () => this.sessionHistorySnapshots },
      setSessionHistorySnapshot: { get: () => this.setSessionHistorySnapshot.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly runtimeGoalOperationsContext: RuntimeGoalOperationsContext =
    createPropertyContext<RuntimeGoalOperationsContext>({
      gatewayClientGeneration: { get: () => this.gatewayClientGeneration },
      store: { get: () => this.store },
      gatewayClient: { get: () => this.gatewayClient },
      getSessionKeysForSession: { get: () => this.getSessionKeysForSession.bind(this) },
      goalContinuationCoordinator: { get: () => this.goalContinuationCoordinator },
      goalMutationOperations: { get: () => this.goalMutationOperations },
      mutateSessionGoal: { get: () => this.mutateSessionGoal.bind(this) },
      executeSessionGoalMutation: { get: () => this.executeSessionGoalMutation.bind(this) },
      requireGatewayClient: { get: () => this.requireGatewayClient.bind(this) },
      prepareSessionKey: { get: () => this.prepareSessionKey.bind(this) },
      rememberSessionKey: { get: () => this.rememberSessionKey.bind(this) },
      performSessionGoalMutation: { get: () => this.performSessionGoalMutation.bind(this) },
      stoppedSessions: { get: () => this.stoppedSessions },
      goalIdsActivatedThisApp: { get: () => this.goalIdsActivatedThisApp },
      ensureActiveTurn: { get: () => this.ensureActiveTurn.bind(this) },
      manuallyStoppedSessions: { get: () => this.manuallyStoppedSessions },
      goalReplacementPromises: { get: () => this.goalReplacementPromises },
      performCompletedGoalReplacement: {
        get: () => this.performCompletedGoalReplacement.bind(this),
      },
      goalRecoveryGeneration: {
        get: () => this.goalRecoveryGeneration,
        set: value => {
          this.goalRecoveryGeneration = value;
        },
      },
      goalRecoveryTimer: {
        get: () => this.goalRecoveryTimer,
        set: value => {
          this.goalRecoveryTimer = value;
        },
      },
      getRuntimeSessionSnapshot: { get: () => this.getRuntimeSessionSnapshot.bind(this) },
      scheduleGoalRecovery: { get: () => this.scheduleGoalRecovery.bind(this) },
      runtimeRowString: { get: () => this.runtimeRowString.bind(this) },
      activeTurns: { get: () => this.activeTurns },
      goalSessionsActivatingThisApp: { get: () => this.goalSessionsActivatingThisApp },
      isRuntimeSessionRowActive: { get: () => this.isRuntimeSessionRowActive.bind(this) },
      initialGatewayGoalRecoveryPending: {
        get: () => this.initialGatewayGoalRecoveryPending,
        set: value => {
          this.initialGatewayGoalRecoveryPending = value;
        },
      },
      recoverActiveGoals: { get: () => this.recoverActiveGoals.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly runtimeSessionStatusContext: RuntimeSessionStatusContext =
    createPropertyContext<RuntimeSessionStatusContext>({
      invalidateSubagentStatus: { get: () => this.invalidateSubagentStatus.bind(this) },
      subagentStatusCache: { get: () => this.subagentStatusCache },
      subagentStatusRefreshes: { get: () => this.subagentStatusRefreshes },
      refreshSubagentStatuses: { get: () => this.refreshSubagentStatuses.bind(this) },
      ensureGatewayClientReady: { get: () => this.ensureGatewayClientReady.bind(this) },
      gatewayClient: { get: () => this.gatewayClient },
      subagentStatusGenerations: { get: () => this.subagentStatusGenerations },
      subagentDetailCache: { get: () => this.subagentDetailCache },
      getSessionKeysForSession: { get: () => this.getSessionKeysForSession.bind(this) },
      store: { get: () => this.store },
      invalidateSubagentStatusSnapshot: {
        get: () => this.invalidateSubagentStatusSnapshot.bind(this),
      },
      getSessionRuntimeStatuses: { get: () => this.getSessionRuntimeStatuses.bind(this) },
      disconnectedSessionIds: { get: () => this.disconnectedSessionIds },
      disconnectedRecoveryPromises: { get: () => this.disconnectedRecoveryPromises },
      reconcileDisconnectedTurn: { get: () => this.reconcileDisconnectedTurn.bind(this) },
      goalContinuationCoordinator: { get: () => this.goalContinuationCoordinator },
      isSessionActive: { get: () => this.isSessionActive.bind(this) },
      compactionInFlightSessionIds: { get: () => this.compactionInFlightSessionIds },
      rootRunIdBySession: { get: () => this.rootRunIdBySession },
      getRuntimeSessionSnapshot: { get: () => this.getRuntimeSessionSnapshot.bind(this) },
      runtimeRowString: { get: () => this.runtimeRowString.bind(this) },
      isRuntimeSessionRowMainActive: { get: () => this.isRuntimeSessionRowMainActive.bind(this) },
      isRuntimeSessionRowActive: { get: () => this.isRuntimeSessionRowActive.bind(this) },
      runtimeSessionSnapshot: {
        get: () => this.runtimeSessionSnapshot,
        set: value => {
          this.runtimeSessionSnapshot = value;
        },
      },
      runtimeSessionSnapshotGeneration: {
        get: () => this.runtimeSessionSnapshotGeneration,
        set: value => {
          this.runtimeSessionSnapshotGeneration = value;
        },
      },
      runtimeSessionSnapshotPromise: {
        get: () => this.runtimeSessionSnapshotPromise,
        set: value => {
          this.runtimeSessionSnapshotPromise = value;
        },
      },
      lastRuntimeStatusWarningAt: {
        get: () => this.lastRuntimeStatusWarningAt,
        set: value => {
          this.lastRuntimeStatusWarningAt = value;
        },
      },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly runtimeGatewayEventsContext: RuntimeGatewayEventsContext =
    createPropertyContext<RuntimeGatewayEventsContext>({
      emit: { get: () => this.emit.bind(this) },
      lastTickTimestamp: {
        get: () => this.lastTickTimestamp,
        set: value => {
          this.lastTickTimestamp = value;
        },
      },
      handleChatEvent: { get: () => this.handleChatEvent.bind(this) },
      lastAgentActivityTimestamp: {
        get: () => this.lastAgentActivityTimestamp,
        set: value => {
          this.lastAgentActivityTimestamp = value;
        },
      },
      handleAgentEvent: { get: () => this.handleAgentEvent.bind(this) },
      handleSessionMessageEvent: { get: () => this.handleSessionMessageEvent.bind(this) },
      handleAskUserRequested: { get: () => this.handleAskUserRequested.bind(this) },
      handleAskUserResolved: { get: () => this.handleAskUserResolved.bind(this) },
      handlePlanModeRequested: { get: () => this.handlePlanModeRequested.bind(this) },
      handlePlanModeResolved: { get: () => this.handlePlanModeResolved.bind(this) },
      handleExecApprovalRequested: { get: () => this.handleExecApprovalRequested.bind(this) },
      broadcastApproval: { get: () => this.broadcastApproval.bind(this) },
      handlePluginApprovalRequested: { get: () => this.handlePluginApprovalRequested.bind(this) },
      handleTaskEvent: { get: () => this.handleTaskEvent.bind(this) },
      handleSessionOperationEvent: { get: () => this.handleSessionOperationEvent.bind(this) },
      handleSessionsChangedEvent: { get: () => this.handleSessionsChangedEvent.bind(this) },
      resolveSessionIdBySessionKey: { get: () => this.resolveSessionIdBySessionKey.bind(this) },
      invalidateSubagentStatusSnapshot: {
        get: () => this.invalidateSubagentStatusSnapshot.bind(this),
      },
      subagentStatusCache: { get: () => this.subagentStatusCache },
      subagentDetailCache: { get: () => this.subagentDetailCache },
      subagentStatusRefreshes: { get: () => this.subagentStatusRefreshes },
      invalidateSubagentStatus: { get: () => this.invalidateSubagentStatus.bind(this) },
      sessionIdByRunId: { get: () => this.sessionIdByRunId },
      isRecentTerminalRun: { get: () => this.isRecentTerminalRun.bind(this) },
      isAnnounceRunId: { get: () => this.isAnnounceRunId.bind(this) },
      ensureActiveTurn: { get: () => this.ensureActiveTurn.bind(this) },
      activeTurns: { get: () => this.activeTurns },
      unknownSessionRuns: { get: () => this.unknownSessionRuns },
      reconcileDisconnectedTurn: { get: () => this.reconcileDisconnectedTurn.bind(this) },
      confirmUnknownSessionRunAdmission: {
        get: () => this.confirmUnknownSessionRunAdmission.bind(this),
      },
      rememberTerminalTurn: { get: () => this.rememberTerminalTurn.bind(this) },
      cleanupSessionTurn: { get: () => this.cleanupSessionTurn.bind(this) },
      store: { get: () => this.store },
      terminalLifecycleSessionIds: { get: () => this.terminalLifecycleSessionIds },
      terminalLifecycleErrorSessionIds: { get: () => this.terminalLifecycleErrorSessionIds },
      resolveTurn: { get: () => this.resolveTurn.bind(this) },
      legacyAgentSequence: {
        get: () => this.legacyAgentSequence,
        set: value => {
          this.legacyAgentSequence = value;
        },
      },
      goalContinuationCoordinator: { get: () => this.goalContinuationCoordinator },
      classifyMainAgentEvent: { get: () => this.classifyMainAgentEvent.bind(this) },
      rootRunIdBySession: { get: () => this.rootRunIdBySession },
      handleCompactionPhase: { get: () => this.handleCompactionPhase.bind(this) },
      scheduleLifecycleEndFallback: { get: () => this.scheduleLifecycleEndFallback.bind(this) },
      sessionExecApprovalGrants: { get: () => this.sessionExecApprovalGrants },
      clearCompactionInFlight: { get: () => this.clearCompactionInFlight.bind(this) },
      compactionInFlightSessionIds: { get: () => this.compactionInFlightSessionIds },
      lifecycleEndFallbackTimers: { get: () => this.lifecycleEndFallbackTimers },
      invalidateRuntimeSessionSnapshot: {
        get: () => this.invalidateRuntimeSessionSnapshot.bind(this),
      },
    });
}

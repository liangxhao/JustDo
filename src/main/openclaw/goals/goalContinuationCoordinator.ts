import { randomUUID } from 'crypto';

import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  isDefinitiveSessionGoalGatewayError,
  normalizeSessionGoal,
  type SessionGoal,
  SessionGoalStatus,
} from '../../../shared/cowork/sessionGoal';
import { coworkLog } from '../../cowork/coworkLogger';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { GoalEventAdmission, GoalEventIdentity } from './goalEventAdmission';

const CONTINUATION_SYSTEM_PROMPT = [
  'This is an automatic continuation of the active session goal.',
  'The host has already confirmed that the same goal is still active.',
  'Review the existing conversation, artifacts, and tool results before acting.',
  'First determine whether the existing evidence already proves the objective is achieved; do not repeat completed work merely to create activity.',
  'If achieved, perform only the verification still needed, then call update_goal with complete and a non-empty concise note describing the evidence; never mark complete without that evidence note.',
  'After any successful update_goal call, always provide one concise user-visible final answer; never end without one.',
  'If completed results were already clearly presented earlier, do not repeat, regenerate, paraphrase, or summarize them; reply with exactly one short sentence in the user\'s language stating only that the goal is confirmed complete, without referring to earlier messages or results.',
  'Otherwise provide one concise final summary. For a blocked goal, briefly state the blocker and the user action or external change needed.',
  'If incomplete, advance the next unresolved part with concrete work instead of only restating status or proposing future work.',
  'Call update_goal with blocked only when the same blocking condition has persisted for at least three consecutive goal turns and no meaningful progress remains possible without user input or an external state change.',
  'Before ending the turn, reassess the objective; keep it active only when useful work genuinely remains.',
].join(' ');

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;

const buildContinuationPrompt = (goal: SessionGoal): string =>
  [
    'Continue the active goal below.',
    '',
    'Authoritative goal objective:',
    goal.objective,
    '',
    'Use the existing session history and current artifacts as execution context.',
  ].join('\n');

type GatewaySession = Record<string, unknown> & { key?: string; goal?: unknown };
type GoalSessionTarget = { sessionId: string; lifecycleRevision?: string | null };
type TerminalGoalStatus = 'complete' | 'blocked';
type GoalDecision = {
  token: symbol;
  epoch: number;
  generation: number;
  stopGeneration: number;
  runId?: string;
};
type GoalContinuationTarget = {
  sessionKey: string;
  runId: string;
  target: GoalSessionTarget;
  goalId?: string;
};

export interface GoalLifecycleEvent extends GoalEventIdentity {
  runId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  phase: 'start' | 'end' | 'error';
  executionSettled?: boolean;
  aborted?: boolean;
  yielded?: boolean;
  livenessState?: string;
  stopReason?: string;
  status?: string;
  timeoutPhase?: string;
  error?: string;
}

export interface GoalToolEvent extends GoalEventIdentity {
  runId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  name: string;
  toolCallId: string | null;
  input?: unknown;
  output?: unknown;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  failed: boolean;
}

interface GoalContinuationCoordinatorDependencies {
  getClient: () => GatewayClientLike | null;
  resolveSessionId: (sessionKey: string) => string | null;
  resolveAgentId: (sessionId: string) => string;
  getMaxContinuationTurns: () => number;
  onRunAccepted: (
    sessionId: string,
    sessionKey: string,
    runId: string,
    nativeSessionId: string,
  ) => void;
  onRunFailed: (sessionId: string, runId: string) => void;
  onRunConfirmed: (sessionId: string, runId: string) => void;
  onRunUnknown: (sessionId: string, runId: string) => void;
  eventAdmission: Pick<GoalEventAdmission, 'admit' | 'clearSession' | 'clear'>;
  onSnapshot: (snapshot: GoalExecutionSnapshot) => void;
  prepareSessionForContinuation?: (sessionId: string) => Promise<void>;
  waitBeforeAutomaticContinuation?: () => Promise<void>;
  now?: () => number;
}

const asGoal = (value: unknown): SessionGoal | null => normalizeSessionGoal(value) ?? null;

const isManagedGoalSessionKey = (sessionKey: string): boolean =>
  /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey.trim());

const readGoalTerminalStatus = (value: unknown): TerminalGoalStatus | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return status === SessionGoalStatus.Complete || status === SessionGoalStatus.Blocked
    ? status
    : null;
};

// Native tools can return a successful transport result containing status:error.
// Only an explicit updated receipt proves that the requested transition committed.
const readUpdatedGoal = (value: unknown, depth = 0): SessionGoal | null => {
  if (depth > 3) return null;
  if (typeof value === 'string') {
    try {
      return readUpdatedGoal(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.isError === true || result.status === 'error') return null;
  if (result.status === 'updated') return asGoal(result.goal);
  const details = readUpdatedGoal(result.details, depth + 1);
  if (details) return details;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block?.type !== 'text') continue;
      const goal = readUpdatedGoal(block.text, depth + 1);
      if (goal) return goal;
    }
  }
  return null;
};

const phaseForGoal = (goal: SessionGoal | null): GoalExecutionPhase => {
  if (goal?.status === SessionGoalStatus.Complete) {
    return GoalExecutionPhase.AwaitingConfirmation;
  }
  if (
    goal?.status === SessionGoalStatus.Blocked ||
    goal?.status === SessionGoalStatus.UsageLimited ||
    goal?.status === SessionGoalStatus.BudgetLimited
  ) {
    return GoalExecutionPhase.AwaitingInput;
  }
  if (goal?.status === SessionGoalStatus.Paused) return GoalExecutionPhase.Stopped;
  return GoalExecutionPhase.Waiting;
};

const terminalPhase = (status: TerminalGoalStatus): GoalExecutionPhase =>
  status === SessionGoalStatus.Complete
    ? GoalExecutionPhase.AwaitingConfirmation
    : GoalExecutionPhase.AwaitingInput;

const errorSummary = (error: unknown): string => {
  const value = error instanceof Error ? error.message : String(error || 'Goal continuation failed');
  return value.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Goal continuation failed';
};

const isYieldedWaiting = (event: GoalLifecycleEvent): boolean =>
  event.phase === 'end' && event.yielded === true && event.livenessState === 'paused' &&
  event.stopReason === 'end_turn' && event.aborted !== true &&
  event.status !== 'cancelled' && event.status !== 'timed_out' &&
  event.timeoutPhase === undefined && event.error === undefined;

const readContinuationDeferredReason = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const value = error as { gatewayCode?: unknown; details?: unknown };
  if (value.gatewayCode !== 'INVALID_REQUEST' || !value.details ||
    typeof value.details !== 'object') return null;
  const details = value.details as { code?: unknown; reason?: unknown };
  return details.code === 'GOAL_CONTINUATION_DEFERRED' && typeof details.reason === 'string'
    ? details.reason
    : null;
};

export class GoalContinuationCoordinator {
  private readonly snapshots = new Map<string, GoalExecutionSnapshot>();
  private readonly sessionKeys = new Map<string, string>();
  private readonly processedTerminalRuns = new Set<string>();
  private readonly stoppedSessionIds = new Set<string>();
  private readonly continuationRuns = new Map<string, GoalSessionTarget>();
  private readonly dispatchLanes = new Map<string, GoalDecision>();
  private readonly decisionEpochs = new Map<string, number>();
  private readonly continuationTargets = new Map<string, GoalContinuationTarget>();
  private readonly latestRunIds = new Map<string, string>();
  private readonly pendingGoalUpdates = new Map<string, TerminalGoalStatus>();
  private readonly terminalGoalRuns = new Map<string, TerminalGoalStatus>();
  private readonly snapshotsBeforeStop = new Map<string, GoalExecutionSnapshot | null>();
  private readonly stopGenerations = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTargets = new Map<string, GoalSessionTarget>();
  private readonly sessionTargets = new Map<
    string,
    { sessionId: string; lifecycleRevision: string | null }
  >();
  private readonly now: () => number;
  private generation = 0;

  constructor(private readonly dependencies: GoalContinuationCoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  getSnapshot(sessionId: string): GoalExecutionSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  getDecisionEpoch(sessionId: string): number {
    return this.decisionEpochs.get(sessionId) ?? 0;
  }

  /** Retire old asynchronous decisions before the user's first preparation await. */
  invalidateForUserTurn(sessionId: string): void {
    this.invalidateDecision(sessionId);
    this.cancelRetry(sessionId, true);
    this.retryTargets.delete(sessionId);
    this.continuationTargets.delete(sessionId);
  }

  /** A change notification may recheck retained settlement, but cannot create authority. */
  async recheck(sessionId: string): Promise<void> {
    const retained = this.continuationTargets.get(sessionId);
    const snapshot = this.snapshots.get(sessionId);
    if (!retained || this.stoppedSessionIds.has(sessionId) || this.dispatchLanes.has(sessionId) ||
      snapshot?.phase !== GoalExecutionPhase.Waiting || snapshot.identityPending ||
      this.latestRunIds.get(sessionId) !== retained.runId) return;
    await this.retry(
      sessionId, retained.sessionKey, retained.goalId, this.generation, retained.target,
    );
  }

  /** Restore only authenticated native settlement, never a sessions.list idle projection. */
  async reconcileNativeObservation(
    sessionId: string,
    sessionKey: string,
    goal: SessionGoal,
    describedSession: Record<string, unknown> | null | undefined,
  ): Promise<void> {
    if (!isManagedGoalSessionKey(sessionKey) ||
      this.dependencies.resolveSessionId(sessionKey) !== sessionId ||
      this.stoppedSessionIds.has(sessionId) || this.dispatchLanes.has(sessionId) ||
      this.retryTimers.has(sessionId) ||
      this.snapshots.get(sessionId)?.identityPending) return;
    this.invalidateDecision(sessionId);
    this.cancelRetry(sessionId, true);
    this.continuationTargets.delete(sessionId);
    this.sessionKeys.set(sessionId, sessionKey);
    const observationValue = describedSession?.goalContinuation;
    const observation = observationValue && typeof observationValue === 'object' &&
      !Array.isArray(observationValue) ? observationValue as Record<string, unknown> : null;
    const predecessorValue = observation?.predecessor;
    const predecessor = predecessorValue && typeof predecessorValue === 'object' &&
      !Array.isArray(predecessorValue) ? predecessorValue as Record<string, unknown> : null;
    const nativeSessionId = describedSession?.sessionId;
    const lifecycleRevision = describedSession?.lifecycleRevision;
    const describedGoal = asGoal(describedSession?.goal);
    const predecessorRunId = predecessor?.runId;
    const hasExactSettlement = describedSession?.key === sessionKey &&
      describedGoal?.id === goal.id && describedGoal.status === goal.status &&
      observation?.continuationTurns === describedGoal.continuationTurns &&
      typeof nativeSessionId === 'string' && Boolean(nativeSessionId.trim()) &&
      typeof lifecycleRevision === 'string' && Boolean(lifecycleRevision.trim()) &&
      predecessor?.sessionId === nativeSessionId &&
      predecessor.lifecycleRevision === lifecycleRevision &&
      predecessor.goalId === goal.id &&
      typeof predecessorRunId === 'string' && Boolean(predecessorRunId.trim()) &&
      predecessor.executionSettled === true &&
      (predecessor.phase === 'end' || predecessor.phase === 'error');
    if (goal.status !== SessionGoalStatus.Active) {
      this.publishGoalState(sessionId, goal, goal.continuationTurns);
      return;
    }
    this.publish({
      sessionId, goalId: goal.id, phase: GoalExecutionPhase.Waiting,
      ...(hasExactSettlement ? { runId: predecessorRunId as string } : {}),
      waitingReason: predecessor?.yielded === true ? 'native-wake' : 'native-guard',
      continuationCount: goal.continuationTurns, updatedAt: this.now(),
    });
    if (!hasExactSettlement) return;
    const target: GoalSessionTarget = {
      sessionId: nativeSessionId as string, lifecycleRevision: lifecycleRevision as string,
    };
    this.sessionTargets.set(sessionKey, {
      sessionId: target.sessionId, lifecycleRevision: target.lifecycleRevision ?? null,
    });
    this.latestRunIds.set(sessionId, predecessorRunId as string);
    this.continuationTargets.set(sessionId, {
      sessionKey, runId: predecessorRunId as string, target, goalId: goal.id,
    });
    if (observation?.blockedReason) {
      if (observation.blockedReason === 'limit-reached' ||
        observation.blockedReason === 'stale-predecessor') {
        this.stop(sessionId);
        this.confirmStop(sessionId);
      }
      return;
    }
    await this.recheck(sessionId);
  }

  private invalidateDecision(sessionId: string): void {
    this.decisionEpochs.set(sessionId, (this.decisionEpochs.get(sessionId) ?? 0) + 1);
    this.dispatchLanes.delete(sessionId);
  }

  private beginDecision(sessionId: string): GoalDecision | null {
    if (this.dispatchLanes.has(sessionId)) return null;
    const decision: GoalDecision = {
      token: Symbol(),
      epoch: this.decisionEpochs.get(sessionId) ?? 0,
      generation: this.generation,
      stopGeneration: this.stopGenerations.get(sessionId) ?? 0,
      runId: this.latestRunIds.get(sessionId),
    };
    this.dispatchLanes.set(sessionId, decision);
    return decision;
  }

  private isCurrentDecision(sessionId: string, decision: GoalDecision, allowStopped = false): boolean {
    return decision.generation === this.generation &&
      decision.epoch === (this.decisionEpochs.get(sessionId) ?? 0) &&
      decision.stopGeneration === (this.stopGenerations.get(sessionId) ?? 0) &&
      this.dispatchLanes.get(sessionId)?.token === decision.token &&
      this.latestRunIds.get(sessionId) === decision.runId &&
      (allowStopped || !this.stoppedSessionIds.has(sessionId));
  }

  private finishDecision(sessionId: string, decision: GoalDecision): void {
    if (this.dispatchLanes.get(sessionId)?.token === decision.token) {
      this.dispatchLanes.delete(sessionId);
    }
  }

  private stopForGoalChange(sessionId: string, goal: SessionGoal): void {
    this.stop(sessionId);
    this.publish({
      sessionId, goalId: goal.id, phase: GoalExecutionPhase.Stopped,
      continuationCount: goal.continuationTurns, updatedAt: this.now(),
      error: 'Goal changed while an automatic continuation was pending',
    });
  }

  restoreRunning(sessionId: string, goalId: string, runId?: string, nativeContinuationTurns?: number): void {
    if (runId && this.latestRunIds.get(sessionId) !== runId) {
      this.invalidateDecision(sessionId);
      this.continuationTargets.delete(sessionId);
    }
    this.cancelRetry(sessionId, true);
    this.retryTargets.delete(sessionId);
    this.stoppedSessionIds.delete(sessionId);
    this.snapshotsBeforeStop.delete(sessionId);
    if (runId) this.latestRunIds.set(sessionId, runId);
    this.publish({
      sessionId,
      goalId,
      phase: GoalExecutionPhase.Running,
      ...(runId ? { runId } : {}),
      continuationCount: nativeContinuationTurns ?? this.snapshots.get(sessionId)?.continuationCount ?? 0,
      updatedAt: this.now(),
    });
  }

  synchronizeGoal(
    sessionId: string,
    goal: SessionGoal | null,
    options: { preserveStopped?: boolean } = {},
  ): void {
    if (goal?.status !== SessionGoalStatus.Active ||
      (this.snapshots.get(sessionId)?.goalId && this.snapshots.get(sessionId)?.goalId !== goal.id)) {
      this.invalidateDecision(sessionId);
      this.continuationTargets.delete(sessionId);
    }
    this.cancelRetry(sessionId, true);
    const current = this.snapshots.get(sessionId);
    if (
      options.preserveStopped &&
      current?.phase === GoalExecutionPhase.Stopped &&
      goal?.status === SessionGoalStatus.Active
    ) {
      this.stoppedSessionIds.add(sessionId);
      this.publish({ ...current, goalId: goal.id, updatedAt: this.now() });
      return;
    }
    if (goal?.status === SessionGoalStatus.Paused) {
      this.stoppedSessionIds.add(sessionId);
    } else {
      this.stoppedSessionIds.delete(sessionId);
      this.snapshotsBeforeStop.delete(sessionId);
    }
    this.publishGoalState(sessionId, goal, this.snapshots.get(sessionId)?.continuationCount ?? 0);
  }

  clearSession(sessionId: string): void {
    this.invalidateDecision(sessionId);
    this.continuationTargets.delete(sessionId);
    this.dependencies.eventAdmission.clearSession(sessionId);
    const sessionKey = this.sessionKeys.get(sessionId);
    if (sessionKey) this.sessionTargets.delete(sessionKey);
    this.sessionKeys.delete(sessionId);
    this.cancelRetry(sessionId, true);
    this.retryTargets.delete(sessionId);
    const runIds = new Set([
      this.latestRunIds.get(sessionId),
      this.snapshots.get(sessionId)?.runId,
    ]);
    for (const runId of runIds) {
      if (!runId) continue;
      this.rememberProcessedTerminalRun(runId);
      this.continuationRuns.delete(runId);
      this.terminalGoalRuns.delete(runId);
      for (const key of this.pendingGoalUpdates.keys()) {
        if (key.startsWith(`${runId}:`)) this.pendingGoalUpdates.delete(key);
      }
    }
    this.snapshots.delete(sessionId);
    this.stoppedSessionIds.delete(sessionId);
    this.latestRunIds.delete(sessionId);
    this.snapshotsBeforeStop.delete(sessionId);
    this.stopGenerations.set(sessionId, (this.stopGenerations.get(sessionId) ?? 0) + 1);
    this.dependencies.onSnapshot({
      sessionId,
      phase: GoalExecutionPhase.Waiting,
      continuationCount: 0,
      updatedAt: this.now(),
    });
  }

  restoreSnapshot(snapshot: GoalExecutionSnapshot): void {
    this.invalidateDecision(snapshot.sessionId);
    this.cancelRetry(snapshot.sessionId, true);
    if (snapshot.phase === GoalExecutionPhase.Stopped) {
      this.stoppedSessionIds.add(snapshot.sessionId);
    } else {
      this.stoppedSessionIds.delete(snapshot.sessionId);
    }
    this.publish({ ...snapshot, updatedAt: this.now() });
  }

  clear(): void {
    this.generation += 1;
    this.dependencies.eventAdmission.clear();
    this.sessionTargets.clear();
    const clearedSnapshots = [...this.snapshots.values()];
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    this.retryTargets.clear();
    this.snapshots.clear();
    this.sessionKeys.clear();
    this.processedTerminalRuns.clear();
    this.stoppedSessionIds.clear();
    this.continuationRuns.clear();
    this.dispatchLanes.clear();
    this.decisionEpochs.clear();
    this.continuationTargets.clear();
    this.latestRunIds.clear();
    this.pendingGoalUpdates.clear();
    this.terminalGoalRuns.clear();
    this.snapshotsBeforeStop.clear();
    this.stopGenerations.clear();
    for (const snapshot of clearedSnapshots) {
      this.dependencies.onSnapshot({
        sessionId: snapshot.sessionId,
        phase: GoalExecutionPhase.Waiting,
        continuationCount: 0,
        updatedAt: this.now(),
      });
    }
  }

  stop(sessionId: string): void {
    this.invalidateDecision(sessionId);
    this.stopGenerations.set(sessionId, (this.stopGenerations.get(sessionId) ?? 0) + 1);
    if (!this.stoppedSessionIds.has(sessionId)) {
      this.snapshotsBeforeStop.set(sessionId, this.snapshots.get(sessionId) ?? null);
    }
    this.stoppedSessionIds.add(sessionId);
    this.cancelRetry(sessionId, true);
  }

  confirmStop(sessionId: string): void {
    if (!this.stoppedSessionIds.has(sessionId)) return;
    const current = this.snapshots.get(sessionId);
    this.publish({
      sessionId,
      ...(current?.goalId ? { goalId: current.goalId } : {}),
      phase: GoalExecutionPhase.Stopped,
      continuationCount: current?.continuationCount ?? 0,
      updatedAt: this.now(),
    });
    this.snapshotsBeforeStop.delete(sessionId);
  }

  rollbackStop(sessionId: string): void {
    if (!this.stoppedSessionIds.delete(sessionId)) return;
    const previous = this.snapshotsBeforeStop.get(sessionId);
    this.snapshotsBeforeStop.delete(sessionId);
    if (previous) {
      this.publish({ ...previous, updatedAt: this.now() });
      const sessionKey = this.sessionKeys.get(sessionId);
      if (sessionKey && (previous.phase === GoalExecutionPhase.Retrying ||
        previous.phase === GoalExecutionPhase.Continuing)) {
        // stop() invalidates in-flight dispatches and cancels retry timers.
        // Restoring only the snapshot would leave an active task with no work
        // scheduled after a failed cancellation.
        this.scheduleRetry(sessionId, sessionKey, previous.goalId, previous.error);
      }
      return;
    }
    this.snapshots.delete(sessionId);
    this.dependencies.onSnapshot({
      sessionId,
      phase: GoalExecutionPhase.Waiting,
      continuationCount: 0,
      updatedAt: this.now(),
    });
  }

  async continue(sessionId: string, sessionKey: string): Promise<GoalExecutionSnapshot> {
    this.sessionKeys.set(sessionId, sessionKey);
    const generation = this.generation;
    const stopGeneration = this.stopGenerations.get(sessionId) ?? 0;
    if (!isManagedGoalSessionKey(sessionKey)) {
      throw new Error('Goal continuation is only available for managed JustDo sessions');
    }
    const current = this.snapshots.get(sessionId);
    if (
      this.dispatchLanes.has(sessionId) ||
      current?.phase === GoalExecutionPhase.Running ||
      current?.phase === GoalExecutionPhase.Continuing
    ) {
      throw new Error('The session goal is already running');
    }
    const decision = this.beginDecision(sessionId)!;
    try {
      const goal = await this.readGoal(sessionKey, decision, true);
      if (generation !== this.generation) throw new Error('OpenClaw Gateway connection changed');
      if ((this.stopGenerations.get(sessionId) ?? 0) !== stopGeneration) {
        throw new Error('Goal execution was stopped');
      }
      if (!this.isCurrentDecision(sessionId, decision, true)) {
        throw new Error('Goal continuation was superseded');
      }
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        throw new Error('The session does not have an active goal');
      }
      this.stoppedSessionIds.delete(sessionId);
      this.snapshotsBeforeStop.delete(sessionId);
      this.cancelRetry(sessionId, true);
      this.retryTargets.delete(sessionId);
      try {
        await this.dispatchContinuation(
          sessionId,
          sessionKey,
          goal,
          generation,
          stopGeneration,
          false,
          undefined,
          decision,
        );
        if (!this.snapshots.has(sessionId)) throw new Error('Goal execution was stopped');
      } catch (error) {
        if (
          !this.isCurrentDecision(sessionId, decision) ||
          generation !== this.generation ||
          (this.stopGenerations.get(sessionId) ?? 0) !== stopGeneration ||
          this.stoppedSessionIds.has(sessionId)
        ) {
          throw error;
        }
        this.scheduleRetry(sessionId, sessionKey, goal.id, error);
      }
      return this.snapshots.get(sessionId)!;
    } finally {
      this.finishDecision(sessionId, decision);
    }
  }

  async handleLifecycle(event: GoalLifecycleEvent): Promise<void> {
    if (!isManagedGoalSessionKey(event.sessionKey) || event.spawnedBy) return;
    const sessionId = this.dependencies.resolveSessionId(event.sessionKey);
    if (!sessionId || !this.dependencies.eventAdmission.admit(sessionId, event)) return;
    await this.processLifecycle(event);
  }

  /** The caller has checked the exact agent.wait run ID and terminal receipt. */
  async reconcileSettledRun(
    event: GoalLifecycleEvent & { phase: 'end' | 'error'; executionSettled: true },
  ): Promise<void> {
    await this.processLifecycle(event);
  }

  private async processLifecycle(event: GoalLifecycleEvent): Promise<void> {
    if (!isManagedGoalSessionKey(event.sessionKey) || event.spawnedBy) return;
    // Attempt terminals can precede provider retries and the final run outcome.
    // Do not deduplicate or continue until the native execution has settled.
    if (event.phase !== 'start' && event.executionSettled !== true) return;
    const sessionId = this.dependencies.resolveSessionId(event.sessionKey);
    if (!sessionId) return;
    this.sessionKeys.set(sessionId, event.sessionKey);
    if (this.processedTerminalRuns.has(event.runId)) return;
    if (event.phase === 'start') {
      const isContinuation = this.continuationRuns.has(event.runId);
      if (!isContinuation && this.latestRunIds.get(sessionId) !== event.runId) {
        this.invalidateDecision(sessionId);
        this.continuationTargets.delete(sessionId);
      }
      this.latestRunIds.set(sessionId, event.runId);
      if (this.stoppedSessionIds.has(sessionId)) return;
      if (!isContinuation) {
        this.snapshotsBeforeStop.delete(sessionId);
        this.cancelRetry(sessionId, true);
        this.retryTargets.delete(sessionId);
      }
      const current = this.snapshots.get(sessionId);
      this.publish({
        sessionId,
        ...(current?.goalId ? { goalId: current.goalId } : {}),
        phase: GoalExecutionPhase.Running,
        runId: event.runId,
        continuationCount: current?.continuationCount ?? 0,
        updatedAt: this.now(),
      });
      return;
    }

    const knownTarget = this.continuationRuns.get(event.runId);
    this.continuationRuns.delete(event.runId);
    const terminalStatus = this.terminalGoalRuns.get(event.runId) ?? null;
    this.terminalGoalRuns.delete(event.runId);
    for (const key of this.pendingGoalUpdates.keys()) {
      if (key.startsWith(`${event.runId}:`)) this.pendingGoalUpdates.delete(key);
    }
    if (this.processedTerminalRuns.has(event.runId)) return;
    this.rememberProcessedTerminalRun(event.runId);
    const latestRunId = this.latestRunIds.get(sessionId);
    if (latestRunId && latestRunId !== event.runId) return;
    if (!latestRunId) this.latestRunIds.set(sessionId, event.runId);
    let terminalTarget = event.sessionId
      ? knownTarget?.sessionId === event.sessionId ? knownTarget : { sessionId: event.sessionId }
      : knownTarget ?? this.sessionTargets.get(event.sessionKey);

    const current = this.snapshots.get(sessionId);
    const generation = this.generation;
    const sessionGeneration = this.stopGenerations.get(sessionId) ?? 0;
    if (this.stoppedSessionIds.has(sessionId)) {
      // Stop is a session-level latch and only Continue may clear it. Keep its
      // snapshot attached to a replacement active Goal so the renderer does
      // not hide the only recovery action because of a stale Goal identity.
      try {
        const stoppedGoal = await this.readGoal(event.sessionKey);
        if (
          generation === this.generation &&
          this.stoppedSessionIds.has(sessionId) &&
          this.latestRunIds.get(sessionId) === event.runId &&
          stoppedGoal?.status === SessionGoalStatus.Active &&
          stoppedGoal.id !== current?.goalId
        ) {
          this.publish({
            sessionId,
            goalId: stoppedGoal.id,
            phase: GoalExecutionPhase.Stopped,
            continuationCount: 0,
            updatedAt: this.now(),
          });
        }
      } catch {
        // Preserve the explicit Stop when the Gateway cannot be inspected.
      }
      return;
    }
    if (terminalStatus) {
      this.cancelRetry(sessionId, true);
      this.publish({
        sessionId,
        ...(current?.goalId ? { goalId: current.goalId } : {}),
        phase: terminalPhase(terminalStatus),
        continuationCount: current?.continuationCount ?? 0,
        updatedAt: this.now(),
      });
      return;
    }
    if (terminalTarget) {
      this.continuationTargets.set(sessionId, {
        sessionKey: event.sessionKey,
        runId: event.runId,
        target: terminalTarget,
        goalId: current?.goalId,
      });
    }
    if (isYieldedWaiting(event)) {
      this.cancelRetry(sessionId, true);
      this.publish({
        sessionId,
        ...(current?.goalId ? { goalId: current.goalId } : {}),
        phase: GoalExecutionPhase.Waiting,
        runId: event.runId,
        waitingReason: 'native-wake',
        continuationCount: current?.continuationCount ?? 0,
        updatedAt: this.now(),
      });
      return;
    }
    if (event.aborted || event.phase === 'error') {
      const decision = this.beginDecision(sessionId);
      if (!decision) {
        this.scheduleRetry(sessionId, event.sessionKey, current?.goalId,
          'Goal continuation dispatch is still settling', terminalTarget);
        return;
      }
      let retryGoalId = current?.goalId;
      let nativeContinuationTurns: number | undefined;
      try {
        let retryGoal: SessionGoal | null | undefined;
        try {
          retryGoal = await this.readGoal(event.sessionKey, decision);
        } catch {
          // A failed read preserves the original terminal's identity for retry.
        }
        if (!this.isCurrentDecision(sessionId, decision)) return;
        if (retryGoal !== undefined) {
          if (!retryGoal || retryGoal.status !== SessionGoalStatus.Active) {
            this.publishGoalState(sessionId, retryGoal, current?.continuationCount ?? 0);
            return;
          }
          if (retryGoalId && retryGoal.id !== retryGoalId) {
            this.stopForGoalChange(sessionId, retryGoal);
            return;
          }
          retryGoalId = retryGoal.id;
          nativeContinuationTurns = retryGoal.continuationTurns;
          if (!this.matchesTarget(this.sessionTargets.get(event.sessionKey), terminalTarget)) {
            this.stop(sessionId);
            this.confirmStop(sessionId);
            return;
          }
          terminalTarget = this.sessionTargets.get(event.sessionKey);
          if (terminalTarget) this.retryTargets.set(sessionId, terminalTarget);
        }
        this.scheduleRetry(
          sessionId,
          event.sessionKey,
          retryGoalId,
          event.error || (event.aborted ? 'Goal run was interrupted' : 'Goal continuation failed'),
          terminalTarget,
          nativeContinuationTurns,
        );
      } finally {
        this.finishDecision(sessionId, decision);
      }
      return;
    }
    this.retryAttempts.delete(sessionId);
    if (this.dispatchLanes.has(sessionId)) {
      this.scheduleRetry(
        sessionId,
        event.sessionKey,
        current?.goalId,
        'Goal continuation dispatch is still settling',
        terminalTarget,
      );
      return;
    }

    const decision = this.beginDecision(sessionId)!;
    try {
      let goal = await this.readGoal(event.sessionKey, decision);
      if (
        !this.isCurrentDecision(sessionId, decision) ||
        generation !== this.generation ||
        (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration ||
        this.stoppedSessionIds.has(sessionId)
      ) {
        return;
      }
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        this.cancelRetry(sessionId, true);
        this.publishGoalState(sessionId, goal, current?.continuationCount ?? 0);
        return;
      }
      if (current?.goalId && current.goalId !== goal.id) {
        this.stopForGoalChange(sessionId, goal);
        return;
      }
      if (!this.matchesTarget(this.sessionTargets.get(event.sessionKey), terminalTarget)) {
        this.stop(sessionId);
        this.confirmStop(sessionId);
        return;
      }
      terminalTarget = this.sessionTargets.get(event.sessionKey);
      if (terminalTarget) this.retryTargets.set(sessionId, terminalTarget);
      if (terminalTarget) {
        this.continuationTargets.set(sessionId, {
          sessionKey: event.sessionKey, runId: event.runId, target: terminalTarget, goalId: goal.id,
        });
      }
      const goalId = goal.id;
      this.publish({
        sessionId,
        goalId,
        phase: GoalExecutionPhase.Continuing,
        continuationCount: goal.continuationTurns,
        updatedAt: this.now(),
      });
      await this.dependencies.waitBeforeAutomaticContinuation?.();
      if (
        !this.isCurrentDecision(sessionId, decision) ||
        generation !== this.generation ||
        (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration ||
        this.stoppedSessionIds.has(sessionId) ||
        (this.latestRunIds.has(sessionId) && this.latestRunIds.get(sessionId) !== event.runId)
      ) {
        return;
      }
      goal = await this.readGoal(event.sessionKey, decision);
      if (
        !this.isCurrentDecision(sessionId, decision) ||
        generation !== this.generation ||
        (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration ||
        this.stoppedSessionIds.has(sessionId) ||
        (this.latestRunIds.has(sessionId) && this.latestRunIds.get(sessionId) !== event.runId)
      ) {
        return;
      }
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        this.publishGoalState(sessionId, goal, 0);
        return;
      }
      if (goal.id !== goalId) {
        this.stopForGoalChange(sessionId, goal);
        return;
      }
      try {
        await this.dispatchContinuation(
          sessionId,
          event.sessionKey,
          goal,
          generation,
          sessionGeneration,
          true,
          terminalTarget,
          decision,
        );
      } catch (error) {
        if (
          this.isCurrentDecision(sessionId, decision) &&
          generation === this.generation &&
          (this.stopGenerations.get(sessionId) ?? 0) === sessionGeneration &&
          !this.stoppedSessionIds.has(sessionId)
        ) {
          this.scheduleRetry(sessionId, event.sessionKey, goal.id, error, terminalTarget);
        }
      }
    } catch (error) {
      if (
        this.isCurrentDecision(sessionId, decision) &&
        generation === this.generation &&
        (this.stopGenerations.get(sessionId) ?? 0) === sessionGeneration &&
        !this.stoppedSessionIds.has(sessionId)
      ) {
        this.scheduleRetry(sessionId, event.sessionKey, current?.goalId, error, terminalTarget);
      }
    } finally {
      this.finishDecision(sessionId, decision);
    }
  }

  handleToolEvent(event: GoalToolEvent): void {
    if (
      !isManagedGoalSessionKey(event.sessionKey) ||
      event.spawnedBy ||
      !event.toolCallId ||
      event.name.trim().toLowerCase() !== 'update_goal'
    ) {
      return;
    }
    const sessionId = this.dependencies.resolveSessionId(event.sessionKey);
    if (!sessionId) return;
    if (!this.dependencies.eventAdmission.admit(sessionId, event)) return;
    if (this.processedTerminalRuns.has(event.runId)) return;
    const key = `${event.runId}:${event.toolCallId}`;
    const requestedStatus = readGoalTerminalStatus(event.input);
    if (event.status === 'running') {
      if (requestedStatus) this.pendingGoalUpdates.set(key, requestedStatus);
      return;
    }
    const pendingStatus = this.pendingGoalUpdates.get(key);
    this.pendingGoalUpdates.delete(key);
    const status = requestedStatus || pendingStatus;
    if (event.status !== 'completed' || event.failed || !status) return;
    const updatedGoal = readUpdatedGoal(event.output);
    if (!updatedGoal || updatedGoal.status !== status) return;
    const current = this.snapshots.get(sessionId);
    if (current?.goalId && current.goalId !== updatedGoal.id) return;
    const latestRunId = this.latestRunIds.get(sessionId);
    if (latestRunId && latestRunId !== event.runId) return;
    this.terminalGoalRuns.set(event.runId, status);
    this.cancelRetry(sessionId, true);
    this.publish({
      sessionId,
      goalId: updatedGoal.id,
      phase: terminalPhase(status),
      continuationCount: current?.continuationCount ?? 0,
      updatedAt: this.now(),
    });
  }

  private async readGoal(
    sessionKey: string,
    decision?: GoalDecision,
    allowStopped = false,
  ): Promise<SessionGoal | null> {
    const client = this.dependencies.getClient();
    if (!client) throw new Error('OpenClaw Gateway is not connected');
    const result = await client.request<{ session?: GatewaySession | null }>('sessions.describe', {
      key: sessionKey,
    });
    if (result.session && result.session.key !== sessionKey) {
      throw new Error('Gateway returned a different Goal session key');
    }
    const sessionId = this.dependencies.resolveSessionId(sessionKey);
    if (decision && (!sessionId || !this.isCurrentDecision(sessionId, decision, allowStopped))) {
      return asGoal(result.session?.goal);
    }
    const nativeSessionId = result.session?.sessionId;
    if (typeof nativeSessionId === 'string' && nativeSessionId.trim()) {
      this.sessionTargets.set(sessionKey, {
        sessionId: nativeSessionId,
        lifecycleRevision:
          typeof result.session?.lifecycleRevision === 'string'
            ? result.session.lifecycleRevision
            : null,
      });
    } else {
      this.sessionTargets.delete(sessionKey);
    }
    return asGoal(result.session?.goal);
  }

  private async dispatchContinuation(
    sessionId: string,
    sessionKey: string,
    goal: SessionGoal,
    generation: number,
    sessionGeneration: number,
    enforceMaxContinuationTurns = true,
    expectedTarget?: GoalSessionTarget,
    decision?: GoalDecision,
  ): Promise<void> {
    if (!decision || !this.isCurrentDecision(sessionId, decision)) return;
    if (
      generation !== this.generation ||
      (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration
    ) {
      throw new Error('OpenClaw Gateway connection changed');
    }
    const client = this.dependencies.getClient();
    if (!client) throw new Error('OpenClaw Gateway is not connected');
    const current = this.snapshots.get(sessionId);
    let continuationCount = goal.continuationTurns;
    const maxContinuationTurns = Math.max(0, Math.floor(this.dependencies.getMaxContinuationTurns()));
    this.publish({
      sessionId,
      goalId: goal.id,
      phase: GoalExecutionPhase.Continuing,
      continuationCount,
      updatedAt: this.now(),
    });

    const target = this.sessionTargets.get(sessionKey);
    const previousRunId = this.latestRunIds.get(sessionId);
    if (!target) throw new Error('Goal session identity is unavailable');
    if (!this.matchesTarget(target, expectedTarget)) {
      this.stop(sessionId);
      this.confirmStop(sessionId);
      return;
    }
    this.retryTargets.set(sessionId, target);
    await this.dependencies.prepareSessionForContinuation?.(sessionId);
    if (!this.isCurrentDecision(sessionId, decision)) return;
    if (generation !== this.generation) throw new Error('OpenClaw Gateway connection changed');
    if (
      (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration ||
      this.stoppedSessionIds.has(sessionId)
    ) {
      throw new Error('Goal execution was stopped');
    }
    const preparedGoal = await this.readGoal(sessionKey, decision);
    if (
      !this.isCurrentDecision(sessionId, decision) ||
      generation !== this.generation ||
      (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration ||
      this.stoppedSessionIds.has(sessionId) ||
      this.latestRunIds.get(sessionId) !== previousRunId
    ) {
      return;
    }
    const preparedTarget = this.sessionTargets.get(sessionKey);
    if (!preparedGoal || preparedGoal.status !== SessionGoalStatus.Active) {
      this.publishGoalState(sessionId, preparedGoal, current?.continuationCount ?? 0);
      return;
    }
    if (
      preparedGoal.id !== goal.id ||
      preparedTarget?.sessionId !== target.sessionId ||
      preparedTarget.lifecycleRevision !== target.lifecycleRevision
    ) {
      this.stop(sessionId);
      this.publish({
        sessionId,
        goalId: preparedGoal.id,
        phase: GoalExecutionPhase.Stopped,
        continuationCount: current?.continuationCount ?? 0,
        updatedAt: this.now(),
        error: 'Goal or native session changed during continuation preparation',
      });
      return;
    }

    const predecessorRunId = decision.runId;
    if (enforceMaxContinuationTurns && !predecessorRunId) {
      this.publish({
        sessionId, goalId: preparedGoal.id, phase: GoalExecutionPhase.Waiting,
        waitingReason: 'native-guard', continuationCount: preparedGoal.continuationTurns,
        updatedAt: this.now(),
      });
      return;
    }
    continuationCount = preparedGoal.continuationTurns;
    if (enforceMaxContinuationTurns && predecessorRunId) {
      this.continuationTargets.set(sessionId, {
        sessionKey, runId: predecessorRunId, target, goalId: preparedGoal.id,
      });
    }
    const runId = randomUUID();
    this.continuationRuns.set(runId, target);
    decision.runId = runId;
    this.latestRunIds.set(sessionId, runId);
    this.dependencies.onRunAccepted(sessionId, sessionKey, runId, target.sessionId);
    try {
      // Normal chat.send turns receive OpenClaw's native bounded active-Goal context. Automatic
      // continuations use the lower-level agent RPC so the synthetic prompt stays out of history
      // and JustDo can retain its stricter completion and blocked-state policy.
      const receipt = await client.request('agent', {
        message: buildContinuationPrompt(preparedGoal),
        extraSystemPrompt: CONTINUATION_SYSTEM_PROMPT,
        sessionKey,
        expectedExistingSessionId: target.sessionId,
        expectedExistingSessionLifecycleRevision: target.lifecycleRevision,
        agentId: this.dependencies.resolveAgentId(sessionId),
        deliver: false,
        suppressPromptPersistence: true,
        idempotencyKey: runId,
        ...(enforceMaxContinuationTurns ? {
          goalContinuation: {
            goalId: preparedGoal.id,
            predecessorRunId,
            maxAutomaticContinuations: maxContinuationTurns,
            automatic: true,
          },
        } : {}),
      });
      if (receipt.runId !== runId || (receipt.status !== 'accepted' && receipt.status !== 'in_flight')) {
        throw new Error('Gateway returned an unconfirmed Goal continuation receipt');
      }
      if (enforceMaxContinuationTurns) {
        const acceptedValue = receipt.goalContinuation;
        const accepted = acceptedValue && typeof acceptedValue === 'object' &&
          !Array.isArray(acceptedValue) ? acceptedValue as Record<string, unknown> : null;
        if (!accepted || accepted.goalId !== preparedGoal.id ||
          accepted.predecessorRunId !== predecessorRunId ||
          typeof accepted.continuationTurns !== 'number' ||
          !Number.isSafeInteger(accepted.continuationTurns) || accepted.continuationTurns < 0 ||
          typeof accepted.acceptedAt !== 'number' || !Number.isFinite(accepted.acceptedAt) ||
          accepted.acceptedAt < 0) {
          throw new Error('Gateway returned an unconfirmed Goal continuation admission');
        }
        continuationCount = accepted.continuationTurns;
      }
    } catch (error) {
      if (
        !this.isCurrentDecision(sessionId, decision) ||
        generation !== this.generation ||
        this.latestRunIds.get(sessionId) !== runId ||
        this.processedTerminalRuns.has(runId)
      ) {
        return;
      }
      const deferredReason = readContinuationDeferredReason(error);
      if (
        deferredReason ||
        isDefinitiveSessionGoalGatewayError(error) ||
        (error && typeof error === 'object' && 'requestSent' in error && error.requestSent === false)
      ) {
        this.continuationRuns.delete(runId);
        this.dependencies.onRunFailed(sessionId, runId);
        decision.runId = predecessorRunId;
        if (predecessorRunId) this.latestRunIds.set(sessionId, predecessorRunId);
        else this.latestRunIds.delete(sessionId);
        if (deferredReason) {
          if (deferredReason === 'goal-inactive') {
            this.cancelRetry(sessionId, true);
            const latestGoal = await this.readGoal(sessionKey, decision);
            if (this.isCurrentDecision(sessionId, decision)) {
              this.publishGoalState(sessionId, latestGoal, latestGoal?.continuationTurns ?? continuationCount);
            }
          } else if (deferredReason === 'stale-predecessor') {
            this.stop(sessionId);
            this.confirmStop(sessionId);
          } else if (deferredReason === 'limit-reached') {
            this.cancelRetry(sessionId, true);
            this.publish({
              sessionId, goalId: preparedGoal.id,
              phase: GoalExecutionPhase.Stopped,
              ...(predecessorRunId ? { runId: predecessorRunId } : {}),
              error: `Maximum automatic goal continuation turns reached (${maxContinuationTurns})`,
              continuationCount, updatedAt: this.now(),
            });
          } else {
            // Native cleanup can release its lease without another session event.
            // A definite preaccept refusal may be rechecked; unknown sends may not.
            this.scheduleRetry(sessionId, sessionKey, preparedGoal.id, error, target, continuationCount);
          }
          return;
        }
        throw error;
      }
      // A sent request can execute before its ACK is lost. Preserve custody and
      // reconcile this exact run; a new idempotency key could repeat side effects.
      this.cancelRetry(sessionId, false);
      if (!this.stoppedSessionIds.has(sessionId)) {
        this.publish({
          sessionId,
          goalId: goal.id,
          phase: GoalExecutionPhase.Running,
          runId,
          continuationCount,
          updatedAt: this.now(),
          identityPending: true,
          error: errorSummary(error),
        });
      }
      this.dependencies.onRunUnknown(sessionId, runId);
      return;
    }
    if (
      !this.isCurrentDecision(sessionId, decision) ||
      generation !== this.generation ||
      this.stoppedSessionIds.has(sessionId) ||
      this.latestRunIds.get(sessionId) !== runId ||
      this.processedTerminalRuns.has(runId)
    ) {
      return;
    }
    this.dependencies.onRunConfirmed(sessionId, runId);
    this.continuationTargets.delete(sessionId);
    this.cancelRetry(sessionId, false);
    this.publish({
      sessionId,
      goalId: goal.id,
      phase: GoalExecutionPhase.Running,
      runId,
      continuationCount,
      updatedAt: this.now(),
    });
  }

  private scheduleRetry(
    sessionId: string,
    sessionKey: string,
    goalId: string | undefined,
    error: unknown,
    expectedTarget = this.retryTargets.get(sessionId) ?? this.sessionTargets.get(sessionKey),
    nativeContinuationTurns?: number,
  ): void {
    if (this.stoppedSessionIds.has(sessionId)) return;
    // Keep the original terminal's fence even when Stop fails and rollbackStop
    // rearms the retry after its timer was cancelled.
    if (expectedTarget) this.retryTargets.set(sessionId, expectedTarget);
    this.cancelRetry(sessionId, false);
    const attempt = (this.retryAttempts.get(sessionId) ?? 0) + 1;
    this.retryAttempts.set(sessionId, attempt);
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    const nextRetryAt = this.now() + delay;
    const current = this.snapshots.get(sessionId);
    const summary = errorSummary(error);
    const resolvedGoalId = goalId || current?.goalId;
    const deferredReason = readContinuationDeferredReason(error);
    const nativeGuardWait = deferredReason === 'main-running' || deferredReason === 'queued-input' ||
      deferredReason === 'native-handoff' || deferredReason === 'predecessor-unconfirmed';
    const predecessorRunId = this.latestRunIds.get(sessionId);
    this.publish({
      sessionId,
      ...(resolvedGoalId ? { goalId: resolvedGoalId } : {}),
      phase: nativeGuardWait ? GoalExecutionPhase.Waiting : GoalExecutionPhase.Retrying,
      ...(nativeGuardWait ? {
        waitingReason: 'native-guard' as const,
        ...(predecessorRunId ? { runId: predecessorRunId } : {}),
      } : { error: summary }),
      continuationCount: nativeContinuationTurns ?? current?.continuationCount ?? 0,
      updatedAt: this.now(),
      retryAttempt: attempt,
      nextRetryAt,
    });
    coworkLog(nativeGuardWait ? 'INFO' : 'WARN', 'GoalContinuation', nativeGuardWait
      ? 'Native Goal admission deferred; recheck scheduled'
      : 'Goal run failed; automatic retry scheduled', {
      sessionId,
      retryAttempt: attempt,
      nextRetryAt,
      error: summary,
    });
    const generation = this.generation;
    this.retryTimers.set(
      sessionId,
      setTimeout(() => {
        this.retryTimers.delete(sessionId);
        void this.retry(sessionId, sessionKey, goalId, generation, expectedTarget, predecessorRunId);
      }, delay),
    );
  }

  private async retry(
    sessionId: string,
    sessionKey: string,
    expectedGoalId: string | undefined,
    generation: number,
    expectedTarget?: GoalSessionTarget,
    predecessorRunId = this.latestRunIds.get(sessionId),
  ): Promise<void> {
    if (generation !== this.generation || this.stoppedSessionIds.has(sessionId) ||
      this.latestRunIds.get(sessionId) !== predecessorRunId) return;
    const sessionGeneration = this.stopGenerations.get(sessionId) ?? 0;
    if (this.dispatchLanes.has(sessionId)) {
      this.scheduleRetry(
        sessionId,
        sessionKey,
        expectedGoalId,
        'Goal continuation dispatch is still in progress',
        expectedTarget,
      );
      return;
    }
    const decision = this.beginDecision(sessionId)!;
    let retryGoalId = expectedGoalId;
    try {
      const goal = await this.readGoal(sessionKey, decision);
      if (
        !this.isCurrentDecision(sessionId, decision) ||
        generation !== this.generation ||
        (this.stopGenerations.get(sessionId) ?? 0) !== sessionGeneration ||
        this.stoppedSessionIds.has(sessionId)
      ) {
        return;
      }
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        this.cancelRetry(sessionId, true);
        this.publishGoalState(sessionId, goal, this.snapshots.get(sessionId)?.continuationCount ?? 0);
        return;
      }
      if (!this.matchesTarget(this.sessionTargets.get(sessionKey), expectedTarget)) {
        this.stop(sessionId);
        this.confirmStop(sessionId);
        return;
      }
      expectedTarget = this.sessionTargets.get(sessionKey);
      if (expectedTarget) this.retryTargets.set(sessionId, expectedTarget);
      if (expectedGoalId && goal.id !== expectedGoalId) {
        this.stopForGoalChange(sessionId, goal);
        return;
      }
      retryGoalId = goal.id;
      await this.dispatchContinuation(
        sessionId,
        sessionKey,
        goal,
        generation,
        sessionGeneration,
        true,
        expectedTarget,
        decision,
      );
    } catch (error) {
      if (
        this.isCurrentDecision(sessionId, decision) &&
        generation === this.generation &&
        (this.stopGenerations.get(sessionId) ?? 0) === sessionGeneration &&
        !this.stoppedSessionIds.has(sessionId)
      ) {
        this.scheduleRetry(sessionId, sessionKey, retryGoalId, error, expectedTarget);
      }
    } finally {
      this.finishDecision(sessionId, decision);
    }
  }

  private matchesTarget(target: GoalSessionTarget | undefined, expected: GoalSessionTarget | undefined): boolean {
    return !expected || Boolean(target && target.sessionId === expected.sessionId &&
      (expected.lifecycleRevision === undefined || target.lifecycleRevision === expected.lifecycleRevision));
  }

  private cancelRetry(sessionId: string, resetAttempt: boolean): void {
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
    if (resetAttempt) this.retryAttempts.delete(sessionId);
  }

  private rememberProcessedTerminalRun(runId: string): void {
    this.processedTerminalRuns.add(runId);
    if (this.processedTerminalRuns.size > 512) {
      const oldest = this.processedTerminalRuns.values().next().value;
      if (oldest) this.processedTerminalRuns.delete(oldest);
    }
  }

  private publishGoalState(
    sessionId: string,
    goal: SessionGoal | null,
    continuationCount: number,
  ): void {
    this.publish({
      sessionId,
      ...(goal?.id ? { goalId: goal.id } : {}),
      phase: phaseForGoal(goal),
      continuationCount: goal?.continuationTurns ?? continuationCount,
      updatedAt: this.now(),
    });
  }

  private publish(snapshot: GoalExecutionSnapshot): GoalExecutionSnapshot {
    this.snapshots.set(snapshot.sessionId, snapshot);
    this.dependencies.onSnapshot(snapshot);
    return snapshot;
  }
}

import { randomUUID } from 'crypto';

import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  normalizeSessionGoal,
  type SessionGoal,
  SessionGoalStatus,
} from '../../../shared/sessionGoal';
import { coworkLog } from '../../cowork/coworkLogger';
import type { GatewayClientLike } from '../../engine/gateway/types';

const CONTINUATION_SYSTEM_PROMPT = [
  'This is an automatic continuation of the active session goal.',
  'Call get_goal first to confirm that the same goal is still active.',
  'Review the existing conversation, artifacts, and tool results before acting.',
  'First determine whether the existing evidence already proves the objective is achieved; do not repeat completed work merely to create activity.',
  'If achieved, perform only the verification still needed, then call update_goal with complete and a non-empty concise note describing the evidence; never mark complete without that evidence note.',
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
type TerminalGoalStatus = 'complete' | 'blocked';

export interface GoalLifecycleEvent {
  runId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  phase: 'start' | 'end' | 'error';
  aborted?: boolean;
  error?: string;
}

export interface GoalToolEvent {
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
  onRunAccepted: (sessionId: string, sessionKey: string, runId: string) => void;
  onRunFailed: (sessionId: string, runId: string) => void;
  onSnapshot: (snapshot: GoalExecutionSnapshot) => void;
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

const phaseForGoal = (goal: SessionGoal | null): GoalExecutionPhase => {
  if (goal?.status === SessionGoalStatus.Complete) {
    return GoalExecutionPhase.AwaitingConfirmation;
  }
  if (goal?.status === SessionGoalStatus.Blocked) return GoalExecutionPhase.AwaitingInput;
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

export class GoalContinuationCoordinator {
  private readonly snapshots = new Map<string, GoalExecutionSnapshot>();
  private readonly processedTerminalRuns = new Set<string>();
  private readonly stoppedSessionIds = new Set<string>();
  private readonly continuationRuns = new Set<string>();
  private readonly controlRuns = new Set<string>();
  private readonly dispatchingSessionIds = new Set<string>();
  private readonly latestRunIds = new Map<string, string>();
  private readonly pendingGoalUpdates = new Map<string, TerminalGoalStatus>();
  private readonly terminalGoalRuns = new Map<string, TerminalGoalStatus>();
  private readonly snapshotsBeforeStop = new Map<string, GoalExecutionSnapshot | null>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly now: () => number;
  private generation = 0;

  constructor(private readonly dependencies: GoalContinuationCoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  getSnapshot(sessionId: string): GoalExecutionSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  isUserInputRun(runId: string): boolean {
    return !this.controlRuns.has(runId) && !this.continuationRuns.has(runId);
  }

  registerControlRun(runId: string): void {
    this.controlRuns.add(runId);
    if (this.controlRuns.size > 512) {
      const oldest = this.controlRuns.values().next().value;
      if (oldest) this.controlRuns.delete(oldest);
    }
  }

  unregisterControlRun(runId: string): void {
    this.controlRuns.delete(runId);
  }

  restoreRunning(sessionId: string, goalId: string, runId?: string): void {
    this.cancelRetry(sessionId, true);
    this.publish({
      sessionId,
      goalId,
      phase: GoalExecutionPhase.Running,
      ...(runId ? { runId } : {}),
      continuationCount: this.snapshots.get(sessionId)?.continuationCount ?? 0,
      updatedAt: this.now(),
    });
  }

  restoreSnapshot(snapshot: GoalExecutionSnapshot): void {
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
    const clearedSnapshots = [...this.snapshots.values()];
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    this.snapshots.clear();
    this.processedTerminalRuns.clear();
    this.stoppedSessionIds.clear();
    this.continuationRuns.clear();
    this.controlRuns.clear();
    this.dispatchingSessionIds.clear();
    this.latestRunIds.clear();
    this.pendingGoalUpdates.clear();
    this.terminalGoalRuns.clear();
    this.snapshotsBeforeStop.clear();
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
    const generation = this.generation;
    if (!isManagedGoalSessionKey(sessionKey)) {
      throw new Error('Goal continuation is only available for managed JustDo sessions');
    }
    const current = this.snapshots.get(sessionId);
    if (
      this.dispatchingSessionIds.has(sessionId) ||
      current?.phase === GoalExecutionPhase.Running ||
      current?.phase === GoalExecutionPhase.Continuing
    ) {
      throw new Error('The session goal is already running');
    }
    this.stoppedSessionIds.delete(sessionId);
    this.snapshotsBeforeStop.delete(sessionId);
    this.cancelRetry(sessionId, true);
    this.dispatchingSessionIds.add(sessionId);
    try {
      const goal = await this.readGoal(sessionKey);
      if (generation !== this.generation) throw new Error('OpenClaw Gateway connection changed');
      if (this.stoppedSessionIds.has(sessionId)) throw new Error('Goal execution was stopped');
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        throw new Error('The session does not have an active goal');
      }
      try {
        await this.dispatchContinuation(sessionId, sessionKey, goal, generation);
      } catch (error) {
        this.scheduleRetry(sessionId, sessionKey, goal.id, error);
      }
      return this.snapshots.get(sessionId)!;
    } finally {
      this.dispatchingSessionIds.delete(sessionId);
    }
  }

  async handleLifecycle(event: GoalLifecycleEvent): Promise<void> {
    if (!isManagedGoalSessionKey(event.sessionKey) || event.spawnedBy) return;
    const sessionId = this.dependencies.resolveSessionId(event.sessionKey);
    if (!sessionId) return;
    if (event.phase === 'start') {
      if (this.controlRuns.has(event.runId)) return;
      this.latestRunIds.set(sessionId, event.runId);
      const isContinuation = this.continuationRuns.has(event.runId);
      if (isContinuation && this.stoppedSessionIds.has(sessionId)) return;
      if (!isContinuation) {
        this.stoppedSessionIds.delete(sessionId);
        this.snapshotsBeforeStop.delete(sessionId);
        this.cancelRetry(sessionId, true);
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

    this.continuationRuns.delete(event.runId);
    const wasControlRun = this.controlRuns.delete(event.runId);
    const terminalStatus = this.terminalGoalRuns.get(event.runId) ?? null;
    this.terminalGoalRuns.delete(event.runId);
    for (const key of this.pendingGoalUpdates.keys()) {
      if (key.startsWith(`${event.runId}:`)) this.pendingGoalUpdates.delete(key);
    }
    if (wasControlRun) return;
    if (this.processedTerminalRuns.has(event.runId)) return;
    this.processedTerminalRuns.add(event.runId);
    if (this.processedTerminalRuns.size > 512) {
      const oldest = this.processedTerminalRuns.values().next().value;
      if (oldest) this.processedTerminalRuns.delete(oldest);
    }
    const latestRunId = this.latestRunIds.get(sessionId);
    if (latestRunId && latestRunId !== event.runId) return;

    const current = this.snapshots.get(sessionId);
    if (this.stoppedSessionIds.has(sessionId)) return;
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
    if (event.aborted || event.phase === 'error') {
      this.scheduleRetry(
        sessionId,
        event.sessionKey,
        current?.goalId,
        event.error || (event.aborted ? 'Goal run was interrupted' : 'Goal continuation failed'),
      );
      return;
    }
    this.retryAttempts.delete(sessionId);
    if (this.dispatchingSessionIds.has(sessionId)) return;

    const generation = this.generation;
    this.dispatchingSessionIds.add(sessionId);
    try {
      let goal = await this.readGoal(event.sessionKey);
      if (generation !== this.generation || this.stoppedSessionIds.has(sessionId)) return;
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        this.cancelRetry(sessionId, true);
        this.publishGoalState(sessionId, goal, current?.continuationCount ?? 0);
        return;
      }
      const goalId = goal.id;
      this.publish({
        sessionId,
        goalId,
        phase: GoalExecutionPhase.Continuing,
        continuationCount: current?.continuationCount ?? 0,
        updatedAt: this.now(),
      });
      await this.dependencies.waitBeforeAutomaticContinuation?.();
      if (
        generation !== this.generation ||
        this.stoppedSessionIds.has(sessionId) ||
        (this.latestRunIds.has(sessionId) && this.latestRunIds.get(sessionId) !== event.runId)
      ) {
        return;
      }
      goal = await this.readGoal(event.sessionKey);
      if (
        generation !== this.generation ||
        this.stoppedSessionIds.has(sessionId) ||
        (this.latestRunIds.has(sessionId) && this.latestRunIds.get(sessionId) !== event.runId)
      ) {
        return;
      }
      if (!goal || goal.status !== SessionGoalStatus.Active || goal.id !== goalId) {
        this.publishGoalState(sessionId, goal, 0);
        return;
      }
      try {
        await this.dispatchContinuation(sessionId, event.sessionKey, goal, generation);
      } catch (error) {
        this.scheduleRetry(sessionId, event.sessionKey, goal.id, error);
      }
    } catch (error) {
      if (generation === this.generation && !this.stoppedSessionIds.has(sessionId)) {
        this.scheduleRetry(sessionId, event.sessionKey, current?.goalId, error);
      }
    } finally {
      this.dispatchingSessionIds.delete(sessionId);
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
    this.terminalGoalRuns.set(event.runId, status);
    const current = this.snapshots.get(sessionId);
    this.cancelRetry(sessionId, true);
    this.publish({
      sessionId,
      ...(current?.goalId ? { goalId: current.goalId } : {}),
      phase: terminalPhase(status),
      continuationCount: current?.continuationCount ?? 0,
      updatedAt: this.now(),
    });
  }

  private async readGoal(sessionKey: string): Promise<SessionGoal | null> {
    const client = this.dependencies.getClient();
    if (!client) throw new Error('OpenClaw Gateway is not connected');
    const result = await client.request<{ session?: GatewaySession | null }>('sessions.describe', {
      key: sessionKey,
    });
    return asGoal(result.session?.goal);
  }

  private async dispatchContinuation(
    sessionId: string,
    sessionKey: string,
    goal: SessionGoal,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) throw new Error('OpenClaw Gateway connection changed');
    const client = this.dependencies.getClient();
    if (!client) throw new Error('OpenClaw Gateway is not connected');
    const current = this.snapshots.get(sessionId);
    const continuationCount = (current?.continuationCount ?? 0) + 1;
    this.publish({
      sessionId,
      goalId: goal.id,
      phase: GoalExecutionPhase.Continuing,
      continuationCount,
      updatedAt: this.now(),
    });

    const runId = `justdo-goal-${goal.id}-${continuationCount}-${randomUUID()}`;
    this.continuationRuns.add(runId);
    this.latestRunIds.set(sessionId, runId);
    this.dependencies.onRunAccepted(sessionId, sessionKey, runId);
    try {
      await client.request('agent', {
        message: buildContinuationPrompt(goal),
        extraSystemPrompt: CONTINUATION_SYSTEM_PROMPT,
        sessionKey,
        agentId: this.dependencies.resolveAgentId(sessionId),
        deliver: false,
        suppressPromptPersistence: true,
        idempotencyKey: runId,
      });
    } catch (error) {
      this.continuationRuns.delete(runId);
      this.dependencies.onRunFailed(sessionId, runId);
      throw error;
    }
    if (generation !== this.generation || this.stoppedSessionIds.has(sessionId)) return;
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
  ): void {
    if (this.stoppedSessionIds.has(sessionId)) return;
    this.cancelRetry(sessionId, false);
    const attempt = (this.retryAttempts.get(sessionId) ?? 0) + 1;
    this.retryAttempts.set(sessionId, attempt);
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    const nextRetryAt = this.now() + delay;
    const current = this.snapshots.get(sessionId);
    const summary = errorSummary(error);
    const resolvedGoalId = goalId || current?.goalId;
    this.publish({
      sessionId,
      ...(resolvedGoalId ? { goalId: resolvedGoalId } : {}),
      phase: GoalExecutionPhase.Retrying,
      continuationCount: current?.continuationCount ?? 0,
      updatedAt: this.now(),
      error: summary,
      retryAttempt: attempt,
      nextRetryAt,
    });
    coworkLog('WARN', 'GoalContinuation', 'Goal run failed; automatic retry scheduled', {
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
        void this.retry(sessionId, sessionKey, goalId, generation);
      }, delay),
    );
  }

  private async retry(
    sessionId: string,
    sessionKey: string,
    expectedGoalId: string | undefined,
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.generation ||
      this.stoppedSessionIds.has(sessionId) ||
      this.dispatchingSessionIds.has(sessionId)
    ) {
      return;
    }
    this.dispatchingSessionIds.add(sessionId);
    try {
      const goal = await this.readGoal(sessionKey);
      if (generation !== this.generation || this.stoppedSessionIds.has(sessionId)) return;
      if (
        !goal ||
        goal.status !== SessionGoalStatus.Active ||
        (expectedGoalId && goal.id !== expectedGoalId)
      ) {
        this.cancelRetry(sessionId, true);
        this.publishGoalState(sessionId, goal, this.snapshots.get(sessionId)?.continuationCount ?? 0);
        return;
      }
      await this.dispatchContinuation(sessionId, sessionKey, goal, generation);
    } catch (error) {
      if (generation === this.generation && !this.stoppedSessionIds.has(sessionId)) {
        this.scheduleRetry(sessionId, sessionKey, expectedGoalId, error);
      }
    } finally {
      this.dispatchingSessionIds.delete(sessionId);
    }
  }

  private cancelRetry(sessionId: string, resetAttempt: boolean): void {
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
    if (resetAttempt) this.retryAttempts.delete(sessionId);
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
      continuationCount,
      updatedAt: this.now(),
    });
  }

  private publish(snapshot: GoalExecutionSnapshot): GoalExecutionSnapshot {
    this.snapshots.set(snapshot.sessionId, snapshot);
    this.dependencies.onSnapshot(snapshot);
    return snapshot;
  }
}

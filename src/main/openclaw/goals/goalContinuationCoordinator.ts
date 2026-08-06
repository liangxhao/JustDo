import { createHash, randomUUID } from 'crypto';

import {
  GoalExecutionFailureReason,
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  type SessionGoal,
  SessionGoalStatus,
} from '../../../shared/sessionGoal';
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

const MAX_CONSECUTIVE_STALLED_CONTINUATIONS = 2;
const NON_PROGRESS_TOOL_NAMES = new Set(['create_goal', 'get_goal', 'update_goal', 'update_plan']);

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

const asGoal = (value: unknown): SessionGoal | null => {
  if (!value || typeof value !== 'object') return null;
  const goal = value as Partial<SessionGoal>;
  if (
    goal.schemaVersion !== 1 ||
    typeof goal.id !== 'string' ||
    !goal.id.trim() ||
    typeof goal.objective !== 'string' ||
    !goal.objective.trim() ||
    !Object.values(SessionGoalStatus).includes(goal.status as SessionGoalStatus)
  ) {
    return null;
  }
  return goal as SessionGoal;
};

const isManagedGoalSessionKey = (sessionKey: string): boolean =>
  /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey.trim());

const readGoalTerminalStatus = (value: unknown): 'complete' | 'blocked' | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return status === SessionGoalStatus.Complete || status === SessionGoalStatus.Blocked
    ? status
    : null;
};

const fingerprintValue = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const fingerprintToolProgress = (event: GoalToolEvent, normalizedName: string): string =>
  createHash('sha256')
    .update(normalizedName)
    .update('\0')
    .update(fingerprintValue(event.input))
    .update('\0')
    .update(fingerprintValue(event.output))
    .digest('hex');

export class GoalContinuationCoordinator {
  private readonly snapshots = new Map<string, GoalExecutionSnapshot>();
  private readonly processedTerminalRuns = new Set<string>();
  private readonly stoppedSessionIds = new Set<string>();
  private readonly continuationRuns = new Set<string>();
  private readonly dispatchingSessionIds = new Set<string>();
  private readonly latestRunIds = new Map<string, string>();
  private readonly pendingGoalUpdates = new Map<string, 'complete' | 'blocked'>();
  private readonly terminalGoalRuns = new Set<string>();
  private readonly productiveRunFingerprints = new Map<string, Set<string>>();
  private readonly lastProgressFingerprints = new Map<string, string>();
  private readonly stalledContinuationCounts = new Map<string, number>();
  private readonly snapshotsBeforeStop = new Map<string, GoalExecutionSnapshot | null>();
  private readonly now: () => number;
  private generation = 0;

  constructor(private readonly dependencies: GoalContinuationCoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  getSnapshot(sessionId: string): GoalExecutionSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  clear(): void {
    this.generation += 1;
    const clearedSnapshots = [...this.snapshots.values()];
    this.snapshots.clear();
    this.processedTerminalRuns.clear();
    this.stoppedSessionIds.clear();
    this.continuationRuns.clear();
    this.dispatchingSessionIds.clear();
    this.latestRunIds.clear();
    this.pendingGoalUpdates.clear();
    this.terminalGoalRuns.clear();
    this.productiveRunFingerprints.clear();
    this.lastProgressFingerprints.clear();
    this.stalledContinuationCounts.clear();
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
    this.stalledContinuationCounts.delete(sessionId);
    this.lastProgressFingerprints.delete(sessionId);
    this.dispatchingSessionIds.add(sessionId);
    try {
      const goal = await this.readGoal(sessionKey);
      if (generation !== this.generation) {
        throw new Error('OpenClaw Gateway connection changed');
      }
      if (this.stoppedSessionIds.has(sessionId)) {
        throw new Error('Goal execution was stopped');
      }
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        throw new Error('The session does not have an active goal');
      }
      await this.dispatchContinuation(sessionId, sessionKey, goal, generation);
      return this.snapshots.get(sessionId)!;
    } catch (error) {
      if (generation === this.generation && !this.stoppedSessionIds.has(sessionId)) {
        this.publishFailure(sessionId, error);
      }
      throw error;
    } finally {
      this.dispatchingSessionIds.delete(sessionId);
    }
  }

  async handleLifecycle(event: GoalLifecycleEvent): Promise<void> {
    if (!isManagedGoalSessionKey(event.sessionKey) || event.spawnedBy) return;
    const sessionId = this.dependencies.resolveSessionId(event.sessionKey);
    if (!sessionId) return;

    if (event.phase === 'start') {
      this.latestRunIds.set(sessionId, event.runId);
      const isContinuation = this.continuationRuns.has(event.runId);
      if (isContinuation && this.stoppedSessionIds.has(sessionId)) return;
      if (!isContinuation) {
        this.stoppedSessionIds.delete(sessionId);
        this.snapshotsBeforeStop.delete(sessionId);
        this.stalledContinuationCounts.delete(sessionId);
        this.lastProgressFingerprints.delete(sessionId);
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

    if (this.processedTerminalRuns.has(event.runId)) return;
    this.processedTerminalRuns.add(event.runId);
    if (this.processedTerminalRuns.size > 512) {
      const oldest = this.processedTerminalRuns.values().next().value;
      if (oldest) this.processedTerminalRuns.delete(oldest);
    }
    const wasContinuation = this.continuationRuns.delete(event.runId);
    const productiveFingerprints = this.productiveRunFingerprints.get(event.runId);
    this.productiveRunFingerprints.delete(event.runId);
    const progressFingerprint = productiveFingerprints?.size
      ? [...productiveFingerprints].sort().join(':')
      : null;
    const goalWasTerminated = this.terminalGoalRuns.delete(event.runId);
    for (const key of this.pendingGoalUpdates.keys()) {
      if (key.startsWith(`${event.runId}:`)) this.pendingGoalUpdates.delete(key);
    }
    const latestRunId = this.latestRunIds.get(sessionId);
    if (latestRunId && latestRunId !== event.runId) return;

    const current = this.snapshots.get(sessionId);
    if (event.aborted) {
      this.stoppedSessionIds.add(sessionId);
      this.publish({
        sessionId,
        ...(current?.goalId ? { goalId: current.goalId } : {}),
        phase: GoalExecutionPhase.Stopped,
        continuationCount: current?.continuationCount ?? 0,
        updatedAt: this.now(),
      });
      return;
    }
    if (this.stoppedSessionIds.has(sessionId)) return;
    if (goalWasTerminated) {
      this.stalledContinuationCounts.delete(sessionId);
      this.lastProgressFingerprints.delete(sessionId);
      this.publish({
        sessionId,
        ...(current?.goalId ? { goalId: current.goalId } : {}),
        phase: GoalExecutionPhase.Waiting,
        continuationCount: 0,
        updatedAt: this.now(),
      });
      return;
    }
    if (event.phase === 'error') {
      this.publishFailure(sessionId, event.error || 'Goal continuation failed');
      return;
    }
    if (this.dispatchingSessionIds.has(sessionId)) return;

    const generation = this.generation;
    this.dispatchingSessionIds.add(sessionId);
    try {
      let goal = await this.readGoal(event.sessionKey);
      if (generation !== this.generation || this.stoppedSessionIds.has(sessionId)) return;
      if (!goal || goal.status !== SessionGoalStatus.Active) {
        this.stalledContinuationCounts.delete(sessionId);
        this.lastProgressFingerprints.delete(sessionId);
        this.publish({
          sessionId,
          ...(goal?.id ? { goalId: goal.id } : {}),
          phase: GoalExecutionPhase.Waiting,
          continuationCount: 0,
          updatedAt: this.now(),
        });
        return;
      }
      const goalId = goal.id;
      if (current?.goalId && current.goalId !== goalId) {
        this.stalledContinuationCounts.delete(sessionId);
        this.lastProgressFingerprints.delete(sessionId);
      }
      if (wasContinuation) {
        const lastProgressFingerprint = this.lastProgressFingerprints.get(sessionId);
        const hasNewProgress = Boolean(
          progressFingerprint && progressFingerprint !== lastProgressFingerprint,
        );
        const stalledCount = hasNewProgress
          ? 0
          : (this.stalledContinuationCounts.get(sessionId) ?? 0) + 1;
        if (progressFingerprint) {
          this.lastProgressFingerprints.set(sessionId, progressFingerprint);
        }
        if (stalledCount >= MAX_CONSECUTIVE_STALLED_CONTINUATIONS) {
          this.stalledContinuationCounts.delete(sessionId);
          this.stoppedSessionIds.add(sessionId);
          this.publishFailure(sessionId, undefined, GoalExecutionFailureReason.StalledNoProgress);
          return;
        }
        this.stalledContinuationCounts.set(sessionId, stalledCount);
      }
      this.publish({
        sessionId,
        goalId: goal.id,
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
        this.publish({
          sessionId,
          ...(goal?.id ? { goalId: goal.id } : {}),
          phase: GoalExecutionPhase.Waiting,
          continuationCount: 0,
          updatedAt: this.now(),
        });
        return;
      }
      await this.dispatchContinuation(sessionId, event.sessionKey, goal, generation);
    } catch (error) {
      if (generation === this.generation && !this.stoppedSessionIds.has(sessionId)) {
        this.publishFailure(sessionId, error);
      }
    } finally {
      this.dispatchingSessionIds.delete(sessionId);
    }
  }

  handleToolEvent(event: GoalToolEvent): void {
    if (
      !isManagedGoalSessionKey(event.sessionKey) ||
      event.spawnedBy ||
      !event.toolCallId
    ) {
      return;
    }
    const normalizedName = event.name.trim().toLowerCase();
    if (
      event.status === 'completed' &&
      !event.failed &&
      !NON_PROGRESS_TOOL_NAMES.has(normalizedName)
    ) {
      const fingerprints = this.productiveRunFingerprints.get(event.runId) ?? new Set<string>();
      fingerprints.add(fingerprintToolProgress(event, normalizedName));
      this.productiveRunFingerprints.set(event.runId, fingerprints);
    }
    if (normalizedName !== 'update_goal') return;
    const key = `${event.runId}:${event.toolCallId}`;
    const requestedStatus = readGoalTerminalStatus(event.input);
    if (event.status === 'running') {
      if (requestedStatus) this.pendingGoalUpdates.set(key, requestedStatus);
      return;
    }
    const pendingStatus = this.pendingGoalUpdates.get(key);
    this.pendingGoalUpdates.delete(key);
    if (event.status === 'completed' && !event.failed && (requestedStatus || pendingStatus)) {
      this.terminalGoalRuns.add(event.runId);
    }
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
    if (generation !== this.generation) {
      throw new Error('OpenClaw Gateway connection changed');
    }
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
    this.publish({
      sessionId,
      goalId: goal.id,
      phase: GoalExecutionPhase.Running,
      runId,
      continuationCount,
      updatedAt: this.now(),
    });
  }

  private publish(snapshot: GoalExecutionSnapshot): void {
    this.snapshots.set(snapshot.sessionId, snapshot);
    this.dependencies.onSnapshot(snapshot);
  }

  private publishFailure(
    sessionId: string,
    error: unknown,
    failureReason?: GoalExecutionSnapshot['failureReason'],
  ): void {
    const current = this.snapshots.get(sessionId);
    this.publish({
      sessionId,
      ...(current?.goalId ? { goalId: current.goalId } : {}),
      phase: GoalExecutionPhase.Failed,
      continuationCount: current?.continuationCount ?? 0,
      updatedAt: this.now(),
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
      ...(failureReason ? { failureReason } : {}),
    });
  }
}

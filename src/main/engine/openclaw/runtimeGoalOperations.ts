import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';

import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  type GoalFeedbackPreparationResult,
  isDefinitiveSessionGoalGatewayError,
  normalizeSessionGoal,
  type SessionGoal,
  SessionGoalIpc,
  type SessionGoalMutationOutcome,
  type SessionGoalMutationRequest,
  type SessionGoalMutationResult,
  SessionGoalStatus,
} from '../../../shared/cowork/sessionGoal';
import { coworkLog } from '../../cowork/coworkLogger';
import type { CoworkStore } from '../../data/coworkStore';
import { GoalContinuationCoordinator } from '../../openclaw/goals/goalContinuationCoordinator';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from '../../openclaw/sessions/openclawSessionKeys';
import { isRecord } from '../gateway/helpers';
import type { GatewayClientLike, SessionTurn } from '../gateway/types';
import type { CoworkPreparedSession, CoworkPrepareSessionOptions } from '../types';
import {
  readActiveRunIds,
  RetainedSessionGoalMutation,
  RuntimeSessionSnapshot,
} from './runtimeAdapterSupport';
export interface RuntimeGoalOperationsContext {
  readonly gatewayClientGeneration: number;
  readonly store: CoworkStore;
  readonly gatewayClient: GatewayClientLike | null;
  readonly getSessionKeysForSession: (sessionId: string) => string[];
  readonly goalContinuationCoordinator: GoalContinuationCoordinator;
  readonly goalMutationOperations: Map<string, RetainedSessionGoalMutation>;
  readonly mutateSessionGoal: (
    sessionId: string,
    request: SessionGoalMutationRequest,
  ) => Promise<SessionGoalMutationOutcome>;
  readonly executeSessionGoalMutation: (
    sessionId: string,
    operation: RetainedSessionGoalMutation,
  ) => Promise<SessionGoalMutationOutcome>;
  readonly requireGatewayClient: () => GatewayClientLike;
  readonly prepareSessionKey: (
    sessionId: string,
    sessionKey: string,
    options?: CoworkPrepareSessionOptions,
  ) => Promise<CoworkPreparedSession>;
  readonly rememberSessionKey: (sessionId: string, sessionKey: string) => void;
  readonly performSessionGoalMutation: (
    sessionId: string,
    request: SessionGoalMutationRequest,
    params: Record<string, unknown>,
  ) => Promise<SessionGoalMutationOutcome>;
  readonly stoppedSessions: Map<string, number>;
  readonly goalIdsActivatedThisApp: Set<string>;
  readonly ensureActiveTurn: (sessionId: string, sessionKey: string, runId: string) => void;
  readonly manuallyStoppedSessions: Set<string>;
  readonly goalReplacementPromises: Map<string, Promise<GoalFeedbackPreparationResult>>;
  readonly performCompletedGoalReplacement: (
    sessionId: string,
    expectedGoalId: string,
    preparedObjective?: string,
  ) => Promise<GoalFeedbackPreparationResult>;
  goalRecoveryGeneration: number | null;
  goalRecoveryTimer: NodeJS.Timeout | null;
  readonly getRuntimeSessionSnapshot: (
    forceRefresh?: boolean,
    fullScan?: boolean,
  ) => Promise<RuntimeSessionSnapshot>;
  readonly scheduleGoalRecovery: (
    generation: number,
    options?: { stopGoalsCreatedBeforeMs?: number },
  ) => void;
  readonly runtimeRowString: (value: unknown) => string;
  readonly activeTurns: Map<string, SessionTurn>;
  readonly goalSessionsActivatingThisApp: Set<string>;
  readonly isRuntimeSessionRowActive: (row: Record<string, unknown>) => boolean;
  initialGatewayGoalRecoveryPending: boolean;
  readonly recoverActiveGoals: (
    generation: number,
    options?: { stopGoalsCreatedBeforeMs?: number },
  ) => Promise<void>;
}

export async function persistTerminalGoalSnapshot(
  this: RuntimeGoalOperationsContext,
  snapshot: GoalExecutionSnapshot,
): Promise<void> {
  const generation = this.gatewayClientGeneration;
  const session = this.store.getSession(snapshot.sessionId);
  const client = this.gatewayClient;
  let canonicalGoal: SessionGoal | null = null;
  if (session && client) {
    const candidateKeys = [
      ...this.getSessionKeysForSession(snapshot.sessionId),
      buildManagedSessionKey(snapshot.sessionId, session.agentId || DEFAULT_MANAGED_AGENT_ID),
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

export async function mutateSessionGoal(
  this: RuntimeGoalOperationsContext,
  sessionId: string,
  request: SessionGoalMutationRequest,
): Promise<SessionGoalMutationOutcome> {
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const signature = JSON.stringify([
    request.action,
    request.goalId,
    request.action === 'edit'
      ? request.objective
      : request.action === 'clear'
        ? null
        : (request.note ?? null),
  ]);
  const retained = this.goalMutationOperations.get(sessionId);
  if (retained?.promise) {
    if (retained.signature === signature) return retained.promise;
    await retained.promise;
    return this.mutateSessionGoal(sessionId, request);
  }
  if (retained && retained.signature === signature) {
    return this.executeSessionGoalMutation(sessionId, retained);
  }
  if (retained) {
    // A prior transport failure may have happened after commit. Settle that exact
    // operation first, then resolve the new action against fresh canonical state.
    await this.executeSessionGoalMutation(sessionId, retained);
  }

  const client = this.requireGatewayClient();
  const candidateKeys = [
    ...this.getSessionKeysForSession(sessionId),
    buildManagedSessionKey(sessionId, session.agentId || DEFAULT_MANAGED_AGENT_ID),
    buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
  ];
  let target:
    | {
        sessionKey: string;
        gatewaySessionId: string;
        agentId: string;
      }
    | undefined;
  for (const candidateKey of new Set(candidateKeys)) {
    const result = await client.request<{
      session?: { key?: string; sessionId?: string; goal?: unknown } | null;
    }>('sessions.describe', { key: candidateKey });
    const goal = normalizeSessionGoal(result.session?.goal);
    if (!result.session || goal?.id !== request.goalId) continue;
    const gatewaySessionId = result.session.sessionId?.trim();
    if (!gatewaySessionId) throw new Error('Gateway session has no sessionId');
    const sessionKey = result.session.key?.trim() || candidateKey;
    target = {
      sessionKey,
      gatewaySessionId,
      agentId: session.agentId || DEFAULT_MANAGED_AGENT_ID,
    };
    break;
  }
  if (!target) throw new Error('The displayed goal is no longer current');
  await this.prepareSessionKey(sessionId, target.sessionKey);
  this.rememberSessionKey(sessionId, target.sessionKey);

  const identity = {
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    sessionId: target.gatewaySessionId,
    goalId: request.goalId,
    operationId: randomUUID(),
    issuedAtMs: Date.now(),
  };
  const params =
    request.action === 'clear'
      ? identity
      : request.action === 'edit'
        ? { ...identity, action: request.action, objective: request.objective }
        : {
            ...identity,
            action: request.action,
            ...(request.note ? { note: request.note } : {}),
          };
  const operation = { request, signature, params };
  this.goalMutationOperations.set(sessionId, operation);
  return this.executeSessionGoalMutation(sessionId, operation);
}

export function executeSessionGoalMutation(
  this: RuntimeGoalOperationsContext,
  sessionId: string,
  operation: RetainedSessionGoalMutation,
): Promise<SessionGoalMutationOutcome> {
  if (operation.promise) return operation.promise;
  const promise = this.performSessionGoalMutation(
    sessionId,
    operation.request,
    operation.params,
  ).finally(() => {
    if (this.goalMutationOperations.get(sessionId) === operation) {
      operation.promise = undefined;
    }
  });
  operation.promise = promise;
  return promise;
}

export async function performSessionGoalMutation(
  this: RuntimeGoalOperationsContext,
  sessionId: string,
  request: SessionGoalMutationRequest,
  params: Record<string, unknown>,
): Promise<SessionGoalMutationOutcome> {
  const client = this.requireGatewayClient();
  const method = request.action === 'clear' ? 'sessions.goal.clear' : 'sessions.goal.update';
  let rawMutation: SessionGoalMutationResult;
  try {
    rawMutation = await client.request<SessionGoalMutationResult>(method, params);
  } catch (error) {
    if (
      isDefinitiveSessionGoalGatewayError(error) &&
      this.goalMutationOperations.get(sessionId)?.params === params
    ) {
      this.goalMutationOperations.delete(sessionId);
    }
    throw error;
  }
  const rejectMismatchedReceipt = (): never => {
    if (this.goalMutationOperations.get(sessionId)?.params === params) {
      this.goalMutationOperations.delete(sessionId);
    }
    throw new Error('Gateway returned a mismatched goal mutation receipt');
  };
  if (
    rawMutation.operationId !== params.operationId ||
    rawMutation.action !== request.action ||
    rawMutation.goalId !== request.goalId ||
    rawMutation.sessionId !== params.sessionId ||
    (request.action === 'clear'
      ? rawMutation.status !== 'cleared'
      : request.action === 'resume'
        ? rawMutation.status !== 'started' ||
          rawMutation.runId?.trim() !== String(params.operationId)
        : rawMutation.status !== 'updated')
  ) {
    rejectMismatchedReceipt();
  }

  const mutationGoal = normalizeSessionGoal(rawMutation.goal);
  if (mutationGoal && mutationGoal.id !== request.goalId) {
    rejectMismatchedReceipt();
  }
  const mutationRunId = rawMutation.runId?.trim() || undefined;
  let goal = request.action === 'clear' ? null : (mutationGoal ?? null);
  let activeRunIds: string[] = [];
  if (rawMutation.replayed || (request.action !== 'clear' && !goal)) {
    const described = await client.request<{
      session?: { goal?: unknown } | null;
    }>('sessions.describe', { key: params.sessionKey });
    goal = normalizeSessionGoal(described.session?.goal) ?? null;
  }
  if (rawMutation.replayed && request.action === 'resume') {
    const listed = await client.request<{
      sessions?: Array<{ key?: unknown; activeRunIds?: unknown }>;
    }>('sessions.list', {
      search: String(params.sessionKey),
      limit: 20,
      ...(typeof params.agentId === 'string' && params.agentId ? { agentId: params.agentId } : {}),
    });
    const runtimeRow = listed.sessions?.find(row => row.key === params.sessionKey);
    activeRunIds = readActiveRunIds(runtimeRow?.activeRunIds);
  }
  const mutation: SessionGoalMutationResult = {
    operationId: rawMutation.operationId,
    action: rawMutation.action,
    sessionId: rawMutation.sessionId,
    goalId: rawMutation.goalId,
    status: rawMutation.status,
    ...(mutationGoal ? { goal: mutationGoal } : {}),
    ...(mutationRunId ? { runId: mutationRunId } : {}),
    ...(rawMutation.replayed ? { replayed: true } : {}),
  };

  let execution: GoalExecutionSnapshot | undefined;
  const resumeRunIsCurrent =
    !mutation.replayed || (!!mutation.runId && activeRunIds.includes(mutation.runId));
  if (
    request.action === 'resume' &&
    mutation.runId &&
    goal?.id === request.goalId &&
    goal?.status === SessionGoalStatus.Active &&
    resumeRunIsCurrent
  ) {
    this.stoppedSessions.delete(sessionId);
    this.goalIdsActivatedThisApp.add(`${sessionId}:${goal.id}`);
    this.ensureActiveTurn(sessionId, String(params.sessionKey), mutation.runId);
    this.goalContinuationCoordinator.restoreRunning(sessionId, goal.id, mutation.runId);
    execution = this.goalContinuationCoordinator.getSnapshot(sessionId) ?? undefined;
  } else if (!goal) {
    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.goalContinuationCoordinator.clearSession(sessionId);
    this.store.clearGoalExecutionSnapshot?.(sessionId);
  } else {
    this.goalContinuationCoordinator.synchronizeGoal(sessionId, goal, {
      preserveStopped: request.action === 'edit',
    });
    execution = this.goalContinuationCoordinator.getSnapshot(sessionId) ?? undefined;
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(SessionGoalIpc.Changed, { sessionId });
  }
  const operation = this.goalMutationOperations.get(sessionId);
  if (operation?.params === params) this.goalMutationOperations.delete(sessionId);
  return { mutation, goal, ...(execution ? { execution } : {}) };
}

export async function restartCompletedGoalForFeedback(
  this: RuntimeGoalOperationsContext,
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

export async function performCompletedGoalReplacement(
  this: RuntimeGoalOperationsContext,
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
      if (goal.status !== SessionGoalStatus.Complete) continue;
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
      const retained = this.goalMutationOperations.get(sessionId);
      if (
        retained?.request.action === 'clear' &&
        retained.request.goalId === expectedGoalId &&
        !retained.promise
      ) {
        this.goalMutationOperations.delete(sessionId);
      }
      return { objective: fallbackObjective };
    }
    throw new Error('The completed goal changed before feedback could be submitted');
  }
  this.rememberSessionKey(sessionId, sessionKey);
  const objective = completedGoal.objective.trim() ? completedGoal.objective : preparedObjective;
  if (!objective?.trim()) throw new Error('The completed goal does not have an objective');

  const cleared = await this.mutateSessionGoal(sessionId, {
    action: 'clear',
    goalId: expectedGoalId,
  });
  if (cleared.goal) {
    throw new Error('The completed goal changed while it was being cleared');
  }
  return { objective };
}

export async function recoverActiveGoals(
  this: RuntimeGoalOperationsContext,
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
          (persistedExecution.identityPending === true || persistedExecution.goalId === goalId) &&
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
        const activeTurn = this.activeTurns.get(session.id);
        if (activeTurn) {
          this.goalIdsActivatedThisApp.add(`${session.id}:${goalId}`);
          this.goalContinuationCoordinator.restoreRunning(session.id, goalId, activeTurn.runId);
          break;
        }
        const runtimeRow = runtimeRowsByKey.get(sessionKey);
        if (runtimeRow?.hasActiveRun === true) {
          const runId = this.runtimeRowString(runtimeRow.runId);
          this.goalIdsActivatedThisApp.add(`${session.id}:${goalId}`);
          this.goalContinuationCoordinator.restoreRunning(session.id, goalId, runId || undefined);
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
          this.goalContinuationCoordinator.restoreRunning(session.id, goalId, runId || undefined);
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

export function scheduleGoalRecovery(
  this: RuntimeGoalOperationsContext,
  generation: number,
  options: { stopGoalsCreatedBeforeMs?: number } = {},
): void {
  if (this.goalRecoveryTimer || generation !== this.gatewayClientGeneration) return;
  this.goalRecoveryTimer = setTimeout(() => {
    this.goalRecoveryTimer = null;
    void this.recoverActiveGoals(generation, options);
  }, 2_000);
}

export function cancelGoalRecovery(this: RuntimeGoalOperationsContext): void {
  if (this.goalRecoveryTimer) clearTimeout(this.goalRecoveryTimer);
  this.goalRecoveryTimer = null;
  this.goalRecoveryGeneration = null;
}

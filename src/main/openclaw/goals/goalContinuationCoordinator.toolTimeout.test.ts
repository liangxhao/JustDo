import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GoalExecutionPhase,
  type SessionGoal,
  SessionGoalStatus,
} from '../../../shared/cowork/sessionGoal';
import type { GatewayClientLike, SessionTurn } from '../../engine/gateway/types';
import { GoalContinuationCoordinator, type GoalLifecycleEvent } from './goalContinuationCoordinator';
import { GoalEventAdmission } from './goalEventAdmission';

vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));

const sessionId = 'session-1';
const sessionKey = 'agent:main:justdo:session-1';
const predecessorRunId = 'tool-timeout-run';
const nativeIdentity = { sessionId: 'native-session-1', lifecycleRevision: 'revision-1' };
const initialGoal: SessionGoal = {
  schemaVersion: 1, id: 'goal-1', objective: 'Verify the deployment and finish the release',
  status: SessionGoalStatus.Active, createdAt: 1, updatedAt: 1,
  tokenStart: 0, tokensUsed: 0, continuationTurns: 0,
};

const toolTimeout = (overrides: Partial<GoalLifecycleEvent> = {}): GoalLifecycleEvent => ({
  runId: predecessorRunId, sessionKey, sessionId: nativeIdentity.sessionId, agentSeq: 2,
  phase: 'error', executionSettled: true, aborted: true, status: 'timed_out',
  timeoutPhase: 'tool_execution', error: 'Tool execution timed out', ...overrides,
});

const coordinators: GoalContinuationCoordinator[] = [];

function createHarness(loseSuccessorAck = false) {
  let currentGoal = { ...initialGoal };
  let activeTurn: SessionTurn | undefined = {
    sessionId, sessionKey, runId: predecessorRunId,
    gatewaySessionId: nativeIdentity.sessionId, lifecycleGeneration: null,
    lastAgentSeq: 0, status: 'running', turnToken: 1, stopRequested: false,
    knownRunIds: new Set([predecessorRunId]),
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.describe') {
      return {
        session: { key: sessionKey, ...nativeIdentity, goal: currentGoal, status: 'interrupted' },
      };
    }
    if (method !== 'agent') throw new Error(`Unexpected method ${method}`);
    if (loseSuccessorAck) throw new Error('The sent successor lost its ACK');
    const admission = params?.goalContinuation as { goalId: string; predecessorRunId: string };
    currentGoal = { ...currentGoal, continuationTurns: currentGoal.continuationTurns + 1 };
    return {
      runId: params?.idempotencyKey, status: 'accepted',
      goalContinuation: {
        goalId: admission.goalId, predecessorRunId: admission.predecessorRunId,
        continuationTurns: currentGoal.continuationTurns, acceptedAt: 100,
      },
    };
  });
  const onRunUnknown = vi.fn();
  const prepareSessionForContinuation = vi.fn().mockResolvedValue(undefined);
  const coordinator = new GoalContinuationCoordinator({
    getClient: () => ({ request } as unknown as GatewayClientLike),
    resolveSessionId: key => key === sessionKey ? sessionId : null,
    resolveAgentId: () => 'main', getMaxContinuationTurns: () => 20,
    onRunAccepted: (_sessionId, _sessionKey, runId, gatewaySessionId) => {
      activeTurn = {
        sessionId, sessionKey, runId, gatewaySessionId, lifecycleGeneration: null,
        lastAgentSeq: 0, status: 'running', turnToken: 2, stopRequested: false,
        knownRunIds: new Set([runId]),
      };
    },
    onRunFailed: vi.fn(), onRunConfirmed: vi.fn(), onRunUnknown,
    eventAdmission: new GoalEventAdmission(() => activeTurn), onSnapshot: vi.fn(),
    prepareSessionForContinuation,
  });
  coordinators.push(coordinator);
  return {
    coordinator, request, onRunUnknown, prepareSessionForContinuation,
    agentCalls: () => request.mock.calls.filter(([method]) => method === 'agent'),
    start: async () => {
      await coordinator.handleLifecycle({
        runId: predecessorRunId, sessionKey, sessionId: nativeIdentity.sessionId,
        phase: 'start', agentSeq: 1,
      });
      // Chat final may retire Main's turn before the whole-run terminal arrives.
      activeTurn = undefined;
    },
  };
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.clear();
  vi.useRealTimers();
});

describe('OpenClaw tool_execution Goal successors', () => {
  it('automatically admits a fresh conditional successor after the exact settled timeout', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await h.start();
    await h.coordinator.handleLifecycle(toolTimeout());

    expect(h.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying, retryAttempt: 1,
    });
    expect(h.agentCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.agentCalls()).toHaveLength(1);
    const params = h.agentCalls()[0][1]!;
    expect(params).toMatchObject({
      sessionKey, expectedExistingSessionId: nativeIdentity.sessionId,
      expectedExistingSessionLifecycleRevision: nativeIdentity.lifecycleRevision,
      suppressPromptPersistence: true, deliver: false,
      goalContinuation: {
        goalId: initialGoal.id, predecessorRunId, automatic: true, maxAutomaticContinuations: 20,
      },
    });
    expect(params.idempotencyKey).toEqual(expect.any(String));
    expect(params.idempotencyKey).not.toBe(predecessorRunId);
    expect(params.message).toContain(initialGoal.objective);
    expect(params.extraSystemPrompt).toContain('Review the existing conversation, artifacts, and tool results before acting.');
    expect(params.extraSystemPrompt).toContain('first verify authoritative state and existing results; do not blindly repeat calls that may have side effects.');
    expect(h.prepareSessionForContinuation).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(h.request.mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(3);
    expect(h.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running, runId: params.idempotencyKey, continuationCount: 1,
    });
  });

  it.each([undefined, false])('does not create a successor without whole-run settlement (%s)', async executionSettled => {
    vi.useFakeTimers();
    const h = createHarness();
    await h.start();
    await h.coordinator.handleLifecycle(toolTimeout({ executionSettled }));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.request).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running, runId: predecessorRunId,
    });
  });

  it.each([
    { sessionId: 'retired-native-session' }, { runId: 'retired-run' }, { agentSeq: 1 },
    { agentSeq: undefined },
  ])('rejects stale or incomplete admitted timeout identity %j', async overrides => {
    vi.useFakeTimers();
    const h = createHarness();
    await h.start();
    await h.coordinator.handleLifecycle(toolTimeout(overrides));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.request).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Running);
  });

  it('does not replace the retry or submit another successor for duplicate settled terminals', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await h.start();
    await h.coordinator.handleLifecycle(toolTimeout());
    const scheduled = h.coordinator.getSnapshot(sessionId);
    await h.coordinator.handleLifecycle(toolTimeout());
    await h.coordinator.handleLifecycle(toolTimeout({ agentSeq: 3 }));
    expect(h.coordinator.getSnapshot(sessionId)).toBe(scheduled);

    await vi.advanceTimersByTimeAsync(2_000);
    await h.coordinator.handleLifecycle(toolTimeout({ agentSeq: 4 }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.agentCalls()).toHaveLength(1);
  });

  it('retains a sent successor with a lost ACK instead of replaying either run', async () => {
    vi.useFakeTimers();
    const h = createHarness(true);
    await h.start();
    await h.coordinator.handleLifecycle(toolTimeout());
    await vi.advanceTimersByTimeAsync(2_000);
    const unknown = h.coordinator.getSnapshot(sessionId);
    expect(unknown).toMatchObject({ phase: GoalExecutionPhase.Running, identityPending: true });
    expect(unknown?.runId).not.toBe(predecessorRunId);
    expect(h.onRunUnknown).toHaveBeenCalledExactlyOnceWith(sessionId, unknown?.runId);

    await h.coordinator.recheck(sessionId);
    await h.coordinator.handleLifecycle(toolTimeout({ agentSeq: 3 }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.coordinator.getSnapshot(sessionId)).toBe(unknown);
    expect(h.agentCalls()).toHaveLength(1);
  });

  it.each([true, false])('restores only exact settled predecessors from interrupted native observation (%s)', async executionSettled => {
    const h = createHarness();
    await h.coordinator.reconcileNativeObservation(sessionId, sessionKey, initialGoal, {
      key: sessionKey, ...nativeIdentity, goal: initialGoal, status: 'interrupted',
      goalContinuation: {
        predecessor: {
          runId: predecessorRunId, ...nativeIdentity, executionSettled,
          goalId: initialGoal.id, yielded: false, phase: 'error',
        },
        continuationTurns: 0,
      },
    });

    expect(h.agentCalls()).toHaveLength(executionSettled ? 1 : 0);
    expect(h.coordinator.getSnapshot(sessionId)?.phase).toBe(
      executionSettled ? GoalExecutionPhase.Running : GoalExecutionPhase.Waiting,
    );
  });
});

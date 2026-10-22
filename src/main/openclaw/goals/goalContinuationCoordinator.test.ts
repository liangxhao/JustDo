import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GoalExecutionPhase,
  type SessionGoal,
  SessionGoalStatus,
} from '../../../shared/cowork/sessionGoal';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { GoalContinuationCoordinator } from './goalContinuationCoordinator';

vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));

const sessionId = 'session-1';
const nativeIdentity = { sessionId: 'native-session-1', lifecycleRevision: 'revision-1' };
const sessionKey = 'agent:main:justdo:session-1';

const goal = (status: SessionGoal['status'] = SessionGoalStatus.Active): SessionGoal => ({
  schemaVersion: 1,
  id: 'goal-1',
  objective: 'Ship the release',
  status,
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 0,
  continuationTurns: 0,
});

const acceptedReceipt = (params?: Record<string, unknown>, continuationTurns = 1) => {
  const admission = params?.goalContinuation as {
    goalId: string; predecessorRunId: string;
  } | undefined;
  return {
    runId: params?.idempotencyKey,
    status: 'accepted',
    ...(admission ? {
      goalContinuation: {
        goalId: admission.goalId, predecessorRunId: admission.predecessorRunId,
        continuationTurns, acceptedAt: 100,
      },
    } : {}),
  };
};

const nativeDeferred = (reason: string) => Object.assign(new Error('native continuation deferred'), {
  gatewayCode: 'INVALID_REQUEST',
  details: { code: 'GOAL_CONTINUATION_DEFERRED', reason },
});

const nativeObservation = (
  predecessorOverrides: Record<string, unknown> = {},
  observationOverrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  key: sessionKey,
  ...nativeIdentity,
  goal: goal(),
  goalContinuation: {
    predecessor: {
      runId: 'parent-run', ...nativeIdentity, executionSettled: true,
      goalId: 'goal-1', yielded: false, phase: 'end', ...predecessorOverrides,
    },
    continuationTurns: 0,
    ...observationOverrides,
  },
});

const createHarness = (
  goalStatus: SessionGoal['status'] = SessionGoalStatus.Active,
  waitBeforeAutomaticContinuation?: () => Promise<void>,
  maxContinuationTurns = 20,
  prepareSessionForContinuation = vi.fn().mockResolvedValue(undefined),
) => {
  let currentGoal: unknown = goal(goalStatus);
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.describe') return { session: { key: sessionKey, ...nativeIdentity, goal: currentGoal } };
    if (method === 'agent') {
      const current = currentGoal as SessionGoal;
      const admission = params?.goalContinuation as { maxAutomaticContinuations: number } | undefined;
      if (admission && current.continuationTurns >= admission.maxAutomaticContinuations) {
        throw Object.assign(new Error('automatic continuation limit'), {
          gatewayCode: 'INVALID_REQUEST',
          details: { code: 'GOAL_CONTINUATION_DEFERRED', reason: 'limit-reached' },
        });
      }
      if (admission) currentGoal = { ...current, continuationTurns: current.continuationTurns + 1 };
      return acceptedReceipt(params, (currentGoal as SessionGoal).continuationTurns);
    }
    throw new Error(`unexpected method ${method}`);
  });
  const onSnapshot = vi.fn();
  const onRunAccepted = vi.fn();
  const onRunFailed = vi.fn();
  const onRunUnknown = vi.fn();
  let now = 100;
  const coordinator = new GoalContinuationCoordinator({
    getClient: () => ({ request } as unknown as GatewayClientLike),
    resolveSessionId: key => (key === sessionKey ? sessionId : null),
    resolveAgentId: () => 'main',
    getMaxContinuationTurns: () => maxContinuationTurns,
    onRunAccepted,
    onRunFailed,
    onRunConfirmed: vi.fn(),
    onRunUnknown,
    eventAdmission: { admit: () => true, clearSession: () => {}, clear: () => {} },
    onSnapshot,
    prepareSessionForContinuation,
    waitBeforeAutomaticContinuation,
    now: () => ++now,
  });
  return {
    coordinator,
    request,
    onSnapshot,
    onRunAccepted,
    onRunFailed,
    onRunUnknown,
    prepareSessionForContinuation,
    setGoal: (value: unknown) => {
      currentGoal = value;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Goal continuation ownership and native waiting', () => {
  it('waits after the exact native yielded handoff instead of starting a goal successor', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId, phase: 'start',
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true, yielded: true, livenessState: 'paused',
      stopReason: 'end_turn', aborted: false,
    });

    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Waiting, runId: 'parent-run',
    });
    harness.coordinator.clear();
  });

  it.each([
    { phase: 'error' as const },
    { aborted: true },
    { yielded: false },
    { livenessState: 'working' },
    { stopReason: 'completed' },
    { status: 'cancelled' },
    { status: 'timed_out' },
    { timeoutPhase: 'provider' },
    { error: 'handoff failed' },
  ])('does not treat an incomplete or failed handoff as native waiting: %j', async overrides => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId, phase: 'start',
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true, yielded: true, livenessState: 'paused',
      stopReason: 'end_turn', aborted: false, ...overrides,
    });

    expect(harness.coordinator.getSnapshot(sessionId)?.phase).not.toBe(GoalExecutionPhase.Waiting);
    harness.coordinator.clear();
  });

  it.each(['resolve', 'reject'] as const)(
    'retires a retry already reading the Goal when a new user turn begins (%s)', async outcome => {
      vi.useFakeTimers();
      const harness = createHarness();
      const normalRequest = harness.request.getMockImplementation()!;
      let resolveRead!: () => void;
      let rejectRead!: (error: Error) => void;
      let inspections = 0;
      harness.request.mockImplementation(async (method, params) => {
        if (method === 'sessions.describe' && ++inspections === 2) {
          await new Promise<void>((resolve, reject) => {
            resolveRead = resolve;
            rejectRead = reject;
          });
        }
        return normalRequest(method, params);
      });
      await harness.coordinator.handleLifecycle({
        runId: 'failed-run', sessionKey, sessionId: nativeIdentity.sessionId,
        phase: 'error', executionSettled: true,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolveRead).toBeTypeOf('function');

      harness.coordinator.invalidateForUserTurn(sessionId);
      await harness.coordinator.handleLifecycle({ runId: 'manual-run', sessionKey, phase: 'start' });
      const newOwnerSnapshot = harness.coordinator.getSnapshot(sessionId);
      if (outcome === 'resolve') resolveRead();
      else rejectRead(new Error('old lookup failed'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
      expect(harness.coordinator.getSnapshot(sessionId)).toBe(newOwnerSnapshot);
      expect(harness.prepareSessionForContinuation).not.toHaveBeenCalled();
      harness.coordinator.clear();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'retires an in-flight continuation preparation when a user turn takes ownership (%s)', async outcome => {
      const harness = createHarness();
      let resolvePreparation!: () => void;
      let rejectPreparation!: (error: Error) => void;
      harness.prepareSessionForContinuation.mockImplementation(async () => {
        await new Promise<void>((resolve, reject) => {
          resolvePreparation = resolve;
          rejectPreparation = reject;
        });
      });
      const oldDecision = harness.coordinator.handleLifecycle({
        runId: 'old-run', sessionKey, sessionId: nativeIdentity.sessionId,
        phase: 'end', executionSettled: true,
      });
      await vi.waitFor(() => expect(resolvePreparation).toBeTypeOf('function'));
      harness.coordinator.invalidateForUserTurn(sessionId);
      await harness.coordinator.handleLifecycle({ runId: 'manual-run', sessionKey, phase: 'start' });
      const newOwnerSnapshot = harness.coordinator.getSnapshot(sessionId);
      if (outcome === 'resolve') resolvePreparation();
      else rejectPreparation(new Error('old preparation failed'));
      await oldDecision;

      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
      expect(harness.coordinator.getSnapshot(sessionId)).toBe(newOwnerSnapshot);
      harness.coordinator.clear();
    },
  );

  it('does not infer continuation authority from a session change without a settled predecessor', async () => {
    const harness = createHarness();
    await harness.coordinator.recheck(sessionId);
    expect(harness.request).not.toHaveBeenCalled();
    harness.coordinator.clear();
  });

  it.each(['main-running', 'queued-input', 'native-handoff', 'predecessor-unconfirmed'])(
    'rechecks %s without requiring a later native notification', async reason => {
      vi.useFakeTimers();
      const harness = createHarness();
      const normalRequest = harness.request.getMockImplementation()!;
      let requests = 0;
      harness.request.mockImplementation(async (method, params) => {
        if (method === 'agent' && ++requests === 1) {
          throw nativeDeferred(reason);
        }
        return normalRequest(method, params);
      });
      await harness.coordinator.handleLifecycle({
        runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
        phase: 'end', executionSettled: true,
      });
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
        phase: GoalExecutionPhase.Waiting, runId: 'parent-run',
        waitingReason: 'native-guard', continuationCount: 0,
      });
      expect(harness.onRunFailed).toHaveBeenCalledOnce();
      expect(harness.onRunUnknown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toBe(2);
      for (const [, params] of harness.request.mock.calls.filter(([method]) => method === 'agent')) {
        expect(params).toMatchObject({
          expectedExistingSessionId: nativeIdentity.sessionId,
          expectedExistingSessionLifecycleRevision: nativeIdentity.lifecycleRevision,
          goalContinuation: { goalId: 'goal-1', predecessorRunId: 'parent-run', automatic: true },
        });
      }
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
        phase: GoalExecutionPhase.Running, continuationCount: 1,
      });
      harness.coordinator.clear();
    },
  );

  it('backs off while native ownership remains occupied without consuming continuation count', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const normalRequest = harness.request.getMockImplementation()!;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'agent') throw nativeDeferred('native-handoff');
      return normalRequest(method, params);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    let attempts = 1;
    for (const delay of [2_000, 5_000, 10_000, 30_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(attempts);
      await vi.advanceTimersByTimeAsync(1);
      attempts += 1;
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(attempts);
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
        phase: GoalExecutionPhase.Waiting, waitingReason: 'native-guard',
        continuationCount: 0, retryAttempt: attempts,
      });
      expect(harness.coordinator.getSnapshot(sessionId)?.error).toBeUndefined();
    }
    harness.coordinator.clear();
  });

  it.each(['user-input', 'stop'])(
    'retires a native guard recheck when %s arrives during permission preparation', async action => {
      vi.useFakeTimers();
      const harness = createHarness();
      const normalRequest = harness.request.getMockImplementation()!;
      harness.request.mockImplementation(async (method, params) => {
        if (method === 'agent') throw nativeDeferred('main-running');
        return normalRequest(method, params);
      });
      harness.prepareSessionForContinuation.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        if (action === 'user-input') harness.coordinator.invalidateForUserTurn(sessionId);
        else {
          harness.coordinator.stop(sessionId);
          harness.coordinator.confirmStop(sessionId);
        }
      });
      await harness.coordinator.handleLifecycle({
        runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
        phase: 'end', executionSettled: true,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.prepareSessionForContinuation).toHaveBeenCalledTimes(2);
      const retired = harness.coordinator.getSnapshot(sessionId);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
      expect(harness.coordinator.getSnapshot(sessionId)).toBe(retired);
      harness.coordinator.clear();
    },
  );

  it('stops the deferred predecessor when a native successor has already taken ownership', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const normalRequest = harness.request.getMockImplementation()!;
    let attempts = 0;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'agent') throw nativeDeferred(++attempts === 1 ? 'main-running' : 'stale-predecessor');
      return normalRequest(method, params);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(2);
    expect(harness.coordinator.getSnapshot(sessionId)?.continuationCount).toBe(0);
    harness.coordinator.clear();
  });

  it('keeps the exact candidate unknown when a native guard recheck loses its ACK', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const normalRequest = harness.request.getMockImplementation()!;
    let attempts = 0;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'agent') {
        if (++attempts === 1) throw nativeDeferred('main-running');
        throw Object.assign(new Error('ACK lost'), { requestSent: true });
      }
      return normalRequest(method, params);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const unknown = harness.coordinator.getSnapshot(sessionId);
    expect(unknown).toMatchObject({ phase: GoalExecutionPhase.Running, identityPending: true });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(attempts).toBe(2);
    expect(harness.coordinator.getSnapshot(sessionId)).toBe(unknown);
    expect(harness.onRunUnknown).toHaveBeenCalledOnce();
    harness.coordinator.clear();
  });

  it('restores collector settlement through native guarded admission rather than fake running', async () => {
    const harness = createHarness();
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, goal(), nativeObservation(),
    );
    expect(harness.request).toHaveBeenCalledWith('agent', expect.objectContaining({
      goalContinuation: expect.objectContaining({ predecessorRunId: 'parent-run', automatic: true }),
    }));
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running, continuationCount: 1,
    });
    harness.coordinator.clear();
  });

  it('keeps restored native handoff waiting until the native observation changes', async () => {
    const harness = createHarness();
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, goal(),
      nativeObservation({ yielded: true }, { blockedReason: 'native-handoff' }),
    );
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Waiting, waitingReason: 'native-wake',
    });
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, goal(), nativeObservation({ yielded: true }),
    );
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    harness.coordinator.clear();
  });

  it.each([
    { runId: '' }, { sessionId: 'replaced-session' }, { lifecycleRevision: 'replaced-revision' },
    { executionSettled: false }, { phase: 'start' },
    { goalId: 'replacement-goal' },
  ])('does not recover an uncertain or mismatched predecessor: %j', async predecessor => {
    const harness = createHarness();
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, goal(), nativeObservation(predecessor),
    );
    await harness.coordinator.recheck(sessionId);
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Waiting);
    harness.coordinator.clear();
  });

  it('does not replace an explicit Stop with a late native observation', async () => {
    const harness = createHarness();
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);
    const stopped = harness.coordinator.getSnapshot(sessionId);
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, goal(), nativeObservation(),
    );
    expect(harness.coordinator.getSnapshot(sessionId)).toBe(stopped);
    expect(harness.request).not.toHaveBeenCalled();
    harness.coordinator.clear();
  });

  it('preserves sent admission uncertainty while a native observation arrives', async () => {
    const harness = createHarness();
    const normalRequest = harness.request.getMockImplementation()!;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'agent') throw Object.assign(new Error('ACK lost'), { requestSent: true });
      return normalRequest(method, params);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    const unknown = harness.coordinator.getSnapshot(sessionId);
    expect(unknown?.identityPending).toBe(true);
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, goal(), nativeObservation(),
    );
    await harness.coordinator.recheck(sessionId);
    expect(harness.coordinator.getSnapshot(sessionId)).toBe(unknown);
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    harness.coordinator.clear();
  });

  it('does not let an old finally release a newer dispatch lane', async () => {
    const harness = createHarness();
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    harness.prepareSessionForContinuation
      .mockImplementationOnce(async () => { await new Promise<void>(resolve => { releaseOld = resolve; }); })
      .mockImplementationOnce(async () => { await new Promise<void>(resolve => { releaseNew = resolve; }); });
    const oldDecision = harness.coordinator.handleLifecycle({
      runId: 'old-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    harness.coordinator.invalidateForUserTurn(sessionId);
    await harness.coordinator.handleLifecycle({ runId: 'parent-run', sessionKey, phase: 'start' });
    const newDecision = harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    await vi.waitFor(() => expect(releaseNew).toBeTypeOf('function'));
    const newSnapshot = harness.coordinator.getSnapshot(sessionId);
    releaseOld();
    await oldDecision;
    await harness.coordinator.reconcileNativeObservation(sessionId, sessionKey, goal(), nativeObservation());
    expect(harness.prepareSessionForContinuation).toHaveBeenCalledTimes(2);
    expect(harness.coordinator.getSnapshot(sessionId)).toBe(newSnapshot);
    releaseNew();
    await newDecision;
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    harness.coordinator.clear();
  });

  it('restores the native accepted count across connection cleanup', async () => {
    const harness = createHarness(SessionGoalStatus.Active, undefined, 25);
    harness.setGoal({ ...goal(), continuationTurns: 24 });
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'parent-run', 24);
    harness.coordinator.clear();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'parent-run', 24);
    expect(harness.coordinator.getSnapshot(sessionId)?.continuationCount).toBe(24);
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    expect(harness.coordinator.getSnapshot(sessionId)?.continuationCount).toBe(25);
    harness.coordinator.clear();
  });

  it.each([
    undefined,
    { goalId: 'different-goal', predecessorRunId: 'parent-run', continuationTurns: 1, acceptedAt: 100 },
    { goalId: 'goal-1', predecessorRunId: 'different-run', continuationTurns: 1, acceptedAt: 100 },
    { goalId: 'goal-1', predecessorRunId: 'parent-run', continuationTurns: -1, acceptedAt: 100 },
    { goalId: 'goal-1', predecessorRunId: 'parent-run', continuationTurns: 1 },
  ])('keeps a sent automatic run unknown when its native admission receipt is invalid: %j', async receipt => {
    vi.useFakeTimers();
    const harness = createHarness();
    const normalRequest = harness.request.getMockImplementation()!;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'agent') {
        return { runId: params?.idempotencyKey, status: 'accepted', goalContinuation: receipt };
      }
      return normalRequest(method, params);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    const unknown = harness.coordinator.getSnapshot(sessionId);
    expect(unknown).toMatchObject({ phase: GoalExecutionPhase.Running, identityPending: true });
    expect(harness.onRunUnknown).toHaveBeenCalledOnce();
    expect(harness.onRunFailed).not.toHaveBeenCalled();
    await harness.coordinator.recheck(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    expect(harness.coordinator.getSnapshot(sessionId)).toBe(unknown);
    harness.coordinator.clear();
  });

  it('does not create a new count when preparation fails before native admission', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.setGoal({ ...goal(), continuationTurns: 7 });
    harness.prepareSessionForContinuation.mockRejectedValue(new Error('permissions unavailable'));
    await harness.coordinator.handleLifecycle({
      runId: 'parent-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'end', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying, continuationCount: 7,
    });
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    harness.coordinator.clear();
  });

  it('does not resume a different Goal from a stale native observation', async () => {
    const harness = createHarness();
    await harness.coordinator.reconcileNativeObservation(
      sessionId, sessionKey, { ...goal(), id: 'replacement-goal' }, nativeObservation(),
    );
    await harness.coordinator.recheck(sessionId);
    expect(harness.request).not.toHaveBeenCalled();
    harness.coordinator.clear();
  });
});

describe('GoalContinuationCoordinator', () => {
  it('keeps a sent request unknown until exact settlement, without sending another run', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const normalRequest = harness.request.getMockImplementation()!;
    let sends = 0;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'agent' && ++sends === 1) {
        throw Object.assign(new Error('ACK timed out'), { code: 'CLIENT_TIMEOUT', requestSent: true });
      }
      return normalRequest(method, params);
    });
    await harness.coordinator.continue(sessionId, sessionKey);
    const unknown = harness.coordinator.getSnapshot(sessionId)!;
    expect(unknown).toMatchObject({ phase: GoalExecutionPhase.Running, identityPending: true });
    expect(harness.onRunFailed).not.toHaveBeenCalled();
    expect(harness.onRunUnknown).toHaveBeenCalledWith(sessionId, unknown.runId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toBe(1);
    await expect(harness.coordinator.continue(sessionId, sessionKey)).rejects.toThrow('already running');
    await harness.coordinator.reconcileSettledRun({
      sessionKey, runId: unknown.runId!, phase: 'error', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sends).toBe(2);
    expect(harness.coordinator.getSnapshot(sessionId)?.runId).not.toBe(unknown.runId);
  });

  it.each([{ runId: 'wrong-run', status: 'accepted' }, { status: 'aborted' }, {}])(
    'reconciles an unconfirmed continuation receipt %j without retrying', async receipt => {
      vi.useFakeTimers();
      const harness = createHarness();
      const normalRequest = harness.request.getMockImplementation()!;
      harness.request.mockImplementation(async (method, params) => method === 'agent'
        ? { runId: params?.idempotencyKey, ...receipt } : normalRequest(method, params));
      await harness.coordinator.continue(sessionId, sessionKey);
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ identityPending: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
      expect(harness.onRunFailed).not.toHaveBeenCalled();
    },
  );

  it.each([
    [SessionGoalStatus.Paused, GoalExecutionPhase.Stopped],
    [SessionGoalStatus.Complete, GoalExecutionPhase.AwaitingConfirmation],
    [SessionGoalStatus.BudgetLimited, GoalExecutionPhase.AwaitingInput],
  ] as const)('does not send when preparation changes the Goal to %s', async (status, phase) => {
    const harness = createHarness();
    harness.prepareSessionForContinuation.mockImplementation(async () => { harness.setGoal(goal(status)); });
    await harness.coordinator.continue(sessionId, sessionKey);
    expect(harness.onRunAccepted).not.toHaveBeenCalled();
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase, continuationCount: 0 });
  });

  it.each(['sessionId', 'lifecycleRevision'] as const)(
    'requires explicit review when the native %s changes during preparation', async field => {
      const harness = createHarness();
      let identity = { ...nativeIdentity };
      harness.request.mockImplementation(async _method => ({ session: { key: sessionKey, ...identity, goal: goal() } }));
      harness.prepareSessionForContinuation.mockImplementation(async () => { identity = { ...identity, [field]: 'replacement' }; });
      await harness.coordinator.continue(sessionId, sessionKey);
      expect(harness.onRunAccepted).not.toHaveBeenCalled();
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: GoalExecutionPhase.Stopped });
    },
  );

  it('does not transfer a prepared continuation to a replacement Goal', async () => {
    const harness = createHarness();
    harness.prepareSessionForContinuation.mockImplementation(async () => { harness.setGoal({ ...goal(), id: 'goal-2' }); });
    await harness.coordinator.continue(sessionId, sessionKey);
    expect(harness.onRunAccepted).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ goalId: 'goal-2', phase: GoalExecutionPhase.Stopped });
  });

  it('uses the current objective and native session constraints after preparation', async () => {
    const harness = createHarness();
    harness.prepareSessionForContinuation.mockImplementation(async () => { harness.setGoal({ ...goal(), objective: 'Revised objective' }); });
    await harness.coordinator.continue(sessionId, sessionKey);
    expect(harness.request).toHaveBeenCalledWith('agent', expect.objectContaining({
      message: expect.stringContaining('Revised objective'),
      expectedExistingSessionId: nativeIdentity.sessionId,
      expectedExistingSessionLifecycleRevision: nativeIdentity.lifecycleRevision,
    }));
  });

  it.each([
    ['end', false], ['error', false], ['end', true], ['error', true],
  ] as const)(
    'keeps the settled native session fence after failed %s inspection, rollback %s', async (phase, rollback) => {
      vi.useFakeTimers();
      const harness = createHarness();
      let inspections = 0;
      harness.request.mockImplementation(async method => {
        if (method === 'sessions.describe') {
          if (++inspections <= 2) throw new Error('inspection unavailable');
          return { session: { key: sessionKey, ...nativeIdentity, sessionId: 'replacement-native', goal: goal() } };
        }
        throw new Error(`unexpected send ${method}`);
      });
      await harness.coordinator.handleLifecycle({
        runId: 'run-1', sessionKey, sessionId: nativeIdentity.sessionId, phase: 'start',
      });
      await harness.coordinator.handleLifecycle({
        runId: 'run-1', sessionKey, sessionId: nativeIdentity.sessionId, phase, executionSettled: true,
      });
      if (rollback) {
        harness.coordinator.stop(sessionId);
        harness.coordinator.rollbackStop(sessionId);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
      expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
      harness.coordinator.clear();
    },
  );
  it.each([false, true])('retains a known lifecycle revision across retry, rollback %s', async rollback => {
    vi.useFakeTimers();
    const harness = createHarness();
    let lifecycleRevision = nativeIdentity.lifecycleRevision;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, ...nativeIdentity, lifecycleRevision, goal: goal() } };
      if (method === 'agent') return acceptedReceipt(params);
      throw new Error(method);
    });
    const running = await harness.coordinator.continue(sessionId, sessionKey);
    await harness.coordinator.handleLifecycle({
      runId: running.runId!, sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'error', executionSettled: true,
    });
    lifecycleRevision = 'revision-after-reset';
    if (rollback) {
      harness.coordinator.stop(sessionId);
      harness.coordinator.rollbackStop(sessionId);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
    harness.coordinator.clear();
  });

  it.each([false, true])('captures the first inspected revision before retrying an initial run, read failure %s', async failFirstRead => {
    vi.useFakeTimers();
    const prepare = vi.fn().mockRejectedValueOnce(new Error('preparation unavailable'));
    const harness = createHarness(SessionGoalStatus.Active, undefined, 20, prepare);
    let lifecycleRevision = nativeIdentity.lifecycleRevision;
    let reads = 0;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe') {
        if (++reads === 1 && failFirstRead) throw new Error('inspection unavailable');
        return { session: { key: sessionKey, ...nativeIdentity, lifecycleRevision, goal: goal() } };
      }
      if (method === 'agent') return acceptedReceipt(params);
      throw new Error(method);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'initial-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'error', executionSettled: true,
    });
    if (failFirstRead) await vi.advanceTimersByTimeAsync(2_000);
    lifecycleRevision = 'revision-after-reset';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
    harness.coordinator.clear();
  });

  it.each(['end', 'error'] as const)('rejects a reset before inspecting a settled %s run', async phase => {
    const harness = createHarness();
    const running = await harness.coordinator.continue(sessionId, sessionKey);
    harness.request.mockResolvedValue({ session: { key: sessionKey, ...nativeIdentity, lifecycleRevision: 'revision-after-reset', goal: goal() } });
    await harness.coordinator.handleLifecycle({
      runId: running.runId!, sessionKey, sessionId: nativeIdentity.sessionId, phase, executionSettled: true,
    });
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
    harness.coordinator.clear();
  });

  it('preserves a newly learned revision when Stop rolls back during retry preparation', async () => {
    vi.useFakeTimers();
    let releasePreparation: (() => void) | undefined;
    const prepare = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {
      releasePreparation = resolve;
    }));
    const harness = createHarness(SessionGoalStatus.Active, undefined, 20, prepare);
    let revision = nativeIdentity.lifecycleRevision;
    let reads = 0;
    harness.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe') {
        if (++reads === 1) throw new Error('inspection unavailable');
        return { session: { key: sessionKey, ...nativeIdentity, lifecycleRevision: revision, goal: goal() } };
      }
      if (method === 'agent') return acceptedReceipt(params);
      throw new Error(method);
    });
    await harness.coordinator.handleLifecycle({
      runId: 'initial-run', sessionKey, sessionId: nativeIdentity.sessionId,
      phase: 'error', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(releasePreparation).toBeDefined();
    harness.coordinator.stop(sessionId);
    harness.coordinator.rollbackStop(sessionId);
    revision = 'revision-after-reset';
    releasePreparation!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
    harness.coordinator.clear();
  });

  it.each(['end', 'error'] as const)(
    'ignores attempt %s until the same run definitively settles',
    async phase => {
      const harness = createHarness();
      await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'start' });
      for (const executionSettled of [undefined, false]) {
        await harness.coordinator.handleLifecycle({
          runId: 'run-1', sessionKey, phase, executionSettled,
        });
      }
      expect(harness.request).not.toHaveBeenCalled();
      expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Running);
      await harness.coordinator.handleLifecycle({
        runId: 'run-1', sessionKey, phase: 'end', executionSettled: true,
      });
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    },
  );

  it.each([
    undefined,
    JSON.stringify({ status: 'error', error: 'goal is already paused' }),
    JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ status: 'error' }) }] }),
    JSON.stringify({ status: 'updated', goal: goal(SessionGoalStatus.Paused) }),
  ])('does not infer completion from a requested status without a matching receipt (%s)', async output => {
    const harness = createHarness();
    harness.coordinator.handleToolEvent({
      runId: 'run-1', sessionKey, name: 'update_goal', toolCallId: 'call-1',
      input: { status: SessionGoalStatus.Complete }, output, status: 'completed', failed: false,
    });
    expect(harness.coordinator.getSnapshot(sessionId)).toBeNull();
    harness.setGoal(goal(SessionGoalStatus.Paused));
    await harness.coordinator.handleLifecycle({
      runId: 'run-1', sessionKey, phase: 'end', executionSettled: true,
    });
    expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Stopped);
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
  });

  it('reconciles structured mutation results into product execution state', () => {
    const harness = createHarness();

    harness.coordinator.synchronizeGoal(sessionId, goal(SessionGoalStatus.Paused));
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-1',
      phase: GoalExecutionPhase.Stopped,
    });

    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'resume-run');
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-1',
      phase: GoalExecutionPhase.Running,
      runId: 'resume-run',
    });

    harness.coordinator.clearSession(sessionId);
    expect(harness.coordinator.getSnapshot(sessionId)).toBeNull();
    expect(harness.onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId, phase: GoalExecutionPhase.Waiting }),
    );
  });

  it('preserves an explicit local stop while editing the same active goal', () => {
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);

    harness.coordinator.synchronizeGoal(sessionId, goal(SessionGoalStatus.Active), {
      preserveStopped: true,
    });

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-1',
      phase: GoalExecutionPhase.Stopped,
    });
  });

  it('does not dispatch a continuation after the session goal is cleared during lookup', async () => {
    let resolveGoal!: (value: { session: { key: string; goal: SessionGoal } }) => void;
    const goalLookup = new Promise<{ session: { key: string; goal: SessionGoal } }>(resolve => {
      resolveGoal = resolve;
    });
    const harness = createHarness();
    harness.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.describe') return goalLookup;
      if (method === 'agent') return acceptedReceipt(params);
      throw new Error(`unexpected method ${method}`);
    });

    const continuing = harness.coordinator.continue(sessionId, sessionKey);
    harness.coordinator.clearSession(sessionId);
    resolveGoal({ session: { key: sessionKey, ...nativeIdentity, goal: goal() } });

    await expect(continuing).rejects.toThrow('stopped');
    expect(harness.request.mock.calls.some(([method]) => method === 'agent')).toBe(false);
  });

  it('rejects a manual continuation cleared during session preparation', async () => {
    let resolvePreparation!: () => void;
    const preparation = new Promise<void>(resolve => {
      resolvePreparation = resolve;
    });
    const harness = createHarness(undefined, undefined, 20, vi.fn(() => preparation));

    const continuing = harness.coordinator.continue(sessionId, sessionKey);
    await vi.waitFor(() => expect(harness.prepareSessionForContinuation).toHaveBeenCalledOnce());
    harness.coordinator.clearSession(sessionId);
    resolvePreparation();

    await expect(continuing).rejects.toThrow('stopped');
    expect(harness.request.mock.calls.some(([method]) => method === 'agent')).toBe(false);
  });

  it('does not restore retry state when a cleared lifecycle lookup rejects', async () => {
    let rejectGoal!: (error: Error) => void;
    const goalLookup = new Promise<never>((_resolve, reject) => {
      rejectGoal = reject;
    });
    const harness = createHarness();
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return goalLookup;
      throw new Error(`unexpected method ${method}`);
    });

    const handling = harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'end', executionSettled: true,
    });
    harness.coordinator.clearSession(sessionId);
    rejectGoal(new Error('lookup unavailable'));
    await handling;

    expect(harness.coordinator.getSnapshot(sessionId)).toBeNull();
    expect(harness.onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId, phase: GoalExecutionPhase.Waiting }),
    );
  });

  it('ignores late terminal tool and lifecycle events from a cleared run', async () => {
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    harness.coordinator.clearSession(sessionId);

    harness.coordinator.handleToolEvent({
      runId: 'run-1',
      sessionKey,
      name: 'update_goal',
      toolCallId: 'call-1',
      input: { status: SessionGoalStatus.Complete },
      status: 'completed',
      failed: false,
    });
    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });

    expect(harness.coordinator.getSnapshot(sessionId)).toBeNull();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('dispatches another turn whenever a successful goal run remains active', async () => {
    const harness = createHarness();

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });

    expect(harness.request).toHaveBeenCalledWith('sessions.describe', { key: sessionKey });
    expect(harness.prepareSessionForContinuation).toHaveBeenCalledWith(sessionId);
    expect(harness.prepareSessionForContinuation.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onRunAccepted.mock.invocationCallOrder[0]!,
    );
    const agentParams = harness.request.mock.calls.find(call => call[0] === 'agent')?.[1];
    expect(agentParams).toMatchObject({
      sessionKey,
      agentId: 'main',
      deliver: false,
      suppressPromptPersistence: true,
    });
    expect(agentParams.message).toContain('Ship the release');
    expect(agentParams.extraSystemPrompt).toContain('do not repeat completed work');
    expect(agentParams.extraSystemPrompt).toContain('call update_goal with complete');
    expect(agentParams.extraSystemPrompt).toContain(
      'always provide one concise user-visible final answer',
    );
    expect(agentParams.extraSystemPrompt).toContain(
      'do not repeat, regenerate, paraphrase, or summarize them',
    );
    expect(agentParams.extraSystemPrompt).toContain(
      'exactly one short sentence in the user\'s language',
    );
    expect(agentParams.extraSystemPrompt).toContain(
      'without referring to earlier messages or results',
    );
    expect(agentParams.extraSystemPrompt).not.toContain('NO_REPLY');
    expect(agentParams.extraSystemPrompt).not.toContain('get_goal');
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-1',
      phase: GoalExecutionPhase.Running,
      continuationCount: 1,
    });
  });

  it('fails closed when the native session permission cannot be prepared', async () => {
    const prepareSessionForContinuation = vi
      .fn()
      .mockRejectedValue(new Error('permission synchronization failed'));
    const harness = createHarness(
      SessionGoalStatus.Active,
      undefined,
      20,
      prepareSessionForContinuation,
    );

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });

    expect(prepareSessionForContinuation).toHaveBeenCalledWith(sessionId);
    expect(harness.request.mock.calls.some(call => call[0] === 'agent')).toBe(false);
    expect(harness.onRunAccepted).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying,
    });
  });

  it('stops automatic continuation after the configured maximum', async () => {
    const harness = createHarness(SessionGoalStatus.Active, undefined, 0);

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });

    expect(harness.request).toHaveBeenCalledWith('agent', expect.objectContaining({
      goalContinuation: expect.objectContaining({ maxAutomaticContinuations: 0, automatic: true }),
    }));
    expect(harness.onRunUnknown).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
      continuationCount: 0,
    });
  });

  it('continues indefinitely even when turns have no tools or repeat the same tool result', async () => {
    const harness = createHarness();
    let runId = 'manual-run';

    for (let index = 0; index < 12; index += 1) {
      if (index > 0) {
        harness.coordinator.handleToolEvent({
          runId,
          sessionKey,
          name: 'shell_command',
          toolCallId: `tool-${index}`,
          input: { command: 'git status --short' },
          output: 'clean',
          status: 'completed',
          failed: false,
        });
      }
      await harness.coordinator.handleLifecycle({ runId, sessionKey, phase: 'end', executionSettled: true });
      runId = harness.coordinator.getSnapshot(sessionId)?.runId ?? '';
    }

    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(12);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running,
      continuationCount: 12,
    });
  });

  it('requires explicit continuation when the Goal is replaced during reconciliation', async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness(SessionGoalStatus.Active, async () => {
      harness.setGoal({
        ...goal(),
        id: 'goal-2',
        objective: 'Ship the replacement release',
      });
    });

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });

    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Stopped,
      continuationCount: 0,
    });
  });

  it('does not let a late continuation acknowledgement overwrite a newer manual run', async () => {
    const harness = createHarness();
    let resolveAgent: (() => void) | undefined;
    harness.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, ...nativeIdentity, goal: goal() } };
      if (method === 'agent') {
        await new Promise<void>(resolve => {
          resolveAgent = resolve;
        });
        return acceptedReceipt(params);
      }
      throw new Error(`unexpected method ${method}`);
    });

    const continuation = harness.coordinator.handleLifecycle({
      runId: 'old-run',
      sessionKey,
      phase: 'end', executionSettled: true,
    });
    await vi.waitFor(() => expect(harness.onRunAccepted).toHaveBeenCalledOnce());
    await harness.coordinator.handleLifecycle({
      runId: 'manual-run',
      sessionKey,
      phase: 'start',
    });
    resolveAgent?.();
    await continuation;

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running,
      runId: 'manual-run',
    });
  });

  it.each([
    [SessionGoalStatus.Paused, GoalExecutionPhase.Stopped],
    [SessionGoalStatus.Blocked, GoalExecutionPhase.AwaitingInput],
    [SessionGoalStatus.UsageLimited, GoalExecutionPhase.AwaitingInput],
    [SessionGoalStatus.BudgetLimited, GoalExecutionPhase.AwaitingInput],
    [SessionGoalStatus.Complete, GoalExecutionPhase.AwaitingConfirmation],
  ] as const)('does not continue a %s goal', async (status, phase) => {
    const harness = createHarness(status);
    await harness.coordinator.handleLifecycle({ runId: `run-${status}`, sessionKey, phase: 'end', executionSettled: true });
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase });
  });

  it.each([
    [SessionGoalStatus.Complete, GoalExecutionPhase.AwaitingConfirmation],
    [SessionGoalStatus.Blocked, GoalExecutionPhase.AwaitingInput],
  ] as const)('publishes update_goal %s immediately and latches stale metadata', async (status, phase) => {
    const harness = createHarness();
    harness.coordinator.handleToolEvent({
      runId: 'run-1',
      sessionKey,
      name: 'update_goal',
      toolCallId: 'call-1',
      input: { status },
      status: 'running',
      failed: false,
    });
    harness.coordinator.handleToolEvent({
      runId: 'run-1',
      sessionKey,
      name: 'update_goal',
      toolCallId: 'call-1',
      status: 'completed',
      output: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ status: 'updated', goal: goal(status) }) }],
        details: { status: 'updated', goal: goal(status) },
      }),
      failed: false,
    });

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase });
    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase });
  });

  it('continues when update_goal fails', async () => {
    const harness = createHarness();
    harness.coordinator.handleToolEvent({
      runId: 'run-1',
      sessionKey,
      name: 'update_goal',
      toolCallId: 'call-1',
      input: { status: SessionGoalStatus.Complete },
      status: 'running',
      failed: false,
    });
    harness.coordinator.handleToolEvent({
      runId: 'run-1',
      sessionKey,
      name: 'update_goal',
      toolCallId: 'call-1',
      status: 'failed',
      failed: true,
    });

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end', executionSettled: true });
    expect(harness.request).toHaveBeenCalledWith('agent', expect.anything());
  });

  it.each(['stale-run', 'stale-goal'])('ignores a successful %s tool receipt', stale => {
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    harness.coordinator.handleToolEvent({
      runId: stale === 'stale-run' ? 'old-run' : 'run-1',
      sessionKey,
      name: 'update_goal',
      toolCallId: 'call-1',
      input: { status: SessionGoalStatus.Complete },
      output: {
        status: 'updated',
        goal: { ...goal(SessionGoalStatus.Complete), id: stale === 'stale-goal' ? 'old-goal' : 'goal-1' },
      },
      status: 'completed',
      failed: false,
    });
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running, goalId: 'goal-1', runId: 'run-1',
    });
  });

  it('ignores a previous run terminal after restoring a new run', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({
      runId: 'old-run',
      sessionKey,
      phase: 'start',
    });
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'resumed-run');

    await harness.coordinator.handleLifecycle({
      runId: 'old-run',
      sessionKey,
      phase: 'end',
      executionSettled: true,
    });

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running,
      goalId: 'goal-1',
      runId: 'resumed-run',
    });
  });

  it('retries lifecycle errors and unexpected aborts instead of stopping', async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await harness.coordinator.handleLifecycle({
      runId: 'run-error',
      sessionKey,
      phase: 'error', executionSettled: true,
      error: 'provider failed',
    });
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying,
      retryAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.request).toHaveBeenCalledWith('agent', expect.anything());

    await harness.coordinator.handleLifecycle({
      runId: harness.coordinator.getSnapshot(sessionId)?.runId ?? 'retry-run',
      sessionKey,
      phase: 'end', executionSettled: true,
      aborted: true,
    });
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying,
      retryAttempt: 2,
    });
  });

  it('keeps retrying when a retry timer fires while another dispatch is settling', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let resolveAgent: (() => void) | undefined;
    let agentCalls = 0;
    harness.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, ...nativeIdentity, goal: goal() } };
      if (method === 'agent') {
        agentCalls += 1;
        if (agentCalls === 1) {
          await new Promise<void>(resolve => {
            resolveAgent = resolve;
          });
        }
        return acceptedReceipt(params);
      }
      throw new Error(`unexpected method ${method}`);
    });

    const firstDispatch = harness.coordinator.handleLifecycle({
      runId: 'manual-run',
      sessionKey,
      phase: 'end', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const continuationRunId = harness.onRunAccepted.mock.calls[0]?.[2] as string;

    await harness.coordinator.handleLifecycle({
      runId: continuationRunId,
      sessionKey,
      phase: 'end', executionSettled: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying,
      retryAttempt: 2,
    });

    resolveAgent?.();
    await firstDispatch;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(2);
  });

  it('does not transfer a failed run retry to a replacement Goal', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    await harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'error', executionSettled: true,
      error: 'provider failed',
    });
    harness.setGoal({
      ...goal(),
      id: 'goal-2',
      objective: 'Ship the replacement release',
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Stopped,
      continuationCount: 0,
    });
  });

  it('does not rearm backoff for a Goal which replaced the settled run owner', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, ...nativeIdentity, goal: goalState } };
      if (method === 'agent') throw Object.assign(new Error('gateway unavailable'), { requestSent: false });
      throw new Error(`unexpected method ${method}`);
    });
    let goalState: unknown = goal();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    await harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'error', executionSettled: true,
      error: 'provider failed',
    });
    goalState = {
      ...goal(),
      id: 'goal-2',
      objective: 'Ship the replacement release',
    };

    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Stopped,
      continuationCount: 0,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Stopped,
      continuationCount: 0,
    });
    expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
  });

  it('uses 2/5/10/30/60 second retry backoff without a maximum attempt count', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, ...nativeIdentity, goal: goal() } };
      if (method === 'agent') throw Object.assign(new Error('gateway unavailable'), { requestSent: false });
      throw new Error(`unexpected method ${method}`);
    });

    await harness.coordinator.handleLifecycle({
      runId: 'run-error',
      sessionKey,
      phase: 'error', executionSettled: true,
      error: 'provider failed',
    });
    for (const [index, delay] of [2_000, 5_000, 10_000, 30_000, 60_000, 60_000].entries()) {
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
        phase: GoalExecutionPhase.Retrying,
        retryAttempt: index + 1,
      });
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying,
      retryAttempt: 7,
    });
  });

  it('lets a manual run cancel a pending retry', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({
      runId: 'run-error',
      sessionKey,
      phase: 'error', executionSettled: true,
      error: 'provider failed',
    });

    harness.request.mockClear();
    await harness.coordinator.handleLifecycle({ runId: 'manual-run', sessionKey, phase: 'start' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running,
      runId: 'manual-run',
    });
  });

  it('keeps an explicit user stop authoritative', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.coordinator.stop(sessionId);
    await harness.coordinator.handleLifecycle({
      runId: 'run-stop',
      sessionKey,
      phase: 'end', executionSettled: true,
      aborted: true,
    });
    harness.coordinator.confirmStop(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
    });
  });

  it('does not let a later manual message implicitly resume an explicit user stop', async () => {
    const harness = createHarness();
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);

    await harness.coordinator.handleLifecycle({
      runId: 'manual-message',
      sessionKey,
      phase: 'start',
    });
    await harness.coordinator.handleLifecycle({
      runId: 'manual-message',
      sessionKey,
      phase: 'end', executionSettled: true,
    });

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
    });
  });

  it('keeps Continue available when an explicit Stop is followed by a replacement goal', async () => {
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'old-run');
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);
    harness.setGoal({
      ...goal(),
      id: 'goal-2',
      objective: 'Ship the replacement release',
    });

    await harness.coordinator.handleLifecycle({
      runId: 'create-replacement',
      sessionKey,
      phase: 'start',
    });
    await harness.coordinator.handleLifecycle({
      runId: 'create-replacement',
      sessionKey,
      phase: 'end', executionSettled: true,
    });

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Stopped,
    });

    await harness.coordinator.continue(sessionId, sessionKey);
    const agentParams = harness.request.mock.calls.find(call => call[0] === 'agent')?.[1];
    expect(agentParams.message).toContain('Ship the replacement release');
  });

  it('keeps an explicit Stop latched when Continue cannot read the Goal', async () => {
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'old-run');
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);
    harness.request.mockRejectedValueOnce(new Error('gateway offline'));

    await expect(harness.coordinator.continue(sessionId, sessionKey)).rejects.toThrow(
      'gateway offline',
    );
    await harness.coordinator.handleLifecycle({
      runId: 'manual-message',
      sessionKey,
      phase: 'start',
    });
    await harness.coordinator.handleLifecycle({
      runId: 'manual-message',
      sessionKey,
      phase: 'end', executionSettled: true,
    });

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
    });
  });

  it('does not let a concurrent Stop be cleared by an in-flight Continue', async () => {
    const harness = createHarness();
    let resolveGoalRead: (() => void) | undefined;
    harness.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.describe') {
        await new Promise<void>(resolve => {
          resolveGoalRead = resolve;
        });
        return { session: { key: sessionKey, ...nativeIdentity, goal: goal() } };
      }
      if (method === 'agent') return acceptedReceipt(params);
      throw new Error(`unexpected method ${method}`);
    });
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'old-run');
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);

    const continuing = harness.coordinator.continue(sessionId, sessionKey);
    await vi.waitFor(() => expect(resolveGoalRead).toBeTypeOf('function'));
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);
    resolveGoalRead?.();

    await expect(continuing).rejects.toThrow('Goal execution was stopped');
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
    });
  });

  it('does not let a stopped terminal handler overwrite a concurrent Continue', async () => {
    const harness = createHarness();
    let resolveStoppedRead: (() => void) | undefined;
    let describeCalls = 0;
    const replacementGoal = {
      ...goal(),
      id: 'goal-2',
      objective: 'Ship the replacement release',
    };
    harness.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.describe') {
        describeCalls += 1;
        if (describeCalls === 1) {
          await new Promise<void>(resolve => {
            resolveStoppedRead = resolve;
          });
        }
        return { session: { key: sessionKey, ...nativeIdentity, goal: replacementGoal } };
      }
      if (method === 'agent') return acceptedReceipt(params);
      throw new Error(`unexpected method ${method}`);
    });
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'old-run');
    harness.coordinator.stop(sessionId);
    harness.coordinator.confirmStop(sessionId);
    await harness.coordinator.handleLifecycle({
      runId: 'replacement-run',
      sessionKey,
      phase: 'start',
    });
    const stoppedTerminal = harness.coordinator.handleLifecycle({
      runId: 'replacement-run',
      sessionKey,
      phase: 'end', executionSettled: true,
    });
    await vi.waitFor(() => expect(describeCalls).toBe(1));

    await harness.coordinator.continue(sessionId, sessionKey);
    resolveStoppedRead?.();
    await stoppedTerminal;

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Running,
    });
  });

  it('deduplicates terminal lifecycle events and ignores unrelated sessions', async () => {
    const harness = createHarness();
    const event = { runId: 'run-1', sessionKey, phase: 'end' as const, executionSettled: true };
    await harness.coordinator.handleLifecycle(event);
    await harness.coordinator.handleLifecycle(event);
    await harness.coordinator.handleLifecycle({
      runId: 'subagent',
      sessionKey,
      spawnedBy: 'parent-run',
      phase: 'end', executionSettled: true,
    });
    await harness.coordinator.handleLifecycle({
      runId: 'channel',
      sessionKey: 'agent:main:discord:channel',
      phase: 'end', executionSettled: true,
    });
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(1);
  });
});


it('rearms automatic retry after a stop fails instead of restoring a timerless active snapshot', async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  await harness.coordinator.handleLifecycle({ runId: 'failed-run', sessionKey, phase: 'error', executionSettled: true, error: 'provider failure' });
  harness.coordinator.stop(sessionId);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
  harness.coordinator.rollbackStop(sessionId);
  expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Retrying);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(harness.request).toHaveBeenCalledWith('agent', expect.objectContaining({ sessionKey }));
});


it('does not schedule automatic work for a failed ordinary conversation with no goal', async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  harness.setGoal(null);
  await harness.coordinator.handleLifecycle({ runId: 'ordinary-run', sessionKey, phase: 'error', executionSettled: true, error: 'provider failed' });
  expect(harness.coordinator.getSnapshot(sessionId)?.phase).toBe(GoalExecutionPhase.Waiting);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
});

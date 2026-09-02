import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoalExecutionPhase, SessionGoalStatus } from '../../../shared/sessionGoal';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { GoalContinuationCoordinator } from './goalContinuationCoordinator';

const sessionId = 'session-1';
const sessionKey = 'agent:main:justdo:session-1';

const goal = (status: string = SessionGoalStatus.Active) => ({
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

const createHarness = (
  goalStatus: string = SessionGoalStatus.Active,
  waitBeforeAutomaticContinuation?: () => Promise<void>,
  maxContinuationTurns = 20,
  prepareSessionForContinuation = vi.fn().mockResolvedValue(undefined),
) => {
  let currentGoal: unknown = goal(goalStatus);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') return { session: { key: sessionKey, goal: currentGoal } };
    if (method === 'agent') return { runId: 'accepted', status: 'accepted' };
    throw new Error(`unexpected method ${method}`);
  });
  const onSnapshot = vi.fn();
  const onRunAccepted = vi.fn();
  const onRunFailed = vi.fn();
  let now = 100;
  const coordinator = new GoalContinuationCoordinator({
    getClient: () => ({ request } as unknown as GatewayClientLike),
    resolveSessionId: key => (key === sessionKey ? sessionId : null),
    resolveAgentId: () => 'main',
    getMaxContinuationTurns: () => maxContinuationTurns,
    onRunAccepted,
    onRunFailed,
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
    prepareSessionForContinuation,
    setGoal: (value: unknown) => {
      currentGoal = value;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('GoalContinuationCoordinator', () => {
  it('dispatches another turn whenever a successful goal run remains active', async () => {
    const harness = createHarness();

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });

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

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });

    expect(prepareSessionForContinuation).toHaveBeenCalledWith(sessionId);
    expect(harness.request.mock.calls.some(call => call[0] === 'agent')).toBe(false);
    expect(harness.onRunAccepted).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Retrying,
    });
  });

  it('stops automatic continuation after the configured maximum', async () => {
    const harness = createHarness(SessionGoalStatus.Active, undefined, 0);

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });

    expect(harness.request.mock.calls.some(call => call[0] === 'agent')).toBe(false);
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
      await harness.coordinator.handleLifecycle({ runId, sessionKey, phase: 'end' });
      runId = harness.coordinator.getSnapshot(sessionId)?.runId ?? '';
    }

    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(12);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Running,
      continuationCount: 12,
    });
  });

  it('continues a replacement goal that is still active during reconciliation', async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness(SessionGoalStatus.Active, async () => {
      harness.setGoal({
        ...goal(),
        id: 'goal-2',
        objective: 'Ship the replacement release',
      });
    });

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });

    const agentParams = harness.request.mock.calls.find(call => call[0] === 'agent')?.[1];
    expect(agentParams.message).toContain('Ship the replacement release');
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Running,
      continuationCount: 1,
    });
  });

  it('does not let a late continuation acknowledgement overwrite a newer manual run', async () => {
    const harness = createHarness();
    let resolveAgent: (() => void) | undefined;
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, goal: goal() } };
      if (method === 'agent') {
        await new Promise<void>(resolve => {
          resolveAgent = resolve;
        });
        return { runId: 'accepted', status: 'accepted' };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const continuation = harness.coordinator.handleLifecycle({
      runId: 'old-run',
      sessionKey,
      phase: 'end',
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
    [SessionGoalStatus.Complete, GoalExecutionPhase.AwaitingConfirmation],
  ] as const)('does not continue a %s goal', async (status, phase) => {
    const harness = createHarness(status);
    await harness.coordinator.handleLifecycle({ runId: `run-${status}`, sessionKey, phase: 'end' });
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase });
  });

  it.each([
    [SessionGoalStatus.UsageLimited, SessionGoalStatus.Blocked],
    [SessionGoalStatus.BudgetLimited, SessionGoalStatus.Blocked],
  ])('defensively treats unsupported %s as blocked', async status => {
    const harness = createHarness(status);
    await harness.coordinator.handleLifecycle({ runId: `run-${status}`, sessionKey, phase: 'end' });
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.AwaitingInput,
    });
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
      failed: false,
    });

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase });
    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });
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

    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });
    expect(harness.request).toHaveBeenCalledWith('agent', expect.anything());
  });

  it('retries lifecycle errors and unexpected aborts instead of stopping', async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await harness.coordinator.handleLifecycle({
      runId: 'run-error',
      sessionKey,
      phase: 'error',
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
      phase: 'end',
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
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, goal: goal() } };
      if (method === 'agent') {
        agentCalls += 1;
        if (agentCalls === 1) {
          await new Promise<void>(resolve => {
            resolveAgent = resolve;
          });
        }
        return { runId: 'accepted', status: 'accepted' };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const firstDispatch = harness.coordinator.handleLifecycle({
      runId: 'manual-run',
      sessionKey,
      phase: 'end',
    });
    await vi.advanceTimersByTimeAsync(0);
    const continuationRunId = harness.onRunAccepted.mock.calls[0]?.[2] as string;

    await harness.coordinator.handleLifecycle({
      runId: continuationRunId,
      sessionKey,
      phase: 'end',
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

  it('retries the current active goal when it replaces the failed goal', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    await harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'error',
      error: 'provider failed',
    });
    harness.setGoal({
      ...goal(),
      id: 'goal-2',
      objective: 'Ship the replacement release',
    });

    await vi.advanceTimersByTimeAsync(2_000);

    const agentParams = harness.request.mock.calls.find(call => call[0] === 'agent')?.[1];
    expect(agentParams.message).toContain('Ship the replacement release');
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Running,
      continuationCount: 1,
    });
  });

  it('keeps replacement-goal dispatch failures on the normal retry backoff', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, goal: goalState } };
      if (method === 'agent') throw new Error('gateway unavailable');
      throw new Error(`unexpected method ${method}`);
    });
    let goalState: unknown = goal();
    harness.coordinator.restoreRunning(sessionId, 'goal-1', 'run-1');
    await harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'error',
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
      phase: GoalExecutionPhase.Retrying,
      retryAttempt: 1,
      continuationCount: 1,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-2',
      phase: GoalExecutionPhase.Retrying,
      retryAttempt: 2,
      continuationCount: 2,
    });
  });

  it('uses 2/5/10/30/60 second retry backoff without a maximum attempt count', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, goal: goal() } };
      if (method === 'agent') throw new Error('gateway unavailable');
      throw new Error(`unexpected method ${method}`);
    });

    await harness.coordinator.handleLifecycle({
      runId: 'run-error',
      sessionKey,
      phase: 'error',
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
      phase: 'error',
      error: 'provider failed',
    });

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
      phase: 'end',
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
      phase: 'end',
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
      phase: 'end',
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
      phase: 'end',
    });

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
    });
  });

  it('does not let a concurrent Stop be cleared by an in-flight Continue', async () => {
    const harness = createHarness();
    let resolveGoalRead: (() => void) | undefined;
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') {
        await new Promise<void>(resolve => {
          resolveGoalRead = resolve;
        });
        return { session: { key: sessionKey, goal: goal() } };
      }
      if (method === 'agent') return { runId: 'accepted', status: 'accepted' };
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
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') {
        describeCalls += 1;
        if (describeCalls === 1) {
          await new Promise<void>(resolve => {
            resolveStoppedRead = resolve;
          });
        }
        return { session: { key: sessionKey, goal: replacementGoal } };
      }
      if (method === 'agent') return { runId: 'accepted', status: 'accepted' };
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
      phase: 'end',
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

  it('does not auto-continue an internal resume control run', async () => {
    const harness = createHarness();
    harness.coordinator.registerControlRun('resume-run');
    await harness.coordinator.handleLifecycle({ runId: 'resume-run', sessionKey, phase: 'start' });
    await harness.coordinator.handleLifecycle({ runId: 'resume-run', sessionKey, phase: 'end' });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('does not let a late control start hide the user feedback terminal event', async () => {
    const harness = createHarness();
    harness.coordinator.registerControlRun('control-run');

    await harness.coordinator.handleLifecycle({ runId: 'feedback-run', sessionKey, phase: 'start' });
    await harness.coordinator.handleLifecycle({ runId: 'control-run', sessionKey, phase: 'start' });
    await harness.coordinator.handleLifecycle({ runId: 'feedback-run', sessionKey, phase: 'end' });
    await harness.coordinator.handleLifecycle({ runId: 'control-run', sessionKey, phase: 'end' });

    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(1);
  });

  it('deduplicates terminal lifecycle events and ignores unrelated sessions', async () => {
    const harness = createHarness();
    const event = { runId: 'run-1', sessionKey, phase: 'end' as const };
    await harness.coordinator.handleLifecycle(event);
    await harness.coordinator.handleLifecycle(event);
    await harness.coordinator.handleLifecycle({
      runId: 'subagent',
      sessionKey,
      spawnedBy: 'parent-run',
      phase: 'end',
    });
    await harness.coordinator.handleLifecycle({
      runId: 'channel',
      sessionKey: 'agent:main:discord:channel',
      phase: 'end',
    });
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(1);
  });
});

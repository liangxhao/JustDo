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
    onRunAccepted,
    onRunFailed,
    onSnapshot,
    waitBeforeAutomaticContinuation,
    now: () => ++now,
  });
  return {
    coordinator,
    request,
    onSnapshot,
    onRunAccepted,
    onRunFailed,
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
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: GoalExecutionPhase.Stopped,
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

import { describe, expect, it, vi } from 'vitest';

import { SessionGoalStatus } from '../../../shared/sessionGoal';
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

describe('GoalContinuationCoordinator', () => {
  it('dispatches a hidden visible-effects continuation after a successful active goal run', async () => {
    const harness = createHarness();

    await harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'end',
    });

    expect(harness.request).toHaveBeenCalledWith('sessions.describe', { key: sessionKey });
    expect(harness.request).toHaveBeenCalledWith(
      'agent',
      expect.objectContaining({
        sessionKey,
        agentId: 'main',
        deliver: false,
        suppressPromptPersistence: true,
      }),
    );
    const agentParams = harness.request.mock.calls.find(call => call[0] === 'agent')?.[1];
    expect(agentParams.message).toContain('Ship the release');
    expect(agentParams.extraSystemPrompt).not.toContain('Ship the release');
    expect(agentParams.extraSystemPrompt).toContain('do not repeat completed work');
    expect(agentParams.extraSystemPrompt).toContain('a non-empty concise note describing the evidence');
    expect(agentParams.extraSystemPrompt).toContain('at least three consecutive goal turns');
    expect(agentParams).not.toHaveProperty('sessionEffects');
    expect(harness.onRunAccepted).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      goalId: 'goal-1',
      phase: 'running',
      continuationCount: 1,
    });
  });

  it.each([
    SessionGoalStatus.Paused,
    SessionGoalStatus.Blocked,
    SessionGoalStatus.UsageLimited,
    SessionGoalStatus.BudgetLimited,
    SessionGoalStatus.Complete,
  ])('does not continue a %s goal', async status => {
    const harness = createHarness(status);
    await harness.coordinator.handleLifecycle({ runId: `run-${status}`, sessionKey, phase: 'end' });
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
  });

  it('does not continue a cleared goal', async () => {
    const harness = createHarness();
    harness.setGoal(undefined);
    await harness.coordinator.handleLifecycle({ runId: 'run-clear', sessionKey, phase: 'end' });
    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
  });

  it.each([SessionGoalStatus.Complete, SessionGoalStatus.Blocked])(
    'does not continue after a successful update_goal %s tool call even if describe is stale',
    async status => {
      const harness = createHarness(SessionGoalStatus.Active);
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

      await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' });

      expect(harness.request).not.toHaveBeenCalled();
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'waiting' });
    },
  );

  it('continues when update_goal fails instead of treating the attempted status as authoritative', async () => {
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

  it('deduplicates terminal lifecycle events', async () => {
    const harness = createHarness();
    const event = { runId: 'run-1', sessionKey, phase: 'end' as const };
    await harness.coordinator.handleLifecycle(event);
    await harness.coordinator.handleLifecycle(event);
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(1);
  });

  it('serializes different terminal events for the same session', async () => {
    const harness = createHarness();
    await Promise.all([
      harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'end' }),
      harness.coordinator.handleLifecycle({ runId: 'run-2', sessionKey, phase: 'end' }),
    ]);
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(1);
  });

  it('cancels a pending continuation when the goal changes before dispatch', async () => {
    let releaseWait: (() => void) | undefined;
    const harness = createHarness(
      SessionGoalStatus.Active,
      () => new Promise<void>(resolve => (releaseWait = resolve)),
    );
    const terminal = harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'end',
    });
    await vi.waitFor(() => {
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'continuing' });
    });
    harness.setGoal(goal(SessionGoalStatus.Paused));
    releaseWait?.();
    await terminal;

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'waiting' });
  });

  it('does not resume a pending continuation after coordinator reset', async () => {
    let releaseWait: (() => void) | undefined;
    const harness = createHarness(
      SessionGoalStatus.Active,
      () => new Promise<void>(resolve => (releaseWait = resolve)),
    );
    const terminal = harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'end',
    });
    await vi.waitFor(() => {
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'continuing' });
    });
    harness.coordinator.clear();
    releaseWait?.();
    await terminal;

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toBeNull();
  });

  it('lets a new manual run supersede a pending automatic continuation', async () => {
    let releaseWait: (() => void) | undefined;
    const harness = createHarness(
      SessionGoalStatus.Active,
      () => new Promise<void>(resolve => (releaseWait = resolve)),
    );
    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'start' });
    const terminal = harness.coordinator.handleLifecycle({
      runId: 'run-1',
      sessionKey,
      phase: 'end',
    });
    await vi.waitFor(() => {
      expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'continuing' });
    });
    await harness.coordinator.handleLifecycle({ runId: 'manual-run', sessionKey, phase: 'start' });
    releaseWait?.();
    await terminal;

    expect(harness.request).not.toHaveBeenCalledWith('agent', expect.anything());
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: 'running',
      runId: 'manual-run',
    });
  });

  it('stops before an abort can trigger a new continuation', async () => {
    const harness = createHarness();
    harness.coordinator.stop(sessionId);
    await harness.coordinator.handleLifecycle({ runId: 'run-stop', sessionKey, phase: 'end' });
    await harness.coordinator.handleLifecycle({
      runId: 'run-stop-error',
      sessionKey,
      phase: 'error',
      error: 'aborted',
    });
    harness.coordinator.confirmStop(sessionId);
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'stopped' });
  });

  it('does not continue a run reported as aborted by OpenClaw', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({
      runId: 'run-aborted',
      sessionKey,
      phase: 'end',
      aborted: true,
    });
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'stopped' });
  });

  it('records failures without retrying automatically', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({
      runId: 'run-error',
      sessionKey,
      phase: 'error',
      error: 'provider failed',
    });
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: 'failed',
      error: 'provider failed',
    });
  });

  it('records an agent RPC rejection and allows a later manual retry', async () => {
    const harness = createHarness();
    let rejectAgent = true;
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, goal: goal() } };
      if (method === 'agent' && rejectAgent) throw new Error('gateway unavailable');
      if (method === 'agent') return { runId: 'accepted', status: 'accepted' };
      throw new Error(`unexpected method ${method}`);
    });

    await expect(harness.coordinator.continue(sessionId, sessionKey)).rejects.toThrow(
      'gateway unavailable',
    );
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: 'failed',
      error: 'gateway unavailable',
    });
    expect(harness.onRunFailed).toHaveBeenCalledTimes(1);

    rejectAgent = false;
    await harness.coordinator.continue(sessionId, sessionKey);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'running' });
  });

  it('rejects concurrent manual continuation requests for one session', async () => {
    const harness = createHarness();
    const first = harness.coordinator.continue(sessionId, sessionKey);
    await expect(harness.coordinator.continue(sessionId, sessionKey)).rejects.toThrow(
      'already running',
    );
    await first;
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(1);
  });

  it('keeps stop authoritative when an accepted continuation starts late', async () => {
    const harness = createHarness();
    let acceptAgent: (() => void) | undefined;
    harness.request.mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') return { session: { key: sessionKey, goal: goal() } };
      if (method === 'agent') {
        await new Promise<void>(resolve => (acceptAgent = resolve));
        return { status: 'accepted' };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const continuing = harness.coordinator.continue(sessionId, sessionKey);
    await vi.waitFor(() => expect(harness.onRunAccepted).toHaveBeenCalledTimes(1));
    const runId = harness.onRunAccepted.mock.calls[0][2];
    harness.coordinator.stop(sessionId);
    await harness.coordinator.handleLifecycle({ runId, sessionKey, phase: 'start' });
    acceptAgent?.();
    await continuing;
    harness.coordinator.confirmStop(sessionId);

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({ phase: 'stopped' });
  });

  it('restores the running snapshot when a stop cannot be confirmed', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({ runId: 'run-1', sessionKey, phase: 'start' });

    harness.coordinator.stop(sessionId);
    harness.coordinator.rollbackStop(sessionId);

    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: 'running',
      runId: 'run-1',
    });
  });

  it('stops after two automatic turns without concrete tool progress', async () => {
    const harness = createHarness();

    await harness.coordinator.handleLifecycle({ runId: 'manual-run', sessionKey, phase: 'end' });
    const firstContinuation = harness.coordinator.getSnapshot(sessionId)?.runId ?? '';
    harness.coordinator.handleToolEvent({
      runId: firstContinuation,
      sessionKey,
      name: 'get_goal',
      toolCallId: 'get-goal-1',
      status: 'completed',
      failed: false,
    });
    await harness.coordinator.handleLifecycle({
      runId: firstContinuation,
      sessionKey,
      phase: 'end',
    });
    const secondContinuation = harness.coordinator.getSnapshot(sessionId)?.runId ?? '';
    await harness.coordinator.handleLifecycle({
      runId: secondContinuation,
      sessionKey,
      phase: 'end',
    });

    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(2);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: 'failed',
      failureReason: 'stalled_no_progress',
    });
  });

  it('stops when successful tools repeat the same inputs and outputs without new evidence', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({ runId: 'manual-run', sessionKey, phase: 'end' });

    for (let index = 0; index < 3; index += 1) {
      const runId = harness.coordinator.getSnapshot(sessionId)?.runId ?? '';
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
      await harness.coordinator.handleLifecycle({ runId, sessionKey, phase: 'end' });
    }

    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(3);
    expect(harness.coordinator.getSnapshot(sessionId)).toMatchObject({
      phase: 'failed',
      failureReason: 'stalled_no_progress',
    });
  });

  it('allows unlimited sequential continuations while successful tools show concrete progress', async () => {
    const harness = createHarness();
    let runId = 'run-0';
    for (let index = 0; index < 12; index += 1) {
      if (index > 0) {
        harness.coordinator.handleToolEvent({
          runId,
          sessionKey,
          name: 'shell_command',
          toolCallId: `tool-${index}`,
          input: { command: `complete-step-${index}` },
          output: `completed-step-${index}`,
          status: 'completed',
          failed: false,
        });
      }
      await harness.coordinator.handleLifecycle({
        runId,
        sessionKey,
        phase: 'end',
      });
      runId = harness.coordinator.getSnapshot(sessionId)?.runId ?? '';
    }
    expect(harness.request.mock.calls.filter(call => call[0] === 'agent')).toHaveLength(12);
    expect(harness.coordinator.getSnapshot(sessionId)?.continuationCount).toBe(12);
  });

  it('requires manual continuation after coordinator state is cleared', async () => {
    const harness = createHarness();
    await harness.coordinator.handleLifecycle({ runId: 'run-start', sessionKey, phase: 'start' });
    harness.coordinator.clear();
    expect(harness.coordinator.getSnapshot(sessionId)).toBeNull();
    expect(harness.onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId, phase: 'waiting', continuationCount: 0 }),
    );

    await harness.coordinator.continue(sessionId, sessionKey);

    expect(harness.request).toHaveBeenCalledWith('agent', expect.anything());
  });

  it('ignores subagents and non-JustDo sessions', async () => {
    const harness = createHarness();
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
    expect(harness.request).not.toHaveBeenCalled();
  });
});

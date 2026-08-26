import { GoalExecutionPhase, SessionGoalStatus } from '@shared/sessionGoal';
import { describe, expect, it, vi } from 'vitest';

import { pauseGoalRun, shouldSendGoalPauseCommand } from './goalPause';

const goal = {
  schemaVersion: 1 as const,
  id: 'goal-1',
  objective: 'Ship the release',
  status: SessionGoalStatus.Active,
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 0,
  continuationTurns: 0,
};

describe('goal pause', () => {
  it('cancels startup without sending a pause command before execution binds the Goal', () => {
    expect(shouldSendGoalPauseCommand('session-1', goal, null)).toBe(false);
    expect(
      shouldSendGoalPauseCommand('session-1', goal, {
        sessionId: 'session-1',
        phase: GoalExecutionPhase.Running,
        continuationCount: 0,
        updatedAt: 2,
      }),
    ).toBe(false);
  });

  it('sends the pause command after execution binds the current Goal', () => {
    expect(
      shouldSendGoalPauseCommand('session-1', goal, {
        sessionId: 'session-1',
        goalId: goal.id,
        phase: GoalExecutionPhase.Running,
        continuationCount: 1,
        updatedAt: 2,
      }),
    ).toBe(true);
  });

  it('does not pause a stale Goal generation', () => {
    expect(
      shouldSendGoalPauseCommand('session-1', goal, {
        sessionId: 'session-1',
        goalId: 'goal-2',
        phase: GoalExecutionPhase.Running,
        continuationCount: 1,
        updatedAt: 2,
      }),
    ).toBe(false);
  });

  it('does not pause an execution snapshot from another session', () => {
    expect(
      shouldSendGoalPauseCommand('session-2', goal, {
        sessionId: 'session-1',
        goalId: goal.id,
        phase: GoalExecutionPhase.Running,
        continuationCount: 1,
        updatedAt: 2,
      }),
    ).toBe(false);
  });

  it('stops startup without sending a pause command', async () => {
    const calls: string[] = [];
    const result = await pauseGoalRun({
      sessionId: 'session-1',
      goal,
      execution: null,
      stop: () => {
        calls.push('stop');
        return true;
      },
      pause: () => {
        calls.push('pause');
      },
    });

    expect(result).toBe('stopped');
    expect(calls).toEqual(['stop']);
  });

  it('keeps the Goal unchanged when stopping fails', async () => {
    const pause = vi.fn();

    await expect(
      pauseGoalRun({
        sessionId: 'session-1',
        goal,
        execution: {
          sessionId: 'session-1',
          goalId: goal.id,
          phase: GoalExecutionPhase.Running,
          continuationCount: 1,
          updatedAt: 2,
        },
        stop: () => false,
        pause,
      }),
    ).resolves.toBe('stop_failed');
    expect(pause).not.toHaveBeenCalled();
  });

  it('sends a bound Goal pause only after stopping succeeds', async () => {
    const calls: string[] = [];
    const result = await pauseGoalRun({
      sessionId: 'session-1',
      goal,
      execution: {
        sessionId: 'session-1',
        goalId: goal.id,
        phase: GoalExecutionPhase.Running,
        continuationCount: 1,
        updatedAt: 2,
      },
      stop: () => {
        calls.push('stop');
        return true;
      },
      pause: () => {
        calls.push('pause');
      },
    });

    expect(result).toBe('paused');
    expect(calls).toEqual(['stop', 'pause']);
  });
});

import { SessionGoalStatus } from '@shared/sessionGoal';
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
  it('targets the exact displayed Goal generation', () => {
    expect(shouldSendGoalPauseCommand('session-1', goal)).toBe(true);
    expect(shouldSendGoalPauseCommand(undefined, goal)).toBe(false);
    expect(shouldSendGoalPauseCommand('session-1', null)).toBe(false);
  });

  it('keeps the Goal unchanged when stopping fails', async () => {
    const pause = vi.fn();

    await expect(
      pauseGoalRun({
        sessionId: 'session-1',
        goal,
        stop: () => false,
        pause,
      }),
    ).resolves.toBe('stop_failed');
    expect(pause).not.toHaveBeenCalled();
  });

  it('sends the structured pause only after stopping succeeds', async () => {
    const calls: string[] = [];
    const result = await pauseGoalRun({
      sessionId: 'session-1',
      goal,
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

it('pauses the originating Goal after navigation while the stop is pending', async () => {
  let finishStop!: (stopped: boolean) => void;
  let displayedGoal = goal;
  const pause = vi.fn();
  const pausing = pauseGoalRun({
    sessionId: 'session-a',
    goal: displayedGoal,
    stop: () =>
      new Promise<boolean>(resolve => {
        finishStop = resolve;
      }),
    pause,
  });
  displayedGoal = { ...goal, id: 'goal-b' };
  finishStop(true);
  await pausing;
  expect(pause).toHaveBeenCalledWith(goal);
  expect(pause).not.toHaveBeenCalledWith(displayedGoal);
});

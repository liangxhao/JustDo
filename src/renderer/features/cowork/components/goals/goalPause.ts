import type { SessionGoal } from '@shared/sessionGoal';

/**
 * Native Goal mutations fence the displayed Goal ID, so a pause remains safe
 * even when the local execution snapshot has not bound that identity yet.
 */
export const shouldSendGoalPauseCommand = (
  sessionId: string | undefined,
  goal: SessionGoal | null,
): boolean => !!sessionId && !!goal;

export type GoalPauseResult = 'stop_failed' | 'stopped' | 'paused';

export const pauseGoalRun = async ({
  sessionId,
  goal,
  stop,
  pause,
}: {
  sessionId: string | undefined;
  goal: SessionGoal | null;
  stop: () => boolean | void | Promise<boolean | void>;
  pause: (goal: SessionGoal) => void | Promise<void>;
}): Promise<GoalPauseResult> => {
  const sendPauseCommand = shouldSendGoalPauseCommand(sessionId, goal);
  const stopped = await stop();
  if (stopped === false) return 'stop_failed';
  if (!sendPauseCommand || !goal) return 'stopped';
  await pause(goal);
  return 'paused';
};

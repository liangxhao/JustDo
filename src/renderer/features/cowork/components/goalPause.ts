import type { GoalExecutionSnapshot, SessionGoal } from '@shared/sessionGoal';

/**
 * The Gateway can expose a newly created Goal before JustDo's continuation
 * coordinator has bound that Goal identity. In that startup window, stopping
 * the session is already a complete and durable pause; sending another
 * `/goal pause` turn can race the session abort and surface a false error.
 */
export const shouldSendGoalPauseCommand = (
  sessionId: string | undefined,
  goal: SessionGoal | null,
  execution: GoalExecutionSnapshot | null,
): boolean =>
  !!sessionId && !!goal && execution?.sessionId === sessionId && execution.goalId === goal.id;

export type GoalPauseResult = 'stop_failed' | 'stopped' | 'paused';

export const pauseGoalRun = async ({
  sessionId,
  goal,
  execution,
  stop,
  pause,
}: {
  sessionId: string | undefined;
  goal: SessionGoal | null;
  execution: GoalExecutionSnapshot | null;
  stop: () => boolean | void | Promise<boolean | void>;
  pause: () => void | Promise<void>;
}): Promise<GoalPauseResult> => {
  const sendPauseCommand = shouldSendGoalPauseCommand(sessionId, goal, execution);
  const stopped = await stop();
  if (stopped === false) return 'stop_failed';
  if (!sendPauseCommand) return 'stopped';
  await pause();
  return 'paused';
};

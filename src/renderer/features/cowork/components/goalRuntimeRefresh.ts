import { SessionGoalStatus as GoalStatuses, type SessionGoalStatus } from '@shared/sessionGoal';

export const GOAL_RUNNING_REFRESH_MS = 3_000;
export const GOAL_ACTIVE_IDLE_REFRESH_MS = 5_000;

export const getGoalRefreshDelay = (
  isRunActive: boolean,
  goalStatus?: SessionGoalStatus,
): number | null => {
  if (isRunActive) return GOAL_RUNNING_REFRESH_MS;
  return goalStatus === GoalStatuses.Active ? GOAL_ACTIVE_IDLE_REFRESH_MS : null;
};

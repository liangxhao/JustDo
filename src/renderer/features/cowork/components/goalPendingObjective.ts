import { parseGoalStartObjective } from '@shared/slashCommands';

export const inferInitialGoalObjective = (
  prompt: string,
  isSessionRunning: boolean,
): string | null => {
  if (!isSessionRunning) return null;
  return parseGoalStartObjective(prompt);
};

export const resolvePendingGoalObjectiveOnSessionChange = ({
  previousSessionId,
  nextSessionId,
  currentObjective,
  initialObjective,
  startupCancelled = false,
}: {
  previousSessionId?: string;
  nextSessionId?: string;
  currentObjective: string | null;
  initialObjective: string | null;
  startupCancelled?: boolean;
}): string | null => {
  if (startupCancelled) return null;
  if (initialObjective) return initialObjective;
  const inheritsTemporarySessionGoal =
    !!previousSessionId?.startsWith('temp-') &&
    !!nextSessionId &&
    !nextSessionId.startsWith('temp-');
  return inheritsTemporarySessionGoal ? currentObjective : null;
};

export type GoalClearFetchDecision = 'accept_new_goal' | 'cleared' | 'ignore_old_goal';

export const resolveGoalClearFetch = (
  clearTargetId: string | null,
  fetchedGoalId: string | null,
): GoalClearFetchDecision => {
  if (!fetchedGoalId) return 'cleared';
  if (clearTargetId && fetchedGoalId !== clearTargetId) return 'accept_new_goal';
  return 'ignore_old_goal';
};

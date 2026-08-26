import { parseGoalStartObjective } from '@shared/slashCommands';

import type { CoworkMessage } from '@/features/cowork/coworkTypes';

export const inferInitialGoalObjective = (
  messages: readonly Pick<CoworkMessage, 'type' | 'content'>[],
  isSessionRunning: boolean,
): string | null => {
  if (!isSessionRunning || messages.some(message => message.type === 'assistant')) return null;
  const latestUserMessage = [...messages].reverse().find(message => message.type === 'user');
  return parseGoalStartObjective(latestUserMessage?.content ?? '');
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

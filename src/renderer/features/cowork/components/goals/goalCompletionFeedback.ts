import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';

interface GoalRestartResponse {
  success: boolean;
  objective?: string;
}

interface SubmitGoalCompletionFeedbackOptions {
  completedGoalId: string;
  preparedObjective?: string;
  restart: (goalId: string, objective?: string) => Promise<GoalRestartResponse>;
  onPrepared: (objective: string) => void;
  canSend?: () => boolean;
  feedback: string;
  send: (gatewayMessage: string) => Promise<boolean | void>;
}

export type GoalCompletionFeedbackOutcome =
  'context_changed' | 'restart_failed' | 'send_failed' | 'sent';

export const shouldDiscardGoalCompletionFeedback = (
  completedGoalId: string,
  nextGoalId: string | null | undefined,
): boolean => Boolean(nextGoalId && nextGoalId !== completedGoalId);

export const submitGoalCompletionFeedback = async ({
  completedGoalId,
  preparedObjective,
  restart,
  onPrepared,
  canSend,
  feedback,
  send,
}: SubmitGoalCompletionFeedbackOptions): Promise<GoalCompletionFeedbackOutcome> => {
  let result: GoalRestartResponse;
  try {
    result = await restart(completedGoalId, preparedObjective?.trim() || undefined);
  } catch {
    return 'restart_failed';
  }
  const objective = result.objective?.trim() ?? '';
  if (!result.success || !objective) return 'restart_failed';
  onPrepared(objective);

  if (canSend && !canSend()) return 'context_changed';

  try {
    const sent = await send(buildGoalFollowUpPrompt(objective, feedback));
    return sent === false ? 'send_failed' : 'sent';
  } catch {
    return 'send_failed';
  }
};

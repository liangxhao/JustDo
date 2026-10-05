import { SessionGoalStatus } from '@shared/cowork/sessionGoal';

/** Goal resume/feedback routes do not send a normal chat request. */
export function blocksSwarmGoalSubmission({
  swarmSelected,
  goalStatus,
  completionFeedback,
}: {
  swarmSelected: boolean;
  goalStatus?: SessionGoalStatus;
  completionFeedback: boolean;
}): boolean {
  return (
    swarmSelected &&
    (completionFeedback || (goalStatus !== undefined && goalStatus !== SessionGoalStatus.Complete))
  );
}

import { SessionGoalStatus } from '@shared/cowork/sessionGoal';

/** Goal resume/feedback routes do not send a normal chat request. */
export function blocksSwarmWorkflowGoalSubmission({
  swarmWorkflowSelected,
  goalStatus,
  completionFeedback,
}: {
  swarmWorkflowSelected: boolean;
  goalStatus?: SessionGoalStatus;
  completionFeedback: boolean;
}): boolean {
  return (
    swarmWorkflowSelected &&
    (completionFeedback || (goalStatus !== undefined && goalStatus !== SessionGoalStatus.Complete))
  );
}

import { SessionGoalStatus } from '@shared/cowork/sessionGoal';

import { blocksWorkflowGoalSubmission } from '../../../../../../plugins/extensions/swarm-workflow/browser/composer';

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
  return blocksWorkflowGoalSubmission({
    swarmWorkflowSelected,
    completionFeedback,
    goalIsIncomplete: goalStatus !== undefined && goalStatus !== SessionGoalStatus.Complete,
  });
}

import { SessionGoalStatus } from '@shared/cowork/sessionGoal';
import { expect, it } from 'vitest';

import { blocksSwarmWorkflowGoalSubmission } from './swarmWorkflowSubmission';

it.each([
  SessionGoalStatus.Active,
  SessionGoalStatus.Paused,
  SessionGoalStatus.Blocked,
  SessionGoalStatus.UsageLimited,
  SessionGoalStatus.BudgetLimited,
])('refuses a Swarm send before the existing %s goal can consume it', goalStatus => {
  expect(
    blocksSwarmWorkflowGoalSubmission({ swarmWorkflowSelected: true, goalStatus, completionFeedback: false }),
  ).toBe(true);
});

it('refuses completed-goal feedback before restarting the old goal', () => {
  expect(
    blocksSwarmWorkflowGoalSubmission({
      swarmWorkflowSelected: true,
      goalStatus: SessionGoalStatus.Complete,
      completionFeedback: true,
    }),
  ).toBe(true);
});

it.each([undefined, SessionGoalStatus.Complete])(
  'allows Swarm with no unfinished goal (%s)',
  goalStatus => {
    expect(
      blocksSwarmWorkflowGoalSubmission({ swarmWorkflowSelected: true, goalStatus, completionFeedback: false }),
    ).toBe(false);
  },
);

it('keeps ordinary goal resume and feedback available when Swarm is not selected', () => {
  for (const goalStatus of Object.values(SessionGoalStatus)) {
    for (const completionFeedback of [true, false]) {
      expect(
        blocksSwarmWorkflowGoalSubmission({ swarmWorkflowSelected: false, goalStatus, completionFeedback }),
      ).toBe(false);
    }
  }
});

import { SessionGoalStatus } from '@shared/cowork/sessionGoal';
import { expect, it } from 'vitest';

import { blocksSwarmGoalSubmission } from './swarmSubmission';

it.each([
  SessionGoalStatus.Active,
  SessionGoalStatus.Paused,
  SessionGoalStatus.Blocked,
  SessionGoalStatus.UsageLimited,
  SessionGoalStatus.BudgetLimited,
])('refuses a Swarm send before the existing %s goal can consume it', goalStatus => {
  expect(
    blocksSwarmGoalSubmission({ swarmSelected: true, goalStatus, completionFeedback: false }),
  ).toBe(true);
});

it('refuses completed-goal feedback before restarting the old goal', () => {
  expect(
    blocksSwarmGoalSubmission({
      swarmSelected: true,
      goalStatus: SessionGoalStatus.Complete,
      completionFeedback: true,
    }),
  ).toBe(true);
});

it.each([undefined, SessionGoalStatus.Complete])(
  'allows Swarm with no unfinished goal (%s)',
  goalStatus => {
    expect(
      blocksSwarmGoalSubmission({ swarmSelected: true, goalStatus, completionFeedback: false }),
    ).toBe(false);
  },
);

it('keeps ordinary goal resume and feedback available when Swarm is not selected', () => {
  for (const goalStatus of Object.values(SessionGoalStatus)) {
    for (const completionFeedback of [true, false]) {
      expect(
        blocksSwarmGoalSubmission({ swarmSelected: false, goalStatus, completionFeedback }),
      ).toBe(false);
    }
  }
});

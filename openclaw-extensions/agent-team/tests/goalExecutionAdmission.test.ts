import { describe, expect, it } from 'vitest';

import { hasBlockingGoalExecution } from '../contracts/goalExecutionAdmission';

describe('Goal admission evidence', () => {
  it.each([undefined, null, { phase: 'waiting' }, { phase: 'stopped' }])(
    'allows absent or neutral ordinary-session evidence %j',
    snapshot => expect(hasBlockingGoalExecution(snapshot)).toBe(false),
  );
  it.each([
    {},
    [],
    true,
    { phase: 'running' },
    { phase: 'retrying' },
    { phase: 'continuing' },
    { phase: 'awaiting_confirmation' },
    { phase: 'unknown' },
    { phase: 'waiting', goalId: 'goal' },
    { phase: 'stopped', goalId: 'goal' },
    { phase: 'waiting', identityPending: true },
    { phase: 'stopped', identityPending: true },
    { phase: 'waiting', identityPending: 'unknown' },
  ])('retains restrictions for Goal or uncertain evidence %j', snapshot => {
    expect(hasBlockingGoalExecution(snapshot)).toBe(true);
  });
});

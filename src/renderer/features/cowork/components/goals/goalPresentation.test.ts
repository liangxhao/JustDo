import { SessionGoalStatus } from '@shared/sessionGoal';
import { describe, expect, it } from 'vitest';

import { getGoalPresentation } from './goalPresentation';

describe('goal presentation', () => {
  it('maps every runtime status to an intentional tone', () => {
    expect(
      Object.values(SessionGoalStatus).map(status => getGoalPresentation(status).tone),
    ).toEqual(['active', 'muted', 'warning', 'warning', 'warning', 'success']);
  });

  it('keeps usage and budget limits distinguishable from a blocked Goal', () => {
    expect(getGoalPresentation(SessionGoalStatus.Blocked).labelKey).toBe('coworkGoalBlocked');
    expect(getGoalPresentation(SessionGoalStatus.UsageLimited).labelKey).toBe(
      'coworkGoalUsageLimited',
    );
    expect(getGoalPresentation(SessionGoalStatus.BudgetLimited).labelKey).toBe(
      'coworkGoalBudgetLimited',
    );
  });
});

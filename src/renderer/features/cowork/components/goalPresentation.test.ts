import { SessionGoalStatus } from '@shared/sessionGoal';
import { describe, expect, it } from 'vitest';

import { getGoalPresentation } from './goalPresentation';

describe('goal presentation', () => {
  it('maps every runtime status to an intentional tone', () => {
    expect(
      Object.values(SessionGoalStatus).map(status => getGoalPresentation(status).tone),
    ).toEqual(['active', 'muted', 'warning', 'warning', 'warning', 'success']);
  });
});

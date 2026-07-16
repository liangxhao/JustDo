import { describe, expect, it } from 'vitest';

import { getGoalRefreshDelay } from './goalRuntimeRefresh';

describe('getGoalRefreshDelay', () => {
  it('refreshes quickly during a run and backs off for an idle active goal', () => {
    expect(getGoalRefreshDelay(true, 'active')).toBe(1_500);
    expect(getGoalRefreshDelay(false, 'active')).toBe(5_000);
  });

  it('stops polling terminal or paused goals while idle', () => {
    expect(getGoalRefreshDelay(false, 'complete')).toBeNull();
    expect(getGoalRefreshDelay(false, 'paused')).toBeNull();
    expect(getGoalRefreshDelay(false)).toBeNull();
  });
});

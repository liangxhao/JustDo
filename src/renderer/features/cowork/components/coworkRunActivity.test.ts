import { describe, expect, it } from 'vitest';

import { canStopCoworkRun, isCoworkRunActive } from './coworkRunActivity';
import type { GoalRunProgress } from './goalRunProgress';

const compactionProgress: GoalRunProgress = {
  phase: 'compacting',
  startedAt: 1,
  toolCount: 0,
};

describe('isCoworkRunActive', () => {
  it('keeps the prompt running while local context compaction is active', () => {
    expect(isCoworkRunActive(false, compactionProgress)).toBe(true);
  });

  it('is idle only when runtime and local controller activity are both idle', () => {
    expect(isCoworkRunActive(false, null)).toBe(false);
  });

  it('does not offer chat abort for standalone context compaction', () => {
    expect(canStopCoworkRun(false, compactionProgress)).toBe(false);
    expect(canStopCoworkRun(true, compactionProgress)).toBe(false);
    expect(canStopCoworkRun(true, null)).toBe(true);
  });
});

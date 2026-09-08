import { describe, expect, it } from 'vitest';

import type { GoalRunProgress } from '../goals/goalRunProgress';
import { canStopCoworkRun, isCoworkRunActive } from './coworkRunActivity';

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

  it('keeps cancellation available during automatic and manual compaction', () => {
    expect(canStopCoworkRun(false, compactionProgress)).toBe(true);
    expect(canStopCoworkRun(true, compactionProgress)).toBe(true);
    expect(canStopCoworkRun(true, null)).toBe(true);
  });

  it('does not turn stale controller progress into a new runtime activity claim', () => {
    const progress: GoalRunProgress = { phase: 'running', startedAt: 1, toolCount: 0 };
    expect(isCoworkRunActive(false, progress)).toBe(false);
    expect(canStopCoworkRun(false, progress)).toBe(false);
    expect(canStopCoworkRun(true, progress)).toBe(true);
    expect(canStopCoworkRun(false, null)).toBe(false);
  });
});

import { type SessionGoal, SessionGoalStatus } from '@shared/sessionGoal';
import { describe, expect, it } from 'vitest';

import {
  formatGoalTokenCount,
  getGoalBudgetPercentage,
  getGoalPresentation,
} from './goalPresentation';

const createGoal = (overrides: Partial<SessionGoal> = {}): SessionGoal => ({
  schemaVersion: 1,
  id: 'goal-1',
  objective: 'Ship the goal UI',
  status: SessionGoalStatus.Active,
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 12_000,
  tokenBudget: 50_000,
  continuationTurns: 1,
  ...overrides,
});

describe('goal presentation', () => {
  it('maps every runtime status to an intentional tone', () => {
    expect(
      Object.values(SessionGoalStatus).map(status => getGoalPresentation(status).tone),
    ).toEqual(['active', 'muted', 'warning', 'danger', 'warning', 'success']);
  });

  it('formats compact token counts', () => {
    expect(formatGoalTokenCount(999)).toBe('999');
    expect(formatGoalTokenCount(12_300)).toBe('12k');
    expect(formatGoalTokenCount(1_250_000)).toBe('1.3m');
  });

  it('caps goal budget progress for over-budget goals', () => {
    expect(getGoalBudgetPercentage(createGoal())).toBe(24);
    expect(getGoalBudgetPercentage(createGoal({ tokensUsed: 75_000 }))).toBe(100);
    expect(getGoalBudgetPercentage(createGoal({ tokenBudget: undefined }))).toBeNull();
    expect(getGoalBudgetPercentage(createGoal({ tokensUsed: 0 }))).toBeNull();
  });
});

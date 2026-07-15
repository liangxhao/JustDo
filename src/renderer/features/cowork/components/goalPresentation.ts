import { type SessionGoal, SessionGoalStatus } from '@shared/sessionGoal';

export type GoalTone = 'active' | 'muted' | 'warning' | 'danger' | 'success';

export interface GoalPresentation {
  labelKey:
    | 'coworkGoalActive'
    | 'coworkGoalPaused'
    | 'coworkGoalBlocked'
    | 'coworkGoalUsageLimited'
    | 'coworkGoalBudgetLimited'
    | 'coworkGoalComplete';
  hintKey:
    | 'coworkGoalActiveHint'
    | 'coworkGoalPausedHint'
    | 'coworkGoalBlockedHint'
    | 'coworkGoalUsageLimitedHint'
    | 'coworkGoalBudgetLimitedHint'
    | 'coworkGoalCompleteHint';
  tone: GoalTone;
}

export const getGoalPresentation = (status: SessionGoal['status']): GoalPresentation => {
  switch (status) {
    case SessionGoalStatus.Active:
      return {
        labelKey: 'coworkGoalActive',
        hintKey: 'coworkGoalActiveHint',
        tone: 'active',
      };
    case SessionGoalStatus.Paused:
      return {
        labelKey: 'coworkGoalPaused',
        hintKey: 'coworkGoalPausedHint',
        tone: 'muted',
      };
    case SessionGoalStatus.Blocked:
      return {
        labelKey: 'coworkGoalBlocked',
        hintKey: 'coworkGoalBlockedHint',
        tone: 'warning',
      };
    case SessionGoalStatus.UsageLimited:
      return {
        labelKey: 'coworkGoalUsageLimited',
        hintKey: 'coworkGoalUsageLimitedHint',
        tone: 'danger',
      };
    case SessionGoalStatus.BudgetLimited:
      return {
        labelKey: 'coworkGoalBudgetLimited',
        hintKey: 'coworkGoalBudgetLimitedHint',
        tone: 'warning',
      };
    case SessionGoalStatus.Complete:
      return {
        labelKey: 'coworkGoalComplete',
        hintKey: 'coworkGoalCompleteHint',
        tone: 'success',
      };
  }
};

export const formatGoalTokenCount = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const rounded = value >= 10_000 ? Math.round(value / 1_000) : Math.round(value / 100) / 10;
    return rounded >= 1_000 ? '1m' : `${rounded}k`;
  }
  const rounded =
    value >= 10_000_000 ? Math.round(value / 1_000_000) : Math.round(value / 100_000) / 10;
  return `${rounded}m`;
};

export const getGoalBudgetPercentage = (goal: SessionGoal): number | null => {
  if (goal.tokensUsed <= 0 || goal.tokenBudget === undefined || goal.tokenBudget <= 0) return null;
  return Math.min(100, Math.max(0, (goal.tokensUsed / goal.tokenBudget) * 100));
};

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

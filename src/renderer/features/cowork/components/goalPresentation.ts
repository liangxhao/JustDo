import { type SessionGoal, SessionGoalStatus } from '@shared/sessionGoal';

export type GoalTone = 'active' | 'muted' | 'warning' | 'danger' | 'success';

export interface GoalPresentation {
  labelKey: 'coworkGoalActive' | 'coworkGoalPaused' | 'coworkGoalBlocked' | 'coworkGoalComplete';
  hintKey:
    | 'coworkGoalActiveHint'
    | 'coworkGoalPausedHint'
    | 'coworkGoalBlockedHint'
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
    case SessionGoalStatus.BudgetLimited:
      return {
        labelKey: 'coworkGoalBlocked',
        hintKey: 'coworkGoalBlockedHint',
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

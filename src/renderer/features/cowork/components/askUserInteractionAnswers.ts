import type { AskUserAnswers } from '@shared/openclaw/extensions';

export const buildSingleOptionAnswers = (
  questionId: string,
  optionId: string,
): AskUserAnswers => ({
  [questionId]: { selected: [optionId] },
});

export const buildOtherAnswers = (questionId: string, other: string): AskUserAnswers => ({
  [questionId]: { selected: [], other },
});

export const resolveWizardAutoAdvanceStep = (
  currentStep: number,
  scheduledStep: number,
  totalSteps: number,
): number => {
  if (currentStep !== scheduledStep) return currentStep;
  const nextStep = scheduledStep + 1;
  return nextStep < totalSteps ? nextStep : currentStep;
};

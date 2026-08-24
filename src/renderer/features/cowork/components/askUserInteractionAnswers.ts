import type { AskUserQuestion } from '@shared/openclaw/extensions';

export const isQuestionAnswerComplete = (
  question: AskUserQuestion,
  selected: string[],
  optionInputs: Record<string, string> | undefined,
  otherActive: boolean,
  otherInput: string | undefined,
): boolean => {
  if (otherActive && !otherInput?.trim()) return false;
  const hasOther = Boolean(otherActive && otherInput?.trim());
  if (selected.length === 0 && !hasOther) return false;

  return selected.every(id => {
    const option = question.options.find(candidate => candidate.id === id);
    return !option?.input || Boolean(optionInputs?.[id]?.trim());
  });
};

export const resolveWizardAutoAdvanceStep = (
  currentStep: number,
  scheduledStep: number,
  totalSteps: number,
): number => {
  if (currentStep !== scheduledStep) return currentStep;
  const nextStep = scheduledStep + 1;
  return nextStep < totalSteps ? nextStep : currentStep;
};

export const shouldShowQuestionHeader = (questionCount: number): boolean => questionCount > 1;

export const getQuestionDialogTitle = (questions: AskUserQuestion[], fallback: string): string =>
  questions.length === 1 ? questions[0].header?.trim() || fallback : fallback;

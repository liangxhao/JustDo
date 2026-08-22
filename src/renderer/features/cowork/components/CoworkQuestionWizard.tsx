import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type {
  AskUserAnswers,
  AskUserQuestion,
  AskUserQuestionOption,
} from '@shared/openclaw/extensions';
import { CoworkInteractionKind, parseAskUserQuestions } from '@shared/openclaw/extensions';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type {
  CoworkInteractionPresentation,
  CoworkInteractionRequest,
  CoworkInteractionResult,
} from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

import {
  isQuestionAnswerComplete,
  resolveWizardAutoAdvanceStep,
  shouldShowQuestionHeader,
} from './askUserInteractionAnswers';
import AskUserWaitPolicyNotice from './AskUserWaitPolicyNotice';
import { useDialogFocusTrap } from './useDialogFocusTrap';

interface CoworkQuestionWizardProps {
  interaction: CoworkInteractionRequest;
  onRespond: (result: CoworkInteractionResult) => void;
  presentation?: CoworkInteractionPresentation;
  isActive?: boolean;
}

const CoworkQuestionWizard: React.FC<CoworkQuestionWizardProps> = ({
  interaction,
  onRespond,
  presentation = 'modal',
  isActive = true,
}) => {
  const toolInput = useMemo(() => interaction.toolInput ?? {}, [interaction.toolInput]);

  const questions = useMemo<AskUserQuestion[]>(() => {
    if (interaction.interactionKind !== CoworkInteractionKind.STRUCTURED_QUESTION) return [];
    if (!toolInput || typeof toolInput !== 'object') return [];
    return parseAskUserQuestions((toolInput as Record<string, unknown>).questions) ?? [];
  }, [interaction.interactionKind, toolInput]);

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [optionInputs, setOptionInputs] = useState<Record<string, Record<string, string>>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Record<string, boolean>>({});
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const isFloating = presentation === 'floating';

  useDialogFocusTrap(dialogRef, closeButtonRef, interaction.requestId, !isFloating, isActive);

  useEffect(() => {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = null;
    setCurrentStep(0);
    setAnswers({});
    setOptionInputs({});
    setOtherInputs({});
    setOtherActive({});
    setSkippedQuestions({});
    return () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    };
  }, [interaction.requestId, toolInput]);

  if (questions.length === 0) {
    return null;
  }

  const totalSteps = questions.length;
  const activeStep = Math.min(currentStep, totalSteps - 1);
  const currentQuestion = questions[activeStep];
  const isFirstStep = activeStep === 0;
  const isLastStep = activeStep === totalSteps - 1;

  const getSelectedValues = (question: AskUserQuestion): string[] => {
    return answers[question.id] ?? [];
  };

  const clearAutoAdvance = () => {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = null;
  };

  const handleSelectOption = (question: AskUserQuestion, optionId: string) => {
    clearAutoAdvance();
    setSkippedQuestions(prev => ({ ...prev, [question.id]: false }));
    if (!question.multiSelect) {
      setAnswers(prev => ({
        ...prev,
        [question.id]: [optionId],
      }));
      setOtherInputs(prev => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
      setOtherActive(prev => ({ ...prev, [question.id]: false }));

      setOptionInputs(prev => ({
        ...prev,
        [question.id]: prev[question.id]?.[optionId]
          ? { [optionId]: prev[question.id][optionId] }
          : {},
      }));

      const selectedOption = question.options.find(option => option.id === optionId);
      // Keep the question visible when the selected option requires extra input.
      if (!selectedOption?.input) {
        const scheduledStep = activeStep;
        advanceTimerRef.current = setTimeout(() => {
          advanceTimerRef.current = null;
          setCurrentStep(prevStep =>
            resolveWizardAutoAdvanceStep(prevStep, scheduledStep, questions.length),
          );
        }, 150);
      }
    } else {
      setAnswers(prev => {
        const rawValue = prev[question.id] ?? [];

        if (rawValue.length === 0) {
          return {
            ...prev,
            [question.id]: [optionId],
          };
        }

        const current = new Set(rawValue);

        if (current.has(optionId)) {
          current.delete(optionId);
        } else {
          current.add(optionId);
        }

        if (current.size === 0) {
          const newAnswers = { ...prev };
          delete newAnswers[question.id];
          return newAnswers;
        }

        return {
          ...prev,
          [question.id]: Array.from(current),
        };
      });
    }
  };

  const handleOptionInputChange = (option: AskUserQuestionOption, value: string) => {
    setOptionInputs(prev => ({
      ...prev,
      [currentQuestion.id]: {
        ...(prev[currentQuestion.id] ?? {}),
        [option.id]: value,
      },
    }));
  };

  const handleOtherInputChange = (value: string) => {
    clearAutoAdvance();
    setSkippedQuestions(prev => ({ ...prev, [currentQuestion.id]: false }));
    setOtherInputs(prev => ({
      ...prev,
      [currentQuestion.id]: value,
    }));
    setOtherActive(prev => ({
      ...prev,
      [currentQuestion.id]: true,
    }));
    if (!currentQuestion.multiSelect) {
      setAnswers(prev => {
        const next = { ...prev };
        delete next[currentQuestion.id];
        return next;
      });
    }
  };

  const handleToggleOther = () => {
    clearAutoAdvance();
    setSkippedQuestions(prev => ({ ...prev, [currentQuestion.id]: false }));
    setOtherActive(prev => {
      const nextActive = !prev[currentQuestion.id];
      return {
        ...prev,
        [currentQuestion.id]: nextActive,
      };
    });
    if (!currentQuestion.multiSelect) {
      setAnswers(prev => {
        const next = { ...prev };
        delete next[currentQuestion.id];
        return next;
      });
    }
  };

  const handlePrevious = () => {
    clearAutoAdvance();
    if (!isFirstStep) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const handleNext = () => {
    clearAutoAdvance();
    if (!isLastStep) {
      setCurrentStep(prev => prev + 1);
    }
  };

  const handleSkip = () => {
    clearAutoAdvance();
    const questionId = currentQuestion.id;
    setSkippedQuestions(prev => ({ ...prev, [questionId]: true }));
    setAnswers(prev => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    setOptionInputs(prev => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    setOtherInputs(prev => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    setOtherActive(prev => ({ ...prev, [questionId]: false }));
    if (!isLastStep) setCurrentStep(prev => prev + 1);
  };

  const handleStepSelect = (step: number) => {
    clearAutoAdvance();
    setCurrentStep(step);
  };

  const handleSubmit = () => {
    const finalAnswers: AskUserAnswers = {};
    questions.forEach(question => {
      if (skippedQuestions[question.id]) {
        finalAnswers[question.id] = { selected: [], skipped: true };
        return;
      }
      const selected = getSelectedValues(question);
      const selectedOptionInputs = Object.fromEntries(
        selected
          .map(id => [id, optionInputs[question.id]?.[id]?.trim()] as const)
          .filter((entry): entry is [string, string] => Boolean(entry[1])),
      );
      const other = otherActive[question.id] ? otherInputs[question.id]?.trim() : '';
      finalAnswers[question.id] = {
        selected,
        ...(Object.keys(selectedOptionInputs).length > 0
          ? { optionInputs: selectedOptionInputs }
          : {}),
        ...(other ? { other } : {}),
      };
    });

    onRespond({
      behavior: 'submit',
      updatedInput: {
        ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
        answers: finalAnswers,
      },
    });
  };

  const handleCancel = () => {
    onRespond({
      behavior: 'cancel',
      message: 'Interaction canceled',
    });
  };

  const selectedValues = getSelectedValues(currentQuestion);

  const isQuestionAnswered = (question: AskUserQuestion): boolean =>
    isQuestionAnswerComplete(
      question,
      getSelectedValues(question),
      optionInputs[question.id],
      Boolean(otherActive[question.id]),
      otherInputs[question.id],
    );

  const isQuestionComplete = (question: AskUserQuestion): boolean =>
    Boolean(skippedQuestions[question.id]) || isQuestionAnswered(question);

  const allAnswered = questions.every(isQuestionComplete);

  return (
    <div
      className={
        isFloating
          ? 'flex max-h-[80vh] min-h-0 w-full flex-col'
          : 'fixed inset-0 z-50 flex items-center justify-center modal-backdrop'
      }
    >
      <div
        ref={dialogRef}
        className={
          isFloating
            ? 'flex max-h-[80vh] min-h-0 w-full flex-col overflow-hidden bg-surface'
            : 'modal-content w-full max-w-2xl mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden'
        }
        role="dialog"
        aria-modal={isFloating ? undefined : true}
        aria-labelledby="cowork-question-wizard-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div
          className={`flex items-center gap-3 px-6 py-4 border-b border-border ${
            isFloating ? 'cursor-move touch-none select-none' : ''
          }`}
          data-question-drag-handle={isFloating ? true : undefined}
        >
          <div className="flex-1">
            <h2 id="cowork-question-wizard-title" className="text-lg font-semibold text-foreground">
              {i18nService.t('coworkQuestionWizardTitle')}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            onClick={handleCancel}
            className="p-2 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-surface-raised">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((activeStep + 1) / totalSteps) * 100}%` }}
          />
        </div>

        <div className="px-6 pt-4">
          <AskUserWaitPolicyNotice questions={questions} toolInput={toolInput} />
        </div>

        {/* Content */}
        <div
          className={`px-6 py-6 flex flex-col ${
            isFloating ? 'min-h-0 flex-1 overflow-y-auto' : 'min-h-[300px]'
          }`}
        >
          <div className="flex-1">
            {/* Question header and navigation */}
            <div className="flex flex-col items-start gap-4 mb-4 sm:flex-row sm:justify-between">
              <div className="flex-1">
                {shouldShowQuestionHeader(totalSteps) && currentQuestion.header && (
                  <span className="inline-block text-[11px] uppercase tracking-wide px-2 py-1 rounded-full bg-surface-raised text-secondary mb-3">
                    {currentQuestion.header}
                  </span>
                )}
                {/* Question text */}
                <h3 className="text-base font-medium text-foreground">
                  {currentQuestion.question}
                  <span className="ml-1.5 text-sm font-normal text-secondary">
                    {i18nService.t(
                      currentQuestion.multiSelect
                        ? 'coworkQuestionMultiSelect'
                        : 'coworkQuestionSingleSelect',
                    )}
                  </span>
                </h3>
              </div>

              {/* Step indicators and navigation */}
              <div className="flex w-full items-center justify-center gap-2 sm:w-auto">
                {/* Previous button */}
                {!isFirstStep && (
                  <button
                    onClick={handlePrevious}
                    className="p-1.5 rounded-lg text-foreground hover:bg-surface-raised transition-colors"
                    title={i18nService.t('coworkQuestionWizardPrevious')}
                  >
                    <ChevronLeftIcon className="h-5 w-5" />
                  </button>
                )}

                {/* Step dots */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-1.5 sm:flex-none sm:flex-nowrap">
                  {questions.map((question, index) => {
                    const isActive = index === activeStep;
                    const isAnswered = isQuestionAnswered(question);

                    return (
                      <button
                        key={index}
                        type="button"
                        onClick={() => handleStepSelect(index)}
                        aria-current={isActive ? 'step' : undefined}
                        className={`relative flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium transition-all ${
                          isActive
                            ? 'bg-primary text-white shadow-md'
                            : isAnswered
                              ? 'bg-green-500/20 dark:bg-green-600/20 text-green-700 dark:text-green-400 border border-green-500 dark:border-green-600 hover:scale-105'
                              : 'bg-surface-raised text-secondary hover:bg-primary/20 dark:hover:bg-primary/20 hover:scale-105'
                        }`}
                        title={question.question}
                      >
                        {isAnswered && !isActive ? (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none">
                            <path
                              d="M13 4L6 11L3 8"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : (
                          index + 1
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Next button */}
                {!isLastStep && (
                  <button
                    onClick={handleNext}
                    className="p-1.5 rounded-lg text-foreground hover:bg-surface-raised transition-colors"
                    title={i18nService.t('coworkQuestionWizardNext')}
                  >
                    <ChevronRightIcon className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>

            {/* Options */}
            <div className="space-y-2">
              {currentQuestion.options.map(option => {
                const isSelected = selectedValues.includes(option.id);
                return (
                  <React.Fragment key={option.id}>
                    <button
                      type="button"
                      onClick={() => handleSelectOption(currentQuestion, option.id)}
                      aria-pressed={isSelected}
                      className={`w-full text-left rounded-lg border px-4 py-3 transition-all ${
                        isSelected
                          ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                          : 'border-border text-secondary hover:bg-surface-raised hover:border-primary/50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {currentQuestion.multiSelect ? (
                          <div
                            className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 transition-colors ${
                              isSelected ? 'bg-primary border-primary' : 'border-border'
                            }`}
                          >
                            {isSelected && (
                              <svg
                                className="w-full h-full text-white"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M13 4L6 11L3 8"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </div>
                        ) : (
                          <div
                            className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 transition-colors ${
                              isSelected ? 'border-primary' : 'border-border'
                            }`}
                          >
                            {isSelected && (
                              <div className="w-full h-full rounded-full bg-primary scale-50" />
                            )}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span>{option.label}</span>
                            {currentQuestion.defaultOptionIds?.includes(option.id) && (
                              <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                                {i18nService.t('coworkQuestionDefaultChoice')}
                              </span>
                            )}
                          </div>
                          {option.description && (
                            <div className="text-xs mt-1 opacity-80">{option.description}</div>
                          )}
                        </div>
                      </div>
                    </button>
                    {isSelected && option.input && (
                      <label className="block pl-3 text-xs font-medium text-secondary">
                        {option.input.label}
                        <textarea
                          rows={3}
                          value={optionInputs[currentQuestion.id]?.[option.id] ?? ''}
                          onChange={event => handleOptionInputChange(option, event.target.value)}
                          placeholder={option.input.placeholder}
                          className="mt-1 w-full min-h-20 max-h-40 resize-y px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm font-normal"
                          autoFocus
                        />
                      </label>
                    )}
                  </React.Fragment>
                );
              })}
              <button
                type="button"
                onClick={handleToggleOther}
                aria-pressed={Boolean(otherActive[currentQuestion.id])}
                className={`w-full text-left rounded-lg border px-4 py-3 transition-all ${
                  otherActive[currentQuestion.id]
                    ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                    : 'border-border text-secondary hover:bg-surface-raised hover:border-primary/50'
                }`}
              >
                <div className="flex items-start gap-3">
                  {currentQuestion.multiSelect ? (
                    <div
                      className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 transition-colors ${
                        otherActive[currentQuestion.id]
                          ? 'bg-primary border-primary'
                          : 'border-border'
                      }`}
                    >
                      {otherActive[currentQuestion.id] && (
                        <svg className="w-full h-full text-white" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M13 4L6 11L3 8"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                  ) : (
                    <div
                      className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 transition-colors ${
                        otherActive[currentQuestion.id] ? 'border-primary' : 'border-border'
                      }`}
                    >
                      {otherActive[currentQuestion.id] && (
                        <div className="w-full h-full rounded-full bg-primary scale-50" />
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {i18nService.t('coworkQuestionWizardOther')}
                    </div>
                  </div>
                </div>
              </button>
            </div>

            <div className="mt-4 flex items-start gap-3">
              {otherActive[currentQuestion.id] && (
                <textarea
                  rows={3}
                  value={otherInputs[currentQuestion.id] || ''}
                  onChange={e => handleOtherInputChange(e.target.value)}
                  placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                  className="flex-1 min-h-20 max-h-40 resize-y px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                  autoFocus
                />
              )}
              {questions.length > 1 && (
                <button
                  type="button"
                  onClick={handleSkip}
                  aria-pressed={Boolean(skippedQuestions[currentQuestion.id])}
                  className={`ml-auto px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                    skippedQuestions[currentQuestion.id]
                      ? 'bg-primary/10 text-primary'
                      : 'text-secondary hover:bg-surface-raised'
                  }`}
                >
                  {i18nService.t(
                    skippedQuestions[currentQuestion.id]
                      ? 'coworkQuestionWizardSkipped'
                      : 'coworkQuestionWizardSkip',
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-border bg-surface-raised">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className={`px-5 py-2 text-sm font-medium rounded-lg border shadow-sm transition-colors ${
              allAnswered
                ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                : 'border-border bg-surface text-secondary cursor-not-allowed'
            }`}
            title={!allAnswered ? i18nService.t('coworkQuestionWizardAnswerRequired') : undefined}
          >
            {i18nService.t('coworkQuestionWizardSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoworkQuestionWizard;

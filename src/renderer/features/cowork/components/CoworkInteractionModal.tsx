import { QuestionMarkCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
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
  getQuestionDialogTitle,
  isQuestionAnswerComplete,
  shouldShowQuestionHeader,
} from './askUserInteractionAnswers';
import AskUserWaitPolicyNotice from './AskUserWaitPolicyNotice';
import { useDialogFocusTrap } from './useDialogFocusTrap';

interface CoworkInteractionModalProps {
  interaction: CoworkInteractionRequest;
  onRespond: (result: CoworkInteractionResult) => Promise<boolean>;
  presentation?: CoworkInteractionPresentation;
  isActive?: boolean;
}

const CoworkInteractionModal: React.FC<CoworkInteractionModalProps> = ({
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

  const isQuestionTool = questions.length > 0;

  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [optionInputs, setOptionInputs] = useState<Record<string, Record<string, string>>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Record<string, boolean>>({});
  const [isResponding, setIsResponding] = useState(false);
  const respondingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const isFloating = presentation === 'floating';
  const dialogTitleId = `cowork-interaction-modal-title-${interaction.requestId}`;

  useDialogFocusTrap(
    dialogRef,
    isQuestionTool ? dialogRef : closeButtonRef,
    interaction.requestId,
    !isFloating,
    isActive,
  );

  useEffect(() => {
    setAnswers({});
    setOptionInputs({});
    setOtherInputs({});
    setOtherActive({});
    setSkippedQuestions({});
  }, [isQuestionTool, interaction.requestId, toolInput]);

  const formatToolInput = (input: Record<string, unknown>): string => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  };

  const requestedCommand = useMemo(() => {
    if (!toolInput || typeof toolInput !== 'object') {
      return '';
    }
    const context = (toolInput as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') {
      return '';
    }
    const requestedToolInput = (context as Record<string, unknown>).requestedToolInput;
    if (!requestedToolInput || typeof requestedToolInput !== 'object') {
      return '';
    }
    const command = (requestedToolInput as Record<string, unknown>).command;
    return typeof command === 'string' ? command.trim() : '';
  }, [toolInput]);

  const getSelectedValues = (question: AskUserQuestion): string[] => {
    return answers[question.id] ?? [];
  };

  const getQuestionDomId = (question: AskUserQuestion): string =>
    `ask-user-question-${interaction.requestId}-${question.id}`;

  const handleSelectOption = (question: AskUserQuestion, optionId: string) => {
    setSkippedQuestions(prev => ({ ...prev, [question.id]: false }));
    setAnswers(prev => {
      if (!question.multiSelect) {
        return { ...prev, [question.id]: [optionId] };
      }

      const current = new Set(prev[question.id] ?? []);
      if (current.has(optionId)) {
        current.delete(optionId);
      } else {
        current.add(optionId);
      }

      return {
        ...prev,
        [question.id]: Array.from(current),
      };
    });
    if (!question.multiSelect) {
      setOptionInputs(prev => ({
        ...prev,
        [question.id]: prev[question.id]?.[optionId]
          ? { [optionId]: prev[question.id][optionId] }
          : {},
      }));
      setOtherInputs(prev => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
      setOtherActive(prev => ({ ...prev, [question.id]: false }));
    }
  };

  const handleToggleOther = (question: AskUserQuestion) => {
    setSkippedQuestions(prev => ({ ...prev, [question.id]: false }));
    setOtherActive(prev => ({
      ...prev,
      [question.id]: !prev[question.id],
    }));
    if (!question.multiSelect) {
      setAnswers(prev => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
    }
  };

  const handleOtherInputChange = (question: AskUserQuestion, value: string) => {
    setSkippedQuestions(prev => ({ ...prev, [question.id]: false }));
    setOtherInputs(prev => ({ ...prev, [question.id]: value }));
    setOtherActive(prev => ({ ...prev, [question.id]: true }));
    if (!question.multiSelect) {
      setAnswers(prev => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
    }
  };

  const handleOptionInputChange = (
    question: AskUserQuestion,
    option: AskUserQuestionOption,
    value: string,
  ) => {
    setSkippedQuestions(prev => ({ ...prev, [question.id]: false }));
    setOptionInputs(prev => ({
      ...prev,
      [question.id]: {
        ...(prev[question.id] ?? {}),
        [option.id]: value,
      },
    }));
  };

  const handleSkipQuestion = (questionId: string) => {
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
  };

  const buildFinalAnswers = (): AskUserAnswers => {
    const finalAnswers: AskUserAnswers = {};
    questions.forEach(question => {
      if (skippedQuestions[question.id]) {
        finalAnswers[question.id] = { selected: [], skipped: true };
        return;
      }
      const selected = getSelectedValues(question);
      const otherValue = otherInputs[question.id]?.trim();
      const selectedOptionInputs = Object.fromEntries(
        selected
          .map(id => [id, optionInputs[question.id]?.[id]?.trim()] as const)
          .filter((entry): entry is [string, string] => Boolean(entry[1])),
      );
      finalAnswers[question.id] = {
        selected,
        ...(Object.keys(selectedOptionInputs).length > 0
          ? { optionInputs: selectedOptionInputs }
          : {}),
        ...(otherActive[question.id] && otherValue ? { other: otherValue } : {}),
      };
    });
    return finalAnswers;
  };

  const isQuestionComplete = (question: AskUserQuestion): boolean => {
    return (
      Boolean(skippedQuestions[question.id]) ||
      isQuestionAnswerComplete(
        question,
        getSelectedValues(question),
        optionInputs[question.id],
        Boolean(otherActive[question.id]),
        otherInputs[question.id],
      )
    );
  };

  const isComplete = isQuestionTool ? questions.every(isQuestionComplete) : true;

  const cancelButtonLabel = isQuestionTool
    ? i18nService.t('coworkCancelRequest')
    : i18nService.t('coworkCancel');
  const submitButtonLabel = isQuestionTool
    ? i18nService.t('coworkSubmitSelection')
    : i18nService.t('coworkSubmit');

  const respond = async (result: CoworkInteractionResult): Promise<void> => {
    if (respondingRef.current) return;
    respondingRef.current = true;
    setIsResponding(true);
    try {
      const succeeded = await onRespond(result);
      if (succeeded) return;
    } catch {
      // App owns user-visible error reporting; keep the dialog retryable here.
    }
    respondingRef.current = false;
    setIsResponding(false);
  };

  const handleSubmit = () => {
    if (isQuestionTool) {
      if (!isComplete) return;
      void respond({
        behavior: 'submit',
        updatedInput: {
          ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
          answers: buildFinalAnswers(),
        },
      });
      return;
    }

    void respond({
      behavior: 'submit',
      updatedInput: toolInput && typeof toolInput === 'object' ? toolInput : {},
    });
  };

  const handleCancel = () => {
    void respond({
      behavior: 'cancel',
      message: 'Interaction canceled',
    });
  };

  const canRespond = isComplete;
  const questionDialogTitle = getQuestionDialogTitle(
    questions,
    i18nService.t('coworkSelectionRequired'),
  );

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
            ? 'flex max-h-[80vh] min-h-0 w-full flex-col overflow-hidden bg-surface focus:outline-none'
            : 'modal-content w-full max-w-lg mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden focus:outline-none'
        }
        role="dialog"
        aria-modal={isFloating ? undefined : true}
        aria-labelledby={dialogTitleId}
        aria-busy={isResponding}
        tabIndex={-1}
      >
        {/* Header */}
        <div
          className={`flex items-center gap-3 px-6 py-4 border-b border-border ${
            isFloating ? 'cursor-move touch-none select-none' : ''
          }`}
          data-question-drag-handle={isFloating ? true : undefined}
        >
          <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
            <QuestionMarkCircleIcon className="h-6 w-6 text-blue-600 dark:text-blue-500" />
          </div>
          <div className="flex-1">
            <h2 id={dialogTitleId} className="text-lg font-semibold text-foreground">
              {isQuestionTool ? questionDialogTitle : i18nService.t('coworkInteractionRequired')}
            </h2>
            <p className="text-sm text-secondary">
              {isQuestionTool
                ? i18nService.t('coworkSelectionDescription')
                : i18nService.t('coworkInteractionDescription')}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={handleCancel}
            disabled={isResponding}
            className="p-2 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div
          className={`px-6 py-4 space-y-4 overflow-y-auto ${
            isFloating ? 'min-h-0 flex-1' : 'max-h-[60vh]'
          }`}
        >
          {isQuestionTool && (
            <AskUserWaitPolicyNotice questions={questions} toolInput={toolInput} />
          )}
          {isQuestionTool ? (
            <>
              {questions.map(question => {
                const selectedValues = getSelectedValues(question);
                return (
                  <div key={question.id} className="rounded-xl border border-border p-4 space-y-3">
                    {/* 问题 */}
                    <div
                      id={getQuestionDomId(question)}
                      className="text-sm font-medium text-foreground"
                    >
                      {shouldShowQuestionHeader(questions.length) && question.header && (
                        <span className="inline-block text-[11px] uppercase tracking-wide px-2 py-0.5 mr-1.5 rounded-full bg-surface-raised text-secondary align-middle">
                          {question.header}
                        </span>
                      )}
                      {question.question}
                      <span className="ml-1.5 text-xs font-normal text-secondary">
                        {i18nService.t(
                          question.multiSelect
                            ? 'coworkQuestionMultiSelect'
                            : 'coworkQuestionSingleSelect',
                        )}
                      </span>
                    </div>
                    {questions.length > 1 && (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleSkipQuestion(question.id)}
                          disabled={isResponding}
                          aria-pressed={Boolean(skippedQuestions[question.id])}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                            skippedQuestions[question.id]
                              ? 'bg-primary/10 text-primary'
                              : 'text-secondary hover:bg-surface-raised'
                          }`}
                        >
                          {i18nService.t(
                            skippedQuestions[question.id]
                              ? 'coworkQuestionWizardSkipped'
                              : 'coworkQuestionWizardSkip',
                          )}
                        </button>
                      </div>
                    )}
                    {/* 命令详情 */}
                    {requestedCommand && (
                      <div>
                        <label className="block text-xs font-medium text-secondary uppercase tracking-wider mb-1">
                          {i18nService.t('coworkToolInput')}
                        </label>
                        <div className="px-3 py-2 rounded-lg bg-background max-h-40 overflow-y-auto">
                          <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                            {requestedCommand}
                          </pre>
                        </div>
                      </div>
                    )}
                    {/* 选项 */}
                    <div
                      className="space-y-2"
                      role={question.multiSelect ? 'group' : 'radiogroup'}
                      aria-labelledby={getQuestionDomId(question)}
                    >
                      {question.options.map(option => {
                        const isSelected = selectedValues.includes(option.id);
                        return (
                          <React.Fragment key={option.id}>
                            <label
                              className={`block w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors focus-within:ring-2 focus-within:ring-primary/50 ${
                                isSelected
                                  ? 'border-primary bg-primary/10 text-foreground'
                                  : 'border-border text-secondary hover:bg-surface-raised'
                              }`}
                            >
                              <input
                                type={question.multiSelect ? 'checkbox' : 'radio'}
                                name={getQuestionDomId(question)}
                                value={option.id}
                                checked={isSelected}
                                disabled={isResponding}
                                onChange={() => handleSelectOption(question, option.id)}
                                className="sr-only"
                              />
                              <div className="flex items-start gap-3">
                                <span
                                  aria-hidden="true"
                                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 ${
                                    question.multiSelect ? 'rounded' : 'rounded-full'
                                  } ${isSelected ? 'border-primary' : 'border-border'} ${
                                    question.multiSelect && isSelected ? 'bg-primary' : ''
                                  }`}
                                >
                                  {isSelected &&
                                    (question.multiSelect ? (
                                      <span className="text-[10px] leading-none text-white">✓</span>
                                    ) : (
                                      <span className="h-2 w-2 rounded-full bg-primary" />
                                    ))}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-2 text-sm font-medium">
                                    <span>{option.label}</span>
                                    {question.defaultOptionIds?.includes(option.id) && (
                                      <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                                        {i18nService.t('coworkQuestionDefaultChoice')}
                                      </span>
                                    )}
                                  </span>
                                  {option.description && (
                                    <span className="mt-1 block text-xs opacity-80">
                                      {option.description}
                                    </span>
                                  )}
                                </span>
                              </div>
                            </label>
                            {isSelected && option.input && (
                              <label className="block pl-3 text-xs font-medium text-secondary">
                                {option.input.label}
                                <textarea
                                  rows={3}
                                  value={optionInputs[question.id]?.[option.id] ?? ''}
                                  disabled={isResponding}
                                  onChange={event =>
                                    handleOptionInputChange(question, option, event.target.value)
                                  }
                                  placeholder={option.input.placeholder}
                                  className="mt-1 w-full min-h-20 max-h-40 resize-y px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm font-normal"
                                  autoFocus
                                />
                              </label>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {question.allowOther !== false && (
                        <>
                          <label
                            className={`block w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors focus-within:ring-2 focus-within:ring-primary/50 ${
                              otherActive[question.id]
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'border-border text-secondary hover:bg-surface-raised'
                            }`}
                          >
                            <input
                              type={question.multiSelect ? 'checkbox' : 'radio'}
                              name={getQuestionDomId(question)}
                              checked={Boolean(otherActive[question.id])}
                              disabled={isResponding}
                              onChange={() => handleToggleOther(question)}
                              className="sr-only"
                            />
                            <div className="flex items-center gap-3">
                              <span
                                aria-hidden="true"
                                className={`flex h-4 w-4 shrink-0 items-center justify-center border-2 ${
                                  question.multiSelect ? 'rounded' : 'rounded-full'
                                } ${
                                  otherActive[question.id] ? 'border-primary' : 'border-border'
                                } ${
                                  question.multiSelect && otherActive[question.id]
                                    ? 'bg-primary'
                                    : ''
                                }`}
                              >
                                {otherActive[question.id] &&
                                  (question.multiSelect ? (
                                    <span className="text-[10px] leading-none text-white">✓</span>
                                  ) : (
                                    <span className="h-2 w-2 rounded-full bg-primary" />
                                  ))}
                              </span>
                              <span className="text-sm font-medium">
                                {i18nService.t('coworkQuestionWizardOther')}
                              </span>
                            </div>
                          </label>
                          {otherActive[question.id] && (
                            <textarea
                              rows={3}
                              value={otherInputs[question.id] || ''}
                              disabled={isResponding}
                              onChange={event =>
                                handleOtherInputChange(question, event.target.value)
                              }
                              placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                              className="w-full min-h-20 max-h-40 resize-y px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                              autoFocus
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <>
              {/* Tool name */}
              <div>
                <label className="block text-xs font-medium text-secondary uppercase tracking-wider mb-1">
                  {i18nService.t('coworkToolName')}
                </label>
                <div className="px-3 py-2 rounded-lg bg-background">
                  <code className="text-sm text-foreground">{interaction.toolName}</code>
                </div>
              </div>

              {/* Tool input */}
              <div>
                <label className="block text-xs font-medium text-secondary uppercase tracking-wider mb-1">
                  {i18nService.t('coworkToolInput')}
                </label>
                <div className="px-3 py-2 rounded-lg bg-background">
                  <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                    {formatToolInput(interaction.toolInput)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
          <button
            onClick={handleCancel}
            disabled={isResponding}
            className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {cancelButtonLabel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canRespond || isResponding}
            className={`px-4 py-2 text-sm font-medium rounded-lg border shadow-sm transition-colors ${
              canRespond && !isResponding
                ? 'border-primary bg-primary text-white hover:bg-primary-hover'
                : 'border-border bg-surface text-secondary cursor-not-allowed'
            }`}
          >
            {submitButtonLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoworkInteractionModal;

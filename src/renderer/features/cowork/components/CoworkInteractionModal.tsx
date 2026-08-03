import { QuestionMarkCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type {
  AskUserAnswers,
  AskUserQuestion,
  AskUserQuestionOption,
} from '@shared/openclaw/extensions';
import {
  CoworkInteractionKind,
  parseAskUserQuestions,
} from '@shared/openclaw/extensions';
import React, { useEffect, useMemo, useState } from 'react';

import type { CoworkInteractionRequest, CoworkInteractionResult } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

import { buildOtherAnswers, buildSingleOptionAnswers } from './askUserInteractionAnswers';

interface CoworkInteractionModalProps {
  interaction: CoworkInteractionRequest;
  onRespond: (result: CoworkInteractionResult) => void;
}

const resolveBinaryQuestionButtons = (question: AskUserQuestion): { primary: AskUserQuestionOption; secondary: AskUserQuestionOption } => {
  const [firstOption, secondOption] = question.options;
  if (!firstOption || !secondOption) {
    throw new Error('Binary question requires exactly two options.');
  }
  return { primary: firstOption, secondary: secondOption };
};

const CoworkInteractionModal: React.FC<CoworkInteractionModalProps> = ({
  interaction,
  onRespond,
}) => {
  const toolInput = useMemo(() => interaction.toolInput ?? {}, [interaction.toolInput]);

  const questions = useMemo<AskUserQuestion[]>(() => {
    if (interaction.interactionKind !== CoworkInteractionKind.STRUCTURED_QUESTION) return [];
    if (!toolInput || typeof toolInput !== 'object') return [];
    return parseAskUserQuestions((toolInput as Record<string, unknown>).questions) ?? [];
  }, [interaction.interactionKind, toolInput]);

  const isQuestionTool = questions.length > 0;

  // Render a single two-option question as a compact dialog.
  const isBinaryQuestion = isQuestionTool
    && questions.length === 1
    && questions[0].options.length === 2
    && !questions[0].multiSelect
    && questions[0].options.every(option => !option.input);

  const binaryQuestionButtons = useMemo(() => {
    if (!isBinaryQuestion) return null;
    return resolveBinaryQuestionButtons(questions[0]);
  }, [isBinaryQuestion, questions]);

  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [optionInputs, setOptionInputs] = useState<Record<string, Record<string, string>>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setAnswers({});
    setOtherInputs({});
    setOtherActive({});
    setOptionInputs({});
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

  const buildQuestionAnswerResult = (question: string, answer: string): CoworkInteractionResult => {
    return {
      behavior: 'submit',
      updatedInput: {
        ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
        answers: buildSingleOptionAnswers(question, answer),
      },
    };
  };

  const buildOtherAnswerResult = (questionId: string, other: string): CoworkInteractionResult => ({
    behavior: 'submit',
    updatedInput: {
      ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
      answers: buildOtherAnswers(questionId, other),
    },
  });

  const getSelectedValues = (question: AskUserQuestion): string[] => {
    return answers[question.id] ?? [];
  };

  const handleSelectOption = (question: AskUserQuestion, optionId: string) => {
    setAnswers((prev) => {
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
      setOptionInputs((prev) => ({
        ...prev,
        [question.id]: prev[question.id]?.[optionId]
          ? { [optionId]: prev[question.id][optionId] }
          : {},
      }));
      setOtherInputs((prev) => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
      setOtherActive((prev) => ({ ...prev, [question.id]: false }));
    }
  };

  const handleToggleOther = (question: AskUserQuestion) => {
    setOtherActive((prev) => ({
      ...prev,
      [question.id]: !prev[question.id],
    }));
    if (!question.multiSelect) {
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
    }
  };

  const handleOtherInputChange = (question: AskUserQuestion, value: string) => {
    setOtherInputs((prev) => ({ ...prev, [question.id]: value }));
    setOtherActive((prev) => ({ ...prev, [question.id]: true }));
    if (!question.multiSelect) {
      setAnswers((prev) => {
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
    setOptionInputs((prev) => ({
      ...prev,
      [question.id]: {
        ...(prev[question.id] ?? {}),
        [option.id]: value,
      },
    }));
  };

  const buildFinalAnswers = (): AskUserAnswers => {
    const finalAnswers: AskUserAnswers = {};
    questions.forEach((question) => {
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
    const selected = getSelectedValues(question);
    const hasOther = Boolean(
      otherActive[question.id] && otherInputs[question.id]?.trim(),
    );
    if (selected.length === 0 && !hasOther) return false;
    return selected.every((id) => {
      const option = question.options.find(candidate => candidate.id === id);
      if (!option?.input) return true;
      return Boolean(optionInputs[question.id]?.[id]?.trim());
    });
  };

  const isComplete = isQuestionTool && !isBinaryQuestion
    ? questions.every(isQuestionComplete)
    : true;

  const cancelButtonLabel = isQuestionTool && !isBinaryQuestion
    ? i18nService.t('coworkCancelRequest')
    : i18nService.t('coworkCancel');
  const submitButtonLabel = isQuestionTool && !isBinaryQuestion
    ? i18nService.t('coworkSubmitSelection')
    : i18nService.t('coworkSubmit');

  const handleBinaryOptionSelect = (optionId: string) => {
    if (!isBinaryQuestion) return;
    onRespond(buildQuestionAnswerResult(questions[0].id, optionId));
  };

  const handleSubmit = () => {
    if (isBinaryQuestion) {
      const question = questions[0];
      const otherValue = otherInputs[question.id]?.trim();
      if (otherActive[question.id]) {
        if (!otherValue) return;
        onRespond(buildOtherAnswerResult(question.id, otherValue));
        return;
      }
      handleBinaryOptionSelect(binaryQuestionButtons?.primary.id ?? questions[0].options[0].id);
      return;
    }

    if (isQuestionTool) {
      if (!isComplete) return;
      onRespond({
        behavior: 'submit',
        updatedInput: {
          ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
          answers: buildFinalAnswers(),
        },
      });
      return;
    }

    onRespond({
      behavior: 'submit',
      updatedInput: toolInput && typeof toolInput === 'object' ? toolInput : {},
    });
  };

  const handleCancel = () => {
    onRespond({
      behavior: 'cancel',
      message: 'Interaction canceled',
    });
  };

  const isBinaryOtherActive = isBinaryQuestion && Boolean(otherActive[questions[0].id]);
  const canSubmit = !isBinaryOtherActive || Boolean(otherInputs[questions[0].id]?.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-lg mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
            <QuestionMarkCircleIcon className="h-6 w-6 text-blue-600 dark:text-blue-500" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-foreground">
              {isQuestionTool && !isBinaryQuestion
                ? i18nService.t('coworkSelectionRequired')
                : i18nService.t('coworkInteractionRequired')}
            </h2>
            <p className="text-sm text-secondary">
              {isQuestionTool && !isBinaryQuestion
                ? i18nService.t('coworkSelectionDescription')
                : i18nService.t('coworkInteractionDescription')}
            </p>
          </div>
          <button
            onClick={handleCancel}
            className="p-2 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {isBinaryQuestion ? (
            <div className="px-3 py-2 rounded-lg bg-background">
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {questions[0].question}
              </p>
              {requestedCommand && (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-secondary uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolInput')}
                  </label>
                  <div className="px-3 py-2 rounded-lg bg-surface max-h-40 overflow-y-auto">
                    <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                      {requestedCommand}
                    </pre>
                  </div>
                </div>
              )}
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => handleToggleOther(questions[0])}
                  className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                    otherActive[questions[0].id]
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-secondary hover:bg-surface-raised'
                  }`}
                >
                  <div className="text-sm font-medium">
                    {i18nService.t('coworkQuestionWizardOther')}
                  </div>
                </button>
                {otherActive[questions[0].id] && (
                  <textarea
                    rows={3}
                    value={otherInputs[questions[0].id] || ''}
                    onChange={(event) => handleOtherInputChange(questions[0], event.target.value)}
                    placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                    className="mt-2 w-full min-h-20 max-h-40 resize-y px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                    autoFocus
                  />
                )}
              </div>
            </div>
          ) : isQuestionTool ? (
            <>
              {questions.map((question) => {
                const selectedValues = getSelectedValues(question);
                return (
                  <div
                    key={question.id}
                    className="rounded-xl border border-border p-4 space-y-3"
                  >
                    {/* 问题 */}
                    <div className="text-sm font-medium text-foreground">
                      {question.header && (
                        <span className="inline-block text-[11px] uppercase tracking-wide px-2 py-0.5 mr-1.5 rounded-full bg-surface-raised text-secondary align-middle">
                          {question.header}
                        </span>
                      )}
                      {question.question}
                    </div>
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
                    <div className="space-y-2">
                      {question.options.map((option) => {
                        const isSelected = selectedValues.includes(option.id);
                        return (
                          <React.Fragment key={option.id}>
                            <button
                              type="button"
                              onClick={() => handleSelectOption(question, option.id)}
                              className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                                isSelected
                                  ? 'border-primary bg-primary/10 text-foreground'
                                  : 'border-border text-secondary hover:bg-surface-raised'
                              }`}
                            >
                              <div className="text-sm font-medium">{option.label}</div>
                              {option.description && (
                                <div className="text-xs mt-1 opacity-80">{option.description}</div>
                              )}
                            </button>
                            {isSelected && option.input && (
                              <label className="block pl-3 text-xs font-medium text-secondary">
                                {option.input.label}
                                <textarea
                                  rows={3}
                                  value={optionInputs[question.id]?.[option.id] ?? ''}
                                  onChange={(event) => handleOptionInputChange(question, option, event.target.value)}
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
                        onClick={() => handleToggleOther(question)}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          otherActive[question.id]
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border text-secondary hover:bg-surface-raised'
                        }`}
                      >
                        <div className="text-sm font-medium">
                          {i18nService.t('coworkQuestionWizardOther')}
                        </div>
                      </button>
                      {otherActive[question.id] && (
                        <textarea
                          rows={3}
                          value={otherInputs[question.id] || ''}
                          onChange={(event) => handleOtherInputChange(question, event.target.value)}
                          placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                          className="w-full min-h-20 max-h-40 resize-y px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                          autoFocus
                        />
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
                  <code className="text-sm text-foreground">
                    {interaction.toolName}
                  </code>
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
            onClick={isBinaryQuestion && binaryQuestionButtons ? () => handleBinaryOptionSelect(binaryQuestionButtons.secondary.id) : handleCancel}
            className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {isBinaryQuestion && binaryQuestionButtons ? binaryQuestionButtons.secondary.label : cancelButtonLabel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isComplete || !canSubmit}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary hover:bg-primary-hover text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isBinaryOtherActive
              ? i18nService.t('coworkSubmitSelection')
              : isBinaryQuestion && binaryQuestionButtons
              ? binaryQuestionButtons.primary.label
              : submitButtonLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoworkInteractionModal;

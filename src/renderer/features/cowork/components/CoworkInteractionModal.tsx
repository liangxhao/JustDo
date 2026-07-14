import { QuestionMarkCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { CoworkInteractionKind } from '@shared/openclaw/extensions';
import React, { useEffect, useMemo, useState } from 'react';

import type { CoworkInteractionRequest, CoworkInteractionResult } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

interface CoworkInteractionModalProps {
  interaction: CoworkInteractionRequest;
  onRespond: (result: CoworkInteractionResult) => void;
}

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

const resolveBinaryQuestionButtons = (question: QuestionItem): { primary: QuestionOption; secondary: QuestionOption } => {
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

  const questions = useMemo<QuestionItem[]>(() => {
    if (interaction.interactionKind !== CoworkInteractionKind.STRUCTURED_QUESTION) return [];
    if (!toolInput || typeof toolInput !== 'object') return [];
    const rawQuestions = (toolInput as Record<string, unknown>).questions;
    if (!Array.isArray(rawQuestions)) return [];

    return rawQuestions
      .map((question) => {
        if (!question || typeof question !== 'object') return null;
        const record = question as Record<string, unknown>;
        const options = Array.isArray(record.options)
          ? record.options
              .map((option) => {
                if (!option || typeof option !== 'object') return null;
                const optionRecord = option as Record<string, unknown>;
                if (typeof optionRecord.label !== 'string') return null;
                return {
                  label: optionRecord.label,
                  description: typeof optionRecord.description === 'string'
                    ? optionRecord.description
                    : undefined,
                } as QuestionOption;
              })
              .filter(Boolean) as QuestionOption[]
          : [];

        if (typeof record.question !== 'string' || options.length === 0) {
          return null;
        }

        return {
          question: record.question,
          header: typeof record.header === 'string' ? record.header : undefined,
          options,
          multiSelect: Boolean(record.multiSelect),
        } as QuestionItem;
      })
      .filter(Boolean) as QuestionItem[];
  }, [interaction.interactionKind, toolInput]);

  const isQuestionTool = questions.length > 0;

  // Render a single two-option question as a compact dialog.
  const isBinaryQuestion = isQuestionTool
    && questions.length === 1
    && questions[0].options.length === 2
    && !questions[0].multiSelect;

  const binaryQuestionButtons = useMemo(() => {
    if (!isBinaryQuestion) return null;
    return resolveBinaryQuestionButtons(questions[0]);
  }, [isBinaryQuestion, questions]);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isQuestionTool) {
      setAnswers({});
      return;
    }

    const rawAnswers = (toolInput as Record<string, unknown>).answers;
    if (rawAnswers && typeof rawAnswers === 'object') {
      const initial: Record<string, string> = {};
      Object.entries(rawAnswers as Record<string, unknown>).forEach(([key, value]) => {
        if (typeof value === 'string') {
          initial[key] = value;
        }
      });
      setAnswers(initial);
    } else {
      setAnswers({});
    }
    setOtherInputs({});
    setOtherActive({});
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
        answers: { [question]: answer },
      },
    };
  };

  const getSelectedValues = (question: QuestionItem): string[] => {
    const rawValue = answers[question.question] ?? '';
    if (!rawValue) return [];
    if (!question.multiSelect) return [rawValue];
    return rawValue
      .split('|||')
      .map((value) => value.trim())
      .filter(Boolean);
  };

  const handleSelectOption = (question: QuestionItem, optionLabel: string) => {
    setAnswers((prev) => {
      if (!question.multiSelect) {
        return { ...prev, [question.question]: optionLabel };
      }

      const rawValue = prev[question.question] ?? '';
      const current = new Set(
        rawValue
          .split('|||')
          .map((value) => value.trim())
          .filter(Boolean)
      );
      if (current.has(optionLabel)) {
        current.delete(optionLabel);
      } else {
        current.add(optionLabel);
      }

      return {
        ...prev,
        [question.question]: Array.from(current).join('|||'),
      };
    });
    if (!question.multiSelect) {
      setOtherInputs((prev) => {
        const next = { ...prev };
        delete next[question.question];
        return next;
      });
      setOtherActive((prev) => ({ ...prev, [question.question]: false }));
    }
  };

  const handleToggleOther = (question: QuestionItem) => {
    setOtherActive((prev) => ({
      ...prev,
      [question.question]: !prev[question.question],
    }));
    if (!question.multiSelect) {
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[question.question];
        return next;
      });
    }
  };

  const handleOtherInputChange = (question: QuestionItem, value: string) => {
    setOtherInputs((prev) => ({ ...prev, [question.question]: value }));
    setOtherActive((prev) => ({ ...prev, [question.question]: true }));
    if (!question.multiSelect) {
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[question.question];
        return next;
      });
    }
  };

  const buildFinalAnswers = (): Record<string, string> => {
    const finalAnswers = { ...answers };
    questions.forEach((question) => {
      const otherValue = otherInputs[question.question]?.trim();
      if (!otherActive[question.question] || !otherValue) return;
      if (question.multiSelect) {
        const existingAnswers = finalAnswers[question.question]
          ?.split('|||')
          .map(answer => answer.trim())
          .filter(Boolean) ?? [];
        finalAnswers[question.question] = [...existingAnswers, otherValue].join('|||');
      } else {
        finalAnswers[question.question] = otherValue;
      }
    });
    return finalAnswers;
  };

  const isComplete = isQuestionTool && !isBinaryQuestion
    ? questions.every((question) => (buildFinalAnswers()[question.question] ?? '').trim())
    : true;

  const cancelButtonLabel = isQuestionTool && !isBinaryQuestion
    ? i18nService.t('coworkCancelRequest')
    : i18nService.t('coworkCancel');
  const submitButtonLabel = isQuestionTool && !isBinaryQuestion
    ? i18nService.t('coworkSubmitSelection')
    : i18nService.t('coworkSubmit');

  const handleBinaryOptionSelect = (optionLabel: string) => {
    if (!isBinaryQuestion) return;
    onRespond(buildQuestionAnswerResult(questions[0].question, optionLabel));
  };

  const handleSubmit = () => {
    if (isBinaryQuestion) {
      const question = questions[0];
      const otherValue = otherInputs[question.question]?.trim();
      if (otherActive[question.question]) {
        if (!otherValue) return;
        handleBinaryOptionSelect(otherValue);
        return;
      }
      handleBinaryOptionSelect(binaryQuestionButtons?.primary.label ?? questions[0].options[0].label);
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

  const isBinaryOtherActive = isBinaryQuestion && Boolean(otherActive[questions[0].question]);
  const canSubmit = !isBinaryOtherActive || Boolean(otherInputs[questions[0].question]?.trim());

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
                    otherActive[questions[0].question]
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-secondary hover:bg-surface-raised'
                  }`}
                >
                  <div className="text-sm font-medium">
                    {i18nService.t('coworkQuestionWizardOther')}
                  </div>
                </button>
                {otherActive[questions[0].question] && (
                  <input
                    type="text"
                    value={otherInputs[questions[0].question] || ''}
                    onChange={(event) => handleOtherInputChange(questions[0], event.target.value)}
                    placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                    className="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
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
                    key={question.question}
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
                        const isSelected = selectedValues.includes(option.label);
                        return (
                          <button
                            key={option.label}
                            type="button"
                            onClick={() => handleSelectOption(question, option.label)}
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
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => handleToggleOther(question)}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          otherActive[question.question]
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border text-secondary hover:bg-surface-raised'
                        }`}
                      >
                        <div className="text-sm font-medium">
                          {i18nService.t('coworkQuestionWizardOther')}
                        </div>
                      </button>
                      {otherActive[question.question] && (
                        <input
                          type="text"
                          value={otherInputs[question.question] || ''}
                          onChange={(event) => handleOtherInputChange(question, event.target.value)}
                          placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
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
            onClick={isBinaryQuestion && binaryQuestionButtons ? () => handleBinaryOptionSelect(binaryQuestionButtons.secondary.label) : handleCancel}
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

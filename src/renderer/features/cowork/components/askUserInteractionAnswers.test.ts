import { describe, expect, test } from 'vitest';

import {
  getQuestionDialogTitle,
  isQuestionAnswerComplete,
  resolveWizardAutoAdvanceStep,
  shouldShowQuestionHeader,
} from './askUserInteractionAnswers';

describe('ask-user interaction answer builders', () => {
  test('does not auto-advance after the user has moved to another step', () => {
    expect(resolveWizardAutoAdvanceStep(2, 0, 4)).toBe(2);
    expect(resolveWizardAutoAdvanceStep(0, 0, 4)).toBe(1);
    expect(resolveWizardAutoAdvanceStep(3, 3, 4)).toBe(3);
  });

  test('requires selected option inputs before marking a question complete', () => {
    const question = {
      id: 'environment',
      question: 'Which environment?',
      options: [
        { id: 'custom', label: 'Custom', input: { label: 'Environment name' } },
        { id: 'production', label: 'Production' },
      ],
    };

    expect(isQuestionAnswerComplete(question, ['custom'], undefined, false, undefined)).toBe(false);
    expect(isQuestionAnswerComplete(question, ['custom'], { custom: '  ' }, false, undefined)).toBe(
      false,
    );
    expect(
      isQuestionAnswerComplete(question, ['custom'], { custom: 'staging' }, false, undefined),
    ).toBe(true);
    expect(isQuestionAnswerComplete(question, [], undefined, true, 'Other environment')).toBe(true);
  });

  test('requires active other input even when a regular option is selected', () => {
    const question = {
      id: 'targets',
      question: 'Which targets?',
      multiSelect: true,
      options: [
        { id: 'desktop', label: 'Desktop' },
        { id: 'mobile', label: 'Mobile' },
      ],
    };

    expect(isQuestionAnswerComplete(question, ['desktop'], undefined, true, '  ')).toBe(false);
    expect(isQuestionAnswerComplete(question, ['desktop'], undefined, true, 'Tablet')).toBe(true);
  });
});

describe('getQuestionDialogTitle', () => {
  const question = {
    id: 'confirm',
    question: 'Continue?',
    header: 'Design review',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
  };

  test('uses the header as the title for a single question', () => {
    expect(getQuestionDialogTitle([question], 'Please choose')).toBe('Design review');
  });

  test('uses the generic title for multiple questions', () => {
    expect(
      getQuestionDialogTitle([question, { ...question, id: 'confirm_again' }], 'Please choose'),
    ).toBe('Please choose');
  });
});

describe('shouldShowQuestionHeader', () => {
  test('hides step-like headers for a single question', () => {
    expect(shouldShowQuestionHeader(1)).toBe(false);
  });

  test('keeps headers when they distinguish multiple questions', () => {
    expect(shouldShowQuestionHeader(2)).toBe(true);
  });
});

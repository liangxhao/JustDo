import { describe, expect, test } from 'vitest';

import {
  buildOtherAnswers,
  buildSingleOptionAnswers,
  isQuestionAnswerComplete,
  resolveWizardAutoAdvanceStep,
} from './askUserInteractionAnswers';

describe('ask-user interaction answer builders', () => {
  test('keeps a binary option id in selected', () => {
    expect(buildSingleOptionAnswers('confirm', 'allow')).toEqual({
      confirm: { selected: ['allow'] },
    });
  });

  test('keeps binary free text in other instead of selected', () => {
    expect(buildOtherAnswers('confirm', 'Use the staging environment')).toEqual({
      confirm: { selected: [], other: 'Use the staging environment' },
    });
  });

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
    expect(isQuestionAnswerComplete(question, ['custom'], { custom: '  ' }, false, undefined)).toBe(false);
    expect(isQuestionAnswerComplete(question, ['custom'], { custom: 'staging' }, false, undefined)).toBe(true);
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

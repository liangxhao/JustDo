import { describe, expect, test } from 'vitest';

import {
  buildOtherAnswers,
  buildSingleOptionAnswers,
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
});

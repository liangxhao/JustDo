import type { NativeAppQuestion } from '@shared/plugins/mcpApps';
import { describe, expect, it } from 'vitest';

import { freeQuestionAnswers, mergeFreeQuestionAnswers } from './questionAnswers';

const field: NativeAppQuestion['questions'][number] = {
  questionId: 'choice',
  header: '',
  question: '',
  options: [
    { label: 'First', value: 'a' },
    { label: 'Second', value: 'b' },
  ],
  multiSelect: true,
  isOther: true,
};
describe('native question option and custom answer composition', () => {
  it('keeps checked choices while editing and clearing Other', () => {
    expect(freeQuestionAnswers(field, ['a', 'custom'])).toEqual(['custom']);
    expect(mergeFreeQuestionAnswers(field, ['a', 'b', 'custom'], ['new'])).toEqual([
      'a',
      'b',
      'new',
    ]);
    expect(mergeFreeQuestionAnswers(field, ['a', 'custom'], [''])).toEqual(['a']);
  });
  it('keeps radio options and a custom answer mutually exclusive', () => {
    expect(mergeFreeQuestionAnswers({ ...field, multiSelect: false }, ['a'], ['custom'])).toEqual([
      'custom',
    ]);
    expect(mergeFreeQuestionAnswers({ ...field, multiSelect: false }, ['a'], [''])).toEqual(['a']);
  });
  it('preserves exact free text and secret whitespace', () => {
    expect(
      mergeFreeQuestionAnswers({ ...field, options: [], isSecret: true }, [], ['  secret  ']),
    ).toEqual(['  secret  ']);
  });
});

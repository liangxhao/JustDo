import { describe, expect, test } from 'vitest';

import {
  AskUserQuestionSchema,
  MAX_ASK_USER_QUESTIONS,
  parseQuestions,
} from '../../../../openclaw-extensions/ask-user-question/index';

const makeQuestion = (index: number) => ({
  id: `question_${index + 1}`,
  question: `Question ${index + 1}`,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
});

describe('ask-user-question plugin limits', () => {
  test('accepts up to eight questions and rejects more', () => {
    expect(MAX_ASK_USER_QUESTIONS).toBe(8);
    const questions = Array.from({ length: MAX_ASK_USER_QUESTIONS }, (_, index) =>
      makeQuestion(index));

    expect(parseQuestions(questions)).toHaveLength(MAX_ASK_USER_QUESTIONS);
    expect(parseQuestions([...questions, makeQuestion(MAX_ASK_USER_QUESTIONS)])).toBeNull();
  });

  test('advertises the same question limit in the tool schema', () => {
    expect(AskUserQuestionSchema.properties.questions.maxItems).toBe(MAX_ASK_USER_QUESTIONS);
    expect(AskUserQuestionSchema.properties.questions.description).toBe('Questions to show (1-8).');
  });
});

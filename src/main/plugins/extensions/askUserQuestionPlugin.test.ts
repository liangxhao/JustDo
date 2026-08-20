import { Value } from 'typebox/value';
import { describe, expect, test } from 'vitest';

import {
  AskUserQuestionSchema,
  AskUserWaitPolicySchema,
  formatAskUserToolResponse,
  MAX_ASK_USER_QUESTIONS,
  MAX_ASK_USER_TIMEOUT_MINUTES,
  parseQuestions,
  parseWaitPolicy,
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
      makeQuestion(index),
    );

    expect(parseQuestions(questions)).toHaveLength(MAX_ASK_USER_QUESTIONS);
    expect(parseQuestions([...questions, makeQuestion(MAX_ASK_USER_QUESTIONS)])).toBeNull();
  });

  test('advertises the same question limit in the tool schema', () => {
    expect(AskUserQuestionSchema.properties.questions.maxItems).toBe(MAX_ASK_USER_QUESTIONS);
    expect(AskUserQuestionSchema.properties.questions.description).toBe('Questions to show (1-8).');
    expect(AskUserQuestionSchema.properties.waitPolicy).toMatchObject(AskUserWaitPolicySchema);
  });

  test('keeps the JSON schema aligned with the discriminated wait policy contract', () => {
    const questions = [{ ...makeQuestion(0), defaultOptionIds: ['no'] }];

    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        waitPolicy: { mode: 'required' },
      }),
    ).toBe(true);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        waitPolicy: {
          mode: 'timeout',
          timeoutMinutes: 10,
          onTimeout: 'use-defaults',
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        waitPolicy: { mode: 'timeout' },
      }),
    ).toBe(false);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        waitPolicy: {
          mode: 'required',
          timeoutMinutes: 10,
          onTimeout: 'model-decides',
        },
      }),
    ).toBe(false);
  });

  test('supports required waits and bounded timeout behavior', () => {
    const questions = parseQuestions([
      {
        ...makeQuestion(0),
        defaultOptionIds: ['no'],
      },
    ])!;

    expect(parseWaitPolicy(undefined, questions)).toEqual({ mode: 'required' });
    expect(
      parseWaitPolicy(
        {
          mode: 'timeout',
          timeoutMinutes: 10,
          onTimeout: 'use-defaults',
        },
        questions,
      ),
    ).toEqual({
      mode: 'timeout',
      timeoutMinutes: 10,
      onTimeout: 'use-defaults',
    });
    expect(
      parseWaitPolicy(
        {
          mode: 'timeout',
          timeoutMinutes: MAX_ASK_USER_TIMEOUT_MINUTES + 1,
          onTimeout: 'model-decides',
        },
        questions,
      ),
    ).toBeNull();
  });

  test('requires valid defaults when timeout should auto-select', () => {
    const questions = parseQuestions([makeQuestion(0)])!;

    expect(
      parseWaitPolicy(
        {
          mode: 'timeout',
          timeoutMinutes: 10,
          onTimeout: 'use-defaults',
        },
        questions,
      ),
    ).toBeNull();
    expect(
      parseQuestions([
        {
          ...makeQuestion(0),
          options: [
            { id: 'yes', label: 'Yes', input: { label: 'Why?' } },
            { id: 'no', label: 'No' },
          ],
          defaultOptionIds: ['yes'],
        },
      ]),
    ).toBeNull();
  });

  test('returns actionable model guidance or reports automatic defaults after timeout', () => {
    const questions = parseQuestions([
      {
        ...makeQuestion(0),
        defaultOptionIds: ['no'],
      },
    ])!;

    expect(formatAskUserToolResponse({ behavior: 'timeout' }, questions)).toContain(
      'Choose suitable values yourself based on the context and continue.',
    );
    expect(
      formatAskUserToolResponse(
        {
          behavior: 'allow',
          answers: { question_1: { selected: ['no'] } },
          timedOut: true,
        },
        questions,
      ),
    ).toContain('configured default choices were selected automatically');
  });
});

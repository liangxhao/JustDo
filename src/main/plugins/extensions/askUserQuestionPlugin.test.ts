import { Value } from 'typebox/value';
import { describe, expect, test } from 'vitest';

import {
  ASK_USER_TIMEOUT_MINUTES,
  AskUserQuestionSchema,
  buildWaitPolicy,
  formatAskUserToolResponse,
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
      makeQuestion(index),
    );

    expect(parseQuestions(questions)).toHaveLength(MAX_ASK_USER_QUESTIONS);
    expect(parseQuestions([...questions, makeQuestion(MAX_ASK_USER_QUESTIONS)])).toBeNull();
  });

  test('advertises the same question limit in the tool schema', () => {
    expect(AskUserQuestionSchema.properties.questions.maxItems).toBe(MAX_ASK_USER_QUESTIONS);
    expect(AskUserQuestionSchema.properties.questions.description).toBe('Questions to show (1-8).');
    expect(AskUserQuestionSchema.properties.timeoutEnabled.type).toBe('boolean');
  });

  test('exposes a flat timeout contract without a wait-policy union', () => {
    const questions = [{ ...makeQuestion(0), defaultOptionIds: ['no'] }];

    expect(AskUserQuestionSchema).not.toHaveProperty('anyOf');
    expect(AskUserQuestionSchema.properties).not.toHaveProperty('waitPolicy');
    expect(AskUserQuestionSchema.additionalProperties).toBe(false);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
      }),
    ).toBe(true);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        timeoutEnabled: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        timeoutEnabled: 'yes',
      }),
    ).toBe(false);
    expect(
      Value.Check(AskUserQuestionSchema, {
        questions,
        waitPolicy: {
          mode: 'timeout',
          timeoutMinutes: ASK_USER_TIMEOUT_MINUTES,
        },
      }),
    ).toBe(false);
  });

  test('derives required waits and bounded timeout behavior', () => {
    const questions = parseQuestions([
      {
        ...makeQuestion(0),
        defaultOptionIds: ['no'],
      },
    ])!;

    expect(buildWaitPolicy(undefined, questions)).toEqual({ mode: 'required' });
    expect(buildWaitPolicy(true, questions)).toEqual({
      mode: 'timeout',
      timeoutMinutes: ASK_USER_TIMEOUT_MINUTES,
      onTimeout: 'use-defaults',
    });
    expect(buildWaitPolicy(false, questions)).toEqual({ mode: 'required' });
    expect(buildWaitPolicy('yes', questions)).toBeNull();
  });

  test('lets the model decide after timeout when any question has no default', () => {
    const questions = parseQuestions([makeQuestion(0)])!;

    expect(buildWaitPolicy(true, questions)).toEqual({
      mode: 'timeout',
      timeoutMinutes: ASK_USER_TIMEOUT_MINUTES,
      onTimeout: 'model-decides',
    });
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

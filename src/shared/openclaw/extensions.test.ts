import { describe, expect, test } from 'vitest';

import {
  AskUserTimeoutBehavior,
  AskUserWaitMode,
  buildAskUserDefaultAnswers,
  MAX_ASK_USER_QUESTIONS,
  parseAskUserAnswers,
  parseAskUserQuestions,
  parseAskUserWaitPolicy,
} from './extensions';

const rawQuestions = [
  {
    id: 'deployment',
    question: 'How should this be deployed?',
    options: [
      { id: 'automatic', label: 'Automatic' },
      {
        id: 'custom',
        label: 'Custom',
        input: {
          label: 'Deployment instructions',
          placeholder: 'Describe the target environment',
        },
      },
    ],
  },
];

describe('ask-user-question runtime validation', () => {
  test('parses stable ids and required option input answers', () => {
    const questions = parseAskUserQuestions(rawQuestions);

    expect(questions).not.toBeNull();
    expect(parseAskUserAnswers({
      deployment: {
        selected: ['custom'],
        optionInputs: { custom: 'Deploy to staging' },
      },
    }, questions!)).toEqual({
      deployment: {
        selected: ['custom'],
        optionInputs: { custom: 'Deploy to staging' },
      },
    });
  });

  test('rejects duplicate question and option ids', () => {
    expect(parseAskUserQuestions([...rawQuestions, rawQuestions[0]])).toBeNull();
    expect(parseAskUserQuestions([{
      ...rawQuestions[0],
      options: [rawQuestions[0].options[0], rawQuestions[0].options[0]],
    }])).toBeNull();
  });

  test('accepts up to eight questions and rejects more', () => {
    expect(MAX_ASK_USER_QUESTIONS).toBe(8);
    const questions = Array.from({ length: MAX_ASK_USER_QUESTIONS }, (_, index) => ({
      ...rawQuestions[0],
      id: `question_${index + 1}`,
    }));

    expect(parseAskUserQuestions(questions)).toHaveLength(MAX_ASK_USER_QUESTIONS);
    expect(parseAskUserQuestions([
      ...questions,
      { ...rawQuestions[0], id: 'question_9' },
    ])).toBeNull();
  });

  test('rejects ids that can address object prototype properties', () => {
    expect(parseAskUserQuestions([{
      ...rawQuestions[0],
      id: '__proto__',
    }])).toBeNull();
    expect(parseAskUserQuestions([{
      ...rawQuestions[0],
      options: [
        { ...rawQuestions[0].options[0], id: 'constructor' },
        rawQuestions[0].options[1],
      ],
    }])).toBeNull();
  });

  test('rejects missing required inputs and unknown option ids', () => {
    const questions = parseAskUserQuestions(rawQuestions)!;

    expect(parseAskUserAnswers({
      deployment: { selected: ['custom'] },
    }, questions)).toBeNull();
    expect(parseAskUserAnswers({
      deployment: { selected: ['unknown'] },
    }, questions)).toBeNull();
  });

  test('keeps other answers separate from selected option ids', () => {
    const questions = parseAskUserQuestions(rawQuestions)!;

    expect(parseAskUserAnswers({
      deployment: { selected: [], other: 'Ask me later' },
    }, questions)).toEqual({
      deployment: { selected: [], other: 'Ask me later' },
    });
  });

  test('accepts an explicit skipped answer and rejects mixed skipped content', () => {
    const questions = parseAskUserQuestions(rawQuestions)!;

    expect(
      parseAskUserAnswers(
        {
          deployment: { selected: [], skipped: true },
        },
        questions,
      ),
    ).toEqual({ deployment: { selected: [], skipped: true } });
    expect(
      parseAskUserAnswers(
        {
          deployment: { selected: ['automatic'], skipped: true },
        },
        questions,
      ),
    ).toBeNull();
  });

  test('validates default option ids and builds timeout answers', () => {
    const questions = parseAskUserQuestions([{
      ...rawQuestions[0],
      defaultOptionIds: ['automatic'],
    }]);

    expect(questions).not.toBeNull();
    expect(buildAskUserDefaultAnswers(questions!)).toEqual({
      deployment: { selected: ['automatic'] },
    });
    expect(parseAskUserQuestions([{
      ...rawQuestions[0],
      defaultOptionIds: ['custom'],
    }])).toBeNull();
    expect(parseAskUserQuestions([{
      ...rawQuestions[0],
      defaultOptionIds: 'automatic',
    }])).toBeNull();
  });

  test('defaults to required waiting and validates timeout policies', () => {
    const questions = parseAskUserQuestions(rawQuestions)!;

    expect(parseAskUserWaitPolicy(undefined, questions)).toEqual({
      mode: AskUserWaitMode.REQUIRED,
    });
    expect(parseAskUserWaitPolicy({
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 10,
      onTimeout: AskUserTimeoutBehavior.MODEL_DECIDES,
    }, questions)).toEqual({
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 10,
      onTimeout: AskUserTimeoutBehavior.MODEL_DECIDES,
    });
    expect(parseAskUserWaitPolicy({
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 10,
      onTimeout: AskUserTimeoutBehavior.USE_DEFAULTS,
    }, questions)).toBeNull();

    const questionsWithDefaults = parseAskUserQuestions([{
      ...rawQuestions[0],
      defaultOptionIds: ['automatic'],
    }])!;
    expect(parseAskUserWaitPolicy({
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 10,
      onTimeout: AskUserTimeoutBehavior.USE_DEFAULTS,
    }, questionsWithDefaults)?.mode).toBe(AskUserWaitMode.TIMEOUT);
  });
});

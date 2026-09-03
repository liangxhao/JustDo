import { describe, expect, test } from 'vitest';

import {
  AskUserTimeoutBehavior,
  AskUserWaitMode,
  buildAskUserDefaultAnswers,
  MAX_ASK_USER_HEADER_LENGTH,
  MAX_ASK_USER_QUESTIONS,
  parseAskUserAnswers,
  parseAskUserQuestions,
  parseAskUserRequest,
  parseAskUserWaitPolicy,
} from './extensions';

const rawQuestions = [
  {
    id: 'deployment',
    header: 'Deploy',
    question: 'How should this be deployed?',
    options: [
      { id: 'automatic', label: 'Automatic' },
      {
        id: 'custom',
        label: 'Custom',
        description: 'Choose the target yourself.',
        input: { label: 'Target', placeholder: 'staging' },
      },
    ],
    allowOther: true,
  },
];

describe('AskUserQuestion validation', () => {
  test('parses rich questions and option-specific inputs', () => {
    const questions = parseAskUserQuestions(rawQuestions);

    expect(questions).toEqual(rawQuestions);
    expect(
      parseAskUserAnswers(
        {
          deployment: {
            selected: ['custom'],
            optionInputs: { custom: 'production' },
          },
        },
        questions!,
      ),
    ).toEqual({
      deployment: {
        selected: ['custom'],
        optionInputs: { custom: 'production' },
      },
    });
  });

  test('accepts up to eight questions and rejects duplicate or unsafe ids', () => {
    expect(MAX_ASK_USER_QUESTIONS).toBe(8);
    const questions = Array.from({ length: MAX_ASK_USER_QUESTIONS }, (_, index) => ({
      ...rawQuestions[0],
      id: `question_${index + 1}`,
    }));

    expect(parseAskUserQuestions(questions)).toHaveLength(MAX_ASK_USER_QUESTIONS);
    expect(parseAskUserQuestions([...questions, { ...rawQuestions[0], id: 'question_9' }])).toBeNull();
    expect(parseAskUserQuestions([...rawQuestions, rawQuestions[0]])).toBeNull();
    expect(parseAskUserQuestions([{ ...rawQuestions[0], id: 'constructor' }])).toBeNull();
  });

  test('validates headers, skips, free text, and required option inputs', () => {
    expect(
      parseAskUserQuestions([
        { ...rawQuestions[0], header: 'x'.repeat(MAX_ASK_USER_HEADER_LENGTH + 1) },
      ]),
    ).toBeNull();
    const questions = parseAskUserQuestions(rawQuestions)!;
    expect(parseAskUserAnswers({ deployment: { selected: ['custom'] } }, questions)).toBeNull();
    expect(
      parseAskUserAnswers({ deployment: { selected: [], other: 'Ask me later' } }, questions),
    ).toEqual({ deployment: { selected: [], other: 'Ask me later' } });
    expect(
      parseAskUserAnswers({ deployment: { selected: [], skipped: true } }, questions),
    ).toEqual({ deployment: { selected: [], skipped: true } });
  });

  test('validates timeout defaults and complete request envelopes', () => {
    const questions = parseAskUserQuestions([
      { ...rawQuestions[0], defaultOptionIds: ['automatic'] },
    ])!;
    const waitPolicy = {
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 10,
      onTimeout: AskUserTimeoutBehavior.USE_DEFAULTS,
    } as const;

    expect(parseAskUserWaitPolicy(waitPolicy, questions)).toEqual(waitPolicy);
    expect(buildAskUserDefaultAnswers(questions)).toEqual({
      deployment: { selected: ['automatic'] },
    });
    expect(
      parseAskUserRequest({
        requestId: 'ask-1',
        sessionKey: 'agent:main:justdo:session-1',
        questions,
        waitPolicy,
        expiresAt: 1_000,
      }),
    ).toMatchObject({ requestId: 'ask-1', questions, waitPolicy, expiresAt: 1_000 });
    expect(
      parseAskUserRequest({ requestId: 'ask-1', questions, waitPolicy }),
    ).toBeNull();
  });
});

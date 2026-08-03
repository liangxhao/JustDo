import { describe, expect, test } from 'vitest';

import { parseAskUserAnswers, parseAskUserQuestions } from './extensions';

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
});

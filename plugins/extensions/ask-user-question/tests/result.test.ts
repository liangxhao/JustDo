import { describe, expect, test } from 'vitest';

import { parseQuestionResult, type Question, readQuestionResult } from '../contracts/result';

const question: Question = {
  id: 'stack',
  question: 'Which stack should I use?',
  options: [
    { id: 'react', label: 'React' },
    { id: 'vue', label: 'Vue' },
  ],
};

const result = (response: unknown, questions = [question]) => ({ version: 1, questions, response });

describe('question result contract', () => {
  test('reads explicit structured results after native history removes private details', () => {
    const snapshot = result({ status: 'answered', timedOut: true, answers: { stack: { selected: ['react'] } } }, [
      { ...question, defaultOptionIds: ['react'] },
    ]);
    const envelope = { askUserQuestion: snapshot, summary: 'Configured defaults applied.' };
    const content = [{ type: 'text', text: JSON.stringify(envelope) }];
    const nativeResult = { content, details: { askUserQuestion: snapshot } };
    const historyResult = { role: 'toolResult', toolName: 'ask_user_question', toolCallId: 'call-1', content };
    const expected = parseQuestionResult(snapshot);

    expect(readQuestionResult(nativeResult)).toEqual(expected);
    expect(readQuestionResult(historyResult)).toEqual(expected);
    expect(readQuestionResult(content)).toEqual(expected);
    expect(readQuestionResult(JSON.stringify(envelope))).toEqual(expected);
    expect(readQuestionResult(JSON.stringify(nativeResult))).toEqual(expected);
    expect(readQuestionResult(JSON.stringify({ content }))).toEqual(expected);
  });

  test('does not parse prose, partial JSON, mixed content or recursive envelopes', () => {
    const snapshot = result({ status: 'cancelled' });
    const text = JSON.stringify({ askUserQuestion: snapshot });
    expect(readQuestionResult(`Result: ${text}`)).toBeNull();
    expect(readQuestionResult(text.slice(0, -1))).toBeNull();
    expect(readQuestionResult({ content: [{ type: 'text', text }, { type: 'text', text: 'Extra' }] })).toBeNull();
    expect(readQuestionResult({ content: [{ type: 'image', text }] })).toBeNull();
    expect(readQuestionResult({ content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text }] }) }] })).toBeNull();
    expect(readQuestionResult('The question was cancelled; proceed with best judgment.')).toBeNull();
  });

  test('decodes a snapshot of every human answer without treating it as a timeout', () => {
    const decoded = parseQuestionResult(result({
      status: 'answered',
      answers: { stack: { selected: ['react'] }, files: { selected: ['pdf', 'excel'] } },
    }, [
      question,
      {
        id: 'files', question: 'Which deliverables?', multiSelect: true,
        options: [{ id: 'pdf', label: 'PDF' }, { id: 'excel', label: 'Excel' }],
      },
    ]));

    expect(decoded?.questions.map(item => item.question)).toEqual([
      'Which stack should I use?', 'Which deliverables?',
    ]);
    expect(decoded?.response).toEqual({
      status: 'answered',
      answers: { stack: { selected: ['react'] }, files: { selected: ['pdf', 'excel'] } },
    });
  });

  test('preserves option-specific input, free text and skipped questions', () => {
    const inputQuestion = {
      ...question,
      options: [{ id: 'react', label: 'React', input: { label: 'Version' } }, question.options[1]],
    };
    expect(parseQuestionResult(result({
      status: 'answered', answers: { stack: { selected: ['react'], optionInputs: { react: '19' } } },
    }, [inputQuestion]))?.response).toEqual({
      status: 'answered', answers: { stack: { selected: ['react'], optionInputs: { react: '19' } } },
    });
    expect(parseQuestionResult(result({
      status: 'answered', answers: { stack: { selected: [], other: 'Svelte' } },
    }))?.response).toEqual({
      status: 'answered', answers: { stack: { selected: [], other: 'Svelte' } },
    });
    expect(parseQuestionResult(result({
      status: 'answered', answers: { stack: { selected: [], skipped: true } },
    }))?.response).toEqual({
      status: 'answered', answers: { stack: { selected: [], skipped: true } },
    });
  });

  test('admits automatic defaults only when the actual answers match all configured defaults', () => {
    const questions = [{ ...question, defaultOptionIds: ['react'] }];
    const response = { status: 'answered', answers: { stack: { selected: ['react'] } }, timedOut: true };
    expect(parseQuestionResult(result(response, questions))?.response).toEqual(response);
    expect(parseQuestionResult(result(response))).toBeNull();
    expect(parseQuestionResult(result({
      ...response, answers: { stack: { selected: ['vue'] } },
    }, questions))).toBeNull();
    expect(parseQuestionResult(result({
      ...response, answers: { stack: { selected: [], skipped: true } },
    }, questions))).toBeNull();
  });

  test.each(['timeout', 'cancelled'])('preserves %s without inventing default answers', status => {
    expect(parseQuestionResult(result({ status }))?.response).toEqual({ status });
    expect(parseQuestionResult(result({ status, answers: { stack: { selected: ['react'] } } }))).toBeNull();
  });

  test.each([
    { status: 'answered', answers: { stack: { selected: ['unknown'] } } },
    { status: 'answered', answers: { stack: { selected: ['react', 'vue'] } } },
    { status: 'answered', answers: {} },
    { status: 'answered', answers: { stack: { selected: ['react'], optionInputs: { vue: '3' } } } },
    { status: 'answered', answers: { stack: { selected: ['react'] } }, timedOut: 'true' },
    { status: 'pending' },
  ])('rejects inconsistent response data: %j', response => {
    expect(parseQuestionResult(result(response))).toBeNull();
  });

  test('rejects unsupported versions and malformed questions', () => {
    expect(parseQuestionResult({ ...result({ status: 'cancelled' }), version: 2 })).toBeNull();
    expect(parseQuestionResult(result({ status: 'cancelled' }, []))).toBeNull();
    expect(parseQuestionResult(result({ status: 'cancelled' }, [question, question]))).toBeNull();
    expect(parseQuestionResult('The user selected React')).toBeNull();
  });
});

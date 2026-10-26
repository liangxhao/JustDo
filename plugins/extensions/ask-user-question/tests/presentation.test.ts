/** @vitest-environment jsdom */

import { render } from 'lit';
import { afterEach, describe, expect, test } from 'vitest';

import { questionPresentationResponse, renderQuestionPresentation } from '../browser/presentation';
import { askUserQuestionTranslations } from '../browser/translations';
import type { AskUserResponse, Question } from '../contracts/result';

const questions: Question[] = [
  {
    id: 'stack',
    question: '项目使用哪种技术栈？',
    options: [
      { id: 'react', label: 'React + TypeScript' },
      { id: 'vue', label: 'Vue + TypeScript', input: { label: '补充说明' } },
    ],
    defaultOptionIds: ['react'],
  },
  {
    id: 'formats',
    question: '需要交付哪些文件格式？',
    multiSelect: true,
    options: [
      { id: 'pdf', label: 'PDF' },
      { id: 'excel', label: 'Excel' },
    ],
    defaultOptionIds: ['pdf', 'excel'],
  },
];

function display(response?: AskUserResponse) {
  const container = document.createElement('div');
  document.body.append(container);
  render(
    renderQuestionPresentation(
      questions,
      response,
      key => askUserQuestionTranslations.zh[key as keyof typeof askUserQuestionTranslations.zh],
    ),
    container,
  );
  return container;
}

afterEach(() => document.body.replaceChildren());

describe('question result presentation', () => {
  test.each(['cancelled', 'interrupted', 'failed'])(
    'preserves native %s without returning to the waiting state',
    status => {
      const container = document.createElement('div');
      render(
        renderQuestionPresentation(
          questions,
          questionPresentationResponse(status, undefined, 'Native error detail'),
          key => askUserQuestionTranslations.en[key as keyof typeof askUserQuestionTranslations.en],
        ),
        container,
      );
      expect(container.querySelector('.question-answer--human')).toBeNull();
      expect(container.querySelector('.question-answer__waiting')).toBeNull();
      expect(container.textContent).toContain(questions[0].question);
      if (status !== 'cancelled') expect(container.textContent).toContain('Native error detail');
    },
  );
  test('keeps waiting minimal without duplicating the answer dialog', () => {
    const container = display();
    expect(container.textContent).toContain('等待你的回答 · 2 个问题');
    expect(container.querySelector('form, input, button, textarea, select')).toBeNull();
    expect(container.textContent).not.toContain(questions[0].question);
  });

  test('shows human answers with the question and optional details; other questions are locally collapsible', () => {
    const container = display({
      status: 'answered',
      answers: {
        stack: { selected: ['vue'], optionInputs: { vue: '<script>alert(1)</script>' } },
        formats: { selected: ['pdf'], other: 'Markdown\n和文档' },
      },
    });
    expect(container.querySelector('.question-answer--human')).not.toBeNull();
    expect(container.textContent).toContain(questions[0].question);
    expect(container.textContent).toContain('Vue + TypeScript');
    expect(container.textContent).toContain('补充说明: <script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
    const more = container.querySelector<HTMLDetailsElement>('.question-answer__more')!;
    expect(more.open).toBe(false);
    more.open = true;
    expect(more.textContent).toContain(questions[1].question);
    expect(more.textContent).toContain('PDF');
    expect(more.textContent).toContain('Markdown\n和文档');
  });

  test('shows every timed-out question with the actual default answer and system attribution', () => {
    const container = display({
      status: 'answered',
      timedOut: true,
      answers: {
        stack: { selected: ['react'] },
        formats: { selected: ['pdf', 'excel'] },
      },
    });
    expect(container.querySelector('.question-answer--human')).toBeNull();
    expect(container.querySelector('.question-answer--system')).not.toBeNull();
    expect(container.textContent).toContain('系统自动选择 · 未收到用户回答');
    expect(
      Array.from(container.querySelectorAll('.question-answer__pair')).map(
        pair => pair.textContent,
      ),
    ).toEqual([
      expect.stringContaining('项目使用哪种技术栈？'),
      expect.stringContaining('需要交付哪些文件格式？'),
    ]);
    expect(container.querySelectorAll('.question-answer__pair')[0].textContent).toContain(
      'React + TypeScript',
    );
    expect(container.querySelectorAll('.question-answer__pair')[1].textContent).toContain('PDF');
    expect(container.querySelectorAll('.question-answer__pair')[1].textContent).toContain('Excel');
    expect(container.querySelector('details')).toBeNull();
  });

  test.each(['timeout', 'cancelled'] as const)(
    'shows unanswered questions for %s without claiming defaults were selected',
    status => {
      const container = display({ status });
      expect(container.querySelector('.question-answer--human')).toBeNull();
      expect(container.textContent).toContain(questions[0].question);
      expect(container.textContent).toContain(questions[1].question);
      expect(container.textContent).toContain('未收到回答');
      expect(container.textContent).not.toContain('React + TypeScript');
      expect(container.textContent).not.toContain('已采用默认');
    },
  );

  test('retains skipped answers without inventing a selection', () => {
    const container = display({
      status: 'answered',
      answers: {
        stack: { selected: [], skipped: true },
        formats: { selected: [], skipped: true },
      },
    });
    expect(container.textContent).toContain('已跳过');
    expect(container.textContent).not.toContain('React + TypeScript');
  });

  test('provides matching English and Chinese labels', () => {
    expect(Object.keys(askUserQuestionTranslations.en).sort()).toEqual(
      Object.keys(askUserQuestionTranslations.zh).sort(),
    );
  });
});

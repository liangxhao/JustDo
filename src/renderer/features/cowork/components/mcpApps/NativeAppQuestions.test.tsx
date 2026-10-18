// @vitest-environment jsdom
import type { McpAppHostApi, NativeAppQuestion } from '@shared/plugins/mcpApps';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { NativeAppQuestions } from './NativeAppQuestions';

vi.mock('@/libs/openclaw-chat/components/mcp-app/view', () => ({ McpAppView: class {} }));
vi.mock('@/libs/openclaw-chat/pipeline/native-mcp-app', () => ({
  decodeMcpAppQuestionPreview: () => undefined,
}));
afterEach(cleanup);
const question = (fields: NativeAppQuestion['questions']): NativeAppQuestion => ({
  id: 'question',
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  status: 'pending',
  questions: fields,
});
function setup(value: NativeAppQuestion) {
  i18nService.setLanguage('en', { persist: false });
  const resolveQuestion = vi
    .fn<McpAppHostApi['resolveQuestion']>()
    .mockResolvedValue({ success: true, value: {} });
  const api = {
    questions: vi
      .fn<McpAppHostApi['questions']>()
      .mockResolvedValue({ success: true, value: [value] }),
    resolveQuestion,
    onQuestionsChanged: () => () => {},
  };
  Object.defineProperty(window, 'electron', { configurable: true, value: { mcpApps: api } });
  render(<NativeAppQuestions sessionId="session" prepare={vi.fn()} />);
  return { resolveQuestion, api };
}

test('requires a selection and focuses its field before submitting a native question', async () => {
  const { resolveQuestion } = setup(
    question([
      {
        questionId: 'color',
        header: 'Color',
        question: 'Choose color',
        options: [{ label: 'Blue', value: 'blue' }],
      },
    ]),
  );
  const choice = await screen.findByRole('radio', { name: 'Blue' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(resolveQuestion).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(choice);
  fireEvent.click(choice);
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(resolveQuestion).toHaveBeenCalledWith({
      sessionId: 'session',
      id: 'question',
      answers: { color: ['blue'] },
    }),
  );
});

test('clearing an optional answer submits an empty selection and preserves exact secret bytes', async () => {
  const { resolveQuestion } = setup(
    question([
      {
        questionId: 'note',
        header: 'Note',
        question: 'Optional note',
        options: [],
        allowEmpty: true,
      },
      { questionId: 'secret', header: 'Secret', question: 'Token', options: [], isSecret: true },
    ]),
  );
  const note = await screen.findByRole('textbox', { name: 'Optional note' });
  fireEvent.change(note, { target: { value: 'old' } });
  fireEvent.change(note, { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: '  token  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(resolveQuestion).toHaveBeenCalledWith({
      sessionId: 'session',
      id: 'question',
      answers: { note: [], secret: ['  token  '] },
    }),
  );
});

// @vitest-environment jsdom
import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoworkInteractionRequest } from '../../coworkTypes';
import CoworkQuestionFloatingWindow from './CoworkQuestionFloatingWindow';
import { QuestionSurface } from './QuestionSurface';

afterEach(cleanup);
const interaction: CoworkInteractionRequest = {
  requestId: 'one',
  sessionId: 'source',
  toolName: 'ask_user_question',
  interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
  toolInput: {
    questions: [
      {
        id: 'choice',
        question: 'Choose a result',
        options: [
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two' },
        ],
      },
    ],
  },
};

test('moves the same unanswered form between documents, preserving drafts and responding only to that request', () => {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const secondary = frame.contentDocument!;
  const respond = vi.fn().mockResolvedValue(true);
  const view = (target?: Document) => (
    <QuestionSurface target={target}>
      <CoworkQuestionFloatingWindow
        interaction={interaction}
        isVisible
        sourceLabel="Actual child"
        onRespond={respond}
      />
    </QuestionSurface>
  );
  const { rerender } = render(view());
  const form = screen.getByRole('dialog');
  fireEvent.click(screen.getByRole('radio', { name: /Other|其他/ }));
  const field = screen.getByRole('textbox');
  fireEvent.change(field, { target: { value: 'Keep this answer' } });
  rerender(view(secondary));
  expect(within(secondary.body).getByRole('dialog')).toBe(form);
  expect((within(secondary.body).getByRole('textbox') as HTMLInputElement).value).toBe(
    'Keep this answer',
  );
  fireEvent(secondary.defaultView!, new secondary.defaultView!.Event('pagehide'));
  expect(screen.getByRole('dialog')).toBe(form);
  fireEvent.click(
    screen.getByRole('button', {
      name: /Submit current selection|提交当前选择/,
    }),
  );
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({
      updatedInput: expect.objectContaining({
        answers: { choice: { selected: [], other: 'Keep this answer' } },
      }),
    }),
  );
  frame.remove();
});

test('switching the concurrent question queue retains separate drafts and cancels only the selected request', () => {
  const respond = vi.fn().mockResolvedValue(true);
  function Queue() {
    const [selected, setSelected] = useState('one');
    return ['one', 'two'].map(id => (
      <CoworkQuestionFloatingWindow
        key={id}
        interaction={{ ...interaction, requestId: id }}
        isVisible={selected === id}
        queue={[
          { id: 'one', label: 'First child' },
          { id: 'two', label: 'Second child' },
        ]}
        onSelectRequest={setSelected}
        sourceLabel={`${id} child`}
        onRespond={result => respond(id, result)}
      />
    ));
  }
  render(<Queue />);
  fireEvent.click(screen.getByRole('radio', { name: /Other|其他/ }));
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'First draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Question 2|问题 2/ }));
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: /Other|其他/ }));
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Second draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Question 1|问题 1/ }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('First draft');
  fireEvent.click(screen.getByRole('button', { name: /Close|关闭/ }));
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    'one',
    expect.objectContaining({ behavior: 'cancel' }),
  );
});

// @vitest-environment jsdom

import { CoworkInteractionKind } from '@shared/openclaw/extensions';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CoworkInteractionRequest } from '@/features/cowork/coworkTypes';

import CoworkInteractionModal from './CoworkInteractionModal';

const buildInteraction = (
  questionOverrides: Record<string, unknown> = {},
): CoworkInteractionRequest => ({
  sessionId: 'session-1',
  requestId: 'request-1',
  toolName: 'AskUserQuestion',
  interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
  toolInput: {
    questions: [
      {
        id: 'design_confirm',
        header: 'Design',
        question: 'Confirm the design?',
        options: [
          {
            id: 'confirm_start',
            label: 'Confirm and start',
            description: 'Start Phase A and generate the signal interface list.',
          },
          {
            id: 'need_modify',
            label: 'Modify design',
            description: 'Adjust the project name or pagination strategy.',
          },
        ],
        ...questionOverrides,
      },
    ],
  },
});

afterEach(cleanup);

describe('CoworkInteractionModal structured questions', () => {
  test('renders a binary question as described radios and submits the selected option', () => {
    const onRespond = vi.fn();
    render(<CoworkInteractionModal interaction={buildInteraction()} onRespond={onRespond} />);

    expect(screen.getByRole('heading', { name: 'Design' })).toBeTruthy();
    expect(screen.getByText('Start Phase A and generate the signal interface list.')).toBeTruthy();
    expect(screen.getByText('Adjust the project name or pagination strategy.')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Other|其他/ })).toBeNull();

    const submit = screen.getByRole('button', { name: /Submit current selection|提交当前选择/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /Modify design/ }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'submit',
        updatedInput: expect.objectContaining({
          answers: { design_confirm: { selected: ['need_modify'] } },
        }),
      }),
    );
  });

  test('shows Other only when allowed and requires its text before submission', () => {
    const onRespond = vi.fn();
    render(
      <CoworkInteractionModal
        interaction={buildInteraction({ allowOther: true })}
        onRespond={onRespond}
      />,
    );

    const other = screen.getByRole('radio', { name: /Other|其他/ });
    const submit = screen.getByRole('button', { name: /Submit current selection|提交当前选择/ });
    fireEvent.click(other);
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/custom answer|自定义答案/), {
      target: { value: 'Use a different workflow' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedInput: expect.objectContaining({
          answers: {
            design_confirm: { selected: [], other: 'Use a different workflow' },
          },
        }),
      }),
    );
  });

  test('requires option input and keeps cancel separate from option selection', () => {
    const onRespond = vi.fn();
    render(
      <CoworkInteractionModal
        interaction={buildInteraction({
          options: [
            { id: 'confirm_start', label: 'Confirm and start' },
            {
              id: 'need_modify',
              label: 'Modify design',
              input: { label: 'Requested changes', placeholder: 'Describe the changes' },
            },
          ],
        })}
        onRespond={onRespond}
      />,
    );

    const submit = screen.getByRole('button', { name: /Submit current selection|提交当前选择/ });
    fireEvent.click(screen.getByRole('radio', { name: /Modify design/ }));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Describe the changes'), {
      target: { value: 'Rename the project' },
    });
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        updatedInput: expect.objectContaining({
          answers: {
            design_confirm: {
              selected: ['need_modify'],
              optionInputs: { need_modify: 'Rename the project' },
            },
          },
        }),
      }),
    );

    onRespond.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Cancel request|取消请求/ }));
    expect(onRespond).toHaveBeenCalledWith({
      behavior: 'cancel',
      message: 'Interaction canceled',
    });
  });
});

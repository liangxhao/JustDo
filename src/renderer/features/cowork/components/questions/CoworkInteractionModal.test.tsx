// @vitest-environment jsdom

import { CoworkInteractionKind } from '@shared/openclaw/extensions';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  test('focuses the dialog instead of highlighting the close button when opened', async () => {
    render(
      <CoworkInteractionModal
        interaction={buildInteraction()}
        onRespond={vi.fn()}
        presentation="floating"
      />,
    );

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /Close|关闭/ }));
  });

  test('renders a binary question as described radios and submits the selected option', () => {
    const onRespond = vi.fn();
    render(<CoworkInteractionModal interaction={buildInteraction()} onRespond={onRespond} />);

    expect(screen.getByRole('heading', { name: 'Design' })).toBeTruthy();
    expect(screen.getByText('Start Phase A and generate the signal interface list.')).toBeTruthy();
    expect(screen.getByText('Adjust the project name or pagination strategy.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Other|其他/ })).toBeTruthy();

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

  test('shows Other by default and requires its text before submission', () => {
    const onRespond = vi.fn();
    render(<CoworkInteractionModal interaction={buildInteraction()} onRespond={onRespond} />);

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

  test('hides Other when it is explicitly disabled', () => {
    render(
      <CoworkInteractionModal
        interaction={buildInteraction({ allowOther: false })}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.queryByRole('radio', { name: /Other|其他/ })).toBeNull();
  });

  test('keeps native option selection separate from cancelling the request', () => {
    const onRespond = vi.fn().mockResolvedValue(true);
    render(
      <CoworkInteractionModal
        interaction={buildInteraction({
          options: [
            { id: 'confirm_start', label: 'Confirm and start' },
            { id: 'need_modify', label: 'Modify design' },
          ],
        })}
        onRespond={onRespond}
      />,
    );

    const submit = screen.getByRole('button', { name: /Submit current selection|提交当前选择/ });
    fireEvent.click(screen.getByRole('radio', { name: /Modify design/ }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        updatedInput: expect.objectContaining({
          answers: {
            design_confirm: {
              selected: ['need_modify'],
            },
          },
        }),
      }),
    );

    cleanup();
    const onCancel = vi.fn().mockResolvedValue(true);
    render(
      <CoworkInteractionModal
        interaction={buildInteraction({
          options: [
            { id: 'confirm_start', label: 'Confirm and start' },
            { id: 'need_modify', label: 'Modify design' },
          ],
        })}
        onRespond={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel request|取消请求/ }));
    expect(onCancel).toHaveBeenCalledWith({
      behavior: 'cancel',
      message: 'Interaction canceled',
    });
  });

  test('prevents duplicate responses and becomes retryable after a failed response', async () => {
    let resolveResponse!: (success: boolean) => void;
    const onRespond = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveResponse = resolve;
        }),
    );
    render(<CoworkInteractionModal interaction={buildInteraction()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('radio', { name: /Modify design/ }));
    const submit = screen.getByRole('button', { name: /Submit current selection|提交当前选择/ });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');

    await act(async () => resolveResponse(false));

    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('false');
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledTimes(2);
  });
});

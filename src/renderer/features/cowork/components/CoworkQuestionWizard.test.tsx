// @vitest-environment jsdom

import { CoworkInteractionKind } from '@shared/openclaw/extensions';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CoworkInteractionRequest } from '@/features/cowork/coworkTypes';

import CoworkQuestionWizard from './CoworkQuestionWizard';

const buildInteraction = (
  firstQuestionOverrides: Record<string, unknown> = {},
  secondQuestionOverrides: Record<string, unknown> = {},
) =>
  ({
    sessionId: 'session-1',
    requestId: 'request-1',
    toolName: 'AskUserQuestion',
    interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
    toolInput: {
      questions: [
        {
          id: 'targets',
          question: 'Which targets should be included?',
          multiSelect: true,
          options: [
            { id: 'desktop', label: 'Desktop' },
            { id: 'mobile', label: 'Mobile' },
          ],
          ...firstQuestionOverrides,
        },
        {
          id: 'environment',
          question: 'Which environment should be used?',
          options: [
            { id: 'staging', label: 'Staging' },
            { id: 'production', label: 'Production' },
          ],
          ...secondQuestionOverrides,
        },
      ],
    },
  }) satisfies CoworkInteractionRequest;

afterEach(cleanup);

describe('CoworkQuestionWizard multi-select navigation', () => {
  test('shows Next only after the current multi-select answer is complete', () => {
    render(<CoworkQuestionWizard interaction={buildInteraction()} onRespond={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Desktop' }));

    const next = screen.getByRole('button', { name: /Next|下一个/ });
    fireEvent.click(next);

    expect(screen.getByText('Which environment should be used?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();
  });

  test('waits for required option input before showing Next', () => {
    render(
      <CoworkQuestionWizard
        interaction={buildInteraction({
          options: [
            {
              id: 'custom',
              label: 'Custom target',
              input: { label: 'Target name', placeholder: 'Enter a target' },
            },
            { id: 'desktop', label: 'Desktop' },
          ],
        })}
        onRespond={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Custom target' }));
    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Enter a target'), {
      target: { value: 'Embedded' },
    });
    expect(screen.getByRole('button', { name: /Next|下一个/ })).toBeTruthy();
  });

  test('hides Next again when the last selected option is cleared', () => {
    render(<CoworkQuestionWizard interaction={buildInteraction()} onRespond={vi.fn()} />);

    const desktop = screen.getByRole('checkbox', { name: 'Desktop' });
    fireEvent.click(desktop);
    expect(screen.getByRole('button', { name: /Next|下一个/ })).toBeTruthy();

    fireEvent.click(desktop);
    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();
  });

  test('requires allowed Other text and hides Next when Other is cleared', () => {
    render(<CoworkQuestionWizard interaction={buildInteraction()} onRespond={vi.fn()} />);

    const other = screen.getByRole('checkbox', { name: /Other|其他/ });
    fireEvent.click(other);
    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/custom answer|自定义答案/), {
      target: { value: 'Tablet' },
    });
    expect(screen.getByRole('button', { name: /Next|下一个/ })).toBeTruthy();

    fireEvent.click(other);
    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();
  });

  test('restores Next when returning to a completed multi-select question', () => {
    render(<CoworkQuestionWizard interaction={buildInteraction()} onRespond={vi.fn()} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desktop' }));
    fireEvent.click(screen.getByRole('button', { name: /Next|下一个/ }));
    fireEvent.click(screen.getByTitle(/Previous|上一个/));

    expect(screen.getByText('Which targets should be included?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Next|下一个/ })).toBeTruthy();
  });

  test('never shows Next on the final question when it is multi-select', () => {
    render(
      <CoworkQuestionWizard
        interaction={buildInteraction(
          {},
          {
            multiSelect: true,
            options: [
              { id: 'staging', label: 'Staging' },
              { id: 'production', label: 'Production' },
            ],
          },
        )}
        onRespond={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desktop' }));
    fireEvent.click(screen.getByRole('button', { name: /Next|下一个/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Staging' }));

    expect(screen.getByText('Which environment should be used?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Next|下一个/ })).toBeNull();
  });
});

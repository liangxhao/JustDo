// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

import CoworkSearchModal from './CoworkSearchModal';

const sessions: CoworkSessionSummary[] = [
  {
    id: 'title-match',
    title: 'Release checklist',
    status: 'idle',
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'message-match',
    title: 'Unrelated title',
    status: 'completed',
    pinned: false,
    createdAt: 2,
    updatedAt: 2,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CoworkSearchModal', () => {
  test('unions title matches with user or assistant message matches', async () => {
    i18nService.setLanguage('en', { persist: false });
    const searchSessionMessages = vi.fn().mockResolvedValue({
      success: true,
      matches: [
        {
          sessionId: 'message-match',
          role: 'assistant',
          snippet: 'needle in the assistant content',
          timestamp: 10,
          score: 1,
        },
      ],
      indexing: false,
      truncated: false,
      partial: false,
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { cowork: { searchSessionMessages } },
    });

    render(
      <CoworkSearchModal
        isOpen
        sessions={sessions}
        currentSessionId={null}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search titles and messages...'), {
      target: { value: 'needle' },
    });

    await waitFor(() => expect(searchSessionMessages).toHaveBeenCalledWith('needle'));
    const matchingTitle = await screen.findByText('Unrelated title');
    expect(matchingTitle.closest('button')?.textContent).toContain(
      'needle in the assistant content',
    );
    expect(screen.getAllByText('needle')).toHaveLength(1);
    expect(screen.queryByText('Release checklist')).toBeNull();
    expect(screen.queryByText('Conversations')).toBeNull();
    expect(screen.queryByText('Recent')).toBeNull();
  });

  test('keeps title matching immediate while message search is pending', () => {
    i18nService.setLanguage('en', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: { searchSessionMessages: vi.fn(() => new Promise(() => undefined)) },
      },
    });

    render(
      <CoworkSearchModal
        isOpen
        sessions={sessions}
        currentSessionId={null}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search titles and messages...'), {
      target: { value: 'release' },
    });

    expect(screen.getByText('Release').closest('button')?.textContent).toBe('Release checklist');
    expect(screen.queryByText('Unrelated title')).toBeNull();
  });

  test('shows search failures separately from an empty result', async () => {
    i18nService.setLanguage('en', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          searchSessionMessages: vi.fn().mockResolvedValue({
            success: false,
            error: 'Gateway unavailable',
          }),
        },
      },
    });

    render(
      <CoworkSearchModal
        isOpen
        sessions={sessions}
        currentSessionId={null}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search titles and messages...'), {
      target: { value: 'missing' },
    });

    expect(await screen.findByText("Couldn't search messages. Please retry.")).toBeTruthy();
    expect(screen.queryByText('No matching tasks')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('supports arrow-key navigation and Enter selection', async () => {
    i18nService.setLanguage('en', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { cowork: { searchSessionMessages: vi.fn() } },
    });
    const onSelectSession = vi.fn();
    const onClose = vi.fn();
    render(
      <CoworkSearchModal
        isOpen
        sessions={sessions}
        currentSessionId={null}
        onClose={onClose}
        onSelectSession={onSelectSession}
      />,
    );

    const input = screen.getByRole('searchbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith('message-match'));
    expect(onClose).toHaveBeenCalled();
  });

  test('does not preselect a result before pointer or keyboard navigation', () => {
    i18nService.setLanguage('en', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { cowork: { searchSessionMessages: vi.fn() } },
    });

    render(
      <CoworkSearchModal
        isOpen
        sessions={sessions}
        currentSessionId="title-match"
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    const input = screen.getByRole('searchbox');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    for (const result of screen.getAllByRole('button').filter(button => button.id)) {
      expect(result.className).not.toContain('bg-primary/[0.12]');
      expect(result.className).not.toContain('ring-primary/25');
    }
  });
});

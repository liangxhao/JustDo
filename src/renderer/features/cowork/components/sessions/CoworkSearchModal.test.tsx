// @vitest-environment jsdom

import type { CoworkSessionMessageSearchMatch } from '@shared/cowork/sessionSearch';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
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
  vi.useRealTimers();
});

const match = (sessionId: string): CoworkSessionMessageSearchMatch => ({
  sessionId,
  nativeSessionKey: `agent:main:justdo:${sessionId}`,
  nativeSessionId: `native-${sessionId}`,
  messageId: `entry-${sessionId}`,
  role: 'assistant',
  snippet: 'needle content',
  timestamp: 10,
  score: 1,
});

const searchResponse = (matches: CoworkSessionMessageSearchMatch[] = []) => ({
  success: true,
  matches,
  indexing: false,
  partial: false,
  truncated: false,
  archivedTranscriptsExcluded: 0,
});

const renderSearch = (
  searchSessionMessages = vi.fn().mockResolvedValue(searchResponse()),
  props: Partial<ComponentProps<typeof CoworkSearchModal>> = {},
) => {
  i18nService.setLanguage('en', { persist: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { searchSessionMessages } },
  });
  const callbacks = { onSelectSession: vi.fn(), onClose: vi.fn() };
  const view = render(
    <CoworkSearchModal
      isOpen
      sessions={sessions}
      currentSessionId={null}
      {...callbacks}
      {...props}
    />,
  );
  return { ...view, ...callbacks, searchSessionMessages, input: screen.getByRole('searchbox') };
};

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

    await waitFor(() =>
      expect(searchSessionMessages).toHaveBeenCalledWith('needle', {
        sessionIds: ['message-match', 'title-match'],
      }),
    );
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

    expect(screen.getByText('Release').closest('button')?.textContent).toContain(
      'Release checklist',
    );
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
    expect(screen.queryByText('No conversations found')).toBeNull();
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

    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith('title-match'));
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
      expect(result.getAttribute('data-active')).toBeNull();
    }
  });

  test('clears the query, restores recent conversations and keeps focus in search', async () => {
    i18nService.setLanguage('en', { persist: false });
    const onSelectSession = vi.fn();
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
        onSelectSession={onSelectSession}
      />,
    );
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'release' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('cowork-search-result-0');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(screen.getByText('Recent conversations')).toBeTruthy();
    expect(screen.getByText('Unrelated title')).toBeTruthy();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  test('distinguishes an empty history from a completed search without matches', async () => {
    i18nService.setLanguage('en', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          searchSessionMessages: vi.fn().mockResolvedValue({ success: true, matches: [] }),
        },
      },
    });
    render(
      <CoworkSearchModal
        isOpen
        sessions={[]}
        currentSessionId={null}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    expect(screen.getByText('No conversations yet')).toBeTruthy();
    expect(screen.queryByText('No conversations found')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });

    expect(await screen.findByText('No conversations found')).toBeTruthy();
    expect(screen.getByText('Try a shorter keyword or a different phrase.')).toBeTruthy();
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });

  test('contains keyboard focus and restores it to the trigger on close', async () => {
    i18nService.setLanguage('en', { persist: false });
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const props = {
      sessions,
      currentSessionId: null,
      onClose: vi.fn(),
      onSelectSession: vi.fn(),
    };
    const { rerender } = render(<CoworkSearchModal {...props} isOpen />);
    const input = screen.getByRole('searchbox');
    await waitFor(() => expect(document.activeElement).toBe(input));
    const firstButton = screen.getByRole('button', { name: 'Close' });
    firstButton.focus();

    fireEvent.keyDown(firstButton, { key: 'Tab', shiftKey: true });

    expect(document.activeElement?.id).toBe('cowork-search-result-1');
    rerender(<CoworkSearchModal {...props} isOpen={false} />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  test('matches all title keywords in any order and sorts recent conversations by time', () => {
    const { input } = renderSearch(undefined, {
      sessions: [
        { ...sessions[0], title: '优化侧边栏，增加搜索按钮', pinned: true },
        { ...sessions[1], title: '只有搜索', updatedAt: 20 },
      ],
    });
    expect(
      screen
        .getAllByRole('button')
        .filter(button => button.id)
        .map(button => button.id),
    ).toEqual(['cowork-search-result-0', 'cowork-search-result-1']);
    expect(document.getElementById('cowork-search-result-0')?.textContent).toContain('只有搜索');
    fireEvent.change(input, { target: { value: '搜索   侧边栏' } });
    expect(screen.getByText('侧边栏').closest('button')?.textContent).toContain(
      '优化侧边栏，增加搜索按钮',
    );
    expect(screen.queryByText('只有搜索')).toBeNull();
  });

  test('does not navigate, close or search while the input method is composing', async () => {
    vi.useFakeTimers();
    const { input, searchSessionMessages, onSelectSession, onClose } = renderSearch();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'release' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(searchSessionMessages).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(searchSessionMessages).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(onSelectSession).toHaveBeenCalledWith('title-match');
    expect(onClose).toHaveBeenCalledOnce();
  });

  test.each([{ isComposing: true }, { keyCode: 229 }])(
    'honors native input-method keyboard flags %j',
    flags => {
      const { input, onSelectSession, onClose } = renderSearch();
      fireEvent.keyDown(input, { key: 'Enter', ...flags });
      fireEvent.keyDown(input, { key: 'Escape', ...flags });
      expect(onSelectSession).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  test('filters both title results and native message search by pin and group', async () => {
    const { input, searchSessionMessages } = renderSearch(undefined, {
      sessions: [
        { ...sessions[0], pinned: true, groupId: 'work' },
        { ...sessions[1], groupId: 'work' },
      ],
      groups: [{ id: 'work', name: 'Work', color: 'blue', sortOrder: 0, createdAt: 1 }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));
    expect(screen.queryByText('Unrelated title')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } });
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() =>
      expect(searchSessionMessages).toHaveBeenLastCalledWith('needle', {
        sessionIds: ['title-match'],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'All conversations' }));
    await waitFor(() =>
      expect(searchSessionMessages).toHaveBeenLastCalledWith('needle', {
        sessionIds: ['message-match', 'title-match'],
      }),
    );
  });

  test('loads more conversations using exclusions and keeps the native message identity on selection', async () => {
    const nativeMatch = match('message-match');
    const search = vi
      .fn()
      .mockResolvedValueOnce({ ...searchResponse([match('title-match')]), truncated: true })
      .mockResolvedValueOnce(searchResponse([nativeMatch]));
    const { input, onSelectSession, onClose } = renderSearch(search);
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more results' }));
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith('needle', {
        sessionIds: ['message-match', 'title-match'],
        excludeSessionIds: ['title-match'],
      }),
    );
    fireEvent.click((await screen.findByText('Unrelated title')).closest('button')!);
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith('message-match', nativeMatch));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull();
  });

  test('discards a late page when the query changes', async () => {
    let resolvePage!: (value: ReturnType<typeof searchResponse>) => void;
    const search = vi
      .fn()
      .mockResolvedValueOnce({ ...searchResponse([match('title-match')]), truncated: true })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolvePage = resolve;
          }),
      )
      .mockResolvedValue(searchResponse());
    const { input } = renderSearch(search);
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more results' }));
    fireEvent.change(input, { target: { value: 'missing' } });
    await act(async () => {
      resolvePage(searchResponse([match('message-match')]));
    });
    expect(await screen.findByText('No conversations found')).toBeTruthy();
    expect(screen.queryByText('Unrelated title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull();
  });

  test('separates indexing and cold archives from a failed or completed search', async () => {
    vi.useFakeTimers();
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        ...searchResponse(),
        indexing: true,
        archivedTranscriptsExcluded: 2,
      })
      .mockResolvedValue(searchResponse());
    const { input } = renderSearch(search);
    fireEvent.change(input, { target: { value: 'needle' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(
      screen.getByText('The message index is updating. Results may be incomplete.'),
    ).toBeTruthy();
    expect(
      screen.getByText('2 archived transcripts are excluded from message search.'),
    ).toBeTruthy();
    expect(screen.queryByText('No conversations found')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByText('No conversations found')).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(2);
  });

  test('keeps the dialog open if navigation is declined and prevents duplicate selection', async () => {
    let finishSelection!: (value: boolean) => void;
    const select = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finishSelection = resolve;
        }),
    );
    const { input, onClose } = renderSearch(undefined, { onSelectSession: select });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(select).toHaveBeenCalledOnce();
    await act(async () => {
      finishSelection(false);
    });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {
      finishSelection(true);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

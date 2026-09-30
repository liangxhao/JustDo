// @vitest-environment jsdom
import { MemoryIndexHealth, type MemorySearchResult } from '@shared/openclaw/memory';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import MemoryView from './MemoryView';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/libs/openclaw-chat/components/markdown', () => ({ toSanitizedMarkdownHtml: () => '' }));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));
afterEach(cleanup);

function mount(
  searchResult: MemorySearchResult = { success: true, hits: [] },
  health = MemoryIndexHealth.KeywordOnly as MemoryIndexHealth,
) {
  const memory = {
    getOverview: vi.fn().mockResolvedValue({
      success: true,
      overview: {
        documents: [],
        counts: { total: 0, profile: 0, longTerm: 0, daily: 0, dream: 0, dreaming: 0 },
        index: { available: false, chunks: 0, dirty: false, loading: true },
        loadedAt: 0,
      },
    }),
    getIndexStatus: vi.fn().mockResolvedValue({
      success: true,
      index: { available: true, chunks: 7, dirty: false, health },
    }),
    search: vi.fn().mockResolvedValue(searchResult),
    getDocument: vi.fn(),
    rebuildIndex: vi.fn().mockResolvedValue({ success: true, warning: 'Vector recall degraded.' }),
  };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: 'main', name: 'main' },
          { id: 'research', name: 'Research' },
        ]),
      },
      openclaw: { memory },
    },
  });
  render(<MemoryView isSidebarCollapsed={false} onToggleSidebar={vi.fn()} onNewChat={vi.fn()} />);
  return memory;
}

async function search() {
  await screen.findByText('memoryIndexKeywordOnly');
  fireEvent.change(screen.getByPlaceholderText('memorySearchPlaceholder'), {
    target: { value: 'preferences' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'memorySearchAction' }));
}

test('shows keyword-only health instead of semantic readiness', async () => {
  mount();
  await screen.findByText('memoryIndexKeywordOnly');
  expect(screen.queryByText('memoryIndexReady')).toBeNull();
});

test('shows stale diagnostics instead of the ordinary empty search message', async () => {
  mount({
    success: true,
    hits: [],
    stale: true,
    warning: 'Index changed',
    action: 'Rebuild the index',
    searchMode: 'fts-only',
  });
  await search();
  await screen.findByText('Index changed');
  expect(screen.getByText('Rebuild the index')).toBeTruthy();
  expect(screen.getByText('memoryIndexStale')).toBeTruthy();
  expect(screen.queryByText('memorySearchEmpty')).toBeNull();
});

test('retains session snippets without enabling unsupported file reads', async () => {
  const memory = mount({
    success: true,
    hits: [
      {
        path: 'sessions/test.jsonl',
        source: 'sessions',
        previewable: false,
        snippet: 'Remembered preference',
        startLine: 1,
        endLine: 2,
        score: 0.7,
      },
    ],
  });
  await search();
  const hit = await screen.findByRole('button', { name: /Remembered preference/ });
  expect(hit.hasAttribute('disabled')).toBe(true);
  fireEvent.click(hit);
  expect(memory.getDocument).not.toHaveBeenCalled();
  expect(screen.getByText(/memorySourceSession/)).toBeTruthy();
});

test('shows rebuild warnings without the unqualified success notice', async () => {
  const memory = mount();
  await screen.findByText('memoryIndexKeywordOnly');
  fireEvent.click(screen.getByRole('button', { name: 'memoryRebuild' }));
  await screen.findByText(/memoryRebuildDegraded.*Vector recall degraded/);
  await waitFor(() => expect(memory.getOverview).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('memoryRebuildSucceeded')).toBeNull();
});

test('describes complete stored vectors without asserting live semantic readiness', async () => {
  mount(undefined, MemoryIndexHealth.Indexed);
  await screen.findByText('memoryIndexStored');
  expect(screen.queryByText('memoryIndexReady')).toBeNull();
  expect(screen.queryByText('memoryIndexUnknown')).toBeNull();
});

test('scopes overview, search and rebuild to the selected assistant', async () => {
  const memory = mount();
  await screen.findByRole('option', { name: 'Research' });
  fireEvent.change(screen.getByRole('combobox', { name: 'memoryAssistant' }), {
    target: { value: 'research' },
  });
  await waitFor(() => expect(memory.getOverview).toHaveBeenCalledWith('research'));
  await waitFor(() => expect(memory.getIndexStatus).toHaveBeenCalledWith('research'));
  await search();
  await waitFor(() => expect(memory.search).toHaveBeenCalledWith('preferences', 'research'));
  fireEvent.click(screen.getByRole('button', { name: 'memoryRebuild' }));
  await waitFor(() => expect(memory.rebuildIndex).toHaveBeenCalledWith('research'));
});

test('discards pending search results when switching assistants', async () => {
  const memory = mount();
  let finish!: (result: MemorySearchResult) => void;
  memory.search.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await search();
  await screen.findByRole('option', { name: 'Research' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'research' } });
  await waitFor(() => expect(memory.getOverview).toHaveBeenCalledWith('research'));
  await act(async () =>
    finish({
      success: true,
      hits: [
        { path: 'MEMORY.md', snippet: 'Old assistant secret', startLine: 1, endLine: 1, score: 1 },
      ],
    }),
  );
  expect(screen.queryByText('Old assistant secret')).toBeNull();
  expect((screen.getByPlaceholderText('memorySearchPlaceholder') as HTMLInputElement).value).toBe(
    '',
  );
});

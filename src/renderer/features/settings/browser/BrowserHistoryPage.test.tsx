// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import BrowserHistoryPage, { browserHistoryDateKey } from './BrowserHistoryPage';

const entries = [
  {
    url: 'https://example.com/docs',
    title: 'Example Docs',
    lastVisitAt: new Date('2026-09-15T12:10:00').getTime(),
    visitCount: 2,
  },
  {
    url: 'https://github.com/login',
    title: 'Sign in to GitHub',
    lastVisitAt: new Date('2026-09-14T11:10:00').getTime(),
    visitCount: 1,
  },
];
const listHistory = vi.fn(async (query = '') => ({
  success: true,
  entries: entries.filter(
    entry => !query || entry.title.toLowerCase().includes(query.toLowerCase()),
  ),
}));
const deleteHistory = vi.fn().mockResolvedValue({ success: true });
const clearHistory = vi.fn().mockResolvedValue({ success: true });

describe('BrowserHistoryPage', () => {
  it('groups history by the local calendar date instead of UTC', () => {
    const timestamp = new Date(2026, 8, 15, 1, 30).getTime();
    expect(browserHistoryDateKey(timestamp)).toBe('2026-09-15');
  });

  beforeEach(() => {
    i18nService.setLanguage('en', { persist: false });
    listHistory.mockClear();
    deleteHistory.mockClear();
    clearHistory.mockClear();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { browser: { listHistory, deleteHistory, clearHistory } },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('groups, searches, selects, and deletes browser history', async () => {
    render(<BrowserHistoryPage onBack={vi.fn()} />);
    expect(await screen.findByText('Example Docs')).toBeTruthy();
    expect(screen.getByText('Sign in to GitHub')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search browsing history'), {
      target: { value: 'github' },
    });
    await waitFor(() => expect(listHistory).toHaveBeenLastCalledWith('github'));

    fireEvent.click(screen.getByLabelText('Select Sign in to GitHub'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith(['https://github.com/login']));
  });

  it('requires a second click before clearing all history', async () => {
    render(<BrowserHistoryPage onBack={vi.fn()} />);
    await screen.findByText('Example Docs');
    fireEvent.click(screen.getByRole('button', { name: 'Clear browsing data' }));
    expect(clearHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Click again to clear' }));
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());
  });
});

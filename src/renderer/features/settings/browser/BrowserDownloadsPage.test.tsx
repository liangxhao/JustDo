// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import BrowserDownloadsPage from './BrowserDownloadsPage';

const completedEntry = {
  id: 'download-1',
  fileName: 'report.pdf',
  sourceUrl: 'https://example.com/report.pdf',
  state: 'completed' as const,
  receivedBytes: 2048,
  totalBytes: 2048,
  startedAt: new Date('2026-09-15T12:00:00').getTime(),
  updatedAt: new Date('2026-09-15T12:01:00').getTime(),
};
const listDownloads = vi.fn(async (query = '') => ({
  success: true,
  entries: query
    ? [completedEntry].filter(entry => entry.fileName.includes(query))
    : [completedEntry],
}));
const deleteDownloads = vi.fn().mockResolvedValue({ success: true });
const clearDownloads = vi.fn().mockResolvedValue({ success: true });
const openDownload = vi.fn().mockResolvedValue({ success: true });
const revealDownload = vi.fn().mockResolvedValue({ success: true });

describe('BrowserDownloadsPage', () => {
  beforeEach(() => {
    i18nService.setLanguage('en', { persist: false });
    vi.clearAllMocks();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        browser: {
          listDownloads,
          deleteDownloads,
          clearDownloads,
          openDownload,
          revealDownload,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('searches and exposes real completed-download actions', async () => {
    render(<BrowserDownloadsPage onBack={vi.fn()} />);
    expect(await screen.findByText('report.pdf')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => {
      expect(openDownload).toHaveBeenCalledWith('download-1');
      expect(revealDownload).toHaveBeenCalledWith('download-1');
    });

    fireEvent.change(screen.getByLabelText('Search download history'), {
      target: { value: 'report' },
    });
    await waitFor(() => expect(listDownloads).toHaveBeenLastCalledWith('report'));
  });

  it('deletes records and requires confirmation before clearing all', async () => {
    render(<BrowserDownloadsPage onBack={vi.fn()} />);
    await screen.findByText('report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Delete this download record' }));
    await waitFor(() => expect(deleteDownloads).toHaveBeenCalledWith(['download-1']));

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(clearDownloads).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Click again to clear' }));
    await waitFor(() => expect(clearDownloads).toHaveBeenCalledOnce());
  });

  it('shows the download-specific empty state', async () => {
    listDownloads.mockResolvedValueOnce({ success: true, entries: [] });
    render(<BrowserDownloadsPage onBack={vi.fn()} />);
    expect(await screen.findByText('No downloads yet')).toBeTruthy();
    expect(screen.getByText('Files downloaded from the built-in browser appear here')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear all' }).hasAttribute('disabled')).toBe(true);
  });
});

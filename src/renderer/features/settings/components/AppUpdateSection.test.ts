// @vitest-environment jsdom

import type { AppUpdateState } from '@shared/appUpdate';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import AppUpdateSection from './AppUpdateSection';

const appUpdateMocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  getReleaseHistory: vi.fn(),
  getState: vi.fn(),
  onStateChanged: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    getLanguage: () => 'en',
    t: (key: string) => key,
  },
}));

vi.mock('@/libs/openclaw-chat/components/markdown', () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

const updateState = (phase: AppUpdateState['phase']): AppUpdateState => ({
  revision: 1,
  phase,
  currentVersion: 'v2026.8.10',
  availableVersion: phase === 'available' ? 'v2026.8.11' : undefined,
});

describe('AppUpdateSection', () => {
  beforeEach(() => {
    for (const mock of Object.values(appUpdateMocks)) mock.mockReset();
    appUpdateMocks.onStateChanged.mockReturnValue(vi.fn());
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { appUpdate: appUpdateMocks },
    });
  });

  afterEach(cleanup);

  test('does not check or download merely because the Help page was opened', async () => {
    appUpdateMocks.getState.mockResolvedValue(updateState('available'));
    appUpdateMocks.download.mockResolvedValue({
      success: true,
      state: updateState('downloading'),
    });
    render(React.createElement(AppUpdateSection));

    const downloadButton = await screen.findByRole('button', { name: 'appUpdateDownload' });
    expect(appUpdateMocks.getState).toHaveBeenCalledOnce();
    expect(appUpdateMocks.check).not.toHaveBeenCalled();
    expect(appUpdateMocks.download).not.toHaveBeenCalled();

    fireEvent.click(downloadButton);
    await waitFor(() => expect(appUpdateMocks.download).toHaveBeenCalledOnce());
  });

  test('still supports an explicit manual update check', async () => {
    appUpdateMocks.getState.mockResolvedValue(updateState('idle'));
    appUpdateMocks.check.mockResolvedValue(updateState('up-to-date'));
    render(React.createElement(AppUpdateSection));

    const checkButton = await screen.findByRole('button', { name: 'appUpdateCheck' });
    expect(appUpdateMocks.check).not.toHaveBeenCalled();
    fireEvent.click(checkButton);
    await waitFor(() => expect(appUpdateMocks.check).toHaveBeenCalledOnce());
  });

  test('loads release history only after the user requests it', async () => {
    appUpdateMocks.getState.mockResolvedValue({
      ...updateState('available'),
      releaseNotes: 'Latest notes',
    });
    appUpdateMocks.getReleaseHistory.mockResolvedValue({
      success: true,
      history: {
        schemaVersion: 1,
        latestVersion: '2026.8.11',
        releases: [
          {
            version: '2026.8.11',
            releaseDate: '2026-08-11T00:00:00.000Z',
            releaseNotes: 'Historical notes',
          },
          {
            version: '2026.8.10',
            releaseDate: '2026-08-10T00:00:00.000Z',
            releaseNotes: 'Older notes',
          },
        ],
      },
    });
    render(React.createElement(AppUpdateSection));

    await screen.findByText('Latest notes');
    const historyButton = await screen.findByRole('button', {
      name: 'appUpdateViewReleaseHistory',
    });
    expect(appUpdateMocks.getReleaseHistory).not.toHaveBeenCalled();
    historyButton.focus();
    fireEvent.click(historyButton);

    await waitFor(() => expect(appUpdateMocks.getReleaseHistory).toHaveBeenCalledOnce());
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByText('Historical notes')).toBeTruthy();
    expect(screen.queryByText('Older notes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /v2026\.8\.10/ }));
    expect(await screen.findByText('Older notes')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(historyButton);

    fireEvent.click(historyButton);
    await waitFor(() => expect(appUpdateMocks.getReleaseHistory).toHaveBeenCalledTimes(2));
  });
});

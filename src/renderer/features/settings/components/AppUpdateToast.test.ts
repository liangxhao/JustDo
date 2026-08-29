// @vitest-environment jsdom

import type { AppUpdateState } from '@shared/appUpdate';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AppUpdateToast from './AppUpdateToast';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

const state = (
  phase: AppUpdateState['phase'],
  overrides: Partial<AppUpdateState> = {},
): AppUpdateState => ({
  revision: 1,
  phase,
  currentVersion: 'v2026.8.10',
  availableVersion: 'v2026.8.11',
  ...overrides,
});

const renderToast = (overrides: Partial<React.ComponentProps<typeof AppUpdateToast>> = {}) => {
  const props: React.ComponentProps<typeof AppUpdateToast> = {
    state: state('available'),
    installing: false,
    installError: false,
    onDownload: vi.fn(),
    onInstall: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  return { ...render(React.createElement(AppUpdateToast, props)), props };
};

describe('AppUpdateToast', () => {
  afterEach(cleanup);

  test('offers a compact download action without downloading automatically', () => {
    const { container, props } = renderToast();

    const status = screen.getByRole('status');
    expect(status.classList.contains('h-8')).toBe(true);
    expect(status.classList.contains('rounded-full')).toBe(true);
    expect(status.textContent).toContain('v2026.8.11');
    expect(container.querySelector('.fixed')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'appUpdateDownload' }));
    expect(props.onDownload).toHaveBeenCalledOnce();
    expect(props.onInstall).not.toHaveBeenCalled();
  });

  test('keeps the notice open and busy while the user-requested download is running', () => {
    const { props } = renderToast({
      state: state('downloading', { downloadPercent: 42 }),
    });

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('42%');
    const actionButton = screen.getByRole('button', {
      name: 'appUpdateStatusDownloading',
    }) as HTMLButtonElement;
    const dismissButton = screen.getByRole('button', {
      name: 'appUpdateLater',
    }) as HTMLButtonElement;
    expect(actionButton.disabled).toBe(true);
    expect(dismissButton.disabled).toBe(true);
    fireEvent.click(dismissButton);
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  test('offers restart and install only after the download completes', () => {
    const { props } = renderToast({ state: state('downloaded') });

    fireEvent.click(screen.getByRole('button', { name: 'appUpdateRestartAndInstall' }));
    expect(props.onInstall).toHaveBeenCalledOnce();
    expect(props.onDownload).not.toHaveBeenCalled();
  });

  test('keeps download failures visible and retryable', () => {
    const { props } = renderToast({
      state: state('error', { errorCode: 'DOWNLOAD_FAILED' }),
    });

    expect(screen.getByRole('status').textContent).toContain('appUpdateStatusDownloadError');
    fireEvent.click(screen.getByRole('button', { name: 'appUpdateDownload' }));
    expect(props.onDownload).toHaveBeenCalledOnce();
  });
});

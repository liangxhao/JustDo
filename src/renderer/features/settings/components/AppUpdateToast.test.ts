// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AppUpdateToast from './AppUpdateToast';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

describe('AppUpdateToast', () => {
  afterEach(cleanup);

  test('renders a compact non-modal update reminder', () => {
    const onDismiss = vi.fn();
    const onInstall = vi.fn();
    const { container } = render(
      React.createElement(AppUpdateToast, {
        availableVersion: 'v2026.8.11',
        installing: false,
        installError: false,
        onInstall,
        onDismiss,
      }),
    );

    const status = screen.getByRole('status');
    expect(status.classList.contains('h-8')).toBe(true);
    expect(status.classList.contains('rounded-full')).toBe(true);
    expect(status.classList.contains('shadow-subtle')).toBe(true);
    expect(status.textContent).toContain('v2026.8.11');
    expect(container.querySelector('.fixed')).toBeNull();
    expect(container.querySelector('.shadow-xl')).toBeNull();
    expect(container.querySelector('.backdrop-blur-md')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'appUpdateRestartAndInstall' }));
    fireEvent.click(screen.getByRole('button', { name: 'appUpdateLater' }));
    expect(onInstall).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test('keeps the notice open and exposes a busy state while installation starts', () => {
    const onDismiss = vi.fn();
    render(
      React.createElement(AppUpdateToast, {
        availableVersion: 'v2026.8.11',
        installing: true,
        installError: false,
        onInstall: vi.fn(),
        onDismiss,
      }),
    );

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    const installButton = screen.getByRole('button', {
      name: 'appUpdateRestartAndInstall',
    }) as HTMLButtonElement;
    expect(installButton.disabled).toBe(true);
    const dismissButton = screen.getByRole('button', {
      name: 'appUpdateLater',
    }) as HTMLButtonElement;
    expect(dismissButton.disabled).toBe(true);
    fireEvent.click(dismissButton);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('shows a retryable error without losing the compact layout', () => {
    render(
      React.createElement(AppUpdateToast, {
        availableVersion: 'v2026.8.11',
        installing: false,
        installError: true,
        onInstall: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('appUpdateStatusInstallError');
    expect(status.classList.contains('h-8')).toBe(true);
    const installButton = screen.getByRole('button', {
      name: 'appUpdateRestartAndInstall',
    }) as HTMLButtonElement;
    const dismissButton = screen.getByRole('button', {
      name: 'appUpdateLater',
    }) as HTMLButtonElement;
    expect(installButton.disabled).toBe(false);
    expect(dismissButton.disabled).toBe(false);
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WindowsSandboxSettingsTab from './WindowsSandboxSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

afterEach(cleanup);

describe('Windows sandbox mode switching', () => {
  it('waits for verified saving and unlocks without another sandbox probe', async () => {
    let finishSave!: (result: { success: boolean }) => void;
    const setConfig = vi.fn(
      () =>
        new Promise(resolve => {
          finishSave = resolve;
        }),
    );
    const getWindowsSandboxStatus = vi.fn(async () => ({ code: 'ready', ready: true }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          setConfig,
          getWindowsSandboxStatus,
          getConfig: vi.fn(async () => ({
            success: true,
            config: { executionMode: 'local', sandboxNetworkEnabled: false },
          })),
        },
      },
    });
    render(<WindowsSandboxSettingsTab />);
    const sandbox = screen.getByRole('radio', { name: /windowsSandboxMode/ }) as HTMLInputElement;
    await waitFor(() => expect(sandbox.disabled).toBe(false));

    fireEvent.click(sandbox);
    expect(sandbox.checked).toBe(false);
    expect(sandbox.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('windowsSandboxSwitching');
    await act(async () => finishSave({ success: true }));

    expect(sandbox.checked).toBe(true);
    expect(sandbox.disabled).toBe(false);
    expect(getWindowsSandboxStatus).toHaveBeenCalledTimes(1);
    expect(setConfig).toHaveBeenCalledWith({ executionMode: 'sandbox' });
  });

  it('keeps the previous mode when the main process rejects the change', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          setConfig: vi.fn(async () => ({ success: false, error: 'Reload failed' })),
          getWindowsSandboxStatus: vi.fn(async () => ({ code: 'ready', ready: true })),
          getConfig: vi.fn(async () => ({
            success: true,
            config: { executionMode: 'sandbox', sandboxNetworkEnabled: false },
          })),
        },
      },
    });
    render(<WindowsSandboxSettingsTab />);
    const sandbox = screen.getByRole('radio', { name: /windowsSandboxMode/ }) as HTMLInputElement;
    await waitFor(() => expect(sandbox.checked).toBe(true));

    fireEvent.click(screen.getByRole('radio', { name: /windowsSandboxLocalMode/ }));
    await screen.findByText('Reload failed');

    expect(sandbox.checked).toBe(true);
    expect(sandbox.disabled).toBe(false);
  });
});

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

describe('Windows sandbox readiness recovery', () => {
  const setup = (status: Record<string, unknown>) => {
    const cowork = {
      getWindowsSandboxStatus: vi.fn(async () => status),
      getConfig: vi.fn(async () => ({
        success: true,
        config: { executionMode: 'local', sandboxNetworkEnabled: false },
      })),
      initializeWindowsSandbox: vi.fn(async () => ({
        success: true,
        status: { code: 'ready', ready: true },
      })),
      openWindowsSandboxDiagnostics: vi.fn(
        async (): Promise<{ success: boolean; error?: string }> => ({ success: true }),
      ),
    };
    Object.defineProperty(window, 'electron', { configurable: true, value: { cowork } });
    render(<WindowsSandboxSettingsTab />);
    return cowork;
  };

  it('shows the native failure and opens diagnostics while keeping sandbox execution disabled', async () => {
    const cowork = setup({
      code: 'check_failed',
      supported: true,
      helperAvailable: true,
      ready: false,
      diagnosticsPath: 'C:/runtime/mxc',
      error: 'MXC host probe did not select an isolation tier.',
    });

    await screen.findByText('MXC host probe did not select an isolation tier.');
    expect(screen.getByText('windowsSandboxCheckFailedHelp')).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: /windowsSandboxMode/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'windowsSandboxInitialize' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'windowsSandboxOpenDiagnostics' }));
    await waitFor(() => expect(cowork.openWindowsSandboxDiagnostics).toHaveBeenCalledOnce());
    expect(cowork.initializeWindowsSandbox).not.toHaveBeenCalled();
  });

  it('shows a diagnostics opening failure without hiding the native failure', async () => {
    const cowork = setup({
      code: 'check_failed',
      ready: false,
      diagnosticsPath: 'C:/runtime/mxc',
      error: 'Native probe failed',
    });
    cowork.openWindowsSandboxDiagnostics.mockResolvedValue({
      success: false,
      error: 'Folder unavailable',
    });

    fireEvent.click(await screen.findByRole('button', { name: 'windowsSandboxOpenDiagnostics' }));

    await screen.findByText('Folder unavailable');
    expect(screen.getByText('Native probe failed')).toBeTruthy();
  });

  it('explains how to restore missing components without offering system drive preparation', async () => {
    setup({ code: 'plugin_missing', supported: true, helperAvailable: false, ready: false });

    await screen.findByText('windowsSandboxPluginMissingHelp');

    expect(screen.queryByRole('button', { name: 'windowsSandboxInitialize' })).toBeNull();
    expect(
      (screen.getByRole('radio', { name: /windowsSandboxMode/ }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('retains optional host preparation for a usable sandbox', async () => {
    const cowork = setup({
      code: 'host_preparation_recommended',
      supported: true,
      helperAvailable: true,
      ready: true,
      hostPreparationRecommended: true,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'windowsSandboxInitialize' }));

    await screen.findByText('windowsSandboxStatus_ready');
    expect(cowork.initializeWindowsSandbox).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'windowsSandboxInitialize' })).toBeNull();
  });

  it('offers verified preparation while keeping a failed sandbox disabled until rechecking succeeds', async () => {
    const cowork = setup({
      code: 'check_failed',
      supported: true,
      helperAvailable: true,
      ready: false,
      hostPreparationRecommended: true,
      error: 'Process startup failed',
    });

    await screen.findByText('Process startup failed');
    const sandbox = screen.getByRole('radio', { name: /windowsSandboxMode/ }) as HTMLInputElement;
    expect(sandbox.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'windowsSandboxInitialize' }));

    await screen.findByText('windowsSandboxStatus_ready');
    expect(cowork.initializeWindowsSandbox).toHaveBeenCalledOnce();
    expect(sandbox.disabled).toBe(false);
  });

  it('reports refresh failures and allows another refresh to recover', async () => {
    const cowork = setup({ code: 'ready', ready: true });
    await screen.findByText('windowsSandboxStatus_ready');
    cowork.getWindowsSandboxStatus.mockRejectedValueOnce(new Error('Status check failed'));

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await screen.findByText('Status check failed');
    cowork.getWindowsSandboxStatus.mockResolvedValue({
      code: 'check_failed',
      ready: false,
      error: 'Native failure',
    });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));

    await screen.findByText('Native failure');
    expect(screen.queryByText('Status check failed')).toBeNull();
  });
});

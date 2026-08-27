// @vitest-environment jsdom

import {
  type BrowserConnectionStatus,
  type BrowserConnectionTestResult,
  BrowserMode,
} from '@shared/browser';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';

import BrowserSettingsTab, { extensionConnectionErrorMessage } from './BrowserSettingsTab';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  reloadFromStore: vi.fn(),
  translate: vi.fn((key: string) => key),
}));

vi.mock('@/services/config', () => ({
  configService: {
    getConfig: mocks.getConfig,
    reloadFromStore: mocks.reloadFromStore,
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: { t: mocks.translate },
}));

const disconnectedChromeStatus: BrowserConnectionStatus = {
  supported: true,
  chromeFound: true,
  remoteDebuggingEnabled: false,
  activePort: null,
  activePortFileExists: false,
  activePortOwnerResolved: true,
  activePortOwner: null,
  endpointReachable: false,
  issue: 'remote-debugging-disabled',
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const installElectronBrowserMock = (overrides: Record<string, unknown> = {}) => {
  let engineProgressListener: ((status: OpenClawEngineStatus) => void) | null = null;
  const browser = {
    getStatus: vi.fn().mockResolvedValue({ success: true, status: disconnectedChromeStatus }),
    canSetMode: vi.fn().mockResolvedValue({ success: true, canSwitch: true }),
    setMode: vi.fn().mockImplementation(async (mode: BrowserMode) => ({ success: true, mode })),
    openRemoteDebugging: vi.fn(),
    testConnection: vi.fn(),
    openExtensionManagement: vi.fn(),
    revealExtension: vi.fn(),
    copyExtensionPairing: vi.fn(),
    testExtensionConnection: vi.fn(),
    emitEngineProgress: (status: OpenClawEngineStatus) => engineProgressListener?.(status),
    ...overrides,
  };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      browser,
      openclaw: {
        engine: {
          onProgress: vi.fn((callback: (status: OpenClawEngineStatus) => void) => {
            engineProgressListener = callback;
            return () => {
              engineProgressListener = null;
            };
          }),
        },
      },
    },
  });
  return browser;
};

describe('extension connection error messages', () => {
  test.each([
    ['gateway-unavailable', 'browserExtensionRelayUnavailable'],
    ['extension-relay-unavailable', 'browserExtensionRelayUnavailable'],
    ['extension-pairing-mismatch', 'browserExtensionPairingMismatch'],
    ['extension-relay-port-conflict', 'browserExtensionRelayPortConflict'],
    ['extension-browser-service-failed', 'browserExtensionBrowserServiceFailed'],
    ['extension-not-connected', 'browserExtensionNotConnected'],
    ['connection-failed', 'browserExtensionRelayUnavailable'],
  ] as const)('maps %s to %s', (errorCode, expected) => {
    expect(extensionConnectionErrorMessage({ success: false, errorCode })).toBe(expected);
  });

  test('formats relay port and owner details', () => {
    mocks.translate.mockImplementation(key =>
      key === 'browserExtensionRelayPortConflict' ? '{port} / {owner}' : key,
    );
    const result: BrowserConnectionTestResult = {
      success: false,
      errorCode: 'extension-relay-port-conflict',
      relayPort: 42881,
      relayPortOwner: { pid: 321, processName: 'other.exe', isChrome: false },
    };

    expect(extensionConnectionErrorMessage(result)).toBe('42881 / other.exe (PID 321)');
    mocks.translate.mockImplementation((key: string) => key);
  });
});

describe('BrowserSettingsTab extension connection checks', () => {
  beforeEach(() => {
    mocks.getConfig.mockReturnValue({ browserMode: BrowserMode.Extension });
    mocks.reloadFromStore.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test('checks automatically without locking setup controls or losing success to Chrome status', async () => {
    const status = deferred<{ success: true; status: BrowserConnectionStatus }>();
    const extension = deferred<{ success: true }>();
    const browser = installElectronBrowserMock({
      getStatus: vi.fn(() => status.promise),
      testExtensionConnection: vi.fn(() => extension.promise),
    });

    render(<BrowserSettingsTab />);

    await waitFor(() => expect(browser.testExtensionConnection).toHaveBeenCalledTimes(1));
    expect(
      (
        screen.getByRole('button', {
          name: 'browserExtensionTestConnection',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('radio', { name: /browserModeIsolatedTitle/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole('button', {
          name: 'browserExtensionRevealFolder',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole('button', {
          name: 'browserExtensionCopyPairing',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    await act(async () => extension.resolve({ success: true }));
    await waitFor(() => expect(screen.getByText('browserConnectionVerified')).toBeTruthy());

    await act(async () => status.resolve({ success: true, status: disconnectedChromeStatus }));
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'browserExtensionOpenPage',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test('discards a pending extension result after switching browser modes', async () => {
    const first = deferred<{ success: true }>();
    const second = deferred<{ success: true }>();
    const testExtensionConnection = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const browser = installElectronBrowserMock({
      testExtensionConnection,
    });

    render(<BrowserSettingsTab />);
    await waitFor(() => expect(testExtensionConnection).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('radio', { name: /browserModeIsolatedTitle/ }));
    await waitFor(() => expect(screen.getByText('browserModeIsolatedActive')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: /browserModeExtensionTitle/ }));
    await waitFor(() => expect(testExtensionConnection).toHaveBeenCalledTimes(2));

    await act(async () => first.resolve({ success: true }));
    expect(screen.queryByText('browserConnectionVerified')).toBeNull();
    expect(browser.setMode).toHaveBeenNthCalledWith(1, BrowserMode.Isolated);
    expect(browser.setMode).toHaveBeenNthCalledWith(2, BrowserMode.Extension);
  });

  test('renders the selected mode immediately and reports Gateway restart with a compact spinner', async () => {
    mocks.getConfig.mockReturnValue({ browserMode: BrowserMode.Isolated });
    const modeChange = deferred<{ success: true; mode: typeof BrowserMode.User }>();
    const browser = installElectronBrowserMock({
      setMode: vi.fn(() => modeChange.promise),
    });

    render(<BrowserSettingsTab />);
    fireEvent.click(screen.getByRole('radio', { name: /browserModeUserTitle/ }));

    await waitFor(() => expect(browser.setMode).toHaveBeenCalledWith(BrowserMode.User));
    expect(
      screen.getByRole('radio', { name: /browserModeUserTitle/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByText('browserModeApplying')).toBeTruthy();

    act(() => {
      browser.emitEngineProgress({
        phase: 'starting',
        version: null,
        canRetry: false,
      });
    });
    expect(screen.getByText('browserModeGatewayRestarting')).toBeTruthy();
    expect(screen.queryByText('42%')).toBeNull();
    expect(
      screen
        .getByText('browserModeGatewayRestarting')
        .closest('[role="status"]')
        ?.querySelector('.animate-spin'),
    ).toBeTruthy();

    await act(async () => modeChange.resolve({ success: true, mode: BrowserMode.User }));
    await waitFor(() => expect(screen.getByText('browserModeChangeComplete')).toBeTruthy());
  });

  test('keeps the current mode and warns when an active session blocks switching', async () => {
    mocks.getConfig.mockReturnValue({ browserMode: BrowserMode.Isolated });
    const browser = installElectronBrowserMock({
      canSetMode: vi.fn().mockResolvedValue({
        success: true,
        canSwitch: false,
        errorCode: 'active-session',
      }),
    });

    render(<BrowserSettingsTab />);
    fireEvent.click(screen.getByRole('radio', { name: /browserModeUserTitle/ }));

    await waitFor(() => expect(screen.getByText('browserModeActiveSessionWarning')).toBeTruthy());
    expect(
      screen.getByRole('radio', { name: /browserModeIsolatedTitle/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.queryByText('browserModeApplying')).toBeNull();
    expect(mocks.reloadFromStore).not.toHaveBeenCalled();
    expect(browser.setMode).not.toHaveBeenCalled();
  });

  test('restores the current mode if a session starts after the availability check', async () => {
    mocks.getConfig.mockReturnValue({ browserMode: BrowserMode.Isolated });
    const browser = installElectronBrowserMock({
      setMode: vi.fn().mockResolvedValue({
        success: false,
        mode: BrowserMode.Isolated,
        errorCode: 'active-session',
      }),
    });

    render(<BrowserSettingsTab />);
    fireEvent.click(screen.getByRole('radio', { name: /browserModeUserTitle/ }));

    await waitFor(() => expect(screen.getByText('browserModeActiveSessionWarning')).toBeTruthy());
    expect(
      screen.getByRole('radio', { name: /browserModeIsolatedTitle/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(browser.canSetMode).toHaveBeenCalledOnce();
    expect(browser.setMode).toHaveBeenCalledOnce();
  });

  test('retries a transient cold-start failure during the automatic connection check', async () => {
    vi.useFakeTimers();
    const testExtensionConnection = vi
      .fn()
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: true });
    installElectronBrowserMock({ testExtensionConnection });

    render(<BrowserSettingsTab />);
    await act(async () => {});

    expect(testExtensionConnection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(testExtensionConnection).toHaveBeenCalledTimes(2);
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('keeps retrying through the extension maximum reconnect backoff', async () => {
    vi.useFakeTimers();
    const results = [
      ...Array.from({ length: 6 }, () => ({
        success: false as const,
        errorCode: 'extension-not-connected',
      })),
      { success: true as const },
    ];
    const testExtensionConnection = vi
      .fn()
      .mockImplementation(() => Promise.resolve(results.shift()!));
    installElectronBrowserMock({ testExtensionConnection });

    render(<BrowserSettingsTab />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_500);
    });

    expect(testExtensionConnection).toHaveBeenCalledTimes(7);
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('reports a transient automatic failure after exhausting retries', async () => {
    vi.useFakeTimers();
    const testExtensionConnection = vi.fn().mockResolvedValue({
      success: false,
      errorCode: 'extension-not-connected',
    });
    installElectronBrowserMock({ testExtensionConnection });

    render(<BrowserSettingsTab />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_500);
    });

    expect(testExtensionConnection).toHaveBeenCalledTimes(7);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('browserConnectionVerified')).toBeNull();
  });

  test('lets a manual test take over an automatic retry and wait for a delayed reconnect', async () => {
    vi.useFakeTimers();
    const testExtensionConnection = vi
      .fn()
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: true });
    installElectronBrowserMock({ testExtensionConnection });

    render(<BrowserSettingsTab />);
    await act(async () => {});

    const testButton = screen.getByRole('button', {
      name: 'browserExtensionTestConnection',
    }) as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(testButton);
    });

    expect(testExtensionConnection).toHaveBeenCalledTimes(2);
    expect(testButton.disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_500);
    });
    expect(testExtensionConnection).toHaveBeenCalledTimes(6);
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();
    expect(testButton.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('keeps retrying after a manual test takes over', async () => {
    vi.useFakeTimers();
    const testExtensionConnection = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' })
      .mockResolvedValueOnce({ success: true });
    installElectronBrowserMock({ testExtensionConnection });

    render(<BrowserSettingsTab />);
    await act(async () => {});
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'browserExtensionTestConnection' }));
    await act(async () => {});

    expect(testExtensionConnection).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(testExtensionConnection).toHaveBeenCalledTimes(3);
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('keeps the latest StrictMode result when the first effect resolves late', async () => {
    const first = deferred<{ success: true }>();
    const second = deferred<{ success: false }>();
    const testExtensionConnection = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    installElectronBrowserMock({ testExtensionConnection });

    render(
      <StrictMode>
        <BrowserSettingsTab />
      </StrictMode>,
    );
    await waitFor(() => expect(testExtensionConnection).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve({ success: false }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    await act(async () => first.resolve({ success: true }));
    expect(screen.queryByText('browserConnectionVerified')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

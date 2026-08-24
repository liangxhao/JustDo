// @vitest-environment jsdom

import { type BrowserConnectionStatus, BrowserMode } from '@shared/browser';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import BrowserSettingsTab from './BrowserSettingsTab';

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
  const browser = {
    getStatus: vi.fn().mockResolvedValue({ success: true, status: disconnectedChromeStatus }),
    setMode: vi.fn().mockImplementation(async (mode: BrowserMode) => ({ success: true, mode })),
    openRemoteDebugging: vi.fn(),
    testConnection: vi.fn(),
    openExtensionManagement: vi.fn(),
    revealExtension: vi.fn(),
    copyExtensionPairing: vi.fn(),
    testExtensionConnection: vi.fn(),
    ...overrides,
  };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser },
  });
  return browser;
};

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

  test('lets a manual test replace an automatic retry wait', async () => {
    vi.useFakeTimers();
    const testExtensionConnection = vi
      .fn()
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
    expect(screen.getByText('browserConnectionVerified')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(testExtensionConnection).toHaveBeenCalledTimes(2);
  });

  test('keeps a manual extension connection test immediate', async () => {
    const testExtensionConnection = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, errorCode: 'extension-not-connected' });
    installElectronBrowserMock({ testExtensionConnection });

    render(<BrowserSettingsTab />);
    await waitFor(() => expect(screen.getByText('browserConnectionVerified')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'browserExtensionTestConnection' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(testExtensionConnection).toHaveBeenCalledTimes(2);
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

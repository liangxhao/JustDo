import { ipcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { BrowserIpc, BrowserMode } from '../../../shared/browser/browser';
import {
  applyBrowserModeChange,
  getBrowserModeSwitchAvailability,
  parseLsofPortOwner,
  parseWindowsNetstatListeningPid,
  parseWindowsTasklistProcessName,
  registerBrowserHandlers,
  testBrowserConnection,
} from './browser';

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(), isPackaged: false },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openPath: vi.fn() },
}));

const { loadHistoryFavicon } = vi.hoisted(() => ({ loadHistoryFavicon: vi.fn() }));
vi.mock('../../browser/history/browserHistoryFavicon', () => ({
  loadBrowserHistoryFavicon: loadHistoryFavicon,
}));

test('limits history icon loading to the main application frame and forwards stored-page requests', async () => {
  const handle = vi.mocked(ipcMain.handle);
  handle.mockClear();
  loadHistoryFavicon.mockClear();
  registerBrowserHandlers({
    getGatewayClient: () => null,
    hasActiveSessions: () => false,
    setBrowserMode: vi.fn(),
  });
  const handler = handle.mock.calls.find(
    ([channel]) => channel === BrowserIpc.LoadHistoryFavicon,
  )?.[1];
  expect(handler).toBeTruthy();
  const mainFrame = {};
  for (const event of [
    { sender: { getType: () => 'webview', mainFrame }, senderFrame: mainFrame },
    { sender: { getType: () => 'window', mainFrame }, senderFrame: {} },
  ]) {
    expect(
      await handler!(event as Electron.IpcMainInvokeEvent, 'https://example.com/', false),
    ).toEqual({ success: false, errorCode: 'invalid_request' });
  }
  expect(loadHistoryFavicon).not.toHaveBeenCalled();
  loadHistoryFavicon.mockResolvedValue({
    success: true,
    dataUrl: 'data:image/png;base64,aWNvbg==',
  });
  const event = { sender: { getType: () => 'window', mainFrame }, senderFrame: mainFrame };
  expect(
    await handler!(event as Electron.IpcMainInvokeEvent, 'https://example.com/', true),
  ).toEqual({ success: true, dataUrl: 'data:image/png;base64,aWNvbg==' });
  expect(loadHistoryFavicon).toHaveBeenCalledWith('https://example.com/', true);
});

describe('applyBrowserModeChange', () => {
  test('persists the embedded browser mode', async () => {
    let config: Record<string, unknown> = { browserMode: BrowserMode.Isolated };
    const result = await applyBrowserModeChange(BrowserMode.Embedded, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig: vi.fn().mockResolvedValue({ success: true }),
    });

    expect(result).toEqual({ success: true, mode: BrowserMode.Embedded });
    expect(config.browserMode).toBe(BrowserMode.Embedded);
  });

  test('persists the selected mode and synchronizes it once', async () => {
    let config: Record<string, unknown> = { theme: 'light' };
    const syncConfig = vi.fn().mockResolvedValue({ success: true });

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig,
    });

    expect(result).toEqual({ success: true, mode: BrowserMode.User });
    expect(config).toEqual({ theme: 'light', browserMode: BrowserMode.User });
    expect(syncConfig).toHaveBeenCalledTimes(1);
    expect(syncConfig).toHaveBeenCalledWith('browser-mode-change');
  });

  test('rejects a mode change before writing config when a session is active', async () => {
    const originalConfig = { browserMode: BrowserMode.Isolated };
    const writeAppConfig = vi.fn();
    const syncConfig = vi.fn();

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => originalConfig,
      writeAppConfig,
      hasActiveSessions: () => true,
      syncConfig,
    });

    expect(result).toEqual({
      success: false,
      mode: BrowserMode.Isolated,
      errorCode: 'active-session',
    });
    expect(writeAppConfig).not.toHaveBeenCalled();
    expect(syncConfig).not.toHaveBeenCalled();
  });

  test('allows selecting the current mode while a session is active', async () => {
    const writeAppConfig = vi.fn();
    const syncConfig = vi.fn();

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => ({ browserMode: BrowserMode.User }),
      writeAppConfig,
      hasActiveSessions: () => true,
      syncConfig,
    });

    expect(result).toEqual({ success: true, mode: BrowserMode.User });
    expect(writeAppConfig).not.toHaveBeenCalled();
    expect(syncConfig).not.toHaveBeenCalled();
  });

  test('restores app config and OpenClaw config when synchronization fails', async () => {
    const originalConfig = { theme: 'dark', browserMode: BrowserMode.Isolated };
    let config: Record<string, unknown> = originalConfig;
    const syncConfig = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'apply failed' })
      .mockResolvedValueOnce({ success: true });

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig,
    });

    expect(result).toEqual({ success: false, errorCode: 'config-sync-failed' });
    expect(config).toBe(originalConfig);
    expect(syncConfig).toHaveBeenNthCalledWith(1, 'browser-mode-change');
    expect(syncConfig).toHaveBeenNthCalledWith(2, 'browser-mode-rollback');
  });

  test('rolls back when synchronization rejects', async () => {
    const originalConfig = { browserMode: BrowserMode.Isolated };
    let config: Record<string, unknown> = originalConfig;
    const syncConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('unexpected failure'))
      .mockResolvedValueOnce({ success: true });

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig,
    });

    expect(result).toEqual({ success: false, errorCode: 'config-sync-failed' });
    expect(config).toBe(originalConfig);
    expect(syncConfig).toHaveBeenNthCalledWith(2, 'browser-mode-rollback');
  });
});

describe('getBrowserModeSwitchAvailability', () => {
  test('allows switching only when no session is active', () => {
    expect(getBrowserModeSwitchAvailability(() => false)).toEqual({
      success: true,
      canSwitch: true,
    });
    expect(getBrowserModeSwitchAvailability(() => true)).toEqual({
      success: true,
      canSwitch: false,
      errorCode: 'active-session',
    });
  });

  test('fails closed when the runtime state cannot be read', () => {
    expect(
      getBrowserModeSwitchAvailability(() => {
        throw new Error('runtime unavailable');
      }),
    ).toEqual({ success: false, canSwitch: false, error: 'runtime unavailable' });
  });
});

describe('testBrowserConnection', () => {
  test('requests the user Chrome tab list to trigger authorization', async () => {
    const request = vi.fn().mockResolvedValue({ running: true, tabs: [] });

    const result = await testBrowserConnection({ request });

    expect(result).toEqual({ success: true });
    expect(request).toHaveBeenCalledWith('browser.request', {
      method: 'GET',
      path: '/tabs',
      query: { profile: 'user' },
      timeoutMs: 45_000,
    });
  });

  test('does not report a stopped user browser profile as connected', async () => {
    const request = vi.fn().mockResolvedValue({ running: false, tabs: [] });

    await expect(testBrowserConnection({ request })).resolves.toEqual({
      success: false,
      errorCode: 'browser-not-running',
      error: 'The Chrome browser profile is not running.',
    });
  });

  test('reports a running extension profile with no shared tabs as connected', async () => {
    const request = vi.fn().mockResolvedValue({ running: true, tabs: [] });

    const result = await testBrowserConnection({ request }, 'chrome');

    expect(result).toEqual({ success: true });
    expect(request).toHaveBeenCalledWith('browser.request', {
      method: 'GET',
      path: '/tabs',
      query: { profile: 'chrome' },
      timeoutMs: 45_000,
    });
  });

  test('reports the extension profile as connected when it exposes a shared tab', async () => {
    const request = vi.fn().mockResolvedValue({
      running: true,
      tabs: [{ targetId: 'shared-tab', title: 'Shared tab', url: 'https://example.com' }],
    });

    await expect(testBrowserConnection({ request }, 'chrome')).resolves.toEqual({ success: true });
  });

  test.each([
    {},
    { running: false, tabs: [{ targetId: 'shared-tab' }] },
    { running: 'true', tabs: [] },
  ])('rejects an extension response without the running signal %#', async response => {
    const request = vi.fn().mockResolvedValue(response);

    await expect(testBrowserConnection({ request }, 'chrome')).resolves.toEqual({
      success: false,
      errorCode: 'extension-not-connected',
      error: 'The browser extension is not connected.',
    });
  });

  test('reports a Chrome MCP handshake timeout as an authorization timeout', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error('Chrome MCP handshake timed out while attaching'));

    const result = await testBrowserConnection({ request });

    expect(result).toEqual({
      success: false,
      errorCode: 'permission-timeout',
      error: 'Chrome MCP handshake timed out while attaching',
    });
  });

  test('reports a missing Gateway before making a request', async () => {
    await expect(testBrowserConnection(null)).resolves.toEqual({
      success: false,
      errorCode: 'gateway-unavailable',
      error: 'OpenClaw Gateway is not connected.',
    });
  });
});

describe('browser debugging port ownership', () => {
  test('finds the listening PID for an IPv4 or IPv6 Windows endpoint', () => {
    const output = [
      '  TCP    127.0.0.1:43127      0.0.0.0:0      LISTENING       1000',
      '  TCP    [::1]:9222           [::]:0         LISTENING       25348',
    ].join('\r\n');

    expect(parseWindowsNetstatListeningPid(output, 9222)).toBe(25348);
    expect(parseWindowsNetstatListeningPid(output, 9223)).toBeNull();
  });

  test('reads the executable name from tasklist CSV output', () => {
    expect(parseWindowsTasklistProcessName('"chrome.exe","25348","Console","1","200,000 K"')).toBe(
      'chrome.exe',
    );
    expect(parseWindowsTasklistProcessName('INFO: No tasks are running')).toBeNull();
  });

  test('reads a Chrome owner from lsof field output', () => {
    expect(parseLsofPortOwner('p321\ncGoogle Chrome\n')).toEqual({
      pid: 321,
      processName: 'Google Chrome',
      isChrome: true,
    });
    expect(parseLsofPortOwner('')).toBeNull();
  });
});

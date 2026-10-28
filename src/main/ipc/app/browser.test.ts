import { app, clipboard, ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test, vi } from 'vitest';

import { BrowserIpc, BrowserMode } from '../../../shared/browser/browser';
import {
  applyBrowserModeChange,
  buildBrowserExtensionPairingCommandArgs,
  buildBrowserPairingCommandEnvironment,
  copyBrowserExtensionPairing,
  findBundledBrowserExtensionPath,
  getBrowserModeSwitchAvailability,
  openBrowserExtensionFolder,
  openBrowserUrlInChrome,
  parseLsofPortOwner,
  parseWindowsNetstatListeningPid,
  parseWindowsTasklistProcessName,
  readBundledBrowserExtensionVersion,
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
    buildCliEnvironment: vi.fn(),
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

describe('opening message links in Chrome', () => {
  test('denies Chrome launches from guests and child frames', () => {
    const handle = vi.mocked(ipcMain.handle);
    handle.mockClear();
    registerBrowserHandlers({
      getGatewayClient: () => null,
      buildCliEnvironment: vi.fn(),
      hasActiveSessions: () => false,
      setBrowserMode: vi.fn(),
    });
    const handler = handle.mock.calls.find(([channel]) => channel === BrowserIpc.OpenInChrome)?.[1];
    expect(handler).toBeTruthy();
    const mainFrame = {};
    for (const event of [
      { sender: { getType: () => 'webview', mainFrame }, senderFrame: mainFrame },
      { sender: { getType: () => 'window', mainFrame }, senderFrame: {} },
    ]) {
      expect(handler!(event as Electron.IpcMainInvokeEvent, 'https://example.com')).toEqual({
        success: false,
        error: 'Access denied',
      });
    }
  });
  test.each([
    undefined,
    null,
    {},
    'file:///C:/report.html',
    'javascript:alert(1)',
    '--incognito',
    'https://example.com/\n--incognito',
  ])('rejects an invalid URL: %s', async url => {
    const launch = vi.fn();
    expect((await openBrowserUrlInChrome(url, launch)).success).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test('passes the complete web URL as one launch argument and returns launch failures', async () => {
    const url = 'https://example.com/report.html?q=%E4%B8%AD%E6%96%87#chart';
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'Chrome unavailable' });
    expect(await openBrowserUrlInChrome(url, launch)).toEqual({
      success: false,
      error: 'Chrome unavailable',
    });
    expect(launch).toHaveBeenCalledWith(url);
  });

  test('opens an existing local HTML in Chrome with its original file URL', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-chrome-html-'));
    try {
      const filePath = path.join(directory, '季度报告 #100%.html');
      fs.writeFileSync(filePath, '<p>Report</p>');
      const url = pathToFileURL(filePath);
      url.search = '?mode=3d';
      url.hash = '#camera';
      const launch = vi.fn().mockResolvedValue({ success: true });

      await expect(openBrowserUrlInChrome(url.href, launch)).resolves.toEqual({ success: true });
      expect(launch).toHaveBeenCalledWith(url.href);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
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

describe('browser extension resources', () => {
  test('bootstraps the OpenClaw CLI with Node-compatible argv under Electron', () => {
    expect(buildBrowserExtensionPairingCommandArgs('openclaw.mjs')).toEqual([
      '-e',
      "process.argv[0]='node';import(require('node:url').pathToFileURL(process.argv[1]).href)",
      'openclaw.mjs',
      'browser',
      'extension',
      'pair',
      '--json',
    ]);
  });

  test('prevents OpenClaw from respawning the pairing CLI under Electron', () => {
    const cli = {
      openclawEntry: 'gateway-launcher.cjs',
      runtimeRoot: 'runtime',
      port: 42871,
      token: 'gateway-token',
      env: { OPENCLAW_NO_RESPAWN: '0', EXISTING_VALUE: 'preserved' },
    };

    expect(buildBrowserPairingCommandEnvironment(cli)).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_NO_RESPAWN: '1',
      EXISTING_VALUE: 'preserved',
    });
  });

  test('finds the generated extension in development', () => {
    const appPath = path.resolve('app');
    const expected = path.join(appPath, 'build', 'browser-extension');

    expect(
      findBundledBrowserExtensionPath(
        { isPackaged: false, resourcesPath: path.resolve('resources'), appPath },
        candidate => candidate === path.join(expected, 'chrome-extension', 'manifest.json'),
      ),
    ).toBe(expected);
  });

  test('finds the installed extension in packaged resources', () => {
    const resourcesPath = path.resolve('installed', 'resources');
    const expected = path.join(resourcesPath, 'browser-extension');

    expect(
      findBundledBrowserExtensionPath(
        { isPackaged: true, resourcesPath, appPath: path.resolve('app.asar') },
        candidate => candidate === path.join(expected, 'chrome-extension', 'manifest.json'),
      ),
    ).toBe(expected);
  });

  test('copies the pairing string returned by the locked OpenClaw runtime', async () => {
    const writeText = vi.mocked(clipboard.writeText);
    writeText.mockClear();
    const pairingString = `ws://127.0.0.1:42881/extension?gateway=${encodeURIComponent('ws://127.0.0.1:42871')}#${'a'.repeat(64)}`;
    const runPairCommand = vi.fn().mockResolvedValue(
      JSON.stringify({
        pairingString,
        relayPort: 42881,
        remote: false,
      }),
    );
    const cli = {
      openclawEntry: 'openclaw.cjs',
      runtimeRoot: 'runtime',
      port: 42871,
      token: 'gateway-token',
      env: { OPENCLAW_GATEWAY_PORT: '42871' },
    };

    await copyBrowserExtensionPairing(async () => cli, runPairCommand);

    expect(runPairCommand).toHaveBeenCalledWith(cli);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(pairingString);
  });

  test('rejects malformed runtime pairing output without changing the clipboard', async () => {
    const writeText = vi.mocked(clipboard.writeText);
    writeText.mockClear();

    await expect(
      copyBrowserExtensionPairing(
        async () => ({
          openclawEntry: 'openclaw.cjs',
          runtimeRoot: 'runtime',
          port: 42871,
          token: 'gateway-token',
          env: {},
        }),
        async () => JSON.stringify({ pairingString: null, relayPort: '42881' }),
      ),
    ).rejects.toThrow('invalid browser extension pairing result');
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('bundled browser extension version', () => {
  test.each([
    [{ version: '2.3.0', version_name: 'v2026.10.20' }, '2.3.0'],
    [{ version: '2.3.0' }, '2.3.0'],
    [{ version_name: 'v2026.10.20' }, null],
  ])('reads the extension version independently of display labels (%j)', (manifest, expected) => {
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-extension-metadata-'));
    try {
      fs.mkdirSync(path.join(extensionPath, 'chrome-extension'));
      fs.writeFileSync(
        path.join(extensionPath, 'chrome-extension', 'manifest.json'),
        JSON.stringify(manifest),
      );
      expect(readBundledBrowserExtensionVersion(extensionPath)).toBe(expected);
    } finally {
      fs.rmSync(extensionPath, { recursive: true, force: true });
    }
  });

  test('returns unknown for missing or damaged metadata', () => {
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-extension-metadata-'));
    try {
      expect(readBundledBrowserExtensionVersion(extensionPath)).toBeNull();
      fs.mkdirSync(path.join(extensionPath, 'chrome-extension'));
      const manifestPath = path.join(extensionPath, 'chrome-extension', 'manifest.json');
      fs.writeFileSync(manifestPath, '{');
      expect(readBundledBrowserExtensionVersion(extensionPath)).toBeNull();
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 123 }));
      expect(readBundledBrowserExtensionVersion(extensionPath)).toBeNull();
    } finally {
      fs.rmSync(extensionPath, { recursive: true, force: true });
    }
  });

  test('retains bundled metadata when Chrome status detection fails', async () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-extension-status-'));
    const extensionPath = path.join(appPath, 'build', 'browser-extension', 'chrome-extension');
    const getAppPath = vi.mocked(app.getAppPath);
    const exists = vi.spyOn(fs, 'existsSync');
    try {
      fs.mkdirSync(extensionPath, { recursive: true });
      fs.writeFileSync(
        path.join(extensionPath, 'manifest.json'),
        JSON.stringify({ version: '2.3.0', version_name: 'v2026.10.20' }),
      );
      getAppPath.mockReturnValue(appPath);
      exists.mockImplementation(candidate => {
        if (candidate === path.join(extensionPath, 'manifest.json')) return true;
        throw new Error('Chrome lookup unavailable');
      });
      vi.mocked(ipcMain.handle).mockClear();
      registerBrowserHandlers({
        getGatewayClient: () => null,
        buildCliEnvironment: vi.fn(),
        hasActiveSessions: () => false,
        setBrowserMode: vi.fn(),
      });
      const handler = vi
        .mocked(ipcMain.handle)
        .mock.calls.find(([channel]) => channel === BrowserIpc.GetStatus)?.[1];
      expect(await handler!({} as Electron.IpcMainInvokeEvent)).toEqual({
        success: false,
        error: 'Chrome lookup unavailable',
        bundledExtensionVersion: '2.3.0',
      });
    } finally {
      exists.mockRestore();
      getAppPath.mockReset();
      fs.rmSync(appPath, { recursive: true, force: true });
    }
  });
});

describe('browser extension folder', () => {
  test('opens the extension directory directly', async () => {
    const openPath = vi.fn().mockResolvedValue('');

    await expect(openBrowserExtensionFolder('C:\\extension', openPath)).resolves.toBeUndefined();
    expect(openPath).toHaveBeenCalledWith('C:\\extension');
  });

  test('surfaces an Explorer launch failure', async () => {
    const openPath = vi.fn().mockResolvedValue('Access denied');

    await expect(openBrowserExtensionFolder('C:\\extension', openPath)).rejects.toThrow(
      'Access denied',
    );
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

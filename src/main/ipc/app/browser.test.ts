import { clipboard } from 'electron';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { describe, expect, test, vi } from 'vitest';

import { BrowserMode } from '../../../shared/browser';
import {
  applyBrowserModeChange,
  classifyBrowserExtensionRelayProbe,
  copyBrowserExtensionPairing,
  ensureBrowserExtensionRelayToken,
  findBundledBrowserExtensionPath,
  getBrowserModeSwitchAvailability,
  isBrowserExtensionRelayResponse,
  openBrowserExtensionFolder,
  parseLsofPortOwner,
  parseWindowsNetstatListeningPid,
  parseWindowsTasklistProcessName,
  probeBrowserExtensionRelay,
  resolveBrowserExtensionRelayPort,
  testBrowserConnection,
} from './browser';

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(), isPackaged: false },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));

describe('applyBrowserModeChange', () => {
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
    const request = vi.fn().mockResolvedValue({ tabs: [] });

    const result = await testBrowserConnection({ request });

    expect(result).toEqual({ success: true });
    expect(request).toHaveBeenCalledWith('browser.request', {
      method: 'GET',
      path: '/tabs',
      query: { profile: 'user' },
      timeoutMs: 45_000,
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

describe('browser extension relay diagnostics', () => {
  const baseProbe = {
    relayPort: 42881,
    portListening: true,
    portOwner: { pid: 123, processName: 'JustDo.exe', isChrome: false },
    reachable: true,
    identified: true,
    statusCode: 503,
  };

  test.each([
    [
      { portListening: false, reachable: false, identified: false, statusCode: null },
      'extension-relay-unavailable',
    ],
    [{ reachable: false, identified: false, statusCode: null }, 'extension-relay-port-conflict'],
    [{ identified: false, statusCode: 200 }, 'extension-relay-port-conflict'],
    [{ statusCode: 401 }, 'extension-pairing-mismatch'],
    [{ statusCode: 503 }, 'extension-not-connected'],
    [{ statusCode: 200 }, 'extension-browser-service-failed'],
    [{ statusCode: 404 }, 'extension-relay-port-conflict'],
  ])('classifies relay probe %# as %s', (overrides, errorCode) => {
    expect(classifyBrowserExtensionRelayProbe({ ...baseProbe, ...overrides })).toMatchObject({
      success: false,
      errorCode,
      relayPort: 42881,
      relayPortOwner: baseProbe.portOwner,
    });
  });

  test('recognizes only authenticated extension relay response shapes', () => {
    expect(
      isBrowserExtensionRelayResponse(42881, 401, 'Basic realm="openclaw-extension-relay"', ''),
    ).toBe(true);
    expect(
      isBrowserExtensionRelayResponse(
        42881,
        503,
        undefined,
        JSON.stringify({ error: 'OpenClaw Chrome extension is not connected. Install it.' }),
      ),
    ).toBe(true);
    expect(
      isBrowserExtensionRelayResponse(
        42881,
        200,
        undefined,
        JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:42881/cdp' }),
      ),
    ).toBe(true);
  });

  test.each([
    [401, 'Basic realm="another-service"', ''],
    [503, undefined, JSON.stringify({ error: 'Service unavailable' })],
    [200, undefined, JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:42881/devtools' })],
    [200, undefined, JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/cdp' })],
    [200, undefined, JSON.stringify({ Browser: 'Chrome/151' })],
  ])('rejects a non-relay response %#', (statusCode, authenticateHeader, body) => {
    expect(isBrowserExtensionRelayResponse(42881, statusCode, authenticateHeader, body)).toBe(
      false,
    );
  });

  test('settles when a local service aborts a partial HTTP response', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"webSocketDebuggerUrl":');
      setImmediate(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');

    try {
      await expect(probeBrowserExtensionRelay(address.port, 'a'.repeat(64), 500)).resolves.toEqual({
        reachable: true,
        identified: false,
        statusCode: 200,
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('browser extension resources', () => {
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

  test('derives the extension relay port from the active Gateway port', () => {
    expect(
      resolveBrowserExtensionRelayPort({
        openclawEntry: 'openclaw.cjs',
        runtimeRoot: 'runtime',
        env: { OPENCLAW_GATEWAY_PORT: '42871' },
      }),
    ).toBe(42881);
  });

  test('creates and then reuses the host-local extension relay token', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-extension-'));

    try {
      const created = ensureBrowserExtensionRelayToken(stateDir);
      const reused = ensureBrowserExtensionRelayToken(stateDir);
      const persisted = fs.readFileSync(
        path.join(stateDir, 'credentials', 'browser-extension-relay.secret'),
        'utf8',
      );

      expect(created).toMatch(/^[0-9a-f]{64}$/);
      expect(reused).toBe(created);
      expect(persisted).toBe(`${created}\n`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('copies a complete loopback pairing string without returning the token', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-extension-'));
    const writeText = vi.mocked(clipboard.writeText);
    writeText.mockClear();

    try {
      await copyBrowserExtensionPairing(async () => ({
        openclawEntry: 'openclaw.cjs',
        runtimeRoot: 'runtime',
        env: {
          OPENCLAW_GATEWAY_PORT: '42871',
          OPENCLAW_STATE_DIR: stateDir,
        },
      }));

      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith(
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:42881\/extension#[0-9a-f]{64}$/),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
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

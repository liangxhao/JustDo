import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, clipboard, ipcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { BrowserIpc } from '../../shared/browser/browser';
import { registerBrowserHandlers } from '../ipc/app/browser';
import {
  buildChromeExtensionPairingCommandArgs,
  buildChromePairingCommandEnvironment,
  copyChromeExtensionPairing,
  findBundledChromeExtensionPath,
  openChromeExtensionFolder,
  readBundledChromeExtensionVersion,
} from './chromeSettings';

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(), isPackaged: false },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openPath: vi.fn() },
}));

describe('browser extension resources', () => {
  test('bootstraps the OpenClaw CLI with Node-compatible argv under Electron', () => {
    expect(buildChromeExtensionPairingCommandArgs('openclaw.mjs')).toEqual([
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

    expect(buildChromePairingCommandEnvironment(cli)).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_NO_RESPAWN: '1',
      EXISTING_VALUE: 'preserved',
    });
  });

  test('finds the generated extension in development', () => {
    const appPath = path.resolve('app');
    const expected = path.join(appPath, 'build', 'chrome-extension');

    expect(
      findBundledChromeExtensionPath(
        { isPackaged: false, resourcesPath: path.resolve('resources'), appPath },
        candidate => candidate === path.join(expected, 'chrome-extension', 'manifest.json'),
      ),
    ).toBe(expected);
  });

  test('finds the installed extension in packaged resources', () => {
    const resourcesPath = path.resolve('installed', 'resources');
    const expected = path.join(resourcesPath, 'chrome-extension');

    expect(
      findBundledChromeExtensionPath(
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

    await copyChromeExtensionPairing(async () => cli, runPairCommand);

    expect(runPairCommand).toHaveBeenCalledWith(cli);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(pairingString);
  });

  test('rejects malformed runtime pairing output without changing the clipboard', async () => {
    const writeText = vi.mocked(clipboard.writeText);
    writeText.mockClear();

    await expect(
      copyChromeExtensionPairing(
        async () => ({
          openclawEntry: 'openclaw.cjs',
          runtimeRoot: 'runtime',
          port: 42871,
          token: 'gateway-token',
          env: {},
        }),
        async () => JSON.stringify({ pairingString: null, relayPort: '42881' }),
      ),
    ).rejects.toThrow('invalid Chrome extension pairing result');
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('bundled browser extension version', () => {
  test.each([
    [{ version: '2.3.0', version_name: 'v2026.10.20' }, '2.3.0'],
    [{ version: '2.3.0' }, '2.3.0'],
    [{ version_name: 'v2026.10.20' }, null],
  ])('reads the extension version independently of display labels (%j)', (manifest, expected) => {
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-extension-metadata-'));
    try {
      fs.mkdirSync(path.join(extensionPath, 'chrome-extension'));
      fs.writeFileSync(
        path.join(extensionPath, 'chrome-extension', 'manifest.json'),
        JSON.stringify(manifest),
      );
      expect(readBundledChromeExtensionVersion(extensionPath)).toBe(expected);
    } finally {
      fs.rmSync(extensionPath, { recursive: true, force: true });
    }
  });

  test('returns unknown for missing or damaged metadata', () => {
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-extension-metadata-'));
    try {
      expect(readBundledChromeExtensionVersion(extensionPath)).toBeNull();
      fs.mkdirSync(path.join(extensionPath, 'chrome-extension'));
      const manifestPath = path.join(extensionPath, 'chrome-extension', 'manifest.json');
      fs.writeFileSync(manifestPath, '{');
      expect(readBundledChromeExtensionVersion(extensionPath)).toBeNull();
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 123 }));
      expect(readBundledChromeExtensionVersion(extensionPath)).toBeNull();
    } finally {
      fs.rmSync(extensionPath, { recursive: true, force: true });
    }
  });

  test('retains bundled metadata when Chrome status detection fails', async () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-extension-status-'));
    const extensionPath = path.join(appPath, 'build', 'chrome-extension', 'chrome-extension');
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

    await expect(openChromeExtensionFolder('C:\\extension', openPath)).resolves.toBeUndefined();
    expect(openPath).toHaveBeenCalledWith('C:\\extension');
  });

  test('surfaces an Explorer launch failure', async () => {
    const openPath = vi.fn().mockResolvedValue('Access denied');

    await expect(openChromeExtensionFolder('C:\\extension', openPath)).rejects.toThrow(
      'Access denied',
    );
  });
});

import { spawn } from 'child_process';
import { clipboard, ipcMain } from 'electron';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import {
  type BrowserConnectionIssue,
  type BrowserConnectionStatus,
  type BrowserConnectionTestResult,
  BrowserIpc,
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  type BrowserModeUpdateResult,
  parseDevToolsActivePort,
} from '../../../shared/browser';
import type { GatewayClientLike } from '../../engine/gateway/types';

const REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';

const resolveChromeUserDataDir = (): string | null => {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome');
  }
  return null;
};

const resolveChromeExecutable = (): string | null => {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
          process.env['PROGRAMFILES(X86)']
            ? path.join(
                process.env['PROGRAMFILES(X86)'],
                'Google',
                'Chrome',
                'Application',
                'chrome.exe',
              )
            : '',
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) ?? null;
};

const readRemoteDebuggingEnabled = (userDataDir: string): boolean => {
  try {
    const localState = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'),
    ) as {
      devtools?: { remote_debugging?: { 'user-enabled'?: unknown } };
    };
    return localState.devtools?.remote_debugging?.['user-enabled'] === true;
  } catch {
    return false;
  }
};

const probeLoopbackPort = (port: number, timeoutMs = 700): Promise<boolean> =>
  new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

export const getBrowserConnectionStatus = async (): Promise<BrowserConnectionStatus> => {
  const userDataDir = resolveChromeUserDataDir();
  const supported = userDataDir !== null;
  const chromeFound = resolveChromeExecutable() !== null;
  const remoteDebuggingEnabled = userDataDir ? readRemoteDebuggingEnabled(userDataDir) : false;
  const activePortPath = userDataDir ? path.join(userDataDir, 'DevToolsActivePort') : null;
  const activePortFileExists = !!activePortPath && fs.existsSync(activePortPath);
  let activePort: number | null = null;
  if (activePortPath && activePortFileExists) {
    try {
      activePort = parseDevToolsActivePort(fs.readFileSync(activePortPath, 'utf8'));
    } catch {
      activePort = null;
    }
  }
  const endpointReachable = activePort ? await probeLoopbackPort(activePort) : false;

  let issue: BrowserConnectionIssue | null = null;
  if (!supported) issue = 'unsupported-platform';
  else if (!chromeFound) issue = 'chrome-not-found';
  else if (!remoteDebuggingEnabled) issue = 'remote-debugging-disabled';
  else if (activePortFileExists && !endpointReachable) issue = 'chrome-restart-required';
  else if (!endpointReachable) issue = 'not-running';

  return {
    supported,
    chromeFound,
    remoteDebuggingEnabled,
    activePort,
    activePortFileExists,
    endpointReachable,
    issue,
  };
};

type BrowserHandlerDependencies = {
  getGatewayClient: () => GatewayClientLike | null;
  setBrowserMode: (mode: BrowserModeValue) => Promise<BrowserModeUpdateResult>;
};

type BrowserModeChangeDependencies = {
  readAppConfig: () => Record<string, unknown>;
  writeAppConfig: (config: Record<string, unknown>) => void;
  syncConfig: (reason: string) => Promise<{ success: boolean; error?: string }>;
  logError?: (message: string, error?: string) => void;
};

export const applyBrowserModeChange = async (
  mode: BrowserModeValue,
  dependencies: BrowserModeChangeDependencies,
): Promise<BrowserModeUpdateResult> => {
  const previousConfig = dependencies.readAppConfig();
  dependencies.writeAppConfig({ ...previousConfig, browserMode: mode });
  const syncResult = await dependencies.syncConfig('browser-mode-change').catch(error => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (syncResult.success) return { success: true, mode };

  dependencies.logError?.('Failed to apply browser mode; rolling back.', syncResult.error);
  dependencies.writeAppConfig(previousConfig);
  const rollbackResult = await dependencies.syncConfig('browser-mode-rollback').catch(error => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!rollbackResult.success) {
    dependencies.logError?.('Failed to roll back browser mode.', rollbackResult.error);
  }
  return {
    success: false,
    errorCode: 'config-sync-failed',
  };
};

export const registerBrowserHandlers = ({
  getGatewayClient,
  setBrowserMode,
}: BrowserHandlerDependencies): void => {
  ipcMain.handle(BrowserIpc.GetStatus, async () => {
    try {
      return { success: true, status: await getBrowserConnectionStatus() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(BrowserIpc.SetMode, async (_event, mode: unknown) => {
    if (mode !== BrowserMode.Isolated && mode !== BrowserMode.User) {
      return {
        success: false,
        errorCode: 'invalid-mode',
      } satisfies BrowserModeUpdateResult;
    }
    return setBrowserMode(mode);
  });

  ipcMain.handle(BrowserIpc.OpenRemoteDebugging, () => {
    const executable = resolveChromeExecutable();
    if (!executable) return { success: false, error: 'Google Chrome was not found.' };
    try {
      // Chrome may intentionally discard externally supplied chrome:// URLs.
      // Copy the internal URL and focus Chrome so the user can paste it into
      // the address bar, which works consistently across supported versions.
      clipboard.writeText(REMOTE_DEBUGGING_URL);
      const child = spawn(executable, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(BrowserIpc.TestConnection, async (): Promise<BrowserConnectionTestResult> => {
    const client = getGatewayClient();
    if (!client) {
      return {
        success: false,
        errorCode: 'gateway-unavailable',
        error: 'OpenClaw Gateway is not connected.',
      };
    }
    try {
      await client.request('browser.request', {
        method: 'GET',
        path: '/tabs',
        query: { profile: 'user' },
        timeoutMs: 45_000,
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorCode: /timed?\s*out|timeout/i.test(message)
          ? 'permission-timeout'
          : 'connection-failed',
        error: message,
      };
    }
  });
};

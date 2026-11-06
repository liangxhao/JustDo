import { execFile } from 'child_process';
import { ipcMain, session, shell } from 'electron';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import {
  BROWSER_GUEST_CREDENTIALS_GET_CHANNEL,
  BROWSER_IMPORTED_PROFILE_PARTITION,
  BROWSER_PANEL_PARTITION,
  type BrowserActionResult,
  type BrowserClearDataResult,
  type BrowserClearDataSummaryResult,
  type BrowserConnectionIssue,
  type BrowserConnectionStatus,
  type BrowserConnectionTestResult,
  type BrowserDownloadListResult,
  type BrowserHistoryFaviconResult,
  type BrowserHistoryListResult,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSourcesResult,
  BrowserIpc,
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  type BrowserModeSwitchAvailabilityResult,
  type BrowserModeUpdateResult,
  type BrowserPortOwner,
  isBrowserClearDataRange,
  isBrowserProfileRunning,
  normalizeBrowserMode,
  parseDevToolsActivePort,
} from '../../../shared/browser/browser';
import {
  clearBrowserData,
  getBrowserClearDataSummary,
  isBrowserClearDataRequest,
} from '../../browser/data/browserClearDataService';
import {
  clearBrowserDownloads,
  clearBrowserHistory,
  deleteBrowserDownloads,
  deleteBrowserHistory,
  getBrowserDownloadPath,
  getImportedCredentials,
  importChromeData,
  listBrowserDownloads,
  listBrowserHistory,
  listChromeImportSources,
} from '../../browser/data/browserDataImportService';
import { loadBrowserHistoryFavicon } from '../../browser/history/browserHistoryFavicon';
import { createLocalHtmlPreview } from '../../browser/preview/localHtmlPreviewServer';
import {
  focusRunningChrome,
  readBundledChromeExtensionVersion,
  resolveChromeExecutable,
  resolveChromeUserDataDir,
} from '../../chrome/chromeSettings';
import type { GatewayClientLike } from '../../engine/gateway/types';

const execFileAsync = promisify(execFile);

type PortOwnerLookup = {
  resolved: boolean;
  owner: BrowserPortOwner | null;
};

const isChromeProcessName = (processName: string): boolean =>
  /^(?:chrome(?:\.exe)?|google chrome|google-chrome(?:-stable)?|chromium(?:-browser)?)$/i.test(
    processName.trim(),
  );

export const parseWindowsNetstatListeningPid = (output: string, port: number): number | null => {
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== 'TCP') continue;
    const localAddress = fields[1] ?? '';
    const state = fields[3]?.toUpperCase();
    const pid = Number(fields[4]);
    if (
      state === 'LISTENING' &&
      localAddress.endsWith(`:${port}`) &&
      Number.isInteger(pid) &&
      pid > 0
    ) {
      return pid;
    }
  }
  return null;
};

export const parseWindowsTasklistProcessName = (output: string): string | null => {
  const match = output.trim().match(/^"((?:[^"]|"")+)"/);
  return match?.[1]?.replace(/""/g, '"').trim() || null;
};

export const parseLsofPortOwner = (output: string): BrowserPortOwner | null => {
  const pid = Number(output.match(/^p(\d+)$/m)?.[1]);
  const processName = output.match(/^c(.+)$/m)?.[1]?.trim() || null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    processName,
    isChrome: processName ? isChromeProcessName(processName) : false,
  };
};

const resolvePortOwner = async (port: number): Promise<PortOwnerLookup> => {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
      });
      const pid = parseWindowsNetstatListeningPid(stdout, port);
      if (!pid) return { resolved: true, owner: null };

      let processName: string | null = null;
      try {
        const tasklistResult = await execFileAsync(
          'tasklist.exe',
          ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
          {
            encoding: 'utf8',
            timeout: 2_000,
            windowsHide: true,
          },
        );
        processName = parseWindowsTasklistProcessName(tasklistResult.stdout);
      } catch {
        // PID ownership is still useful when the executable name cannot be read.
      }
      return {
        resolved: true,
        owner: {
          pid,
          processName,
          isChrome: processName ? isChromeProcessName(processName) : false,
        },
      };
    }

    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp', '-Fc'],
      {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
      },
    );
    return { resolved: true, owner: parseLsofPortOwner(stdout) };
  } catch (error) {
    const exitCode = (error as { code?: unknown }).code;
    if (exitCode === 1 || exitCode === '1') return { resolved: true, owner: null };
    return { resolved: false, owner: null };
  }
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
  const portListening = activePort ? await probeLoopbackPort(activePort) : false;
  const portOwnerLookup =
    activePort && portListening
      ? await resolvePortOwner(activePort)
      : { resolved: true, owner: null };
  const occupiedByOtherProcess =
    portListening &&
    portOwnerLookup.resolved &&
    portOwnerLookup.owner !== null &&
    portOwnerLookup.owner.processName !== null &&
    !portOwnerLookup.owner.isChrome;
  const endpointReachable = portListening && !occupiedByOtherProcess;

  let issue: BrowserConnectionIssue | null = null;
  if (!supported) issue = 'unsupported-platform';
  else if (!chromeFound) issue = 'chrome-not-found';
  else if (!remoteDebuggingEnabled) issue = 'remote-debugging-disabled';
  else if (occupiedByOtherProcess) issue = 'port-occupied-by-other-process';
  else if (activePortFileExists && !endpointReachable) issue = 'chrome-restart-required';
  else if (!endpointReachable) issue = 'not-running';

  return {
    supported,
    chromeFound,
    remoteDebuggingEnabled,
    activePort,
    activePortFileExists,
    activePortOwnerResolved: portOwnerLookup.resolved,
    activePortOwner: portOwnerLookup.owner,
    endpointReachable,
    issue,
  };
};

type BrowserHandlerDependencies = {
  getGatewayClient: () => GatewayClientLike | null;
  hasActiveSessions: () => boolean;
  setBrowserMode: (mode: BrowserModeValue) => Promise<BrowserModeUpdateResult>;
};

type BrowserModeChangeDependencies = {
  readAppConfig: () => Record<string, unknown>;
  writeAppConfig: (config: Record<string, unknown>) => void;
  hasActiveSessions?: () => boolean;
  syncConfig: (reason: string) => Promise<{ success: boolean; error?: string }>;
  logError?: (message: string, error?: string) => void;
};

export const testBrowserConnection = async (
  client: GatewayClientLike | null,
  profile: 'user' | 'chrome' = 'user',
): Promise<BrowserConnectionTestResult> => {
  if (!client) {
    return {
      success: false,
      errorCode: 'gateway-unavailable',
      error: 'OpenClaw Gateway is not connected.',
    };
  }
  try {
    const response = await client.request<unknown>('browser.request', {
      method: 'GET',
      path: '/tabs',
      query: { profile },
      timeoutMs: 45_000,
    });
    if (!isBrowserProfileRunning(response)) {
      return {
        success: false,
        errorCode: profile === 'chrome' ? 'extension-not-connected' : 'browser-not-running',
        error:
          profile === 'chrome'
            ? 'The browser extension is not connected.'
            : 'The Chrome browser profile is not running.',
      };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      errorCode: /timed?\s*out|timeout/i.test(message) ? 'permission-timeout' : 'connection-failed',
      error: message,
    };
  }
};

export const applyBrowserModeChange = async (
  mode: BrowserModeValue,
  dependencies: BrowserModeChangeDependencies,
): Promise<BrowserModeUpdateResult> => {
  const previousConfig = dependencies.readAppConfig();
  const previousMode = normalizeBrowserMode(previousConfig.browserMode);
  if (mode === previousMode) return { success: true, mode };
  if (dependencies.hasActiveSessions?.()) {
    return { success: false, mode: previousMode, errorCode: 'active-session' };
  }

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

export const getBrowserModeSwitchAvailability = (
  hasActiveSessions: () => boolean,
): BrowserModeSwitchAvailabilityResult => {
  try {
    const canSwitch = !hasActiveSessions();
    return {
      success: true,
      canSwitch,
      ...(canSwitch ? {} : { errorCode: 'active-session' as const }),
    };
  } catch (error) {
    return {
      success: false,
      canSwitch: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const registerBrowserHandlers = ({
  getGatewayClient,
  hasActiveSessions,
  setBrowserMode,
}: BrowserHandlerDependencies): void => {
  ipcMain.handle(
    BrowserIpc.CreateLocalHtmlPreview,
    (event, filePath: unknown, workingDirectory?: unknown) => {
      if (
        event.sender.getType() !== 'window' ||
        typeof filePath !== 'string' ||
        (workingDirectory !== undefined && typeof workingDirectory !== 'string')
      ) {
        return { success: false as const, errorCode: 'invalid_request' as const };
      }
      return createLocalHtmlPreview(
        filePath,
        typeof workingDirectory === 'string' ? workingDirectory : undefined,
      );
    },
  );
  ipcMain.handle(BROWSER_GUEST_CREDENTIALS_GET_CHANNEL, event => {
    if (
      event.sender.getType() !== 'webview' ||
      ![
        session.fromPartition(BROWSER_PANEL_PARTITION),
        session.fromPartition(BROWSER_IMPORTED_PROFILE_PARTITION),
      ].includes(event.sender.session) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return [];
    }
    try {
      const credentials = getImportedCredentials(new URL(event.senderFrame.url).origin);
      return credentials.length === 1 ? credentials : [];
    } catch {
      return [];
    }
  });
  ipcMain.handle(BrowserIpc.GetStatus, async () => {
    const bundledExtensionVersion = readBundledChromeExtensionVersion();
    try {
      return { success: true, status: await getBrowserConnectionStatus(), bundledExtensionVersion };
    } catch (error) {
      return {
        success: false,
        bundledExtensionVersion,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(BrowserIpc.CanSetMode, () => getBrowserModeSwitchAvailability(hasActiveSessions));

  ipcMain.handle(BrowserIpc.SetMode, async (_event, mode: unknown) => {
    if (
      mode !== BrowserMode.Isolated &&
      mode !== BrowserMode.User &&
      mode !== BrowserMode.Extension &&
      mode !== BrowserMode.Embedded
    ) {
      return {
        success: false,
        errorCode: 'invalid-mode',
      } satisfies BrowserModeUpdateResult;
    }
    return setBrowserMode(mode);
  });

  ipcMain.handle(BrowserIpc.TestConnection, async (): Promise<BrowserConnectionTestResult> => {
    // Start the request first so Chrome has an incoming attach to display,
    // then foreground Chrome while the request waits for explicit approval.
    // Chrome MCP needs a moment to start, so focus it again after the native
    // authorization dialog has had time to appear.
    const connectionResult = testBrowserConnection(getGatewayClient());
    focusRunningChrome();
    const refocusTimer = setTimeout(focusRunningChrome, 1_500);
    refocusTimer.unref();
    try {
      return await connectionResult;
    } finally {
      clearTimeout(refocusTimer);
    }
  });

  ipcMain.handle(BrowserIpc.ListImportSources, (event): BrowserImportSourcesResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      return { success: true, sources: listChromeImportSources() };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(
    BrowserIpc.ImportData,
    async (event, request: BrowserImportRequest): Promise<BrowserImportResult> => {
      if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
      return importChromeData(request);
    },
  );

  ipcMain.handle(BrowserIpc.ListHistory, (event, query: unknown): BrowserHistoryListResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      return { success: true, entries: listBrowserHistory(typeof query === 'string' ? query : '') };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle(
    BrowserIpc.LoadHistoryFavicon,
    async (event, url: unknown, retry: unknown): Promise<BrowserHistoryFaviconResult> => {
      if (event.sender.getType() !== 'window' || event.senderFrame !== event.sender.mainFrame) {
        return { success: false, errorCode: 'invalid_request' };
      }
      try {
        return await loadBrowserHistoryFavicon(url, retry);
      } catch {
        return { success: false, errorCode: 'load_failed' };
      }
    },
  );
  ipcMain.handle(BrowserIpc.DeleteHistory, (event, urls: unknown): BrowserActionResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      deleteBrowserHistory(
        Array.isArray(urls) ? urls.filter(value => typeof value === 'string') : [],
      );
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle(BrowserIpc.ClearHistory, (event): BrowserActionResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      clearBrowserHistory();
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(BrowserIpc.ListDownloads, (event, query: unknown): BrowserDownloadListResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      return {
        success: true,
        entries: listBrowserDownloads(typeof query === 'string' ? query : ''),
      };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle(BrowserIpc.DeleteDownloads, (event, ids: unknown): BrowserActionResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      deleteBrowserDownloads(
        Array.isArray(ids) ? ids.filter(value => typeof value === 'string') : [],
      );
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle(BrowserIpc.ClearDownloads, (event): BrowserActionResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      clearBrowserDownloads();
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle(
    BrowserIpc.OpenDownload,
    async (event, id: unknown): Promise<BrowserActionResult> => {
      if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
      try {
        const filePath = typeof id === 'string' ? getBrowserDownloadPath(id) : null;
        if (!filePath) return { success: false, error: 'Downloaded file is unavailable.' };
        const error = await shell.openPath(filePath);
        return error
          ? { success: false, error: 'Downloaded file is unavailable.' }
          : { success: true };
      } catch {
        return { success: false, error: 'Downloaded file is unavailable.' };
      }
    },
  );
  ipcMain.handle(BrowserIpc.RevealDownload, (event, id: unknown): BrowserActionResult => {
    if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
    try {
      const filePath = typeof id === 'string' ? getBrowserDownloadPath(id) : null;
      if (!filePath) return { success: false, error: 'Downloaded file is unavailable.' };
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch {
      return { success: false, error: 'Downloaded file is unavailable.' };
    }
  });

  ipcMain.handle(
    BrowserIpc.GetClearDataSummary,
    async (event, range: unknown): Promise<BrowserClearDataSummaryResult> => {
      if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
      if (!isBrowserClearDataRange(range)) return { success: false, error: 'Invalid range.' };
      return getBrowserClearDataSummary(range);
    },
  );
  ipcMain.handle(
    BrowserIpc.ClearBrowsingData,
    async (event, request: unknown): Promise<BrowserClearDataResult> => {
      if (event.sender.getType() !== 'window') return { success: false, error: 'Access denied.' };
      if (!isBrowserClearDataRequest(request)) {
        return { success: false, errorCode: 'invalid-request' };
      }
      return clearBrowserData(request);
    },
  );
};

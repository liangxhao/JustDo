import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import { app, clipboard, ipcMain, shell } from 'electron';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  type BrowserActionResult,
  type BrowserConnectionIssue,
  type BrowserConnectionStatus,
  type BrowserConnectionTestResult,
  BrowserIpc,
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  type BrowserModeUpdateResult,
  type BrowserPortOwner,
  isBrowserExtensionConnected,
  parseDevToolsActivePort,
} from '../../../shared/browser';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawCliEnvironment } from '../../openclaw/runtime/openclawEngineManager';

const REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';
const EXTENSION_MANAGEMENT_URL = 'chrome://extensions';
const EXTENSION_RELAY_SECRET_FILE = 'browser-extension-relay.secret';
const DEFAULT_EXTENSION_RELAY_PORT = 18_799;
const EXTENSION_RELAY_GATEWAY_PORT_OFFSET = 10;
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

const launchOrFocusChrome = (): BrowserActionResult => {
  const executable = resolveChromeExecutable();
  if (!executable) return { success: false, error: 'Google Chrome was not found.' };
  try {
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
};

const focusRunningChrome = (): void => {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SYSTEMROOT?.trim();
    const powershell = systemRoot
      ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const script = [
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class NativeWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }\'',
      '$chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
      'if ($chrome) { [NativeWindow]::ShowWindowAsync($chrome.MainWindowHandle, 9) | Out-Null; [NativeWindow]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null }',
    ].join('; ');
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.once('error', () => {});
    child.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', ['-a', 'Google Chrome'], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => {});
    child.unref();
  }
};

export const findBundledBrowserExtensionPath = (
  environment: { isPackaged: boolean; resourcesPath: string; appPath: string },
  pathExists: (candidate: string) => boolean = fs.existsSync,
): string | null => {
  const candidates = environment.isPackaged
    ? [path.join(environment.resourcesPath, 'browser-extension')]
    : [
        path.join(environment.appPath, 'build', 'browser-extension'),
        path.join(process.cwd(), 'build', 'browser-extension'),
      ];
  return (
    candidates.find(candidate =>
      pathExists(path.join(candidate, 'chrome-extension', 'manifest.json')),
    ) ?? null
  );
};

const normalizeExtensionRelayToken = (value: string): string | null => {
  const token = value.trim();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
};

const readExtensionRelayToken = (secretPath: string): string | null => {
  try {
    return normalizeExtensionRelayToken(fs.readFileSync(secretPath, 'utf8'));
  } catch {
    return null;
  }
};

export const ensureBrowserExtensionRelayToken = (stateDir: string): string => {
  const secretPath = path.join(stateDir, 'credentials', EXTENSION_RELAY_SECRET_FILE);
  const existing = readExtensionRelayToken(secretPath);
  if (existing) return existing;

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(secretPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readExtensionRelayToken(secretPath);
    if (!winner) throw new Error('Browser extension relay secret is invalid.');
    return winner;
  }
};

const readConfiguredExtensionRelayPort = (configPath: string | undefined): number | null => {
  if (!configPath) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      browser?: { profiles?: { chrome?: { cdpPort?: unknown } } };
    };
    const port = Number(config.browser?.profiles?.chrome?.cdpPort);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
};

export const resolveBrowserExtensionRelayPort = (cli: OpenClawCliEnvironment): number => {
  const configured = readConfiguredExtensionRelayPort(cli.env.OPENCLAW_CONFIG_PATH);
  if (configured) return configured;
  const gatewayPort = Number(cli.env.OPENCLAW_GATEWAY_PORT);
  const derived = gatewayPort + EXTENSION_RELAY_GATEWAY_PORT_OFFSET;
  return Number.isInteger(derived) && derived > 0 && derived <= 65_535
    ? derived
    : DEFAULT_EXTENSION_RELAY_PORT;
};

const resolveBrowserExtensionPath = (): string => {
  const extensionPath = findBundledBrowserExtensionPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (!extensionPath) throw new Error('The bundled browser extension is missing.');
  return extensionPath;
};

export const copyBrowserExtensionPairing = async (
  buildCliEnvironment: () => Promise<OpenClawCliEnvironment>,
): Promise<void> => {
  const cli = await buildCliEnvironment();
  const stateDir = cli.env.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir || !path.isAbsolute(stateDir)) {
    throw new Error('Browser extension state directory is unavailable.');
  }
  const token = ensureBrowserExtensionRelayToken(stateDir);
  const relayPort = resolveBrowserExtensionRelayPort(cli);
  clipboard.writeText(`ws://127.0.0.1:${relayPort}/extension#${token}`);
  console.log(`[BrowserSettings] Browser extension pairing copied (relayPort=${relayPort}).`);
};

export const openBrowserExtensionFolder = async (
  extensionPath: string,
  openPath: (targetPath: string) => Promise<string> = shell.openPath,
): Promise<void> => {
  const error = await openPath(extensionPath);
  if (error) throw new Error(error);
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
  buildCliEnvironment: () => Promise<OpenClawCliEnvironment>;
  setBrowserMode: (mode: BrowserModeValue) => Promise<BrowserModeUpdateResult>;
};

type BrowserModeChangeDependencies = {
  readAppConfig: () => Record<string, unknown>;
  writeAppConfig: (config: Record<string, unknown>) => void;
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
    if (profile === 'chrome' && !isBrowserExtensionConnected(response)) {
      return {
        success: false,
        errorCode: 'extension-not-connected',
        error: 'The browser extension is not connected.',
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
  buildCliEnvironment,
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
    if (
      mode !== BrowserMode.Isolated &&
      mode !== BrowserMode.User &&
      mode !== BrowserMode.Extension
    ) {
      return {
        success: false,
        errorCode: 'invalid-mode',
      } satisfies BrowserModeUpdateResult;
    }
    return setBrowserMode(mode);
  });

  ipcMain.handle(BrowserIpc.OpenRemoteDebugging, () => {
    // Chrome may intentionally discard externally supplied chrome:// URLs.
    // Copy the internal URL and focus Chrome so the user can paste it into
    // the address bar, which works consistently across supported versions.
    clipboard.writeText(REMOTE_DEBUGGING_URL);
    return launchOrFocusChrome();
  });

  ipcMain.handle(BrowserIpc.OpenExtensionManagement, () => {
    clipboard.writeText(EXTENSION_MANAGEMENT_URL);
    return launchOrFocusChrome();
  });

  ipcMain.handle(BrowserIpc.RevealExtension, async (): Promise<BrowserActionResult> => {
    try {
      const extensionPath = resolveBrowserExtensionPath();
      console.log(`[BrowserSettings] Opening browser extension folder: ${extensionPath}`);
      await openBrowserExtensionFolder(extensionPath);
      return { success: true };
    } catch (error) {
      console.error('[BrowserSettings] Failed to open browser extension folder:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(BrowserIpc.CopyExtensionPairing, async (): Promise<BrowserActionResult> => {
    try {
      await copyBrowserExtensionPairing(buildCliEnvironment);
      return { success: true };
    } catch (error) {
      console.error('[BrowserSettings] Failed to copy browser extension pairing:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
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

  ipcMain.handle(
    BrowserIpc.TestExtensionConnection,
    async (): Promise<BrowserConnectionTestResult> =>
      testBrowserConnection(getGatewayClient(), 'chrome'),
  );
};

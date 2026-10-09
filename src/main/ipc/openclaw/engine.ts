import { spawn } from 'child_process';
import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OpenClawAssistantMediaIpc,
  type OpenClawAssistantMediaRequest,
  type OpenClawAssistantMediaResult,
} from '../../../shared/openclaw/assistantMedia';
import {
  type OpenClawSessionMigrationConfirmRequest,
  OpenClawSessionMigrationIpc,
} from '../../../shared/openclaw/sessionMigration';
import {
  type ManagedWorktree,
  type WorktreeCleanResult,
  WorktreeIpc,
  type WorktreeRemoveResult,
  type WorktreeResult,
} from '../../../shared/openclaw/worktrees';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { SystemPromptReplacementIpc } from '../../../shared/prompts/systemPromptReplacements';
import { JUSTDO_MANAGED_PYTHON_USER_BASE_ENV } from '../../core/runtime/pythonRuntime';
import type { CoworkStore } from '../../data/coworkStore';
import { isWorkspacePathWithin } from '../../engine/openclaw/runtimeAdapterSupport';
import { WorktreeSettingsService } from '../../openclaw/config/worktreeSettingsService';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';

interface OpenClawEngineHandlerDependencies {
  getManager: () => OpenClawEngineManager;
  getCoworkStore: () => CoworkStore;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  reconnectGatewayClient: () => Promise<void>;
  runConfigMutationExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}

const GATEWAY_RESTART_REQUEST_METHOD = 'gateway.restart.request';
const GATEWAY_IN_PROCESS_RESTART_TIMEOUT_MS = 30_000;
const GATEWAY_IN_PROCESS_RESTART_MAX_DELAY_MS = 1_000;
const ASSISTANT_MEDIA_TIMEOUT_MS = 15_000;
const MAX_ASSISTANT_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_ASSISTANT_MEDIA_SOURCE_LENGTH = 2_048;
const MAX_ASSISTANT_MEDIA_SESSION_KEY_LENGTH = 512;
const MANAGED_INBOUND_MEDIA_PATTERN = /^media:\/\/inbound\/([^/?#]+)$/i;
const MANAGED_OUTGOING_MEDIA_PATTERN =
  /^\/api\/chat\/media\/outgoing\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/full$/i;
const QUALIFIED_SESSION_AGENT_PATTERN = /^agent:([a-z0-9][a-z0-9_-]{0,63}):/i;

const GatewayRestartRequestStatus = {
  Scheduled: 'scheduled',
  Deferred: 'deferred',
  Coalesced: 'coalesced',
} as const;

type GatewayRestartRequestResult = {
  ok?: boolean;
  status?: (typeof GatewayRestartRequestStatus)[keyof typeof GatewayRestartRequestStatus];
  restart?: {
    delayMs?: number;
  };
};

const isAcceptedGatewayRestartRequest = (result: GatewayRestartRequestResult): boolean =>
  result.ok === true &&
  (result.status === GatewayRestartRequestStatus.Scheduled ||
    result.status === GatewayRestartRequestStatus.Deferred ||
    result.status === GatewayRestartRequestStatus.Coalesced);

async function readResponseBodyWithLimit(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSISTANT_MEDIA_BYTES) {
    await response.body?.cancel().catch((): undefined => undefined);
    throw new Error('Gateway image is too large');
  }
  if (!response.body) throw new Error('Gateway image response is empty');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ASSISTANT_MEDIA_BYTES) {
        await reader.cancel().catch((): undefined => undefined);
        throw new Error('Gateway image is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

const isCanonicalManagedInboundMediaSource = (source: string): boolean => {
  const match = MANAGED_INBOUND_MEDIA_PATTERN.exec(source);
  if (!match?.[1]) return false;
  try {
    const id = decodeURIComponent(match[1]);
    return (
      id !== '.' &&
      id !== '..' &&
      !id.includes('/') &&
      !id.includes('\\') &&
      !id.includes('\0')
    );
  } catch {
    return false;
  }
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch((): undefined => undefined);
};

const resolveQualifiedSessionAgentId = (sessionKey: string): string | undefined =>
  QUALIFIED_SESSION_AGENT_PATTERN.exec(sessionKey)?.[1]?.toLowerCase();

const isCanonicalManagedOutgoingMediaSource = (
  source: string,
  sessionKey: string,
): boolean => {
  const match = MANAGED_OUTGOING_MEDIA_PATTERN.exec(source);
  if (!match?.[1]) return false;
  try {
    return decodeURIComponent(match[1]) === sessionKey && match[1] === encodeURIComponent(sessionKey);
  } catch {
    return false;
  }
};

export async function readOpenClawAssistantMedia(
  manager: OpenClawEngineManager,
  request: OpenClawAssistantMediaRequest,
): Promise<OpenClawAssistantMediaResult> {
  const source = typeof request?.source === 'string' ? request.source.trim() : '';
  const sessionKey = typeof request?.sessionKey === 'string' ? request.sessionKey.trim() : '';
  if (
    !source ||
    source.length > MAX_ASSISTANT_MEDIA_SOURCE_LENGTH ||
    !sessionKey ||
    sessionKey.length > MAX_ASSISTANT_MEDIA_SESSION_KEY_LENGTH
  ) {
    return { success: false, error: 'Invalid Gateway image request' };
  }
  const isManagedInbound = isCanonicalManagedInboundMediaSource(source);
  const isManagedOutgoing = isCanonicalManagedOutgoingMediaSource(source, sessionKey);
  if (!isManagedInbound && !isManagedOutgoing) {
    return { success: false, error: 'Invalid Gateway image request' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASSISTANT_MEDIA_TIMEOUT_MS);
  try {
    if (manager.getStatus().phase !== 'running') {
      return { success: false, error: 'Gateway is not running' };
    }
    const { port, token } = manager.getGatewayConnectionInfo();
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      typeof token !== 'string' ||
      !token
    ) {
      return { success: false, error: 'Gateway connection is unavailable' };
    }
    let gatewayPath: string;
    const headers: Record<string, string> = {
      Accept: 'image/*',
      Authorization: `Bearer ${token}`,
    };
    if (isManagedOutgoing) {
      gatewayPath = source;
      headers['x-openclaw-requester-session-key'] = sessionKey;
    } else {
      const query = new URLSearchParams({ source, sessionKey });
      const agentId = resolveQualifiedSessionAgentId(sessionKey);
      if (agentId) query.set('agentId', agentId);
      gatewayPath = `/__openclaw__/assistant-media?${query.toString()}`;
    }
    const response = await fetch(
      `http://127.0.0.1:${port}${gatewayPath}`,
      {
        headers,
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      await cancelResponseBody(response);
      return { success: false, error: `Gateway image is unavailable (${response.status})` };
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!mimeType.startsWith('image/')) {
      await cancelResponseBody(response);
      return { success: false, error: 'Gateway response is not an image' };
    }
    const buffer = await readResponseBodyWithLimit(response);
    return {
      success: true,
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
      mimeType,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'Gateway image request timed out'
          : error instanceof Error
            ? error.message
            : 'Failed to read Gateway image',
    };
  } finally {
    clearTimeout(timeout);
  }
}

const reconnectGatewayClientAfterRestart = (
  reconnectGatewayClient: () => Promise<void>,
): void => {
  try {
    void reconnectGatewayClient().catch(error => {
      // The adapter keeps its normal reconnect loop. A transient bridge failure
      // must not turn a healthy Gateway restart into a false engine failure.
      console.warn(
        `[OpenClawEngine] Gateway restarted, but the runtime adapter did not reconnect immediately: ${String(error)}`,
      );
    });
  } catch (error) {
    console.warn(
      `[OpenClawEngine] Gateway restarted, but the runtime adapter did not reconnect immediately: ${String(error)}`,
    );
  }
};

export const restartOpenClawGatewayForUser = async ({
  getManager,
  requestGateway,
  reconnectGatewayClient,
}: Pick<OpenClawEngineHandlerDependencies, 'getManager' | 'requestGateway' | 'reconnectGatewayClient'>): Promise<OpenClawEngineStatus> => {
  const manager = getManager();
  const status = manager.getStatus();
  if (status.phase === 'starting') {
    const started = await manager.startGateway();
    if (started.phase !== 'running') return started;
    return restartOpenClawGatewayForUser({
      getManager,
      requestGateway,
      reconnectGatewayClient,
    });
  }
  const requiresLaunchArgumentRefresh =
    status.phase === 'running' &&
    manager.getGatewayPort() !== manager.getConfiguredGatewayPort();
  const requiresLaunchEnvironmentRefresh =
    status.phase === 'running' && manager.hasPendingGatewayLaunchEnvironmentChanges();

  if (
    status.phase === 'running' &&
    !requiresLaunchArgumentRefresh &&
    !requiresLaunchEnvironmentRefresh
  ) {
    const lifecycleGeneration = manager.getGatewayLifecycleGeneration();
    try {
      const result = await requestGateway<GatewayRestartRequestResult>(
        GATEWAY_RESTART_REQUEST_METHOD,
        {
          reason: 'justdo-manual-restart',
          // Preserve the existing manual-restart behavior: the explicit user
          // action is not held for the automatic workload deferral window.
          skipDeferral: true,
        },
      );
      if (!isAcceptedGatewayRestartRequest(result)) {
        throw new Error('Gateway rejected the in-process restart request.');
      }
      const scheduledDelayMs = result.restart?.delayMs;
      if (
        typeof scheduledDelayMs === 'number' &&
        scheduledDelayMs > GATEWAY_IN_PROCESS_RESTART_MAX_DELAY_MS
      ) {
        throw new Error(
          `Gateway delayed the in-process restart by ${scheduledDelayMs}ms.`,
        );
      }

      const ready = await manager.waitForGatewayReadyAfter(
        lifecycleGeneration,
        GATEWAY_IN_PROCESS_RESTART_TIMEOUT_MS,
      );
      if (!ready || manager.getStatus().phase !== 'running') {
        throw new Error('Gateway did not become ready after the in-process restart.');
      }

      console.log('[OpenClawEngine] Gateway in-process restart completed.');
      reconnectGatewayClientAfterRestart(reconnectGatewayClient);
      return manager.getStatus();
    } catch (error) {
      console.warn(
        `[OpenClawEngine] In-process Gateway restart unavailable; falling back to a full restart: ${String(error)}`,
      );
    }
  } else if (requiresLaunchArgumentRefresh) {
    console.log(
      '[OpenClawEngine] Gateway port changed; using a full restart to refresh launch arguments.',
    );
  } else if (requiresLaunchEnvironmentRefresh) {
    console.log(
      '[OpenClawEngine] Gateway launch environment changed; using a full restart to apply it.',
    );
  }

  const restarted = await manager.restartGateway();
  if (restarted.phase === 'running') {
    reconnectGatewayClientAfterRestart(reconnectGatewayClient);
  }
  return restarted;
};

const isAvailable = (status: OpenClawEngineStatus): boolean =>
  status.phase === 'running' || status.phase === 'ready';

const quoteAppleScriptString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const quotePosixShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const escapeWindowsCmdValue = (value: string): string =>
  value
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>');

const interactiveShellCommand = (fallbackShell: string): string =>
  'exec "${SHELL:-' + fallbackShell + '}"';

export const resolveExternalTerminalCwd = (requestedCwd: unknown, fallbackCwd: string): string => {
  if (requestedCwd === undefined) return fallbackCwd;
  if (
    typeof requestedCwd !== 'string' ||
    requestedCwd.length === 0 ||
    requestedCwd.length > 4096 ||
    requestedCwd.includes('\0')
  ) {
    throw new Error('Invalid terminal working directory');
  }
  const resolved = path.resolve(requestedCwd);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('Terminal working directory is not a directory');
  }
  return resolved;
};

const isOpenClawTerminalEnvKey = (key: string): boolean => {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey === JUSTDO_MANAGED_PYTHON_USER_BASE_ENV) return false;
  return (
    key === 'OPENCLAW_BUNDLED_SKILLS_DIR' ||
    key === 'OPENCLAW_BUNDLED_HOOKS_DIR' ||
    key === 'OPENCLAW_STATE_DIR' ||
    key === 'OPENCLAW_CONFIG_PATH' ||
    key === 'OPENCLAW_GATEWAY_TOKEN' ||
    key === 'OPENCLAW_GATEWAY_PORT' ||
    key === 'OPENCLAW_NO_AUTO_UPDATE' ||
    key === 'OPENCLAW_BUNDLED_PLUGINS_DIR' ||
    key === 'OPENCLAW_LOG_LEVEL' ||
    key === 'NODE_COMPILE_CACHE' ||
    key === 'NPM_CONFIG_USERCONFIG' ||
    key === 'npm_config_userconfig' ||
    key === 'PIP_CONFIG_FILE' ||
    key === 'NODE_OPTIONS' ||
    key === 'NODE_EXTRA_CA_CERTS' ||
    key === 'NODE_USE_ENV_PROXY' ||
    key === 'REQUESTS_CA_BUNDLE' ||
    key === 'CURL_CA_BUNDLE' ||
    key === 'SSL_CERT_FILE' ||
    key === 'PIP_CERT' ||
    key === 'JUSTDO_ELECTRON_PATH' ||
    key === 'JUSTDO_OPENCLAW_ENTRY' ||
    key === 'JUSTDO_NPM_BIN_DIR' ||
    key === 'PATH' ||
    key === 'Path' ||
    key === 'TZ' ||
    normalizedKey === 'HTTP_PROXY' ||
    normalizedKey === 'HTTPS_PROXY' ||
    normalizedKey === 'ALL_PROXY' ||
    normalizedKey === 'NO_PROXY' ||
    key.startsWith('JUSTDO_')
  );
};

export const getOpenClawTerminalEnvKeys = (env: NodeJS.ProcessEnv): string[] => {
  const pythonUserBase = env.PYTHONUSERBASE;
  const hasManagedPythonUserBase =
    typeof pythonUserBase === 'string' &&
    pythonUserBase.length > 0 &&
    env[JUSTDO_MANAGED_PYTHON_USER_BASE_ENV] === pythonUserBase;
  const keys = Object.keys(env).filter(
    key =>
      isOpenClawTerminalEnvKey(key) || (key === 'PYTHONUSERBASE' && hasManagedPythonUserBase),
  );
  const orderedKeys = ['PATH', ...keys.filter(key => key !== 'PATH' && key !== 'Path').sort()];
  return Array.from(new Set(orderedKeys));
};

const buildPosixExportScript = (env: NodeJS.ProcessEnv): string => {
  return getOpenClawTerminalEnvKeys(env)
    .map(key => {
      const value = key === 'PATH' ? env.PATH || env.Path : env[key];
      return typeof value === 'string' ? `export ${key}=${quotePosixShell(value)}` : null;
    })
    .filter((line): line is string => line !== null)
    .join('; ');
};

export type TerminalCandidate = {
  command: string;
  args: string[];
  windowsHide?: boolean;
};

export const resolveWindowsPowerShell = (env: NodeJS.ProcessEnv): string => {
  for (const directory of (env.PATH || env.Path)?.split(path.delimiter) ?? []) {
    const normalizedDirectory = directory.replace(/^"|"$/g, '').trim();
    if (!path.isAbsolute(normalizedDirectory)) continue;
    const candidate = path.join(normalizedDirectory, 'pwsh.exe');
    if (fs.existsSync(candidate)) return candidate;
  }

  const systemRoot = env.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
  const bundledPowerShell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return fs.existsSync(bundledPowerShell) ? bundledPowerShell : 'powershell.exe';
};

export const buildWindowsTerminalCandidates = (
  commandProcessor: string,
  powershellPath: string,
  cwd: string,
  terminalTitle: string,
): TerminalCandidate[] => [
  {
    command: commandProcessor,
    // Electron is a GUI process and has no console to inherit. Launching cmd.exe
    // directly can therefore leave a live command processor with no visible
    // window. `start` explicitly creates the interactive terminal window while
    // this short-lived launcher remains hidden.
    args: [
      '/d',
      '/c',
      'start',
      '',
      powershellPath,
      '-NoLogo',
      '-NoExit',
      '-Command',
      `$Host.UI.RawUI.WindowTitle = '${terminalTitle.replace(/'/g, "''")}'`,
    ],
    windowsHide: true,
  },
  {
    command: commandProcessor,
    args: [
      '/d',
      '/c',
      'start',
      '',
      commandProcessor,
      '/d',
      '/k',
      `title ${escapeWindowsCmdValue(terminalTitle)}`,
    ],
    windowsHide: true,
  },
  {
    command: 'wt.exe',
    args: ['-w', 'new', 'new-tab', '-d', cwd, powershellPath, '-NoLogo', '-NoExit'],
  },
];

export const spawnDetachedTerminal = (
  candidate: TerminalCandidate,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
  spawnProcess: typeof spawn = spawn,
  startupObservationMs: number | null = 500,
): Promise<{ success: boolean; error?: string }> =>
  new Promise(resolve => {
    let settled = false;
    let startupTimer: NodeJS.Timeout | undefined;
    const settle = (result: { success: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      resolve(result);
    };
    const child = spawnProcess(candidate.command, candidate.args, {
      ...options,
      windowsHide: candidate.windowsHide ?? options.windowsHide,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', error => {
      settle({ success: false, error: error.message });
    });
    child.once('spawn', () => {
      if (startupObservationMs === null) return;
      startupTimer = setTimeout(() => {
        child.unref();
        settle({ success: true });
      }, startupObservationMs);
    });
    child.once('exit', code => {
      settle(
        code === 0
          ? { success: true }
          : { success: false, error: `Terminal launcher exited with code ${String(code)}` },
      );
    });
  });

const launchTerminal = async (options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<{ success: boolean; error?: string }> => {
  const { env, cwd } = options;

  if (process.platform === 'win32') {
    const commandProcessor =
      process.env.ComSpec ||
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const powershellPath = resolveWindowsPowerShell(env);
    const terminalTitle = `${PRODUCT_NAME} Terminal`;
    console.log(`[OpenClawEngine] Opening OpenClaw terminal on Windows, cwd=${cwd}`);
    for (const candidate of buildWindowsTerminalCandidates(
      commandProcessor,
      powershellPath,
      cwd,
      terminalTitle,
    )) {
      const result = await spawnDetachedTerminal(candidate, { cwd, env, windowsHide: false });
      if (result.success) {
        console.log(`[OpenClawEngine] Opened Windows terminal via ${candidate.command}`);
        return result;
      }
      console.warn(
        `[OpenClawEngine] Failed to open Windows terminal via ${candidate.command}: ${result.error || 'unknown error'}`,
      );
    }
    return { success: false, error: 'Failed to launch the Windows system terminal' };
  }

  if (process.platform === 'darwin') {
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-terminal-'));
    const launcherPath = path.join(launcherDir, 'launch.sh');
    const launcher = [
      '#!/bin/sh',
      buildPosixExportScript(env),
      `rm -f -- ${quotePosixShell(launcherPath)}`,
      `rmdir ${quotePosixShell(launcherDir)} 2>/dev/null || true`,
      `cd ${quotePosixShell(cwd)}`,
      interactiveShellCommand('/bin/zsh'),
      '',
    ].join('\n');
    fs.writeFileSync(launcherPath, launcher, { encoding: 'utf8', mode: 0o700 });
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script "${quoteAppleScriptString(quotePosixShell(launcherPath))}"`,
      'end tell',
    ].join('\n');
    console.log(`[OpenClawEngine] Opening OpenClaw terminal on macOS, cwd=${cwd}`);
    const result = await spawnDetachedTerminal(
      { command: 'osascript', args: ['-e', script] },
      {},
      spawn,
      null,
    );
    if (!result.success) {
      fs.rmSync(launcherDir, { recursive: true, force: true });
      return result;
    }
    const cleanupTimer = setTimeout(() => {
      fs.rmSync(launcherDir, { recursive: true, force: true });
    }, 30_000);
    cleanupTimer.unref();
    return result;
  }

  const command = `${buildPosixExportScript(env)}; ${interactiveShellCommand('/bin/bash')}`;
  const terminalCandidates: TerminalCandidate[] = [
    { command: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', command] },
    { command: 'gnome-terminal', args: ['--', 'sh', '-lc', command] },
    { command: 'konsole', args: ['-e', 'sh', '-lc', command] },
    { command: 'xterm', args: ['-e', 'sh', '-lc', command] },
  ];

  for (const candidate of terminalCandidates) {
    console.log(
      `[OpenClawEngine] Opening OpenClaw terminal on Linux via ${candidate.command}, cwd=${cwd}`,
    );
    const result = await spawnDetachedTerminal(candidate, { cwd, env });
    if (result.success) return result;
  }

  return Promise.resolve({ success: false, error: 'No supported terminal emulator was found' });
};

export const registerOpenClawEngineHandlers = ({
  getManager,
  getCoworkStore,
  requestGateway,
  reconnectGatewayClient,
  runConfigMutationExclusive,
}: OpenClawEngineHandlerDependencies): void => {
  let restartGatewayPromise: Promise<OpenClawEngineStatus> | null = null;

  getManager().onSessionMigrationProgress(progress => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(OpenClawSessionMigrationIpc.Progress, progress);
      }
    }
  });

  ipcMain.handle(OpenClawSessionMigrationIpc.Plan, async () => {
    try {
      return { success: true, plan: await getManager().getSessionMigrationPlan() };
    } catch (error) {
      console.warn(
        '[OpenClawEngine] Failed to prepare session migration plan:',
        error instanceof Error ? error.name : 'UnknownError',
      );
      return {
        success: false,
        error: 'Failed to prepare session migration.',
      };
    }
  });

  ipcMain.handle(
    OpenClawSessionMigrationIpc.Confirm,
    async (_event, request: OpenClawSessionMigrationConfirmRequest) => {
      if (
        !request ||
        typeof request.planId !== 'string' ||
        typeof request.approved !== 'boolean'
      ) {
        return { success: false, error: 'Invalid session migration confirmation.' };
      }
      try {
        const result = await getManager().confirmSessionMigration(
          request.planId,
          request.approved,
        );
        if (result.success) {
          const status = await getManager().startGateway();
          return { ...result, status };
        }
        return result;
      } catch (error) {
        console.warn(
          '[OpenClawEngine] Session migration confirmation failed:',
          error instanceof Error ? error.name : 'UnknownError',
        );
        return { success: false, error: 'Session migration failed.' };
      }
    },
  );

  ipcMain.handle('openclaw:engine:getStatus', async () => {
    try {
      return { success: true, status: getManager().getStatus() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw engine status',
      };
    }
  });

  const worktreeResult = async <T>(operation: () => Promise<T>): Promise<WorktreeResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const worktreeSettings = new WorktreeSettingsService(requestGateway, () => getManager().getStateDir());
  ipcMain.handle(WorktreeIpc.Settings, () => worktreeSettings.getSettings());
  ipcMain.handle(WorktreeIpc.SaveSettings, (_event, input: unknown) =>
    runConfigMutationExclusive(() => worktreeSettings.saveSettings(input)),
  );
  const worktreeId = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      throw new Error('Invalid worktree ID');
    }
    return value.trim();
  };
  ipcMain.handle(WorktreeIpc.List, () =>
    worktreeResult(async () => {
      const response = await requestGateway<{ worktrees: ManagedWorktree[] }>('worktrees.list', {});
      if (!Array.isArray(response.worktrees)) throw new Error('Invalid worktree list');
      return response.worktrees;
    }),
  );
  ipcMain.handle(WorktreeIpc.Restore, (_event, id: unknown) =>
    worktreeResult(async () => {
      await requestGateway('worktrees.restore', { id: worktreeId(id) });
      return true;
    }),
  );
  ipcMain.handle(WorktreeIpc.Remove, (_event, id: unknown) =>
    worktreeResult(async () => {
      const targetId = worktreeId(id);
      const response = await requestGateway<{ worktrees: ManagedWorktree[] }>('worktrees.list', {});
      const record = response.worktrees.find(item => item.id === targetId);
      if (!record) throw new Error('Worktree not found. Refresh the list.');
      const store = getCoworkStore();
      if (
        store
          .listSessions()
          .some(
            summary => {
              const session = store.getSession(summary.id);
              return session && isWorkspacePathWithin(session.cwd, record.path);
            },
          )
      ) {
        throw new Error('Delete the linked conversation before removing this worktree.');
      }
      return requestGateway<WorktreeRemoveResult>('worktrees.remove', { id: targetId });
    }),
  );
  ipcMain.handle(WorktreeIpc.Clean, () =>
    worktreeResult(() => requestGateway<WorktreeCleanResult>('worktrees.gc', {})),
  );

  ipcMain.handle(SystemPromptReplacementIpc.GetRules, () => {
    try {
      return {
        success: true,
        rules: getManager().getSystemPromptReplacementRules(),
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to get system prompt replacement rules',
      };
    }
  });

  ipcMain.handle(SystemPromptReplacementIpc.SetRules, (_event, rules: unknown) => {
    try {
      return {
        success: true,
        rules: getManager().setSystemPromptReplacementRules(rules),
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to set system prompt replacement rules',
      };
    }
  });

  ipcMain.handle('openclaw:engine:restartGateway', async () => {
    const restart =
      restartGatewayPromise ??
      restartOpenClawGatewayForUser({
        getManager,
        requestGateway,
        reconnectGatewayClient,
      });
    restartGatewayPromise = restart;
    try {
      const status = await restart;
      return { success: isAvailable(status), status };
    } catch (error) {
      return {
        success: false,
        status: getManager().getStatus(),
        error: error instanceof Error ? error.message : 'Failed to restart OpenClaw gateway',
      };
    } finally {
      if (restartGatewayPromise === restart) {
        restartGatewayPromise = null;
      }
    }
  });

  ipcMain.handle('openclaw:engine:getPort', () => {
    try {
      const manager = getManager();
      const port = manager.getConfiguredGatewayPort();
      const activePort = manager.getStatus().phase === 'running' ? manager.getGatewayPort() : undefined;
      return { success: true, port, activePort, requiresRestart: activePort !== undefined && activePort !== port };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw gateway port',
      };
    }
  });

  ipcMain.handle('openclaw:engine:getToken', () => {
    try {
      const manager = getManager();
      let token = manager.getGatewayToken();
      const status = manager.getStatus();
      if (token === null && status.phase === 'running') {
        console.log('[OpenClawEngine] Gateway running but token is null, checking connection info');
        token = manager.getGatewayConnectionInfo().token;
      }
      if (token === null) {
        if (status.phase !== 'running') {
          return { success: false, error: 'Gateway not running' };
        }
        console.warn('[OpenClawEngine] Gateway is running but token is unavailable');
        return {
          success: false,
          error: 'Gateway token not available. Try restarting the gateway.',
        };
      }
      return { success: true, token };
    } catch (error) {
      console.error('[OpenClawEngine] Failed to get gateway token:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw gateway token',
      };
    }
  });

  ipcMain.handle(
    OpenClawAssistantMediaIpc.ReadDataUrl,
    async (_event, request: OpenClawAssistantMediaRequest) =>
      readOpenClawAssistantMedia(getManager(), request),
  );

  ipcMain.handle('openclaw:engine:setPort', async (_event, port: number) => {
    try {
      return await getManager().setGatewayPort(port);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set OpenClaw gateway port',
      };
    }
  });

  ipcMain.handle('openclaw:engine:openTerminal', async (_event, requestedCwd?: unknown) => {
    try {
      const manager = getManager();
      const status = manager.getStatus();
      if (status.phase !== 'running') {
        const started = await manager.startGateway();
        if (started.phase !== 'running') {
          return {
            success: false,
            error: started.message || 'OpenClaw gateway is not running',
            status: started,
          };
        }
      }

      const cliEnvironment = await manager.buildCliEnvironment();
      return launchTerminal({
        env: cliEnvironment.env,
        cwd: resolveExternalTerminalCwd(requestedCwd, cliEnvironment.runtimeRoot),
      });
    } catch (error) {
      console.error('[OpenClawEngine] Failed to open terminal:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open OpenClaw terminal',
      };
    }
  });
};

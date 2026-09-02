import { spawn } from 'child_process';
import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type OpenClawSessionMigrationConfirmRequest,
  OpenClawSessionMigrationIpc,
} from '../../../shared/openclaw/sessionMigration';
import { SystemPromptReplacementIpc } from '../../../shared/openclaw/systemPromptReplacements';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { JUSTDO_MANAGED_PYTHON_USER_BASE_ENV } from '../../core/pythonRuntime';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';

interface OpenClawEngineHandlerDependencies {
  getManager: () => OpenClawEngineManager;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  reconnectGatewayClient: () => Promise<void>;
}

const GATEWAY_RESTART_REQUEST_METHOD = 'gateway.restart.request';
const GATEWAY_IN_PROCESS_RESTART_TIMEOUT_MS = 30_000;
const GATEWAY_IN_PROCESS_RESTART_MAX_DELAY_MS = 1_000;

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
}: OpenClawEngineHandlerDependencies): Promise<OpenClawEngineStatus> => {
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
  'exec ${SHELL:-' + fallbackShell + '}';

const isOpenClawTerminalEnvKey = (key: string): boolean => {
  if (key.toUpperCase() === JUSTDO_MANAGED_PYTHON_USER_BASE_ENV) return false;
  return (
    key === 'SKILLS_ROOT' ||
    key === 'JUSTDO_SKILLS_ROOT' ||
    key === 'OPENCLAW_BUNDLED_SKILLS_DIR' ||
    key === 'OPENCLAW_STATE_DIR' ||
    key === 'OPENCLAW_CONFIG_PATH' ||
    key === 'OPENCLAW_GATEWAY_TOKEN' ||
    key === 'OPENCLAW_GATEWAY_PORT' ||
    key === 'OPENCLAW_NO_RESPAWN' ||
    key === 'OPENCLAW_ENGINE_VERSION' ||
    key === 'OPENCLAW_BUNDLED_PLUGINS_DIR' ||
    key === 'OPENCLAW_LOG_LEVEL' ||
    key === 'NODE_COMPILE_CACHE' ||
    key === 'NPM_CONFIG_USERCONFIG' ||
    key === 'npm_config_userconfig' ||
    key === 'PIP_CONFIG_FILE' ||
    key === 'JUSTDO_ELECTRON_PATH' ||
    key === 'JUSTDO_OPENCLAW_ENTRY' ||
    key === 'JUSTDO_NPM_BIN_DIR' ||
    key === 'PATH' ||
    key === 'Path' ||
    key === 'TZ' ||
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

const launchTerminal = (options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<{ success: boolean; error?: string }> => {
  const { env, cwd } = options;
  const terminalTitle = `${PRODUCT_NAME} Terminal`;
  const terminalReadyMessage = `${PRODUCT_NAME} CLI is ready.`;

  if (process.platform === 'win32') {
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-terminal-'));
    fs.mkdirSync(launcherDir, { recursive: true });
    const launcherPath = path.join(launcherDir, 'justdo-openclaw-terminal.cmd');
    const envLines = getOpenClawTerminalEnvKeys(env)
      .map(key => {
        const value = key === 'PATH' ? env.PATH || env.Path : env[key];
        return typeof value === 'string' ? `set "${key}=${escapeWindowsCmdValue(value)}"` : null;
      })
      .filter((line): line is string => line !== null);
    const launcher = [
      '@echo off',
      `title ${escapeWindowsCmdValue(terminalTitle)}`,
      ...envLines,
      `cd /d "${cwd}"`,
      `echo ${escapeWindowsCmdValue(terminalTitle)}`,
      'echo.',
      `echo ${escapeWindowsCmdValue(terminalReadyMessage)}`,
      'echo.',
      '',
    ].join('\r\n');

    fs.writeFileSync(launcherPath, launcher, 'utf8');

    console.log(
      `[OpenClawEngine] Opening OpenClaw terminal on Windows via launcher=${launcherPath}, cwd=${cwd}`,
    );
    const commandProcessor = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

    return new Promise(resolve => {
      const child = spawn(
        commandProcessor,
        ['/d', '/c', 'start', '', commandProcessor, '/d', '/k', launcherPath],
        {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );

      child.once('error', error => {
        fs.rmSync(launcherDir, { recursive: true, force: true });
        console.error('[OpenClawEngine] Failed to launch Windows terminal:', error);
        resolve({ success: false, error: error.message });
      });
      child.once('exit', code => {
        if (code !== 0) {
          fs.rmSync(launcherDir, { recursive: true, force: true });
          const error = `Windows terminal launcher exited with code ${code}`;
          console.error(`[OpenClawEngine] ${error}`);
          resolve({ success: false, error });
          return;
        }
        child.unref();
        const cleanupTimer = setTimeout(() => {
          fs.rmSync(launcherDir, { recursive: true, force: true });
        }, 10_000);
        cleanupTimer.unref();
        resolve({ success: true });
      });
    });
  }

  if (process.platform === 'darwin') {
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script "${quoteAppleScriptString(
        `cd ${quotePosixShell(cwd)}; ${buildPosixExportScript(
          env,
        )}; clear; echo ${quotePosixShell(terminalTitle)}; echo; echo ${quotePosixShell(terminalReadyMessage)}; echo; ${interactiveShellCommand('/bin/zsh')}`,
      )}"`,
      'end tell',
    ].join('\n');
    console.log(`[OpenClawEngine] Opening OpenClaw terminal on macOS, cwd=${cwd}`);
    const child = spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return Promise.resolve({ success: true });
  }

  const command = `cd ${quotePosixShell(cwd)}; ${buildPosixExportScript(
    env,
  )}; clear; echo ${quotePosixShell(terminalTitle)}; echo; echo ${quotePosixShell(terminalReadyMessage)}; echo; ${interactiveShellCommand('/bin/bash')}`;
  const terminalCandidates: Array<{ command: string; args: string[] }> = [
    { command: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', command] },
    { command: 'gnome-terminal', args: ['--', 'sh', '-lc', command] },
    { command: 'konsole', args: ['-e', 'sh', '-lc', command] },
    { command: 'xterm', args: ['-e', 'sh', '-lc', command] },
  ];

  for (const candidate of terminalCandidates) {
    try {
      console.log(
        `[OpenClawEngine] Opening OpenClaw terminal on Linux via ${candidate.command}, cwd=${cwd}`,
      );
      const child = spawn(candidate.command, candidate.args, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return Promise.resolve({ success: true });
    } catch {
      // Try the next installed terminal.
    }
  }

  return Promise.resolve({ success: false, error: 'No supported terminal emulator was found' });
};

export const registerOpenClawEngineHandlers = ({
  getManager,
  requestGateway,
  reconnectGatewayClient,
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

  ipcMain.handle('openclaw:engine:openTerminal', async () => {
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
        cwd: cliEnvironment.runtimeRoot,
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

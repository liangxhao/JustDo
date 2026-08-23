import { execFile } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type { MulticaIntegrationResult, MulticaIntegrationStatus } from '../../../shared/multica';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { SqliteStore } from '../../data/sqliteStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { MULTICA_BRIDGE_PROTOCOL_VERSION } from './multicaBridgeProtocol';
import {
  ensureMulticaCommandLauncher,
  MULTICA_COMMAND_NAME,
  type MulticaCommandLauncher,
  removeMulticaCommandLauncher,
} from './multicaCommandLauncher';

const execFileAsync = promisify(execFile);
const STATE_KEY = 'multica_integration_v1';
const LOG_PREFIX = '[MulticaIntegrationService]';

let operationSequence = 0;

class MulticaIntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const multicaErrorCategory = (error: unknown): string => {
  if (error instanceof MulticaIntegrationError) return error.code;
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
};

interface PersistedIntegrationState {
  enabled: boolean;
  profileName?: string;
  managedBinaryPath: string;
  launcherArguments?: string[];
  commandLauncherPath?: string;
  commandLine?: string;
}

interface MulticaDaemonStatusPayload {
  active_task_count?: number;
  running_task_count?: number;
  agents?: string[];
  cli_version?: string;
  launched_by?: string;
  pid?: number;
  profile?: string;
  status?: string;
  workspaces?: Array<{ id?: string }>;
}

interface DetectedMultica {
  executable: string;
  version: string | null;
  profileName: string | null;
  daemon: MulticaDaemonStatusPayload | null;
}

const DESKTOP_PROFILE_PREFIX = 'desktop-';
const DESKTOP_PROFILE_USER_ID_FILE = '.desktop-user-id';

export interface MulticaIntegrationServiceOptions {
  getStore: () => SqliteStore;
  getEngineManager: () => OpenClawEngineManager;
  isBridgeRunning: () => boolean;
  getLauncherPath?: () => string;
  getLauncherArguments?: () => string[];
  getCommandLauncher?: (
    targetPath: string,
    targetArgs: readonly string[],
  ) => MulticaCommandLauncher;
}

export const isMulticaDesktopProfile = (
  profilesRoot: string,
  profileName: string,
  status: MulticaDaemonStatusPayload,
): boolean => {
  if (status.launched_by === 'desktop') return true;
  if (!profileName.startsWith(DESKTOP_PROFILE_PREFIX)) return false;
  return fs.existsSync(path.join(profilesRoot, profileName, DESKTOP_PROFILE_USER_ID_FILE));
};

export const isAllowedLocalMulticaCommand = (args: string[]): boolean =>
  (args.length === 1 && args[0] === '--version') ||
  (args.length === 6 &&
    args[0] === 'daemon' &&
    args[1] === 'status' &&
    args[2] === '--profile' &&
    Boolean(args[3]) &&
    args[4] === '--output' &&
    args[5] === 'json');

const normalizePathForComparison = (value: string): string => {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
};

export class MulticaIntegrationService {
  constructor(private readonly options: MulticaIntegrationServiceOptions) {}

  private nextOperationId(action: string): string {
    operationSequence += 1;
    return `${action}-${operationSequence}`;
  }

  async getStatus(): Promise<MulticaIntegrationStatus> {
    const operationId = this.nextOperationId('status');
    const state = this.options.getStore().get<PersistedIntegrationState>(STATE_KEY);
    console.debug(`${LOG_PREFIX} status started`, {
      operationId,
      enabled: state?.enabled === true,
    });
    let detected: DetectedMultica | null = null;
    let detectionError: string | undefined;
    let detectionErrorCode: string | undefined;
    try {
      detected = await this.detectMultica();
    } catch (error) {
      detectionError = error instanceof Error ? error.message : String(error);
      if (error instanceof MulticaIntegrationError) detectionErrorCode = error.code;
      console.warn(`${LOG_PREFIX} status detection failed`, {
        operationId,
        category: multicaErrorCategory(error),
      });
    }

    let targetLauncherPath = '';
    try {
      targetLauncherPath = this.getLauncherPath();
    } catch (error) {
      detectionError ||= error instanceof Error ? error.message : String(error);
    }
    const manager = this.options.getEngineManager();
    const engineStatus = manager.getStatus();
    const usesCurrentLauncher = Boolean(
      state?.enabled &&
      targetLauncherPath &&
      normalizePathForComparison(state.managedBinaryPath) ===
        normalizePathForComparison(targetLauncherPath),
    );
    let launcherReady = false;
    if (usesCurrentLauncher && state?.commandLauncherPath) {
      launcherReady =
        fs.existsSync(state.commandLauncherPath) &&
        !(
          process.platform === 'win32' &&
          path.extname(state.commandLauncherPath).toLowerCase() !== '.exe'
        ) &&
        Boolean(state.commandLine);
    }
    const daemonState =
      detected?.daemon?.status === 'running' ? 'running' : detected ? 'stopped' : 'unavailable';

    const result: MulticaIntegrationStatus = {
      enabled: state?.enabled === true,
      supported: Boolean(targetLauncherPath),
      networkPolicy: 'local-only',
      launcherPath:
        usesCurrentLauncher && state?.commandLauncherPath
          ? state.commandLauncherPath
          : targetLauncherPath,
      bridgeState: this.options.isBridgeRunning() ? 'running' : 'stopped',
      bridgeProtocolVersion: MULTICA_BRIDGE_PROTOCOL_VERSION,
      openclawVersion: engineStatus.version,
      gatewayPhase: engineStatus.phase,
      gatewayPort: manager.getGatewayPort() || null,
      multicaExecutable: detected?.executable ?? null,
      multicaVersion: detected?.version ?? detected?.daemon?.cli_version ?? null,
      profileName: detected?.profileName ?? state?.profileName ?? null,
      daemonState,
      activeTaskCount: detected?.daemon ? this.activeTaskCount(detected.daemon) : 0,
      launcherReady,
      manualSetup: {
        protocolFamily: 'Openclaw',
        displayName: PRODUCT_NAME,
        commandName:
          usesCurrentLauncher && state?.commandLine
            ? state.commandLine
            : process.platform === 'win32' && targetLauncherPath
              ? targetLauncherPath.replaceAll('\\', '/')
              : MULTICA_COMMAND_NAME,
        description: `${PRODUCT_NAME} local Agent runtime`,
      },
      ...(detectionError
        ? {
            errorCode: detectionErrorCode ?? 'MULTICA_DETECTION_FAILED',
            error: detectionError,
          }
        : {}),
    };
    console.debug(`${LOG_PREFIX} status completed`, {
      operationId,
      supported: result.supported,
      bridgeState: result.bridgeState,
      daemonState: result.daemonState,
      activeTaskCount: result.activeTaskCount,
      launcherReady: result.launcherReady,
      errorCode: result.errorCode ?? null,
    });
    return result;
  }

  async enable(): Promise<MulticaIntegrationResult> {
    const operationId = this.nextOperationId('enable');
    console.info(`${LOG_PREFIX} enable started`, { operationId });
    try {
      let detected: DetectedMultica | null = null;
      try {
        detected = await this.detectMultica();
      } catch (error) {
        console.info(`${LOG_PREFIX} local launcher will be prepared without Multica detection`, {
          operationId,
          category: multicaErrorCategory(error),
        });
      }
      const existing = this.options.getStore().get<PersistedIntegrationState>(STATE_KEY);
      const managedBinaryPath = this.getLauncherPath();
      const launcherArguments = this.options.getLauncherArguments?.() ?? [];
      const commandLauncher = this.getCommandLauncher(managedBinaryPath, launcherArguments);
      if (
        !this.options.getCommandLauncher &&
        existing?.commandLauncherPath &&
        normalizePathForComparison(existing.commandLauncherPath) !==
          normalizePathForComparison(commandLauncher.path)
      ) {
        removeMulticaCommandLauncher(
          existing.commandLauncherPath,
          existing.managedBinaryPath,
          process.platform,
          existing.launcherArguments ?? [],
        );
      }
      const state: PersistedIntegrationState = {
        enabled: true,
        ...(detected?.profileName || existing?.profileName
          ? { profileName: detected?.profileName ?? existing?.profileName }
          : {}),
        managedBinaryPath,
        launcherArguments,
        commandLauncherPath: commandLauncher.path,
        commandLine: commandLauncher.commandLine,
      };
      this.options.getStore().set(STATE_KEY, state);
      console.info(`${LOG_PREFIX} local launcher state saved`, { operationId });
      console.info(`${LOG_PREFIX} enable completed`, { operationId });
      return { success: true, status: await this.getStatus() };
    } catch (error) {
      console.warn(`${LOG_PREFIX} enable failed`, {
        operationId,
        category: multicaErrorCategory(error),
      });
      return this.failure(error);
    }
  }

  async disable(): Promise<MulticaIntegrationResult> {
    const operationId = this.nextOperationId('disable');
    console.info(`${LOG_PREFIX} disable started`, { operationId });
    const state = this.options.getStore().get<PersistedIntegrationState>(STATE_KEY);
    if (!state) return { success: true, status: await this.getStatus() };
    try {
      this.removeCommandLauncher(state);
      const disabledState: PersistedIntegrationState = {
        ...state,
        enabled: false,
      };
      this.options.getStore().set(STATE_KEY, disabledState);
      console.info(`${LOG_PREFIX} disable completed`, { operationId });
      return { success: true, status: await this.getStatus() };
    } catch (error) {
      console.warn(`${LOG_PREFIX} disable failed`, {
        operationId,
        category: multicaErrorCategory(error),
      });
      return this.failure(error);
    }
  }

  async refresh(): Promise<MulticaIntegrationResult> {
    const operationId = this.nextOperationId('refresh');
    console.info(`${LOG_PREFIX} refresh started`, { operationId });
    try {
      const state = this.options.getStore().get<PersistedIntegrationState>(STATE_KEY);
      if (state?.enabled) {
        const currentStatus = await this.getStatus();
        if (!currentStatus.launcherReady) {
          console.info(`${LOG_PREFIX} refresh repairing missing local launcher`, {
            operationId,
          });
          return this.enable();
        }
      }
      const status = await this.getStatus();
      console.info(`${LOG_PREFIX} refresh completed`, {
        operationId,
        launcherReady: status.launcherReady,
        errorCode: status.errorCode ?? null,
      });
      return { success: true, status };
    } catch (error) {
      console.warn(`${LOG_PREFIX} refresh failed`, {
        operationId,
        category: multicaErrorCategory(error),
      });
      return this.failure(error);
    }
  }

  private async failure(error: unknown): Promise<MulticaIntegrationResult> {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof MulticaIntegrationError ? error.code : 'MULTICA_OPERATION_FAILED';
    const status = await this.getStatus();
    return {
      success: false,
      status: { ...status, errorCode, error: message },
      error: message,
    };
  }

  private getLauncherPath(): string {
    if (this.options.getLauncherPath) return this.options.getLauncherPath();
    if (app.isPackaged) return process.execPath;
    throw new Error('The Multica development launcher is unavailable.');
  }

  private getCommandLauncher(
    targetPath: string,
    targetArgs: readonly string[],
  ): MulticaCommandLauncher {
    if (this.options.getCommandLauncher)
      return this.options.getCommandLauncher(targetPath, targetArgs);
    return ensureMulticaCommandLauncher({
      targetPath,
      targetArgs,
      localAppData: process.env.LOCALAPPDATA,
      appData: process.env.APPDATA,
    });
  }

  private removeCommandLauncher(state: PersistedIntegrationState): void {
    if (this.options.getCommandLauncher || !state.commandLauncherPath) return;
    removeMulticaCommandLauncher(
      state.commandLauncherPath,
      state.managedBinaryPath,
      process.platform,
      state.launcherArguments ?? [],
    );
  }

  private activeTaskCount(status: MulticaDaemonStatusPayload): number {
    return Math.max(status.active_task_count ?? 0, status.running_task_count ?? 0);
  }

  private workspaceIds(status: MulticaDaemonStatusPayload): string[] {
    return [
      ...new Set(
        (status.workspaces ?? [])
          .map(workspace => workspace.id?.trim())
          .filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
      ),
    ];
  }

  private async runLocalMulticaCli(
    executable: string,
    args: string[],
    timeout: number,
  ): Promise<{ stdout: string; stderr: string }> {
    if (!isAllowedLocalMulticaCommand(args)) {
      console.warn(`${LOG_PREFIX} blocked non-local CLI command`);
      throw new MulticaIntegrationError(
        'MULTICA_NETWORK_POLICY_BLOCKED',
        'The Multica command was blocked by the local-only integration policy.',
      );
    }
    const command = args[0] === '--version' ? 'version' : 'daemon status';
    const startedAt = Date.now();
    const result = await execFileAsync(executable, args, { windowsHide: true, timeout });
    console.debug(`${LOG_PREFIX} local CLI completed`, {
      command,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  private async detectMultica(): Promise<DetectedMultica> {
    const executable = await this.findMulticaExecutable();
    if (!executable) throw new Error('Multica desktop CLI was not found.');
    let version: string | null = null;
    try {
      const result = await this.runLocalMulticaCli(executable, ['--version'], 5_000);
      version = result.stdout.trim() || result.stderr.trim() || null;
    } catch {
      // Daemon status also reports cli_version.
    }

    const profilesRoot = path.join(os.homedir(), '.multica', 'profiles');
    const profileNames = fs.existsSync(profilesRoot)
      ? fs
          .readdirSync(profilesRoot, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
      : [];
    const candidates: Array<{ name: string; status: MulticaDaemonStatusPayload }> = [];
    for (const profileName of profileNames) {
      try {
        const result = await this.runLocalMulticaCli(
          executable,
          ['daemon', 'status', '--profile', profileName, '--output', 'json'],
          5_000,
        );
        const status = JSON.parse(result.stdout) as MulticaDaemonStatusPayload;
        if (
          status.status === 'running' &&
          isMulticaDesktopProfile(profilesRoot, profileName, status)
        ) {
          candidates.push({ name: profileName, status });
        }
      } catch {
        // Ignore stopped and invalid profiles.
      }
    }
    if (candidates.length > 1) {
      throw new Error('Multiple running Multica desktop profiles were found.');
    }
    const selected = candidates[0];
    console.debug(`${LOG_PREFIX} detection completed`, {
      executableFound: true,
      versionDetected: Boolean(version ?? selected?.status.cli_version),
      desktopProfileCount: candidates.length,
      daemonState: selected?.status.status ?? 'unavailable',
      activeTaskCount: selected ? this.activeTaskCount(selected.status) : 0,
      workspaceCount: selected ? this.workspaceIds(selected.status).length : 0,
    });
    return {
      executable,
      version,
      profileName: selected?.name ?? null,
      daemon: selected?.status ?? null,
    };
  }

  private async findMulticaExecutable(): Promise<string | null> {
    const candidates = [
      process.env.MULTICA_CLI_PATH,
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            'Programs',
            '@multicadesktop',
            'resources',
            'app.asar.unpacked',
            'resources',
            'bin',
            'multica.exe',
          )
        : undefined,
      process.platform === 'darwin'
        ? '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica'
        : undefined,
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    try {
      const command = process.platform === 'win32' ? 'where.exe' : 'which';
      const result = await execFileAsync(command, ['multica'], {
        windowsHide: true,
        timeout: 3_000,
      });
      const resolved = result.stdout.split(/\r?\n/).find(Boolean)?.trim();
      return resolved && fs.existsSync(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }
}

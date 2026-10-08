import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type {
  MulticaIntegrationResult,
  MulticaIntegrationStatus,
} from '../../../shared/integrations/multica';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { SqliteStore } from '../../data/sqliteStore';
import { MULTICA_BRIDGE_PROTOCOL_VERSION } from './multicaBridgeProtocol';
import {
  ensureMulticaCommandLauncher,
  type MulticaCommandLauncher,
  removeMulticaCommandLauncher,
} from './multicaCommandLauncher';

const execFileAsync = promisify(execFile);
const STATE_KEY = 'multica_integration_v2';
const LOG_PREFIX = '[MulticaIntegrationService]';

interface PersistedState {
  enabled: boolean;
  launcherPath?: string;
  command?: string;
}

interface MulticaIntegrationServiceOptions {
  getStore: () => SqliteStore;
  getBridgeState: () => { running: boolean; activeTaskCount: number };
  ensureBridgeRunning: () => Promise<void>;
  getOpenClawVersion: () => string | null;
  getLauncherTarget: () => { path: string; args: string[] };
  createLauncher?: (targetPath: string, targetArgs: readonly string[]) => MulticaCommandLauncher;
  removeLauncher?: (launcherPath: string) => void;
}

const supportedPlatform = (): boolean => ['win32', 'darwin', 'linux'].includes(process.platform);

export class MulticaIntegrationService {
  constructor(private readonly options: MulticaIntegrationServiceOptions) {}

  isEnabled(): boolean {
    return this.options.getStore().get<PersistedState>(STATE_KEY)?.enabled === true;
  }

  async getStatus(): Promise<MulticaIntegrationStatus> {
    const state = this.options.getStore().get<PersistedState>(STATE_KEY);
    const bridge = this.options.getBridgeState();
    const detected = await this.detectMultica();
    const launcherPath = state?.launcherPath ?? '';
    const launcherReady =
      state?.enabled === true && Boolean(launcherPath) && fs.existsSync(launcherPath);
    return {
      enabled: state?.enabled === true,
      supported: supportedPlatform(),
      networkPolicy: 'local-only',
      bridgeState: bridge.running ? 'running' : 'stopped',
      bridgeProtocolVersion: MULTICA_BRIDGE_PROTOCOL_VERSION,
      launcherPath,
      launcherReady,
      openclawVersion: this.options.getOpenClawVersion(),
      multicaExecutable: detected.path,
      multicaVersion: detected.version,
      activeTaskCount: bridge.activeTaskCount,
      manualSetup: {
        protocolFamily: 'codex',
        displayName: PRODUCT_NAME,
        command: state?.command ?? '',
        description: 'Local desktop Agent runtime',
      },
    };
  }

  async enable(): Promise<MulticaIntegrationResult> {
    try {
      if (!supportedPlatform()) throw new Error('Multica integration is not supported here.');
      await this.options.ensureBridgeRunning();
      const target = this.options.getLauncherTarget();
      const launcher = this.options.createLauncher
        ? this.options.createLauncher(target.path, target.args)
        : ensureMulticaCommandLauncher({ targetPath: target.path, targetArgs: target.args });
      this.options.getStore().set<PersistedState>(STATE_KEY, {
        enabled: true,
        launcherPath: launcher.path,
        command: launcher.command,
      });
      console.info(`${LOG_PREFIX} enabled`);
      return { success: true, status: await this.getStatus() };
    } catch (error) {
      return this.failure(error);
    }
  }

  async disable(): Promise<MulticaIntegrationResult> {
    try {
      const state = this.options.getStore().get<PersistedState>(STATE_KEY);
      this.options.getStore().set<PersistedState>(STATE_KEY, { ...state, enabled: false });
      if (state?.launcherPath) {
        try {
          (this.options.removeLauncher ?? removeMulticaCommandLauncher)(state.launcherPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`${LOG_PREFIX} launcher cleanup failed`, { error: message });
        }
      }
      console.info(`${LOG_PREFIX} disabled`);
      return { success: true, status: await this.getStatus() };
    } catch (error) {
      return this.failure(error);
    }
  }

  async refresh(): Promise<MulticaIntegrationResult> {
    try {
      await this.options.ensureBridgeRunning();
      const state = this.options.getStore().get<PersistedState>(STATE_KEY);
      if (state?.enabled && (!state.launcherPath || !fs.existsSync(state.launcherPath))) {
        return this.enable();
      }
      return { success: true, status: await this.getStatus() };
    } catch (error) {
      return this.failure(error);
    }
  }

  private async failure(error: unknown): Promise<MulticaIntegrationResult> {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG_PREFIX} operation failed`, { error: message });
    const status = await this.getStatus();
    return {
      success: false,
      status: { ...status, errorCode: 'MULTICA_OPERATION_FAILED', error: message },
      error: message,
    };
  }

  private async detectMultica(): Promise<{ path: string | null; version: string | null }> {
    const configured = process.env.MULTICA_CLI_PATH?.trim();
    const desktopCandidate =
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
        : process.platform === 'darwin'
          ? '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica'
          : path.join(os.homedir(), '.local', 'bin', 'multica');
    let executable = [configured, desktopCandidate]
      .filter((value): value is string => Boolean(value))
      .find(value => fs.existsSync(value));
    executable = executable ? path.resolve(executable) : null;
    if (!executable) {
      try {
        const locator = process.platform === 'win32' ? 'where.exe' : 'which';
        const result = await execFileAsync(locator, ['multica'], {
          timeout: 3_000,
          windowsHide: true,
        });
        executable =
          result.stdout
            .split(/\r?\n/)
            .map(value => value.trim())
            .find(Boolean) ?? null;
      } catch {
        executable = null;
      }
    }
    if (!executable) return { path: null, version: null };
    try {
      const result = await execFileAsync(executable, ['--version'], {
        timeout: 5_000,
        windowsHide: true,
      });
      return { path: executable, version: result.stdout.trim() || result.stderr.trim() || null };
    } catch {
      return { path: executable, version: null };
    }
  }
}

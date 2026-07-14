import type { CoworkStore } from '../../data/coworkStore';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';
import type { OpenClawHookStore } from '../../plugins/hooks';
import type { McpStore } from '../../plugins/mcp';
import type { AskUserExtensionConfig } from './openclawConfigSync';
import { OpenClawConfigSync } from './openclawConfigSync';

type OpenClawConfigSyncServiceDeps = {
  getCoworkStore: () => CoworkStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getAskUserExtensionConfig: () => AskUserExtensionConfig | null;
  getMcpStore: () => McpStore;
  getHookStore: () => OpenClawHookStore;
  hasActiveGatewayWorkloads: () => boolean;
  disconnectGatewayClient: () => void;
};

type SyncOpenClawConfigOptions = {
  reason: string;
  restartGatewayIfRunning?: boolean;
};

type SyncOpenClawConfigResult = {
  success: boolean;
  changed: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
};

const DEFERRED_RESTART_POLL_MS = 3_000;
const DEFERRED_RESTART_MAX_WAIT_MS = 5 * 60_000;

export class OpenClawConfigSyncService {
  private readonly deps: OpenClawConfigSyncServiceDeps;
  private configSync: OpenClawConfigSync | null = null;
  private deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
  private deferredRestartTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: OpenClawConfigSyncServiceDeps) {
    this.deps = deps;
  }

  async syncConfig(
    options: SyncOpenClawConfigOptions = { reason: 'unknown' },
  ): Promise<SyncOpenClawConfigResult> {
    console.log(
      `[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason}, restart gateway if running: ${options.restartGatewayIfRunning ? 'yes' : 'no'})`,
    );

    const syncResult = this.getConfigSync().sync(options.reason);
    if (!syncResult.ok) {
      const status = this.deps
        .getOpenClawEngineManager()
        .setExternalError(`OpenClaw config sync failed: ${syncResult.error || 'unknown error'}`);
      return {
        success: false,
        changed: false,
        status,
        error: syncResult.error,
      };
    }

    const nextSecretEnvVars = this.getConfigSync().collectSecretEnvVars();
    const engineManager = this.deps.getOpenClawEngineManager();
    const prevSecretEnvVars = engineManager.getSecretEnvVars();
    const secretEnvVarsChanged =
      JSON.stringify(nextSecretEnvVars) !== JSON.stringify(prevSecretEnvVars);
    engineManager.setSecretEnvVars(nextSecretEnvVars);

    const needsHardRestart =
      secretEnvVarsChanged || (syncResult.changed && options.restartGatewayIfRunning);

    if (!needsHardRestart) {
      return {
        success: true,
        changed: syncResult.changed,
      };
    }

    const status = engineManager.getStatus();
    if (status.phase !== 'running') {
      return {
        success: true,
        changed: true,
        status,
      };
    }

    if (this.deps.hasActiveGatewayWorkloads()) {
      console.log(
        `[OpenClaw] syncOpenClawConfig: deferring hard restart because active workloads exist (reason: ${options.reason})`,
      );
      this.scheduleDeferredGatewayRestart(options.reason);
      return {
        success: true,
        changed: true,
        status,
      };
    }

    console.log(
      `[OpenClaw] syncOpenClawConfig: pre-emptively disconnecting runtime adapter before gateway restart (reason: ${options.reason})`,
    );
    this.deps.disconnectGatewayClient();

    await engineManager.stopGateway();
    const restarted = await engineManager.startGateway();
    if (restarted.phase !== 'running') {
      return {
        success: false,
        changed: true,
        status: restarted,
        error: restarted.message || 'Failed to restart OpenClaw gateway after config sync.',
      };
    }
    return {
      success: true,
      changed: true,
      status: restarted,
    };
  }

  private getConfigSync(): OpenClawConfigSync {
    if (!this.configSync) {
      this.configSync = new OpenClawConfigSync({
        engineManager: this.deps.getOpenClawEngineManager(),
        getCoworkConfig: () => this.deps.getCoworkStore().getConfig(),
        getAskUserExtensionConfig: this.deps.getAskUserExtensionConfig,
        getMcpServers: () => this.deps.getMcpStore().listServers(),
        getHooks: () => this.deps.getHookStore().listHooks(),
        getAgents: () => this.deps.getCoworkStore().listAgents(),
      });
    }
    return this.configSync;
  }

  private clearDeferredRestart(): void {
    if (this.deferredRestartTimer) {
      clearInterval(this.deferredRestartTimer);
      this.deferredRestartTimer = null;
    }
    if (this.deferredRestartTimeout) {
      clearTimeout(this.deferredRestartTimeout);
      this.deferredRestartTimeout = null;
    }
  }

  private async executeDeferredGatewayRestart(reason: string): Promise<void> {
    this.clearDeferredRestart();
    console.log(
      `[OpenClaw] executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`,
    );
    await this.syncConfig({ reason: `deferred:${reason}` });
  }

  private scheduleDeferredGatewayRestart(reason: string): void {
    if (this.deferredRestartTimer) {
      console.log(
        `[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`,
      );
      return;
    }

    this.deferredRestartTimer = setInterval(() => {
      if (!this.deps.hasActiveGatewayWorkloads()) {
        void this.executeDeferredGatewayRestart(reason);
      }
    }, DEFERRED_RESTART_POLL_MS);

    this.deferredRestartTimeout = setTimeout(() => {
      console.warn(
        `[OpenClaw] scheduleDeferredGatewayRestart: max wait exceeded, forcing restart (reason: ${reason})`,
      );
      void this.executeDeferredGatewayRestart(reason);
    }, DEFERRED_RESTART_MAX_WAIT_MS);
  }
}

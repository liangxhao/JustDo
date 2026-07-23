import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import type { CoworkStore } from '../../data/coworkStore';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';
import type { OpenClawHookStore } from '../../plugins/hooks';
import type { McpStore } from '../../plugins/mcp';
import type { AskUserExtensionConfig } from './openclawConfigSync';
import {
  OpenClawConfigSync,
  verifyLoggedOutOpenClawConfig,
} from './openclawConfigSync';

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
};

type SyncOpenClawConfigResult = {
  success: boolean;
  changed: boolean;
  configSynced: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
};

const DEFERRED_RESTART_POLL_MS = 3_000;
const DEFERRED_RESTART_MAX_WAIT_MS = 5 * 60_000;

export type OpenClawConfigApplyMode = 'none' | 'native-reload' | 'hard-restart';

export const resolveOpenClawConfigApplyMode = (options: {
  gatewayPhase: OpenClawEngineStatus['phase'];
  configChanged: boolean;
  secretEnvVarsChanged: boolean;
  requiresGatewayRestart: boolean;
}): OpenClawConfigApplyMode => {
  if (options.gatewayPhase !== 'running' && options.gatewayPhase !== 'starting') {
    return 'none';
  }
  if (options.secretEnvVarsChanged || options.requiresGatewayRestart) {
    return 'hard-restart';
  }
  if (options.gatewayPhase === 'starting' && options.configChanged) {
    return 'hard-restart';
  }
  return options.gatewayPhase === 'running' && options.configChanged
    ? 'native-reload'
    : 'none';
};

const resolveAuthLogoutConfigApplyMode = (options: {
  gatewayPhase: OpenClawEngineStatus['phase'];
  configChanged: boolean;
}): OpenClawConfigApplyMode =>
  options.gatewayPhase === 'running' && options.configChanged
    ? 'native-reload'
    : 'none';

export type DeferredGatewayRestartAction = 'restart' | 'discard';

export const resolveDeferredGatewayRestartAction = (options: {
  gatewayPhase: OpenClawEngineStatus['phase'];
  currentProcessGeneration: number;
  targetProcessGeneration: number;
}): DeferredGatewayRestartAction =>
  options.gatewayPhase === 'running' &&
  options.currentProcessGeneration === options.targetProcessGeneration
    ? 'restart'
    : 'discard';

export class OpenClawConfigSyncService {
  private readonly deps: OpenClawConfigSyncServiceDeps;
  private configSync: OpenClawConfigSync | null = null;
  private deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
  private deferredRestartTimeout: ReturnType<typeof setTimeout> | null = null;
  private deferredRestartGeneration: number | null = null;

  constructor(deps: OpenClawConfigSyncServiceDeps) {
    this.deps = deps;
  }

  async syncConfig(
    options: SyncOpenClawConfigOptions = { reason: 'unknown' },
  ): Promise<SyncOpenClawConfigResult> {
    console.log(`[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason})`);

    const engineManager = this.deps.getOpenClawEngineManager();
    const statusBeforeSync = engineManager.getStatus();
    const isAuthLifecycleSync =
      options.reason === BuiltinModelSyncReason.AuthLogin ||
      options.reason === BuiltinModelSyncReason.AuthLogout;
    const reloadGeneration = engineManager.getGatewayConfigReloadGeneration();
    const syncResult = this.getConfigSync().sync(options.reason);
    if (!syncResult.ok) {
      const status = isAuthLifecycleSync
        ? statusBeforeSync
        : engineManager.setExternalError(
            `OpenClaw config sync failed: ${syncResult.error || 'unknown error'}`,
          );
      return {
        success: false,
        changed: false,
        configSynced: false,
        status,
        error: syncResult.error,
      };
    }

    if (options.reason === BuiltinModelSyncReason.AuthLogout) {
      const verification = verifyLoggedOutOpenClawConfig(syncResult.configPath);
      if (!verification.ok) {
        const error = verification.error || 'OpenClaw logout config verification failed.';
        return {
          success: false,
          changed: syncResult.changed,
          configSynced: false,
          status: statusBeforeSync,
          error,
        };
      }
      console.log(`[OpenClaw] Verified logged-out config at ${syncResult.configPath}`);
    }

    const nextSecretEnvVars = this.getConfigSync().collectSecretEnvVars();
    const prevSecretEnvVars = engineManager.getSecretEnvVars();
    const secretEnvVarsChanged =
      JSON.stringify(nextSecretEnvVars) !== JSON.stringify(prevSecretEnvVars);
    engineManager.setSecretEnvVars(nextSecretEnvVars);

    const isAuthLogout = options.reason === BuiltinModelSyncReason.AuthLogout;
    const applyMode = isAuthLogout
      ? resolveAuthLogoutConfigApplyMode({
          gatewayPhase: statusBeforeSync.phase,
          configChanged: syncResult.configChanged,
        })
      : resolveOpenClawConfigApplyMode({
          gatewayPhase: statusBeforeSync.phase,
          configChanged: syncResult.configChanged,
          secretEnvVarsChanged,
          requiresGatewayRestart: syncResult.requiresGatewayRestart,
        });

    if (applyMode === 'none') {
      return {
        success: true,
        changed: syncResult.changed,
        configSynced: true,
      };
    }

    if (applyMode === 'native-reload') {
      const reloaded = await engineManager.waitForGatewayConfigReload(reloadGeneration);
      if (reloaded) {
        return {
          success: true,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        };
      }
      if (isAuthLogout) {
        console.warn(
          '[OpenClaw] syncOpenClawConfig: logout native reload did not complete; leaving Gateway running without a hard restart.',
        );
        return {
          success: false,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
          error: 'OpenClaw logout config was written, but native reload did not complete.',
        };
      }
      console.warn(
        `[OpenClaw] syncOpenClawConfig: native reload did not complete; falling back to a hard restart (reason: ${options.reason})`,
      );
    }

    return this.restartGatewayOrDefer(
      options.reason,
      syncResult.changed,
      applyMode === 'hard-restart',
    );
  }

  private async restartGatewayOrDefer(
    reason: string,
    changed: boolean,
    restartAfterInFlightStart: boolean,
  ): Promise<SyncOpenClawConfigResult> {
    const engineManager = this.deps.getOpenClawEngineManager();
    let status = engineManager.getStatus();
    if (status.phase === 'starting') {
      status = await engineManager.startGateway();
      if (status.phase !== 'running') {
        return {
          success: false,
          changed,
          configSynced: true,
          status,
          error:
            status.message ||
            'OpenClaw gateway did not finish starting before its required restart.',
        };
      }
      if (!restartAfterInFlightStart) {
        return {
          success: true,
          changed,
          configSynced: true,
          status,
        };
      }
    }
    if (status.phase === 'error') {
      const started = await engineManager.startGateway();
      return started.phase === 'running'
        ? {
          success: true,
          changed,
          configSynced: true,
          status: started,
        }
        : {
            success: false,
            changed,
            configSynced: true,
            status: started,
            error:
              started.message ||
              'Failed to start OpenClaw gateway after config application failed.',
          };
    }
    if (status.phase !== 'running') {
      return {
        success: true,
        changed,
        configSynced: true,
        status,
      };
    }
    if (this.deps.hasActiveGatewayWorkloads()) {
      console.log(
        `[OpenClaw] syncOpenClawConfig: deferring hard restart because active workloads exist (reason: ${reason})`,
      );
      this.scheduleDeferredGatewayRestart(
        reason,
        engineManager.getGatewayProcessGeneration(),
      );
      return {
        success: true,
        changed,
        configSynced: true,
        status,
      };
    }

    console.log(
      `[OpenClaw] syncOpenClawConfig: pre-emptively disconnecting runtime adapter before gateway restart (reason: ${reason})`,
    );
    this.deps.disconnectGatewayClient();

    await engineManager.stopGateway();
    const restarted = await engineManager.startGateway();
    if (restarted.phase !== 'running') {
      return {
        success: false,
        changed,
        configSynced: true,
        status: restarted,
        error: restarted.message || 'Failed to restart OpenClaw gateway after config sync.',
      };
    }
    return {
      success: true,
      changed,
      configSynced: true,
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
    this.deferredRestartGeneration = null;
  }

  private async executeDeferredGatewayRestart(
    reason: string,
    targetProcessGeneration: number,
  ): Promise<void> {
    this.clearDeferredRestart();
    const engineManager = this.deps.getOpenClawEngineManager();
    const action = resolveDeferredGatewayRestartAction({
      gatewayPhase: engineManager.getStatus().phase,
      currentProcessGeneration: engineManager.getGatewayProcessGeneration(),
      targetProcessGeneration,
    });
    if (action === 'discard') {
      console.log(
        `[OpenClaw] executeDeferredGatewayRestart: discarding stale restart intent (reason: ${reason})`,
      );
      return;
    }
    console.log(
      `[OpenClaw] executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`,
    );
    this.deps.disconnectGatewayClient();
    await engineManager.stopGateway();
    const status = await engineManager.startGateway();
    if (status.phase !== 'running') {
      console.error(
        `[OpenClaw] executeDeferredGatewayRestart: gateway restart failed (reason: ${reason}): ${status.message || status.phase}`,
      );
    }
  }

  private scheduleDeferredGatewayRestart(
    reason: string,
    targetProcessGeneration: number,
  ): void {
    if (this.deferredRestartTimer) {
      if (this.deferredRestartGeneration === targetProcessGeneration) {
        console.log(
          `[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`,
        );
        return;
      }
      this.clearDeferredRestart();
    }
    this.deferredRestartGeneration = targetProcessGeneration;

    this.deferredRestartTimer = setInterval(() => {
      if (!this.deps.hasActiveGatewayWorkloads()) {
        void this.executeDeferredGatewayRestart(reason, targetProcessGeneration);
      }
    }, DEFERRED_RESTART_POLL_MS);

    this.deferredRestartTimeout = setTimeout(() => {
      console.warn(
        `[OpenClaw] scheduleDeferredGatewayRestart: max wait exceeded, forcing restart (reason: ${reason})`,
      );
      void this.executeDeferredGatewayRestart(reason, targetProcessGeneration);
    }, DEFERRED_RESTART_MAX_WAIT_MS);
  }
}

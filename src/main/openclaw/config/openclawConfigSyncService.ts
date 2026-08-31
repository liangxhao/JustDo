import type { BrowserMode } from '../../../shared/browser';
import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import type { PermissionMode } from '../../../shared/openclaw/approvals';
import { ScheduledTaskAgentId } from '../../../shared/scheduledTask/constants';
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
  connectGatewayClient: () => Promise<void>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  getBrowserMode?: () => BrowserMode;
};

type SyncOpenClawConfigOptions = {
  reason: string;
  restartGatewayIfRunning?: boolean;
};

type SyncOpenClawConfigResult = {
  success: boolean;
  changed: boolean;
  configSynced: boolean;
  permissionVerified?: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
};

type ExecApprovalsFile = {
  version?: number;
  defaults?: Record<string, unknown>;
  agents?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type ExecApprovalsSnapshot = {
  hash?: string;
  file?: ExecApprovalsFile;
};

const resolveExecApprovalFields = (mode: PermissionMode) => {
  if (mode === 'full') {
    return { security: 'full', ask: 'off', askFallback: 'full' };
  }
  return { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' };
};

type ConfigSnapshot = {
  config?: {
    agents?: {
      list?: Array<{
        id?: unknown;
        tools?: {
          exec?: { host?: unknown; mode?: unknown };
          fs?: { workspaceOnly?: unknown };
        };
      }>;
    };
    tools?: {
      exec?: { host?: unknown; mode?: unknown };
      fs?: { workspaceOnly?: unknown };
    };
  };
};

type ActionApprovalInfo = {
  loaded?: boolean;
  adapterVersion?: unknown;
  configuredMode?: unknown;
  fullAgentIds?: unknown;
};

const removePersistentApprovalGrants = (
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const allowlist = entry.allowlist;
  if (!Array.isArray(allowlist)) return entry;
  return {
    ...entry,
    allowlist: allowlist.filter(
      item =>
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        (item as Record<string, unknown>).source !== 'allow-always',
    ),
  };
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
  private syncTail: Promise<void> = Promise.resolve();

  constructor(deps: OpenClawConfigSyncServiceDeps) {
    this.deps = deps;
  }

  syncConfig(
    options: SyncOpenClawConfigOptions = { reason: 'unknown' },
  ): Promise<SyncOpenClawConfigResult> {
    return this.enqueueSyncOperation(() => this.syncConfigExclusive(options));
  }

  runConfigMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueSyncOperation(operation);
  }

  private enqueueSyncOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.syncTail.then(operation, operation);
    this.syncTail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private async syncConfigExclusive(
    options: SyncOpenClawConfigOptions,
  ): Promise<SyncOpenClawConfigResult> {
    console.log(`[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason})`);

    const engineManager = this.deps.getOpenClawEngineManager();
    const statusBeforeSync = engineManager.getStatus();
    const reloadGeneration = engineManager.getGatewayConfigReloadGeneration();
    const expectedPermissionMode = this.deps.getCoworkStore().getConfig().permissionMode;
    let restrictedExecPolicyVerified = false;
    if (statusBeforeSync.phase === 'running' && expectedPermissionMode !== 'full') {
      try {
        const restrictedPolicyApplied = await this.applyExecApprovalPolicy(expectedPermissionMode);
        if (!restrictedPolicyApplied) {
          return this.failClosedConfigApplication(
            {
              success: false,
              changed: false,
              configSynced: false,
              status: statusBeforeSync,
            },
            'The restricted host execution policy could not be applied before reloading OpenClaw configuration.',
          );
        }
        restrictedExecPolicyVerified = true;
      } catch (error) {
        return this.failClosedConfigApplication(
          {
            success: false,
            changed: false,
            configSynced: false,
            status: statusBeforeSync,
          },
          `Failed to restrict host execution before reloading OpenClaw configuration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const syncResult = this.getConfigSync().sync(options.reason, {
      // The Gateway owns sessions.json while its process is active. Restrict
      // legacy managed-session migrations to the fully stopped/ready phase so
      // config reloads cannot overwrite concurrent token, fallback, or
      // lifecycle updates from the Gateway session writer.
      allowManagedSessionStoreMutation: statusBeforeSync.phase === 'ready',
    });
    if (!syncResult.ok) {
      return this.failClosedConfigApplication({
        success: false,
        changed: false,
        configSynced: false,
        error: syncResult.error,
      }, `OpenClaw config sync failed: ${syncResult.error || 'unknown error'}`);
    }

    if (options.reason === BuiltinModelSyncReason.AuthLogout) {
      const verification = verifyLoggedOutOpenClawConfig(syncResult.configPath);
      if (!verification.ok) {
        const error = verification.error || 'OpenClaw logout config verification failed.';
        return this.failClosedConfigApplication({
          success: false,
          changed: syncResult.changed,
          configSynced: false,
          error,
        }, error);
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
      return this.verifySuccessfulConfigApplication(
        {
          success: true,
          changed: syncResult.changed,
          configSynced: true,
        },
        { execPolicyAlreadyVerified: restrictedExecPolicyVerified },
      );
    }

    if (applyMode === 'native-reload') {
      const reloaded = await engineManager.waitForGatewayConfigReload(reloadGeneration);
      if (reloaded) {
        return this.verifySuccessfulConfigApplication({
          success: true,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        });
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
      if (options.restartGatewayIfRunning === false) {
        return this.failClosedConfigApplication({
          success: false,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        }, 'OpenClaw config was written, but native reload did not complete.');
      }
      console.warn(
        `[OpenClaw] syncOpenClawConfig: native reload did not complete; falling back to a hard restart (reason: ${options.reason})`,
      );
    }

    if (applyMode === 'hard-restart' && options.restartGatewayIfRunning === false) {
      return this.failClosedConfigApplication({
        success: false,
        changed: syncResult.changed,
        configSynced: true,
        status: engineManager.getStatus(),
      }, 'OpenClaw config change requires a Gateway restart.');
    }

    const restartResult = await this.restartGatewayOrDefer(
      options.reason,
      syncResult.changed,
      applyMode === 'hard-restart',
    );
    return restartResult.success
      ? this.verifySuccessfulConfigApplication(restartResult)
      : restartResult;
  }

  verifyActivePermissionPolicy(): Promise<SyncOpenClawConfigResult> {
    return this.enqueueSyncOperation(() =>
      this.verifySuccessfulConfigApplication({
        success: true,
        changed: false,
        configSynced: true,
        status: this.deps.getOpenClawEngineManager().getStatus(),
      }),
    );
  }

  private async verifySuccessfulConfigApplication(
    result: SyncOpenClawConfigResult,
    options: { execPolicyAlreadyVerified?: boolean } = {},
  ): Promise<SyncOpenClawConfigResult> {
    const engineManager = this.deps.getOpenClawEngineManager();
    if (engineManager.getStatus().phase !== 'running') return result;

    try {
      const expectedMode = this.deps.getCoworkStore().getConfig().permissionMode;
      const [runtimeConfigApplied, execPolicyApplied] = await Promise.all([
        this.verifyRuntimePermissionConfig(expectedMode),
        options.execPolicyAlreadyVerified
          ? Promise.resolve(true)
          : this.applyExecApprovalPolicy(expectedMode),
      ]);
      if (runtimeConfigApplied && execPolicyApplied) {
        return { ...result, permissionVerified: true };
      }

      const error = 'The OpenClaw host execution policy could not be verified.';
      return this.failClosedConfigApplication(result, error);
    } catch (error) {
      const message = `Failed to apply or verify the active OpenClaw permission state: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return this.failClosedConfigApplication(result, message);
    }
  }

  private async verifyRuntimePermissionConfig(mode: PermissionMode): Promise<boolean> {
    const [snapshot, pluginInfo] = await Promise.all([
      this.deps.requestGateway<ConfigSnapshot>('config.get'),
      this.deps.requestGateway<ActionApprovalInfo>('actionApproval.info'),
    ]);
    const expectedWorkspaceOnly = mode !== 'full';
    const schedulerAgent = snapshot.config?.agents?.list?.find(
      agent => agent.id === ScheduledTaskAgentId,
    );
    const fullAgentIds = Array.isArray(pluginInfo.fullAgentIds)
      ? pluginInfo.fullAgentIds.filter((agentId): agentId is string => typeof agentId === 'string')
      : [];
    return (
      snapshot.config?.tools?.exec?.host === 'gateway' &&
      snapshot.config.tools.exec.mode === mode &&
      snapshot.config?.tools?.fs?.workspaceOnly === expectedWorkspaceOnly &&
      schedulerAgent?.tools?.exec?.host === 'gateway' &&
      schedulerAgent.tools.exec.mode === 'full' &&
      schedulerAgent.tools.fs?.workspaceOnly === false &&
      pluginInfo.loaded === true &&
      pluginInfo.adapterVersion === 2 &&
      pluginInfo.configuredMode === mode &&
      fullAgentIds.includes(ScheduledTaskAgentId)
    );
  }

  private async applyExecApprovalPolicy(mode: PermissionMode): Promise<boolean> {
    const current =
      await this.deps.requestGateway<ExecApprovalsSnapshot>('exec.approvals.get');
    if (
      typeof current.hash === 'string' &&
      current.hash.length > 0 &&
      this.isExecApprovalPolicyApplied(current.file, mode)
    ) {
      return true;
    }

    const file: ExecApprovalsFile = {
      ...(current.file ?? {}),
      version: 1,
    };
    const policy = resolveExecApprovalFields(mode);
    const schedulerPolicy = resolveExecApprovalFields('full');
    file.defaults = { ...(file.defaults ?? {}), ...policy };
    file.agents = {
      ...Object.fromEntries(
        Object.entries(file.agents ?? {})
          .filter(([agentId]) => agentId !== ScheduledTaskAgentId)
          .map(([agentId, entry]) => [
            agentId,
            removePersistentApprovalGrants({ ...entry, ...policy }),
          ]),
      ),
      [ScheduledTaskAgentId]: removePersistentApprovalGrants({
        ...(file.agents?.[ScheduledTaskAgentId] ?? {}),
        ...schedulerPolicy,
      }),
    };
    const submitted = await this.deps.requestGateway<ExecApprovalsSnapshot>('exec.approvals.set', {
      file,
      ...(current.hash ? { baseHash: current.hash } : {}),
    });
    const applied =
      await this.deps.requestGateway<ExecApprovalsSnapshot>('exec.approvals.get');
    return (
      typeof submitted.hash === 'string' &&
      submitted.hash.length > 0 &&
      applied.hash === submitted.hash &&
      this.isExecApprovalPolicyApplied(applied.file, mode)
    );
  }

  private isExecApprovalPolicyApplied(
    file: ExecApprovalsFile | undefined,
    mode: PermissionMode,
  ): boolean {
    if (file?.version !== 1) return false;

    const expected = resolveExecApprovalFields(mode);
    const schedulerPolicy = resolveExecApprovalFields('full');
    const defaults = file.defaults;
    const agents = file.agents ?? {};
    if (!Object.prototype.hasOwnProperty.call(agents, ScheduledTaskAgentId)) return false;

    const agentsMatch = Object.entries(agents).every(([agentId, agent]) => {
      const expectedAgentPolicy =
        agentId === ScheduledTaskAgentId ? schedulerPolicy : expected;
      return (
        agent?.security === expectedAgentPolicy.security &&
        agent.ask === expectedAgentPolicy.ask &&
        agent.askFallback === expectedAgentPolicy.askFallback
      );
    });
    return (
      defaults?.security === expected.security &&
      defaults.ask === expected.ask &&
      defaults.askFallback === expected.askFallback &&
      agentsMatch &&
      !this.hasPersistentApprovalGrants(file)
    );
  }

  private hasPersistentApprovalGrants(file: ExecApprovalsFile | undefined): boolean {
    return Object.values(file?.agents ?? {}).some(entry =>
      Array.isArray(entry.allowlist)
        ? entry.allowlist.some(
            item =>
              item !== null &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              (item as Record<string, unknown>).source === 'allow-always',
          )
        : false,
    );
  }

  private async failClosedConfigApplication(
    result: SyncOpenClawConfigResult,
    error: string,
  ): Promise<SyncOpenClawConfigResult> {
    const engineManager = this.deps.getOpenClawEngineManager();
    this.deps.disconnectGatewayClient();
    let stopError: string | undefined;
    try {
      await engineManager.stopGateway();
    } catch (cause) {
      stopError = cause instanceof Error ? cause.message : String(cause);
    }
    const status = engineManager.setExternalError(
      stopError
        ? `Permission synchronization is unverified and the Gateway stop failed: ${stopError}`
        : `Permission synchronization is unverified; the Gateway was stopped. ${error}`,
    );
    return {
      ...result,
      success: false,
      configSynced: false,
      status,
      error:
        `The product preference may have been persisted, but the runtime permission state was not confirmed. ` +
        (stopError
          ? `The Gateway stop failed after the app disconnected from it: ${stopError}. `
          : 'The Gateway was stopped to fail closed. ') +
        error,
    };
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
        return this.restoreGatewayBridgeOrFailClosed({
          success: true,
          changed,
          configSynced: true,
          status,
        });
      }
    }
    if (status.phase === 'error') {
      const started = await engineManager.startGateway();
      if (started.phase === 'running') {
        return this.restoreGatewayBridgeOrFailClosed({
          success: true,
          changed,
          configSynced: true,
          status: started,
        });
      }
      return {
        success: false,
        changed,
        configSynced: true,
        status: started,
        error:
          started.message || 'Failed to start OpenClaw gateway after config application failed.',
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

    const restarted = await engineManager.restartGateway({ afterCurrent: true });
    if (restarted.phase !== 'running') {
      return {
        success: false,
        changed,
        configSynced: true,
        status: restarted,
        error: restarted.message || 'Failed to restart OpenClaw gateway after config sync.',
      };
    }
    return this.restoreGatewayBridgeOrFailClosed({
      success: true,
      changed,
      configSynced: true,
      status: restarted,
    });
  }

  private async restoreGatewayBridgeOrFailClosed(
    result: SyncOpenClawConfigResult,
  ): Promise<SyncOpenClawConfigResult> {
    try {
      await this.deps.connectGatewayClient();
      return result;
    } catch (error) {
      return this.failClosedConfigApplication(
        {
          ...result,
          success: false,
          configSynced: false,
        },
        `Failed to restore the approval event bridge after Gateway start: ${String(error)}`,
      );
    }
  }

  private getConfigSync(): OpenClawConfigSync {
    if (!this.configSync) {
      this.configSync = new OpenClawConfigSync({
        engineManager: this.deps.getOpenClawEngineManager(),
        getCoworkConfig: () => this.deps.getCoworkStore().getConfig(),
        getAgentRuntimeSettings: () =>
          this.deps.getCoworkStore().getAgentRuntimeSettings(),
        getAskUserExtensionConfig: this.deps.getAskUserExtensionConfig,
        getMcpServers: () => this.deps.getMcpStore().listServers(),
        getHooks: () => this.deps.getHookStore().listHooks(),
        getAgents: () => this.deps.getCoworkStore().listAgents(),
        getBrowserMode: this.deps.getBrowserMode,
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
    const status = await engineManager.restartGateway({ afterCurrent: true });
    if (status.phase !== 'running') {
      console.error(
        `[OpenClaw] executeDeferredGatewayRestart: gateway restart failed (reason: ${reason}): ${status.message || status.phase}`,
      );
      return;
    }
    const bridgeResult = await this.restoreGatewayBridgeOrFailClosed({
      success: true,
      changed: true,
      configSynced: true,
      status,
    });
    if (!bridgeResult.success) {
      console.error(
        `[OpenClaw] executeDeferredGatewayRestart: runtime adapter reconnect failed and Gateway was failed closed (reason: ${reason}): ${bridgeResult.error ?? 'unknown error'}`,
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

import type { BrowserMode } from '../../../shared/browser/browser';
import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import { readModelRef } from '../../../shared/providers/modelRef';
import type { WindowsSandboxStatus } from '../../../shared/security/windowsSandbox';
import { ManagedDirectoryRuntimeStopAbortedError } from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import { redactLogText } from '../../core/logRedaction';
import type { CoworkStore } from '../../data/coworkStore';
import { createManagedSessionModelPolicy } from '../../engine/gateway/managedSessionModels';
import { enqueueSessionModelOperation } from '../../engine/gateway/sessionModelOperations';
import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  OPENCLAW_COMPACT_SESSION_ROW_MODE,
  parseSessionsListResultV2026_10_6,
} from '../../engine/openclaw/wire/v2026_10_6';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';
import type { OpenClawHookStore } from '../../plugins/hooks';
import type { McpStore } from '../../plugins/mcp';
import { discoverOpenClawManagedMcpServers } from '../../plugins/mcp';
import { ComputerHostPreparation } from '../runtime/computerHostPreparation';
import {
  GatewayConfigRestartOutcome,
  requestGatewayConfigRestart,
} from '../runtime/gatewayConfigRestart';
import { resolveManagedCredentialReloadTimeoutMs } from './models/credentialTimeouts';
import {
  ManagedCredentialReloadOutcome,
  reloadManagedCredentials,
} from './models/managedCredentialReload';
import { isModelDefaultsSyncReason } from './models/modelDefaultConfigChange';
import { maintainStartupAuthProfiles } from './models/startupAuthProfileMaintenance';
import {
  OPENCLAW_FALLBACK_EXEC_MODE,
  OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
  OpenClawConfigSync,
  resolveOpenClawExecHost,
  verifyLoggedOutOpenClawConfig,
} from './openclawConfigSync';
import type { ManagedSpeechModelSettings } from './speech/speechModelConfig';

type OpenClawConfigSyncServiceDeps = {
  getCoworkStore: () => CoworkStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getMcpStore: () => McpStore;
  getExtensionMcpServerNames?: () => Promise<ReadonlySet<string>>;
  getHookStore: () => OpenClawHookStore;
  disconnectGatewayClient: () => void;
  connectGatewayClient: () => Promise<void>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  getGatewayClient: () => GatewayClientLike | null;
  getModelAuthSessionId?: () => string | null;
  getBrowserMode?: () => BrowserMode;
  getControlUiEnabled?: () => boolean;
  getDecisionModelCategory?: () => unknown;
  getNativeVideoCategory?: () => unknown;
  getSpeechModelSettings?: () => ManagedSpeechModelSettings;
  getLocalSttConfig?: () => Record<string, unknown> | null;
  getLocalTtsConfig?: () => Record<string, unknown> | null;
  getLocalSpeechExtensionTtsConfig?: () => Record<string, unknown> | null;
  getSpeechOutputState?: () => { enabled: boolean; mode: 'local' | 'online' };
  getWindowsSandboxStatus: () => Promise<WindowsSandboxStatus>;
  getWindowsSandboxEnvironment: () => Record<string, string>;
};

type SyncOpenClawConfigOptions = {
  reason: string;
  restartGatewayIfRunning?: boolean;
  discoverExternalMcpServers?: boolean;
  retiredMcpServerNames?: readonly string[];
  retiredProviderIds?: readonly string[];
  restoreDecisionModelSnapshot?: boolean;
};

type SyncOpenClawConfigResult = {
  success: boolean;
  changed: boolean;
  configSynced: boolean;
  /** Default preference persistence is independent of runtime application evidence. */
  modelDefaultsApplicationPending?: true;
  hostPolicyVerified?: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
};

type PendingCredentialReload = {
  authSessionId: string | null;
  recoveryUsed: boolean;
  configApplication?: {
    reloadGeneration: number;
    processGeneration: number;
    lifecycleGeneration: number;
    requiresHardRestart: boolean;
    nativeRestartRequested?: boolean;
  };
  acknowledged?: { processGeneration: number; lifecycleGeneration: number };
  stopped?: {
    processGeneration: number;
    diagnosticId?: string;
    message?: string;
  };
};

type ConfigApplicationOwnership = {
  isCurrent: () => boolean;
  ownsProcess: () => boolean;
};

type ExecutionAdmissionOptions = {
  prepareComputerForSend?: boolean;
};

export type OpenClawConfigMutationContext = {
  syncConfig: (options: SyncOpenClawConfigOptions) => Promise<SyncOpenClawConfigResult>;
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

type GatewaySuspendPrepareResult =
  | {
      status: 'busy' | 'draining';
      suspensionId?: string;
    }
  | {
      status: 'ready';
      suspensionId: string;
    };

type GatewayRestartSuspension = {
  suspensionId: string;
  targetProcessGeneration: number;
};

const FALLBACK_EXEC_APPROVAL_FIELDS = {
  // OpenClaw ask/auto deliberately share this host floor. The native session
  // mode remains intact and decides whether the automatic reviewer is enabled.
  security: 'allowlist',
  ask: 'on-miss',
  askFallback: 'deny',
} as const;

type ConfigSnapshot = {
  configRevisionHash?: unknown;
  appliedConfigHash?: unknown;
  config?: {
    models?: {
      providers?: Record<
        string,
        {
          models?: Array<{ id?: unknown }>;
        }
      >;
    };
    agents?: {
      defaults?: {
        model?: unknown;
      };
      entries?: Record<
        string,
        {
          model?: unknown;
          tools?: {
            exec?: { host?: unknown; mode?: unknown };
            fs?: { workspaceOnly?: unknown };
          };
        }
      >;
    };
    tools?: {
      exec?: { host?: unknown; mode?: unknown };
      fs?: { workspaceOnly?: unknown };
    };
  };
};

type ModelAuthStatusSnapshot = {
  unavailable?: unknown;
  providers?: Array<{
    provider?: unknown;
    profiles?: Array<{
      profileId?: unknown;
      type?: unknown;
      source?: unknown;
    }>;
  }>;
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
export const MODEL_DEFAULTS_HOT_RELOAD_TIMEOUT_MS = 90_000;

export type OpenClawConfigApplyMode = 'none' | 'native-reload' | 'hard-restart';

export const resolveOpenClawConfigApplyMode = (options: {
  gatewayPhase: OpenClawEngineStatus['phase'];
  configChanged: boolean;
  gatewayLaunchEnvVarsChanged: boolean;
  requiresGatewayRestart: boolean;
}): OpenClawConfigApplyMode => {
  if (options.gatewayPhase !== 'running' && options.gatewayPhase !== 'starting') {
    return 'none';
  }
  if (options.gatewayLaunchEnvVarsChanged || options.requiresGatewayRestart) {
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
  private readonly computerHostPreparation = new ComputerHostPreparation();
  private configSync: OpenClawConfigSync | null = null;
  private deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
  private deferredRestartGeneration: number | null = null;
  private deferredRestartCheckInProgress = false;
  private syncTail: Promise<void> = Promise.resolve();
  private readonly pendingRetiredProviderIds = new Set<string>();
  private orphanedAuthProfilesReconciled = false;
  private pendingCredentialReload: PendingCredentialReload | null = null;

  constructor(deps: OpenClawConfigSyncServiceDeps) {
    this.deps = deps;
  }

  syncConfig(
    options: SyncOpenClawConfigOptions = { reason: 'unknown' },
  ): Promise<SyncOpenClawConfigResult> {
    if (isModelDefaultsSyncReason(options.reason)) {
      // The watcher owns hot application. Keep publication ordered with other
      // mutations, but do not hold execution admission behind its observation.
      return this.enqueueSyncOperation(() => this.beginModelDefaultsSync(options, false))
        .then(publication => publication.observation);
    }
    return this.enqueueSyncOperation(() => this.syncConfigExclusive(options));
  }

  runConfigMutationExclusive<T>(
    operation: (context: OpenClawConfigMutationContext) => Promise<T>,
  ): Promise<T> {
    return this.enqueueSyncOperation(() =>
      operation({
        syncConfig: options => this.syncConfigExclusive(options),
      }),
    );
  }

  restartGatewayWhenIdle(reason: string): Promise<OpenClawEngineStatus> {
    return this.enqueueSyncOperation(() => this.restartGatewayAfterExclusiveMutation(reason));
  }

  async restartGatewayAfterExclusiveMutation(reason: string): Promise<OpenClawEngineStatus> {
    const engineManager = this.deps.getOpenClawEngineManager();
    if (reason.startsWith('extension-') && reason !== 'extension-network-policy-change') {
      const nativeRestart = await requestGatewayConfigRestart(
        engineManager, this.deps.requestGateway, reason,
      );
      if (nativeRestart === GatewayConfigRestartOutcome.Ready) {
        const restored = await this.restoreGatewayBridgeOrFailClosed({
          success: true,
          changed: true,
          configSynced: true,
          status: engineManager.getStatus(),
        });
        const verified = restored.success
          ? await this.verifySuccessfulConfigApplication(restored)
          : restored;
        return verified.status ?? engineManager.getStatus();
      }
      if (nativeRestart === GatewayConfigRestartOutcome.Pending) return engineManager.getStatus();
      if (nativeRestart === GatewayConfigRestartOutcome.Unconfirmed) {
        throw new Error(t('engineRestartUnconfirmed'));
      }
    }
    const result = await this.restartGatewayOrDefer(reason, true, true);
    return result.status ?? this.deps.getOpenClawEngineManager().getStatus();
  }

  async prepareGatewayStopAfterExclusiveMutation(
    reason: string,
  ): Promise<
    { ready: true; token: GatewayRestartSuspension } | { ready: false; message?: string }
  > {
    const engineManager = this.deps.getOpenClawEngineManager();
    const status = engineManager.getStatus();
    if (status.phase !== 'running') {
      return { ready: false };
    }

    const targetProcessGeneration = engineManager.getGatewayProcessGeneration();
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration);
    if (!suspension) {
      console.log(
        `[OpenClaw] Gateway directory-lock stop remains busy (reason: ${reason})`,
      );
      return { ready: false };
    }
    const actionAfterSuspension = resolveDeferredGatewayRestartAction({
      gatewayPhase: engineManager.getStatus().phase,
      currentProcessGeneration: engineManager.getGatewayProcessGeneration(),
      targetProcessGeneration,
    });
    if (actionAfterSuspension === 'discard') {
      console.log(
        `[OpenClaw] Gateway lifecycle changed while preparing a directory-lock stop (reason: ${reason})`,
      );
      return { ready: false };
    }
    return { ready: true, token: suspension };
  }

  async stopGatewayAfterExclusiveMutation(token: unknown): Promise<void> {
    const engineManager = this.deps.getOpenClawEngineManager();
    if (
      !token ||
      typeof token !== 'object' ||
      !('targetProcessGeneration' in token) ||
      typeof token.targetProcessGeneration !== 'number' ||
      !('suspensionId' in token) ||
      typeof token.suspensionId !== 'string'
    ) {
      throw new ManagedDirectoryRuntimeStopAbortedError(
        'The Gateway stop preparation is invalid. Try the operation again.',
      );
    }
    const { targetProcessGeneration, suspensionId } = token;
    if (
      engineManager.getStatus().phase !== 'running' ||
      engineManager.getGatewayProcessGeneration() !== targetProcessGeneration
    ) {
      throw new ManagedDirectoryRuntimeStopAbortedError(
        'The Gateway changed after the directory operation was prepared. Try again.',
      );
    }
    try {
      await engineManager.stopGateway();
    } catch (error) {
      const sameGatewayStillRunning =
        engineManager.getStatus().phase === 'running' &&
        engineManager.getGatewayProcessGeneration() === targetProcessGeneration;
      if (sameGatewayStillRunning) {
        try {
          await this.deps.requestGateway('gateway.suspend.resume', { suspensionId });
        } catch (recoveryError) {
          throw new Error(
            `Gateway stop failed and its suspension could not be resumed: ${String(recoveryError)}`,
            { cause: error },
          );
        }
        throw new ManagedDirectoryRuntimeStopAbortedError(
          `The Gateway could not be stopped safely: ${String(error)}`,
        );
      }
      throw error;
    } finally {
      const status = engineManager.getStatus();
      if (
        status.phase !== 'running' ||
        engineManager.getGatewayProcessGeneration() !== targetProcessGeneration
      ) {
        this.deps.disconnectGatewayClient();
        this.clearDeferredRestartForGeneration(targetProcessGeneration);
      }
    }
  }

  async startGatewayAfterExclusiveMutation(
    token: unknown,
  ): Promise<{ running: boolean; message?: string }> {
    const engineManager = this.deps.getOpenClawEngineManager();
    const status = await engineManager.startGateway();
    if (status.phase !== 'running') {
      return { running: false, message: status.message };
    }
    if (
      token &&
      typeof token === 'object' &&
      'targetProcessGeneration' in token &&
      typeof token.targetProcessGeneration === 'number' &&
      'suspensionId' in token &&
      typeof token.suspensionId === 'string' &&
      token.suspensionId &&
      engineManager.getGatewayProcessGeneration() === token.targetProcessGeneration
    ) {
      try {
        await this.deps.requestGateway('gateway.suspend.resume', {
          suspensionId: token.suspensionId,
        });
        return { running: true };
      } catch (error) {
        this.deps.disconnectGatewayClient();
        await engineManager.stopGateway().catch(stopError => {
          console.error(
            '[OpenClaw] Failed to stop Gateway after suspension recovery failed:',
            stopError,
          );
        });
        const message = `Gateway suspension recovery failed: ${String(error)}`;
        engineManager.setExternalError(message);
        return { running: false, message };
      }
    }
    const bridgeResult = await this.restoreGatewayBridgeOrFailClosed({
      success: true,
      changed: true,
      configSynced: true,
      status,
    });
    return {
      running: bridgeResult.success && bridgeResult.status?.phase === 'running',
      message: bridgeResult.error ?? bridgeResult.status?.message,
    };
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
    if (isModelDefaultsSyncReason(options.reason)) {
      // An explicit mutation context already owns the queue until it returns.
      // Confirm here rather than recursively queuing behind that same owner.
      return (await this.beginModelDefaultsSync(options, true)).observation;
    }
    const result = await this.applyConfigExclusive(options);
    const pending = this.pendingCredentialReload;
    const manager = this.deps.getOpenClawEngineManager();
    if (pending && !result.success) return { ...result, configSynced: false };
    if (result.success && pending) {
      if (!this.getCredentialReloadOwnership(pending)?.isCurrent()) return {
        ...result, success: false, configSynced: false, status: manager.getStatus(),
        error: t('engineConfigApplicationUnconfirmed'),
      };
      this.pendingCredentialReload = null;
    }
    return result;
  }

  private async beginModelDefaultsSync(
    options: SyncOpenClawConfigOptions,
    ownsSyncQueue: boolean,
  ): Promise<{ observation: Promise<SyncOpenClawConfigResult> }> {
    const manager = this.deps.getOpenClawEngineManager();
    let changed = false;
    const unconfirmed = (): SyncOpenClawConfigResult => ({
      success: false, changed, configSynced: false,
      modelDefaultsApplicationPending: true, status: manager.getStatus(),
    });
    const completed = (result: SyncOpenClawConfigResult) => ({ observation: Promise.resolve(result) });
    const status = manager.getStatus();
    if (this.pendingCredentialReload || this.pendingRetiredProviderIds.size > 0 ||
        options.retiredProviderIds?.length || options.retiredMcpServerNames?.length ||
        status.phase === EnginePhase.Starting) return completed(unconfirmed());
    const offline = (status.phase === EnginePhase.Ready || status.phase === EnginePhase.Error) &&
      manager.getGatewayProcessId() === null;
    const client = this.deps.getGatewayClient();
    if (!offline && (status.phase !== EnginePhase.Running || !client)) return completed(unconfirmed());
    const configSync = this.getConfigSync();
    const launchEnvironmentMatches = (): boolean => {
      try {
        const previous = manager.getGatewayLaunchEnvVars();
        const next = configSync.collectGatewayLaunchEnvVars();
        return !manager.hasPendingGatewayLaunchEnvironmentChanges() &&
          Object.keys(previous).length === Object.keys(next).length &&
          Object.entries(next).every(([key, value]) => previous[key] === value);
      } catch {
        return false;
      }
    };
    // A model selection cannot silently adopt pending credential/launch inputs.
    // Those continue through the ordinary serialized configuration barrier.
    if (!offline && !launchEnvironmentMatches()) return completed(unconfirmed());
    const processGeneration = manager.getGatewayProcessGeneration();
    const lifecycleGeneration = manager.getGatewayLifecycleGeneration();
    const authSessionId = this.deps.getModelAuthSessionId?.() ?? null;
    const reloadGeneration = manager.getGatewayConfigReloadGeneration();
    const publication = configSync.syncModelDefaults();
    const result = publication.result;
    changed = result.changed;
    if (!result.ok || result.modelDefaultsOnly !== true || result.secretsChanged || result.requiresGatewayRestart)
      return completed({
        success: false, changed, configSynced: false, status: manager.getStatus(),
        error: result.error || t('modelDefaultConfigSyncFailed'),
      });
    if (offline) return completed(publication.isCurrent() ? {
      success: true, changed, configSynced: true, status: manager.getStatus(),
    } : unconfirmed());
    const isCurrent = (): boolean => !this.pendingCredentialReload && publication.isCurrent() &&
      this.deps.getGatewayClient() === client && manager.getStatus().phase === EnginePhase.Running &&
      manager.getGatewayProcessGeneration() === processGeneration &&
      manager.getGatewayLifecycleGeneration() === lifecycleGeneration &&
      (this.deps.getModelAuthSessionId?.() ?? null) === authSessionId && launchEnvironmentMatches();
    const confirm = async (): Promise<SyncOpenClawConfigResult> => {
      if (!isCurrent()) return unconfirmed();
      const request = <T>(method: string, params?: unknown): Promise<T> =>
        this.requestOwnedGateway<T>(isCurrent, method, params);
      const [runtime, approvals] = await Promise.all([
        this.verifyRuntimePermissionConfig(request),
        request<ExecApprovalsSnapshot>('exec.approvals.get'),
      ]);
      const revision = runtime.snapshot.configRevisionHash;
      if (!isCurrent() || !runtime.verified || typeof revision !== 'string' || !revision ||
          runtime.snapshot.appliedConfigHash !== revision ||
          !publication.matchesRuntimeConfig(runtime.snapshot.config) ||
          typeof approvals.hash !== 'string' || !approvals.hash || !this.isExecApprovalPolicyApplied(approvals.file))
        return unconfirmed();
      return { success: true, changed, configSynced: true, hostPolicyVerified: true, status: manager.getStatus() };
    };
    // Register while publication owns the queue; the returned box deliberately
    // prevents Promise assimilation from retaining the queue for this wait.
    const observation = (async (): Promise<SyncOpenClawConfigResult> => {
      try {
        if (!isCurrent()) return unconfirmed();
        if (result.configChanged && !await manager.waitForGatewayConfigReload(
          reloadGeneration, MODEL_DEFAULTS_HOT_RELOAD_TIMEOUT_MS,
        )) return unconfirmed();
        if (!isCurrent()) return unconfirmed();
        return ownsSyncQueue ? await confirm() : await this.enqueueSyncOperation(confirm);
      } catch {
        return unconfirmed();
      }
    })();
    return { observation };
  }

  private async applyConfigExclusive(
    options: SyncOpenClawConfigOptions,
  ): Promise<SyncOpenClawConfigResult> {
    console.log(`[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason})`);
    const isAuthLogout = options.reason === BuiltinModelSyncReason.AuthLogout;
    // Logout owns cleanup, never a previous credential failure's recovery ticket.
    if (isAuthLogout) this.pendingCredentialReload = null;

    for (const providerId of options.retiredProviderIds ?? []) {
      const normalized = providerId.trim().toLowerCase();
      if (normalized) this.pendingRetiredProviderIds.add(normalized);
    }
    if (options.reason === BuiltinModelSyncReason.AuthLogout) {
      this.pendingRetiredProviderIds.add('builtin_models');
    }

    const engineManager = this.deps.getOpenClawEngineManager();
    let extensionMcpNames: ReadonlySet<string>;
    try {
      extensionMcpNames = (await this.deps.getExtensionMcpServerNames?.()) ?? new Set<string>();
    } catch {
      return this.failClosedConfigApplication(
        { success: false, changed: false, configSynced: false },
        'Native extension MCP ownership could not be read; configuration was preserved.',
      );
    }
    if (options.discoverExternalMcpServers !== false) {
      try {
        const discovered = discoverOpenClawManagedMcpServers(
          engineManager.getConfigPath(),
          this.deps.getMcpStore(),
          extensionMcpNames,
        );
        if (discovered > 0) {
          console.log(`[OpenClawMcp] discovered ${discovered} externally installed server(s)`);
        }
      } catch (error) {
        console.warn(
          '[OpenClawMcp] Failed to discover externally installed MCP servers:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    // Do not write into a startup snapshot and then unconditionally discard
    // the process that just finished loading. Once ready, its watcher can
    // apply ordinary settings without a second cold startup.
    if (
      !isAuthLogout &&
      engineManager.getStatus().phase === EnginePhase.Starting
    ) {
      await engineManager.startGateway();
      const status = engineManager.getStatus();
      // A bounded observation may leave the native restart owner pending.
      // Preserve its startup snapshot and the unapplied configuration obligation.
      if (status.phase === EnginePhase.Starting) return this.unconfirmedConfigApplication({
        success: false, changed: false, configSynced: false, status,
      });
    }
    const statusBeforeSync = engineManager.getStatus();
    const preflightProcessGeneration = engineManager.getGatewayProcessGeneration();
    const preflightLifecycleGeneration = engineManager.getGatewayLifecycleGeneration();
    const preflightAuthSessionId = this.deps.getModelAuthSessionId?.() ?? null;
    const preflightIsCurrent = (): boolean => engineManager.getStatus().phase === statusBeforeSync.phase &&
      engineManager.getGatewayProcessGeneration() === preflightProcessGeneration &&
      engineManager.getGatewayLifecycleGeneration() === preflightLifecycleGeneration &&
      (this.deps.getModelAuthSessionId?.() ?? null) === preflightAuthSessionId;
    const preflightUnconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedConfigApplication({
      success: false, changed: false, configSynced: false,
    });
    const expectedExecutionMode = this.deps.getCoworkStore().getConfig().executionMode;
    if (expectedExecutionMode === 'sandbox') {
      const sandboxStatus = await this.deps.getWindowsSandboxStatus();
      if (!preflightIsCurrent()) return preflightUnconfirmed();
      if (!sandboxStatus.ready) {
        return this.failClosedConfigApplication(
          {
            success: false,
            changed: false,
            configSynced: false,
            status: statusBeforeSync,
          },
          sandboxStatus.error || 'The Windows sandbox backend is not ready.',
        );
      }
    }
    let fallbackExecPolicyVerified = false;
    if (statusBeforeSync.phase === 'running') {
      try {
        const fallbackPolicyApplied = await this.applyExecApprovalPolicy(
          preflightIsCurrent,
          <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(preflightIsCurrent, method, params),
        );
        if (!preflightIsCurrent()) return preflightUnconfirmed();
        if (!fallbackPolicyApplied) {
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
        fallbackExecPolicyVerified = true;
      } catch (error) {
        if (!preflightIsCurrent()) return preflightUnconfirmed();
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
    if (!preflightIsCurrent()) return preflightUnconfirmed();
    const reloadGeneration = engineManager.getGatewayConfigReloadGeneration();
    const processGenerationBeforeSync = engineManager.getGatewayProcessGeneration();
    const lifecycleGenerationBeforeSync = engineManager.getGatewayLifecycleGeneration();
    const configSync = this.getConfigSync();
    const retiredMcpNames = new Set(options.retiredMcpServerNames);
    const syncResult = options.restoreDecisionModelSnapshot === true
      ? configSync.sync(
          options.reason,
          extensionMcpNames,
          retiredMcpNames,
          { restoreDecisionModelSnapshot: true },
        )
      : configSync.sync(options.reason, extensionMcpNames, retiredMcpNames);
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

    const nextGatewayLaunchEnvVars = this.getConfigSync().collectGatewayLaunchEnvVars();
    const previousGatewayLaunchEnvVars = engineManager.getGatewayLaunchEnvVars();
    const gatewayLaunchEnvVarsChanged =
      Object.keys(nextGatewayLaunchEnvVars).length !==
        Object.keys(previousGatewayLaunchEnvVars).length ||
      Object.entries(nextGatewayLaunchEnvVars).some(
        ([key, value]) => previousGatewayLaunchEnvVars[key] !== value,
      );
    engineManager.setGatewayLaunchEnvVars(nextGatewayLaunchEnvVars);

    // File publication is not an acknowledgement from the running Gateway.
    // Retain that obligation even when a later sync sees identical file bytes.
    const authSessionId = this.deps.getModelAuthSessionId?.() ?? null;
    if (this.pendingCredentialReload?.authSessionId !== authSessionId) this.pendingCredentialReload = null;
    if (syncResult.secretsChanged && statusBeforeSync.phase === 'running' &&
      (!isAuthLogout || !syncResult.configChanged)) {
      this.pendingCredentialReload ??= { authSessionId, recoveryUsed: isAuthLogout };
      this.pendingCredentialReload.acknowledged = undefined;
    }
    const pending = this.pendingCredentialReload;
    const requiresHardRestart = gatewayLaunchEnvVarsChanged || syncResult.requiresGatewayRestart;
    if (pending && !isAuthLogout && (syncResult.configChanged || requiresHardRestart)) {
      const previousApplication = pending.configApplication;
      pending.acknowledged = undefined;
      pending.configApplication = {
        reloadGeneration, processGeneration: processGenerationBeforeSync,
        lifecycleGeneration: lifecycleGenerationBeforeSync,
        requiresHardRestart: requiresHardRestart || Boolean(previousApplication?.requiresHardRestart &&
          (previousApplication.processGeneration === processGenerationBeforeSync ||
            engineManager.hasPendingGatewayLaunchEnvironmentChanges())),
        nativeRestartRequested: previousApplication?.nativeRestartRequested &&
          previousApplication.processGeneration === processGenerationBeforeSync &&
          previousApplication.lifecycleGeneration === lifecycleGenerationBeforeSync,
      };
    }
    const owesConfigApplication = pending?.configApplication !== undefined;
    if (pending) {
      const credentialsApplied = await this.applyPendingCredentialReload(options);
      if (credentialsApplied) return credentialsApplied;
    }

    const applyMode = owesConfigApplication ? 'none' : isAuthLogout
      ? resolveAuthLogoutConfigApplyMode({
          gatewayPhase: statusBeforeSync.phase,
          configChanged: syncResult.configChanged,
        })
      : resolveOpenClawConfigApplyMode({
          gatewayPhase: statusBeforeSync.phase,
          configChanged: syncResult.configChanged,
          gatewayLaunchEnvVarsChanged,
          requiresGatewayRestart: syncResult.requiresGatewayRestart,
        });
    const verificationOptions = {
      retiredProviderIds: options.retiredProviderIds,
      ownership: this.getCredentialReloadOwnership(this.pendingCredentialReload),
      // This is based on the complete persisted diff, never on the sync reason alone.
      skipSessionModelReconciliation: syncResult.modelDefaultsOnly === true &&
        !syncResult.secretsChanged && !gatewayLaunchEnvVarsChanged,
    };
    const ownership = verificationOptions.ownership;
    const unconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedConfigApplication({
      success: false, changed: syncResult.changed, configSynced: false,
    });
    const stopOwnership = ownership ? { isCurrentOwner: ownership.ownsProcess } : undefined;
    const requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = ownership
      ? <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(ownership.isCurrent, method, params)
      : this.deps.requestGateway;

    if (applyMode === 'none') {
      return this.verifySuccessfulConfigApplication(
        {
          success: true,
          changed: syncResult.changed,
          configSynced: true,
        },
        {
          ...verificationOptions,
          execPolicyAlreadyVerified: fallbackExecPolicyVerified,
        },
      );
    }

    if (applyMode === 'native-reload') {
      const reloaded = syncResult.secretsChanged
        ? await engineManager.waitForGatewayConfigReload(reloadGeneration, resolveManagedCredentialReloadTimeoutMs())
        : await engineManager.waitForGatewayConfigReload(reloadGeneration);
      if (ownership && !ownership.isCurrent()) return unconfirmed();
      if (reloaded) {
        return this.verifySuccessfulConfigApplication(
          {
            success: true,
            changed: syncResult.changed,
            configSynced: true,
            status: engineManager.getStatus(),
          },
          verificationOptions,
        );
      }
      if (isAuthLogout) {
        return this.failClosedConfigApplication({
          success: false,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        }, 'OpenClaw logout config was written, but native reload did not complete.', stopOwnership);
      }
      if (options.restartGatewayIfRunning === false) {
        return this.failClosedConfigApplication({
          success: false,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        }, 'OpenClaw config was written, but native reload did not complete.', stopOwnership);
      }
      console.warn(
        `[OpenClaw] syncOpenClawConfig: native reload did not complete; requesting an in-process restart (reason: ${options.reason})`,
      );
      const nativeRestart = await requestGatewayConfigRestart(
        engineManager, requestGateway, options.reason,
      );
      if (ownership && (!ownership.isCurrent() || nativeRestart === GatewayConfigRestartOutcome.Pending)) {
        return unconfirmed();
      }
      if (nativeRestart === GatewayConfigRestartOutcome.Unconfirmed) {
        return {
          success: false,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
          error: t('engineConfigApplicationUnconfirmed'),
        };
      }
      if (nativeRestart !== GatewayConfigRestartOutcome.Unavailable) {
        const result = {
          success: true,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        };
        if (nativeRestart === GatewayConfigRestartOutcome.Ready) {
          const restored = await this.restoreGatewayBridgeOrFailClosed(result, ownership);
          return restored.success
            ? this.verifySuccessfulConfigApplication(restored, verificationOptions)
            : restored;
        }
        return result;
      }
    }

    if (applyMode === 'hard-restart' && options.restartGatewayIfRunning === false) {
      return this.failClosedConfigApplication({
        success: false,
        changed: syncResult.changed,
        configSynced: true,
        status: engineManager.getStatus(),
      }, 'OpenClaw config change requires a Gateway restart.', stopOwnership);
    }

    const restartResult = await this.restartGatewayOrDefer(
      options.reason,
      syncResult.changed,
      applyMode === 'hard-restart',
      ownership,
    );
    return restartResult.success
      ? this.verifySuccessfulConfigApplication(restartResult, verificationOptions)
      : restartResult;
  }

  private unconfirmedConfigApplication(result: SyncOpenClawConfigResult): SyncOpenClawConfigResult {
    return {
      ...result, success: false, configSynced: false,
      status: this.deps.getOpenClawEngineManager().getStatus(),
      error: t('engineConfigApplicationUnconfirmed'),
    };
  }

  private getCredentialReloadOwnership(pending: PendingCredentialReload | null): ConfigApplicationOwnership | undefined {
    const acknowledged = pending?.acknowledged;
    if (!pending || !acknowledged) return undefined;
    return this.createCredentialApplicationOwnership(pending, acknowledged);
  }

  private createCredentialApplicationOwnership(
    pending: PendingCredentialReload,
    identity: { processGeneration: number; lifecycleGeneration: number },
  ): ConfigApplicationOwnership {
    const manager = this.deps.getOpenClawEngineManager();
    const ownsProcess = (): boolean => this.pendingCredentialReload === pending &&
      (this.deps.getModelAuthSessionId?.() ?? null) === pending.authSessionId &&
      manager.getGatewayProcessGeneration() === identity.processGeneration;
    return {
      ownsProcess,
      isCurrent: () => ownsProcess() && manager.getStatus().phase === 'running' &&
        manager.getGatewayLifecycleGeneration() === identity.lifecycleGeneration,
    };
  }

  private async requestOwnedGateway<T>(
    isCurrent: () => boolean,
    method: string,
    params?: unknown,
    options?: { timeoutMs: number },
  ): Promise<T> {
    if (!isCurrent()) throw new Error('Configuration application was superseded.');
    if (!this.deps.getGatewayClient()) await this.deps.connectGatewayClient();
    if (!isCurrent()) throw new Error('Configuration application was superseded.');
    const client = this.deps.getGatewayClient();
    if (!client) throw new Error('OpenClaw gateway client is unavailable.');
    const response = options
      ? await client.request<T>(method, params, options)
      : params === undefined
        ? await client.request<T>(method)
        : await client.request<T>(method, params);
    if (!isCurrent()) throw new Error('Configuration application was superseded.');
    return response;
  }

  private async applyPendingCredentialConfig(
    pending: PendingCredentialReload,
    options: SyncOpenClawConfigOptions,
  ): Promise<SyncOpenClawConfigResult | null> {
    const application = pending.configApplication;
    if (!application) return null;
    const manager = this.deps.getOpenClawEngineManager();
    const identity = {
      processGeneration: manager.getGatewayProcessGeneration(),
      lifecycleGeneration: manager.getGatewayLifecycleGeneration(),
    };
    const ownership = this.createCredentialApplicationOwnership(pending, identity);
    const unconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedConfigApplication({
      success: false, changed: true, configSynced: false,
    });
    if (!ownership.isCurrent()) return unconfirmed();
    const requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] =
      <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(ownership.isCurrent, method, params);
    if (application.nativeRestartRequested &&
      identity.processGeneration === application.processGeneration &&
      identity.lifecycleGeneration === application.lifecycleGeneration) {
      // Native idle deferral leaves suspension admission open. A new launch
      // environment must not race an already accepted or uncertain restart.
      await manager.waitForGatewayReadyAfter(application.lifecycleGeneration, resolveManagedCredentialReloadTimeoutMs());
      return unconfirmed();
    }
    const newProcess = identity.processGeneration !== application.processGeneration;
    const newlyReadyRuntime = application.requiresHardRestart
      ? newProcess && !manager.hasPendingGatewayLaunchEnvironmentChanges()
      : newProcess || identity.lifecycleGeneration !== application.lifecycleGeneration;
    if (!newlyReadyRuntime) {
      if (application.requiresHardRestart) {
        if (options.restartGatewayIfRunning === false) {
          return this.failClosedConfigApplication(unconfirmed(), 'OpenClaw credential config requires a Gateway restart.', {
            isCurrentOwner: ownership.ownsProcess,
          });
        }
        await this.restartGatewayOrDefer(options.reason, true, true, ownership);
        return unconfirmed();
      }
      const applied = application.nativeRestartRequested
        ? await manager.waitForGatewayReadyAfter(application.lifecycleGeneration, resolveManagedCredentialReloadTimeoutMs())
        : await manager.waitForGatewayConfigReload(application.reloadGeneration, resolveManagedCredentialReloadTimeoutMs());
      if (!ownership.isCurrent()) return unconfirmed();
      if (!applied) {
        if (application.nativeRestartRequested) return unconfirmed();
        if (options.restartGatewayIfRunning === false) {
          return this.failClosedConfigApplication(unconfirmed(), 'OpenClaw credential config reload did not complete.', {
            isCurrentOwner: ownership.ownsProcess,
          });
        }
        const nativeRestart = await requestGatewayConfigRestart(manager, requestGateway, options.reason);
        application.nativeRestartRequested = nativeRestart !== GatewayConfigRestartOutcome.Unavailable;
        if (!ownership.isCurrent()) return unconfirmed();
        if (nativeRestart === GatewayConfigRestartOutcome.Unavailable) {
          application.requiresHardRestart = true;
          await this.restartGatewayOrDefer(options.reason, true, true, ownership);
          return unconfirmed();
        }
        if (nativeRestart !== GatewayConfigRestartOutcome.Ready) return unconfirmed();
      }
    }
    // secrets.reload reuses the runtime's previous source config. Only an
    // observed watcher application or a newly ready runtime can establish that
    // these revisions describe the newly published source, rather than a cache.
    try {
      const snapshot = await requestGateway<ConfigSnapshot>('config.get');
      if (typeof snapshot.configRevisionHash !== 'string' || !snapshot.configRevisionHash.trim() ||
        snapshot.configRevisionHash !== snapshot.appliedConfigHash) return unconfirmed();
    } catch {
      return unconfirmed();
    }
    if (!ownership.isCurrent()) return unconfirmed();
    pending.configApplication = undefined;
    return null;
  }

  private async applyPendingCredentialReload(options: SyncOpenClawConfigOptions): Promise<SyncOpenClawConfigResult | null> {
    const { reason } = options;
    const pending = this.pendingCredentialReload;
    if (!pending) return null;
    const manager = this.deps.getOpenClawEngineManager();
    const authIsCurrent = (): boolean => (this.deps.getModelAuthSessionId?.() ?? null) === pending.authSessionId;
    const unconfirmed = (): SyncOpenClawConfigResult => ({
      success: false, changed: true, configSynced: false, status: manager.getStatus(),
      error: t('engineConfigApplicationUnconfirmed'),
    });
    let initializeExecPolicy = false;
    if (manager.getStatus().phase !== 'running') {
      const stopped = pending.stopped;
      const status = manager.getStatus();
      if (reason === BuiltinModelSyncReason.AuthLogout || !stopped || pending.recoveryUsed || !authIsCurrent() || status.phase !== 'error' ||
        manager.getGatewayProcessGeneration() !== stopped.processGeneration ||
        status.diagnosticId !== stopped.diagnosticId || status.message !== stopped.message) return unconfirmed();
      // One bounded recovery of our own failed stop, never an unrelated stop or
      // a user-replaced process. Startup reads the current canonical secrets.
      pending.recoveryUsed = true;
      const expectedProcessGeneration = stopped.processGeneration + 1;
      let recovered: OpenClawEngineStatus;
      try {
        recovered = await manager.startGateway();
      } catch (error) {
        console.error('[OpenClaw] Managed credential recovery startup failed:', {
          reason,
          error: redactLogText(error instanceof Error ? error.stack || error.message : String(error)),
        });
        return unconfirmed();
      }
      if (!authIsCurrent() || recovered.phase !== 'running' || manager.getStatus().phase !== 'running' ||
        manager.getGatewayProcessGeneration() !== expectedProcessGeneration) return unconfirmed();
      initializeExecPolicy = true;
    }
    const processGeneration = manager.getGatewayProcessGeneration();
    const lifecycleGeneration = manager.getGatewayLifecycleGeneration();
    const { ownsProcess, isCurrent } = this.createCredentialApplicationOwnership(pending, {
      processGeneration, lifecycleGeneration,
    });
    const configurationApplied = await this.applyPendingCredentialConfig(pending, options);
    if (configurationApplied) return configurationApplied;
    if (!isCurrent()) return unconfirmed();
    const result = await reloadManagedCredentials({
      reason,
      isCurrent,
      getGatewayPhase: () => manager.getStatus().phase,
      // Captured clients cannot implicitly launch a stopped Gateway, unlike
      // the general requester. Reconnect and dispatch only for the same owner.
      request: timeoutMs => this.requestOwnedGateway(isCurrent, 'secrets.reload', undefined, { timeoutMs }),
    });
    if (result.outcome === ManagedCredentialReloadOutcome.Superseded) return unconfirmed();
    if (result.outcome === ManagedCredentialReloadOutcome.Failed) {
      if (!isCurrent()) return unconfirmed();
      let confirmedStopped = false;
      const failed = await this.failClosedConfigApplication({
        success: false, changed: true, configSynced: false, status: manager.getStatus(),
      }, 'Failed to refresh managed model provider credentials.', {
        isCurrentOwner: ownsProcess,
        onStopped: () => { confirmedStopped = true; },
      });
      if (result.retryable && confirmedStopped && ownsProcess() && failed.status?.phase === 'error') {
        pending.stopped = {
          processGeneration,
          diagnosticId: failed.status.diagnosticId,
          message: failed.status.message,
        };
      }
      return failed;
    }
    pending.acknowledged = { processGeneration, lifecycleGeneration };
    if (!initializeExecPolicy) return null;
    // The recovery started a new runtime and therefore owes a new permission
    // initialization; a disk-only sync cannot discharge this obligation.
    const initialized = await this.verifySuccessfulConfigApplication({
      success: true, changed: true, configSynced: true, status: manager.getStatus(),
    }, {
      initializeExecPolicy: true, executionAdmission: true,
      ownership: this.getCredentialReloadOwnership(pending),
    });
    // A recovered runtime still owes this sync's model reconciliation and
    // retired-provider cleanup. Startup permission admission alone is not it.
    return initialized.success ? null : initialized;
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

  verifyExecutionPermissionPolicy(options: ExecutionAdmissionOptions = {}): Promise<SyncOpenClawConfigResult> {
    return this.enqueueSyncOperation(() =>
      this.verifySuccessfulConfigApplication({
        success: true,
        changed: false,
        configSynced: true,
        status: this.deps.getOpenClawEngineManager().getStatus(),
      }, { executionAdmission: true, ...options }),
    );
  }

  startGatewayWithExecutionPolicy(options: ExecutionAdmissionOptions = {}): Promise<OpenClawEngineStatus> {
    return this.enqueueSyncOperation(async () => {
      const engineManager = this.deps.getOpenClawEngineManager();
      const current = engineManager.getStatus();
      const needsStartupPolicy = current.phase !== 'running';
      const status = needsStartupPolicy ? await engineManager.startGateway() : current;
      if (status.phase !== 'running') return status;

      // A stopped config projection cannot use Gateway approval RPCs. Complete
      // that startup obligation here, without redoing config/model/auth work.
      const verified = await this.verifySuccessfulConfigApplication({
        success: true,
        changed: false,
        configSynced: true,
        status,
      }, { executionAdmission: true, initializeExecPolicy: needsStartupPolicy, ...options });
      if (!verified.success && (verified.status ?? engineManager.getStatus()).phase === 'running')
        throw new Error(verified.error || t('enginePreparationFailed'));
      if (verified.success && needsStartupPolicy) {
        void maintainStartupAuthProfiles({
          getGatewayClient: this.deps.getGatewayClient,
          manager: engineManager,
          runExclusive: operation => this.enqueueSyncOperation(operation),
        }).catch(error => {
          console.warn(
            '[OpenClaw] Startup provider auth maintenance failed; a later config change can retry:',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      return verified.status ?? engineManager.getStatus();
    });
  }

  private async verifySuccessfulConfigApplication(
    result: SyncOpenClawConfigResult,
    options: {
      execPolicyAlreadyVerified?: boolean;
      retiredProviderIds?: readonly string[];
      executionAdmission?: boolean;
      initializeExecPolicy?: boolean;
      prepareComputerForSend?: boolean;
      skipSessionModelReconciliation?: boolean;
      ownership?: ConfigApplicationOwnership;
    } = {},
  ): Promise<SyncOpenClawConfigResult> {
    const engineManager = this.deps.getOpenClawEngineManager();
    const unconfirmedOwnership = (): SyncOpenClawConfigResult => ({
      ...result, success: false, configSynced: false, status: engineManager.getStatus(),
      error: t('engineConfigApplicationUnconfirmed'),
    });
    if (options.ownership && !options.ownership.isCurrent()) return unconfirmedOwnership();
    if (engineManager.getStatus().phase !== 'running') {
      return options.executionAdmission
        ? { ...result, success: false, status: engineManager.getStatus() }
        : result;
    }
    const processGeneration = options.executionAdmission
      ? engineManager.getGatewayProcessGeneration()
      : undefined;
    const configGeneration = options.prepareComputerForSend
      ? engineManager.getGatewayConfigReloadGeneration()
      : undefined;
    const supersededAdmission = (): SyncOpenClawConfigResult | null => {
      if (options.ownership && !options.ownership.isCurrent()) return unconfirmedOwnership();
      return options.executionAdmission && (
        engineManager.getStatus().phase !== 'running' ||
        engineManager.getGatewayProcessGeneration() !== processGeneration
      ) ? {
          ...result,
          success: false,
          status: {
            ...engineManager.getStatus(),
            phase: 'error',
            message: 'The active Gateway permission policy is unavailable.',
          },
        } : null;
    };
    const ownership = options.ownership;
    const requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = ownership
      ? <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(ownership.isCurrent, method, params)
      : this.deps.requestGateway;
    const stopOwnership = ownership ? { isCurrentOwner: ownership.ownsProcess } : undefined;

    try {
      const [runtimeConfigResult, execPolicyApplied] = await Promise.all([
        this.verifyRuntimePermissionConfig(requestGateway),
        options.execPolicyAlreadyVerified
          ? Promise.resolve(true)
          : options.executionAdmission && !options.initializeExecPolicy
            ? requestGateway<ExecApprovalsSnapshot>('exec.approvals.get')
              .then(snapshot => typeof snapshot.hash === 'string' && snapshot.hash.length > 0 &&
                this.isExecApprovalPolicyApplied(snapshot.file))
            : options.initializeExecPolicy
              ? this.initializeExecApprovalPolicy(() => supersededAdmission() === null)
              : this.applyExecApprovalPolicy(ownership?.isCurrent, requestGateway),
      ]);
      const superseded = supersededAdmission();
      if (superseded) return superseded;
      if (runtimeConfigResult.verified && execPolicyApplied) {
        if (options.executionAdmission) {
          const client = options.prepareComputerForSend ? this.deps.getGatewayClient() : null;
          if (options.prepareComputerForSend && client && processGeneration !== undefined && configGeneration !== undefined) {
            this.computerHostPreparation.start({
              client,
              config: runtimeConfigResult.snapshot.config,
              processGeneration,
              configGeneration,
              isCurrent: () => this.deps.getGatewayClient() === client &&
                engineManager.getStatus().phase === 'running' &&
                engineManager.getGatewayProcessGeneration() === processGeneration &&
                engineManager.getGatewayConfigReloadGeneration() === configGeneration,
            });
          }
          return { ...result, hostPolicyVerified: true };
        }
        if (!options.skipSessionModelReconciliation) {
          await this.syncManagedSessionModelsViaGateway(runtimeConfigResult.snapshot, requestGateway);
        }
        const afterModels = supersededAdmission();
        if (afterModels) return afterModels;
        await this.discoverOrphanedManagedAuthProfiles(runtimeConfigResult.snapshot, requestGateway);
        const afterDiscovery = supersededAdmission();
        if (afterDiscovery) return afterDiscovery;
        await this.cleanupRetiredProviderAuthProfiles(
          runtimeConfigResult.snapshot,
          options.retiredProviderIds ?? [],
          requestGateway,
        );
        const afterCleanup = supersededAdmission();
        if (afterCleanup) return afterCleanup;
        return { ...result, hostPolicyVerified: true };
      }

      const error = 'The OpenClaw host execution policy could not be verified.';
      return this.failClosedConfigApplication(result, error, stopOwnership);
    } catch (error) {
      const superseded = supersededAdmission();
      if (superseded) return superseded;
      const message = `Failed to apply or verify the active OpenClaw permission state: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return this.failClosedConfigApplication(result, message, stopOwnership);
    }
  }

  private async discoverOrphanedManagedAuthProfiles(
    snapshot: ConfigSnapshot,
    requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = this.deps.requestGateway,
  ): Promise<void> {
    if (this.orphanedAuthProfilesReconciled) return;

    try {
      const configuredProviders = new Set(
        Object.keys(snapshot.config?.models?.providers ?? {}).map(provider =>
          provider.trim().toLowerCase(),
        ),
      );
      const authStatus = await requestGateway<ModelAuthStatusSnapshot>(
        'models.authStatus',
        { agentId: 'main' },
      );
      if (authStatus.unavailable) {
        throw new Error('model authentication status is temporarily unavailable');
      }
      for (const entry of authStatus.providers ?? []) {
        if (typeof entry.provider !== 'string') continue;
        const provider = entry.provider.trim().toLowerCase();
        if (!provider || configuredProviders.has(provider)) continue;

        const profiles = Array.isArray(entry.profiles) ? entry.profiles : [];
        const isJustDoManagedOrphan =
          profiles.length > 0 &&
          profiles.every(
            profile =>
              profile.profileId === `${provider}:default` &&
              profile.type === 'api_key' &&
              (profile.source === 'saved' || profile.source === 'inherited'),
          );
        if (isJustDoManagedOrphan) this.pendingRetiredProviderIds.add(provider);
      }
      this.orphanedAuthProfilesReconciled = true;
    } catch (error) {
      console.warn(
        '[OpenClaw] Failed to inspect orphaned managed auth profiles; will retry later',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async cleanupRetiredProviderAuthProfiles(
    snapshot: ConfigSnapshot,
    providerIds: readonly string[],
    requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = this.deps.requestGateway,
  ): Promise<void> {
    const configuredProviders = new Set(
      Object.keys(snapshot.config?.models?.providers ?? {}).map(provider =>
        provider.trim().toLowerCase(),
      ),
    );
    const uniqueProviderIds = [
      ...new Set([
        ...this.pendingRetiredProviderIds,
        ...providerIds.map(id => id.trim().toLowerCase()).filter(Boolean),
      ]),
    ];
    for (const provider of uniqueProviderIds) {
      if (configuredProviders.has(provider)) {
        this.pendingRetiredProviderIds.delete(provider);
        continue;
      }
      try {
        const result = await requestGateway<{
          removedProfiles?: unknown;
        }>('models.authLogout', {
          provider,
          agentId: 'main',
        });
        const removedCount = Array.isArray(result.removedProfiles)
          ? result.removedProfiles.length
          : 0;
        console.info(
          `[OpenClaw] Retired provider auth cleanup completed: provider=${provider} removedProfiles=${removedCount}`,
        );
        this.pendingRetiredProviderIds.delete(provider);
      } catch (error) {
        // Provider removal remains applied. A later config change can retry the
        // cleanup without restoring a credential or touching session history.
        console.warn(
          `[OpenClaw] Failed to clean retired provider auth profile: provider=${provider}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async verifyRuntimePermissionConfig(
    requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = this.deps.requestGateway,
  ): Promise<{
    verified: boolean;
    snapshot: ConfigSnapshot;
  }> {
    const snapshot = await requestGateway<ConfigSnapshot>('config.get');
    const executionMode = this.deps.getCoworkStore().getConfig().executionMode || 'local';
    const expectedExecHost = resolveOpenClawExecHost(executionMode);
    return {
      snapshot,
      verified:
        snapshot.config?.tools?.exec?.host === expectedExecHost &&
        snapshot.config.tools.exec.mode === OPENCLAW_FALLBACK_EXEC_MODE &&
        snapshot.config?.tools?.fs?.workspaceOnly === OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
    };
  }

  private async syncManagedSessionModelsViaGateway(
    snapshot: ConfigSnapshot,
    requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = this.deps.requestGateway,
  ): Promise<void> {
    const policy = createManagedSessionModelPolicy(snapshot.config);
    if (!policy.hasTargets) return;
    const limit = 200;
    let offset = 0;
    const seenOffsets = new Set<number>();
    while (!seenOffsets.has(offset)) {
      seenOffsets.add(offset);
      const page = parseSessionsListResultV2026_10_6(
        await requestGateway('sessions.list', {
          rowMode: OPENCLAW_COMPACT_SESSION_ROW_MODE, limit, offset,
        }),
      );
      for (const session of page.sessions) {
        const match = /^agent:([^:]+):justdo:(.+)$/.exec(session.key);
        if (!match) continue;
        // An unchanged, available selection needs no repair. Do not issue one
        // describe RPC per historical conversation on every default switch.
        // This fast path never writes a list snapshot back into local state:
        // a concurrent user selection remains authoritative.
        const listedRef = readModelRef(session);
        if (
          listedRef && policy.availableRoute(listedRef) &&
          this.deps.getCoworkStore().getSessionModelRef(match[2]) === listedRef
        ) continue;
        await enqueueSessionModelOperation(session.key, async () => {
          // The list may precede a user switch. Re-read inside the same ordering
          // boundary as SessionRpc before repairing a removed provider/model.
          const described = await requestGateway<{ session?: unknown }>('sessions.describe', {
            key: session.key,
          });
          if (!described.session) return;
          const selectedRef = readModelRef(described.session);
          const store = this.deps.getCoworkStore();
          const persistedRef = store.getSessionModelRef(match[2]);
          // A valid native selection is user-owned, even when the local snapshot
          // still names an earlier picker selection (for example after /model).
          if (selectedRef && policy.availableRoute(selectedRef)) {
            if (persistedRef !== selectedRef) store.updateSession(match[2], { modelRef: selectedRef });
            return;
          }
          const target = policy.repairTarget(match[1], persistedRef);
          if (!target) return;
          const patched = await requestGateway<{ resolved?: unknown }>('sessions.patch', {
            key: session.key,
            model: target,
          });
          const modelRef = readModelRef(patched.resolved);
          if (!modelRef) throw new Error('sessions.patch returned no resolved model');
          store.updateSession(match[2], { modelRef });
        });
      }
      if (!page.hasMore || page.nextOffset === null || page.nextOffset === undefined) break;
      if (page.nextOffset <= offset) {
        throw new Error('OpenClaw sessions.list returned a non-advancing pagination cursor');
      }
      offset = page.nextOffset;
    }
  }

  private async initializeExecApprovalPolicy(isCurrentProcess: () => boolean): Promise<boolean> {
    if (!isCurrentProcess()) return false;
    await this.deps.connectGatewayClient();
    if (!isCurrentProcess()) return false;
    const client = this.deps.getGatewayClient();
    if (!client) throw new Error('The active Gateway permission policy is unavailable.');
    // Mutating startup RPCs must stay on this client. The general requester
    // reconnects automatically and could otherwise write an old snapshot into
    // a replacement after the process check but before dispatch.
    return this.applyExecApprovalPolicy(
      isCurrentProcess,
      <T>(method: string, params?: unknown) => client.request<T>(method, params),
    );
  }

  private async applyExecApprovalPolicy(
    isCurrentProcess?: () => boolean,
    requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = this.deps.requestGateway,
  ): Promise<boolean> {
    const current =
      await requestGateway<ExecApprovalsSnapshot>('exec.approvals.get');
    if (isCurrentProcess && !isCurrentProcess()) return false;
    if (
      typeof current.hash === 'string' &&
      current.hash.length > 0 &&
      this.isExecApprovalPolicyApplied(current.file)
    ) {
      return true;
    }

    const file: ExecApprovalsFile = {
      ...(current.file ?? {}),
      version: 1,
    };
    const policy = FALLBACK_EXEC_APPROVAL_FIELDS;
    file.defaults = { ...(file.defaults ?? {}), ...policy };
    file.agents = Object.fromEntries(
      Object.entries(file.agents ?? {}).map(([agentId, entry]) => [
        agentId,
        removePersistentApprovalGrants({ ...entry, ...policy }),
      ]),
    );
    const submitted = await requestGateway<ExecApprovalsSnapshot>('exec.approvals.set', {
      file,
      ...(current.hash ? { baseHash: current.hash } : {}),
    });
    if (isCurrentProcess && !isCurrentProcess()) return false;
    const applied =
      await requestGateway<ExecApprovalsSnapshot>('exec.approvals.get');
    return (
      typeof submitted.hash === 'string' &&
      submitted.hash.length > 0 &&
      applied.hash === submitted.hash &&
      this.isExecApprovalPolicyApplied(applied.file)
    );
  }

  private isExecApprovalPolicyApplied(file: ExecApprovalsFile | undefined): boolean {
    if (file?.version !== 1) return false;

    const expected = FALLBACK_EXEC_APPROVAL_FIELDS;
    const defaults = file.defaults;
    const agents = file.agents ?? {};

    const agentsMatch = Object.values(agents).every(agent => {
      return (
        agent?.security === expected.security &&
        agent.ask === expected.ask &&
        agent.askFallback === expected.askFallback
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
    ownership?: { isCurrentOwner: () => boolean; onStopped?: () => void },
  ): Promise<SyncOpenClawConfigResult> {
    const engineManager = this.deps.getOpenClawEngineManager();
    const superseded = (): SyncOpenClawConfigResult => ({
      ...result, success: false, configSynced: false, status: engineManager.getStatus(),
      error: t('engineConfigApplicationUnconfirmed'),
    });
    if (ownership && !ownership.isCurrentOwner()) return superseded();
    this.deps.disconnectGatewayClient();
    let stopError: string | undefined;
    try {
      await engineManager.stopGateway();
    } catch (cause) {
      stopError = cause instanceof Error ? cause.message : String(cause);
    }
    if (ownership && !ownership.isCurrentOwner()) return superseded();
    if (!stopError) ownership?.onStopped?.();
    const status = engineManager.setExternalError(
      stopError
        ? `Runtime safety verification failed and the Gateway stop failed: ${stopError}`
        : `Runtime safety verification failed; the Gateway was stopped. ${error}`,
    );
    return {
      ...result,
      success: false,
      configSynced: false,
      status,
      error:
        `The product configuration may have been persisted, but the active runtime safety state was not confirmed. ` +
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
    ownership?: ConfigApplicationOwnership,
  ): Promise<SyncOpenClawConfigResult> {
    const requiresImmediateRestart =
      reason === 'browser-mode-change' || reason === 'browser-mode-rollback';
    const engineManager = this.deps.getOpenClawEngineManager();
    const unconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedConfigApplication({
      success: false, changed, configSynced: false,
    });
    if (ownership && !ownership.isCurrent()) return unconfirmed();
    let status = engineManager.getStatus();
    if (status.phase === 'starting') {
      status = await engineManager.startGateway();
      if (ownership && !ownership.isCurrent()) return unconfirmed();
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
        }, ownership);
      }
    }
    if (status.phase === 'error') {
      const started = await engineManager.startGateway();
      if (ownership && !ownership.isCurrent()) return unconfirmed();
      if (started.phase === 'running') {
        return this.restoreGatewayBridgeOrFailClosed({
          success: true,
          changed,
          configSynced: true,
          status: started,
        }, ownership);
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
    if (reason === 'proxy-change' && engineManager.canReuseGatewayNetworkEnvironment()) {
      console.log('[OpenClaw] Proxy preference applied through the existing local network route.');
      return { success: true, changed, configSynced: true, status };
    }
    const targetProcessGeneration = engineManager.getGatewayProcessGeneration();
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration, ownership);
    if (ownership && !ownership.isCurrent()) return unconfirmed();
    if (!suspension) {
      if (requiresImmediateRestart) {
        const failure = {
          success: false,
          changed,
          configSynced: true,
          status,
          error:
            'The browser provider could not be switched while the Gateway was busy. Try again after active work finishes.',
        };
        return reason === 'browser-mode-rollback'
          ? this.failClosedConfigApplication(
              failure,
              'The previous browser provider configuration was restored, but the active Gateway could not be restarted immediately.',
              ownership ? { isCurrentOwner: ownership.ownsProcess } : undefined,
            )
          : failure;
      }
      console.log(
        `[OpenClaw] syncOpenClawConfig: deferring hard restart until the native Gateway suspension is ready (reason: ${reason})`,
      );
      this.scheduleDeferredGatewayRestart(reason, targetProcessGeneration, ownership);
      if (ownership) return unconfirmed();
      return {
        success: true,
        changed,
        configSynced: true,
        status,
      };
    }

    const actionAfterSuspension = resolveDeferredGatewayRestartAction({
      gatewayPhase: engineManager.getStatus().phase,
      currentProcessGeneration: engineManager.getGatewayProcessGeneration(),
      targetProcessGeneration,
    });
    if (actionAfterSuspension === 'discard') {
      if (requiresImmediateRestart) {
        const failure = {
          success: false,
          changed,
          configSynced: true,
          status: engineManager.getStatus(),
          error:
            'The Gateway lifecycle changed before the browser provider restart could complete.',
        };
        return reason === 'browser-mode-rollback'
          ? this.failClosedConfigApplication(
              failure,
              'The browser provider rollback was superseded by another Gateway lifecycle change.',
              ownership ? { isCurrentOwner: ownership.ownsProcess } : undefined,
            )
          : failure;
      }
      console.log(
        `[OpenClaw] syncOpenClawConfig: concurrent Gateway lifecycle superseded the prepared restart (reason: ${reason})`,
      );
      if (ownership) return unconfirmed();
      this.rescheduleDeferredGatewayRestartForCurrentLifecycle(reason);
      return {
        success: true,
        changed,
        configSynced: true,
        status: engineManager.getStatus(),
      };
    }

    console.log(
      `[OpenClaw] syncOpenClawConfig: pre-emptively disconnecting runtime adapter before gateway restart (reason: ${reason})`,
    );
    this.clearDeferredRestartForGeneration(targetProcessGeneration);
    this.deps.disconnectGatewayClient();

    // A concurrent caller must reuse this generation's restart. Queueing an
    // un-fenced trailing restart would target the newly started Gateway.
    const restarted = await engineManager.restartGateway();
    // A deliberate restart also invalidates the old credential ACK. A later
    // sync must reload and verify the new runtime instead of borrowing it.
    if (ownership && !ownership.isCurrent()) return unconfirmed();
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
    }, ownership);
  }

  private async restoreGatewayBridgeOrFailClosed(
    result: SyncOpenClawConfigResult,
    ownership?: ConfigApplicationOwnership,
  ): Promise<SyncOpenClawConfigResult> {
    if (ownership && !ownership.isCurrent()) return this.unconfirmedConfigApplication(result);
    try {
      await this.deps.connectGatewayClient();
      if (ownership && !ownership.isCurrent()) return this.unconfirmedConfigApplication(result);
      return result;
    } catch (error) {
      if (ownership && !ownership.isCurrent()) return this.unconfirmedConfigApplication(result);
      return this.failClosedConfigApplication(
        {
          ...result,
          success: false,
          configSynced: false,
        },
        `Failed to restore the approval event bridge after Gateway start: ${String(error)}`,
        ownership ? { isCurrentOwner: ownership.ownsProcess } : undefined,
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
        getExternalAgentSettings: () =>
          this.deps.getCoworkStore().getExternalAgentSettings(),
        getMcpServers: () => this.deps.getMcpStore().listServers(),
        getHooks: () => this.deps.getHookStore().listHooks(),
        getAgents: () => this.deps.getCoworkStore().listAgents(),
        getBrowserMode: this.deps.getBrowserMode,
        getControlUiEnabled: this.deps.getControlUiEnabled,
        getDecisionModelCategory: this.deps.getDecisionModelCategory,
        getNativeVideoCategory: this.deps.getNativeVideoCategory,
        getLocalSttConfig: this.deps.getLocalSttConfig,
        getSpeechModelSettings: this.deps.getSpeechModelSettings,
        getLocalTtsConfig: this.deps.getLocalTtsConfig,
        getLocalSpeechExtensionTtsConfig: this.deps.getLocalSpeechExtensionTtsConfig,
        getSpeechOutputState: this.deps.getSpeechOutputState,
        getWindowsSandboxEnvironment: this.deps.getWindowsSandboxEnvironment,
      });
    }
    return this.configSync;
  }

  private clearDeferredRestart(): void {
    if (this.deferredRestartTimer) {
      clearInterval(this.deferredRestartTimer);
      this.deferredRestartTimer = null;
    }
    this.deferredRestartGeneration = null;
  }

  private clearDeferredRestartForGeneration(targetProcessGeneration: number): void {
    if (this.deferredRestartGeneration === targetProcessGeneration) {
      this.clearDeferredRestart();
    }
  }

  private async prepareGatewayRestartSuspension(
    targetProcessGeneration: number,
    ownership?: ConfigApplicationOwnership,
  ): Promise<GatewayRestartSuspension | null> {
    if (ownership && !ownership.isCurrent()) return null;
    const requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = ownership
      ? <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(ownership.isCurrent, method, params)
      : this.deps.requestGateway;
    try {
      const result = await requestGateway<GatewaySuspendPrepareResult>(
        'gateway.suspend.prepare',
        {
          requestId: `justdo-config-restart-${targetProcessGeneration}`,
          terminalPolicy: 'preserve',
        },
      );
      if (
        result.status === 'ready' &&
        typeof result.suspensionId === 'string' &&
        result.suspensionId.trim()
      ) {
        return {
          suspensionId: result.suspensionId,
          targetProcessGeneration,
        };
      }
      if (result.status === 'busy' || result.status === 'draining') {
        return null;
      }
      throw new Error(`unexpected suspension response: ${JSON.stringify(result)}`);
    } catch (error) {
      console.warn(
        `[OpenClaw] Failed to acquire the native Gateway restart suspension; deferring restart: ${String(error)}`,
      );
      return null;
    }
  }

  private async executeDeferredGatewayRestart(
    reason: string,
    targetProcessGeneration: number,
    ownership?: ConfigApplicationOwnership,
  ): Promise<void> {
    if (ownership && !ownership.isCurrent()) {
      this.clearDeferredRestartForGeneration(targetProcessGeneration);
      return;
    }
    const engineManager = this.deps.getOpenClawEngineManager();
    const action = resolveDeferredGatewayRestartAction({
      gatewayPhase: engineManager.getStatus().phase,
      currentProcessGeneration: engineManager.getGatewayProcessGeneration(),
      targetProcessGeneration,
    });
    if (action === 'discard') {
      this.rescheduleDeferredGatewayRestartForCurrentLifecycle(reason);
      return;
    }
    this.clearDeferredRestart();
    console.log(
      `[OpenClaw] executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`,
    );
    this.deps.disconnectGatewayClient();
    // Suspension is bound to targetProcessGeneration, so a concurrent caller
    // must coalesce with this restart instead of queueing work on the next one.
    const status = await engineManager.restartGateway();
    if (ownership && !ownership.isCurrent()) return;
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
    }, ownership);
    if (!bridgeResult.success) {
      console.error(
        `[OpenClaw] executeDeferredGatewayRestart: runtime adapter reconnect failed and Gateway was failed closed (reason: ${reason}): ${bridgeResult.error ?? 'unknown error'}`,
      );
    }
  }

  private scheduleDeferredGatewayRestart(
    reason: string,
    targetProcessGeneration: number,
    ownership?: ConfigApplicationOwnership,
  ): void {
    if (this.deferredRestartTimer) {
      if (this.deferredRestartGeneration === targetProcessGeneration && !ownership) {
        console.log(
          `[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`,
        );
        return;
      }
      this.clearDeferredRestart();
    }
    this.deferredRestartGeneration = targetProcessGeneration;

    this.deferredRestartTimer = setInterval(() => {
      if (this.deferredRestartCheckInProgress) return;
      this.deferredRestartCheckInProgress = true;
      void this.enqueueSyncOperation(() =>
        this.checkDeferredGatewayRestart(reason, targetProcessGeneration, ownership),
      )
        .catch(error => {
          console.error(
            `[OpenClaw] Deferred Gateway restart check failed (reason: ${reason}): ${String(error)}`,
          );
        })
        .finally(() => {
          this.deferredRestartCheckInProgress = false;
        });
    }, DEFERRED_RESTART_POLL_MS);
  }

  private rescheduleDeferredGatewayRestartForCurrentLifecycle(reason: string): void {
    const engineManager = this.deps.getOpenClawEngineManager();
    const status = engineManager.getStatus();
    this.clearDeferredRestart();
    if (status.phase === 'running' || status.phase === 'starting') {
      const generation = engineManager.getGatewayProcessGeneration();
      console.log(
        `[OpenClaw] Retargeting deferred Gateway restart to process generation ${generation} (reason: ${reason})`,
      );
      this.scheduleDeferredGatewayRestart(reason, generation);
      return;
    }
    console.log(
      `[OpenClaw] Discarding deferred Gateway restart because the managed Gateway is ${status.phase} (reason: ${reason})`,
    );
  }

  private async checkDeferredGatewayRestart(
    reason: string,
    targetProcessGeneration: number,
    ownership?: ConfigApplicationOwnership,
  ): Promise<void> {
    if (this.deferredRestartGeneration !== targetProcessGeneration) return;
    if (ownership && !ownership.isCurrent()) {
      this.clearDeferredRestartForGeneration(targetProcessGeneration);
      return;
    }

    const engineManager = this.deps.getOpenClawEngineManager();
    const action = resolveDeferredGatewayRestartAction({
      gatewayPhase: engineManager.getStatus().phase,
      currentProcessGeneration: engineManager.getGatewayProcessGeneration(),
      targetProcessGeneration,
    });
    if (action === 'discard') {
      await this.executeDeferredGatewayRestart(reason, targetProcessGeneration, ownership);
      return;
    }
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration, ownership);
    if (ownership && !ownership.isCurrent()) {
      this.clearDeferredRestartForGeneration(targetProcessGeneration);
      return;
    }
    if (suspension && this.deferredRestartGeneration === targetProcessGeneration) {
      await this.executeDeferredGatewayRestart(reason, targetProcessGeneration, ownership);
    }
  }
}

import fs from 'node:fs';

import type { BrowserMode } from '../../../shared/browser/browser';
import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import { OpenClawProviderId } from '../../../shared/providers';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import { readModelRef } from '../../../shared/providers/modelRef';
import type { WindowsSandboxStatus } from '../../../shared/security/windowsSandbox';
import { ManagedDirectoryRuntimeStopAbortedError } from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import type { CoworkStore } from '../../data/coworkStore';
import { createManagedSessionModelPolicy } from '../../engine/gateway/managedSessionModels';
import { enqueueSessionModelOperation } from '../../engine/gateway/sessionModelOperations';
import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  OPENCLAW_COMPACT_SESSION_ROW_MODE,
  parseSessionsListResultV2026_10_6,
} from '../../engine/openclaw/wire/v2026_10_6';
import type { GatewayRequestOptions } from '../../engine/types';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';
import { type NativeMcpDataBinding, nativeMcpDataDirectory, ownedNativeMcpDataServerNames, prepareNativeMcpData } from '../../plugins/data/nativeMcpData';
import type { OpenClawHookStore } from '../../plugins/hooks';
import type { McpStore } from '../../plugins/mcp';
import { discoverOpenClawManagedMcpServers } from '../../plugins/mcp';
import {
  BuiltinModelAuthDiagnosticEvent,
  BuiltinModelAuthDiagnosticReason,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from '../../providers/builtinModelAuthDiagnostics';
import { ComputerHostPreparation } from '../runtime/computerHostPreparation';
import {
  GatewayConfigRestartOutcome,
  requestGatewayConfigRestart,
} from '../runtime/gatewayConfigRestart';
import type { OpenClawConfigPublication } from './configVerification';
import { resolveManagedCredentialReloadTimeoutMs } from './models/credentialTimeouts';
import {
  ManagedCredentialReloadOutcome,
  reloadManagedCredentials,
} from './models/managedCredentialReload';
import { isModelDefaultsSyncReason } from './models/modelDefaultConfigChange';
import { maintainStartupAuthProfiles } from './models/startupAuthProfileMaintenance';
import { OpenClawConfigSync } from './openclawConfigSync';
import {
  OPENCLAW_FALLBACK_EXEC_MODE,
  OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
  resolveOpenClawExecHost,
} from './policies/executionPolicyProjection';
import type { ManagedSpeechModelSettings } from './speech/speechModelConfig';

type OpenClawConfigSyncServiceDeps = {
  getCoworkStore: () => CoworkStore;
  getAppPluginEntries?: () => Record<string, unknown>;
  getAppPluginDefaults?: (externalIds: readonly string[] | null) => Record<
    string, { defaultEnabled: boolean; userToggleable: boolean }
  >;
  getAppPluginPolicy?: () => { sandboxTools?: string[]; surfaces?: Record<string, unknown> };
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getMcpStore: () => McpStore;
  getExtensionMcpServerNames?: () => Promise<ReadonlySet<string>>;
  getNativeMcpDataBindings?: () => Promise<readonly NativeMcpDataBinding[]>;
  getHookStore: () => OpenClawHookStore;
  disconnectGatewayClient: () => void;
  connectGatewayClient: () => Promise<void>;
  requestGateway: <T>(method: string, params?: unknown, options?: GatewayRequestOptions) => Promise<T>;
  getGatewayClient: () => GatewayClientLike | null;
  getModelAuthSessionId?: () => string | null;
  getModelAuthSessionOwnerId?: () => string | null;
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
  preservedMcpServerNames?: readonly string[];
  retiredProviderIds?: readonly string[];
  restoreDecisionModelSnapshot?: boolean;
};

type SyncOpenClawConfigResult = {
  success: boolean;
  changed: boolean;
  configSynced: boolean;
  /** Default preference persistence is independent of runtime application evidence. */
  modelDefaultsApplicationPending?: true;
  gatewayRestartDeferred?: true;
  hostPolicyVerified?: boolean;
  builtinCredentialSessionId?: string;
  status?: OpenClawEngineStatus;
  error?: string;
};

type PendingCredentialReload = {
  authSessionId: string | null;
  authReason?: typeof BuiltinModelSyncReason.AuthLogin | typeof BuiltinModelSyncReason.AuthLogout;
  needsSecretsReload: boolean;
  builtinPublication?: OpenClawConfigPublication;
  recoveryUsed: boolean;
  configApplication?: {
    reloadGeneration: number;
    processGeneration: number;
    lifecycleGeneration: number;
    requiresHardRestart: boolean;
    nativeRestartRequested?: boolean;
    publication?: OpenClawConfigPublication;
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
  requestGateway?: OpenClawConfigSyncServiceDeps['requestGateway'];
};

type ExecutionAdmissionOptions = {
  prepareComputerForSend?: boolean;
};

export type OpenClawConfigMutationContext = {
  syncConfig: (options: SyncOpenClawConfigOptions) => Promise<SyncOpenClawConfigResult>;
  suspendNativeMcpData: (pluginIds: readonly string[], isCurrent: () => boolean) => Promise<boolean>;
  restoreNativeMcpData: (pluginIds: readonly string[], isCurrent: () => boolean) => Promise<boolean>;
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

type DeferredGatewayRestart = {
  reason: string;
  targetProcessGeneration: number;
  ownership?: ConfigApplicationOwnership;
  isReloadFallbackCurrent?: () => boolean;
  timer: ReturnType<typeof setInterval>;
};

const FALLBACK_EXEC_APPROVAL_FIELDS = {
  // OpenClaw ask/auto deliberately share this host floor. The native session
  // mode remains intact and decides whether the automatic reviewer is enabled.
  security: 'allowlist',
  ask: 'on-miss',
  askFallback: 'deny',
} as const;

type ConfigSnapshot = {
  path?: unknown;
  valid?: unknown;
  hash?: unknown;
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

type NativeMcpDataConfigSnapshot = {
  valid?: boolean;
  configRevisionHash?: string;
  appliedConfigHash?: string;
  sourceConfig?: unknown;
  config?: unknown;
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
const NATIVE_MCP_DATA_HOT_RELOAD_TIMEOUT_MS = 90_000;

export type OpenClawConfigApplyMode = 'none' | 'native-reload' | 'hard-restart';

export const resolveOpenClawConfigApplyMode = (options: {
  gatewayPhase: OpenClawEngineStatus['phase'];
  configChanged: boolean;
  gatewayLaunchEnvVarsChanged: boolean;
}): OpenClawConfigApplyMode => {
  if (options.gatewayPhase !== 'running' && options.gatewayPhase !== 'starting') {
    return 'none';
  }
  if (options.gatewayLaunchEnvVarsChanged) {
    return 'hard-restart';
  }
  if (options.gatewayPhase === 'starting' && options.configChanged) {
    return 'hard-restart';
  }
  return options.gatewayPhase === 'running' && options.configChanged
    ? 'native-reload'
    : 'none';
};

const isBuiltinModelAuthSync = (reason: string): reason is NonNullable<PendingCredentialReload['authReason']> =>
  reason === BuiltinModelSyncReason.AuthLogin || reason === BuiltinModelSyncReason.AuthLogout;

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
  private nativeMcpDataBindings: readonly NativeMcpDataBinding[] = [];
  private readonly deps: OpenClawConfigSyncServiceDeps;
  private readonly computerHostPreparation = new ComputerHostPreparation();
  private configSync: OpenClawConfigSync | null = null;
  private deferredRestart: DeferredGatewayRestart | null = null;
  private deferredRestartCheckInProgress = false;
  private syncTail: Promise<void> = Promise.resolve();
  private readonly pendingRetiredProviderIds = new Set<string>();
  private orphanedAuthProfilesReconciled = false;
  private pendingCredentialReload: PendingCredentialReload | null = null;
  private builtinConfigPublication: {
    authSessionId: string;
    publication: OpenClawConfigPublication;
  } | null = null;

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
    if (options.reason === BuiltinModelSyncReason.AuthLogin) {
      const getAuthOwnerId = this.deps.getModelAuthSessionOwnerId ?? this.deps.getModelAuthSessionId;
      const authOwnerId = getAuthOwnerId?.() ?? null;
      return this.enqueueSyncOperation(() =>
        this.syncConfigExclusive(options, () => (getAuthOwnerId?.() ?? null) === authOwnerId));
    }
    return this.enqueueSyncOperation(() => this.syncConfigExclusive(options));
  }

  reloadBuiltinModelCredential(): Promise<SyncOpenClawConfigResult> {
    const authSessionId = this.deps.getModelAuthSessionId?.();
    return this.enqueueSyncOperation(async () => {
      const options = { reason: BuiltinModelSyncReason.AuthLogin };
      const unconfirmed = () => this.unconfirmedCredentialApplication(true);
      const sessionIsCurrent = () => !!authSessionId && this.deps.getModelAuthSessionId?.() === authSessionId;
      if (!sessionIsCurrent() || !authSessionId) return unconfirmed();
      const fallback = () => this.syncConfigExclusive(options, sessionIsCurrent);
      const manager = this.deps.getOpenClawEngineManager();
      const published = this.builtinConfigPublication;
      if (!published || published.authSessionId !== authSessionId ||
          manager.getStatus().phase !== EnginePhase.Running ||
          this.pendingCredentialReload || this.deferredRestart || this.pendingRetiredProviderIds.size > 0 ||
          manager.hasPendingGatewayLaunchEnvironmentChanges()) {
        return fallback();
      }

      const { publication } = published;
      const processGeneration = manager.getGatewayProcessGeneration();
      const lifecycleGeneration = manager.getGatewayLifecycleGeneration();
      const isCurrent = () => sessionIsCurrent() &&
        this.deps.getOpenClawEngineManager() === manager &&
        manager.getStatus().phase === EnginePhase.Running &&
        manager.getGatewayProcessGeneration() === processGeneration &&
        manager.getGatewayLifecycleGeneration() === lifecycleGeneration;
      const revision = await this.confirmConfigPublication(publication, isCurrent).catch((): undefined => undefined);
      if (!revision || !isCurrent() || !publication.isCurrent()) return fallback();

      const pending: PendingCredentialReload = {
        authSessionId, authReason: options.reason, needsSecretsReload: true, recoveryUsed: false,
        builtinPublication: publication,
      };
      this.pendingCredentialReload = pending;
      const reload = await this.applyPendingCredentialReload(options, false);
      if (reload) return reload;
      const ownership = this.getCredentialReloadOwnership(pending);
      if (!ownership) return unconfirmed();
      const result = await this.verifySuccessfulConfigApplication({
        success: true, changed: true, configSynced: true,
      }, { ownership, preserveGateway: true, credentialOnly: this.orphanedAuthProfilesReconciled });
      if (!result.success) return result;
      const appliedRevision = await this.confirmConfigPublication(publication, ownership.isCurrent)
        .catch((): undefined => undefined);
      if (appliedRevision !== revision ||
          !ownership.isCurrent()) return unconfirmed();
      this.pendingCredentialReload = null;
      return result;
    });
  }

  /** Reconcile managed data after native mutation. False means no file delta, not a runtime ACK. */
  syncNativeMcpDataAfterMutation(isMutationCurrent = () => true): Promise<boolean> {
    return this.enqueueSyncOperation(() =>
      this.syncNativeMcpDataExclusive(isMutationCurrent, {}));
  }

  private async syncNativeMcpDataExclusive(
    isMutationCurrent: () => boolean,
    operation: { suspend: readonly string[] } | { restore?: readonly string[] },
  ): Promise<boolean> {
    const suspending = 'suspend' in operation;
    const discover = this.deps.getNativeMcpDataBindings;
    if (!suspending && !discover) return false;
    const manager = this.deps.getOpenClawEngineManager();
    const configPath = manager.getConfigPath();
    const stateDirectory = manager.getStateDir();
    const phase = manager.getStatus().phase;
    const pid = manager.getGatewayProcessId();
    const processGeneration = manager.getGatewayProcessGeneration();
    const lifecycleGeneration = manager.getGatewayLifecycleGeneration();
    const client = this.deps.getGatewayClient();
    const unconfirmed = () => new Error('Plugin data configuration could not be confirmed.');
    const assertOwner = () => {
      if (!isMutationCurrent() || this.deps.getOpenClawEngineManager() !== manager ||
          manager.getConfigPath() !== configPath || manager.getStateDir() !== stateDirectory ||
          manager.getStatus().phase !== phase || manager.getGatewayProcessId() !== pid ||
          manager.getGatewayProcessGeneration() !== processGeneration ||
          manager.getGatewayLifecycleGeneration() !== lifecycleGeneration ||
          this.deps.getGatewayClient() !== client) throw unconfirmed();
    };
    assertOwner();
    const original = fs.readFileSync(configPath, 'utf8');
    const assertSource = () => {
      assertOwner();
      if (fs.readFileSync(configPath, 'utf8') !== original) throw unconfirmed();
    };
    const bindings = !suspending && discover ? await discover() : [];
    assertSource();
    const online = phase === EnginePhase.Running && pid !== null && pid > 0 ? client : null;
    const offline = phase !== EnginePhase.Starting && phase !== EnginePhase.Running &&
      pid === null && client === null;
    const missing = bindings.filter(binding => {
      try { nativeMcpDataDirectory(stateDirectory, binding.pluginId); return false; }
      catch { return true; }
    }).map(binding => binding.pluginId);
    if (missing.length) {
      if (!online && !offline) throw unconfirmed();
      await prepareNativeMcpData(stateDirectory, missing);
      assertSource();
    }
    let publication;
    try {
      publication = this.getConfigSync().planNativeMcpDataPublication(configPath, original,
        suspending ? { suspendOwners: new Set(operation.suspend) } :
          { bindings, restoreSuspendedOwners: new Set(operation.restore) });
    } catch (error) {
      if (!suspending) throw error;
      // Without a usable projection, let the native uninstall handle the package.
      console.warn('[OpenClaw] Managed MCP uninstall preparation could not read the owned projection');
      return false;
    }
    if (!publication) return false;
    if (!online && !offline) throw unconfirmed();
    if (!online || (!suspending && !publication.changed)) {
      publication.publish(assertOwner);
      return publication.changed;
    }
    const observedGeneration = manager.getGatewayConfigReloadGeneration();
    const before = await online.request<NativeMcpDataConfigSnapshot>('config.get', {}, { timeoutMs: 5_000 });
    assertSource();
    if (before.valid !== true || typeof before.configRevisionHash !== 'string' || !before.configRevisionHash)
      throw unconfirmed();
    if (suspending && !publication.changed && before.appliedConfigHash === before.configRevisionHash &&
        publication.matchesRuntimeConfig(before.sourceConfig ?? before.config)) return true;
    // A retry can encounter the same revision while its reload is already in progress.
    const reloadGeneration = publication.changed ? manager.getGatewayConfigReloadGeneration() :
      Math.max(0, observedGeneration - 1);
    publication.publish(assertOwner);
    const reloaded = await manager.waitForGatewayConfigReload(reloadGeneration, NATIVE_MCP_DATA_HOT_RELOAD_TIMEOUT_MS);
    assertOwner();
    if (!reloaded || !publication.isCurrent()) throw unconfirmed();
    const applied = await online.request<NativeMcpDataConfigSnapshot>('config.get', {}, { timeoutMs: 5_000 });
    assertOwner();
    if (!publication.isCurrent() || applied.valid !== true || !applied.configRevisionHash ||
        (publication.changed && applied.configRevisionHash === before.configRevisionHash) ||
        applied.appliedConfigHash !== applied.configRevisionHash ||
        !publication.matchesRuntimeConfig(applied.sourceConfig ?? applied.config)) throw unconfirmed();
    return true;
  }

  runConfigMutationExclusive<T>(
    operation: (context: OpenClawConfigMutationContext) => Promise<T>,
  ): Promise<T> {
    return this.enqueueSyncOperation(() =>
      operation({
        syncConfig: options => this.syncConfigExclusive(options),
        suspendNativeMcpData: (pluginIds, isCurrent) =>
          this.syncNativeMcpDataExclusive(isCurrent, { suspend: pluginIds }),
        restoreNativeMcpData: (pluginIds, isCurrent) =>
          this.syncNativeMcpDataExclusive(isCurrent, { restore: pluginIds }),
      }),
    );
  }

  restartGatewayWhenIdle(reason: string): Promise<OpenClawEngineStatus> {
    return this.enqueueSyncOperation(() => this.restartGatewayAfterExclusiveMutation(reason));
  }

  async restartGatewayAfterExclusiveMutation(
    reason: string,
    options?: { networkPolicyChanged?: true },
  ): Promise<OpenClawEngineStatus & { deferred?: true }> {
    const engineManager = this.deps.getOpenClawEngineManager();
    const restartReason = options?.networkPolicyChanged &&
      !engineManager.canReuseGatewayNetworkEnvironment()
      ? 'extension-network-policy-change' : reason;
    if (restartReason.startsWith('extension-') && restartReason !== 'extension-network-policy-change') {
      const nativeRestart = await requestGatewayConfigRestart(
        engineManager, this.deps.requestGateway, restartReason,
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
    const result = await this.restartGatewayOrDefer(restartReason, true, true);
    const status = result.status ?? engineManager.getStatus();
    return result.gatewayRestartDeferred ? { ...status, deferred: true } : status;
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
    isAuthRequestCurrent?: () => boolean,
  ): Promise<SyncOpenClawConfigResult> {
    if (isModelDefaultsSyncReason(options.reason)) {
      // An explicit mutation context already owns the queue until it returns.
      // Confirm here rather than recursively queuing behind that same owner.
      return (await this.beginModelDefaultsSync(options, true)).observation;
    }
    if (isAuthRequestCurrent?.() === false) return this.unconfirmedCredentialApplication(true);
    let result = await this.applyConfigExclusive(options, isAuthRequestCurrent);
    if (result.success && this.deps.getModelAuthSessionId &&
        (options.reason === 'startup' || options.reason === 'startup-history') &&
        (this.deps.getModelAuthSessionId?.() ?? null) === null) {
      this.pendingRetiredProviderIds.add(OpenClawProviderId.BuiltinModels);
      if (result.builtinCredentialSessionId) {
        // Expiry can cross the async boundary after persistence. Withdraw only
        // that built-in projection; the rest of startup config is already published.
        const withdrawal = await this.applyLogoutExclusive(true);
        this.builtinConfigPublication = null;
        result = { ...withdrawal, changed: result.changed || withdrawal.changed };
      }
    }
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
        options.preservedMcpServerNames?.length ||
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
    if (!result.ok)
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
        if (changed && !await manager.waitForGatewayConfigReload(
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
    isAuthRequestCurrent?: () => boolean,
  ): Promise<SyncOpenClawConfigResult> {
    console.log(`[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason})`);
    if (options.reason === BuiltinModelSyncReason.AuthLogout) {
      return this.applyLogoutExclusive();
    }
    const authReason = options.reason === BuiltinModelSyncReason.AuthLogin ? options.reason : undefined;
    const unconfirmed = (result: SyncOpenClawConfigResult) => this.unconfirmedConfigApplication(result, Boolean(authReason));
    const failApplication = (result: SyncOpenClawConfigResult, error: string) => authReason
      ? { ...unconfirmed(result), error }
      : this.failClosedConfigApplication(result, error);
    const unapplied = () => unconfirmed({ success: false, changed: false, configSynced: false });
    if (authReason && this.pendingCredentialReload?.authReason === BuiltinModelSyncReason.AuthLogout) {
      this.pendingCredentialReload = null;
    }

    for (const providerId of options.retiredProviderIds ?? []) {
      const normalized = providerId.trim().toLowerCase();
      if (normalized) this.pendingRetiredProviderIds.add(normalized);
    }

    const engineManager = this.deps.getOpenClawEngineManager();
    let extensionMcpNames: ReadonlySet<string>;
    try {
      extensionMcpNames = (await this.deps.getExtensionMcpServerNames?.()) ?? new Set<string>();
    } catch {
      return failApplication(
        { success: false, changed: false, configSynced: false },
        'Native extension MCP ownership could not be read; configuration was preserved.',
      );
    }
    if (isAuthRequestCurrent?.() === false) return unapplied();
    try {
      const bindings = await this.deps.getNativeMcpDataBindings?.() ?? [];
      if (isAuthRequestCurrent?.() === false) return unapplied();
      const missing = bindings.filter(binding => {
        try { nativeMcpDataDirectory(engineManager.getStateDir(), binding.pluginId); return false; }
        catch { return true; }
      }).map(binding => binding.pluginId);
      if (missing.length) await prepareNativeMcpData(engineManager.getStateDir(), missing);
      this.nativeMcpDataBindings = bindings;
    } catch (error) {
      return { success: false, changed: false, configSynced: false,
        error: error instanceof Error ? error.message : 'Plugin data is unavailable.' };
    }
    if (isAuthRequestCurrent?.() === false) return unapplied();
    if (options.discoverExternalMcpServers !== false) {
      try {
        const discovered = discoverOpenClawManagedMcpServers(
          engineManager.getConfigPath(),
          this.deps.getMcpStore(),
          new Set([...extensionMcpNames, ...ownedNativeMcpDataServerNames(engineManager.getConfigPath(), engineManager.getStateDir())]),
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
    if (engineManager.getStatus().phase === EnginePhase.Starting) {
      if (authReason) await engineManager.waitForGatewayStartInProgress();
      else await engineManager.startGateway();
      const status = engineManager.getStatus();
      // A bounded observation may leave the native restart owner pending.
      // Preserve its startup snapshot and the unapplied configuration obligation.
      if (status.phase === EnginePhase.Starting) return unconfirmed({
        success: false, changed: false, configSynced: false, status,
      });
    }
    const statusBeforeSync = engineManager.getStatus();
    const preflightProcessGeneration = engineManager.getGatewayProcessGeneration();
    const preflightLifecycleGeneration = engineManager.getGatewayLifecycleGeneration();
    // Preflight config work belongs to the login even while its token expires.
    const getAuthOwnerId = this.deps.getModelAuthSessionOwnerId ?? this.deps.getModelAuthSessionId;
    const preflightAuthOwnerId = getAuthOwnerId?.() ?? null;
    const preflightOwnsProcess = (): boolean =>
      this.deps.getOpenClawEngineManager() === engineManager &&
      engineManager.getGatewayProcessGeneration() === preflightProcessGeneration &&
      (getAuthOwnerId?.() ?? null) === preflightAuthOwnerId &&
      isAuthRequestCurrent?.() !== false;
    const preflightIsCurrent = (): boolean =>
      preflightOwnsProcess() &&
      engineManager.getStatus().phase === statusBeforeSync.phase &&
      engineManager.getGatewayLifecycleGeneration() === preflightLifecycleGeneration;
    const preflightUnconfirmed = (): SyncOpenClawConfigResult => unconfirmed({
      success: false, changed: false, configSynced: false,
    });
    if (!preflightIsCurrent()) return preflightUnconfirmed();
    const expectedExecutionMode = this.deps.getCoworkStore().getConfig().executionMode;
    if (expectedExecutionMode === 'sandbox') {
      const sandboxStatus = await this.deps.getWindowsSandboxStatus();
      if (!preflightIsCurrent()) return preflightUnconfirmed();
      if (!sandboxStatus.ready) {
        return failApplication(
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
          return failApplication(
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
        return failApplication(
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
    const configSync = this.getConfigSync();
    const workspaceInventory = await configSync.prepareWorkspaceExtensionInventory();
    if (!preflightIsCurrent()) return preflightUnconfirmed();
    const reloadGeneration = engineManager.getGatewayConfigReloadGeneration();
    const processGenerationBeforeSync = engineManager.getGatewayProcessGeneration();
    const lifecycleGenerationBeforeSync = engineManager.getGatewayLifecycleGeneration();
    const retiredMcpNames = new Set(options.retiredMcpServerNames);
    const preservedMcpNames = options.preservedMcpServerNames?.length
      ? new Set([...extensionMcpNames, ...options.preservedMcpServerNames])
      : extensionMcpNames;
    let syncResult = configSync.sync(options.reason, preservedMcpNames, retiredMcpNames, {
      ...(options.restoreDecisionModelSnapshot === true ? { restoreDecisionModelSnapshot: true } : {}),
      workspaceInventory,
    });
    const currentAuthSessionId = () => this.deps.getModelAuthSessionId?.() ?? null;
    if (syncResult.ok && syncResult.builtinCredentialSessionId && currentAuthSessionId() === null &&
      preflightIsCurrent() && syncResult.publication?.isCurrent() !== false) {
      // Withdraw only the expired built-in route from the configuration just published.
      const withdrawal = configSync.sync(BuiltinModelSyncReason.AuthLogout, undefined, undefined, { allowExpiredBuiltinSnapshot: true });
      syncResult = {
        ...withdrawal,
        changed: syncResult.changed || withdrawal.changed,
        configChanged: syncResult.configChanged || withdrawal.configChanged,
        secretsChanged: syncResult.secretsChanged || withdrawal.secretsChanged,
      };
    }
    if (!syncResult.ok) {
      return failApplication({
        success: false,
        changed: false,
        configSynced: false,
        error: syncResult.error,
      }, `OpenClaw config sync failed: ${syncResult.error || 'unknown error'}`);
    }

    const authSessionId = currentAuthSessionId();
    if (!preflightIsCurrent() ||
      (syncResult.builtinCredentialSessionId && syncResult.builtinCredentialSessionId !== authSessionId)) {
      return preflightUnconfirmed();
    }
    const { builtinCredentialSessionId, publication } = syncResult;
    this.builtinConfigPublication = builtinCredentialSessionId && publication
      ? { authSessionId: builtinCredentialSessionId, publication }
      : null;
    const publicationAuthIsCurrent = () => (!syncResult.builtinCredentialSessionId && !authReason) ||
      currentAuthSessionId() === authSessionId;
    const publicationOwnsProcess = () => preflightOwnsProcess() && publicationAuthIsCurrent();
    const publicationIsCurrent = () => preflightIsCurrent() && publicationAuthIsCurrent();

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
    if (this.pendingCredentialReload?.authSessionId !== authSessionId) this.pendingCredentialReload = null;
    if (authReason && this.pendingCredentialReload?.authReason &&
      (statusBeforeSync.phase === EnginePhase.Ready || statusBeforeSync.phase === EnginePhase.Error) &&
      engineManager.getGatewayProcessId() === null) {
      // The stopped process can no longer be using old settings. Its next
      // start will read the configuration we just persisted.
      this.pendingCredentialReload = null;
    }
    // Background renewal publishes before entering this queue. Identical bytes
    // here therefore do not establish that the running Gateway loaded them.
    const authCredentialsPublished = authReason === BuiltinModelSyncReason.AuthLogin && authSessionId !== null;
    const needsSecretsReload = syncResult.secretsChanged || authCredentialsPublished;
    if (statusBeforeSync.phase === EnginePhase.Running &&
      (needsSecretsReload || (authReason && (syncResult.configChanged || gatewayLaunchEnvVarsChanged)))) {
      this.pendingCredentialReload ??= { authSessionId, authReason, needsSecretsReload, recoveryUsed: false };
      if (authReason) this.pendingCredentialReload.authReason = authReason;
      this.pendingCredentialReload.needsSecretsReload ||= needsSecretsReload;
      this.pendingCredentialReload.acknowledged = undefined;
    }
    const pending = this.pendingCredentialReload;
    if (pending && (syncResult.configChanged || gatewayLaunchEnvVarsChanged)) {
      pending.builtinPublication = undefined;
      const previousApplication = pending.configApplication;
      pending.acknowledged = undefined;
      pending.configApplication = {
        reloadGeneration, processGeneration: processGenerationBeforeSync,
        lifecycleGeneration: lifecycleGenerationBeforeSync,
        publication: syncResult.publication,
        requiresHardRestart: gatewayLaunchEnvVarsChanged || Boolean(previousApplication?.requiresHardRestart &&
          (previousApplication.processGeneration === processGenerationBeforeSync ||
            engineManager.hasPendingGatewayLaunchEnvironmentChanges())),
        nativeRestartRequested: previousApplication?.nativeRestartRequested &&
          previousApplication.processGeneration === processGenerationBeforeSync &&
          previousApplication.lifecycleGeneration === lifecycleGenerationBeforeSync,
      };
    }
    if (pending?.authReason === BuiltinModelSyncReason.AuthLogin && syncResult.builtinCredentialSessionId &&
        syncResult.builtinCredentialSessionId === pending.authSessionId && syncResult.publication) {
      pending.builtinPublication = syncResult.publication;
    }
    const owesConfigApplication = pending?.configApplication !== undefined;
    const recoverExpiredSettings = async (result: SyncOpenClawConfigResult): Promise<SyncOpenClawConfigResult> => {
      if (result.success || authReason || !authSessionId || currentAuthSessionId() !== null ||
        !preflightIsCurrent() || syncResult.publication?.isCurrent() === false ||
        gatewayLaunchEnvVarsChanged || pending?.configApplication?.requiresHardRestart) return result;
      const withdrawal = await this.applyLogoutExclusive(true);
      if (!withdrawal.success) return withdrawal;
      const stillRevoked = () => currentAuthSessionId() === null;
      return this.verifySuccessfulConfigApplication({ ...withdrawal, changed: withdrawal.changed || syncResult.changed }, {
        ownership: {
          ownsProcess: () => preflightOwnsProcess() && stillRevoked(),
          isCurrent: () => preflightIsCurrent() && stillRevoked(),
        },
        preserveGateway: true,
      });
    };
    if (pending) {
      if (pending.builtinPublication && !pending.configApplication) {
        const revision = await this.confirmConfigPublication(pending.builtinPublication, publicationIsCurrent)
          .catch((): undefined => undefined);
        if (!revision || !publicationIsCurrent()) return recoverExpiredSettings(preflightUnconfirmed());
      }
      const restartForIndependentConfigChange = !authReason && (gatewayLaunchEnvVarsChanged ||
        (pending.configApplication?.requiresHardRestart === true && engineManager.hasPendingGatewayLaunchEnvironmentChanges()));
      const credentialsApplied = await this.applyPendingCredentialReload(options, restartForIndependentConfigChange);
      if (credentialsApplied) return recoverExpiredSettings(credentialsApplied);
    }

    const applyMode = owesConfigApplication ? 'none' : resolveOpenClawConfigApplyMode({
      gatewayPhase: statusBeforeSync.phase,
      configChanged: syncResult.configChanged,
      gatewayLaunchEnvVarsChanged,
    });
    const authOwnership: ConfigApplicationOwnership | undefined = authReason &&
      statusBeforeSync.phase === EnginePhase.Running ? {
        ownsProcess: publicationOwnsProcess,
        isCurrent: publicationIsCurrent,
      } : undefined;
    const verificationOptions = {
      ownership: this.getCredentialReloadOwnership(this.pendingCredentialReload) ?? authOwnership,
      preserveGateway: Boolean(authReason || pending?.authReason),
    };
    const ownership = verificationOptions.ownership;
    const unconfirmedApplication = (): SyncOpenClawConfigResult => unconfirmed({
      success: false, changed: syncResult.changed, configSynced: false,
    });
    const stopOwnership = ownership ? { isCurrentOwner: ownership.ownsProcess } : undefined;
    if (applyMode === 'none') {
      const result = await this.verifySuccessfulConfigApplication(
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
      const verified = await recoverExpiredSettings(result);
      const startup = options.reason === 'startup' || options.reason === 'startup-history';
      if (startup && verified.success && !verified.gatewayRestartDeferred && builtinCredentialSessionId &&
          publication?.isCurrent()) return { ...verified, builtinCredentialSessionId };
      return verified;
    }

    if (applyMode === 'native-reload') {
      const captureReloadedOwnership = (): ConfigApplicationOwnership => {
        if (ownership) return ownership;
        // A native restart can advance the lifecycle of the same child.
        const lifecycle = engineManager.getGatewayLifecycleGeneration();
        const isCurrent = () => publicationOwnsProcess() && engineManager.getStatus().phase === EnginePhase.Running &&
          engineManager.getGatewayLifecycleGeneration() === lifecycle;
        return {
          ownsProcess: publicationOwnsProcess,
          isCurrent,
          // Keep the adapter's readiness/automation-policy check before dispatch.
          requestGateway: async <T>(method: string, params?: unknown) => {
            const result = await this.requestForCurrentConfig<T>(isCurrent, method, params);
            if (!isCurrent()) throw new Error('Configuration application was superseded.');
            return result;
          },
        };
      };
      const reloaded = await this.waitForConfigApplication(
        reloadGeneration, syncResult.publication, publicationIsCurrent,
        syncResult.secretsChanged ? resolveManagedCredentialReloadTimeoutMs() : undefined,
      );
      if (!publicationOwnsProcess() || (ownership && !ownership.isCurrent())) return recoverExpiredSettings(unconfirmedApplication());
      if (reloaded) {
        const result = await this.verifySuccessfulConfigApplication(
          {
            success: true,
            changed: syncResult.changed,
            configSynced: true,
            status: engineManager.getStatus(),
          },
          { ...verificationOptions, ownership: captureReloadedOwnership() },
        );
        return recoverExpiredSettings(result);
      }
      if (!publicationIsCurrent()) return recoverExpiredSettings(unconfirmedApplication());
      if (options.restartGatewayIfRunning === false) {
        return this.failClosedConfigApplication({
          success: false,
          changed: syncResult.changed,
          configSynced: true,
          status: engineManager.getStatus(),
        }, 'OpenClaw config was written, but native reload did not complete.',
        stopOwnership ?? { isCurrentOwner: publicationOwnsProcess });
      }
      console.warn(
        `[OpenClaw] syncOpenClawConfig: native reload did not complete; requesting an in-process restart (reason: ${options.reason})`,
      );
      const requestRestart: OpenClawConfigSyncServiceDeps['requestGateway'] = <T>(method: string, params?: unknown) =>
        ownership
          ? this.requestOwnedGateway<T>(ownership.isCurrent, method, params)
          : this.requestForCurrentConfig<T>(publicationIsCurrent, method, params);
      const nativeRestart = await requestGatewayConfigRestart(engineManager, requestRestart, options.reason);
      if (!publicationOwnsProcess() ||
          (ownership && (!ownership.isCurrent() || nativeRestart === GatewayConfigRestartOutcome.Pending))) {
        return unconfirmedApplication();
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
          const reloadedOwnership = captureReloadedOwnership();
          const restored = await this.restoreGatewayBridgeOrFailClosed(result, reloadedOwnership);
          return restored.success
            ? this.verifySuccessfulConfigApplication(restored, { ...verificationOptions, ownership: reloadedOwnership })
            : restored;
        }
        return result;
      }
      // A refusal from the previous lifecycle cannot authorize a cold fallback.
      if (!publicationIsCurrent()) return unconfirmedApplication();
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
      applyMode === 'native-reload' ? publicationIsCurrent : undefined,
    );
    return restartResult.success
      ? this.verifySuccessfulConfigApplication(restartResult, verificationOptions)
      : restartResult;
  }

  private async applyLogoutExclusive(allowExpiredBuiltinSnapshot?: true): Promise<SyncOpenClawConfigResult> {
    const reason = BuiltinModelSyncReason.AuthLogout;
    const credentialIsRevoked = () => (this.deps.getModelAuthSessionId?.() ?? null) === null;
    const unconfirmed = (changed: boolean, error?: string): SyncOpenClawConfigResult => ({
      ...this.unconfirmedConfigApplication({ success: false, changed, configSynced: false }, true),
      ...(error && { error }),
    });
    // Expiry cleanup can be queued before the same login recovers.
    if (!credentialIsRevoked()) return unconfirmed(false);

    const manager = this.deps.getOpenClawEngineManager();
    const { phase } = manager.getStatus();
    const offline = (phase === EnginePhase.Ready || phase === EnginePhase.Error) &&
      manager.getGatewayProcessId() === null;
    const processGeneration = manager.getGatewayProcessGeneration();
    const lifecycleGeneration = manager.getGatewayLifecycleGeneration();
    const reloadGeneration = manager.getGatewayConfigReloadGeneration();

    if (offline || this.pendingCredentialReload?.authReason !== reason) {
      this.pendingCredentialReload = null;
    }
    const provider = OpenClawProviderId.BuiltinModels;
    this.pendingRetiredProviderIds.add(provider);
    const sync = allowExpiredBuiltinSnapshot
      ? this.getConfigSync().sync(reason, undefined, undefined, { allowExpiredBuiltinSnapshot })
      : this.getConfigSync().sync(reason);
    if (!sync.ok) return unconfirmed(sync.changed ?? false, sync.error);

    const result = { success: true, changed: sync.changed, configSynced: true };
    if (offline) return result;
    if (sync.configMissing) return unconfirmed(sync.changed);

    // Preserve the obligation to observe this publication across a reload timeout.
    if (sync.configChanged || sync.secretsChanged) {
      const pending = this.pendingCredentialReload ??= {
        authSessionId: null, authReason: reason, needsSecretsReload: false, recoveryUsed: false,
      };
      pending.acknowledged = undefined;
      if (sync.configChanged) {
        pending.configApplication = {
          reloadGeneration, processGeneration, lifecycleGeneration,
          publication: sync.publication, requiresHardRestart: false,
        };
      } else {
        pending.needsSecretsReload = true;
      }
    }
    if (this.pendingCredentialReload) {
      const unconfirmedReload = await this.applyPendingCredentialReload({ reason }, false);
      if (unconfirmedReload) return unconfirmedReload;
    }

    const isCurrent = this.getCredentialReloadOwnership(this.pendingCredentialReload)?.isCurrent ?? (() =>
      credentialIsRevoked() && manager.getStatus().phase === EnginePhase.Running &&
      manager.getGatewayProcessGeneration() === processGeneration &&
      manager.getGatewayLifecycleGeneration() === lifecycleGeneration);
    const request = <T>(method: string, params?: unknown) =>
      this.requestOwnedGateway<T>(isCurrent, method, params);
    try {
      const snapshot = await request<ConfigSnapshot>('config.get');
      const revision = snapshot.configRevisionHash;
      if (snapshot.valid !== true || snapshot.path !== sync.configPath || !snapshot.config ||
          typeof revision !== 'string' || !revision.trim() || snapshot.appliedConfigHash !== revision ||
          Object.hasOwn(snapshot.config.models?.providers ?? {}, provider)) {
        return unconfirmed(sync.changed);
      }
      await this.cleanupRetiredProviderAuthProfiles(snapshot, [provider], request);
      return isCurrent() && !this.pendingRetiredProviderIds.has(provider) ? result : unconfirmed(sync.changed);
    } catch {
      return unconfirmed(sync.changed);
    }
  }

  private unconfirmedConfigApplication(result: SyncOpenClawConfigResult, builtinModelAuth = false): SyncOpenClawConfigResult {
    return {
      ...result, success: false, configSynced: false,
      status: this.deps.getOpenClawEngineManager().getStatus(),
      error: t(builtinModelAuth ? 'builtinModelRuntimeSyncUnconfirmed' : 'engineConfigApplicationUnconfirmed'),
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
      this.deps.getOpenClawEngineManager() === manager &&
      (this.deps.getModelAuthSessionId?.() ?? null) === pending.authSessionId &&
      manager.getGatewayProcessGeneration() === identity.processGeneration;
    return {
      ownsProcess,
      isCurrent: () => ownsProcess() && manager.getStatus().phase === 'running' &&
        manager.getGatewayLifecycleGeneration() === identity.lifecycleGeneration &&
        pending.builtinPublication?.isCurrent() !== false,
    };
  }

  private requestForCurrentConfig<T>(
    isCurrent: () => boolean,
    method: string,
    params?: unknown,
  ): Promise<T> {
    return this.deps.requestGateway<T>(method, params, {
      assertBeforeSend: () => {
        if (!isCurrent()) throw new Error('Configuration application was superseded.');
      },
    });
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

  private waitForConfigApplication(
    generation: number,
    publication: OpenClawConfigPublication | undefined,
    isCurrent: () => boolean,
    timeoutMs?: number,
  ): Promise<boolean> {
    const manager = this.deps.getOpenClawEngineManager();
    if (!publication) {
      return timeoutMs === undefined ? manager.waitForGatewayConfigReload(generation) :
        manager.waitForGatewayConfigReload(generation, timeoutMs);
    }
    return manager.waitForGatewayConfigReload(generation, timeoutMs,
      async () => Boolean(await this.confirmConfigPublication(publication, isCurrent)));
  }

  private async confirmConfigPublication(
    publication: OpenClawConfigPublication,
    isCurrent: () => boolean,
  ): Promise<string | undefined> {
    const client = this.deps.getGatewayClient();
    const stillOwnsPublication = () => isCurrent() && client === this.deps.getGatewayClient() && publication.isCurrent();
    if (!client || !stillOwnsPublication()) return;
    const options = { timeoutMs: 5_000 };
    const snapshot = await client.request<ConfigSnapshot>('config.get', {}, options);
    if (!stillOwnsPublication() || snapshot.path !== publication.path || snapshot.valid !== true ||
      typeof snapshot.configRevisionHash !== 'string' || snapshot.configRevisionHash.trim() === '' ||
      snapshot.configRevisionHash !== snapshot.appliedConfigHash ||
      typeof snapshot.hash !== 'string' || snapshot.hash.trim() === '') return;
    // Native hashes are opaque and config.get can be cached. An empty guarded
    // patch checks the raw revision against a fresh read and performs no write.
    const confirmation = await client.request<{ ok?: boolean; noop?: boolean; path?: string; changedPaths?: unknown }>(
      'config.patch', { raw: '{}', baseHash: snapshot.hash }, options,
    );
    if (stillOwnsPublication() && confirmation.ok === true && confirmation.noop === true &&
      confirmation.path === publication.path && Array.isArray(confirmation.changedPaths) &&
      confirmation.changedPaths.length === 0) return snapshot.configRevisionHash;
  }

  private async applyPendingCredentialConfig(
    pending: PendingCredentialReload,
    options: SyncOpenClawConfigOptions,
    restartForIndependentConfigChange: boolean,
  ): Promise<SyncOpenClawConfigResult | null> {
    const application = pending.configApplication;
    if (!application) return null;
    const manager = this.deps.getOpenClawEngineManager();
    const identity = {
      processGeneration: manager.getGatewayProcessGeneration(),
      lifecycleGeneration: manager.getGatewayLifecycleGeneration(),
    };
    const ownership = this.createCredentialApplicationOwnership(pending, identity);
    const preserveGateway = Boolean(pending.authReason || isBuiltinModelAuthSync(options.reason));
    const unconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedCredentialApplication(preserveGateway);
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
        // An unrelated config mutation can still own its required cold restart.
        if (preserveGateway && !restartForIndependentConfigChange) return unconfirmed();
        if (options.restartGatewayIfRunning === false) {
          return this.failClosedConfigApplication(unconfirmed(), 'OpenClaw credential config requires a Gateway restart.', {
            isCurrentOwner: ownership.ownsProcess,
          });
        }
        await this.restartGatewayOrDefer(options.reason, true, true, ownership);
        return unconfirmed();
      }
      const timeoutMs = pending.needsSecretsReload ? resolveManagedCredentialReloadTimeoutMs() : undefined;
      const applied = await this.waitForConfigApplication(
        application.reloadGeneration, application.publication, ownership.isCurrent, timeoutMs,
      );
      if (!ownership.isCurrent()) return unconfirmed();
      if (!applied) {
        if (preserveGateway) return unconfirmed();
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
    if (pending.needsSecretsReload) {
      // secrets.reload reads the loaded source config. Verify its revision
      // once the watcher has applied a change or a new runtime is ready.
      try {
        const snapshot = await requestGateway<ConfigSnapshot>('config.get');
        if (typeof snapshot.configRevisionHash !== 'string' || !snapshot.configRevisionHash.trim() ||
          snapshot.configRevisionHash !== snapshot.appliedConfigHash) return unconfirmed();
      } catch {
        return unconfirmed();
      }
    }
    if (!ownership.isCurrent()) return unconfirmed();
    pending.configApplication = undefined;
    return null;
  }

  private async applyPendingCredentialReload(
    options: SyncOpenClawConfigOptions,
    restartForIndependentConfigChange: boolean,
  ): Promise<SyncOpenClawConfigResult | null> {
    const { reason } = options;
    const pending = this.pendingCredentialReload;
    if (!pending) return null;
    const manager = this.deps.getOpenClawEngineManager();
    const authIsCurrent = (): boolean => (this.deps.getModelAuthSessionId?.() ?? null) === pending.authSessionId;
    const preserveGateway = Boolean(pending.authReason || isBuiltinModelAuthSync(reason));
    const unconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedCredentialApplication(preserveGateway);
    let initializeExecPolicy = false;
    if (manager.getStatus().phase !== 'running') {
      const stopped = pending.stopped;
      const status = manager.getStatus();
      if (preserveGateway || !stopped || pending.recoveryUsed || !authIsCurrent() || status.phase !== 'error' ||
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
        writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.RecoveryFailed, {
          reason: BuiltinModelAuthDiagnosticReason.RecoveryFailed,
          syncReason: reason === BuiltinModelSyncReason.AuthLogin || reason === BuiltinModelSyncReason.AuthLogout ? reason : 'other',
          errorCode: getBuiltinModelAuthErrorCode(error),
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
    const configurationApplied = await this.applyPendingCredentialConfig(pending, options, restartForIndependentConfigChange);
    if (configurationApplied) return configurationApplied;
    if (!isCurrent()) return unconfirmed();
    if (!pending.needsSecretsReload) {
      pending.acknowledged = { processGeneration, lifecycleGeneration };
      return null;
    }
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
      if (preserveGateway || !isCurrent()) return unconfirmed();
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

  private unconfirmedCredentialApplication(preserveGateway: boolean): SyncOpenClawConfigResult {
    const result = { success: false, changed: true, configSynced: false };
    return this.unconfirmedConfigApplication(result, preserveGateway);
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
      if (this.deps.getModelAuthSessionId &&
          (current.phase === EnginePhase.Ready || current.phase === EnginePhase.Error) &&
          engineManager.getGatewayProcessId() === null) {
        const withdrawal = this.getConfigSync().withdrawStaleBuiltinBeforeLaunch(this.deps.getModelAuthSessionId());
        if (withdrawal) {
          if (!withdrawal.ok) throw new Error(withdrawal.error || t('enginePreparationFailed'));
          this.pendingRetiredProviderIds.add(OpenClawProviderId.BuiltinModels);
          this.builtinConfigPublication = null;
        }
      }
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
      executionAdmission?: boolean;
      initializeExecPolicy?: boolean;
      credentialOnly?: boolean;
      prepareComputerForSend?: boolean;
      ownership?: ConfigApplicationOwnership;
      preserveGateway?: boolean;
    } = {},
  ): Promise<SyncOpenClawConfigResult> {
    const engineManager = this.deps.getOpenClawEngineManager();
    const unconfirmedOwnership = (): SyncOpenClawConfigResult =>
      this.unconfirmedConfigApplication(result, options.preserveGateway);
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
    const requestGateway = ownership?.requestGateway ?? (ownership
      ? <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(ownership.isCurrent, method, params)
      : this.deps.requestGateway);
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
        if (options.executionAdmission || options.credentialOnly) {
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
        await this.syncManagedSessionModelsViaGateway(runtimeConfigResult.snapshot, requestGateway);
        const afterModels = supersededAdmission();
        if (afterModels) return afterModels;
        await this.discoverOrphanedManagedAuthProfiles(runtimeConfigResult.snapshot, requestGateway);
        const afterDiscovery = supersededAdmission();
        if (afterDiscovery) return afterDiscovery;
        await this.cleanupRetiredProviderAuthProfiles(
          runtimeConfigResult.snapshot,
          this.pendingRetiredProviderIds,
          requestGateway,
        );
        const afterCleanup = supersededAdmission();
        if (afterCleanup) return afterCleanup;
        return { ...result, hostPolicyVerified: true };
      }

      const error = 'The OpenClaw host execution policy could not be verified.';
      if (options.preserveGateway) return unconfirmedOwnership();
      return this.failClosedConfigApplication(result, error, stopOwnership);
    } catch (error) {
      const superseded = supersededAdmission();
      if (superseded) return superseded;
      if (options.preserveGateway) return unconfirmedOwnership();
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
    providerIds: Iterable<string>,
    requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = this.deps.requestGateway,
  ): Promise<void> {
    const configuredProviders = new Set(
      Object.keys(snapshot.config?.models?.providers ?? {}).map(provider =>
        provider.trim().toLowerCase(),
      ),
    );
    for (const provider of providerIds) {
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
    isReloadFallbackCurrent?: () => boolean,
  ): Promise<SyncOpenClawConfigResult> {
    const requiresImmediateRestart =
      reason === 'browser-mode-change' || reason === 'browser-mode-rollback';
    const engineManager = this.deps.getOpenClawEngineManager();
    const unconfirmed = (): SyncOpenClawConfigResult => this.unconfirmedConfigApplication({
      success: false, changed, configSynced: false,
    });
    if ((ownership && !ownership.isCurrent()) || (isReloadFallbackCurrent && !isReloadFallbackCurrent())) {
      return unconfirmed();
    }
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
    if (
      (reason === 'proxy-change' || reason === 'extension-network-policy-change') &&
      engineManager.canReuseGatewayNetworkEnvironment()
    ) {
      console.log('[OpenClaw] Network policy applied through the existing local network route.');
      return { success: true, changed, configSynced: true, status };
    }
    const targetProcessGeneration = engineManager.getGatewayProcessGeneration();
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration, ownership, isReloadFallbackCurrent);
    if ((ownership && !ownership.isCurrent()) || (isReloadFallbackCurrent && !isReloadFallbackCurrent())) {
      return unconfirmed();
    }
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
      this.scheduleDeferredGatewayRestart(reason, targetProcessGeneration, ownership, isReloadFallbackCurrent);
      if (ownership) return unconfirmed();
      return {
        success: true,
        changed,
        configSynced: true,
        gatewayRestartDeferred: true,
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
        ...(this.deferredRestart ? { gatewayRestartDeferred: true as const } : {}),
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
        getNativeMcpDataBindings: () => this.nativeMcpDataBindings,
        getHooks: () => this.deps.getHookStore().listHooks(),
        getAgents: () => this.deps.getCoworkStore().listAgents(),
        getAppPluginEntries: this.deps.getAppPluginEntries,
        getAppPluginDefaults: this.deps.getAppPluginDefaults,
        getAppPluginPolicy: this.deps.getAppPluginPolicy,
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
    if (!this.deferredRestart) return;
    clearInterval(this.deferredRestart.timer);
    this.deferredRestart = null;
  }

  private clearDeferredRestartForGeneration(targetProcessGeneration: number): void {
    if (this.deferredRestart?.targetProcessGeneration === targetProcessGeneration) {
      this.clearDeferredRestart();
    }
  }

  private async prepareGatewayRestartSuspension(
    targetProcessGeneration: number,
    ownership?: ConfigApplicationOwnership,
    isReloadFallbackCurrent?: () => boolean,
  ): Promise<GatewayRestartSuspension | null> {
    if (ownership && !ownership.isCurrent()) return null;
    const requestGateway: OpenClawConfigSyncServiceDeps['requestGateway'] = ownership
      ? <T>(method: string, params?: unknown) => this.requestOwnedGateway<T>(ownership.isCurrent, method, params)
      : isReloadFallbackCurrent
        ? <T>(method: string, params?: unknown) => this.requestForCurrentConfig<T>(isReloadFallbackCurrent, method, params)
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

  private async executeDeferredGatewayRestart(restart: DeferredGatewayRestart): Promise<void> {
    const { reason, targetProcessGeneration, ownership } = restart;
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
    isReloadFallbackCurrent?: () => boolean,
  ): void {
    const pending = this.deferredRestart;
    // A required restart can supersede a fallback bound to an old reload.
    if (pending?.targetProcessGeneration === targetProcessGeneration && !ownership &&
        (!pending.isReloadFallbackCurrent || (isReloadFallbackCurrent && pending.isReloadFallbackCurrent()))) {
      console.log(
        `[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`,
      );
      return;
    }
    this.clearDeferredRestart();
    const restart: DeferredGatewayRestart = {
      reason,
      targetProcessGeneration,
      ownership,
      isReloadFallbackCurrent,
      timer: setInterval(() => {
        if (this.deferredRestartCheckInProgress) return;
        this.deferredRestartCheckInProgress = true;
        void this.enqueueSyncOperation(() => this.checkDeferredGatewayRestart(restart))
          .catch(error => {
            console.error(
              `[OpenClaw] Deferred Gateway restart check failed (reason: ${reason}): ${String(error)}`,
            );
          })
          .finally(() => {
            this.deferredRestartCheckInProgress = false;
          });
      }, DEFERRED_RESTART_POLL_MS),
    };
    this.deferredRestart = restart;
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

  private async checkDeferredGatewayRestart(restart: DeferredGatewayRestart): Promise<void> {
    if (this.deferredRestart !== restart) return;
    const { reason, targetProcessGeneration, ownership, isReloadFallbackCurrent } = restart;
    const isCurrent = () => (ownership?.isCurrent() ?? true) && (isReloadFallbackCurrent?.() ?? true);
    if (!isCurrent()) {
      this.clearDeferredRestart();
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
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration, ownership, isReloadFallbackCurrent);
    if (this.deferredRestart !== restart) return;
    if (!isCurrent()) {
      this.clearDeferredRestart();
      return;
    }
    if (suspension) await this.executeDeferredGatewayRestart(restart);
  }
}

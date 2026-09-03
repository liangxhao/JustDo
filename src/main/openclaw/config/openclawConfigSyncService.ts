import type { BrowserMode } from '../../../shared/browser';
import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import { ScheduledTaskAgentId } from '../../../shared/scheduledTask/constants';
import { ManagedDirectoryRuntimeStopAbortedError } from '../../core/managedDirectoryOperations';
import type { CoworkStore } from '../../data/coworkStore';
import {
  parseModelReferenceV2026_8_2,
  parseSessionsListResultV2026_8_2,
} from '../../engine/openclaw/wire/v2026_8_2';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';
import type { OpenClawHookStore } from '../../plugins/hooks';
import type { McpStore } from '../../plugins/mcp';
import {
  OPENCLAW_FALLBACK_EXEC_MODE,
  OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
  OpenClawConfigSync,
  verifyLoggedOutOpenClawConfig,
} from './openclawConfigSync';

type OpenClawConfigSyncServiceDeps = {
  getCoworkStore: () => CoworkStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getMcpStore: () => McpStore;
  getHookStore: () => OpenClawHookStore;
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
  hostPolicyVerified?: boolean;
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

const SCHEDULER_EXEC_APPROVAL_FIELDS = {
  security: 'full',
  ask: 'off',
  askFallback: 'full',
} as const;

type ConfigSnapshot = {
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
  private configSync: OpenClawConfigSync | null = null;
  private deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
  private deferredRestartGeneration: number | null = null;
  private deferredRestartCheckInProgress = false;
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

  restartGatewayWhenIdle(reason: string): Promise<OpenClawEngineStatus> {
    return this.enqueueSyncOperation(() => this.restartGatewayAfterExclusiveMutation(reason));
  }

  async restartGatewayAfterExclusiveMutation(reason: string): Promise<OpenClawEngineStatus> {
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
    console.log(`[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason})`);

    const engineManager = this.deps.getOpenClawEngineManager();
    const statusBeforeSync = engineManager.getStatus();
    const reloadGeneration = engineManager.getGatewayConfigReloadGeneration();
    let fallbackExecPolicyVerified = false;
    if (statusBeforeSync.phase === 'running') {
      try {
        const fallbackPolicyApplied = await this.applyExecApprovalPolicy();
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
    const syncResult = this.getConfigSync().sync(options.reason);
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
      JSON.stringify(nextGatewayLaunchEnvVars) !==
      JSON.stringify(previousGatewayLaunchEnvVars);
    engineManager.setGatewayLaunchEnvVars(nextGatewayLaunchEnvVars);

    const isAuthLogout = options.reason === BuiltinModelSyncReason.AuthLogout;
    const applyMode = isAuthLogout
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

    if (applyMode === 'none') {
      return this.verifySuccessfulConfigApplication(
        {
          success: true,
          changed: syncResult.changed,
          configSynced: true,
        },
        { execPolicyAlreadyVerified: fallbackExecPolicyVerified },
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
      const [runtimeConfigResult, execPolicyApplied] = await Promise.all([
        this.verifyRuntimePermissionConfig(),
        options.execPolicyAlreadyVerified
          ? Promise.resolve(true)
          : this.applyExecApprovalPolicy(),
      ]);
      if (runtimeConfigResult.verified && execPolicyApplied) {
        await this.syncManagedSessionModelsViaGateway(runtimeConfigResult.snapshot);
        return { ...result, hostPolicyVerified: true };
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

  private async verifyRuntimePermissionConfig(): Promise<{
    verified: boolean;
    snapshot: ConfigSnapshot;
  }> {
    const snapshot = await this.deps.requestGateway<ConfigSnapshot>('config.get');
    const schedulerAgent = snapshot.config?.agents?.entries?.[ScheduledTaskAgentId];
    return {
      snapshot,
      verified:
      snapshot.config?.tools?.exec?.host === 'gateway' &&
      snapshot.config.tools.exec.mode === OPENCLAW_FALLBACK_EXEC_MODE &&
      snapshot.config?.tools?.fs?.workspaceOnly === OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY &&
      schedulerAgent?.tools?.exec?.host === 'gateway' &&
      schedulerAgent.tools.exec.mode === 'full' &&
      schedulerAgent.tools.fs?.workspaceOnly === false,
    };
  }

  private async syncManagedSessionModelsViaGateway(snapshot: ConfigSnapshot): Promise<void> {
    const defaults = parseModelReferenceV2026_8_2(snapshot.config?.agents?.defaults?.model);
    const targets = new Map<string, NonNullable<typeof defaults>>();
    for (const [agentId, agent] of Object.entries(snapshot.config?.agents?.entries ?? {})) {
      const target = parseModelReferenceV2026_8_2(agent.model) ?? defaults;
      if (target) targets.set(agentId, target);
    }
    if (defaults) targets.set('main', targets.get('main') ?? defaults);
    if (targets.size === 0) return;

    const availableModelRefs = new Set<string>();
    for (const [providerId, provider] of Object.entries(
      snapshot.config?.models?.providers ?? {},
    )) {
      for (const model of provider.models ?? []) {
        if (typeof model.id !== 'string' || !model.id.trim()) continue;
        availableModelRefs.add(`${providerId}/${model.id.trim()}`);
      }
    }

    const limit = 200;
    let offset = 0;
    const seenOffsets = new Set<number>();
    while (!seenOffsets.has(offset)) {
      seenOffsets.add(offset);
      const page = parseSessionsListResultV2026_8_2(
        await this.deps.requestGateway('sessions.list', { limit, offset }),
      );
      for (const session of page.sessions) {
        const match = /^agent:([^:]+):justdo:(.+)$/.exec(session.key);
        if (!match) continue;
        const persistedTarget = parseModelReferenceV2026_8_2(
          this.deps.getCoworkStore().getSessionModelRef(match[2]),
        );
        const target =
          persistedTarget && availableModelRefs.has(persistedTarget.reference)
            ? persistedTarget
            : targets.get(match[1]);
        if (!target) continue;
        if (session.modelProvider === target.provider && session.model === target.model) continue;
        await this.deps.requestGateway('sessions.patch', {
          key: session.key,
          model: target.reference,
        });
      }
      if (!page.hasMore || page.nextOffset === null || page.nextOffset === undefined) break;
      if (page.nextOffset <= offset) {
        throw new Error('OpenClaw sessions.list returned a non-advancing pagination cursor');
      }
      offset = page.nextOffset;
    }
  }

  private async applyExecApprovalPolicy(): Promise<boolean> {
    const current =
      await this.deps.requestGateway<ExecApprovalsSnapshot>('exec.approvals.get');
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
    const schedulerPolicy = SCHEDULER_EXEC_APPROVAL_FIELDS;
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
      this.isExecApprovalPolicyApplied(applied.file)
    );
  }

  private isExecApprovalPolicyApplied(file: ExecApprovalsFile | undefined): boolean {
    if (file?.version !== 1) return false;

    const expected = FALLBACK_EXEC_APPROVAL_FIELDS;
    const schedulerPolicy = SCHEDULER_EXEC_APPROVAL_FIELDS;
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
    const targetProcessGeneration = engineManager.getGatewayProcessGeneration();
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration);
    if (!suspension) {
      console.log(
        `[OpenClaw] syncOpenClawConfig: deferring hard restart until the native Gateway suspension is ready (reason: ${reason})`,
      );
      this.scheduleDeferredGatewayRestart(reason, targetProcessGeneration);
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
      console.log(
        `[OpenClaw] syncOpenClawConfig: concurrent Gateway lifecycle superseded the prepared restart (reason: ${reason})`,
      );
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
    this.deferredRestartGeneration = null;
  }

  private clearDeferredRestartForGeneration(targetProcessGeneration: number): void {
    if (this.deferredRestartGeneration === targetProcessGeneration) {
      this.clearDeferredRestart();
    }
  }

  private async prepareGatewayRestartSuspension(
    targetProcessGeneration: number,
  ): Promise<GatewayRestartSuspension | null> {
    try {
      const result = await this.deps.requestGateway<GatewaySuspendPrepareResult>(
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
  ): Promise<void> {
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
      if (this.deferredRestartCheckInProgress) return;
      this.deferredRestartCheckInProgress = true;
      void this.enqueueSyncOperation(() =>
        this.checkDeferredGatewayRestart(reason, targetProcessGeneration),
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
  ): Promise<void> {
    if (this.deferredRestartGeneration !== targetProcessGeneration) return;

    const engineManager = this.deps.getOpenClawEngineManager();
    const action = resolveDeferredGatewayRestartAction({
      gatewayPhase: engineManager.getStatus().phase,
      currentProcessGeneration: engineManager.getGatewayProcessGeneration(),
      targetProcessGeneration,
    });
    if (action === 'discard') {
      await this.executeDeferredGatewayRestart(reason, targetProcessGeneration);
      return;
    }
    const suspension = await this.prepareGatewayRestartSuspension(targetProcessGeneration);
    if (suspension && this.deferredRestartGeneration === targetProcessGeneration) {
      await this.executeDeferredGatewayRestart(reason, targetProcessGeneration);
    }
  }
}

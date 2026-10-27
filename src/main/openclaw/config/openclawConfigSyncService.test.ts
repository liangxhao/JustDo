import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import {
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import { SessionRpc } from '../../engine/gateway/sessionRpc';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { ensureExecutionReady } from '../runtime/executionReadiness';
import { resolveManagedCredentialReloadTimeoutMs } from './models/credentialTimeouts';
import {
  MODEL_DEFAULTS_HOT_RELOAD_TIMEOUT_MS,
  OpenClawConfigSyncService,
  resolveDeferredGatewayRestartAction,
  resolveOpenClawConfigApplyMode,
} from './openclawConfigSyncService';

describe('resolveOpenClawConfigApplyMode', () => {
  it('uses native reload for ordinary config changes while the Gateway is running', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: true,
        gatewayLaunchEnvVarsChanged: false,
        requiresGatewayRestart: false,
      }),
    ).toBe('native-reload');
  });

  it('hard-restarts for child-process environment and extension manifest changes', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: true,
        gatewayLaunchEnvVarsChanged: true,
        requiresGatewayRestart: false,
      }),
    ).toBe('hard-restart');
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: false,
        gatewayLaunchEnvVarsChanged: false,
        requiresGatewayRestart: true,
      }),
    ).toBe('hard-restart');
  });

  it('does not restart a stopped Gateway or react to session-store-only changes', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'ready',
        configChanged: true,
        gatewayLaunchEnvVarsChanged: true,
        requiresGatewayRestart: true,
      }),
    ).toBe('none');
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: false,
        gatewayLaunchEnvVarsChanged: false,
        requiresGatewayRestart: false,
      }),
    ).toBe('none');
  });

  it('hard-restarts after an in-flight start when child-process inputs changed', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'starting',
        configChanged: false,
        gatewayLaunchEnvVarsChanged: true,
        requiresGatewayRestart: false,
      }),
    ).toBe('hard-restart');
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'starting',
        configChanged: true,
        gatewayLaunchEnvVarsChanged: false,
        requiresGatewayRestart: false,
      }),
    ).toBe('hard-restart');
  });
});

describe('resolveDeferredGatewayRestartAction', () => {
  it('restarts only the same still-running Gateway process generation', () => {
    expect(
      resolveDeferredGatewayRestartAction({
        gatewayPhase: 'running',
        currentProcessGeneration: 3,
        targetProcessGeneration: 3,
      }),
    ).toBe('restart');
  });

  it('discards intents after stop, replacement, or an in-flight restart', () => {
    expect(
      resolveDeferredGatewayRestartAction({
        gatewayPhase: 'ready',
        currentProcessGeneration: 3,
        targetProcessGeneration: 3,
      }),
    ).toBe('discard');
    expect(
      resolveDeferredGatewayRestartAction({
        gatewayPhase: 'running',
        currentProcessGeneration: 4,
        targetProcessGeneration: 3,
      }),
    ).toBe('discard');
    expect(
      resolveDeferredGatewayRestartAction({
        gatewayPhase: 'starting',
        currentProcessGeneration: 4,
        targetProcessGeneration: 3,
      }),
    ).toBe('discard');
  });
});

describe('managed session model synchronization', () => {
  const createModelHarness = (persisted: string, selected: string, routes: string[]) => {
    let persistedRef = persisted;
    let selectedRef = selected;
    const identity = (ref: string) => {
      const slash = ref.indexOf('/');
      return { modelProvider: ref.slice(0, slash), model: ref.slice(slash + 1) };
    };
    const updateSession = vi.fn((_id: string, updates: { modelRef: string }) => {
      persistedRef = updates.modelRef;
    });
    const requestGateway = vi.fn(async (method: string, params?: { model?: string }) => {
      if (method === 'sessions.list') return {
        sessions: [{ key: 'agent:main:justdo:session-1', ...identity(selectedRef) }], hasMore: false,
      };
      if (method === 'sessions.describe') return { session: identity(selectedRef) };
      if (method === 'sessions.patch') {
        selectedRef = params!.model!;
        return { resolved: identity(selectedRef) };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const modelStore = {
      getSessionModelRef: () => persistedRef,
      getSession: () => ({ id: 'session-1', agentId: 'main', modelRef: persistedRef }),
      updateSession,
    };
    const service = new OpenClawConfigSyncService({
      getCoworkStore: () => modelStore,
      requestGateway,
    } as never);
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request: requestGateway }) as never,
      store: modelStore as never,
    });
    const providers: Record<string, { models: { id: string }[] }> = {};
    for (const ref of routes) {
      const { modelProvider, model } = identity(ref);
      (providers[modelProvider] ??= { models: [] }).models.push({ id: model });
    }
    const sync = () => (service as unknown as {
      syncManagedSessionModelsViaGateway(snapshot: unknown): Promise<void>;
    }).syncManagedSessionModelsViaGateway({ config: {
      models: { providers }, agents: { defaults: { model: { primary: routes[0] } } },
    } });
    return { sync, rpc, requestGateway, updateSession, persisted: () => persistedRef };
  };

  it('preserves the latest native user selection instead of restoring a stale local model', async () => {
    const harness = createModelHarness('p/old', 'p/selected', ['p/old', 'p/selected']);
    await harness.sync();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
    expect(harness.persisted()).toBe('p/selected');
  });

  it('does not describe unchanged available historical sessions when switching defaults', async () => {
    const harness = createModelHarness('p/selected', 'p/selected', ['p/default', 'p/selected']);
    harness.requestGateway.mockResolvedValueOnce({
      sessions: Array.from({ length: 200 }, (_, index) => ({
        key: `agent:main:justdo:session-${index}`,
        modelProvider: 'p', model: 'selected',
      })), hasMore: false,
    });
    await harness.sync();
    expect(harness.requestGateway).toHaveBeenCalledTimes(1);
    expect(harness.updateSession).not.toHaveBeenCalled();
  });

  it('does not restore a valid but stale list selection over a concurrent user switch', async () => {
    const harness = createModelHarness('p/old', 'p/new', ['p/old', 'p/new']);
    harness.requestGateway.mockResolvedValueOnce({
      sessions: [{ key: 'agent:main:justdo:session-1', modelProvider: 'p', model: 'old' }],
      hasMore: false,
    });
    await harness.sync();
    expect(harness.updateSession).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
    await expect(harness.rpc.getModel('session-1')).resolves.toMatchObject({ modelRef: 'p/new' });
  });

  it('replaces a removed selection and persists the Gateway-confirmed replacement', async () => {
    const harness = createModelHarness('p/removed', 'p/removed', ['p/default']);
    await harness.sync();
    expect(harness.requestGateway).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:justdo:session-1', model: 'p/default',
    });
    expect(harness.persisted()).toBe('p/default');
    await harness.sync();
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'sessions.patch')).toHaveLength(1);
  });

  it('restores a renamed local route when the native provider no longer exists', async () => {
    const harness = createModelHarness('renamed/chosen', 'old/chosen', ['renamed/default', 'renamed/chosen']);
    await harness.sync();
    expect(harness.persisted()).toBe('renamed/chosen');
  });

  it('preserves a native built-in alias that is still backed by a configured route', async () => {
    const harness = createModelHarness('hdp/Glm-5.1', 'hdp/Glm-5.1', ['builtin_models/hdp/Glm-5.1']);
    await harness.sync();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
  });

  it('prefers an exact route when restoring a removed native selection', async () => {
    const harness = createModelHarness('hdp/Glm-5.1', 'old/removed', ['builtin_models/hdp/Glm-5.1', 'hdp/Glm-5.1']);
    await harness.sync();
    expect(harness.persisted()).toBe('hdp/Glm-5.1');
  });

  it('re-reads the selected model instead of applying an outdated sessions.list row', async () => {
    const harness = createModelHarness('p/old', 'p/new', ['p/old', 'p/new']);
    harness.requestGateway.mockResolvedValueOnce({
      sessions: [{ key: 'agent:main:justdo:session-1', modelProvider: 'removed', model: 'old' }], hasMore: false,
    });
    await harness.sync();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
    expect(harness.persisted()).toBe('p/new');
  });

  it('a user switch queued during config reconciliation wins after the repair completes', async () => {
    const harness = createModelHarness('removed/old', 'removed/old', ['p/default', 'p/chosen']);
    const request = harness.requestGateway.getMockImplementation()!;
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe') {
        readStarted();
        await pendingRead;
      }
      return request(method, params);
    });
    const syncing = harness.sync();
    await started;
    const selecting = harness.rpc.patchModel('session-1', 'p/chosen');
    releaseRead();
    await syncing;
    await expect(selecting).resolves.toMatchObject({ ok: true, modelRef: 'p/chosen' });
    expect(harness.persisted()).toBe('p/chosen');
    await harness.sync();
    expect(harness.persisted()).toBe('p/chosen');
  });
});

describe('OpenClawConfigSyncService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const runningStatus = {
    phase: 'running' as const,
    version: 'test',
    canRetry: false,
  };

  const createHarness = (options: {
    phase?: 'ready' | 'starting' | 'running' | 'error';
    waitForReload?: boolean;
    activeWorkloads?: boolean;
    prepareGatewaySuspend?: () => unknown | Promise<unknown>;
    previousSecrets?: Record<string, string>;
    nextSecrets?: Record<string, string>;
    configPath?: string;
    permissionMode?: 'ask' | 'auto' | 'full';
    reportedPermissionMode?: 'ask' | 'auto' | 'full';
    configChanged?: boolean;
    modelDefaultsOnly?: boolean;
    getExtensionMcpServerNames?: () => Promise<ReadonlySet<string>>;
    syncError?: string;
    nativeRestartStatus?: string;
    nativeRestartError?: Error;
    reusableNetworkEnvironment?: boolean;
    secretsChanged?: boolean;
    secretsReloadError?: Error | string;
    authLogoutFails?: boolean;
    executionMode?: 'local' | 'sandbox';
    sandboxReady?: boolean;
    getGatewayClient?: () => GatewayClientLike | null;
    getModelAuthSessionId?: () => string | null;
    computerEnabled?: boolean;
    computerStatus?: () => Promise<{ available: boolean }>;
  } = {}) => {
    let phase = options.phase ?? 'running';
    let processGeneration = 1;
    let statusMessage: string | undefined;
    let activeWorkloads = options.activeWorkloads ?? false;
    const getStatus = vi.fn(() => ({
      ...runningStatus,
      phase,
      ...(statusMessage ? { message: statusMessage } : {}),
    }));
    const startGateway = vi.fn(async () => {
      phase = 'running';
      statusMessage = undefined;
      processGeneration += 1;
      return runningStatus;
    });
    const stopGateway = vi.fn(async () => {
      phase = 'ready';
      statusMessage = undefined;
    });
    const restartGateway = vi.fn(async () => {
      await stopGateway();
      return startGateway();
    });
    const engineManager = {
      getStatus,
      getGatewayConfigReloadGeneration: vi.fn(() => 7),
      getGatewayLifecycleGeneration: vi.fn(() => 1),
      waitForGatewayReadyAfter: vi.fn(async () => true),
      hasPendingGatewayLaunchEnvironmentChanges: vi.fn(() => false),
      canReuseGatewayNetworkEnvironment: vi.fn(() => options.reusableNetworkEnvironment ?? false),
      getGatewayPort: vi.fn(() => 18789),
      getConfiguredGatewayPort: vi.fn(() => 18789),
      waitForGatewayConfigReload: vi.fn(async () => options.waitForReload ?? true),
      getGatewayLaunchEnvVars: vi.fn(() => options.previousSecrets ?? {}),
      setGatewayLaunchEnvVars: vi.fn(),
      getGatewayProcessGeneration: vi.fn(() => processGeneration),
      getGatewayProcessId: vi.fn(() => phase === 'ready' || phase === 'error' ? null : 123),
      getDesiredVersion: vi.fn(() => 'v2026.6.11'),
      startGateway,
      stopGateway,
      restartGateway,
      setExternalError: vi.fn((message: string) => {
        phase = 'error';
        statusMessage = message;
        return { ...runningStatus, phase, message };
      }),
    };
    const disconnectGatewayClient = vi.fn();
    const connectGatewayClient = vi.fn(async () => {});
    let approvalHash = 'approval-hash';
    let approvalFile = {
      version: 1,
      defaults: {} as Record<string, unknown>,
      agents: {
        helper: {
          allowlist: [
            { pattern: 'npm run build', source: 'allow-always' },
            { pattern: 'git diff', source: 'manual' },
          ],
        },
      },
    };
    const requestGateway = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'computer.status') return options.computerStatus?.() ?? { available: true };
      if (method === 'secrets.reload') {
        if (options.secretsReloadError) throw options.secretsReloadError;
        return { ok: true };
      }
      if (method === 'models.authLogout') {
        if (options.authLogoutFails) throw new Error('auth store busy');
        return { removedProfiles: [`${(params as { provider: string }).provider}:default`] };
      }
      if (method === 'models.authStatus') {
        return { providers: [] };
      }
      if (method === 'gateway.restart.request') {
        if (options.nativeRestartError) throw options.nativeRestartError;
        return options.nativeRestartStatus
          ? { ok: true, status: options.nativeRestartStatus }
          : { ok: false };
      }
      if (method === 'gateway.suspend.prepare') {
        if (options.prepareGatewaySuspend) return options.prepareGatewaySuspend();
        return activeWorkloads
          ? {
              status: 'busy',
              reason: 'active-work',
              retryAfterMs: 3_000,
              activeCount: 1,
              blockers: [],
            }
          : {
              status: 'ready',
              suspensionId: 'suspension-1',
              expiresAtMs: Date.now() + 120_000,
              activeCount: 0,
              blockers: [],
            };
      }
      if (method === 'gateway.suspend.resume') {
        return { ok: true, status: 'running', resumed: true };
      }
      if (method === 'exec.approvals.get') {
        return {
          hash: approvalHash,
          file: approvalFile,
        };
      }
      if (method === 'exec.approvals.set') {
        approvalFile = (params as { file: typeof approvalFile }).file;
        approvalHash = 'next-approval-hash';
        return { hash: approvalHash };
      }
      if (method === 'config.get') {
        const permissionMode = options.reportedPermissionMode ?? 'ask';
        const executionMode = options.executionMode ?? 'local';
        const execHost = executionMode === 'sandbox' ? 'sandbox' : 'gateway';
        return {
          configRevisionHash: 'applied-config-revision',
          appliedConfigHash: 'applied-config-revision',
          config: {
            ...(options.computerEnabled === undefined ? {} : {
              plugins: { entries: { 'cua-computer': { enabled: options.computerEnabled } } },
            }),
            agents: {
              entries: { main: {} },
            },
            tools: {
              exec: { host: execHost, mode: permissionMode },
              fs: { workspaceOnly: true },
            },
          },
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const connectedClient = { request: requestGateway } as unknown as GatewayClientLike;
    const service = new OpenClawConfigSyncService({
      getCoworkStore: () => ({
        getConfig: () => ({
          permissionMode: options.permissionMode ?? 'ask',
          executionMode: options.executionMode ?? 'local',
        }),
      }),
      getOpenClawEngineManager: () => engineManager,
      getMcpStore: vi.fn(),
      getExtensionMcpServerNames: options.getExtensionMcpServerNames,
      getHookStore: vi.fn(),
      disconnectGatewayClient,
      connectGatewayClient,
      requestGateway,
      getGatewayClient: options.getGatewayClient ?? (() => connectedClient),
      getModelAuthSessionId: options.getModelAuthSessionId,
      getWindowsSandboxStatus: vi.fn(async () => ({
        code: options.sandboxReady === false ? 'check_failed' : 'ready',
        supported: true,
        helperAvailable: true,
        initialized: options.sandboxReady !== false,
        ready: options.sandboxReady !== false,
      })),
      getWindowsSandboxEnvironment: vi.fn(() => ({})),
    } as never);
    const configSync = {
      syncModelDefaults: vi.fn(() => ({
        result: {
          ok: !options.syncError,
          changed: options.configChanged ?? true,
          configChanged: options.configChanged ?? true,
          modelDefaultsOnly: options.modelDefaultsOnly ?? true,
          requiresGatewayRestart: false,
          secretsChanged: options.secretsChanged ?? false,
          configPath: options.configPath ?? 'openclaw.json',
        },
        isCurrent: vi.fn(() => true),
        matchesRuntimeConfig: vi.fn(() => true),
      })),
      sync: vi.fn(() =>
        options.syncError
          ? { ok: false, error: options.syncError }
          : {
              ok: true,
              changed: (options.configChanged ?? true) || (options.secretsChanged ?? false),
              configChanged: options.configChanged ?? true,
              modelDefaultsOnly: options.modelDefaultsOnly,
              requiresGatewayRestart: false,
              secretsChanged: options.secretsChanged ?? false,
              configPath: options.configPath ?? 'openclaw.json',
            },
      ),
      collectGatewayLaunchEnvVars: vi.fn(() => options.nextSecrets ?? {}),
    };
    (
      service as unknown as {
        configSync: typeof configSync;
      }
    ).configSync = configSync;

    return {
      service,
      engineManager,
      getStatus,
      startGateway,
      stopGateway,
      disconnectGatewayClient,
      connectGatewayClient,
      requestGateway,
      configSync,
      setPhase: (nextPhase: typeof phase) => {
        phase = nextPhase;
      },
      setActiveWorkloads: (active: boolean) => {
        activeWorkloads = active;
      },
      advanceProcessGeneration: () => {
        processGeneration += 1;
      },
    };
  };

  const createPendingCredentialHarness = async (options: Parameters<typeof createHarness>[0] = {}) => {
    let sessionId = 'original-session';
    const harness = createHarness({
      ...options, configChanged: false, secretsChanged: true,
      getModelAuthSessionId: () => sessionId,
    });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload') harness.advanceProcessGeneration();
      return request(method, params);
    });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    harness.requestGateway.mockImplementation(request);
    harness.requestGateway.mockClear();
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, configChanged: true, secretsChanged: false });
    return {
      ...harness,
      request,
      published,
      replaceOwner: (owner: 'process' | 'lifecycle' | 'authentication') => {
        if (owner === 'process') harness.advanceProcessGeneration();
        if (owner === 'lifecycle') harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
        if (owner === 'authentication') sessionId = 'replacement-session';
      },
    };
  };

  it('only reads active permissions during execution admission, without projecting config or discovering MCP', async () => {
    const discovery = vi.fn(async () => new Set<string>());
    const harness = createHarness({ getExtensionMcpServerNames: discovery });
    await harness.service.syncConfig({ reason: 'startup' });
    harness.requestGateway.mockClear();
    harness.configSync.sync.mockClear();
    discovery.mockClear();

    await expect(harness.service.verifyExecutionPermissionPolicy()).resolves.toMatchObject({
      success: true, hostPolicyVerified: true,
    });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get',
    ]);
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
  });

  it('rejects unsafe execution admission without repairing the approval file', async () => {
    const harness = createHarness();
    await expect(harness.service.verifyExecutionPermissionPolicy()).resolves.toMatchObject({
      success: false,
    });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get',
    ]);
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('overlaps computer preparation with sending, reusing the verified config without blocking the queue', async () => {
    let release!: (value: { available: boolean }) => void;
    const hostReady = new Promise<{ available: boolean }>(resolve => { release = resolve; });
    const harness = createHarness({ computerEnabled: true, computerStatus: () => hostReady });
    await harness.service.syncConfig({ reason: 'startup' });
    harness.requestGateway.mockClear();
    harness.configSync.sync.mockClear();

    await expect(harness.service.verifyExecutionPermissionPolicy({ prepareComputerForSend: true }))
      .resolves.toMatchObject({ success: true, hostPolicyVerified: true });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get', 'computer.status',
    ]);
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    // A slow native host cannot retain the configuration mutation lock.
    await expect(harness.service.verifyExecutionPermissionPolicy()).resolves.toMatchObject({ success: true });
    release({ available: false });
  });

  it('does not prepare the computer when readiness is requested without a send', async () => {
    const harness = createHarness({ computerEnabled: true });
    await harness.service.syncConfig({ reason: 'startup' });
    harness.requestGateway.mockClear();
    await harness.service.verifyExecutionPermissionPolicy();
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get',
    ]);
  });

  it('does not prepare the computer after a failed permission verification', async () => {
    const harness = createHarness({ computerEnabled: true });
    await expect(harness.service.verifyExecutionPermissionPolicy({ prepareComputerForSend: true }))
      .resolves.toMatchObject({ success: false });
    expect(harness.requestGateway).not.toHaveBeenCalledWith('computer.status', expect.anything(), expect.anything());
  });

  it('skips computer preparation if config reloads while permissions are being read', async () => {
    const harness = createHarness({ computerEnabled: true });
    await harness.service.syncConfig({ reason: 'startup' });
    harness.requestGateway.mockClear();
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      const response = await request(method, params);
      if (method === 'exec.approvals.get') {
        harness.engineManager.getGatewayConfigReloadGeneration.mockReturnValue(8);
      }
      return response;
    });
    await expect(harness.service.verifyExecutionPermissionPolicy({ prepareComputerForSend: true }))
      .resolves.toMatchObject({ success: true });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get',
    ]);
  });

  it('also prepares the host on a cold send after initializing the approval floor', async () => {
    const harness = createHarness({ phase: 'ready', computerEnabled: true });
    await expect(harness.service.startGatewayWithExecutionPolicy({ prepareComputerForSend: true }))
      .resolves.toMatchObject({ phase: 'running' });
    expect(harness.requestGateway).toHaveBeenCalledWith('computer.status', {}, { timeoutMs: 60_000 });
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('initializes the approval floor after a stopped startup projection without repeating config work', async () => {
    const discovery = vi.fn(async () => new Set<string>());
    const harness = createHarness({ phase: 'ready', getExtensionMcpServerNames: discovery });
    await expect(harness.service.syncConfig({ reason: 'startup' })).resolves.toMatchObject({
      success: true,
    });
    expect(harness.requestGateway).not.toHaveBeenCalled();
    harness.configSync.sync.mockClear();
    discovery.mockClear();

    await expect(ensureExecutionReady({
      manager: harness.engineManager,
      startWithPermissionPolicy: () => harness.service.startGatewayWithExecutionPolicy(),
      verifyPermissionPolicy: () => harness.service.verifyExecutionPermissionPolicy(),
    })).resolves.toMatchObject({ phase: 'running' });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get', 'exec.approvals.set', 'exec.approvals.get',
      'models.authStatus', 'config.get',
    ]);
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('serializes concurrent cold starts and initializes the approval floor only once', async () => {
    const harness = createHarness({ phase: 'ready' });
    await expect(Promise.all([
      harness.service.startGatewayWithExecutionPolicy(),
      harness.service.startGatewayWithExecutionPolicy(),
    ])).resolves.toEqual([
      expect.objectContaining({ phase: 'running' }),
      expect.objectContaining({ phase: 'running' }),
    ]);
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'exec.approvals.set'))
      .toHaveLength(1);
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.configSync.sync).not.toHaveBeenCalled();
  });

  it('starts auth maintenance in the background without holding execution admission behind discovery', async () => {
    let releaseDiscovery!: (value: unknown) => void;
    const discovery = new Promise(resolve => { releaseDiscovery = resolve; });
    const backgroundRequest = vi.fn((method: string, params?: unknown): Promise<unknown> => {
      if (method === 'models.authStatus') return discovery;
      if (method === 'config.get') return Promise.resolve({ config: { models: { providers: {} } } });
      return harness.requestGateway(method, params);
    });
    const client = { request: backgroundRequest } as unknown as GatewayClientLike;
    const harness = createHarness({ phase: 'ready', getGatewayClient: () => client });

    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'running' });
    expect(backgroundRequest).toHaveBeenCalledWith('models.authStatus', { agentId: 'main' });
    await expect(harness.service.verifyExecutionPermissionPolicy())
      .resolves.toMatchObject({ success: true });
    expect(harness.requestGateway).not.toHaveBeenCalledWith('models.authStatus', expect.anything());
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    releaseDiscovery({ providers: [] });
  });

  it('joins an in-flight startup before initializing its approval floor', async () => {
    const harness = createHarness({ phase: 'starting' });
    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'running' });
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway).toHaveBeenCalledWith('exec.approvals.set', expect.anything());
  });

  it('does not repair unsafe approvals if another caller already started the Gateway', async () => {
    const harness = createHarness();
    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'error' });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get',
    ]);
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('does not initialize approvals if the Gateway failed to start', async () => {
    const harness = createHarness({ phase: 'ready' });
    harness.startGateway.mockImplementationOnce(async () => {
      harness.setPhase('error');
      return harness.getStatus() as typeof runningStatus;
    });
    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'error' });
    expect(harness.requestGateway).not.toHaveBeenCalled();
  });

  it('does not write an old approval snapshot into a replacement process during startup', async () => {
    const harness = createHarness({ phase: 'ready' });
    const original = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === 'exec.approvals.get') harness.advanceProcessGeneration();
      return response;
    });
    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'error' });
    expect(harness.requestGateway).not.toHaveBeenCalledWith('exec.approvals.set', expect.anything());
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.setExternalError).not.toHaveBeenCalled();
  });

  it('keeps startup approval writes on their captured client if a reconnect races dispatch', async () => {
    const replacementRequest = vi.fn();
    const replacement = { request: replacementRequest } as unknown as GatewayClientLike;
    let currentClient: GatewayClientLike;
    const boundRequest = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'exec.approvals.set') {
        currentClient = replacement;
        harness.advanceProcessGeneration();
        throw new Error('The captured connection closed before dispatch');
      }
      return harness.requestGateway(method, params);
    });
    currentClient = { request: boundRequest } as unknown as GatewayClientLike;
    const harness = createHarness({ phase: 'ready', getGatewayClient: () => currentClient });

    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'error' });
    expect(boundRequest).toHaveBeenCalledWith('exec.approvals.set', expect.anything());
    expect(harness.requestGateway).not.toHaveBeenCalledWith('exec.approvals.set', expect.anything());
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.setExternalError).not.toHaveBeenCalled();
  });

  it('does not admit a startup result after its process has already stopped', async () => {
    const harness = createHarness({ phase: 'ready' });
    harness.startGateway.mockResolvedValueOnce(runningStatus);
    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'ready' });
    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('fails closed when cold-start approval initialization is rejected', async () => {
    const harness = createHarness({ phase: 'ready' });
    const original = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'exec.approvals.set') throw new Error('approval write rejected');
      return original(method, params);
    });
    await expect(harness.service.startGatewayWithExecutionPolicy())
      .resolves.toMatchObject({ phase: 'error' });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('does not inspect historical model selections or clean credentials during execution admission', async () => {
    const harness = createHarness();
    await harness.service.syncConfig({ reason: 'startup' });
    const original = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === 'config.get') {
        return {
          ...response,
          config: {
            ...('config' in response ? response.config : {}),
            agents: { defaults: { model: 'provider/model' } },
            models: { providers: { provider: { models: [{ id: 'model' }] } } },
          },
        };
      }
      return response;
    });
    harness.requestGateway.mockClear();
    await expect(harness.service.verifyExecutionPermissionPolicy()).resolves.toMatchObject({
      success: true,
    });
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'exec.approvals.get',
    ]);
  });

  it('rejects a verification superseded by another process without stopping the replacement', async () => {
    const harness = createHarness();
    await harness.service.syncConfig({ reason: 'startup' });
    const original = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === 'config.get') harness.advanceProcessGeneration();
      return response;
    });
    await expect(harness.service.verifyExecutionPermissionPolicy()).resolves.toMatchObject({
      success: false, status: { phase: 'error' },
    });
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('waits for an existing configuration mutation before reading active permissions', async () => {
    const harness = createHarness();
    await harness.service.syncConfig({ reason: 'startup' });
    harness.requestGateway.mockClear();
    let release!: () => void;
    const pending = harness.service.runConfigMutationExclusive(() => new Promise<void>(resolve => {
      release = resolve;
    }));
    const verification = harness.service.verifyExecutionPermissionPolicy();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(harness.requestGateway).not.toHaveBeenCalled();
    release();
    await pending;
    await expect(verification).resolves.toMatchObject({ success: true });
  });

  it('waits for native hot reload without restarting the Gateway', async () => {
    const harness = createHarness({ waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      changed: true,
    });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledWith(7);
    expect(harness.configSync.sync).toHaveBeenCalledWith('test', new Set(), new Set());
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it.each([true, false])('skips historical model scans for a verified default-only change (config changed: %s)', async configChanged => {
    const harness = createHarness({ modelDefaultsOnly: true, configChanged });
    await harness.service.syncConfig({ reason: 'startup' });
    harness.engineManager.waitForGatewayConfigReload.mockClear();
    harness.configSync.sync.mockClear();
    const reconciliation = vi.spyOn(harness.service as unknown as {
      syncManagedSessionModelsViaGateway: () => Promise<void>;
    }, 'syncManagedSessionModelsViaGateway').mockResolvedValue();
    let finishReload!: (applied: boolean) => void;
    const reload = new Promise<boolean>(resolve => { finishReload = resolve; });
    harness.engineManager.waitForGatewayConfigReload.mockImplementationOnce(() => reload);
    const finished = vi.fn();
    const saving = harness.service.syncConfig({ reason: 'default-model-change' }).then(result => {
      finished();
      return result;
    });
    if (configChanged) {
      await vi.waitFor(() => expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalled());
      expect(finished).not.toHaveBeenCalled();
      finishReload(true);
    }

    await expect(saving).resolves.toMatchObject({ success: true, hostPolicyVerified: true });
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.configSync.syncModelDefaults).toHaveBeenCalledOnce();
    if (configChanged) expect(harness.engineManager.waitForGatewayConfigReload)
      .toHaveBeenCalledWith(7, MODEL_DEFAULTS_HOT_RELOAD_TIMEOUT_MS);
    expect(harness.requestGateway).toHaveBeenCalledWith('config.get');
    expect(harness.requestGateway).toHaveBeenCalledWith('exec.approvals.get');
    expect(reconciliation).not.toHaveBeenCalled();
  });

  it.each([
    { modelDefaultsOnly: false },
    { modelDefaultsOnly: true, secretsChanged: true },
  ])('rejects unsafe model-default publications without a full sync or restart: %j', async options => {
    const harness = createHarness(options);
    const reconciliation = vi.spyOn(harness.service as unknown as {
      syncManagedSessionModelsViaGateway: () => Promise<void>;
    }, 'syncManagedSessionModelsViaGateway').mockResolvedValue();

    const result = await harness.service.syncConfig({ reason: 'default-model-change' });
    expect(result).toMatchObject({ success: false, configSynced: false });
    expect(result.modelDefaultsApplicationPending).toBeUndefined();
    expect(result.error).toBe(t('modelDefaultConfigSyncFailed'));

    expect(reconciliation).not.toHaveBeenCalled();
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalled();
  });

  it('releases execution admission while a model-default hot observation is pending', async () => {
    const harness = createHarness();
    await harness.service.syncConfig({ reason: 'startup' });
    let finishReload!: (applied: boolean) => void;
    harness.engineManager.waitForGatewayConfigReload.mockImplementationOnce(() => new Promise(resolve => {
      finishReload = resolve;
    }));
    harness.requestGateway.mockClear();
    const finished = vi.fn();
    const saving = harness.service.syncConfig({ reason: 'default-model-change' }).then(result => {
      finished(); return result;
    });
    await vi.waitFor(() => expect(finishReload).toBeTypeOf('function'));
    await expect(harness.service.verifyExecutionPermissionPolicy()).resolves.toMatchObject({ success: true });
    expect(finished).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual(['config.get', 'exec.approvals.get']);
    finishReload(true);
    await expect(saving).resolves.toMatchObject({ success: true });
  });

  it('keeps a rejected model publication separate from pending runtime application', async () => {
    const harness = createHarness();
    const publication = harness.configSync.syncModelDefaults.getMockImplementation()!();
    Object.assign(publication.result, { ok: false, error: 'Model configuration write failed' });
    harness.configSync.syncModelDefaults.mockReturnValue(publication);

    const result = await harness.service.syncConfig({ reason: 'default-model-change' });

    expect(result).toMatchObject({
      success: false, configSynced: false, error: 'Model configuration write failed',
    });
    expect(result.modelDefaultsApplicationPending).toBeUndefined();
    expect(harness.engineManager.waitForGatewayConfigReload).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('keeps general permission mutations serialized for their complete native application', async () => {
    const harness = createHarness();
    let finishReload!: (applied: boolean) => void;
    harness.engineManager.waitForGatewayConfigReload.mockImplementationOnce(() => new Promise(resolve => {
      finishReload = resolve;
    }));
    const general = harness.service.syncConfig({ reason: 'permission-change' });
    await vi.waitFor(() => expect(finishReload).toBeTypeOf('function'));
    const saving = harness.service.syncConfig({ reason: 'default-model-change' });
    const verify = harness.service.verifyExecutionPermissionPolicy();
    expect(harness.configSync.syncModelDefaults).not.toHaveBeenCalled();
    finishReload(true);
    await expect(general).resolves.toMatchObject({ success: true });
    await expect(saving).resolves.toMatchObject({ success: true });
    await expect(verify).resolves.toMatchObject({ success: true });
  });

  it.each(['default-model-change', 'default-model-change-rollback'])(
    'never restarts or stops on an unconfirmed model observation: %s', async reason => {
      const harness = createHarness({ waitForReload: false });
      const result = await harness.service.syncConfig({ reason });
      expect(result).toMatchObject({ success: false, configSynced: false, modelDefaultsApplicationPending: true });
      expect(result.error).toBeUndefined();
      expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledWith(7, MODEL_DEFAULTS_HOT_RELOAD_TIMEOUT_MS);
      expect(harness.configSync.sync).not.toHaveBeenCalled();
      expect(harness.requestGateway).not.toHaveBeenCalled();
      expect(harness.stopGateway).not.toHaveBeenCalled();
      expect(harness.startGateway).not.toHaveBeenCalled();
      expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    },
  );

  it('keeps a rejected hot observation unconfirmed without stopping or restarting', async () => {
    const harness = createHarness();
    harness.engineManager.waitForGatewayConfigReload.mockRejectedValueOnce(new Error('observer unavailable'));
    const result = await harness.service.syncConfig({ reason: 'default-model-change' });
    expect(result).toMatchObject({ success: false, configSynced: false, modelDefaultsApplicationPending: true });
    expect(result.error).toBeUndefined();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalled();
  });

  it.each(['revision', 'model', 'permissions'] as const)(
    'requires current native application and policy evidence after hot reload (%s)', async invalid => {
      const harness = createHarness();
      await harness.service.syncConfig({ reason: 'startup' });
      const publication = harness.configSync.syncModelDefaults.getMockImplementation()!();
      if (invalid === 'model') publication.matchesRuntimeConfig.mockReturnValue(false);
      harness.configSync.syncModelDefaults.mockReturnValue(publication);
      const request = harness.requestGateway.getMockImplementation()!;
      harness.requestGateway.mockImplementation(async (method, params) => {
        const result = await request(method, params);
        if (invalid === 'revision' && method === 'config.get') return { ...result, appliedConfigHash: 'previous-revision' };
        if (invalid === 'permissions' && method === 'exec.approvals.get') return { hash: 'unsafe', file: { version: 1, defaults: {} } };
        return result;
      });
      const result = await harness.service.syncConfig({ reason: 'default-model-change' });
      expect(result).toMatchObject({ success: false, configSynced: false, modelDefaultsApplicationPending: true });
      expect(result.error).toBeUndefined();
      expect(result.hostPolicyVerified).toBeUndefined();
      expect(harness.stopGateway).not.toHaveBeenCalled();
      expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    },
  );

  it.each(['pending-input', 'changed-input'])('does not publish defaults across an unapplied launch environment (%s)', async source => {
    const harness = createHarness(source === 'changed-input' ? { nextSecrets: { MANAGED_KEY: 'test-value' } } : {});
    harness.engineManager.hasPendingGatewayLaunchEnvironmentChanges.mockReturnValue(source === 'pending-input');
    const result = await harness.service.syncConfig({ reason: 'default-model-change' });
    expect(result).toMatchObject({ success: false, configSynced: false, modelDefaultsApplicationPending: true });
    expect(result.error).toBeUndefined();
    expect(harness.configSync.syncModelDefaults).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it.each(['retiredProviderIds', 'retiredMcpServerNames'] as const)(
    'rejects a default reason carrying unrelated %s obligations before publication', async field => {
      const harness = createHarness();
      await expect(harness.service.syncConfig({ reason: 'default-model-change', [field]: ['retired'] }))
        .resolves.toMatchObject({ success: false, configSynced: false });
      expect(harness.configSync.syncModelDefaults).not.toHaveBeenCalled();
      expect(harness.configSync.sync).not.toHaveBeenCalled();
      expect(harness.stopGateway).not.toHaveBeenCalled();
    },
  );

  it.each(['client', 'process', 'lifecycle', 'authentication', 'file'] as const)(
    'does not confirm a model observation after its %s owner changes', async owner => {
      let authId = 'initial';
      const harness = createHarness({ getModelAuthSessionId: () => authId });
      await harness.service.syncConfig({ reason: 'startup' });
      let finishReload!: (applied: boolean) => void;
      harness.engineManager.waitForGatewayConfigReload.mockImplementationOnce(() => new Promise(resolve => {
        finishReload = resolve;
      }));
      const publication = harness.configSync.syncModelDefaults.getMockImplementation()!();
      harness.configSync.syncModelDefaults.mockReturnValue(publication);
      const saving = harness.service.syncConfig({ reason: 'default-model-change' });
      await vi.waitFor(() => expect(finishReload).toBeTypeOf('function'));
      if (owner === 'client') (harness.service as unknown as { deps: { getGatewayClient: () => null } }).deps.getGatewayClient = () => null;
      if (owner === 'process') harness.advanceProcessGeneration();
      if (owner === 'lifecycle') harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
      if (owner === 'authentication') authId = 'replacement';
      if (owner === 'file') publication.isCurrent.mockReturnValue(false);
      harness.requestGateway.mockClear();
      finishReload(true);
      await expect(saving).resolves.toMatchObject({ success: false, configSynced: false });
      expect(harness.requestGateway).not.toHaveBeenCalled();
      expect(harness.stopGateway).not.toHaveBeenCalled();
    },
  );

  it.each(['ready', 'error'] as const)('saves only model defaults while offline (%s)', async phase => {
    const harness = createHarness({ phase });
    const result = await harness.service.syncConfig({ reason: 'default-model-change' });
    expect(result).toMatchObject({ success: true, configSynced: true });
    expect(result).not.toHaveProperty('hostPolicyVerified');
    expect(harness.configSync.syncModelDefaults).toHaveBeenCalledOnce();
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('does not write a model default into an in-flight Gateway startup snapshot', async () => {
    const harness = createHarness({ phase: 'starting' });
    const result = await harness.service.syncConfig({ reason: 'default-model-change' });
    expect(result).toMatchObject({ success: false, configSynced: false, modelDefaultsApplicationPending: true });
    expect(result.error).toBeUndefined();
    expect(result.hostPolicyVerified).toBeUndefined();
    expect(harness.configSync.syncModelDefaults).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('preserves an existing credential application obligation instead of publishing a model default', async () => {
    const harness = await createPendingCredentialHarness();
    await expect(harness.service.syncConfig({ reason: 'default-model-change' }))
      .resolves.toMatchObject({ success: false, configSynced: false });
    expect(harness.configSync.syncModelDefaults).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('confirms a model default inside an explicit mutation context without reentering its queue', async () => {
    const harness = createHarness();
    await harness.service.syncConfig({ reason: 'startup' });
    await expect(harness.service.runConfigMutationExclusive(context =>
      context.syncConfig({ reason: 'default-model-change' })))
      .resolves.toMatchObject({ success: true });
  });

  it('stops a running Gateway instead of falling back when the sandbox is not ready', async () => {
    const harness = createHarness({ executionMode: 'sandbox', sandboxReady: false });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped'),
    });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.configSync.sync).not.toHaveBeenCalled();
  });

  it('never asks config sync to mutate the legacy session store', async () => {
    const harness = createHarness({ phase: 'ready' });

    const result = await harness.service.syncConfig({ reason: 'startup' });

    expect(result).toMatchObject({
      success: true,
      configSynced: true,
    });
    expect(result).not.toHaveProperty('hostPolicyVerified');
    expect(harness.configSync.sync).toHaveBeenCalledWith('startup', new Set(), new Set());
  });

  it('passes authoritative native extension names through configuration projection', async () => {
    const names = new Set(['extension-server']);
    const harness = createHarness({ getExtensionMcpServerNames: async () => names });
    await expect(harness.service.syncConfig({ reason: 'preserve-extension', retiredMcpServerNames: ['old-user-server'] })).resolves.toMatchObject({ success: true });
    expect(harness.configSync.sync).toHaveBeenCalledWith('preserve-extension', names, new Set(['old-user-server']));
  });

  it.each([true, false, undefined])('requests decision snapshot restoration only for explicit rollback: %s', async restoreDecisionModelSnapshot => {
    const harness = createHarness({ phase: 'ready' });
    await expect(harness.service.syncConfig({
      reason: 'app-config-change',
      restoreDecisionModelSnapshot,
    })).resolves.toMatchObject({ success: true });
    expect(harness.configSync.sync).toHaveBeenCalledWith(
      'app-config-change',
      new Set(),
      new Set(),
      ...(restoreDecisionModelSnapshot === true ? [{ restoreDecisionModelSnapshot: true }] : []),
    );
  });

  it.each(['preserve-extension', 'auth-logout'])(
    'preserves configuration and stops the runtime when ownership cannot be read during %s',
    async reason => {
      const harness = createHarness({
        getExtensionMcpServerNames: async () => {
          throw new Error('metadata unavailable');
        },
      });
      await expect(harness.service.syncConfig({ reason })).resolves.toMatchObject({
        success: false,
        configSynced: false,
      });
      expect(harness.configSync.sync).not.toHaveBeenCalled();
      expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
      expect(harness.stopGateway).toHaveBeenCalledOnce();
    },
  );

  it('restarts when a running Gateway needs a newly added environment secret', async () => {
    const harness = createHarness({
      nextSecrets: {
        JUSTDO_APIKEY_CUSTOM_1: 'custom-secret',
      },
    });

    await expect(
      harness.service.syncConfig({ reason: 'auth-login' }),
    ).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
  });

  it('hot-reloads login when the Gateway environment is unchanged', async () => {
    const secrets = {
      JUSTDO_APIKEY_CUSTOM_1: 'custom-secret',
    };
    const harness = createHarness({
      previousSecrets: secrets,
      nextSecrets: secrets,
      waitForReload: true,
    });

    await expect(
      harness.service.syncConfig({ reason: 'auth-login' }),
    ).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledOnce();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('refreshes rotated file credentials without restarting or waiting for a config file event', async () => {
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    await expect(harness.service.syncConfig({ reason: 'provider-key-change' })).resolves.toMatchObject({ success: true, changed: true });
    expect(harness.requestGateway).toHaveBeenCalledWith('secrets.reload', undefined, {
      timeoutMs: resolveManagedCredentialReloadTimeoutMs(),
    });
    expect(harness.engineManager.waitForGatewayConfigReload).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('fails closed when the native credential snapshot cannot refresh', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadError = new Error('credential reload timed out; Authorization: Bearer reload-jwt-fixture');
    const harness = createHarness({ configChanged: false, secretsChanged: true, secretsReloadError: reloadError });
    await expect(harness.service.syncConfig({ reason: 'provider-key-change' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Failed to refresh managed model provider credentials.'),
    });
    expect(errorLog).toHaveBeenCalledWith(
      '[OpenClaw] Failed to refresh managed model provider credentials (secrets.reload):',
      expect.objectContaining({
        reason: 'provider-key-change',
        gatewayPhase: 'running',
        elapsedMs: expect.any(Number),
        error: expect.stringContaining('credential reload timed out; Authorization: [REDACTED]'),
      }),
    );
    expect(errorLog.mock.calls[0][1].error).toContain('openclawConfigSyncService.test.ts:');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('reload-jwt-fixture');
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(errorLog.mock.invocationCallOrder[0]).toBeLessThan(harness.stopGateway.mock.invocationCallOrder[0]);
  });

  it('records string rejections when the native credential snapshot cannot refresh', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({
      configChanged: false,
      secretsChanged: true,
      secretsReloadError: 'gateway disconnected; apiKey=reload-key-fixture',
    });
    await expect(harness.service.syncConfig({ reason: 'provider-key-change' })).resolves.toMatchObject({ success: false });
    expect(errorLog.mock.calls[0][1].error).toBe('gateway disconnected; apiKey=[REDACTED]');
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('retries a temporary credential reload without stopping active work', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({ configChanged: false, secretsChanged: true, activeWorkloads: true });
    const request = harness.requestGateway.getMockImplementation()!;
    let attempts = 0;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload' && ++attempts === 1) {
        throw Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE', retryable: false });
      }
      return request(method, params);
    });
    const sync = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(sync).resolves.toMatchObject({ success: true });
    expect(attempts).toBe(2);
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('recovers its own stopped runtime even when the published credential file is unchanged', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    let unavailable = true;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload' && unavailable) {
        throw Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' });
      }
      return request(method, params);
    });
    const failed = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).resolves.toMatchObject({ success: false });
    expect(harness.getStatus().phase).toBe('error');
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    unavailable = false;
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });
    expect(harness.getStatus().phase).toBe('running');
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(4);
    expect(harness.requestGateway).toHaveBeenCalledWith('exec.approvals.set', expect.anything());
  });

  it('finishes provider cleanup when a config change recovers a credential reload failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    let unavailable = true;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload' && unavailable) {
        throw Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' });
      }
      return request(method, params);
    });
    const failed = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).resolves.toMatchObject({ success: false });
    expect(harness.getStatus().phase).toBe('error');
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({
      ...published, changed: true, configChanged: true, secretsChanged: false,
    });
    unavailable = false;

    await expect(harness.service.syncConfig({
      reason: 'provider-remove', retiredProviderIds: ['OldProxy'],
    })).resolves.toMatchObject({ success: true });

    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway).toHaveBeenCalledWith('models.authLogout', {
      provider: 'oldproxy', agentId: 'main',
    });
  });

  it('bounds stopped-runtime recovery and never reports a still-stopped runtime as applied', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadError = Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' });
    const harness = createHarness({ configChanged: false, secretsChanged: true, secretsReloadError: reloadError });
    const first = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ success: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    const retry = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retry).resolves.toMatchObject({ success: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.stopGateway).toHaveBeenCalledTimes(2);
    expect(harness.getStatus().phase).toBe('error');
  });

  it('does not restart after an authoritative credential reload refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadError = Object.assign(new Error('Gateway requester authority changed'), { gatewayCode: 'FORBIDDEN' });
    const harness = createHarness({ configChanged: false, secretsChanged: true, secretsReloadError: reloadError });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
  });

  it('does not accept a credential ACK or stop a replacement authentication session', async () => {
    let sessionId = 'original-session';
    const harness = createHarness({
      configChanged: false, secretsChanged: true, getModelAuthSessionId: () => sessionId,
    });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload') {
        sessionId = 'replacement-session';
        return { ok: true };
      }
      return request(method, params);
    });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('does not stop a replacement Gateway after a late credential reload error', async () => {
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload') {
        harness.advanceProcessGeneration();
        throw Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' });
      }
      return request(method, params);
    });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
  });

  it('does not overwrite a replacement process status while the old failure is stopping', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({ configChanged: false, secretsChanged: true, secretsReloadError: new Error('invalid credential') });
    harness.stopGateway.mockImplementation(async () => { harness.advanceProcessGeneration(); });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.engineManager.setExternalError).not.toHaveBeenCalled();
    expect(harness.getStatus().phase).toBe('running');
  });

  it('does not accept an ACK from an earlier native lifecycle in the same process', async () => {
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload') {
        harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
        return { ok: true };
      }
      return request(method, params);
    });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it.each(['process', 'lifecycle', 'authentication'])('does not confirm a credential refresh after its %s changes during permission verification', async owner => {
    let sessionId = 'original-session';
    const harness = createHarness({ configChanged: false, secretsChanged: true, getModelAuthSessionId: () => sessionId });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'config.get') {
        if (owner === 'process') harness.advanceProcessGeneration();
        if (owner === 'lifecycle') harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
        if (owner === 'authentication') sessionId = 'replacement-session';
      }
      return request(method, params);
    });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it.each(['process', 'lifecycle', 'authentication'])('does not stop a replacement %s when credential permission verification fails late', async owner => {
    let sessionId = 'original-session';
    const harness = createHarness({ configChanged: false, secretsChanged: true, getModelAuthSessionId: () => sessionId });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'config.get') {
        if (owner === 'process') harness.advanceProcessGeneration();
        if (owner === 'lifecycle') harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
        if (owner === 'authentication') sessionId = 'replacement-session';
        throw new Error('previous process disconnected');
      }
      return request(method, params);
    });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.setExternalError).not.toHaveBeenCalled();
  });

  it.each(
    (['process', 'lifecycle', 'authentication'] as const).flatMap(owner =>
      [false, undefined].flatMap(restartGatewayIfRunning =>
        [false, true].map(reloaded => ({ owner, restartGatewayIfRunning, reloaded })),
      ),
    ),
  )('abandons pending credentials when $owner changes during config reload ($reloaded, restart: $restartGatewayIfRunning)', async ({ owner, restartGatewayIfRunning, reloaded }) => {
    const harness = await createPendingCredentialHarness();
    harness.engineManager.waitForGatewayConfigReload.mockImplementation(async () => {
      harness.replaceOwner(owner);
      return reloaded;
    });

    await expect(harness.service.syncConfig({ reason: 'settings', restartGatewayIfRunning })).resolves.toMatchObject({
      success: false, configSynced: false, error: t('engineConfigApplicationUnconfirmed'),
    });

    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.some(([method]) =>
      ['config.get', 'gateway.restart.request', 'gateway.suspend.prepare'].includes(method),
    )).toBe(false);
  });

  it.each(['process', 'lifecycle', 'authentication'] as const)('does not hard-restart a replacement %s after a late native restart refusal', async owner => {
    const harness = await createPendingCredentialHarness({ waitForReload: false });
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'gateway.restart.request') {
        harness.replaceOwner(owner);
        return { ok: false };
      }
      return harness.request(method, params);
    });

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.restart.request', expect.anything());
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'gateway.suspend.prepare')).toBe(false);
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it.each(['process', 'lifecycle', 'authentication'] as const)('does not use a pending credential suspension after its %s changes', async owner => {
    vi.useFakeTimers();
    const harness = await createPendingCredentialHarness({ waitForReload: false });
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'gateway.suspend.prepare') {
        harness.replaceOwner(owner);
        return { status: 'ready', suspensionId: 'stale-suspension' };
      }
      return harness.request(method, params);
    });

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.suspend.prepare')).toHaveLength(1);
  });

  it.each(
    (['process', 'lifecycle', 'authentication'] as const).flatMap(owner =>
      [false, true].map(failed => ({ owner, failed })),
    ),
  )('does not stop a replacement $owner when credential bridge restore finishes (failed: $failed)', async ({ owner, failed }) => {
    const harness = await createPendingCredentialHarness();
    let current = true;
    harness.connectGatewayClient.mockImplementation(async () => {
      harness.replaceOwner(owner);
      current = false;
      if (failed) throw new Error('old approval bridge disconnected');
    });
    const restore = (harness.service as unknown as {
      restoreGatewayBridgeOrFailClosed: (
        result: { success: boolean; changed: boolean; configSynced: boolean },
        ownership: { isCurrent: () => boolean; ownsProcess: () => boolean },
      ) => Promise<unknown>;
    }).restoreGatewayBridgeOrFailClosed.bind(harness.service);

    await expect(restore({ success: true, changed: true, configSynced: true }, {
      isCurrent: () => current, ownsProcess: () => current,
    })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.setExternalError).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'config.get')).toBe(false);
  });

  it.each(['deferred', 'coalesced', 'scheduled'])('retains pending credential confirmation while its native restart is %s', async nativeRestartStatus => {
    const harness = await createPendingCredentialHarness({ waitForReload: false, nativeRestartStatus });
    harness.engineManager.waitForGatewayReadyAfter.mockResolvedValue(false);

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    harness.configSync.sync.mockReturnValue({ ...harness.published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });

    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.restart.request')).toHaveLength(1);
  });

  it('performs a required hard restart and confirms its new runtime before retired auth cleanup', async () => {
    const harness = await createPendingCredentialHarness({ waitForReload: false });

    await expect(harness.service.syncConfig({ reason: 'settings', retiredProviderIds: ['retired-provider'] })).resolves.toMatchObject({
      success: false, configSynced: false,
    });
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
    harness.configSync.sync.mockReturnValue({ ...harness.published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });

    expect(harness.requestGateway).toHaveBeenCalledWith('models.authLogout', { provider: 'retired-provider', agentId: 'main' });
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
  });

  it.each(['process', 'lifecycle', 'authentication'] as const)('discards a credential deferred restart when its %s changes before idle', async owner => {
    vi.useFakeTimers();
    const harness = await createPendingCredentialHarness({ waitForReload: false, activeWorkloads: true });

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });
    harness.replaceOwner(owner);
    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.suspend.prepare')).toHaveLength(1);
  });

  it('performs a pending credential restart when its own deferred suspension becomes idle', async () => {
    vi.useFakeTimers();
    const harness = await createPendingCredentialHarness({ waitForReload: false, activeWorkloads: true });

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });
    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
    harness.configSync.sync.mockReturnValue({ ...harness.published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });
  });

  it('preserves a required deferred restart across a later unchanged credential sync', async () => {
    vi.useFakeTimers();
    const harness = await createPendingCredentialHarness({ waitForReload: false, activeWorkloads: true });

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });
    harness.configSync.sync.mockReturnValue({ ...harness.published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
  });

  it.each([false, true])('retains hard restart debt after an in-process lifecycle change (new config: %s)', async configChanged => {
    vi.useFakeTimers();
    const harness = await createPendingCredentialHarness({ waitForReload: false, activeWorkloads: true });

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });
    harness.configSync.sync.mockReturnValue({ ...harness.published, changed: configChanged, configChanged, secretsChanged: false });
    harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
    harness.setActiveWorkloads(false);
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'secrets.reload')).toBe(false);
    harness.configSync.sync.mockReturnValue({ ...harness.published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });
  });

  it('does not clean retired auth after a credential owner changes during auth discovery', async () => {
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'models.authStatus') harness.advanceProcessGeneration();
      return request(method, params);
    });
    await expect(harness.service.syncConfig({
      reason: 'provider-key-change', retiredProviderIds: ['retired-provider'],
    })).resolves.toMatchObject({ success: false });
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('abandons reconnection when another process takes over its pending handshake', async () => {
    const harness = createHarness({ configChanged: false, secretsChanged: true, getGatewayClient: () => null });
    let connected!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { connected = resolve; });
    const handshake = new Promise<void>(resolve => { release = resolve; });
    harness.connectGatewayClient.mockImplementation(async () => { connected(); await handshake; });
    const sync = harness.service.syncConfig({ reason: 'auth-login' });
    await started;
    harness.advanceProcessGeneration();
    release();
    await expect(sync).resolves.toMatchObject({ success: false });
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'secrets.reload')).toBe(false);
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('reconnects the same process after a temporary credential transport failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let client: GatewayClientLike | null = null;
    const harness = createHarness({ configChanged: false, secretsChanged: true, getGatewayClient: () => client });
    const connectedClient = { request: harness.requestGateway } as unknown as GatewayClientLike;
    client = connectedClient;
    harness.connectGatewayClient.mockImplementation(async () => { client = connectedClient; });
    const request = harness.requestGateway.getMockImplementation()!;
    let attempts = 0;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'secrets.reload' && ++attempts === 1) {
        client = null;
        throw new Error('gateway client stopped');
      }
      return request(method, params);
    });
    const sync = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(sync).resolves.toMatchObject({ success: true });
    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('does not retry or restart a Gateway stopped during credential reload backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({
      configChanged: false, secretsChanged: true,
      secretsReloadError: Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' }),
    });
    const sync = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(0);
    harness.setPhase('ready');
    await vi.advanceTimersByTimeAsync(500);
    await expect(sync).resolves.toMatchObject({ success: false });
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('keeps the reload unconfirmed if permission initialization after recovery fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({ configChanged: false, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    let recovering = false;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (!recovering && method === 'secrets.reload') {
        throw Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' });
      }
      if (recovering && method === 'config.get') return {
        config: {
          agents: { entries: { main: {} } },
          tools: { exec: { host: 'local', mode: 'full' }, fs: { workspaceOnly: true } },
        },
      };
      return request(method, params);
    });
    const failed = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).resolves.toMatchObject({ success: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    recovering = true;
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.getStatus().phase).toBe('error');
  });

  it('does not turn a failed recovery startup into success on a subsequent unchanged sync', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({
      configChanged: false, secretsChanged: true,
      secretsReloadError: Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' }),
    });
    const failed = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).resolves.toMatchObject({ success: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    harness.startGateway.mockRejectedValueOnce(new Error('startup unavailable'));
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.startGateway).toHaveBeenCalledOnce();
  });

  it('does not create an automatic recovery ticket when the Gateway stop was unconfirmed', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({
      configChanged: false, secretsChanged: true,
      secretsReloadError: Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' }),
    });
    harness.stopGateway.mockRejectedValueOnce(new Error('stop unavailable'));
    const failed = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).resolves.toMatchObject({ success: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('does not revive a user-stopped runtime from an earlier credential failure ticket', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({
      configChanged: false, secretsChanged: true,
      secretsReloadError: Object.assign(new Error('secrets.reload failed'), { gatewayCode: 'UNAVAILABLE' }),
    });
    const failed = harness.service.syncConfig({ reason: 'auth-login' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).resolves.toMatchObject({ success: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, secretsChanged: false });
    harness.setPhase('ready');
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('uses the config watcher for a newly added provider and its credential', async () => {
    const harness = createHarness({ configChanged: true, secretsChanged: true });
    await expect(harness.service.syncConfig({ reason: 'provider-add' })).resolves.toMatchObject({ success: true });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledOnce();
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledWith(7, resolveManagedCredentialReloadTimeoutMs());
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('waits for the applied source revision before reloading mixed config and credential changes', async () => {
    const events: string[] = [];
    const harness = createHarness({ configChanged: true, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.engineManager.waitForGatewayConfigReload.mockImplementation(async () => {
      events.push('watcher-applied');
      return true;
    });
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'config.get' || method === 'secrets.reload') events.push(method);
      return request(method, params);
    });

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });

    expect(events.slice(0, 3)).toEqual(['watcher-applied', 'config.get', 'secrets.reload']);
    expect(events[3]).toBe('config.get');
  });

  it.each(['process', 'lifecycle', 'authentication'] as const)('abandons config publication when its %s changes during the permission preflight', async owner => {
    let sessionId = 'original-session';
    let supersede = true;
    const harness = createHarness({ configChanged: true, secretsChanged: true, getModelAuthSessionId: () => sessionId });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'exec.approvals.get' && supersede) {
        supersede = false;
        if (owner === 'process') harness.advanceProcessGeneration();
        if (owner === 'lifecycle') harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
        if (owner === 'authentication') sessionId = 'replacement-session';
      }
      return request(method, params);
    });

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.requestGateway.mock.calls.some(([method]) => ['exec.approvals.set', 'config.get', 'secrets.reload'].includes(method))).toBe(false);
    expect(harness.stopGateway).not.toHaveBeenCalled();
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });

    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'exec.approvals.set')).toHaveLength(1);
  });

  it.each([
    { configRevisionHash: undefined, appliedConfigHash: undefined },
    { configRevisionHash: '', appliedConfigHash: '' },
    { configRevisionHash: 'desired-source', appliedConfigHash: null },
    { configRevisionHash: 'desired-source', appliedConfigHash: 'previous-source' },
  ])('retains mixed credential debt until runtime revisions match: %j', async revisions => {
    const harness = createHarness({ configChanged: true, secretsChanged: true });
    const request = harness.requestGateway.getMockImplementation()!;
    let applied = false;
    harness.requestGateway.mockImplementation(async (method, params) => {
      const response = await request(method, params);
      return method === 'config.get' && !applied ? { ...response, ...revisions } : response;
    });

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'secrets.reload')).toBe(false);
    applied = true;
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });

    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
    expect(harness.engineManager.waitForGatewayConfigReload.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [7, resolveManagedCredentialReloadTimeoutMs()]),
    );
  });

  it.each(['deferred', 'coalesced', 'scheduled'])('does not reload an old source while a mixed credential restart is %s', async nativeRestartStatus => {
    const harness = createHarness({ configChanged: true, secretsChanged: true, waitForReload: false, nativeRestartStatus });
    harness.engineManager.waitForGatewayReadyAfter.mockResolvedValue(false);

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    expect(harness.requestGateway.mock.calls.some(([method]) => ['config.get', 'secrets.reload'].includes(method))).toBe(false);
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.restart.request')).toHaveLength(1);
    harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });

    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('does not repeat an uncertain native restart or borrow a disk snapshot for mixed credentials', async () => {
    const harness = createHarness({
      configChanged: true, secretsChanged: true, waitForReload: false,
      nativeRestartError: new Error('request timed out'),
    });
    harness.engineManager.waitForGatewayReadyAfter.mockResolvedValue(false);

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.restart.request')).toHaveLength(1);
    expect(harness.requestGateway.mock.calls.some(([method]) => ['config.get', 'secrets.reload'].includes(method))).toBe(false);
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('keeps a mixed source application debt when another credential rotates before readiness', async () => {
    const harness = createHarness({ configChanged: true, secretsChanged: true, waitForReload: false, nativeRestartStatus: 'deferred' });
    harness.engineManager.waitForGatewayReadyAfter.mockResolvedValue(false);

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, configChanged: false, secretsChanged: true });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.requestGateway.mock.calls.some(([method]) => ['config.get', 'secrets.reload'].includes(method))).toBe(false);
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.restart.request')).toHaveLength(1);
  });

  it('retains an accepted native restart owner when mixed config is published again', async () => {
    const harness = createHarness({ configChanged: true, secretsChanged: true, waitForReload: false, nativeRestartStatus: 'deferred' });
    harness.engineManager.waitForGatewayReadyAfter.mockResolvedValue(false);

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });
    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, configChanged: true, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.restart.request')).toHaveLength(1);
    expect(harness.requestGateway.mock.calls.some(([method]) => ['config.get', 'secrets.reload'].includes(method))).toBe(false);
  });

  it.each(['deferred', 'unconfirmed'] as const)('waits for a %s native restart before applying a later launch environment', async nativeOutcome => {
    const harness = createHarness({
      configChanged: true, secretsChanged: true, waitForReload: false,
      ...(nativeOutcome === 'deferred'
        ? { nativeRestartStatus: 'deferred' }
        : { nativeRestartError: new Error('request timed out') }),
    });
    harness.engineManager.waitForGatewayReadyAfter.mockResolvedValue(false);
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });

    const published = harness.configSync.sync.getMockImplementation()!();
    harness.configSync.sync.mockReturnValue({ ...published, configChanged: true, secretsChanged: false });
    const nextEnvironment = { MODEL_RUNTIME_SETTING: 'next-value' };
    harness.configSync.collectGatewayLaunchEnvVars.mockReturnValue(nextEnvironment);
    harness.engineManager.hasPendingGatewayLaunchEnvironmentChanges.mockReturnValue(true);

    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.engineManager.waitForGatewayReadyAfter).toHaveBeenCalledWith(1, resolveManagedCredentialReloadTimeoutMs());
    expect(harness.requestGateway.mock.calls.some(([method]) => ['gateway.suspend.prepare', 'secrets.reload'].includes(method))).toBe(false);
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();

    harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
    harness.engineManager.getGatewayLaunchEnvVars.mockReturnValue(nextEnvironment);
    harness.configSync.sync.mockReturnValue({ ...published, changed: false, configChanged: false, secretsChanged: false });
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false });
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();

    harness.engineManager.hasPendingGatewayLaunchEnvironmentChanges.mockReturnValue(false);
    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: true });
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'gateway.restart.request')).toHaveLength(1);
    expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
  });

  it.each(['process', 'lifecycle', 'authentication'] as const)('does not accept mixed source revisions after their %s changes', async owner => {
    let sessionId = 'original-session';
    const harness = createHarness({ configChanged: true, secretsChanged: true, getModelAuthSessionId: () => sessionId });
    const request = harness.requestGateway.getMockImplementation()!;
    harness.requestGateway.mockImplementation(async (method, params) => {
      if (method === 'config.get') {
        if (owner === 'process') harness.advanceProcessGeneration();
        if (owner === 'lifecycle') harness.engineManager.getGatewayLifecycleGeneration.mockReturnValue(2);
        if (owner === 'authentication') sessionId = 'replacement-session';
      }
      return request(method, params);
    });

    await expect(harness.service.syncConfig({ reason: 'auth-login' })).resolves.toMatchObject({ success: false, configSynced: false });

    expect(harness.requestGateway.mock.calls.some(([method]) => method === 'secrets.reload')).toBe(false);
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('cleans retired provider auth profiles through the Gateway without failing the config sync', async () => {
    const harness = createHarness();

    await expect(
      harness.service.syncConfig({ reason: 'provider-remove', retiredProviderIds: ['OldProxy'] }),
    ).resolves.toMatchObject({ success: true });

    expect(harness.requestGateway).toHaveBeenCalledWith('models.authLogout', {
      provider: 'oldproxy',
      agentId: 'main',
    });
  });

  it('reconciles unresolved managed auth profiles left by an earlier app version', async () => {
    const harness = createHarness();
    harness.requestGateway.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'models.authStatus') {
        return {
          providers: [
            {
              provider: 'mymodel',
              profiles: [
                {
                  profileId: 'mymodel:default',
                  type: 'api_key',
                  // OpenClaw treats a legacy ${ENV_VAR} string as statically
                  // configured here even when the Secrets subsystem cannot
                  // resolve it during startup.
                  status: 'static',
                  source: 'inherited',
                },
              ],
            },
            {
              provider: 'manual-provider',
              profiles: [
                {
                  profileId: 'manual-provider:personal',
                  type: 'oauth',
                  status: 'expired',
                  source: 'saved',
                },
              ],
            },
          ],
        };
      }
      if (method === 'models.authLogout') {
        return { removedProfiles: [`${(params as { provider: string }).provider}:default`] };
      }
      if (method === 'exec.approvals.get') {
        return {
          hash: 'approval-hash',
          file: {
            version: 1,
            defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
            agents: {},
          },
        };
      }
      if (method === 'config.get') {
        return {
          config: {
            models: { providers: { builtin_models: { models: [{ id: 'hdp/Glm-5.1' }] } } },
            agents: {
              entries: { main: {} },
            },
            tools: {
              exec: { host: 'gateway', mode: 'ask' },
              fs: { workspaceOnly: true },
            },
          },
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });

    await expect(harness.service.syncConfig({ reason: 'startup' })).resolves.toMatchObject({
      success: true,
    });
    expect(harness.requestGateway).toHaveBeenCalledWith('models.authLogout', {
      provider: 'mymodel',
      agentId: 'main',
    });
    expect(harness.requestGateway).not.toHaveBeenCalledWith('models.authLogout', {
      provider: 'manual-provider',
      agentId: 'main',
    });
  });

  it('keeps a failed retired provider cleanup pending for the next verified sync', async () => {
    const harness = createHarness({ authLogoutFails: true });

    await expect(
      harness.service.syncConfig({ reason: 'provider-remove', retiredProviderIds: ['oldproxy'] }),
    ).resolves.toMatchObject({ success: true });
    harness.requestGateway.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'models.authLogout') {
        return { removedProfiles: [`${(params as { provider: string }).provider}:default`] };
      }
      if (method === 'exec.approvals.get') {
        return {
          hash: 'approval-hash',
          file: {
            version: 1,
            defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
            agents: {},
          },
        };
      }
      if (method === 'config.get') {
        return {
          config: {
            agents: {
              entries: { main: {} },
            },
            tools: {
              exec: { host: 'gateway', mode: 'ask' },
              fs: { workspaceOnly: true },
            },
          },
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });

    await expect(harness.service.verifyActivePermissionPolicy()).resolves.toMatchObject({
      success: true,
    });
    expect(
      harness.requestGateway.mock.calls.filter(([method]) => method === 'models.authLogout'),
    ).toHaveLength(2);
  });

  it('cancels pending auth cleanup when a provider is restored by config rollback', async () => {
    const harness = createHarness({ authLogoutFails: true });

    await expect(
      harness.service.syncConfig({ reason: 'provider-remove', retiredProviderIds: ['oldproxy'] }),
    ).resolves.toMatchObject({ success: true });
    harness.requestGateway.mockImplementation(async (method: string) => {
      if (method === 'models.authStatus') return { providers: [] };
      if (method === 'models.authLogout') return { removedProfiles: ['oldproxy:default'] };
      if (method === 'exec.approvals.get') {
        return {
          hash: 'approval-hash',
          file: {
            version: 1,
            defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
            agents: {},
          },
        };
      }
      if (method === 'config.get') {
        return {
          config: {
            models: { providers: { oldproxy: { models: [{ id: 'restored-model' }] } } },
            agents: {
              entries: { main: {} },
            },
            tools: {
              exec: { host: 'gateway', mode: 'ask' },
              fs: { workspaceOnly: true },
            },
          },
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });

    await expect(harness.service.verifyActivePermissionPolicy()).resolves.toMatchObject({
      success: true,
    });
    expect(
      harness.requestGateway.mock.calls.filter(([method]) => method === 'models.authLogout'),
    ).toHaveLength(1);
  });

  it('does not restart for reordered provider environment variables', async () => {
    const harness = createHarness({
      previousSecrets: { FIRST: 'one', SECOND: 'two' },
      nextSecrets: { SECOND: 'two', FIRST: 'one' },
    });
    await expect(harness.service.syncConfig({ reason: 'providers' })).resolves.toMatchObject({ success: true });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledOnce();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('hot-reloads settings saved during startup after that startup completes', async () => {
    const harness = createHarness({ phase: 'starting' });
    await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: true });
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledOnce();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it.each(['extension-config-change', 'extension-status-change', 'extension-import', 'extension-delete'])(
    'restores the approval bridge after a %s in-process restart',
    async reason => {
      const harness = createHarness({ nativeRestartStatus: 'scheduled' });
      await expect(harness.service.restartGatewayAfterExclusiveMutation(reason)).resolves.toMatchObject({ phase: 'running' });
      expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
      expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    },
  );

  it('keeps proxy changes on the cold restart path when the child has no reusable local route', async () => {
    const harness = createHarness({ nativeRestartStatus: 'scheduled' });
    await harness.service.restartGatewayAfterExclusiveMutation('proxy-change');
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('gateway.restart.request', expect.anything());
  });

  it.each(['running', 'starting'] as const)('hot-applies proxy preferences through an existing local route in %s', async phase => {
    const harness = createHarness({ phase, reusableNetworkEnvironment: true });
    await harness.service.restartGatewayAfterExclusiveMutation('proxy-change');
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).toHaveBeenCalledTimes(phase === 'starting' ? 1 : 0);
  });

  it.each(['config', 'extension'])('does not repeat a %s restart with an unknown request outcome', async kind => {
    const harness = createHarness({ waitForReload: false, nativeRestartError: new Error('request timed out') });
    if (kind === 'config') {
      await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
        success: false, configSynced: true, error: t('engineConfigApplicationUnconfirmed'),
      });
    } else {
      await expect(harness.service.restartGatewayAfterExclusiveMutation('extension-config-change')).rejects.toThrow(t('engineRestartUnconfirmed'));
    }
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('gateway.suspend.prepare', expect.anything());
  });

  it('keeps extension network policy changes on the cold restart path', async () => {
    const harness = createHarness({ nativeRestartStatus: 'scheduled' });
    await harness.service.restartGatewayAfterExclusiveMutation('extension-network-policy-change');
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('gateway.restart.request', expect.anything());
  });

  it.each(['scheduled', 'deferred', 'coalesced'])('uses a %s native restart after reload failure', async nativeRestartStatus => {
    const harness = createHarness({ waitForReload: false, nativeRestartStatus });
    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({ success: true });
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('gateway.suspend.prepare', expect.anything());
    if (nativeRestartStatus === 'scheduled') expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
  });

  it('falls back to a hard restart when both native reload and restart RPC fail', async () => {
    const harness = createHarness({ waitForReload: false });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      changed: true,
    });
    expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.suspend.prepare', {
      requestId: 'justdo-config-restart-1',
      terminalPolicy: 'preserve',
    });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.engineManager.restartGateway.mock.calls).toEqual([[]]);
    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
  });

  it('fails closed when the approval event bridge cannot reconnect after restart', async () => {
    const harness = createHarness({ waitForReload: false });
    harness.connectGatewayClient.mockRejectedValueOnce(new Error('bridge unavailable'));

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped'),
    });
    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.disconnectGatewayClient).toHaveBeenCalledTimes(2);
    expect(harness.stopGateway).toHaveBeenCalledTimes(2);
  });

  it('restores the approval event bridge when an errored Gateway is started', async () => {
    const harness = createHarness({ phase: 'error' });
    const restartGatewayOrDefer = (
      harness.service as unknown as {
        restartGatewayOrDefer: (
          reason: string,
          changed: boolean,
          restartAfterInFlightStart: boolean,
        ) => Promise<unknown>;
      }
    ).restartGatewayOrDefer.bind(harness.service);

    await expect(restartGatewayOrDefer('test', true, false)).resolves.toMatchObject({
      success: true,
      configSynced: true,
      status: { phase: 'running' },
    });
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
  });

  it('restores the approval event bridge after an in-flight Gateway start', async () => {
    const harness = createHarness({ phase: 'starting' });
    const restartGatewayOrDefer = (
      harness.service as unknown as {
        restartGatewayOrDefer: (
          reason: string,
          changed: boolean,
          restartAfterInFlightStart: boolean,
        ) => Promise<unknown>;
      }
    ).restartGatewayOrDefer.bind(harness.service);

    await expect(restartGatewayOrDefer('test', true, false)).resolves.toMatchObject({
      success: true,
      configSynced: true,
      status: { phase: 'running' },
    });
    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
  });

  it('stops the Gateway when a hot-only config change cannot be confirmed', async () => {
    const harness = createHarness({ waitForReload: false });

    await expect(
      harness.service.syncConfig({
        reason: 'cowork-config-change',
        restartGatewayIfRunning: false,
      }),
    ).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped'),
    });
    expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('verifies the active runtime fallback and host approval policy after reload', async () => {
    const harness = createHarness({ waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
      hostPolicyVerified: true,
    });
    expect(harness.requestGateway).toHaveBeenCalledWith('exec.approvals.get');
    expect(harness.requestGateway).toHaveBeenCalledWith(
      'exec.approvals.set',
      expect.objectContaining({ baseHash: 'approval-hash' }),
    );
    expect(harness.requestGateway).toHaveBeenCalledWith('config.get');
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('verifies sandbox execution hosts instead of requiring the local Gateway host', async () => {
    const harness = createHarness({ executionMode: 'sandbox', waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'cowork-config-change' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
      hostPolicyVerified: true,
    });
    expect(harness.stopGateway).not.toHaveBeenCalled();
  });

  it('does not rewrite an already verified approval policy', async () => {
    const harness = createHarness({ waitForReload: true });
    await harness.service.syncConfig({ reason: 'test' });
    harness.requestGateway.mockClear();

    await expect(harness.service.verifyActivePermissionPolicy()).resolves.toMatchObject({
      success: true,
      hostPolicyVerified: true,
    });

    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'config.get',
      'exec.approvals.get',
    ]);
  });

  it('reuses the restricted approval verification when config remains unchanged', async () => {
    const harness = createHarness({ configChanged: false });
    await harness.service.syncConfig({ reason: 'first' });
    harness.requestGateway.mockClear();

    await expect(harness.service.syncConfig({ reason: 'second' })).resolves.toMatchObject({
      success: true,
      hostPolicyVerified: true,
    });

    expect(harness.requestGateway.mock.calls.map(([method]) => method)).toEqual([
      'exec.approvals.get',
      'config.get',
    ]);
  });

  it('applies a restricted host policy before writing and reloading restricted config', async () => {
    const harness = createHarness({ permissionMode: 'ask', waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'cowork-config-change' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });

    const firstApprovalSetOrder = harness.requestGateway.mock.invocationCallOrder.find(
      (_order, index) => harness.requestGateway.mock.calls[index]?.[0] === 'exec.approvals.set',
    );
    expect(firstApprovalSetOrder).toBeDefined();
    expect(firstApprovalSetOrder).toBeLessThan(harness.configSync.sync.mock.invocationCallOrder[0]);
  });

  it('serializes all config sync callers inside the service', async () => {
    const harness = createHarness();
    let releaseFirst: ((result: { success: boolean; changed: boolean; configSynced: boolean }) => void)
      | undefined;
    const firstResult = new Promise<{
      success: boolean;
      changed: boolean;
      configSynced: boolean;
    }>(resolve => {
      releaseFirst = resolve;
    });
    const internals = harness.service as unknown as {
      syncConfigExclusive: (options: { reason: string }) => Promise<{
        success: boolean;
        changed: boolean;
        configSynced: boolean;
      }>;
    };
    const exclusive = vi
      .spyOn(internals, 'syncConfigExclusive')
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce({ success: true, changed: true, configSynced: true });

    const first = harness.service.syncConfig({ reason: 'first' });
    const second = harness.service.syncConfig({ reason: 'second' });
    await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(1));

    releaseFirst?.({ success: true, changed: true, configSynced: true });
    await first;
    await second;
    expect(exclusive).toHaveBeenNthCalledWith(2, { reason: 'second' });
  });

  it('removes legacy allow-always grants while preserving manually managed allowlist entries', async () => {
    const harness = createHarness({ waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });

    expect(harness.requestGateway).toHaveBeenCalledWith(
      'exec.approvals.set',
      expect.objectContaining({
        file: expect.objectContaining({
          agents: expect.objectContaining({
            helper: expect.objectContaining({
              security: 'allowlist',
              ask: 'on-miss',
              askFallback: 'deny',
              allowlist: [{ pattern: 'git diff', source: 'manual' }],
            }),
          }),
        }),
      }),
    );
  });

  it('fails closed when the runtime reports an unsafe global fallback mode', async () => {
    const harness = createHarness({ permissionMode: 'full', reportedPermissionMode: 'full' });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped'),
    });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('verifies runtime permissions without requiring a dedicated task agent', async () => {
    const harness = createHarness({ permissionMode: 'ask' });
    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });
    expect(harness.stopGateway).not.toHaveBeenCalled();
    const approvalWrite = harness.requestGateway.mock.calls.find(
      ([method]) => method === 'exec.approvals.set',
    );
    const policy = approvalWrite?.[1] as { file: { agents: Record<string, unknown> } };
    expect(Object.keys(policy.file.agents)).toEqual(['helper']);
  });

  it.each(['running', 'ready'] as const)(
    'fails closed from %s when the initial config write cannot be confirmed',
    async phase => {
      const harness = createHarness({ phase, syncError: 'disk full' });

      await expect(harness.service.syncConfig({ reason: 'startup' })).resolves.toMatchObject({
        success: false,
        configSynced: false,
        error: expect.stringContaining('active runtime safety state was not confirmed'),
      });
      expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
      expect(harness.stopGateway).toHaveBeenCalledOnce();
      expect(harness.startGateway).not.toHaveBeenCalled();
    },
  );

  it('waits for an in-flight start then restarts when secrets changed', async () => {
    const harness = createHarness({
      phase: 'starting',
      nextSecrets: { API_TOKEN: 'changed' },
    });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      changed: true,
    });
    expect(harness.startGateway).toHaveBeenCalledTimes(2);
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it.each([false, true])('preserves a still-starting native snapshot after joining its observation (restarting: %s)', async restarting => {
    const harness = createHarness({ phase: EnginePhase.Starting });
    harness.getStatus.mockImplementation(() => ({ ...runningStatus, phase: EnginePhase.Starting,
      ...(restarting ? { restarting: true } : {}) }));
    // The current owner, rather than an earlier returned result, controls publication.
    harness.startGateway.mockResolvedValueOnce(runningStatus);

    await expect(harness.service.syncConfig({ reason: 'settings', discoverExternalMcpServers: false }))
      .resolves.toMatchObject({
        success: false, changed: false, configSynced: false,
        status: { phase: EnginePhase.Starting }, error: t('engineConfigApplicationUnconfirmed'),
      });

    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.configSync.sync).not.toHaveBeenCalled();
    expect(harness.configSync.collectGatewayLaunchEnvVars).not.toHaveBeenCalled();
    expect(harness.engineManager.setGatewayLaunchEnvVars).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
  });

  it('keeps logout cleanup independent of a pending native startup observation', async () => {
    const harness = createHarness({ phase: EnginePhase.Starting, syncError: 'logout publication failed' });

    await expect(harness.service.syncConfig({ reason: BuiltinModelSyncReason.AuthLogout,
      discoverExternalMcpServers: false })).resolves.toMatchObject({
      success: false, configSynced: false, error: expect.stringContaining('logout publication failed'),
    });

    expect(harness.startGateway).not.toHaveBeenCalled();
    expect(harness.configSync.sync).toHaveBeenCalledOnce();
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
  });

  it('does not revive a Gateway stopped while a hard restart is deferred', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      activeWorkloads: true,
      nextSecrets: { API_TOKEN: 'changed' },
    });

    await harness.service.syncConfig({ reason: 'test' });
    harness.setPhase('ready');
    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('fails a browser provider switch instead of reporting a deferred restart as complete', async () => {
    const harness = createHarness({ activeWorkloads: true });
    const restartGatewayOrDefer = (
      harness.service as unknown as {
        restartGatewayOrDefer: (
          reason: string,
          changed: boolean,
          restartAfterInFlightStart: boolean,
        ) => Promise<unknown>;
      }
    ).restartGatewayOrDefer.bind(harness.service);

    await expect(
      restartGatewayOrDefer('browser-mode-change', true, false),
    ).resolves.toMatchObject({
      success: false,
      configSynced: true,
      error: expect.stringContaining('could not be switched'),
    });
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('stops the Gateway when a browser provider rollback cannot restart immediately', async () => {
    const harness = createHarness({ activeWorkloads: true });
    const restartGatewayOrDefer = (
      harness.service as unknown as {
        restartGatewayOrDefer: (
          reason: string,
          changed: boolean,
          restartAfterInFlightStart: boolean,
        ) => Promise<unknown>;
      }
    ).restartGatewayOrDefer.bind(harness.service);

    await expect(
      restartGatewayOrDefer('browser-mode-rollback', true, false),
    ).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped to fail closed'),
    });
    expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.engineManager.setExternalError).toHaveBeenCalledOnce();
  });

  it('keeps a hard restart deferred for as long as active workloads remain', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      activeWorkloads: true,
      nextSecrets: { API_TOKEN: 'changed' },
    });

    await harness.service.syncConfig({ reason: 'test' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();

    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
  });

  it('awaits the native suspension barrier before performing a deferred restart', async () => {
    vi.useFakeTimers();
    let activeWorkloads = true;
    const harness = createHarness({
      nextSecrets: { API_TOKEN: 'changed' },
      prepareGatewaySuspend: async () =>
        activeWorkloads
          ? { status: 'busy' }
          : { status: 'ready', suspensionId: 'suspension-async' },
    });

    await harness.service.syncConfig({ reason: 'test' });
    activeWorkloads = false;
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
  });

  it('does not apply an old suspension lease to a newer Gateway generation', async () => {
    vi.useFakeTimers();
    let releaseSuspension!: () => void;
    const suspension = new Promise<{ status: 'ready'; suspensionId: string }>(resolve => {
      releaseSuspension = () => resolve({ status: 'ready', suspensionId: 'stale-suspension' });
    });
    let suspensionAttempt = 0;
    const harness = createHarness({
      nextSecrets: { API_TOKEN: 'changed' },
      prepareGatewaySuspend: () => {
        suspensionAttempt += 1;
        return suspensionAttempt === 1
          ? suspension
          : { status: 'ready', suspensionId: 'current-suspension' };
      },
    });

    const sync = harness.service.syncConfig({ reason: 'test' });
    await vi.waitFor(() =>
      expect(harness.requestGateway).toHaveBeenCalledWith(
        'gateway.suspend.prepare',
        expect.any(Object),
      ),
    );
    harness.advanceProcessGeneration();
    releaseSuspension();

    await expect(sync).resolves.toMatchObject({ success: true });
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.suspend.prepare', {
      requestId: 'justdo-config-restart-2',
      terminalPolicy: 'preserve',
    });
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
  });

  it('does not stop or mutate a replacement Gateway with an old directory suspension', async () => {
    const harness = createHarness();
    const operation = vi.fn(async () => managedDirectorySuccess(undefined));
    const coordinator = new ManagedDirectoryOperationCoordinator({
      runtime: {
        isRunning: () => harness.engineManager.getStatus().phase === 'running',
        ownsProcess: pid => pid === 4242,
        prepareStop: async () => {
          const preparation = await harness.service.prepareGatewayStopAfterExclusiveMutation(
            'directory-test',
          );
          harness.advanceProcessGeneration();
          return preparation;
        },
        stop: token => harness.service.stopGatewayAfterExclusiveMutation(token),
        start: token => harness.service.startGatewayAfterExclusiveMutation(token),
      },
      findLockingProcesses: vi.fn(async () => ({
        available: true,
        processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
      })),
    });

    const result = await coordinator.execute({
      operation,
      resourceName: 'extension directory',
      targetPath: 'C:\\extensions\\demo',
      manageRuntimeOnLock: true,
      preflightLockCheck: true,
    });

    expect(result.success).toBe(false);
    expect(operation).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('resumes the admission fence when a prepared directory stop leaves the Gateway running', async () => {
    const harness = createHarness();
    harness.stopGateway.mockRejectedValueOnce(new Error('stop acknowledgement failed'));
    const preparation = await harness.service.prepareGatewayStopAfterExclusiveMutation(
      'directory-test',
    );
    expect(preparation.ready).toBe(true);
    if (!preparation.ready) return;

    await expect(
      harness.service.stopGatewayAfterExclusiveMutation(preparation.token),
    ).rejects.toThrow('could not be stopped safely');

    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.suspend.resume', {
      suspensionId: 'suspension-1',
    });
    expect(harness.connectGatewayClient).not.toHaveBeenCalled();
    expect(harness.disconnectGatewayClient).not.toHaveBeenCalled();
  });

  it('coalesces an old deferred intent with an immediate restart of the same process', async () => {
    vi.useFakeTimers();
    let suspensionAttempt = 0;
    const harness = createHarness({
      nextSecrets: { API_TOKEN: 'changed' },
      prepareGatewaySuspend: () => {
        suspensionAttempt += 1;
        return suspensionAttempt === 1
          ? { status: 'busy' }
          : { status: 'ready', suspensionId: 'immediate-suspension' };
      },
    });

    await harness.service.syncConfig({ reason: 'deferred-change' });
    await harness.service.restartGatewayWhenIdle('immediate-change');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
  });

  it('serializes deferred restart polling behind config mutations', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      activeWorkloads: true,
      nextSecrets: { API_TOKEN: 'changed' },
    });
    await harness.service.syncConfig({ reason: 'deferred-change' });

    let releaseMutation!: () => void;
    const mutation = harness.service.runConfigMutationExclusive(
      () =>
        new Promise<void>(resolve => {
          releaseMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(releaseMutation).toBeTypeOf('function'));
    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    releaseMutation();
    await mutation;
    await vi.waitFor(() => expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce());
  });

  it('keeps the restart deferred when the native suspension barrier is unavailable', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      nextSecrets: { API_TOKEN: 'changed' },
      prepareGatewaySuspend: async () => {
        throw new Error('Gateway unavailable');
      },
    });

    await harness.service.syncConfig({ reason: 'test' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('fails closed when the approval bridge cannot reconnect after a deferred restart', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      activeWorkloads: true,
      nextSecrets: { API_TOKEN: 'changed' },
    });
    harness.connectGatewayClient.mockRejectedValueOnce(new Error('bridge unavailable'));

    await harness.service.syncConfig({ reason: 'test' });
    harness.setActiveWorkloads(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.startGateway).toHaveBeenCalledOnce();
    expect(harness.connectGatewayClient).toHaveBeenCalledOnce();
    expect(harness.disconnectGatewayClient).toHaveBeenCalledTimes(2);
    expect(harness.stopGateway).toHaveBeenCalledTimes(2);
    expect(harness.engineManager.setExternalError).toHaveBeenCalledWith(
      expect.stringContaining('Gateway was stopped'),
    );
  });

  it('rejects logout before changing secrets or restarting when the file still has built-in config', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-logout-verification-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            builtin_models: {
              apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}',
            },
          },
        },
      }),
      'utf8',
    );
    const harness = createHarness({ configPath });

    try {
      await expect(
        harness.service.syncConfig({ reason: 'auth-logout' }),
      ).resolves.toMatchObject({
        success: false,
        configSynced: false,
        error: expect.stringContaining('built-in authentication placeholder remains'),
      });
      expect(harness.engineManager.setGatewayLaunchEnvVars).not.toHaveBeenCalled();
      expect(harness.stopGateway).toHaveBeenCalledOnce();
      expect(harness.startGateway).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([null, 'original-session'])('discards a credential recovery ticket on logout for auth session %s', async authSessionId => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-logout-recovery-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({ models: {}, memory: { search: { enabled: false } } }), 'utf8');
    const harness = createHarness({
      configPath, configChanged: false, secretsChanged: true,
      getModelAuthSessionId: () => authSessionId,
      secretsReloadError: Object.assign(new Error('secret resolver unavailable'), { gatewayCode: 'UNAVAILABLE' }),
    });

    try {
      const failure = harness.service.syncConfig({ reason: 'auth-login' });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(failure).resolves.toMatchObject({ success: false });
      const published = harness.configSync.sync.getMockImplementation()!();
      harness.configSync.sync.mockReturnValue({ ...published, changed: false, configChanged: false, secretsChanged: false });

      await expect(harness.service.syncConfig({ reason: 'auth-logout' })).resolves.toMatchObject({ success: true });

      expect(harness.startGateway).not.toHaveBeenCalled();
      expect(harness.stopGateway).toHaveBeenCalledOnce();
      expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('reloads secret-only logout cleanup without a recovery ticket (failed: %s)', async failed => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-logout-secrets-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({ models: {}, memory: { search: { enabled: false } } }), 'utf8');
    const harness = createHarness({
      configPath, configChanged: false, secretsChanged: true,
      getModelAuthSessionId: () => null,
      secretsReloadError: failed ? Object.assign(new Error('native refusal'), { gatewayCode: 'FORBIDDEN' }) : undefined,
    });

    try {
      await expect(harness.service.syncConfig({ reason: 'auth-logout' })).resolves.toMatchObject({
        success: !failed, configSynced: !failed,
      });
      const published = harness.configSync.sync.getMockImplementation()!();
      harness.configSync.sync.mockReturnValue({ ...published, changed: false, configChanged: false, secretsChanged: false });
      if (failed) {
        await expect(harness.service.syncConfig({ reason: 'settings' })).resolves.toMatchObject({ success: false });
      }
      await expect(harness.service.syncConfig({ reason: 'auth-logout' })).resolves.toMatchObject({ success: true });

      expect(harness.requestGateway.mock.calls.filter(([method]) => method === 'secrets.reload')).toHaveLength(1);
      expect(harness.startGateway).not.toHaveBeenCalled();
      expect(harness.stopGateway).toHaveBeenCalledTimes(failed ? 1 : 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('hot-reloads logout config without restarting when secrets are removed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-logout-hot-reload-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {},
        memory: { search: { enabled: false } },
      }),
      'utf8',
    );
    const harness = createHarness({
      configPath,
      waitForReload: true,
    });

    try {
      await expect(
        harness.service.syncConfig({ reason: 'auth-logout' }),
      ).resolves.toMatchObject({
        success: true,
        configSynced: true,
      });
      expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledOnce();
      expect(harness.stopGateway).not.toHaveBeenCalled();
      expect(harness.startGateway).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops the Gateway when logout hot reload times out', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-logout-hot-reload-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {},
        memory: { search: { enabled: false } },
      }),
      'utf8',
    );
    const harness = createHarness({
      configPath,
      waitForReload: false,
    });

    try {
      await expect(
        harness.service.syncConfig({ reason: 'auth-logout' }),
      ).resolves.toMatchObject({
        success: false,
        configSynced: false,
        error: expect.stringContaining('Gateway was stopped to fail closed'),
      });
      expect(harness.disconnectGatewayClient).toHaveBeenCalledOnce();
      expect(harness.stopGateway).toHaveBeenCalledOnce();
      expect(harness.startGateway).not.toHaveBeenCalled();
      expect(harness.engineManager.setExternalError).toHaveBeenCalledWith(
        expect.stringContaining('native reload did not complete'),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

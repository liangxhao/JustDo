import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/filesystem/managedDirectoryOperations';
import { SessionRpc } from '../../engine/gateway/sessionRpc';
import {
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
    syncError?: string;
    nativeRestartStatus?: string;
    secretsChanged?: boolean;
    secretsReloadFails?: boolean;
    authLogoutFails?: boolean;
    executionMode?: 'local' | 'sandbox';
    sandboxReady?: boolean;
  } = {}) => {
    let phase = options.phase ?? 'running';
    let processGeneration = 1;
    let activeWorkloads = options.activeWorkloads ?? false;
    const getStatus = vi.fn(() => ({
      ...runningStatus,
      phase,
    }));
    const startGateway = vi.fn(async () => {
      phase = 'running';
      processGeneration += 1;
      return runningStatus;
    });
    const stopGateway = vi.fn(async () => {
      phase = 'ready';
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
      getGatewayPort: vi.fn(() => 18789),
      getConfiguredGatewayPort: vi.fn(() => 18789),
      waitForGatewayConfigReload: vi.fn(async () => options.waitForReload ?? true),
      getGatewayLaunchEnvVars: vi.fn(() => options.previousSecrets ?? {}),
      setGatewayLaunchEnvVars: vi.fn(),
      getGatewayProcessGeneration: vi.fn(() => processGeneration),
      getDesiredVersion: vi.fn(() => 'v2026.6.11'),
      startGateway,
      stopGateway,
      restartGateway,
      setExternalError: vi.fn((message: string) => {
        phase = 'error';
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
      if (method === 'secrets.reload') {
        if (options.secretsReloadFails) throw new Error('credential reload failed');
        return { ok: true };
      }
      if (method === 'models.authLogout') {
        if (options.authLogoutFails) throw new Error('auth store busy');
        return { removedProfiles: [`${(params as { provider: string }).provider}:default`] };
      }
      if (method === 'models.authStatus') {
        return { providers: [] };
      }
      if (method === 'gateway.restart.request' && options.nativeRestartStatus) {
        return { ok: true, status: options.nativeRestartStatus };
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
          config: {
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
    const service = new OpenClawConfigSyncService({
      getCoworkStore: () => ({
        getConfig: () => ({
          permissionMode: options.permissionMode ?? 'ask',
          executionMode: options.executionMode ?? 'local',
        }),
      }),
      getOpenClawEngineManager: () => engineManager,
      getMcpStore: vi.fn(),
      getHookStore: vi.fn(),
      disconnectGatewayClient,
      connectGatewayClient,
      requestGateway,
      getWindowsSandboxStatus: vi.fn(async () => ({
        code: options.sandboxReady === false ? 'broker_unavailable' : 'ready',
        supported: true,
        helperAvailable: true,
        initialized: options.sandboxReady !== false,
        ready: options.sandboxReady !== false,
      })),
      getWindowsSandboxEnvironment: vi.fn(() => ({})),
    } as never);
    const configSync = {
      sync: vi.fn(() =>
        options.syncError
          ? { ok: false, error: options.syncError }
          : {
              ok: true,
              changed: (options.configChanged ?? true) || (options.secretsChanged ?? false),
              configChanged: options.configChanged ?? true,
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

  it('waits for native hot reload without restarting the Gateway', async () => {
    const harness = createHarness({ waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      changed: true,
    });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledWith(7);
    expect(harness.configSync.sync).toHaveBeenCalledWith('test');
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
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
    expect(harness.configSync.sync).toHaveBeenCalledWith('startup');
  });

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
    expect(harness.requestGateway).toHaveBeenCalledWith('secrets.reload');
    expect(harness.engineManager.waitForGatewayConfigReload).not.toHaveBeenCalled();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
  });

  it('fails closed when the native credential snapshot cannot refresh', async () => {
    const harness = createHarness({ configChanged: false, secretsChanged: true, secretsReloadFails: true });
    await expect(harness.service.syncConfig({ reason: 'provider-key-change' })).resolves.toMatchObject({ success: false });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('uses the config watcher for a newly added provider and its credential', async () => {
    const harness = createHarness({ configChanged: true, secretsChanged: true });
    await expect(harness.service.syncConfig({ reason: 'provider-add' })).resolves.toMatchObject({ success: true });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledOnce();
    expect(harness.engineManager.restartGateway).not.toHaveBeenCalled();
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

  it('keeps proxy changes on the cold restart path', async () => {
    const harness = createHarness({ nativeRestartStatus: 'scheduled' });
    await harness.service.restartGatewayAfterExclusiveMutation('proxy-change');
    expect(harness.engineManager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway).not.toHaveBeenCalledWith('gateway.restart.request', expect.anything());
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

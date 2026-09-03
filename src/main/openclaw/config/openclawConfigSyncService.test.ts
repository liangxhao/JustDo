import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/managedDirectoryOperations';
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
  it('preserves an available session-specific model instead of replacing it with the agent model', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:justdo:session-1',
              modelProvider: 'newproxy',
              model: 'agent-model',
            },
          ],
          hasMore: false,
        };
      }
      if (method === 'sessions.patch') return { ok: true };
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const service = new OpenClawConfigSyncService({
      getCoworkStore: () => ({
        getSessionModelRef: (id: string) =>
          id === 'session-1' ? 'newproxy/session-model' : null,
      }),
      requestGateway,
    } as never);
    const syncManagedSessionModelsViaGateway = (
      service as unknown as {
        syncManagedSessionModelsViaGateway: (snapshot: unknown) => Promise<void>;
      }
    ).syncManagedSessionModelsViaGateway.bind(service);

    await syncManagedSessionModelsViaGateway({
      config: {
        models: {
          providers: {
            newproxy: {
              models: [{ id: 'agent-model' }, { id: 'session-model' }],
            },
          },
        },
        agents: {
          defaults: { model: { primary: 'newproxy/agent-model' } },
          entries: {
            main: { model: { primary: 'newproxy/agent-model' } },
          },
        },
      },
    });

    expect(requestGateway).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:justdo:session-1',
      model: 'newproxy/session-model',
    });
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
    reportedSchedulerMode?: 'ask' | 'auto' | 'full';
    configChanged?: boolean;
    syncError?: string;
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
        return {
          config: {
            agents: {
              entries: {
                'justdo-scheduler': {
                  tools: {
                    exec: {
                      host: 'gateway',
                      mode: options.reportedSchedulerMode ?? 'full',
                    },
                    fs: { workspaceOnly: (options.reportedSchedulerMode ?? 'full') !== 'full' },
                  },
                },
              },
            },
            tools: {
              exec: { host: 'gateway', mode: permissionMode },
              fs: { workspaceOnly: permissionMode !== 'full' },
            },
          },
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const service = new OpenClawConfigSyncService({
      getCoworkStore: () => ({
        getConfig: () => ({ permissionMode: options.permissionMode ?? 'ask' }),
      }),
      getOpenClawEngineManager: () => engineManager,
      getMcpStore: vi.fn(),
      getHookStore: vi.fn(),
      disconnectGatewayClient,
      connectGatewayClient,
      requestGateway,
    } as never);
    const configSync = {
      sync: vi.fn(() =>
        options.syncError
          ? { ok: false, error: options.syncError }
          : {
              ok: true,
              changed: options.configChanged ?? true,
              configChanged: options.configChanged ?? true,
              requiresGatewayRestart: false,
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

  it('restarts login only when the running Gateway needs the newly added secret', async () => {
    const harness = createHarness({
      nextSecrets: {
        JUSTDO_APIKEY_BUILTIN_MODELS: 'builtin-secret',
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

  it('hot-reloads login when the Gateway already has the same secret environment', async () => {
    const secrets = {
      JUSTDO_APIKEY_BUILTIN_MODELS: 'builtin-secret',
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

  it('falls back to a hard restart when native reload fails', async () => {
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
              allowlist: [{ pattern: 'git diff', source: 'manual' }],
            }),
            'justdo-scheduler': expect.objectContaining({
              security: 'full',
              ask: 'off',
              askFallback: 'full',
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

  it('fails closed when the scheduler agent is not isolated with Full access', async () => {
    const harness = createHarness({ permissionMode: 'ask', reportedSchedulerMode: 'ask' });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped'),
    });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
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
    const harness = createHarness({
      configPath,
      nextSecrets: { JUSTDO_PROVIDER_API_KEY: 'legacy-unused' },
    });

    try {
      await expect(
        harness.service.syncConfig({ reason: 'auth-logout' }),
      ).resolves.toMatchObject({
        success: false,
        configSynced: false,
        error: expect.stringContaining('built-in API key placeholder remains'),
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
      nextSecrets: { JUSTDO_PROVIDER_API_KEY: 'legacy-unused' },
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

  it('does not fall back to a restart when logout hot reload times out', async () => {
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
      nextSecrets: { JUSTDO_PROVIDER_API_KEY: 'legacy-unused' },
    });

    try {
      await expect(
        harness.service.syncConfig({ reason: 'auth-logout' }),
      ).resolves.toMatchObject({
        success: false,
        configSynced: true,
        error: expect.stringContaining('native reload did not complete'),
      });
      expect(harness.stopGateway).not.toHaveBeenCalled();
      expect(harness.startGateway).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

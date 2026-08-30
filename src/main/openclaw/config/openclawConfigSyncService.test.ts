import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
        secretEnvVarsChanged: false,
        requiresGatewayRestart: false,
      }),
    ).toBe('native-reload');
  });

  it('hard-restarts for child-process environment and extension manifest changes', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: true,
        secretEnvVarsChanged: true,
        requiresGatewayRestart: false,
      }),
    ).toBe('hard-restart');
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: false,
        secretEnvVarsChanged: false,
        requiresGatewayRestart: true,
      }),
    ).toBe('hard-restart');
  });

  it('does not restart a stopped Gateway or react to session-store-only changes', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'ready',
        configChanged: true,
        secretEnvVarsChanged: true,
        requiresGatewayRestart: true,
      }),
    ).toBe('none');
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'running',
        configChanged: false,
        secretEnvVarsChanged: false,
        requiresGatewayRestart: false,
      }),
    ).toBe('none');
  });

  it('hard-restarts after an in-flight start when child-process inputs changed', () => {
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'starting',
        configChanged: false,
        secretEnvVarsChanged: true,
        requiresGatewayRestart: false,
      }),
    ).toBe('hard-restart');
    expect(
      resolveOpenClawConfigApplyMode({
        gatewayPhase: 'starting',
        configChanged: true,
        secretEnvVarsChanged: false,
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
    previousSecrets?: Record<string, string>;
    nextSecrets?: Record<string, string>;
    configPath?: string;
    permissionMode?: 'ask' | 'auto' | 'full';
    reportedPermissionMode?: 'ask' | 'auto' | 'full';
    reportedSchedulerMode?: 'ask' | 'auto' | 'full';
    permissionPolicyLoaded?: boolean;
    reportedPolicyMode?: 'ask' | 'auto' | 'full';
    reportedFullAgentIds?: string[];
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
      getSecretEnvVars: vi.fn(() => options.previousSecrets ?? {}),
      setSecretEnvVars: vi.fn(),
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
        const permissionMode = options.reportedPermissionMode ?? options.permissionMode ?? 'ask';
        return {
          config: {
            agents: {
              list: [
                {
                  id: 'justdo-scheduler',
                  tools: {
                    exec: {
                      host: 'gateway',
                      mode: options.reportedSchedulerMode ?? 'full',
                    },
                    fs: { workspaceOnly: (options.reportedSchedulerMode ?? 'full') !== 'full' },
                  },
                },
              ],
            },
            tools: {
              exec: { host: 'gateway', mode: permissionMode },
              fs: { workspaceOnly: permissionMode !== 'full' },
            },
          },
        };
      }
      if (method === 'actionApproval.info') {
        return {
          loaded: options.permissionPolicyLoaded ?? true,
          adapterVersion: 2,
          configuredMode:
            options.reportedPolicyMode ?? options.reportedPermissionMode ?? options.permissionMode ?? 'ask',
          fullAgentIds: options.reportedFullAgentIds ?? ['justdo-scheduler'],
        };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const service = new OpenClawConfigSyncService({
      getCoworkStore: () => ({
        getConfig: () => ({ permissionMode: options.permissionMode ?? 'ask' }),
      }),
      getOpenClawEngineManager: () => engineManager,
      getAskUserExtensionConfig: vi.fn(),
      getMcpStore: vi.fn(),
      getHookStore: vi.fn(),
      hasActiveGatewayWorkloads: vi.fn(() => activeWorkloads),
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
              changed: true,
              configChanged: true,
              requiresGatewayRestart: false,
              configPath: options.configPath ?? 'openclaw.json',
            },
      ),
      collectSecretEnvVars: vi.fn(() => options.nextSecrets ?? {}),
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
    };
  };

  it('waits for native hot reload without restarting the Gateway', async () => {
    const harness = createHarness({ waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      changed: true,
    });
    expect(harness.engineManager.waitForGatewayConfigReload).toHaveBeenCalledWith(7);
    expect(harness.configSync.sync).toHaveBeenCalledWith('test', {
      allowManagedSessionStoreMutation: false,
    });
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
  });

  it('allows legacy managed-session migration only while the Gateway is stopped', async () => {
    const harness = createHarness({ phase: 'ready' });

    await expect(harness.service.syncConfig({ reason: 'startup' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });
    expect(harness.configSync.sync).toHaveBeenCalledWith('startup', {
      allowManagedSessionStoreMutation: true,
    });
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
    expect(harness.stopGateway).toHaveBeenCalledOnce();
    expect(harness.startGateway).toHaveBeenCalledOnce();
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

  it('verifies the active runtime and compatibility policy after reload', async () => {
    const harness = createHarness({ waitForReload: true });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: true,
      configSynced: true,
    });
    expect(harness.requestGateway).toHaveBeenCalledWith('exec.approvals.get');
    expect(harness.requestGateway).toHaveBeenCalledWith(
      'exec.approvals.set',
      expect.objectContaining({ baseHash: 'approval-hash' }),
    );
    expect(harness.requestGateway).toHaveBeenCalledWith('config.get');
    expect(harness.requestGateway).toHaveBeenCalledWith('actionApproval.info');
    expect(harness.stopGateway).not.toHaveBeenCalled();
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

  it('fails closed when the runtime reports a stale permission mode', async () => {
    const harness = createHarness({ permissionMode: 'auto', reportedPermissionMode: 'ask' });

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

  it('fails closed when the file permission policy extension is not active', async () => {
    const harness = createHarness({ permissionPolicyLoaded: false });

    await expect(harness.service.syncConfig({ reason: 'test' })).resolves.toMatchObject({
      success: false,
      configSynced: false,
      error: expect.stringContaining('Gateway was stopped'),
    });
    expect(harness.stopGateway).toHaveBeenCalledOnce();
  });

  it('fails closed when the scheduler is missing from the file-policy Full allowlist', async () => {
    const harness = createHarness({ reportedFullAgentIds: [] });

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
        error: expect.stringContaining('runtime permission state was not confirmed'),
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
      expect(harness.engineManager.setSecretEnvVars).not.toHaveBeenCalled();
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
        models: { pricing: { enabled: false } },
        agents: { defaults: { memorySearch: { enabled: false } } },
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
        models: { pricing: { enabled: false } },
        agents: { defaults: { memorySearch: { enabled: false } } },
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

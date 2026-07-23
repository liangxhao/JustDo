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
    const engineManager = {
      getStatus,
      getGatewayConfigReloadGeneration: vi.fn(() => 7),
      waitForGatewayConfigReload: vi.fn(async () => options.waitForReload ?? true),
      getSecretEnvVars: vi.fn(() => options.previousSecrets ?? {}),
      setSecretEnvVars: vi.fn(),
      getGatewayProcessGeneration: vi.fn(() => processGeneration),
      startGateway,
      stopGateway,
      setExternalError: vi.fn(),
    };
    const disconnectGatewayClient = vi.fn();
    const service = new OpenClawConfigSyncService({
      getCoworkStore: vi.fn(),
      getOpenClawEngineManager: () => engineManager,
      getAskUserExtensionConfig: vi.fn(),
      getMcpStore: vi.fn(),
      getHookStore: vi.fn(),
      hasActiveGatewayWorkloads: vi.fn(() => activeWorkloads),
      disconnectGatewayClient,
    } as never);
    const configSync = {
      sync: vi.fn(() => ({
        ok: true,
        changed: true,
        configChanged: true,
        requiresGatewayRestart: false,
        configPath: options.configPath ?? 'openclaw.json',
      })),
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
    expect(harness.stopGateway).not.toHaveBeenCalled();
    expect(harness.startGateway).not.toHaveBeenCalled();
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
  });

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
      expect(harness.stopGateway).not.toHaveBeenCalled();
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

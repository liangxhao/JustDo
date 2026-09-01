import { afterEach, describe, expect, test, vi } from 'vitest';

const { ipcHandle } = vi.hoisted(() => ({ ipcHandle: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandle },
}));

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  getOpenClawTerminalEnvKeys,
  registerOpenClawEngineHandlers,
  restartOpenClawGatewayForUser,
} from './engine';

const createRestartHarness = (options: {
  phase?: 'ready' | 'running' | 'error';
  activePort?: number;
  configuredPort?: number;
  ready?: boolean;
  requestResult?: unknown;
  requestError?: Error;
  restartPhase?: 'ready' | 'running' | 'error';
  pendingLaunchEnvironmentChanges?: boolean;
} = {}) => {
  const initialStatus = {
    phase: options.phase ?? 'running',
    version: 'v-test',
    canRetry: false,
  } as const;
  const restartStatus = {
    phase: options.restartPhase ?? 'running',
    version: 'v-test',
    canRetry: false,
  } as const;
  const manager = {
    getStatus: vi.fn().mockReturnValue(initialStatus),
    getGatewayPort: vi.fn().mockReturnValue(options.activePort ?? 6126),
    getConfiguredGatewayPort: vi.fn().mockReturnValue(options.configuredPort ?? 6126),
    hasPendingGatewayLaunchEnvironmentChanges: vi
      .fn()
      .mockReturnValue(options.pendingLaunchEnvironmentChanges ?? false),
    getGatewayLifecycleGeneration: vi.fn().mockReturnValue(7),
    waitForGatewayReadyAfter: vi.fn().mockResolvedValue(options.ready ?? true),
    restartGateway: vi.fn().mockResolvedValue(restartStatus),
    onSessionMigrationProgress: vi.fn().mockReturnValue(() => undefined),
  };
  const requestGateway = options.requestError
    ? vi.fn().mockRejectedValue(options.requestError)
    : vi.fn().mockResolvedValue(
        options.requestResult ?? {
          ok: true,
          status: 'scheduled',
          restart: { delayMs: 0 },
        },
      );
  const reconnectGatewayClient = vi.fn().mockResolvedValue(undefined);

  return {
    manager,
    requestGateway,
    reconnectGatewayClient,
    restart: () =>
      restartOpenClawGatewayForUser({
        getManager: () => manager as unknown as OpenClawEngineManager,
        requestGateway: requestGateway as unknown as <T>(
          method: string,
          params?: unknown,
        ) => Promise<T>,
        reconnectGatewayClient,
      }),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  ipcHandle.mockReset();
});

describe('OpenClaw terminal environment', () => {
  test('passes the managed Python user base but excludes unrelated host values', () => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\Users\\test\\AppData\\Roaming\\JustDo\\runtimes\\python-user',
      JUSTDO_MANAGED_PYTHON_USER_BASE:
        'C:\\Users\\test\\AppData\\Roaming\\JustDo\\runtimes\\python-user',
      UNRELATED_HOST_VALUE: 'blocked',
    });

    expect(keys).toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('JUSTDO_MANAGED_PYTHON_USER_BASE');
    expect(keys).not.toContain('UNRELATED_HOST_VALUE');
  });

  test.each([
    ['missing provenance', undefined],
    ['mismatched provenance', 'C:\\untrusted\\python-user'],
    ['empty provenance', ''],
  ])('excludes a host Python user base with %s', (_label, provenance) => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\host\\python-user',
      ...(provenance === undefined
        ? {}
        : { JUSTDO_MANAGED_PYTHON_USER_BASE: provenance }),
    });

    expect(keys).not.toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('JUSTDO_MANAGED_PYTHON_USER_BASE');
  });

  test('excludes a lowercase provenance lookalike', () => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\host\\python-user',
      justdo_managed_python_user_base: 'C:\\host\\python-user',
    });

    expect(keys).not.toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('justdo_managed_python_user_base');
  });
});

describe('manual OpenClaw Gateway restart', () => {
  test('uses an in-process restart and waits for the next ready lifecycle', async () => {
    const harness = createRestartHarness();

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.restart.request', {
      reason: 'justdo-manual-restart',
      skipDeferral: true,
    });
    expect(harness.manager.waitForGatewayReadyAfter).toHaveBeenCalledWith(7, 30_000);
    expect(harness.manager.restartGateway).not.toHaveBeenCalled();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test('uses a full restart when the configured port differs from the active port', async () => {
    const harness = createRestartHarness({ activePort: 6126, configuredPort: 7000 });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test('uses a full restart when launch environment changes are pending', async () => {
    const harness = createRestartHarness({ pendingLaunchEnvironmentChanges: true });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test.each([
    ['an RPC failure', { requestError: new Error('method unavailable') }],
    ['a rejected request', { requestResult: { ok: false } }],
    ['a ready failure', { ready: false }],
    [
      'a long Gateway cooldown',
      {
        requestResult: {
          ok: true,
          status: 'scheduled',
          restart: { delayMs: 10_000 },
        },
      },
    ],
  ])('falls back to a full restart after %s', async (_label, options) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = createRestartHarness(options);

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test('uses a full restart when the Gateway is not currently running', async () => {
    const harness = createRestartHarness({ phase: 'error' });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
  });

  test('keeps a successful restart when the adapter reconnect is transiently unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = createRestartHarness();
    harness.reconnectGatewayClient.mockRejectedValueOnce(new Error('handshake pending'));

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.manager.restartGateway).not.toHaveBeenCalled();
  });

  test('returns after Gateway ready without waiting for the adapter handshake', async () => {
    const harness = createRestartHarness();
    let finishReconnect: (() => void) | undefined;
    harness.reconnectGatewayClient.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishReconnect = resolve;
      }),
    );

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
    finishReconnect?.();
  });
});

describe('OpenClaw Gateway restart IPC', () => {
  test('returns structured failures to concurrent callers sharing one restart', async () => {
    const harness = createRestartHarness({ phase: 'error' });
    const restartError = new Error('restart failed');
    harness.manager.restartGateway.mockRejectedValueOnce(restartError);
    registerOpenClawEngineHandlers({
      getManager: () => harness.manager as unknown as OpenClawEngineManager,
      requestGateway: harness.requestGateway as unknown as <T>(
        method: string,
        params?: unknown,
      ) => Promise<T>,
      reconnectGatewayClient: harness.reconnectGatewayClient,
    });
    const registration = ipcHandle.mock.calls.find(
      ([channel]) => channel === 'openclaw:engine:restartGateway',
    );
    const handler = registration?.[1] as (() => Promise<{
      success: boolean;
      error?: string;
    }>) | undefined;
    expect(handler).toBeTypeOf('function');

    const [first, second] = await Promise.all([handler!(), handler!()]);

    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ success: false, error: restartError.message });
    expect(second).toMatchObject({ success: false, error: restartError.message });
  });
});

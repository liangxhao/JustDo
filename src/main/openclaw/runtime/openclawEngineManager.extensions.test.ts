import { afterEach, describe, expect, it, vi } from 'vitest';

import { syncLocalOpenClawExtensionsIntoRuntime } from '../../plugins/extensions';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './openclawEngineManager';

vi.mock('../../plugins/extensions', () => ({
  syncLocalOpenClawExtensionsIntoRuntime: vi.fn(),
}));

function createManager() {
  const manager = Object.create(OpenClawEngineManager.prototype) as OpenClawEngineManager;
  // Exercise the real start/readiness/CLI handoff without launching a native process.
  const harness = manager as unknown as {
    status: OpenClawEngineStatus;
    gatewayProcess: { pid: number; exitCode: null } | null;
    shutdownRequested: boolean;
    gatewayPort: number;
    setStatus: (status: OpenClawEngineStatus) => void;
    resolveRuntimeMetadata: () => { root: string; version: string };
    prepareNetworkGeneration: ReturnType<typeof vi.fn>;
    beginNetworkGeneration: ReturnType<typeof vi.fn>;
    refreshSpeechPluginRegistryIfNeeded: ReturnType<typeof vi.fn>;
    resolveOpenClawGatewayEntry: () => null;
    isGatewayHealthy: () => Promise<boolean>;
    gatewayConfigReloadMonitor: {
      getGatewayLifecycleGeneration: () => number;
      isGatewayRestartPending: () => boolean;
    };
  };
  harness.status = { phase: 'ready', version: 'test', message: 'ready', canRetry: false };
  harness.gatewayProcess = null;
  harness.setStatus = status => {
    harness.status = status;
  };
  harness.resolveRuntimeMetadata = () => ({ root: 'fixture-runtime', version: 'test' });
  harness.prepareNetworkGeneration = vi.fn(async () => {});
  harness.beginNetworkGeneration = vi.fn();
  harness.refreshSpeechPluginRegistryIfNeeded = vi.fn(async () => {});
  harness.resolveOpenClawGatewayEntry = () => null;
  harness.isGatewayHealthy = async () => true;
  harness.gatewayPort = 12345;
  harness.gatewayConfigReloadMonitor = {
    getGatewayLifecycleGeneration: () => 0,
    isGatewayRestartPending: () => false,
  };
  manager.buildCliEnvironment = vi.fn(async () => {
    await manager.ensureReady();
    return { openclawEntry: 'fixture-entry', port: 12345, token: 'fixture', env: {} };
  });
  manager.stopGateway = vi.fn(async () => {
    harness.shutdownRequested = true;
    harness.gatewayProcess = null;
    harness.status = { phase: 'ready', version: 'test', message: 'stopped', canRetry: false };
  });
  return { manager, harness };
}

afterEach(() => vi.restoreAllMocks());

describe('Gateway source extension preparation', () => {
  it('keeps both public and internal Gateway starts closed during history preparation', async () => {
    const { manager } = createManager();
    Object.assign(manager, { canStartGateway: () => false });
    const sync = vi.mocked(syncLocalOpenClawExtensionsIntoRuntime);
    sync.mockClear();
    await expect(manager.startGateway()).rejects.toThrow(/history preparation/);
    await expect((manager as unknown as { startGatewayOnce: () => Promise<unknown> }).startGatewayOnce())
      .rejects.toThrow(/history preparation/);
    expect(sync).not.toHaveBeenCalled();
  });
  it('waits for an in-process restart even when the old listener still answers health checks', async () => {
    const { manager, harness } = createManager();
    const ready = Promise.withResolvers<boolean>();
    const waitForReady = vi.fn(() => ready.promise);
    harness.status = { phase: 'starting', version: 'test', canRetry: false, restarting: true };
    harness.gatewayProcess = { pid: 1234, exitCode: null };
    Object.assign(harness.gatewayConfigReloadMonitor, {
      isGatewayRestartPending: () => true,
      waitForGatewayReadyAfter: waitForReady,
    });
    const sync = vi.mocked(syncLocalOpenClawExtensionsIntoRuntime);
    sync.mockReset();

    const starting = manager.startGateway();
    await vi.waitFor(() => expect(waitForReady).toHaveBeenCalledOnce());
    expect(manager.getStatus()).toMatchObject({ phase: 'starting', restarting: true });
    harness.status = { phase: 'running', version: 'test', canRetry: false };
    ready.resolve(true);

    await expect(starting).resolves.toMatchObject({ phase: 'running' });
    expect(sync).not.toHaveBeenCalled();
    expect(manager.stopGateway).not.toHaveBeenCalled();
  });

  it.each(['starting', 'running'] as const)(
    'keeps readiness and healthy Gateway reuse free of resource copies while %s',
    async phase => {
      const { manager, harness } = createManager();
      const sync = vi.mocked(syncLocalOpenClawExtensionsIntoRuntime);
      sync.mockReset();
      await manager.ensureReady();
      harness.status = { ...harness.status, phase };
      harness.gatewayProcess = { pid: 1234, exitCode: null };

      await manager.ensureReady();
      await manager.startGateway();

      expect(sync).not.toHaveBeenCalled();
      expect(harness.status.phase).toBe('running');
    },
  );

  it('shares one slow cold preparation and repeats it on an explicit restart', async () => {
    const { manager, harness } = createManager();
    const pending = Promise.withResolvers<{ sourceDir: string; copied: string[] }>();
    const sync = vi.mocked(syncLocalOpenClawExtensionsIntoRuntime);
    sync
      .mockReset()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ sourceDir: 'source', copied: ['plugin'] });
    const first = manager.startGateway();
    const second = manager.startGateway();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
    expect(harness.status.phase).toBe('starting');
    await manager.ensureReady();
    expect(sync).toHaveBeenCalledOnce();
    pending.resolve({ sourceDir: 'source', copied: ['plugin'] });

    await Promise.all([first, second]);
    expect(sync).toHaveBeenCalledOnce();
    expect(manager.buildCliEnvironment).toHaveBeenCalledOnce();
    await manager.restartGateway();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)(
    'honors stop while asynchronous source preparation is pending: %s',
    async outcome => {
      const { manager, harness } = createManager();
      const pending = Promise.withResolvers<{ sourceDir: string; copied: string[] }>();
      const sync = vi.mocked(syncLocalOpenClawExtensionsIntoRuntime);
      sync.mockReset().mockReturnValue(pending.promise);
      const started = manager.startGateway();
      await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());

      await manager.stopGateway();
      if (outcome === 'resolve') pending.resolve({ sourceDir: 'source', copied: ['plugin'] });
      else pending.reject(new Error('copy failed'));

      await expect(started).resolves.toMatchObject({ phase: 'ready', message: 'stopped' });
      expect(harness.prepareNetworkGeneration).not.toHaveBeenCalled();
      expect(manager.buildCliEnvironment).not.toHaveBeenCalled();
    },
  );

  it('reports a failed copy and prepares again when retried', async () => {
    const { manager, harness } = createManager();
    const sync = vi.mocked(syncLocalOpenClawExtensionsIntoRuntime);
    sync
      .mockReset()
      .mockRejectedValueOnce(new Error('copy failed'))
      .mockResolvedValue({ sourceDir: 'source', copied: ['plugin'] });

    await expect(manager.startGateway()).resolves.toMatchObject({
      phase: 'error',
      canRetry: true,
      message: expect.stringContaining('copy failed'),
    });
    expect(harness.prepareNetworkGeneration).not.toHaveBeenCalled();
    await manager.startGateway();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(manager.buildCliEnvironment).toHaveBeenCalledOnce();
  });
});

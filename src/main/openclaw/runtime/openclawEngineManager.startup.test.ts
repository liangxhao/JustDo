import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { StartupRoute } from '../../../shared/app/startup/routing';
import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { t } from '../../core/i18n';
import { AppInitialization } from '../../startup/initialization/appInitialization';
import { StartupEnginePreparation } from '../../startup/initialization/startupEnginePreparation';
import { GatewayConfigReloadMonitor } from './gatewayConfigReloadMonitor';
import { OpenClawEngineManager } from './openclawEngineManager';

const fakeChild = (pid: number) => Object.assign(new EventEmitter(), {
  pid, exitCode: null as number | null, signalCode: null,
});
type FakeChild = ReturnType<typeof fakeChild>;

function fixture() {
  // Test the cold-start completion boundary without preparing or launching a runtime.
  const manager = Object.create(OpenClawEngineManager.prototype) as OpenClawEngineManager;
  EventEmitter.call(manager);
  const internal = manager as unknown as {
    status: OpenClawEngineStatus;
    gatewayProcess: FakeChild | null;
    gatewayProcessGeneration: number;
    gatewayConfigReloadMonitor: GatewayConfigReloadMonitor;
    gatewayRestartWait: AbortController;
    coldStartingGateway?: { child: FakeChild; processGeneration: number };
    shutdownRequested: boolean;
    applicationShuttingDown: boolean;
    setStatus: (status: OpenClawEngineStatus) => void;
    observeGatewayProcessLine: (child: FakeChild, line: string) => void;
    completeGatewayStart: (options: {
      child: FakeChild; processGeneration: number; lifecycleBeforeStart: number;
      port: number; version: string; startedAt: number; signal: AbortSignal; timeoutMs?: number;
    }) => Promise<OpenClawEngineStatus>;
  };
  const child = fakeChild(4101);
  const monitor = new GatewayConfigReloadMonitor();
  const controller = new AbortController();
  const health = vi.fn(async () => true);
  const stop = vi.fn(async (_target: FakeChild) => {});
  Object.assign(internal, {
    status: { phase: EnginePhase.Starting, version: 'fixture', canRetry: false },
    gatewayProcess: child, gatewayProcessGeneration: 7,
    gatewayConfigReloadMonitor: monitor, gatewayRestartWait: controller,
    coldStartingGateway: { child, processGeneration: 7 },
    shutdownRequested: false, applicationShuttingDown: false,
    isGatewayHealthy: health, stopGatewayProcess: stop,
  });
  const statuses: OpenClawEngineStatus[] = [];
  manager.on('status', status => statuses.push(status));
  const line = (target: FakeChild, value: string) => internal.observeGatewayProcessLine(target, value);
  const start = (timeoutMs?: number) => internal.completeGatewayStart({
    child, processGeneration: 7, lifecycleBeforeStart: monitor.getGatewayLifecycleGeneration(),
    port: 18789, version: 'fixture', startedAt: Date.now(), signal: controller.signal, timeoutMs,
  });
  return { manager, internal, child, monitor, controller, health, stop, statuses, line, start };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('HTTP health before native ready admits the final lifecycle only after permission verification', async () => {
  const f = fixture();
  const initialization = new AppInitialization('/unused', StartupRoute.Normal, vi.fn());
  await initialization.complete();
  const verify = Promise.withResolvers<void>();
  const refresh = vi.fn(async () => f.manager.getStatus());
  const preparation = new StartupEnginePreparation({
    initialization, manager: f.manager, isQuitting: () => false, prepare: refresh,
  });
  f.manager.on('status', status => preparation.observe(status));
  const pending = preparation.run(async () => {
    const status = await f.start();
    await verify.promise;
    return status;
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(f.health).toHaveBeenCalledOnce();
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  expect(f.statuses).toEqual([]);
  expect(preparation.isReady()).toBe(false);

  f.line(f.child, '[gateway] ready');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Running);
  expect(f.manager.getGatewayLifecycleGeneration()).toBe(1);
  expect(preparation.isReady()).toBe(false);
  verify.resolve();

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Running });
  expect(preparation.isReady()).toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('native ready before HTTP health is retained without publishing Running early', async () => {
  const f = fixture();
  const health = Promise.withResolvers<boolean>();
  f.health.mockImplementationOnce(() => health.promise);
  const pending = f.start();

  f.line(f.child, '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  health.resolve(true);

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Running });
  expect(f.statuses.filter(status => status.phase === EnginePhase.Running)).toHaveLength(1);
  expect(f.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('an earlier ready marker cannot discharge a native restart still pending during cold startup', async () => {
  const f = fixture();
  const health = Promise.withResolvers<boolean>();
  f.health.mockImplementationOnce(() => health.promise);
  const pending = f.start();
  f.line(f.child, '[gateway] ready');
  f.line(f.child, '[gateway] received SIGUSR2; restarting');
  health.resolve(true);
  await vi.advanceTimersByTimeAsync(0);

  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  f.line(f.child, '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Running });
  expect(f.manager.getGatewayLifecycleGeneration()).toBe(2);
  expect(f.statuses.filter(status => status.phase === EnginePhase.Running)).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('application shutdown cancels native ready waiting and rejects late Running publication', async () => {
  const f = fixture();
  const pending = f.start();
  await vi.advanceTimersByTimeAsync(0);

  f.manager.beginApplicationShutdown();

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  f.line(f.child, '[gateway] received SIGUSR2; restarting');
  f.line(f.child, '[gateway] ready');
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(f.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('application shutdown waits for an admitted Gateway launch to finish writing', async () => {
  const { manager } = fixture();
  const preparing = Promise.withResolvers<OpenClawEngineStatus>();
  const stop = vi.spyOn(manager, 'stopGateway').mockResolvedValue(undefined);
  Object.assign(manager, { startGatewayPromise: preparing.promise });
  manager.beginApplicationShutdown();

  let settled = false;
  const stopping = manager.stopForApplicationShutdown().then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce();
  expect(settled).toBe(false);

  preparing.resolve(manager.getStatus());
  await stopping;
  expect(settled).toBe(true);
});

test('start cancellation releases an in-flight HTTP probe before its late response', async () => {
  const f = fixture();
  const health = Promise.withResolvers<boolean>();
  f.health.mockImplementationOnce(() => health.promise);
  const pending = f.start();

  f.controller.abort();

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  f.line(f.child, '[gateway] ready');
  health.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(f.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('foreign ready markers and an old child exit cannot activate or retire a successor', async () => {
  const f = fixture();
  const pending = f.start();
  await vi.advanceTimersByTimeAsync(0);
  const successor = fakeChild(4102);
  f.line(successor, '[gateway] ready');
  expect(f.manager.getGatewayLifecycleGeneration()).toBe(0);
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);

  f.internal.gatewayProcess = successor;
  f.internal.gatewayProcessGeneration++;
  const failure: OpenClawEngineStatus = {
    phase: EnginePhase.Error, version: 'fixture', canRetry: true, message: 'Successor startup failed',
  };
  f.internal.setStatus(failure);
  f.monitor.observeGatewayExit();
  f.child.exitCode = 1;
  f.child.emit('exit', 1, null);

  await expect(pending).resolves.toMatchObject(failure);
  expect(f.internal.gatewayProcess).toBe(successor);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('health and native readiness share one cold-start deadline', async () => {
  const f = fixture();
  const health = Promise.withResolvers<boolean>();
  f.health.mockImplementationOnce(() => health.promise);
  const pending = f.start(1_000);
  await vi.advanceTimersByTimeAsync(400);
  health.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(599);
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);

  await vi.advanceTimersByTimeAsync(1);

  await expect(pending).resolves.toMatchObject({
    phase: EnginePhase.Error, message: t('gatewayStartupUnconfirmed'),
  });
  expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.child);
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('a native ready response preserves an existing failure from the same cold-start process', async () => {
  const f = fixture();
  const pending = f.start();
  await vi.advanceTimersByTimeAsync(0);
  const failure: OpenClawEngineStatus = {
    phase: EnginePhase.Error, version: 'fixture', canRetry: true, message: 'Gateway process error',
  };
  f.internal.setStatus(failure);

  f.line(f.child, '[gateway] received SIGUSR2; restarting');
  f.line(f.child, '[gateway] ready');

  await expect(pending).resolves.toMatchObject(failure);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

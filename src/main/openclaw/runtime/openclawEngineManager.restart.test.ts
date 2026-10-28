import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import {
  GATEWAY_RESTART_COMPLETION_TIMEOUT_MS,
  GatewayConfigReloadMonitor,
} from './gatewayConfigReloadMonitor';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './openclawEngineManager';

const runningStatus: OpenClawEngineStatus = {
  phase: EnginePhase.Running, version: 'fixture', canRetry: false,
};
const fakeChild = (pid: number) => Object.assign(new EventEmitter(), {
  pid, exitCode: null as number | null, signalCode: null,
});
type FakeChild = ReturnType<typeof fakeChild>;

function fixture() {
  // Bypass runtime preparation entirely: these tests never launch a Gateway.
  const manager = Object.create(OpenClawEngineManager.prototype) as OpenClawEngineManager;
  EventEmitter.call(manager);
  const internal = manager as unknown as {
    status: OpenClawEngineStatus;
    gatewayProcess: FakeChild | null;
    gatewayProcessGeneration: number;
    gatewayPort: number;
    gatewayRestartWait: AbortController | null;
    gatewayConfigReloadMonitor: GatewayConfigReloadMonitor;
    shutdownRequested: boolean;
    applicationShuttingDown: boolean;
    ensureReady: () => Promise<OpenClawEngineStatus>;
    isGatewayHealthy: () => Promise<boolean>;
    resolveRuntimeMetadata: () => { root: string; version: string };
    stopGatewayProcess: (child: FakeChild) => Promise<void>;
    performGatewayRestart: () => Promise<OpenClawEngineStatus>;
    observeGatewayProcessLine: (child: FakeChild, line: string) => void;
    setStatus: (status: OpenClawEngineStatus) => void;
    startGatewayPromise: Promise<OpenClawEngineStatus> | null;
  };
  const child = fakeChild(4101);
  const monitor = new GatewayConfigReloadMonitor();
  const coldStart = vi.fn((): never => { throw new Error('Unexpected cold Gateway launch'); });
  const retire = (target: FakeChild) => {
    target.exitCode = 0;
    if (internal.gatewayProcess === target) {
      internal.gatewayProcess = null;
      monitor.observeGatewayExit();
    }
  };
  const stop = vi.fn(async (target: FakeChild) => { retire(target); });
  const ensureReady = vi.fn(async () => manager.getStatus());
  const health = vi.fn(async () => false);
  Object.assign(internal, {
    status: runningStatus, gatewayProcess: child, gatewayProcessGeneration: 7,
    gatewayPort: 18789, gatewayRestartWait: null, gatewayConfigReloadMonitor: monitor,
    shutdownRequested: false, applicationShuttingDown: false,
    startGatewayPromise: null, restartGatewayPromise: null,
    ensureReady, isGatewayHealthy: health, stopGatewayProcess: stop,
    resolveRuntimeMetadata: () => {
      if (!internal.shutdownRequested && !internal.gatewayProcess) coldStart();
      return { root: 'fixture-runtime', version: 'fixture' };
    },
  });
  const statuses: OpenClawEngineStatus[] = [];
  manager.on('status', status => statuses.push(status));
  const line = (target: FakeChild, value: string) => internal.observeGatewayProcessLine(target, value);
  line(child, '[gateway] ready');
  line(child, '[gateway] received SIGUSR2; restarting');
  const observe = vi.spyOn(monitor, 'waitForGatewayReadyAfter');
  const waiting = async () => {
    await vi.advanceTimersByTimeAsync(0);
    expect(internal.gatewayRestartWait?.signal.aborted).toBe(false);
    expect(observe).toHaveBeenCalledOnce();
  };
  return { manager, internal, child, monitor, stop, retire, coldStart, ensureReady, health,
    statuses, line, observe, waiting };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('concurrent starts retain the native restart beyond sixty seconds and join its exact child ready at seventy-five seconds', async () => {
  const f = fixture();
  // A live HTTP listener must not replace the native ready evidence during restart.
  f.health.mockResolvedValue(true);
  const first = f.manager.startGateway();
  const second = f.manager.startGateway();
  let settled = false;
  void Promise.all([first, second]).then(() => { settled = true; });
  await f.waiting();
  expect(f.ensureReady).toHaveBeenCalledOnce();
  expect(f.health).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  expect(f.manager.getStatus()).toMatchObject({ phase: EnginePhase.Starting, restarting: true });
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(14_999);
  f.line(fakeChild(4102), '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  f.line(f.child, '[gateway] ready');

  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({ phase: EnginePhase.Running }),
    expect.objectContaining({ phase: EnginePhase.Running }),
  ]);
  expect(f.internal.gatewayProcess).toBe(f.child);
  expect(f.internal.gatewayProcessGeneration).toBe(7);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('the ten-minute observation deadline retains its live owner and a later native ready can still complete it', async () => {
  const f = fixture();
  const pending = f.manager.startGateway();
  await f.waiting();

  await vi.advanceTimersByTimeAsync(GATEWAY_RESTART_COMPLETION_TIMEOUT_MS);

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting, restarting: true });
  expect(f.internal.gatewayProcess).toBe(f.child);
  expect(f.monitor.isGatewayRestartPending()).toBe(true);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(f.internal.gatewayRestartWait).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  f.line(f.child, '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Running);
  expect(f.internal.gatewayProcess).toBe(f.child);
});

test('an explicit stop cancels the ready wait before process retirement and suppresses a late Running update', async () => {
  const f = fixture();
  const pending = f.manager.startGateway();
  await f.waiting();
  let finishStop!: () => void;
  f.stop.mockImplementationOnce(() => new Promise(resolve => {
    finishStop = () => { f.retire(f.child); resolve(); };
  }));

  const stopped = f.manager.stopGateway();
  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  f.line(f.child, '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  finishStop();
  await stopped;
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Ready);
  expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.child);
});

test('a stop in the same tick as start retains shutdown intent before its first readiness probe', async () => {
  const f = fixture();
  let finishStop!: () => void;
  f.stop.mockImplementationOnce(() => new Promise(resolve => {
    finishStop = () => { f.retire(f.child); resolve(); };
  }));

  const pending = f.manager.startGateway();
  const stopped = f.manager.stopGateway();

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  expect(f.internal.shutdownRequested).toBe(true);
  expect(f.ensureReady).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  f.line(f.child, '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  finishStop();
  await stopped;
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Ready);
  expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.child);
});

test.each(['ensureReady', 'health'] as const)('a delayed %s response cannot restore Running after stop while child retirement is pending', async probe => {
  const f = fixture();
  const readiness = Promise.withResolvers<OpenClawEngineStatus>();
  const health = Promise.withResolvers<boolean>();
  if (probe === 'ensureReady') {
    f.ensureReady.mockImplementationOnce(() => readiness.promise);
    f.health.mockResolvedValue(true);
  } else {
    // The listener is ready, while Main still has a Starting observation in flight.
    f.monitor.observeLine('[gateway] ready');
    f.health.mockImplementationOnce(() => health.promise);
  }
  let finishStop!: () => void;
  f.stop.mockImplementationOnce(() => new Promise(resolve => {
    finishStop = () => { f.retire(f.child); resolve(); };
  }));
  const pending = f.manager.startGateway();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.health).toHaveBeenCalledTimes(probe === 'ensureReady' ? 0 : 1);
  expect(f.observe).not.toHaveBeenCalled();

  const stopped = f.manager.stopGateway();
  if (probe === 'ensureReady') {
    f.line(f.child, '[gateway] ready');
    readiness.resolve(f.manager.getStatus());
  } else health.resolve(true);

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  expect(f.health).toHaveBeenCalledTimes(probe === 'ensureReady' ? 0 : 1);
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(f.internal.gatewayProcess).toBe(f.child);
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  finishStop();
  await stopped;
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Ready);
  expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.child);
});

test('application shutdown immediately releases the wait and rejects late native ready publication', async () => {
  const f = fixture();
  const pending = f.manager.startGateway();
  await f.waiting();

  f.manager.beginApplicationShutdown();

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  f.line(f.child, '[gateway] ready');
  expect(f.manager.getStatus().phase).toBe(EnginePhase.Starting);
  expect(f.statuses.some(status => status.phase === EnginePhase.Running)).toBe(false);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('an explicit restart cancels the observation then executes the queued restart for all readiness callers', async () => {
  const f = fixture();
  const initial = f.manager.startGateway();
  await f.waiting();
  const signal = f.internal.gatewayRestartWait!.signal;
  const restart = vi.fn(async () => {
    expect(f.internal.gatewayRestartWait).toBeNull();
    expect(f.internal.startGatewayPromise).toBeNull();
    f.internal.setStatus(runningStatus);
    return f.manager.getStatus();
  });
  f.internal.performGatewayRestart = restart;

  const requested = f.manager.restartGateway();
  expect(signal.aborted).toBe(true);
  expect(restart).not.toHaveBeenCalled();

  await expect(Promise.all([initial, requested])).resolves.toEqual([
    expect.objectContaining({ phase: EnginePhase.Running }),
    expect.objectContaining({ phase: EnginePhase.Running }),
  ]);
  expect(restart).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['ensureReady', 'health'] as const)('a restart queued during %s cancels its future native-ready wait without advancing the clock', async probe => {
  const f = fixture();
  const readiness = Promise.withResolvers<OpenClawEngineStatus>();
  const health = Promise.withResolvers<boolean>();
  if (probe === 'ensureReady') f.ensureReady.mockImplementationOnce(() => readiness.promise);
  else f.health.mockImplementationOnce(() => health.promise);
  const initial = f.manager.startGateway();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.ensureReady).toHaveBeenCalledOnce();
  expect(f.observe).not.toHaveBeenCalled();
  const signal = f.internal.gatewayRestartWait!.signal;
  const restart = vi.fn(async () => {
    expect(f.internal.gatewayRestartWait).toBeNull();
    expect(f.internal.startGatewayPromise).toBeNull();
    f.internal.setStatus(runningStatus);
    return f.manager.getStatus();
  });
  f.internal.performGatewayRestart = restart;

  const requested = f.manager.restartGateway();
  expect(signal.aborted).toBe(true);
  expect(restart).not.toHaveBeenCalled();
  const observedAt = Date.now();
  if (probe === 'ensureReady') readiness.resolve(f.manager.getStatus());
  else health.resolve(false);

  await expect(Promise.all([initial, requested])).resolves.toEqual([
    expect.objectContaining({ phase: EnginePhase.Running }),
    expect.objectContaining({ phase: EnginePhase.Running }),
  ]);
  expect(Date.now()).toBe(observedAt);
  expect(restart).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('a current child exit ends observation and enters the existing cold recovery path', async () => {
  const f = fixture();
  const pending = f.manager.startGateway();
  await f.waiting();
  const recovered = expect(pending).rejects.toThrow('Unexpected cold Gateway launch');

  f.retire(f.child);

  await recovered;
  expect(f.internal.gatewayProcess).toBeNull();
  expect(f.coldStart).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['child', 'generation'] as const)('an older restart waiter cannot replace a successor %s owner', async change => {
  const f = fixture();
  const pending = f.manager.startGateway();
  await f.waiting();
  const successor = change === 'child' ? fakeChild(4102) : f.child;
  f.internal.gatewayProcess = successor;
  f.internal.gatewayProcessGeneration++;
  // A new lifecycle fact settles the old observation; its ownership check
  // must preserve the live successor even when the old child object is reused.
  f.monitor.observeGatewayExit();

  await expect(pending).resolves.toMatchObject({ phase: EnginePhase.Starting });
  expect(f.internal.gatewayProcess).toBe(successor);
  expect(f.internal.gatewayProcessGeneration).toBe(8);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.coldStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

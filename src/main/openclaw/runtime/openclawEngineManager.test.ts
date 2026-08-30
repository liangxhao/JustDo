import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';

import {
  applyOpenClawCliNetworkMode,
  OpenClawCliNetworkMode,
  OpenClawEngineManager,
} from './openclawEngineManager';

test('keeps the inherited CLI environment when outbound proxy mode is not requested', () => {
  const baseEnv = { PATH: 'base' };
  const buildNetworkEnvironment = vi.fn();

  expect(
    applyOpenClawCliNetworkMode(
      baseEnv,
      OpenClawCliNetworkMode.Inherit,
      buildNetworkEnvironment,
    ),
  ).toBe(baseEnv);
  expect(buildNetworkEnvironment).not.toHaveBeenCalled();
});

test('builds an isolated proxy environment for an opted-in CLI command', () => {
  const baseEnv = { PATH: 'base' };
  const proxyEnv = { ...baseEnv, HTTPS_PROXY: 'http://proxy.example' };
  const buildNetworkEnvironment = vi.fn().mockReturnValue(proxyEnv);

  expect(
    applyOpenClawCliNetworkMode(
      baseEnv,
      OpenClawCliNetworkMode.OutboundProxy,
      buildNetworkEnvironment,
    ),
  ).toBe(proxyEnv);
  expect(buildNetworkEnvironment).toHaveBeenCalledWith(baseEnv);
});

test('tracks secret environment changes until a Gateway launch applies them', () => {
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    secretEnvVars: Record<string, string>;
    gatewayLaunchEnvironmentGeneration: number;
    launchedGatewayEnvironmentGeneration: number;
    setSecretEnvVars: (vars: Record<string, string>) => void;
    getSecretEnvVars: () => Record<string, string>;
    hasPendingGatewayLaunchEnvironmentChanges: () => boolean;
  };
  manager.secretEnvVars = {};
  manager.gatewayLaunchEnvironmentGeneration = 0;
  manager.launchedGatewayEnvironmentGeneration = 0;

  manager.setSecretEnvVars({ MODEL_TOKEN: 'first' });
  expect(manager.hasPendingGatewayLaunchEnvironmentChanges()).toBe(true);
  expect(manager.gatewayLaunchEnvironmentGeneration).toBe(1);

  manager.setSecretEnvVars({ MODEL_TOKEN: 'first' });
  expect(manager.gatewayLaunchEnvironmentGeneration).toBe(1);

  manager.launchedGatewayEnvironmentGeneration = 1;
  expect(manager.hasPendingGatewayLaunchEnvironmentChanges()).toBe(false);

  const snapshot = manager.getSecretEnvVars();
  snapshot.MODEL_TOKEN = 'mutated outside manager';
  expect(manager.getSecretEnvVars()).toEqual({ MODEL_TOKEN: 'first' });
});

test('ignores lifecycle events from a superseded Gateway process', () => {
  const currentChild = new EventEmitter();
  const oldChild = new EventEmitter();
  const observeLine = vi.fn();
  const observeGatewayExit = vi.fn();
  const setStatus = vi.fn();
  const scheduleGatewayRestart = vi.fn();
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    gatewayProcess: EventEmitter | null;
    gatewayConfigReloadMonitor: {
      observeLine: (line: string) => void;
      observeGatewayExit: () => void;
    };
    expectedGatewayExits: WeakSet<object>;
    shutdownRequested: boolean;
    status: { version: string };
    attachGatewayExitHandlers: (child: EventEmitter) => void;
    observeGatewayProcessLine: (child: EventEmitter, line: string) => void;
    setStatus: (status: unknown) => void;
    scheduleGatewayRestart: () => void;
  };
  manager.gatewayProcess = currentChild;
  manager.gatewayConfigReloadMonitor = { observeLine, observeGatewayExit };
  manager.expectedGatewayExits = new WeakSet();
  manager.shutdownRequested = false;
  manager.status = { version: 'v-test' };
  manager.setStatus = setStatus;
  manager.scheduleGatewayRestart = scheduleGatewayRestart;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  manager.observeGatewayProcessLine(oldChild, '[gateway] ready');
  manager.attachGatewayExitHandlers(oldChild);
  oldChild.emit('error', new Error('late error'));
  oldChild.emit('exit', 1, null);

  expect(observeLine).not.toHaveBeenCalled();
  expect(observeGatewayExit).not.toHaveBeenCalled();
  expect(setStatus).not.toHaveBeenCalled();
  expect(scheduleGatewayRestart).not.toHaveBeenCalled();
  expect(manager.gatewayProcess).toBe(currentChild);

  manager.observeGatewayProcessLine(currentChild, '[gateway] ready');
  manager.attachGatewayExitHandlers(currentChild);
  currentChild.emit('exit', 1, null);

  expect(observeLine).toHaveBeenCalledWith('[gateway] ready');
  expect(observeGatewayExit).toHaveBeenCalledOnce();
  expect(setStatus).toHaveBeenCalledOnce();
  expect(scheduleGatewayRestart).toHaveBeenCalledOnce();
  expect(manager.gatewayProcess).toBeNull();
});

test('deduplicates concurrent full Gateway restarts', async () => {
  let finishStop: (() => void) | undefined;
  const stopGateway = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishStop = resolve;
      }),
  );
  const runningStatus = {
    phase: 'running' as const,
    version: 'v-test',
    canRetry: false,
  };
  const startGateway = vi.fn().mockResolvedValue(runningStatus);
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    restartGatewayPromise: Promise<unknown> | null;
    gatewayRestartAttempt: number;
    stopGateway: () => Promise<void>;
    startGateway: () => Promise<typeof runningStatus>;
    restartGateway: (options?: { afterCurrent?: boolean }) => Promise<typeof runningStatus>;
  };
  manager.restartGatewayPromise = null;
  manager.gatewayRestartAttempt = 0;
  manager.stopGateway = stopGateway;
  manager.startGateway = startGateway;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const first = manager.restartGateway();
  const second = manager.restartGateway();
  expect(stopGateway).toHaveBeenCalledOnce();

  finishStop?.();
  await expect(Promise.all([first, second])).resolves.toEqual([
    runningStatus,
    runningStatus,
  ]);
  expect(startGateway).toHaveBeenCalledOnce();
  expect(manager.restartGatewayPromise).toBeNull();
});

test('queues a trailing restart when new launch inputs arrive during restart', async () => {
  let finishFirstStart: ((status: { phase: 'running'; version: string; canRetry: boolean }) => void) | undefined;
  const runningStatus = {
    phase: 'running' as const,
    version: 'v-test',
    canRetry: false,
  };
  const stopGateway = vi.fn().mockResolvedValue(undefined);
  const startGateway = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<typeof runningStatus>(resolve => {
          finishFirstStart = resolve;
        }),
    )
    .mockResolvedValue(runningStatus);
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    restartGatewayPromise: Promise<unknown> | null;
    gatewayRestartAttempt: number;
    stopGateway: () => Promise<void>;
    startGateway: () => Promise<typeof runningStatus>;
    restartGateway: (options?: { afterCurrent?: boolean }) => Promise<typeof runningStatus>;
  };
  manager.restartGatewayPromise = null;
  manager.gatewayRestartAttempt = 0;
  manager.stopGateway = stopGateway;
  manager.startGateway = startGateway;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const current = manager.restartGateway();
  await vi.waitFor(() => expect(startGateway).toHaveBeenCalledOnce());
  const trailing = manager.restartGateway({ afterCurrent: true });
  expect(stopGateway).toHaveBeenCalledOnce();

  finishFirstStart?.(runningStatus);
  await expect(current).resolves.toBe(runningStatus);
  await expect(trailing).resolves.toBe(runningStatus);
  expect(stopGateway).toHaveBeenCalledTimes(2);
  expect(startGateway).toHaveBeenCalledTimes(2);
  expect(manager.restartGatewayPromise).toBeNull();
});

test('queues a trailing restart after an independent Gateway start', async () => {
  let finishActiveStart: ((status: { phase: 'running'; version: string; canRetry: boolean }) => void) | undefined;
  const runningStatus = {
    phase: 'running' as const,
    version: 'v-test',
    canRetry: false,
  };
  const activeStart = new Promise<typeof runningStatus>(resolve => {
    finishActiveStart = resolve;
  });
  const stopGateway = vi.fn().mockResolvedValue(undefined);
  const startGateway = vi.fn().mockResolvedValue(runningStatus);
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    startGatewayPromise: Promise<typeof runningStatus> | null;
    restartGatewayPromise: Promise<unknown> | null;
    gatewayRestartAttempt: number;
    stopGateway: () => Promise<void>;
    startGateway: () => Promise<typeof runningStatus>;
    restartGateway: (options?: { afterCurrent?: boolean }) => Promise<typeof runningStatus>;
  };
  manager.startGatewayPromise = activeStart;
  manager.restartGatewayPromise = null;
  manager.gatewayRestartAttempt = 0;
  manager.stopGateway = stopGateway;
  manager.startGateway = startGateway;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const trailing = manager.restartGateway({ afterCurrent: true });
  expect(stopGateway).not.toHaveBeenCalled();

  finishActiveStart?.(runningStatus);
  await expect(trailing).resolves.toBe(runningStatus);
  expect(stopGateway).toHaveBeenCalledOnce();
  expect(startGateway).toHaveBeenCalledOnce();
  expect(manager.restartGatewayPromise).toBeNull();
});

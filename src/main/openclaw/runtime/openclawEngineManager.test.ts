import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { PRODUCT_NAME_LOWERCASE } from '../../../shared/productMetadata';
import {
  applyOpenClawCliNetworkMode,
  buildInitialOpenClawConfig,
  buildOpenClawCliShimSources,
  OPENCLAW_CLI_COMMAND_NAMES,
  OpenClawCliNetworkMode,
  OpenClawEngineManager,
  resolveOpenClawCliEntry,
  resolveOpenClawGatewayBundleEntry,
  resolveOpenClawRuntimeResourcePaths,
} from './openclawEngineManager';

test('resolves the OpenClaw v2026.9.2 runtime resource layout', () => {
  expect(resolveOpenClawRuntimeResourcePaths('C:\\runtime', 'C:\\state')).toEqual({
    bundledSkillsDir: path.join('C:\\runtime', 'skills'),
    bundledPluginsDir: path.join('C:\\runtime', 'dist', 'extensions'),
    bundledHooksDir: path.join('C:\\runtime', 'dist', 'bundled'),
    managedSkillsDir: path.join('C:\\state', 'skills'),
  });
});

test('leaves managed skill discovery out of the initial OpenClaw config', () => {
  expect(buildInitialOpenClawConfig()).toEqual({ gateway: { mode: 'local' } });
});

test('resolves the public OpenClaw CLI independently from the Gateway bundle', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-cli-entry-'));
  try {
    const archivedEntry = path.join(directory, 'gateway.asar', 'openclaw.mjs');
    fs.mkdirSync(path.dirname(archivedEntry), { recursive: true });
    fs.writeFileSync(archivedEntry, '');
    fs.writeFileSync(path.join(directory, 'gateway-bundle.mjs'), '');
    fs.writeFileSync(path.join(directory, 'gateway-launcher.cjs'), '');

    expect(resolveOpenClawCliEntry(directory)).toBe(archivedEntry);

    const bareEntry = path.join(directory, 'openclaw.mjs');
    fs.writeFileSync(bareEntry, '');
    expect(resolveOpenClawCliEntry(directory)).toBe(bareEntry);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('uses a TTY-capable Node runtime for Windows CLI shims', () => {
  const sources = buildOpenClawCliShimSources();

  expect(sources.shell.indexOf('if [ -x "${JUSTDO_ELECTRON_PATH:-}" ]')).toBeLessThan(
    sources.shell.indexOf('command -v node'),
  );
  expect(sources.windows).toContain('setlocal');
  expect(sources.windows.indexOf('where.exe node.exe')).toBeLessThan(
    sources.windows.indexOf('goto run_electron'),
  );
});

test('exposes the lowercase product name as a CLI alias', () => {
  expect(OPENCLAW_CLI_COMMAND_NAMES).toContain(PRODUCT_NAME_LOWERCASE);
  expect(PRODUCT_NAME_LOWERCASE).toBe(PRODUCT_NAME_LOWERCASE.toLowerCase());
});

test('uses the dedicated Gateway bundle directly on POSIX only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-gateway-entry-'));
  try {
    const bundleEntry = path.join(directory, 'gateway-bundle.mjs');
    fs.writeFileSync(bundleEntry, '');

    expect(resolveOpenClawGatewayBundleEntry(directory, 'linux')).toBe(bundleEntry);
    expect(resolveOpenClawGatewayBundleEntry(directory, 'darwin')).toBe(bundleEntry);
    expect(resolveOpenClawGatewayBundleEntry(directory, 'win32')).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retains a Gateway that becomes ready during an overlapping health probe', async () => {
  const existingProcess = { pid: 1234, exitCode: null };
  let lifecycle = 0;
  let restartPending = true;
  const waitForGatewayReadyAfter = vi.fn(async (generation: number) =>
    lifecycle > generation,
  );
  const stopGatewayProcess = vi.fn(async () => undefined);
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    shutdownRequested: boolean;
    status: {
      phase: 'running';
      version: string;
      message: string;
      canRetry: false;
    };
    desiredVersion: string;
    gatewayProcess: typeof existingProcess | null;
    gatewayPort: number;
    startGatewayPromise: Promise<unknown> | null;
    gatewayConfigReloadMonitor: {
      getGatewayLifecycleGeneration: () => number;
      isGatewayRestartPending: () => boolean;
      waitForGatewayReadyAfter: typeof waitForGatewayReadyAfter;
    };
    ensureReady: () => Promise<{
      phase: 'running';
      version: string;
      message: string;
      canRetry: false;
    }>;
    isGatewayHealthy: () => Promise<boolean>;
    stopGatewayProcess: typeof stopGatewayProcess;
    doStartGateway: () => Promise<{ phase: string }>;
  };
  manager.shutdownRequested = false;
  manager.status = {
    phase: 'running',
    version: 'v2026.9.2',
    message: 'running',
    canRetry: false,
  };
  manager.desiredVersion = 'v2026.9.2';
  manager.gatewayProcess = existingProcess;
  manager.gatewayPort = 42872;
  manager.startGatewayPromise = null;
  manager.gatewayConfigReloadMonitor = {
    getGatewayLifecycleGeneration: () => lifecycle,
    isGatewayRestartPending: () => restartPending,
    waitForGatewayReadyAfter,
  };
  manager.ensureReady = vi.fn(async () => manager.status);
  manager.isGatewayHealthy = vi.fn(async () => {
    lifecycle = 1;
    restartPending = false;
    return false;
  });
  manager.stopGatewayProcess = stopGatewayProcess;

  await expect(manager.doStartGateway()).resolves.toMatchObject({ phase: 'running' });

  expect(waitForGatewayReadyAfter).toHaveBeenCalledWith(0, 60_000);
  expect(stopGatewayProcess).not.toHaveBeenCalled();
  expect(manager.gatewayProcess).toBe(existingProcess);

  // A concurrent stop owns the process after the restart wait and must prevent
  // the same start attempt from falling through to a new cold launch.
  lifecycle = 0;
  restartPending = true;
  manager.shutdownRequested = false;
  manager.gatewayProcess = existingProcess;
  manager.isGatewayHealthy = vi.fn(async () => false);
  waitForGatewayReadyAfter.mockImplementationOnce(async () => {
    manager.shutdownRequested = true;
    manager.gatewayProcess = null;
    return false;
  });

  await expect(manager.doStartGateway()).resolves.toMatchObject({ phase: 'running' });

  expect(stopGatewayProcess).not.toHaveBeenCalled();
  expect(manager.gatewayProcess).toBeNull();
});

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

test('refreshes the active speech plugin registry once per bundled manifest', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-registry-'));
  try {
    const bundledPluginsDir = path.join(directory, 'extensions');
    const pluginDir = path.join(bundledPluginsDir, 'tts-local-cli');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'openclaw.json'),
      JSON.stringify({ tts: { provider: 'tts-local-cli' } }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'tts-local-cli' }),
    );

    const runCliWithEnvironment = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
      stateDir: string;
      configPath: string;
      runCliWithEnvironment: typeof runCliWithEnvironment;
      refreshSpeechPluginRegistryIfNeeded: (cli: {
        env: NodeJS.ProcessEnv;
        runtimeRoot: string;
        openclawEntry: string;
        port: number;
        token: string;
      }) => Promise<void>;
    };
    manager.stateDir = directory;
    manager.configPath = path.join(directory, 'openclaw.json');
    manager.runCliWithEnvironment = runCliWithEnvironment;
    const cli = {
      env: { OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir },
      runtimeRoot: directory,
      openclawEntry: path.join(directory, 'openclaw.mjs'),
      port: 14041,
      token: 'test-token',
    };

    await manager.refreshSpeechPluginRegistryIfNeeded(cli);
    await manager.refreshSpeechPluginRegistryIfNeeded(cli);

    expect(runCliWithEnvironment).toHaveBeenCalledOnce();
    expect(runCliWithEnvironment).toHaveBeenCalledWith(
      cli,
      ['plugins', 'registry', '--refresh', '--json'],
      'plugin registry refresh',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('tracks managed environment changes until a Gateway launch applies them', () => {
  const manager = Object.create(OpenClawEngineManager.prototype) as unknown as {
    gatewayLaunchEnvVars: Record<string, string>;
    gatewayLaunchEnvironmentGeneration: number;
    launchedGatewayEnvironmentGeneration: number;
    setGatewayLaunchEnvVars: (vars: Record<string, string>) => void;
    getGatewayLaunchEnvVars: () => Record<string, string>;
    hasPendingGatewayLaunchEnvironmentChanges: () => boolean;
  };
  manager.gatewayLaunchEnvVars = {};
  manager.gatewayLaunchEnvironmentGeneration = 0;
  manager.launchedGatewayEnvironmentGeneration = 0;

  manager.setGatewayLaunchEnvVars({ MODEL_TOKEN: 'first' });
  expect(manager.hasPendingGatewayLaunchEnvironmentChanges()).toBe(true);
  expect(manager.gatewayLaunchEnvironmentGeneration).toBe(1);

  manager.setGatewayLaunchEnvVars({ MODEL_TOKEN: 'first' });
  expect(manager.gatewayLaunchEnvironmentGeneration).toBe(1);

  manager.launchedGatewayEnvironmentGeneration = 1;
  expect(manager.hasPendingGatewayLaunchEnvironmentChanges()).toBe(false);

  const snapshot = manager.getGatewayLaunchEnvVars();
  snapshot.MODEL_TOKEN = 'mutated outside manager';
  expect(manager.getGatewayLaunchEnvVars()).toEqual({ MODEL_TOKEN: 'first' });
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
    startGatewayOnce: () => Promise<typeof runningStatus>;
    restartGatewayOnce: (options?: { afterCurrent?: boolean }) => Promise<typeof runningStatus>;
  };
  manager.restartGatewayPromise = null;
  manager.gatewayRestartAttempt = 0;
  manager.stopGateway = stopGateway;
  manager.startGatewayOnce = startGateway;
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
    startGatewayOnce: () => Promise<typeof runningStatus>;
    restartGatewayOnce: (options?: { afterCurrent?: boolean }) => Promise<typeof runningStatus>;
  };
  manager.restartGatewayPromise = null;
  manager.gatewayRestartAttempt = 0;
  manager.stopGateway = stopGateway;
  manager.startGatewayOnce = startGateway;
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
    startGatewayOnce: () => Promise<typeof runningStatus>;
    restartGatewayOnce: (options?: { afterCurrent?: boolean }) => Promise<typeof runningStatus>;
  };
  manager.startGatewayPromise = activeStart;
  manager.restartGatewayPromise = null;
  manager.gatewayRestartAttempt = 0;
  manager.stopGateway = stopGateway;
  manager.startGatewayOnce = startGateway;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const trailing = manager.restartGateway({ afterCurrent: true });
  expect(stopGateway).not.toHaveBeenCalled();

  finishActiveStart?.(runningStatus);
  await expect(trailing).resolves.toBe(runningStatus);
  expect(stopGateway).toHaveBeenCalledOnce();
  expect(startGateway).toHaveBeenCalledOnce();
  expect(manager.restartGatewayPromise).toBeNull();
});

type LifecycleStatus = { phase: 'running' | 'ready'; version: string; canRetry: boolean };

function createDeferredGatewayLifecycle() {
  const initial = Promise.withResolvers<LifecycleStatus>();
  const restarted = Promise.withResolvers<LifecycleStatus>();
  const stopped: LifecycleStatus = { phase: 'ready', version: 'test', canRetry: false };
  const manager = Object.create(OpenClawEngineManager.prototype) as {
    startGatewayPromise: Promise<LifecycleStatus> | null;
    restartGatewayPromise: Promise<LifecycleStatus> | null;
    shutdownRequested: boolean;
    gatewayRestartAttempt: number;
    doStartGateway: () => Promise<LifecycleStatus>;
    stopGateway: () => Promise<void>;
    getStatus: () => LifecycleStatus;
    startGateway: () => Promise<LifecycleStatus>;
    restartGateway: (options?: { afterCurrent?: boolean }) => Promise<LifecycleStatus>;
  };
  manager.startGatewayPromise = null;
  manager.restartGatewayPromise = null;
  manager.shutdownRequested = false;
  manager.gatewayRestartAttempt = 0;
  manager.getStatus = () => stopped;
  const stop = vi.fn(async () => { manager.shutdownRequested = true; });
  manager.stopGateway = stop;
  const launch = vi.fn()
    .mockImplementationOnce(() => { manager.shutdownRequested = false; return initial.promise; })
    .mockImplementationOnce(() => { manager.shutdownRequested = false; return restarted.promise; });
  manager.doStartGateway = launch;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return { manager, initial, restarted, stopped, stop, launch };
}

test.each([undefined, { afterCurrent: true }])(
  'keeps readiness callers waiting for a restart queued during environment preparation (%j)',
  async options => {
    const { manager, initial, restarted, stop, launch } = createDeferredGatewayLifecycle();
    const firstReady = vi.fn();
    const start = manager.startGateway().then(status => { firstReady(); return status; });
    const restart = manager.restartGateway(options);
    const concurrentStart = manager.startGateway();
    expect(stop).not.toHaveBeenCalled();
    expect(manager.shutdownRequested).toBe(false);
    initial.resolve({ phase: 'running', version: 'old-environment', canRetry: false });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    expect(firstReady).not.toHaveBeenCalled();
    const final: LifecycleStatus = { phase: 'running', version: 'new-environment', canRetry: false };
    restarted.resolve(final);
    await expect(Promise.all([start, restart, concurrentStart])).resolves.toEqual([final, final, final]);
    expect(stop).toHaveBeenCalledOnce();
  },
);

test('preserves an explicit stop while a configuration restart waits for startup', async () => {
  const { manager, initial, stopped, launch, stop } = createDeferredGatewayLifecycle();
  const start = manager.startGateway();
  const restart = manager.restartGateway();
  await manager.stopGateway();
  initial.resolve(stopped);
  await expect(Promise.all([start, restart])).resolves.toEqual([stopped, stopped]);
  expect(launch).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});

test('allows a queued restart to recover a failed startup for existing readiness callers', async () => {
  const { manager, initial, restarted, launch } = createDeferredGatewayLifecycle();
  const start = manager.startGateway();
  const restart = manager.restartGateway();
  initial.reject(new Error('initial launch failed'));
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
  const final: LifecycleStatus = { phase: 'running', version: 'recovered', canRetry: false };
  restarted.resolve(final);
  await expect(Promise.all([start, restart])).resolves.toEqual([final, final]);
});

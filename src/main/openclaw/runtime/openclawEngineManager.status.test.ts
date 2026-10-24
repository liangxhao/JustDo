import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import cliRuntimeFiles from '../../../shared/openclaw/cliRuntimeFiles.json';
import { setLanguage, t } from '../../core/i18n';
import { GatewayConfigReloadMonitor } from './gatewayConfigReloadMonitor';
import { getElectronNodeRuntimePath } from './launch/electronNodeRuntime';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './openclawEngineManager';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => 'fixture-user-data' } }));
vi.mock('../../core/network/trustedCertificates', () => ({
  applyTrustedCertificateEnv: vi.fn(),
  buildTrustedCaBundle: () => 'fixture-ca.pem',
}));
vi.mock('../../core/runtime/dependencyManagerConfig', () => ({
  applyDependencyManagerConfigEnv: vi.fn(),
}));
vi.mock('../../core/runtime/portableGitRuntime', () => ({ applyPortableGitRuntimeEnv: vi.fn() }));
vi.mock('../../core/runtime/pythonRuntime', () => ({ appendPythonRuntimeToEnv: vi.fn() }));
vi.mock('./launch/electronNodeRuntime', async importOriginal => ({
  ...(await importOriginal<typeof import('./launch/electronNodeRuntime')>()),
  getElectronNodeRuntimePath: vi.fn(() => process.execPath),
  ensureElectronNodeShim: () => null,
  resolveElectronNpmBinDir: () => null,
}));

function createManager(phase: 'starting' | 'running' = 'starting') {
  const manager = Object.setPrototypeOf(
    new EventEmitter(),
    OpenClawEngineManager.prototype,
  ) as OpenClawEngineManager;
  const harness = manager as unknown as {
    status: OpenClawEngineStatus;
    stateDir: string;
    configPath: string;
    systemPromptReplacementRulesPath: string;
    gatewayPort: number;
    resolveRuntimeMetadata: () => { root: string | null; version: string | null };
    ensureBareEntryFiles: ReturnType<typeof vi.fn>;
    ensureGatewayToken: () => string;
    ensureBundledCliShims: () => null;
    readGatewayPort: () => number;
    writeGatewayPort: ReturnType<typeof vi.fn>;
    resolveGatewayPort: ReturnType<typeof vi.fn>;
  };
  harness.status = { phase, version: 'test', message: `Gateway ${phase}`, canRetry: false };
  harness.resolveRuntimeMetadata = () => ({ root: 'fixture-runtime', version: 'test' });
  const statuses: OpenClawEngineStatus[] = [];
  manager.on('status', status => statuses.push(status));
  return { manager, harness, statuses };
}

afterEach(() => { vi.restoreAllMocks(); setLanguage('zh'); });

describe('Gateway lifecycle during runtime environment reads', () => {
  it.each(['zh', 'en'] as const)('localizes bundled Node admission failures in %s and keeps diagnostic secrets redacted', async language => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-status-'));
    try {
      for (const name of cliRuntimeFiles) fs.writeFileSync(path.join(directory, name), '');
      const { manager, harness } = createManager('running');
      harness.resolveRuntimeMetadata = () => ({ root: directory, version: 'test' });
      harness.stateDir = directory;
      harness.configPath = path.join(directory, 'openclaw.json');
      harness.systemPromptReplacementRulesPath = path.join(directory, 'prompt-rules.json');
      harness.gatewayPort = 14041;
      harness.ensureBareEntryFiles = vi.fn();
      harness.ensureGatewayToken = () => 'fixture-token';
      harness.readGatewayPort = () => 14041;
      harness.writeGatewayPort = vi.fn();
      const cause = new Error('Bundled Node damaged; token=private-fixture-token');
      vi.mocked(getElectronNodeRuntimePath).mockImplementationOnce(() => { throw cause; });
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      setLanguage(language);

      await expect(manager.buildCliEnvironment()).rejects.toMatchObject({
        message: t('runtimeNodeUnavailable'), cause,
      });
      expect(JSON.stringify(diagnostic.mock.calls)).toContain('Bundled Node damaged');
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-fixture-token');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds diagnostics to the failure attempt, masks credentials and advances identity on retry', () => {
    const { manager } = createManager('running');
    const internal = manager as unknown as { gatewayProcessGeneration: number; setStatus: (status: OpenClawEngineStatus) => void };
    internal.gatewayProcessGeneration = 7;
    const time = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    internal.setStatus({ phase: 'starting', version: 'test', canRetry: false });
    time.mockReturnValue(300_000);
    internal.setStatus({ phase: 'error', version: 'test', canRetry: true, message: 'api_key=private-secret EADDRINUSE' });
    const failure = manager.getDiagnosticContext();
    expect(failure).toMatchObject({ startedAt: 10_000, failedAt: 300_000, processGeneration: 7 });
    expect(failure.id).toBe(manager.getStatus().diagnosticId);
    expect(failure.status.message).not.toContain('private-secret');
    const again = manager.getDiagnosticContext();
    expect(again.failedAt).toBe(failure.failedAt);
    internal.setStatus({ phase: 'starting', version: 'test', canRetry: false });
    expect(manager.getDiagnosticContext().id).not.toBe(failure.id);
    expect(manager.getStatus().diagnosticId).toBeUndefined();
  });

  it('publishes native in-process restart and completion only for the current process', () => {
    const { manager, statuses } = createManager('running');
    const child = {};
    const internals = manager as unknown as {
      gatewayProcess: object;
      gatewayConfigReloadMonitor: GatewayConfigReloadMonitor;
      observeGatewayProcessLine: (child: object, line: string) => void;
    };
    internals.gatewayProcess = child;
    internals.gatewayConfigReloadMonitor = new GatewayConfigReloadMonitor();

    internals.observeGatewayProcessLine({}, '[gateway] received SIGUSR1; restarting');
    expect(statuses).toEqual([]);
    internals.observeGatewayProcessLine(child, '[gateway] received SIGUSR1; restarting');
    expect(manager.getStatus()).toMatchObject({ phase: 'starting', restarting: true });
    internals.observeGatewayProcessLine({}, '[gateway] ready');
    expect(manager.getStatus().phase).toBe('starting');
    internals.observeGatewayProcessLine(child, '[gateway] ready');
    expect(manager.getStatus()).toMatchObject({ phase: 'running' });
    expect(manager.getStatus().restarting).toBeUndefined();
  });

  it('keeps a full restart visible through the intermediate stopped state', async () => {
    const { manager, statuses } = createManager('running');
    const internals = manager as unknown as {
      shutdownRequested: boolean;
      setStatus: (status: OpenClawEngineStatus) => void;
      startGatewayOnce: () => Promise<OpenClawEngineStatus>;
    };
    manager.stopGateway = vi.fn(async () => {
      internals.setStatus({ phase: 'ready', version: 'test', canRetry: false });
    });
    internals.startGatewayOnce = vi.fn(async () => {
      expect(manager.getStatus()).toMatchObject({ phase: 'starting', restarting: true });
      internals.setStatus({ phase: 'running', version: 'test', canRetry: false });
      return manager.getStatus();
    });

    await expect(manager.restartGateway()).resolves.toMatchObject({ phase: 'running' });

    expect(statuses.map(status => status.phase)).toEqual(['starting', 'starting', 'running']);
    expect(statuses.slice(0, 2).every(status => status.restarting)).toBe(true);
    expect(manager.getStatus().restarting).toBeUndefined();
  });

  it('clears the restarting notice when explicitly stopped during restart preparation', async () => {
    const { manager } = createManager('running');
    const internals = manager as unknown as {
      shutdownRequested: boolean;
      setStatus: (status: OpenClawEngineStatus) => void;
      startGatewayOnce: () => Promise<OpenClawEngineStatus>;
    };
    manager.stopGateway = vi.fn(async () => {});
    internals.startGatewayOnce = vi.fn(async () => {
      internals.shutdownRequested = true;
      internals.setStatus({ phase: 'ready', version: 'test', canRetry: false });
      return manager.getStatus();
    });

    await expect(manager.restartGateway()).resolves.toMatchObject({ phase: 'ready' });
    expect(manager.getStatus().restarting).toBeUndefined();
  });

  it.each(['starting', 'running'] as const)(
    'preserves %s status when a page checks runtime readiness',
    async phase => {
      const { manager, statuses } = createManager(phase);
      const before = manager.getStatus();

      await expect(manager.ensureReady()).resolves.toEqual(before);

      expect(manager.getStatus()).toEqual(before);
      expect(statuses).toEqual([]);
    },
  );

  it.each([
    { root: null, version: null },
    { root: 'fixture-runtime', version: null },
  ])('still reports invalid runtime metadata during startup: %j', async runtime => {
    const { manager, harness, statuses } = createManager();
    harness.resolveRuntimeMetadata = () => runtime;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(manager.ensureReady()).resolves.toMatchObject({ phase: 'error', canRetry: true });

    expect(statuses).toHaveLength(1);
    expect(statuses[0].phase).toBe('error');
  });

  it.each(['starting', 'running'] as const)(
    'allows CLI reads while %s without changing status or reallocating the Gateway port',
    async phase => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-status-'));
      try {
        for (const name of cliRuntimeFiles) fs.writeFileSync(path.join(directory, name), '');
        const { manager, harness, statuses } = createManager(phase);
        harness.resolveRuntimeMetadata = () => ({ root: directory, version: 'test' });
        harness.stateDir = directory;
        harness.configPath = path.join(directory, 'openclaw.json');
        harness.systemPromptReplacementRulesPath = path.join(directory, 'prompt-rules.json');
        harness.gatewayPort = 14041;
        harness.ensureBareEntryFiles = vi.fn();
        harness.ensureGatewayToken = () => 'fixture-token';
        harness.ensureBundledCliShims = () => null;
        harness.readGatewayPort = () => 14041;
        harness.writeGatewayPort = vi.fn();
        harness.resolveGatewayPort = vi.fn(async () => 14042);
        const before = manager.getStatus();

        const cli = await manager.buildCliEnvironment();

        expect(cli.port).toBe(14041);
        expect(cli.env.OPENCLAW_GATEWAY_PORT).toBe('14041');
        expect(manager.getStatus()).toEqual(before);
        expect(statuses).toEqual([]);
        expect(harness.resolveGatewayPort).not.toHaveBeenCalled();
        expect(harness.writeGatewayPort).toHaveBeenCalledWith(14041);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

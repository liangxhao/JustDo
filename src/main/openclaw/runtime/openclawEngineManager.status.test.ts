import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import cliRuntimeFiles from '../../../shared/openclaw/cliRuntimeFiles.json';
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
vi.mock('./electronNodeRuntime', async importOriginal => ({
  ...(await importOriginal<typeof import('./electronNodeRuntime')>()),
  getElectronNodeRuntimePath: () => process.execPath,
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

afterEach(() => vi.restoreAllMocks());

describe('Gateway lifecycle during runtime environment reads', () => {
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

import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { OpenClawPluginCapabilityReview } from '../../../shared/plugins/extensions';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { ManagedDirectoryOperationCoordinator } from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  type ApplyExtensionPackageMutation,
  ExtensionPackageLifecycleMode,
  type ExtensionPackageMutationTarget,
} from './extensionPackageLifecycle';
import * as extensionPackageOwnership from './extensionPackageOwnership';
import { OpenClawExtensionImportService } from './openclawExtensionImportService';

vi.mock('../../core/filesystem/windowsFileLockDiagnostics', () => ({
  findWindowsLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
}));

let fixtureRoot: string;
beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-package-install-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function fixture(
  options: {
    companion?: boolean;
    activationTimeout?: boolean;
    leased?: boolean;
    cleanupFailure?: boolean;
    policyRecoveryFailure?: boolean;
  } = {},
) {
  const source = path.join(fixtureRoot, 'source');
  const state = path.join(fixtureRoot, 'state');
  const installed = path.join(state, 'extensions', 'package-plugin');
  const configPath = path.join(state, 'openclaw.json');
  fs.mkdirSync(source);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(source, 'openclaw.plugin.json'), '{"id":"package-plugin"}');
  if (options.companion) {
    fs.mkdirSync(path.join(source, 'app'));
    fs.writeFileSync(path.join(source, 'app', 'app.artifact.json'), '{}');
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: { allow: ['package-plugin'], entries: { 'package-plugin': { enabled: false } } },
    }),
  );
  const reviewToken = 'Reviewed-Token: exact fixture';
  const review: OpenClawPluginCapabilityReview = {
    reviewToken,
    declared: {
      channels: [],
      providers: [],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: false },
        allowConversationAccess: { effective: false },
      },
    },
  };
  const manager = {
    getStatus: () => ({
      phase: 'ready',
      message: 'OpenClaw runtime is ready. Gateway is stopped.',
    }),
    isGatewayMutationInProgress: () => options.leased !== false,
    getBaseDir: () => fixtureRoot,
    getStateDir: () => state,
    getConfigPath: () => configPath,
    getGatewayProcessId: () => null,
    getGatewayProcessGeneration: () => 1,
    buildCliEnvironment: async () => ({
      env: { JUSTDO_ELECTRON_PATH: process.execPath, OPENCLAW_STATE_DIR: state },
      runtimeRoot: fixtureRoot,
      openclawEntry: path.join(fixtureRoot, 'openclaw.mjs'),
    }),
  } as unknown as OpenClawEngineManager;
  const requestGateway = vi.fn(async () => {
    throw new Error('RPC must not start a leased Gateway');
  });
  const runCommand = vi.fn(async (
    _executable: string,
    args: string[],
    _commandOptions?: { successPattern?: RegExp },
  ) => {
    if (args[2] === 'install') {
      fs.cpSync(args[3], installed, { recursive: true });
      return {
        exitCode: options.cleanupFailure ? 1 : 0,
        stdout: 'Installed plugin: package-plugin\nSaved for the next Gateway start.',
        stderr: options.cleanupFailure ? 'Native command finalization failed' : '',
        ...(options.cleanupFailure ? { nativeReceiptObserved: true as const } : {}),
      };
    }
    expect(args.slice(1)).toEqual(['plugins', 'enable', 'package-plugin']);
    if (options.activationTimeout) return { exitCode: 124, timedOut: true, stdout: '', stderr: '' };
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.plugins.entries['package-plugin'].enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config));
    return { exitCode: 0, stdout: 'Enabled plugin "package-plugin"', stderr: '' };
  });
  const inspectCapabilityReview = vi.fn(async () => ({ extensionId: 'package-plugin', review }));
  const reconcilePolicy = vi.fn(() => ({ enabled: false, groups: [], digest: 'stable' }));
  if (options.policyRecoveryFailure) {
    reconcilePolicy
      .mockReturnValueOnce({ enabled: false, groups: [], digest: 'stable' })
      .mockImplementation(() => {
        throw new Error('Outbound policy recovery denied');
      });
  }
  const service = new OpenClawExtensionImportService({
    getOpenClawEngineManager: () => manager,
    requestGateway,
    getConnectedGatewayClient: () => null,
    requiresHotToggle: () => options.companion === true,
    inspectCapabilityReview,
    runCommand,
    ...(options.policyRecoveryFailure ? {
      outboundHeaderPolicy: {
        inspectExtension: vi.fn(() => null),
        reconcile: reconcilePolicy,
      },
    } : {}),
  });
  return {
    service,
    source,
    installed,
    configPath,
    manager,
    reviewToken,
    runCommand,
    requestGateway,
    inspectCapabilityReview,
    reconcilePolicy,
  };
}

test('installs once without manual review while holding the stopped package lease', async () => {
  const f = fixture();

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true,
  });

  expect(result).toMatchObject({
    success: true,
    extensionId: 'package-plugin',
    installPath: f.installed,
  });
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.runCommand).toHaveBeenCalledOnce();
  const args = f.runCommand.mock.calls[0][1];
  expect(args).toContain('--accept-capabilities');
  expect(args).not.toContain('--capability-review-token');
  expect(args).not.toContain(f.reviewToken);
  expect(f.inspectCapabilityReview).not.toHaveBeenCalled();
});

test('does not start an automatic install without the stopped package owner', async () => {
  const f = fixture({ leased: false });

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true,
  });

  expect(result).toMatchObject({ success: false, error: t('extensionInstallMutationUnavailable') });
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.inspectCapabilityReview).not.toHaveBeenCalled();
  expect(fs.existsSync(f.installed)).toBe(false);
});

test('matches a custom multi-entry install receipt by its native child while retaining the canonical package path', async () => {
  const f = fixture();
  const childIds = ['package-plugin/alpha', 'package-plugin/beta'];
  fs.writeFileSync(path.join(f.source, 'package.json'), JSON.stringify({
    name: 'package-plugin',
    type: 'module',
    openclaw: { extensions: ['./alpha.js', './beta.js'] },
  }));
  for (const entry of ['alpha.js', 'beta.js']) {
    fs.writeFileSync(path.join(f.source, entry), 'export default {};');
  }
  const artifactIds = vi.spyOn(extensionPackageOwnership, 'readExtensionArtifactPluginIds')
    .mockResolvedValue(childIds);
  const packageOwnership = vi.spyOn(extensionPackageOwnership, 'readExtensionPackageOwnership')
    .mockResolvedValue([{
      ownerId: 'package-plugin',
      pluginIds: childIds,
      installPath: f.installed,
    }]);
  const receipt = `Installed plugin: ${childIds[0]}\nSaved for the next Gateway start.`;
  f.runCommand.mockImplementationOnce(async (_executable, args, commandOptions) => {
    expect(args.slice(1, 3)).toEqual(['plugins', 'install']);
    expect(commandOptions?.successPattern?.test(receipt)).toBe(true);
    expect(commandOptions?.successPattern?.test(
      'Installed plugin: package-plugin\nSaved for the next Gateway start.',
    )).toBe(false);
    fs.cpSync(args[3], f.installed, { recursive: true });
    return { exitCode: 0, stdout: receipt, stderr: '', nativeReceiptObserved: true as const };
  });

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true,
  });

  expect(result).toMatchObject({
    success: true,
    extensionId: childIds[0],
    installPath: f.installed,
  });
  expect(artifactIds).toHaveBeenCalledExactlyOnceWith(f.manager, f.source);
  expect(packageOwnership).toHaveBeenCalledExactlyOnceWith(f.manager);
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.inspectCapabilityReview).not.toHaveBeenCalled();
});

test('retains acknowledged installation after the CLI exits with a later cleanup error', async () => {
  const f = fixture({ cleanupFailure: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true,
  });

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    installPath: f.installed,
  });
  expect(result.error).toContain('Native command finalization failed');
  expect(result.installSourceInUse).not.toBe(true);
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.requestGateway).not.toHaveBeenCalled();
});

test('keeps the native installation failure ahead of a later outbound policy recovery failure', async () => {
  const f = fixture({ cleanupFailure: true, policyRecoveryFailure: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true,
  });

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    installPath: f.installed,
    failedStage: 'installing',
  });
  expect(result.error).toContain('Native command finalization failed');
  expect(result.error).toContain('Outbound policy recovery denied');
  expect(result.error!.indexOf('Native command finalization failed')).toBeLessThan(
    result.error!.indexOf('Outbound policy recovery denied'),
  );
  expect(result.installSourceInUse).not.toBe(true);
  expect(result.operationUnconfirmed).not.toBe(true);
  expect(f.reconcilePolicy).toHaveBeenCalledTimes(2);
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.requestGateway).not.toHaveBeenCalled();
});

test('finishes a trusted marketplace plain-plugin activation through one cold enable command', async () => {
  const f = fixture();

  const result = await f.service.importPath(f.source, undefined, undefined, {
    trustMarketplaceSource: true,
  });

  expect(result).toMatchObject({ success: true, extensionId: 'package-plugin' });
  expect(f.runCommand).toHaveBeenCalledTimes(2);
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(
    JSON.parse(fs.readFileSync(f.configPath, 'utf8')).plugins.entries['package-plugin'].enabled,
  ).toBe(true);
});

test('keeps an app companion disabled for separate hash approval and preserves hot-only public toggles', async () => {
  const f = fixture({ companion: true });

  const result = await f.service.importPath(f.source, undefined, undefined, {
    trustMarketplaceSource: true,
  });

  expect(result).toMatchObject({ success: true, extensionId: 'package-plugin' });
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.runCommand.mock.calls[0][1]).toContain('--no-enable');
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(
    JSON.parse(fs.readFileSync(f.configPath, 'utf8')).plugins.entries['package-plugin'].enabled,
  ).toBe(false);
  await expect(f.service.setEnabled('package-plugin', true)).resolves.toMatchObject({
    success: false,
  });
  expect(f.runCommand).toHaveBeenCalledOnce();
});

test('preserves the saved installation and unknown activation outcome after a cold CLI timeout', async () => {
  const f = fixture({ activationTimeout: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const result = await f.service.importPath(f.source, undefined, undefined, {
    trustMarketplaceSource: true,
  });

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    operationUnconfirmed: true,
    operationFailedStage: PluginOperationStage.ENABLING,
    error: t('extensionCommandTimedOutUnconfirmed'),
  });
  expect(f.runCommand).toHaveBeenCalledTimes(2);
  expect(f.requestGateway).not.toHaveBeenCalled();
});

function routedFixture(options: {
  companion?: boolean;
  outcome?: 'unknown' | 'persisted-error' | 'incomplete' | 'not-sent';
  restartRequired?: boolean;
  policyChanged?: boolean;
  marketplaceDisabled?: boolean;
  disconnectAfterInstall?: boolean;
  activationRestartRequired?: boolean;
  policyChangedOnActivation?: boolean;
  activationUnknown?: boolean;
  directoryOperations?: ManagedDirectoryOperationCoordinator;
} = {}) {
  const source = path.join(fixtureRoot, 'managed-source');
  const state = path.join(fixtureRoot, 'managed-state');
  const installed = path.join(state, 'extensions', 'package-plugin');
  const configPath = path.join(state, 'openclaw.json');
  fs.mkdirSync(source);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(source, 'openclaw.plugin.json'), '{"id":"package-plugin"}');
  fs.writeFileSync(configPath, JSON.stringify({
    plugins: options.marketplaceDisabled ? {
      entries: { 'package-plugin': { enabled: false } },
    } : {},
  }));
  if (options.companion) {
    fs.mkdirSync(path.join(source, 'app'));
    fs.writeFileSync(path.join(source, 'app', 'app.artifact.json'), '{}');
  }
  let stopped = false;
  let configMutation = false;
  let committed = false;
  let activated = false;
  let connected = true;
  const sources: string[] = [];
  const targets: ExtensionPackageMutationTarget[] = [];
  const publishSource = async (installSource: string) => {
    if (fs.statSync(installSource).isDirectory()) {
      fs.cpSync(installSource, installed, { recursive: true });
    } else {
      fs.mkdirSync(installed, { recursive: true });
      await tar.extract({ file: installSource, cwd: installed, strip: 1 });
    }
  };
  const manager = {
    getStatus: () => ({ phase: stopped ? 'ready' : 'running' }),
    isGatewayMutationInProgress: () => stopped,
    getBaseDir: () => fixtureRoot,
    getStateDir: () => state,
    getConfigPath: () => configPath,
    getGatewayProcessId: () => stopped ? null : 123,
    getGatewayProcessGeneration: () => 1,
    buildCliEnvironment: async () => ({
      env: { JUSTDO_ELECTRON_PATH: process.execPath, OPENCLAW_STATE_DIR: state },
      runtimeRoot: fixtureRoot,
      openclawEntry: path.join(fixtureRoot, 'openclaw.mjs'),
    }),
  } as unknown as OpenClawEngineManager;
  const connectedRequest = vi.fn(async (method: string, params: {
    path: string; enable?: boolean; enabled?: boolean; acknowledgeCapabilities?: unknown;
  }) => {
    expect(configMutation).toBe(true);
    if (method === 'plugins.setEnabled') {
      if (options.activationUnknown) throw new Error('Gateway request timed out during activation');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.plugins.entries['package-plugin'].enabled = params.enabled;
      fs.writeFileSync(configPath, JSON.stringify(config));
      activated = true;
      return { ok: true, restartRequired: options.activationRestartRequired === true };
    }
    expect(method).toBe('plugins.install');
    sources.push(params.path);
    if (options.outcome === 'unknown') throw new Error('Native install response lost');
    if (options.outcome === 'not-sent')
      throw Object.assign(new Error('Connection retired'), { code: 'CLIENT_CLOSED', requestSent: false });
    await publishSource(params.path);
    committed = true;
    if (options.disconnectAfterInstall) connected = false;
    if (options.outcome === 'persisted-error')
      throw Object.assign(new Error('Native application failed after persistence'), {
        details: { persistence: { operation: 'install', pluginId: 'package-plugin' } },
      });
    return {
      ok: true,
      plugin: { id: 'package-plugin' },
      restartRequired: options.restartRequired === true,
      ...(options.outcome === 'incomplete' ? {} : {
        runtime: { generation: 2, pluginIds: ['package-plugin'] },
      }),
    };
  });
  const client = { request: connectedRequest };
  const requestGateway = vi.fn(async () => {
    throw new Error('Managed installs must not start or recover Gateway through an ordinary request');
  });
  const runCommand = vi.fn(async (_executable: string, args: string[]) => {
    expect(stopped).toBe(true);
    expect(configMutation).toBe(true);
    expect(args.slice(1, 3)).toEqual(['plugins', 'install']);
    sources.push(args[3]);
    await publishSource(args[3]);
    committed = true;
    return {
      exitCode: 0, stdout: 'Installed plugin: package-plugin\nSaved for the next Gateway start.', stderr: '',
    };
  });
  const restartGatewayAfterMutation = vi.fn(async () => ({ phase: 'running' }));
  const service = new OpenClawExtensionImportService({
    getOpenClawEngineManager: () => manager,
    getConnectedGatewayClient: () => connected ? client : null,
    requestGateway,
    runCommand,
    restartGatewayAfterMutation,
    ...(options.directoryOperations ? { directoryOperations: options.directoryOperations } : {}),
    runConfigMutationExclusive: async operation => {
      expect(configMutation).toBe(false);
      configMutation = true;
      try { return await operation(); }
      finally { configMutation = false; }
    },
    outboundHeaderPolicy: {
      inspectExtension: vi.fn(() => null),
      reconcile: () => ({
        enabled: false, groups: [], digest:
          (committed && options.policyChanged) || (activated && options.policyChangedOnActivation)
            ? 'changed' : 'stable',
      }),
    },
  });
  const applyPackageMutation: ApplyExtensionPackageMutation = vi.fn(async (target, operation) => {
    expect(configMutation).toBe(false);
    targets.push(target);
    stopped = fs.existsSync(path.join(target.sourceDirectory!, 'app', 'app.artifact.json')) ||
      fs.existsSync(path.join(target.installPath!, 'app', 'app.artifact.json'));
    try {
      return await operation(stopped
        ? ExtensionPackageLifecycleMode.STOPPED : ExtensionPackageLifecycleMode.HOT);
    } finally {
      // Recovery can enter the same config queue only after the write releases it.
      expect(configMutation).toBe(false);
      stopped = false;
    }
  });
  return {
    service, source, installed, configPath, manager, sources, targets, applyPackageMutation,
    connectedRequest, requestGateway, runCommand, restartGatewayAfterMutation,
    disconnect: () => { connected = false; },
    inConfigMutation: () => configMutation,
  };
}

test.each([
  { trustMarketplaceSource: false, preserveActivation: false },
  { trustMarketplaceSource: true, preserveActivation: true },
])('installs a managed plain package through one live native request: %o', async intent => {
  const f = routedFixture();
  const onInstalled = vi.fn(async result => result);
  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, ...intent,
    applyPackageMutation: f.applyPackageMutation, onInstalled,
  });
  expect(result).toMatchObject({ success: true, extensionId: 'package-plugin', installPath: f.installed });
  expect(f.connectedRequest).toHaveBeenCalledExactlyOnceWith('plugins.install', {
    source: 'local', path: f.sources[0], mode: 'update',
    ...(intent.preserveActivation ? { enable: false } : {}),
  }, { timeoutMs: 600_000 });
  expect(f.sources[0]).not.toBe(f.source);
  expect(f.targets[0]).toMatchObject({
    nativePluginIds: ['package-plugin'], sourceDirectory: f.sources[0], installPath: f.installed,
  });
  expect(onInstalled).toHaveBeenCalledWith(result, ExtensionPackageLifecycleMode.HOT);
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  expect(fs.existsSync(f.sources[0])).toBe(false);
});

test('updates once despite an advisory Explorer handle and preserves the disabled state', async () => {
  const findLockingProcesses = vi.fn(async () => ({
    available: true, processes: [{ name: 'explorer', pid: 12996 }],
  }));
  const f = routedFixture({
    marketplaceDisabled: true,
    directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
  });
  fs.mkdirSync(f.installed, { recursive: true });
  fs.writeFileSync(path.join(f.installed, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'package-plugin', version: '1.0.0' }));
  fs.writeFileSync(path.join(f.source, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'package-plugin', version: '2.0.0' }));
  const originalConfig = fs.readFileSync(f.configPath, 'utf8');

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true, preserveActivation: true,
    applyPackageMutation: f.applyPackageMutation,
  });

  expect(result).toMatchObject({ success: true, extensionId: 'package-plugin' });
  expect(f.connectedRequest).toHaveBeenCalledExactlyOnceWith('plugins.install', {
    source: 'local', path: f.sources[0], mode: 'update', enable: false,
  }, { timeoutMs: 600_000 });
  expect(findLockingProcesses).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(path.join(f.installed, 'openclaw.plugin.json'), 'utf8')).version)
    .toBe('2.0.0');
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(originalConfig);
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

test('diagnoses an explicit native update rejection after dispatch and keeps its recovery details', async () => {
  const findLockingProcesses = vi.fn(async () => {
    expect(f.connectedRequest).toHaveBeenCalledOnce();
    return { available: true, processes: [{ name: 'explorer', pid: 12996 }] };
  });
  const f = routedFixture({
    marketplaceDisabled: true,
    directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
  });
  fs.mkdirSync(f.installed, { recursive: true });
  const oldManifest = JSON.stringify({ id: 'package-plugin', version: '1.0.0' });
  fs.writeFileSync(path.join(f.installed, 'openclaw.plugin.json'), oldManifest);
  const backupPath = path.join(fixtureRoot, 'native-retained-backup');
  fs.cpSync(f.installed, backupPath, { recursive: true });
  const nativeReason = `EPERM: operation not permitted, rename; could not restore existing install; backup recovery path: ${backupPath}`;
  f.connectedRequest.mockRejectedValueOnce(Object.assign(new Error(nativeReason), {
    gatewayCode: 'UNAVAILABLE',
  }));
  const originalConfig = fs.readFileSync(f.configPath, 'utf8');

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true, preserveActivation: true,
    applyPackageMutation: f.applyPackageMutation,
  });

  expect(result).toMatchObject({
    success: false, failedStage: 'installing', error: expect.stringContaining(nativeReason),
  });
  expect(result.error).toContain('explorer (PID 12996)');
  expect(result.installationCommitted).not.toBe(true);
  expect(result.installSourceInUse).not.toBe(true);
  expect(findLockingProcesses).toHaveBeenCalledExactlyOnceWith(f.installed);
  expect(fs.readFileSync(path.join(f.installed, 'openclaw.plugin.json'), 'utf8')).toBe(oldManifest);
  expect(fs.readFileSync(path.join(backupPath, 'openclaw.plugin.json'), 'utf8')).toBe(oldManifest);
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(originalConfig);
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

test('retains both ends of a long native update failure while redacting credentials before logging', async () => {
  const findLockingProcesses = vi.fn(async () => ({
    available: true, processes: [{ name: 'explorer', pid: 12996 }],
  }));
  const f = routedFixture({
    directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
  });
  fs.mkdirSync(f.installed, { recursive: true });
  fs.writeFileSync(path.join(f.installed, 'openclaw.plugin.json'), '{"id":"package-plugin"}');
  const backupPath = path.join(fixtureRoot, 'native-retained-backup');
  const nativeReason = [
    '\u001b[31mEPERM: original update rename failure\u001b[0m',
    'Authorization: Bearer fixture-sensitive-authorization',
    '_authToken=fixture-sensitive-npm-token',
    String.raw`--token "C:\credential-private\私密 目录\fixture-sensitive-path-secret"`,
    String.raw`password="C:\credential-private\私密 目录\config"`,
    'native diagnostic context '.repeat(90),
    `Could not restore existing install; backup recovery path: ${backupPath}`,
  ].join('\n');
  f.connectedRequest.mockRejectedValueOnce(Object.assign(new Error(nativeReason), {
    gatewayCode: 'UNAVAILABLE',
  }));
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true, preserveActivation: true,
    applyPackageMutation: f.applyPackageMutation,
  });

  expect(result).toMatchObject({ success: false, failedStage: 'installing' });
  expect(result.error).toContain('EPERM: original update rename failure');
  expect(result.error).toContain('Could not restore existing install; backup recovery path:');
  expect(result.error).toContain(backupPath);
  expect(result.error).toContain('explorer (PID 12996)');
  const logged = errorLog.mock.calls.flat().join('\n');
  for (const output of [result.error!, logged]) {
    expect(output).not.toContain('fixture-sensitive-authorization');
    expect(output).not.toContain('fixture-sensitive-npm-token');
    expect(output).not.toContain('credential-private');
    expect(output).not.toContain('fixture-sensitive-path-secret');
    expect(output).not.toContain('\u001b[31m');
  }
  expect(errorLog).toHaveBeenCalledOnce();
  expect(findLockingProcesses).toHaveBeenCalledExactlyOnceWith(f.installed);
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

test('redacts a JSON-encoded native credential before diagnostics and preserves its directory', async () => {
  const findLockingProcesses = vi.fn(async () => ({
    available: true, processes: [{ name: 'explorer', pid: 12996 }],
  }));
  const f = routedFixture({
    directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
  });
  fs.mkdirSync(f.installed, { recursive: true });
  fs.writeFileSync(path.join(f.installed, 'openclaw.plugin.json'), '{"id":"package-plugin"}');
  const message = `EPERM: ${JSON.stringify({
    message: String.raw`--token "C:\fixture-private\私密 credential-tail\secret"`,
    directory: f.installed,
  })}`;
  f.connectedRequest.mockRejectedValueOnce(Object.assign(new Error(message), { gatewayCode: 'UNAVAILABLE' }));
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true, preserveActivation: true,
    applyPackageMutation: f.applyPackageMutation,
  });

  expect(result).toMatchObject({ success: false, failedStage: 'installing' });
  expect(result.error).toContain('EPERM:');
  expect(result.error).toContain(JSON.stringify(f.installed));
  expect(result.error).toContain('explorer (PID 12996)');
  for (const text of [result.error!, errorLog.mock.calls.flat().join('\n')]) {
    expect(text).not.toContain('fixture-private');
    expect(text).not.toContain('credential-tail');
  }
  expect(findLockingProcesses).toHaveBeenCalledExactlyOnceWith(f.installed);
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

test('keeps a lost update reply unknown when its transport message includes filesystem wording', async () => {
  const findLockingProcesses = vi.fn(async () => ({
    available: true, processes: [{ name: 'explorer', pid: 12996 }],
  }));
  const f = routedFixture({
    marketplaceDisabled: true,
    directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
  });
  fs.mkdirSync(f.installed, { recursive: true });
  const oldManifest = JSON.stringify({ id: 'package-plugin', version: '1.0.0' });
  fs.writeFileSync(path.join(f.installed, 'openclaw.plugin.json'), oldManifest);
  f.connectedRequest.mockRejectedValueOnce(Object.assign(
    new Error('Native update response lost while reporting EPERM rename'),
    { code: 'CLIENT_TIMEOUT', requestSent: true },
  ));
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true, preserveActivation: true,
    applyPackageMutation: f.applyPackageMutation,
  });

  expect(result).toMatchObject({
    success: false, installSourceInUse: true,
    error: 'Native update response lost while reporting EPERM rename',
  });
  expect(result.installationCommitted).not.toBe(true);
  expect(findLockingProcesses).not.toHaveBeenCalled();
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  const installSource = f.connectedRequest.mock.calls[0][1].path;
  expect(fs.existsSync(installSource)).toBe(true);
  expect(fs.readFileSync(path.join(f.installed, 'openclaw.plugin.json'), 'utf8')).toBe(oldManifest);
  const retained = fs.realpathSync(path.dirname(installSource));
  expect(path.basename(retained).startsWith('extension-install-source-')).toBe(true);
  fs.rmSync(retained, { recursive: true, force: true });
});

test.each([
  { restartRequired: false, policyChanged: true, reason: 'extension-network-policy-change' },
  { restartRequired: true, policyChanged: false, reason: 'extension-import' },
  { restartRequired: true, policyChanged: true, reason: 'extension-import' },
])('preserves the precise required restart reason: $reason', async scenario => {
  const f = routedFixture(scenario);
  expect(await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation,
  })).toMatchObject({ success: true });
  if (scenario.restartRequired && scenario.policyChanged) {
    expect(f.restartGatewayAfterMutation).toHaveBeenCalledExactlyOnceWith(scenario.reason, {
      networkPolicyChanged: true,
    });
  } else {
    expect(f.restartGatewayAfterMutation).toHaveBeenCalledExactlyOnceWith(scenario.reason);
  }
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  expect(f.runCommand).not.toHaveBeenCalled();
});

test.each(['unknown', 'persisted-error', 'incomplete', 'not-sent'] as const)(
  'retains native evidence without replay after a managed %s outcome', async outcome => {
    const f = routedFixture({ outcome });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await f.service.importPath(f.source, undefined, undefined, {
      autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation,
    });
    expect(result.success).toBe(false);
    expect(result.installationCommitted).toBe(
      outcome === 'persisted-error' || outcome === 'incomplete' ? true : undefined);
    expect(result.installSourceInUse).toBe(outcome === 'unknown' ? true : undefined);
    expect(fs.existsSync(f.sources[0])).toBe(outcome === 'unknown');
    expect(f.connectedRequest).toHaveBeenCalledOnce();
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    if (outcome === 'unknown') {
      const retained = fs.realpathSync(path.dirname(f.sources[0]));
      expect(path.basename(retained).startsWith('extension-install-source-')).toBe(true);
      fs.rmSync(retained, { recursive: true, force: true });
    }
  },
);

test('selects a stopped companion install before writes and approves before releasing the config lane', async () => {
  const f = routedFixture({ companion: true });
  const onInstalled = vi.fn(async (result, mode) => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
    expect(f.inConfigMutation()).toBe(true);
    expect(f.manager.isGatewayMutationInProgress()).toBe(true);
    return result;
  });
  expect(await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation, onInstalled,
  })).toMatchObject({ success: true });
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.runCommand.mock.calls[0][1]).toContain('--no-enable');
  expect(f.connectedRequest).not.toHaveBeenCalled();
  expect(onInstalled).toHaveBeenCalledOnce();
});

test('classifies an existing broken companion at the actual destination before replacing it', async () => {
  const f = routedFixture();
  fs.mkdirSync(path.join(f.installed, 'app'), { recursive: true });
  fs.writeFileSync(path.join(f.installed, 'openclaw.plugin.json'), '{broken');
  fs.writeFileSync(path.join(f.installed, 'app', 'app.artifact.json'), '{}');
  expect(await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation,
  })).toMatchObject({ success: true });
  expect(f.targets[0].installPath).toBe(f.installed);
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.connectedRequest).not.toHaveBeenCalled();
});

test('uses the frozen source when the original changes after lifecycle classification', async () => {
  const f = routedFixture();
  const originalApply = f.applyPackageMutation;
  const applyPackageMutation: ApplyExtensionPackageMutation = (target, operation) => {
    fs.writeFileSync(path.join(f.source, 'openclaw.plugin.json'), '{"id":"other-app"}');
    fs.mkdirSync(path.join(f.source, 'app'));
    fs.writeFileSync(path.join(f.source, 'app', 'app.artifact.json'), '{}');
    return originalApply(target, operation);
  };
  expect(await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation,
  })).toMatchObject({ success: true, extensionId: 'package-plugin' });
  expect(fs.readFileSync(path.join(f.installed, 'openclaw.plugin.json'), 'utf8'))
    .toBe('{"id":"package-plugin"}');
  expect(fs.existsSync(path.join(f.installed, 'app'))).toBe(false);
  expect(f.runCommand).not.toHaveBeenCalled();
});

test('retains the frozen archive and its inspection tree after an unknown native installation', async () => {
  const f = routedFixture({ outcome: 'unknown' });
  const archive = path.join(fixtureRoot, 'managed-package.tgz');
  await tar.create({ file: archive, cwd: fixtureRoot }, [path.basename(f.source)]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await f.service.importPath(archive, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation,
  });
  expect(result).toMatchObject({ success: false, installSourceInUse: true });
  expect(f.sources[0]).not.toBe(archive);
  expect(f.sources[0]).toMatch(/\.tgz$/);
  expect(fs.statSync(f.sources[0]).isFile()).toBe(true);
  expect(fs.existsSync(path.join(f.targets[0].sourceDirectory!, 'openclaw.plugin.json'))).toBe(true);
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  const retainedArchive = fs.realpathSync(path.dirname(f.sources[0]));
  const retainedInspection = fs.realpathSync(path.dirname(f.targets[0].sourceDirectory!));
  expect(path.basename(retainedArchive).startsWith('extension-install-archive-')).toBe(true);
  expect(path.basename(retainedInspection).startsWith('justdo-extension-import-')).toBe(true);
  fs.rmSync(retainedArchive, { recursive: true, force: true });
  fs.rmSync(retainedInspection, { recursive: true, force: true });
});

test('installs the frozen archive when the user archive changes after inspection', async () => {
  const f = routedFixture();
  const archive = path.join(fixtureRoot, 'managed-package.tgz');
  await tar.create({ file: archive, cwd: fixtureRoot }, [path.basename(f.source)]);
  const frozenBytes = fs.readFileSync(archive);
  const applyPackageMutation: ApplyExtensionPackageMutation = (target, operation) => {
    fs.writeFileSync(archive, 'changed archive');
    return f.applyPackageMutation(target, operation);
  };
  const installedSourceBytes: Buffer[] = [];
  const nativeRequest = f.connectedRequest.getMockImplementation()!;
  f.connectedRequest.mockImplementation(async (method, params) => {
    installedSourceBytes.push(fs.readFileSync(params.path));
    return nativeRequest(method, params);
  });
  expect(await f.service.importPath(archive, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation,
  })).toMatchObject({ success: true, extensionId: 'package-plugin' });
  expect(f.sources[0]).toMatch(/\.tgz$/);
  expect(installedSourceBytes).toEqual([frozenBytes]);
  expect(fs.readFileSync(path.join(f.installed, 'openclaw.plugin.json'), 'utf8'))
    .toBe('{"id":"package-plugin"}');
  expect(fs.existsSync(f.sources[0])).toBe(false);
  expect(fs.existsSync(f.targets[0].sourceDirectory!)).toBe(false);
  expect(f.connectedRequest).toHaveBeenCalledOnce();
  expect(f.runCommand).not.toHaveBeenCalled();
});

test('classifies the native package directory before a misleading archive root manifest', async () => {
  const f = routedFixture();
  const archiveRoot = path.join(fixtureRoot, 'mixed-archive');
  const packageRoot = path.join(archiveRoot, 'package');
  fs.mkdirSync(path.join(packageRoot, 'app'), { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, 'openclaw.plugin.json'), '{"id":"misleading-root"}');
  fs.writeFileSync(path.join(packageRoot, 'openclaw.plugin.json'), '{"id":"package-plugin"}');
  fs.writeFileSync(path.join(packageRoot, 'app', 'app.artifact.json'), '{}');
  const archive = path.join(fixtureRoot, 'mixed-package.tgz');
  await tar.create({ file: archive, cwd: archiveRoot }, ['openclaw.plugin.json', 'package']);
  const onInstalled = vi.fn(async (result, mode) => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
    return result;
  });
  expect(await f.service.importPath(archive, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation, onInstalled,
  })).toMatchObject({ success: true, extensionId: 'package-plugin' });
  expect(path.basename(f.targets[0].sourceDirectory!)).toBe('package');
  expect(f.targets[0].nativePluginIds).toEqual(['package-plugin']);
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.runCommand.mock.calls[0][1]).toContain('--no-enable');
  expect(f.connectedRequest).not.toHaveBeenCalled();
  expect(onInstalled).toHaveBeenCalledOnce();
});

test('does not start a disconnected Gateway during a managed hot installation', async () => {
  const f = routedFixture();
  f.disconnect();
  expect(await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation: f.applyPackageMutation,
  })).toMatchObject({ success: false, error: t('extensionInstallMutationUnavailable') });
  expect(f.connectedRequest).not.toHaveBeenCalled();
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.runCommand).not.toHaveBeenCalled();
});

test.each([false, true])('keeps marketplace activation on the captured connection (disconnect: %s)', async disconnect => {
  const f = routedFixture({ marketplaceDisabled: true, disconnectAfterInstall: disconnect });
  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true,
    applyPackageMutation: f.applyPackageMutation,
  });
  expect(result.success).toBe(!disconnect);
  expect(f.connectedRequest.mock.calls.map(([method]) => method)).toEqual(disconnect
    ? ['plugins.install'] : ['plugins.install', 'plugins.setEnabled']);
  if (disconnect) expect(result.installationCommitted).toBe(true);
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

test.each([
  { restartRequired: true, activationRestartRequired: true },
  { restartRequired: false, activationRestartRequired: false },
])('converges the combined install and activation receipts once: %o', async native => {
  const f = routedFixture({
    ...native, marketplaceDisabled: true, policyChangedOnActivation: true,
  });
  expect(await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true,
    applyPackageMutation: f.applyPackageMutation,
  })).toMatchObject({ success: true });
  expect(f.connectedRequest.mock.calls.map(([method]) => method))
    .toEqual(['plugins.install', 'plugins.setEnabled']);
  if (native.restartRequired) {
    expect(f.restartGatewayAfterMutation).toHaveBeenCalledExactlyOnceWith('extension-import', {
      networkPolicyChanged: true,
    });
  } else {
    expect(f.restartGatewayAfterMutation).toHaveBeenCalledExactlyOnceWith('extension-network-policy-change');
  }
  expect(f.runCommand).not.toHaveBeenCalled();
});

test('preserves a committed install and unknown activation while honoring its required restart once', async () => {
  const f = routedFixture({ restartRequired: true, marketplaceDisabled: true, activationUnknown: true });
  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, trustMarketplaceSource: true,
    applyPackageMutation: f.applyPackageMutation,
  });
  expect(result).toMatchObject({
    success: false, installationCommitted: true, operationUnconfirmed: true,
    operationFailedStage: PluginOperationStage.ENABLING,
  });
  expect(f.connectedRequest.mock.calls.map(([method]) => method))
    .toEqual(['plugins.install', 'plugins.setEnabled']);
  expect(f.restartGatewayAfterMutation).toHaveBeenCalledExactlyOnceWith('extension-import');
  expect(f.runCommand).not.toHaveBeenCalled();
});

test('keeps the committed receipt when selective lifecycle recovery fails after the write', async () => {
  const f = routedFixture({ companion: true });
  const applyPackageMutation: ApplyExtensionPackageMutation = async (target, operation) => {
    await f.applyPackageMutation(target, operation);
    throw new Error('Synthetic reconnection failure');
  };
  const result = await f.service.importPath(f.source, undefined, undefined, {
    autoAcceptCapabilities: true, applyPackageMutation,
  });
  expect(result).toMatchObject({
    success: false, installationCommitted: true, installPath: f.installed,
    operationFailedStage: PluginOperationStage.PREPARING_RUNTIME,
    error: expect.stringContaining('Synthetic reconnection failure'),
  });
  expect(f.runCommand).toHaveBeenCalledOnce();
  expect(f.connectedRequest).not.toHaveBeenCalled();
});

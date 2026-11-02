import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { OpenClawPluginCapabilityReview } from '../../../shared/plugins/extensions';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
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

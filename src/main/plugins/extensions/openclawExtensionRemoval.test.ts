import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG } from '../../../config/outboundHeaders';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { ManagedDirectoryOperationCoordinator } from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import { OutboundHeaderPolicyService } from '../../core/network/outboundHeaderPolicyService';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { removeExtensionPackage } from './extensionMutation';
import { OpenClawExtensionImportService } from './openclawExtensionImportService';

vi.mock('../../core/filesystem/windowsFileLockDiagnostics', () => ({
  findWindowsLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
}));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../config/outboundHeaders', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../config/outboundHeaders')>()),
  PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG: {
    enabled: true,
    groups: [
      {
        baseUrlWhitelist: ['https://builtin-model.example.test/v1/'],
        headerNames: ['X-User-Account', 'X-Cookie'],
      },
    ],
  },
}));

describe('extension removal receipts and package lifecycle', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-removal-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function fixture(
    options: {
      realPolicy?: boolean;
      directoryOperations?: ManagedDirectoryOperationCoordinator;
    } = {},
  ) {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'network-plugin');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'openclaw.plugin.json'), '{"id":"network-plugin"}');
    fs.writeFileSync(
      path.join(installedDir, 'outbound-header-policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            baseUrlWhitelist: [
              'https://plugin.example.test/v1/',
              'https://plugin.example.test/v2/',
            ],
            headerNames: ['X-User-Account', 'X-Cookie'],
          },
        ],
      }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { allow: ['network-plugin', 'other'] } }),
    );
    const state = { leased: false };
    const manager = {
      getStatus: () => ({
        phase: state.leased ? 'ready' : 'running',
        message: state.leased ? 'OpenClaw runtime is ready. Gateway is stopped.' : undefined,
      }),
      isGatewayMutationInProgress: () => state.leased,
      getStateDir: () => stateDir,
      getBaseDir: () => fixtureRoot,
      getConfigPath: () => configPath,
      buildCliEnvironment: vi.fn(async () => ({
        env: { JUSTDO_ELECTRON_PATH: process.execPath, OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: fixtureRoot,
        openclawEntry: path.join(fixtureRoot, 'openclaw.mjs'),
      })),
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn(async () => {
      fs.rmSync(installedDir, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const requestGateway = vi.fn(async (method: string): Promise<unknown> => {
      if (state.leased) throw new Error('OpenClaw runtime is ready. Gateway is stopped.');
      if (method === 'plugins.uninstall') fs.rmSync(installedDir, { recursive: true });
      return { ok: true, restartRequired: false, warnings: ['Native removal warning'] };
    });
    const restartGatewayAfterMutation = vi.fn(async () => ({ phase: 'running' }));
    const reconcile = vi.fn(() => ({
      enabled: false,
      overwrite: false,
      groups: [],
      digest: 'stable',
    }));
    let service: OpenClawExtensionImportService;
    const policy = options.realPolicy
      ? new OutboundHeaderPolicyService({
          listInstalledExtensions: () => service.listInstalled(),
          configPath: path.join(fixtureRoot, 'outbound-policy.json'),
          userInfoPath: path.join(fixtureRoot, 'user-info.json'),
        })
      : undefined;
    service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
      requestGateway: requestGateway as <T>(method: string) => Promise<T>,
      restartGatewayAfterMutation,
      outboundHeaderPolicy: policy ?? { inspectExtension: vi.fn(), reconcile },
      directoryOperations: options.directoryOperations,
    });
    return {
      service,
      state,
      installedDir,
      configPath,
      runCommand,
      requestGateway,
      restartGatewayAfterMutation,
      reconcile,
      policy,
    };
  }

  it('uses one offline uninstall while the package owner deliberately holds the Gateway stopped', async () => {
    const f = fixture({ realPolicy: true });
    f.state.leased = true;
    const before = f.policy!.reconcile();
    expect(before.groups).toHaveLength(2);
    expect(before.groups[1].baseUrlWhitelist).toHaveLength(2);

    await expect(f.service.delete('network-plugin')).resolves.toEqual({ success: true });

    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.runCommand.mock.calls[0]).toEqual([
      process.execPath,
      [path.join(fixtureRoot, 'openclaw.mjs'), 'plugins', 'uninstall', 'network-plugin', '--force'],
      expect.any(Object),
    ]);
    expect(fs.existsSync(f.installedDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).plugins.allow).toEqual(['other']);
    const after = f.policy!.getSnapshot();
    expect(after.enabled).toBe(true);
    expect(after.groups).toEqual(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups);
    expect(after.groups[0].baseUrlWhitelist).toHaveLength(1);
    expect(after.digest).not.toBe(before.digest);
  });

  it('retains the offline removal receipt and actual recovery cause after the lease is released', async () => {
    const f = fixture();
    const result = await removeExtensionPackage(
      () => f.service.delete('network-plugin'),
      async operation => {
        f.state.leased = true;
        try {
          await operation();
        } finally {
          f.state.leased = false;
        }
        throw new Error('EADDRINUSE: engine port 18789 is already in use');
      },
    );

    expect(result).toMatchObject({
      success: true,
      refreshWarning: true,
      failedStage: PluginOperationStage.PREPARING_RUNTIME,
    });
    expect(result.error).toContain('EADDRINUSE');
    expect(result.error).toContain(t('extensionRemovalSavedRecoveryFailed'));
    expect(result.error).not.toContain('Gateway is stopped');
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.runCommand).toHaveBeenCalledOnce();
  });

  it('preserves an acknowledged native removal when policy synchronization then fails', async () => {
    const f = fixture();
    f.reconcile
      .mockImplementationOnce(() => ({
        enabled: true,
        overwrite: false,
        groups: [],
        digest: 'before',
      }))
      .mockImplementation(() => {
        throw new Error('Outbound policy config is not writable');
      });

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: true,
      refreshWarning: true,
      failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
      warnings: ['Native removal warning'],
    });
    expect(result.error).toContain('Outbound policy config is not writable');
    expect(result.error).toContain(t('extensionRemovalPolicyCleanupFailed'));
    expect(f.requestGateway).toHaveBeenCalledExactlyOnceWith('plugins.uninstall', {
      pluginId: 'network-plugin',
    });
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('keeps both the original uninstall failure and a subsequent policy recovery failure', async () => {
    const f = fixture();
    f.state.leased = true;
    f.runCommand.mockImplementation(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Plugin uninstall rejected: config access denied',
    }));
    f.reconcile
      .mockImplementationOnce(() => ({
        enabled: true,
        overwrite: false,
        groups: [],
        digest: 'before',
      }))
      .mockImplementation(() => {
        throw new Error('Outbound policy recovery denied');
      });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: false,
      failedStage: PluginOperationStage.UNINSTALLING,
    });
    expect(result.error).toContain('Plugin uninstall rejected: config access denied');
    expect(result.error).toContain('Outbound policy recovery denied');
    expect(result.error!.indexOf('Plugin uninstall rejected')).toBeLessThan(
      result.error!.indexOf('Outbound policy recovery denied'),
    );
    expect(fs.existsSync(f.installedDir)).toBe(true);
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.requestGateway).not.toHaveBeenCalled();
  });

  it('preserves a confirmed native removal when the required Gateway restart fails', async () => {
    const f = fixture();
    f.reconcile
      .mockReturnValueOnce({ enabled: true, overwrite: false, groups: [], digest: 'before' })
      .mockReturnValue({ enabled: false, overwrite: false, groups: [], digest: 'after' });
    f.restartGatewayAfterMutation.mockRejectedValue(
      new Error('Gateway process could not bind its port'),
    );

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: true,
      refreshWarning: true,
      failedStage: PluginOperationStage.RESTARTING_GATEWAY,
    });
    expect(result.error).toContain('Gateway process could not bind its port');
    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).toHaveBeenCalledOnce();
  });

  it('reports allowlist cleanup separately after a verified CLI removal', async () => {
    const f = fixture();
    f.state.leased = true;
    f.runCommand.mockImplementation(async () => {
      fs.rmSync(f.installedDir, { recursive: true });
      fs.writeFileSync(f.configPath, '{invalid config');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: true,
      refreshWarning: true,
      failedStage: PluginOperationStage.SAVING_CONFIGURATION,
    });
    expect(result.error).toContain(t('extensionRemovalAllowlistCleanupFailed'));
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.requestGateway).not.toHaveBeenCalled();
  });

  it('does not invent a removal receipt or replay the mutation after an invalid RPC response', async () => {
    const f = fixture();
    f.requestGateway.mockResolvedValueOnce(undefined);

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: false,
      operationUnconfirmed: true,
      failedStage: PluginOperationStage.CONFIRMING,
      error: t('extensionUninstallReceiptInvalid'),
    });
    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(fs.existsSync(f.installedDir)).toBe(true);
  });

  it('keeps a timed-out cold uninstall unconfirmed without recommending another mutation', async () => {
    const f = fixture();
    f.state.leased = true;
    f.runCommand.mockImplementation(async () => ({
      exitCode: 124, timedOut: true, stdout: '', stderr: '',
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: false, operationUnconfirmed: true, failedStage: PluginOperationStage.UNINSTALLING,
    });
    expect(result.error).toContain(t('extensionCommandTimedOutUnconfirmed'));
    expect(result.error).not.toContain('then try again');
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.requestGateway).not.toHaveBeenCalled();
  });

  it('preserves acknowledged removal after a later CLI cleanup error', async () => {
    const f = fixture();
    f.state.leased = true;
    f.runCommand.mockImplementation(async () => {
      fs.rmSync(f.installedDir, { recursive: true });
      return { exitCode: 1, nativeReceiptObserved: true as const,
        stdout: 'Uninstalled plugin "network-plugin"', stderr: 'Native cleanup failed' };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({ success: true, refreshWarning: true,
      failedStage: PluginOperationStage.CONFIRMING });
    expect(result.error).toContain('Native cleanup failed');
    expect(result.error).toContain(t('extensionRemovalCommandCleanupFailed'));
    expect(result.operationUnconfirmed).not.toBe(true);
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.requestGateway).not.toHaveBeenCalled();
  });

  it('does not report command execution when an external lock stops the preflight', async () => {
    const f = fixture({
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        findLockingProcesses: vi.fn(async () => ({
          available: true,
          processes: [{ name: 'Fixture Editor', pid: 4242 }],
        })),
      }),
    });
    f.state.leased = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({
      success: false,
      failedStage: PluginOperationStage.PREPARING_RUNTIME,
      error: expect.stringContaining('Fixture Editor'),
    });
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(fs.existsSync(f.installedDir)).toBe(true);
  });
});

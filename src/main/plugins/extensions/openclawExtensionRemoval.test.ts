import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG } from '../../../config/outboundHeaders';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { ManagedDirectoryOperationCoordinator } from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import { getOutboundHeaderPolicyConfig } from '../../core/network/outboundHeaderPolicyConfig';
import { OutboundHeaderPolicyService } from '../../core/network/outboundHeaderPolicyService';
import type { OpenClawConfigMutationContext } from '../../openclaw/config/openclawConfigSyncService';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { nativeMcpDataDirectory, prepareNativeMcpData } from '../data/nativeMcpData';
import { type PluginDataRemovalSnapshot,preparePluginDataDirectory } from '../data/pluginDataService';
import { removeExtensionPackage } from './extensionMutation';
import {
  type ApplyExtensionPackageMutation,
  ExtensionPackageLifecycleMode,
} from './extensionPackageLifecycle';
import { OpenClawExtensionImportService } from './openclawExtensionImportService';

type ManagedMcpPreparation = Pick<
  OpenClawConfigMutationContext, 'suspendNativeMcpData' | 'restoreNativeMcpData'
>;

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function fixture(
    options: {
      realPolicy?: boolean;
      directoryOperations?: ManagedDirectoryOperationCoordinator;
      connectedOnly?: boolean;
      nativePluginId?: string;
      packagePluginIds?: string[];
      pluginData?: ConstructorParameters<typeof OpenClawExtensionImportService>[0]['pluginData'];
      managedMcp?: ManagedMcpPreparation;
    } = {},
  ) {
    const stateDir = path.join(fixtureRoot, 'state');
    const nativePluginId = options.nativePluginId ?? 'network-plugin';
    const installedDir = path.join(stateDir, 'extensions', nativePluginId);
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'openclaw.plugin.json'), JSON.stringify({ id: nativePluginId }));
    if (options.packagePluginIds) fs.writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({
      openclaw: { extensions: options.packagePluginIds.map(id => `./${id}.js`) },
    }));
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
      JSON.stringify({ plugins: { allow: [nativePluginId, 'other'] } }),
    );
    const state = { leased: false, running: true, connected: true, configMutation: false, generation: 1 };
    const manager = {
      getStatus: () => ({
        phase: state.leased || !state.running ? 'ready' : 'running',
        message: state.leased ? 'OpenClaw runtime is ready. Gateway is stopped.' : undefined,
      }),
      isGatewayMutationInProgress: () => state.leased,
      getGatewayProcessId: () => state.leased || !state.running ? null : 100,
      getGatewayProcessGeneration: () => state.generation,
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
    const recoveringGateway = vi.fn(async (method: string) => requestGateway(method));
    const client = { request: requestGateway as <T>(method: string) => Promise<T> };
    const runConfigMutationExclusive = vi.fn(async <T>(operation: (config?: ManagedMcpPreparation) => Promise<T>): Promise<T> => {
      state.configMutation = true;
      try { return await operation(options.managedMcp); }
      finally { state.configMutation = false; }
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
      requestGateway: (options.connectedOnly ? recoveringGateway : requestGateway) as
        <T>(method: string) => Promise<T>,
      ...(options.connectedOnly ? { getConnectedGatewayClient: () => state.connected ? client : null } : {}),
      runConfigMutationExclusive,
      restartGatewayAfterMutation,
      outboundHeaderPolicy: policy ?? { inspectExtension: vi.fn(), reconcile },
      directoryOperations: options.directoryOperations,
      pluginData: options.pluginData,
      ...(options.packagePluginIds ? { readPackageOwnership: async () => [{
        ownerId: nativePluginId, pluginIds: options.packagePluginIds!, installPath: installedDir,
      }] } : {}),
    });
    return {
      service,
      state,
      installedDir,
      configPath,
      runCommand,
      requestGateway,
      recoveringGateway,
      runConfigMutationExclusive,
      restartGatewayAfterMutation,
      reconcile,
      policy,
    };
  }

  function dataFixture(options: {
    failCleanup?: boolean; nativePluginId?: string; packagePluginIds?: string[];
  } = {}) {
    const order: string[] = [];
    const snapshot = {} as PluginDataRemovalSnapshot;
    const pluginData = {
      inspect: vi.fn(async () => ({ exists: true, bytes: 123, canDelete: true })),
      prepareRemoval: vi.fn(async () => {
        expect(f.state.leased).toBe(true);
        expect(f.state.configMutation).toBe(true);
        order.push('snapshot');
        return snapshot;
      }),
      remove: vi.fn(async (selected: PluginDataRemovalSnapshot) => {
        expect(selected).toBe(snapshot);
        expect(f.state.leased).toBe(true);
        expect(fs.existsSync(f.installedDir)).toBe(false);
        order.push('cleanup');
        if (options.failCleanup) throw new Error('Model file is locked');
      }),
    };
    const f = fixture({ pluginData, nativePluginId: options.nativePluginId, packagePluginIds: options.packagePluginIds });
    const native = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (...args) => {
      order.push('uninstall');
      return native(...args);
    });
    const apply: ApplyExtensionPackageMutation = async (target, operation) => {
      expect(target.requireStopped).toBe(true);
      f.state.leased = true;
      try { return await operation(ExtensionPackageLifecycleMode.STOPPED); }
      finally { order.push('restore'); f.state.leased = false; }
    };
    return { ...f, pluginData, order, apply };
  }

  it('freezes the complete package data before uninstall and deletes only before runtime restoration', async () => {
    const f = dataFixture({ packagePluginIds: ['network-child', 'second-child'] });
    const info = await f.service.getDataInfo('network-child');
    expect(info).toEqual({ success: true, exists: true, bytes: 123, canDelete: true });
    expect(f.pluginData.inspect).toHaveBeenCalledWith(
      path.join(fixtureRoot, 'state'), ['network-child', 'network-plugin', 'second-child'], undefined,
    );

    const result = await f.service.delete('network-child', undefined, f.apply, { deleteData: true });

    expect(result).toEqual({ success: true });
    expect(f.order).toEqual(['snapshot', 'uninstall', 'cleanup', 'restore']);
    expect(f.pluginData.prepareRemoval).toHaveBeenCalledWith(
      path.join(fixtureRoot, 'state'), ['network-child', 'network-plugin', 'second-child'], undefined,
    );
    expect(f.runCommand).toHaveBeenCalledOnce();
  });

  it('preserves plugin data by default without inspecting or deleting it', async () => {
    const f = dataFixture();
    await expect(f.service.delete('network-plugin')).resolves.toMatchObject({ success: true });
    expect(f.pluginData.prepareRemoval).not.toHaveBeenCalled();
    expect(f.pluginData.remove).not.toHaveBeenCalled();
  });

  it('reports an absent data directory without starting Gateway or creating it', async () => {
    const f = fixture();

    await expect(f.service.getDataInfo('network-plugin')).resolves.toEqual({
      success: true, exists: false, bytes: 0, canDelete: true,
    });
    expect(fs.existsSync(path.join(fixtureRoot, 'state', 'plugin-data'))).toBe(false);
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it('does not treat a native-only ID as a managed data owner or authorize data removal', async () => {
    const f = dataFixture({ nativePluginId: 'ExampleGenerator' });

    await expect(f.service.getDataInfo('ExampleGenerator')).resolves.toEqual({
      success: true, exists: false, bytes: 0, canDelete: true,
    });
    expect(f.pluginData.inspect).not.toHaveBeenCalled();
    await expect(f.service.delete('ExampleGenerator', undefined, f.apply, { deleteData: true }))
      .resolves.toMatchObject({ success: false });
    expect(f.pluginData.prepareRemoval).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.requestGateway).not.toHaveBeenCalled();
  });

  it('uses the same exact managed child owners for inspection and removal in a mixed package', async () => {
    const f = dataFixture({
      nativePluginId: 'ExampleGenerator', packagePluginIds: ['managed-child', 'second-child'],
    });

    await expect(f.service.getDataInfo('managed-child')).resolves.toMatchObject({
      success: true, exists: true, canDelete: true,
    });
    expect(f.pluginData.inspect).toHaveBeenCalledExactlyOnceWith(
      path.join(fixtureRoot, 'state'), ['managed-child', 'second-child'], undefined,
    );
    await expect(f.service.delete('managed-child', undefined, f.apply, { deleteData: true }))
      .resolves.toEqual({ success: true });
    expect(f.pluginData.prepareRemoval).toHaveBeenCalledExactlyOnceWith(
      path.join(fixtureRoot, 'state'), ['managed-child', 'second-child'], undefined,
    );
    expect(f.order).toEqual(['snapshot', 'uninstall', 'cleanup', 'restore']);
  });

  it('reports retained execution records without presenting them as a read failure', async () => {
    const f = dataFixture();
    f.pluginData.inspect.mockResolvedValue(Object.assign(
      { exists: true, bytes: 123, canDelete: false }, { retained: true as const },
    ));

    await expect(f.service.getDataInfo('network-plugin')).resolves.toEqual({
      success: true, exists: true, bytes: 123, canDelete: false, retained: true,
    });
  });

  async function legacyMcpFixture() {
    const id = 'knowledge-wiki-app';
    const f = fixture({ nativePluginId: id });
    const stateDir = path.dirname(f.configPath);
    fs.writeFileSync(f.configPath, JSON.stringify({ plugins: { entries: { [id]: { enabled: false } } } }));
    fs.writeFileSync(path.join(f.installedDir, 'package.json'), JSON.stringify({
      name: '@local-mcp/knowledge-wiki-app', openclaw: { extensions: ['./dist/extension.cjs'] },
    }));
    fs.writeFileSync(path.join(f.installedDir, 'openclaw.plugin.json'), JSON.stringify({
      id, mcpServers: { 'knowledge-wiki': { command: 'node', args: ['./dist/server.cjs'],
        env: { PLUGIN_DATA: '${PLUGIN_DATA}' } } },
    }));
    const data = await preparePluginDataDirectory(stateDir, id, { directory: 'managed-v1', retention: 'retain' });
    fs.writeFileSync(path.join(data, 'knowledge.sqlite'), 'wiki records');
    const apply: ApplyExtensionPackageMutation = async (target, operation) => {
      expect(target.requireStopped).toBe(true);
      f.state.leased = true;
      try { return await operation(ExtensionPackageLifecycleMode.STOPPED); }
      finally { f.state.leased = false; }
    };
    return { ...f, id, stateDir, data, apply };
  }

  it.each([false, true])('offers cleanup for a disabled legacy MCP library and honors the selection (%s)', async deleteData => {
    const f = await legacyMcpFixture();
    const marker = path.join(f.data, '.owner.json');
    const owner = fs.readFileSync(marker, 'utf8');
    await prepareNativeMcpData(f.stateDir, [f.id]);
    expect(nativeMcpDataDirectory(f.stateDir, f.id)).toBe(f.data);
    await expect(f.service.getDataInfo(f.id)).resolves.toMatchObject({ success: true, exists: true, canDelete: true });
    expect(fs.readFileSync(marker, 'utf8')).toBe(owner);

    const result = deleteData
      ? await f.service.delete(f.id, undefined, f.apply, { deleteData: true })
      : await f.service.delete(f.id);

    expect(result.success).toBe(true);
    expect(fs.existsSync(f.data)).toBe(!deleteData);
  });

  it('rechecks legacy cleanup eligibility if the exact package acquires an App companion', async () => {
    const f = await legacyMcpFixture();
    await expect(f.service.getDataInfo(f.id)).resolves.toMatchObject({ success: true, canDelete: true });
    fs.writeFileSync(path.join(f.installedDir, 'app.plugin.json'), '{}');

    await expect(f.service.getDataInfo(f.id)).resolves.toMatchObject({ success: true, canDelete: false });
    await expect(f.service.delete(f.id, undefined, f.apply, { deleteData: true })).rejects.toThrow('must be retained');
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.data, 'knowledge.sqlite'), 'utf8')).toBe('wiki records');
  });

  it('rejects unsafe data before sending uninstall', async () => {
    const f = dataFixture();
    f.pluginData.prepareRemoval.mockRejectedValue(new Error('Data ownership changed'));

    await expect(f.service.delete('network-plugin', undefined, f.apply, { deleteData: true }))
      .rejects.toThrow('Data ownership changed');

    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.pluginData.remove).not.toHaveBeenCalled();
    expect(fs.existsSync(f.installedDir)).toBe(true);
  });

  it('does not delete data after an unconfirmed native uninstall', async () => {
    const f = dataFixture();
    f.runCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Command timed out' });

    const result = await f.service.delete('network-plugin', undefined, f.apply, { deleteData: true });

    expect(result.success).toBe(false);
    expect(f.pluginData.prepareRemoval).toHaveBeenCalledOnce();
    expect(f.pluginData.remove).not.toHaveBeenCalled();
    expect(f.runCommand).toHaveBeenCalledOnce();
  });

  it('keeps the confirmed uninstall receipt when data cleanup fails', async () => {
    const f = dataFixture({ failCleanup: true });

    const result = await f.service.delete('network-plugin', undefined, f.apply, { deleteData: true });

    expect(result).toMatchObject({
      success: true, refreshWarning: true, failedStage: PluginOperationStage.CLEANING_PLUGIN_DATA,
      error: expect.stringContaining(t('extensionDataRemovalFailed')),
    });
    expect(result.error).toContain('Model file is locked');
    expect(f.order).toEqual(['snapshot', 'uninstall', 'cleanup', 'restore']);
    expect(f.runCommand).toHaveBeenCalledOnce();
  });

  it('requires the stopped package owner when data deletion is requested', async () => {
    const f = dataFixture();

    const result = await f.service.delete('network-plugin', undefined, undefined, { deleteData: true });

    expect(result).toEqual({ success: false, error: t('extensionDataRemovalUnavailable') });
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.pluginData.prepareRemoval).not.toHaveBeenCalled();
  });

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
    const after = getOutboundHeaderPolicyConfig();
    expect(after.enabled).toBe(true);
    expect(after.groups).toEqual(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups);
    expect(after.groups[0].baseUrlWhitelist).toHaveLength(1);
  });

  it('selects native removal from its exact queued package and keeps the existing Gateway connection', async () => {
    const f = fixture({ connectedOnly: true });
    const apply = vi.fn<ApplyExtensionPackageMutation>(async (target, operation) => {
      expect(target).toEqual({
        nativePluginIds: ['network-plugin'],
        installPath: f.installedDir,
      });
      expect(f.state.configMutation).toBe(false);
      return operation(ExtensionPackageLifecycleMode.HOT);
    });

    await expect(f.service.delete('network-plugin', undefined, apply)).resolves.toEqual({
      success: true, warnings: ['Native removal warning'],
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(f.requestGateway).toHaveBeenCalledExactlyOnceWith('plugins.uninstall', {
      pluginId: 'network-plugin',
    }, { timeoutMs: 600_000 });
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('classifies removal of a child entry with its entire native package owner and path', async () => {
    const f = fixture({ connectedOnly: true, packagePluginIds: ['first-entry', 'second-entry'] });
    const apply = vi.fn<ApplyExtensionPackageMutation>(async (target, operation) => {
      expect(target).toEqual({
        nativePluginIds: ['first-entry', 'network-plugin', 'second-entry'],
        installPath: f.installedDir,
      });
      return operation(ExtensionPackageLifecycleMode.HOT);
    });

    await expect(f.service.delete('first-entry', undefined, apply)).resolves.toMatchObject({ success: true });

    expect(apply).toHaveBeenCalledOnce();
    expect(f.requestGateway).toHaveBeenCalledExactlyOnceWith('plugins.uninstall', {
      pluginId: 'first-entry',
    }, { timeoutMs: 600_000 });
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it('retains the selective cold removal receipt after config access ends and recovery fails', async () => {
    const f = fixture({ connectedOnly: true });
    const apply: ApplyExtensionPackageMutation = async (_target, operation) => {
      f.state.leased = true;
      try {
        await operation(ExtensionPackageLifecycleMode.STOPPED);
        expect(f.state.configMutation).toBe(false);
      } finally {
        f.state.leased = false;
      }
      throw new Error('Gateway recovery could not bind the selected port');
    };

    const result = await f.service.delete('network-plugin', undefined, apply);

    expect(result).toMatchObject({
      success: true, refreshWarning: true, mutationCompleted: true,
      failedStage: PluginOperationStage.PREPARING_RUNTIME,
      error: 'Gateway recovery could not bind the selected port',
    });
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('requires an actual stopped Gateway lease before executing the selected offline removal', async () => {
    const f = fixture({ connectedOnly: true });
    const apply: ApplyExtensionPackageMutation = (_target, operation) =>
      operation(ExtensionPackageLifecycleMode.STOPPED);

    await expect(f.service.delete('network-plugin', undefined, apply)).resolves.toMatchObject({ success: false });

    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('does not start a disconnected Gateway to dispatch an offline removal', async () => {
    const f = fixture({ connectedOnly: true });
    f.state.connected = false;
    f.state.running = false;

    await expect(f.service.delete('network-plugin')).resolves.toEqual({ success: true });

    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('rejects an alive disconnected hot removal before any native or policy mutation', async () => {
    const f = fixture({ connectedOnly: true });
    f.state.connected = false;
    const apply: ApplyExtensionPackageMutation = (_target, operation) =>
      operation(ExtensionPackageLifecycleMode.HOT);

    await expect(f.service.delete('network-plugin', undefined, apply)).resolves.toEqual({
      success: false, error: t('extensionHotToggleUnavailable'),
    });

    expect(f.requestGateway).not.toHaveBeenCalled();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('does not replace a captured hot removal with offline CLI when dispatch was fenced', async () => {
    const f = fixture({ connectedOnly: true });
    f.requestGateway.mockRejectedValueOnce(Object.assign(new Error('Gateway connection changed'), {
      code: 'CLIENT_CLOSED', requestSent: false,
    }));
    const apply: ApplyExtensionPackageMutation = (_target, operation) =>
      operation(ExtensionPackageLifecycleMode.HOT);

    await expect(f.service.delete('network-plugin', undefined, apply)).resolves.toMatchObject({
      success: false, error: t('extensionHotToggleUnavailable'),
    });

    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('does not recover or replay an unknown removal through a replacement connection', async () => {
    const managedMcp = {
      suspendNativeMcpData: vi.fn(async () => true),
      restoreNativeMcpData: vi.fn(async () => true),
    };
    const f = fixture({ connectedOnly: true, managedMcp });
    f.requestGateway.mockImplementationOnce(async () => {
      f.state.connected = false;
      throw Object.assign(new Error('Gateway reply was lost'), { code: 'CLIENT_TIMEOUT', requestSent: true });
    });
    const apply: ApplyExtensionPackageMutation = (_target, operation) =>
      operation(ExtensionPackageLifecycleMode.HOT);

    await expect(f.service.delete('network-plugin', undefined, apply)).resolves.toMatchObject({
      success: false, operationUnconfirmed: true,
    });

    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(managedMcp.restoreNativeMcpData).not.toHaveBeenCalled();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(fs.existsSync(f.installedDir)).toBe(true);
  });

  it('waits for the target package background services before dispatch and reconciles a native refusal', async () => {
    const suspended = Promise.withResolvers<boolean>();
    const started = Promise.withResolvers<void>();
    const managedMcp = {
      suspendNativeMcpData: vi.fn((owners: readonly string[]) => {
        expect(owners).toEqual(['network-child', 'network-plugin', 'other-child']);
        started.resolve();
        return suspended.promise;
      }),
      restoreNativeMcpData: vi.fn(async () => true),
    };
    const f = fixture({ connectedOnly: true, managedMcp, packagePluginIds: ['network-child', 'other-child'] });
    const failure = new Error('The native owner refused uninstall');
    f.requestGateway.mockRejectedValueOnce(failure);
    const apply: ApplyExtensionPackageMutation = (_target, operation) =>
      operation(ExtensionPackageLifecycleMode.HOT);

    const result = f.service.delete('network-child', undefined, apply);
    await started.promise;
    expect(f.state.configMutation).toBe(true);
    expect(f.requestGateway).not.toHaveBeenCalled();
    suspended.resolve(true);

    await expect(result).resolves.toMatchObject({ success: false, error: failure.message });
    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(managedMcp.restoreNativeMcpData).toHaveBeenCalledOnce();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('waits for a slow native uninstall receipt without restarting the running Gateway', async () => {
    vi.useFakeTimers();
    const f = fixture({ connectedOnly: true });
    f.requestGateway.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 31_000));
      fs.rmSync(f.installedDir, { recursive: true });
      return { ok: true, restartRequired: false };
    });

    const pending = f.service.delete('network-plugin');
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(pending).resolves.toEqual({ success: true });
    expect(f.requestGateway).toHaveBeenCalledExactlyOnceWith('plugins.uninstall', {
      pluginId: 'network-plugin',
    }, { timeoutMs: 600_000 });
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it.each(['stale inventory', 'temporary read failure'])(
    'confirms an uncertain removal after %s while the same Gateway keeps running',
    async initialRead => {
      vi.useFakeTimers();
      const f = fixture({ connectedOnly: true });
      f.requestGateway
        .mockRejectedValueOnce(Object.assign(new Error('Gateway reply was lost'), {
          code: 'CLIENT_TIMEOUT', requestSent: true,
        }))
        .mockImplementationOnce(async () => {
          if (initialRead === 'temporary read failure')
            throw Object.assign(new Error('Gateway read timed out'), { code: 'CLIENT_TIMEOUT' });
          return { plugins: [{ id: 'network-plugin', installed: true }] };
        })
        .mockImplementationOnce(async () => {
          fs.rmSync(f.installedDir, { recursive: true });
          return { plugins: [] };
        });

      const pending = f.service.delete('network-plugin');
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toEqual({ success: true });
      expect(f.requestGateway.mock.calls.map(([method]) => method)).toEqual([
        'plugins.uninstall', 'plugins.list', 'plugins.list', 'plugins.refresh',
      ]);
      expect(f.requestGateway).toHaveBeenNthCalledWith(2, 'plugins.list', {}, { timeoutMs: 5000 });
      expect(f.runCommand).not.toHaveBeenCalled();
      expect(f.recoveringGateway).not.toHaveBeenCalled();
      expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    },
  );

  it('bounds confirmation and keeps removal unconfirmed when its original directory remains', async () => {
    vi.useFakeTimers();
    const f = fixture({ connectedOnly: true });
    f.requestGateway
      .mockRejectedValueOnce(Object.assign(new Error('Gateway reply was lost'), { code: 'CLIENT_TIMEOUT' }))
      .mockResolvedValue({ plugins: [] });
    let settled = false;

    const pending = f.service.delete('network-plugin').finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ success: false, operationUnconfirmed: true });
    expect(f.requestGateway.mock.calls.filter(([method]) => method === 'plugins.uninstall')).toHaveLength(1);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('continues a timed-out removal observation after the original result without replaying any mutation', async () => {
    vi.useFakeTimers();
    const f = fixture({ connectedOnly: true });
    f.requestGateway
      .mockRejectedValueOnce(Object.assign(new Error('Gateway reply was lost'), { code: 'CLIENT_TIMEOUT' }))
      .mockImplementation(async () => ({
        plugins: fs.existsSync(f.installedDir) ? [{ id: 'network-plugin', installed: true }] : [],
      }));
    const onRemovalUnconfirmed = vi.fn();
    const pending = f.service.delete('network-plugin', undefined, undefined, { onRemovalUnconfirmed });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({ success: false, operationUnconfirmed: true });
    const [confirm, isCurrent] = onRemovalUnconfirmed.mock.calls[0] as [() => Promise<boolean>, () => boolean];
    const confirmation = confirm();
    expect(confirm()).toBe(confirmation);
    await vi.advanceTimersByTimeAsync(1000);
    fs.rmSync(f.installedDir, { recursive: true });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(confirmation).resolves.toBe(true);
    expect(isCurrent()).toBe(true);
    expect(onRemovalUnconfirmed).toHaveBeenCalledOnce();
    expect(f.requestGateway.mock.calls.filter(([method]) => method !== 'plugins.list')).toEqual([
      ['plugins.uninstall', { pluginId: 'network-plugin' }, { timeoutMs: 600_000 }],
    ]);
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('stops the retained observation after 60 seconds without claiming completion', async () => {
    vi.useFakeTimers();
    const f = fixture({ connectedOnly: true });
    f.requestGateway
      .mockRejectedValueOnce(Object.assign(new Error('Gateway reply was lost'), { code: 'CLIENT_TIMEOUT' }))
      .mockResolvedValue({ plugins: [] });
    const onRemovalUnconfirmed = vi.fn();
    const pending = f.service.delete('network-plugin', undefined, undefined, { onRemovalUnconfirmed });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    const confirm = onRemovalUnconfirmed.mock.calls[0][0] as () => Promise<boolean>;
    let settled = false;
    const confirmation = confirm().finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(confirmation).resolves.toBe(false);
    const reads = f.requestGateway.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.requestGateway).toHaveBeenCalledTimes(reads);
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('cancels the retained observation when a newer extension mutation reuses its target', async () => {
    vi.useFakeTimers();
    const f = fixture({ connectedOnly: true });
    f.requestGateway
      .mockRejectedValueOnce(Object.assign(new Error('Gateway reply was lost'), { code: 'CLIENT_TIMEOUT' }))
      .mockResolvedValue({ plugins: [] });
    const onRemovalUnconfirmed = vi.fn();
    const pending = f.service.delete('network-plugin', undefined, undefined, { onRemovalUnconfirmed });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    const [confirm, isCurrent] = onRemovalUnconfirmed.mock.calls[0] as [() => Promise<boolean>, () => boolean];
    const confirmation = confirm();
    await vi.advanceTimersByTimeAsync(100);
    await expect(f.service.delete('network-plugin', undefined, async () => {
      throw new Error('New package mutation admitted');
    })).rejects.toThrow('New package mutation admitted');
    fs.rmSync(f.installedDir, { recursive: true });
    await vi.advanceTimersByTimeAsync(200);

    await expect(confirmation).resolves.toBe(false);
    expect(isCurrent()).toBe(false);
    expect(f.requestGateway.mock.calls.filter(([method]) => method === 'plugins.uninstall')).toHaveLength(1);
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('rejects a late absence response after the Gateway generation changes', async () => {
    const f = fixture({ connectedOnly: true });
    f.requestGateway
      .mockRejectedValueOnce(Object.assign(new Error('Gateway reply was lost'), { code: 'CLIENT_TIMEOUT' }))
      .mockImplementationOnce(async () => {
        fs.rmSync(f.installedDir, { recursive: true });
        f.state.generation += 1;
        return { plugins: [] };
      });

    await expect(f.service.delete('network-plugin')).resolves.toMatchObject({
      success: false, operationUnconfirmed: true,
    });
    expect(f.requestGateway.mock.calls.map(([method]) => method)).toEqual(['plugins.uninstall', 'plugins.list']);
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('preserves a confirmed removal without restarting a newer Gateway generation', async () => {
    const f = fixture({ connectedOnly: true });
    f.requestGateway.mockImplementationOnce(async () => {
      f.state.generation++;
      return { ok: true, restartRequired: true };
    });

    const result = await f.service.delete('network-plugin');

    expect(result).toMatchObject({ success: true, refreshWarning: true });
    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(f.recoveringGateway).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('resolves package identity after an earlier queued mutation has changed its root', async () => {
    const f = fixture({ connectedOnly: true });
    let release!: () => void;
    const entered = new Promise<void>(resolve => { release = resolve; });
    const first = f.service.delete('network-plugin', undefined, async () => {
      await entered;
      fs.renameSync(f.installedDir, `${f.installedDir}-moved`);
      throw new Error('Preparation ended before the native write');
    }).catch((error: Error) => error);
    f.requestGateway.mockImplementation(async () => {
      fs.rmSync(`${f.installedDir}-moved`, { recursive: true });
      return { ok: true, restartRequired: false };
    });
    const apply = vi.fn<ApplyExtensionPackageMutation>(async (target, operation) => {
      expect(target.installPath).toBe(`${f.installedDir}-moved`);
      return operation(ExtensionPackageLifecycleMode.HOT);
    });
    const second = f.service.delete('network-plugin', undefined, apply);
    release();

    await first;
    await second;

    expect(apply).toHaveBeenCalledOnce();
    expect(f.requestGateway).toHaveBeenCalledOnce();
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
      mutationCompleted: true,
      failedStage: PluginOperationStage.PREPARING_RUNTIME,
    });
    expect(result.error).toBe('EADDRINUSE: engine port 18789 is already in use');
    expect(result).not.toHaveProperty('runtimeRecoveryPending');
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
    }, { timeoutMs: 600_000 });
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

  it.each([undefined, { ok: true }])('does not invent a removal receipt after an invalid RPC response: %j', async response => {
    const f = fixture();
    f.requestGateway.mockResolvedValueOnce(response);

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

  it.each([true, false])(
    'keeps native restart requirements independent from a changed policy (refresh still requires restart: %s)',
    async refreshRequiresRestart => {
      const f = fixture({ connectedOnly: true });
      f.requestGateway
        .mockResolvedValueOnce({ ok: true, restartRequired: true })
        .mockResolvedValueOnce({ ok: true, restartRequired: refreshRequiresRestart });
      f.reconcile
        .mockReturnValueOnce({ enabled: true, overwrite: false, groups: [], digest: 'before' })
        .mockReturnValue({ enabled: true, overwrite: false, groups: [], digest: 'after' });

      await expect(f.service.delete('network-plugin')).resolves.toEqual({ success: true });

      expect(f.requestGateway).toHaveBeenNthCalledWith(2, 'plugins.refresh', {});
      expect(f.restartGatewayAfterMutation.mock.calls).toEqual([
        refreshRequiresRestart
          ? ['extension-delete', { networkPolicyChanged: true }]
          : ['extension-network-policy-change'],
      ]);
      expect(f.runCommand).not.toHaveBeenCalled();
      expect(f.recoveringGateway).not.toHaveBeenCalled();
    },
  );

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

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AppConfigIpc } from '../../../shared/app/appConfig';
import { ExtensionIpc } from '../../../shared/plugins/extensions';
import { PluginKind } from '../../../shared/plugins/marketplace';
import {
  PluginOperationAction,
  PluginOperationIpc,
  PluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import { t } from '../../core/i18n';
import { enqueueAppConfigUpdate } from '../../data/appConfigUpdateQueue';
import { EnginePreparationPendingCode, EnginePreparationPendingError } from '../../engine/enginePreparationError';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { OpenClawExtensionImportService } from '../../plugins/extensions';
import {
  type ApplyExtensionPackageMutation,
  ExtensionPackageLifecycleMode,
  type WithExtensionPackageMutation,
} from '../../plugins/extensions/extensionPackageLifecycle';
import type { PluginInstallationService } from '../../plugins/installation';
import { registerStoreHandlers } from '../app/store';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const windows = vi.hoisted(() => ({ getAllWindows: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    ),
  },
  BrowserWindow: windows,
}));

import { registerExtensionHandlers } from './extensions';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

function fixture(
  beforeAgentTeamDisable?: () => Promise<() => void>,
  mutateAppPackage?: <T>(operation: () => Promise<T>) => Promise<T>,
  mutateAppPlugin?: <T>(id: string, enabled: boolean, operation: () => Promise<T>) => Promise<T>,
  approveInstalledAppPackage?: (input: { nativePluginId: string; installPath: string }) => Promise<void>,
  withExtensionPackageMutation?: WithExtensionPackageMutation,
) {
  const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const peer = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  windows.getAllWindows.mockReturnValue([
    { isDestroyed: () => false, webContents: sender },
    { isDestroyed: () => false, webContents: peer },
    { isDestroyed: () => true, webContents: { send: vi.fn() } },
  ]);
  const service = {
    listInstalled: vi.fn(() => [
      { id: 'feature-plugin', installPath: 'C:/installed/feature-plugin' },
    ]),
    listCatalog: vi.fn().mockResolvedValue([{ id: 'feature-plugin', enabled: false }]),
    prepareCatalog: vi.fn(async () => () => [
      { id: 'feature-plugin', enabled: false, configurationFields: [] },
    ]),
    setEnabled: vi.fn(),
    updateConfiguration: vi.fn(),
    delete: vi.fn(),
    getDataInfo: vi.fn(),
    importPath: vi.fn(),
  };
  const forgetMarketplace = vi.fn();
  const installation = { registerInstaller: vi.fn(), install: vi.fn() };
  registerExtensionHandlers({
    extensionImportService: service as unknown as OpenClawExtensionImportService,
    installationService: installation as unknown as PluginInstallationService,
    mutateAppPackage,
    withExtensionPackageMutation,
    approveInstalledAppPackage,
    mutateAppPlugin: mutateAppPlugin ?? (() => {
      let lane: Promise<unknown> = Promise.resolve();
      return <T>(_id: string, enabled: boolean, operation: () => Promise<T>) => {
        const next = lane
          .catch(() => undefined)
          .then(async () => {
            const release =
              !enabled && _id === 'agent-team' ? await beforeAgentTeamDisable?.() : undefined;
            try {
              return await operation();
            } finally {
              release?.();
            }
          });
        lane = next;
        return next;
      };
    })(),
    onMarketplacePluginDeleted: forgetMarketplace,
  });
  return { service, installation, sender, peer, forgetMarketplace, event: { sender } };
}

test('reads plugin data size without entering a package mutation', async () => {
  const mutate = vi.fn();
  const f = fixture(undefined, mutate);
  f.service.getDataInfo.mockResolvedValue({ success: true, exists: true, bytes: 123, canDelete: true });

  await expect(handlers.get(ExtensionIpc.DataInfo)!(f.event, { extensionId: 'feature-plugin' }))
    .resolves.toEqual({ success: true, exists: true, bytes: 123, canDelete: true });

  expect(f.service.getDataInfo).toHaveBeenCalledExactlyOnceWith('feature-plugin');
  expect(f.service.delete).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});

test('rejects an invalid cleanup option before starting uninstall', async () => {
  const f = fixture();

  await expect(handlers.get(ExtensionIpc.Delete)!(f.event, {
    extensionId: 'feature-plugin', deleteData: 'true',
  })).resolves.toMatchObject({ success: false });

  expect(f.service.delete).not.toHaveBeenCalled();
});

test('passes explicit data deletion through the existing package owner', async () => {
  const apply = vi.fn();
  const withMutation: WithExtensionPackageMutation = async operation => operation(apply);
  const f = fixture(undefined, undefined, undefined, undefined, withMutation);
  f.service.delete.mockResolvedValue({ success: true });

  await expect(handlers.get(ExtensionIpc.Delete)!(f.event, {
    extensionId: 'feature-plugin', deleteData: true,
  })).resolves.toMatchObject({ success: true });

  expect(f.service.delete).toHaveBeenCalledExactlyOnceWith(
    'feature-plugin', expect.any(Function), apply, { deleteData: true },
  );
});

function hotToggleIpcFixture(connectionLoss: 'before-toggle' | 'after-plugin-write') {
  const sender = { isDestroyed: () => false, send: vi.fn() };
  windows.getAllWindows.mockReturnValue([
    { isDestroyed: () => false, webContents: sender },
  ]);
  const manager = {
    getStatus: () => ({ phase: 'running' }),
    getGatewayProcessId: () => 123,
    getGatewayProcessGeneration: () => 1,
    startGateway: vi.fn(),
    restartGateway: vi.fn(),
    withStoppedGatewayForMutation: vi.fn(),
  };
  const connectedRequest = vi.fn(async <T>(method: string): Promise<T> => {
    if (method !== 'plugins.setEnabled') throw new Error(`Unexpected Native request: ${method}`);
    client = null;
    return { ok: true, restartRequired: false } as T;
  });
  let client: { request: typeof connectedRequest } | null =
    connectionLoss === 'before-toggle' ? null : { request: connectedRequest };
  // Model the ordinary request's lifecycle side effect so a notification or list
  // accidentally entering that path fails this boundary test.
  const ordinaryRequest = vi.fn(async <T>(): Promise<T> => {
    manager.startGateway();
    return { plugins: [], diagnostics: [], mutationAllowed: true } as T;
  });
  const runCommand = vi.fn();
  const restartGatewayAfterMutation = vi.fn();
  const service = new OpenClawExtensionImportService({
    getOpenClawEngineManager: () => manager as unknown as OpenClawEngineManager,
    requiresHotToggle: () => true,
    getNativeSkillIds: () => ['agent-team'],
    getConnectedGatewayClient: () => client,
    requestGateway: ordinaryRequest,
    restartGatewayAfterMutation,
    runCommand,
  });
  vi.spyOn(service, 'listInstalled').mockReturnValue([]);
  registerExtensionHandlers({
    extensionImportService: service,
    installationService: {
      registerInstaller: vi.fn(),
    } as unknown as PluginInstallationService,
  });
  return {
    sender,
    manager,
    connectedRequest,
    ordinaryRequest,
    restartGatewayAfterMutation,
    runCommand,
    event: { sender },
  };
}

test.each(['before-toggle', 'after-plugin-write'] as const)(
  'does not recover Gateway through hot-toggle notification or list after connection loss: %s',
  async connectionLoss => {
    const f = hotToggleIpcFixture(connectionLoss);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'agent-team',
      enabled: true,
    });
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    // Loss after a committed write remains unconfirmed; neither notification
    // nor a subsequent renderer reload may fabricate a disabled/empty catalog.
    expect(f.sender.send).not.toHaveBeenCalled();
    expect(await handlers.get(ExtensionIpc.List)!(f.event)).toMatchObject({
      success: false,
      error: expect.any(String),
    });
    expect(f.connectedRequest.mock.calls).toEqual(
      connectionLoss === 'before-toggle'
        ? []
        : [['plugins.setEnabled', { pluginId: 'agent-team', enabled: true }]],
    );
    expect(f.ordinaryRequest).not.toHaveBeenCalled();
    expect(f.manager.startGateway).not.toHaveBeenCalled();
    expect(f.manager.restartGateway).not.toHaveBeenCalled();
    expect(f.manager.withStoppedGatewayForMutation).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.sender.send).not.toHaveBeenCalled();
  },
);

test('publishes the actual disabled setting even if a saved toggle reports a restart failure', async () => {
  const f = fixture();
  const failure = { success: false, error: 'Saved, but restart failed' };
  f.service.setEnabled.mockResolvedValue(failure);
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'feature-plugin',
      enabled: false,
    }),
  ).toEqual({ ...failure, failedStage: 'queued' });
  const expected = [ExtensionIpc.Changed, { extensionId: 'feature-plugin', enabled: false }];
  expect(f.sender.send).toHaveBeenCalledWith(...expected);
  expect(f.peer.send).toHaveBeenCalledWith(...expected);
});

test('reports native stages to the requester while publishing observed state to all windows', async () => {
  const f = fixture();
  f.service.setEnabled.mockImplementation(async (_id, _enabled, _reviewToken, report) => {
    report('enabling');
    report('restarting_gateway');
    return { success: true };
  });

  await handlers.get(ExtensionIpc.SetEnabled)!(
    f.event,
    { extensionId: 'feature-plugin', enabled: true },
    { requestId: 'extension-operation' },
  );

  const events = f.sender.send.mock.calls.filter(call => call[0] === PluginOperationIpc.Progress);
  expect(events.map(call => call[1].stage)).toEqual([
    'queued',
    'enabling',
    'restarting_gateway',
    'refreshing_inventory',
  ]);
  expect(events.every(call => call[1].requestId === 'extension-operation')).toBe(true);
  expect(f.peer.send.mock.calls.every(call => call[0] === ExtensionIpc.Changed)).toBe(true);
});

test('rejects invalid progress context before starting an extension mutation', async () => {
  const f = fixture();

  await expect(
    handlers.get(ExtensionIpc.Delete)!(
      f.event,
      { extensionId: 'feature-plugin' },
      { requestId: 'unsafe/private-path' },
    ),
  ).resolves.toMatchObject({ success: false });

  expect(f.service.delete).not.toHaveBeenCalled();
  expect(f.service.listCatalog).not.toHaveBeenCalled();
});

test('a rejected enable request publishes the observed setting instead of the requested value', async () => {
  const f = fixture();
  f.service.setEnabled.mockResolvedValue({ success: false, error: 'Consent required' });
  await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
  expect(f.sender.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: false,
  });
});

test('uninstalling a plugin clears its menu entries in every open window', async () => {
  const f = fixture();
  f.service.delete.mockResolvedValue({ success: true });
  f.service.listCatalog.mockResolvedValue([]);
  await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' });
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: false,
  });
});

test('installations notify consumers through the shared installer used by custom and marketplace installs', async () => {
  const f = fixture();
  f.service.importPath.mockResolvedValue({ success: true, extensionId: 'feature-plugin' });
  f.service.listCatalog.mockResolvedValue([{ id: 'feature-plugin', enabled: true }]);
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'custom',
    onProgress: vi.fn(),
  });
  expect(result).toMatchObject({
    success: true,
    pluginId: 'feature-plugin',
    installPath: 'C:/installed/feature-plugin',
  });
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
});

test('installs a local extension without a review token once inside the package mutation owner', async () => {
  let packageMutationActive = false;
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => {
    packageMutationActive = true;
    try {
      return await operation();
    } finally {
      packageMutationActive = false;
    }
  });
  const f = fixture(undefined, mutateAppPackage);
  f.service.importPath.mockImplementation(async () => {
    expect(packageMutationActive).toBe(true);
    return { success: true, extensionId: 'feature-plugin' };
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    operation: 'install',
    origin: 'custom',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
  });

  expect(result).toMatchObject({ success: true, pluginId: 'feature-plugin' });
  expect(result.capabilityReview).toBeUndefined();
  expect(f.service.importPath).toHaveBeenCalledExactlyOnceWith(
    'C:/source', undefined, undefined, {
      autoAcceptCapabilities: true,
      trustMarketplaceSource: false,
      preserveActivation: false,
    },
  );
  expect(mutateAppPackage).toHaveBeenCalledOnce();
  expect(packageMutationActive).toBe(false);
  expect(f.forgetMarketplace).toHaveBeenCalledExactlyOnceWith(PluginKind.EXTENSION, 'feature-plugin');
});

test.each([ExtensionPackageLifecycleMode.HOT, ExtensionPackageLifecycleMode.STOPPED])(
  'reserves package ordering and approves only the selected stopped lifecycle: %s', async mode => {
    let reserved = false;
    let applying = false;
    const apply: ApplyExtensionPackageMutation = vi.fn(async (_target, operation) => {
      expect(reserved).toBe(true);
      applying = true;
      try { return await operation(mode); }
      finally { applying = false; }
    });
    const withExtensionPackageMutation: WithExtensionPackageMutation = vi.fn(async operation => {
      reserved = true;
      try { return await operation(apply); }
      finally { reserved = false; }
    });
    const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const approveInstalledAppPackage = vi.fn(async () => {
      expect(reserved).toBe(true);
      expect(applying).toBe(true);
    });
    const f = fixture(undefined, mutateAppPackage, undefined,
      approveInstalledAppPackage, withExtensionPackageMutation);
    f.service.importPath.mockImplementation(async (_source, _progress, _review, options) => {
      expect(reserved).toBe(true);
      expect(applying).toBe(false);
      expect(options.autoAcceptCapabilities).toBe(true);
      return options.applyPackageMutation({ nativePluginIds: ['feature-plugin'] },
        (selectedMode: ExtensionPackageLifecycleMode) => options.onInstalled({
          success: true, extensionId: 'feature-plugin', installPath: 'C:/installed/feature-plugin',
        }, selectedMode));
    });
    const installer = f.installation.registerInstaller.mock.calls[0][0];
    const result = await installer.install({
      operation: 'install', origin: 'custom',
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    });
    expect(result).toMatchObject({ success: true, pluginId: 'feature-plugin' });
    expect(withExtensionPackageMutation).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(f.service.importPath).toHaveBeenCalledOnce();
    expect(mutateAppPackage).not.toHaveBeenCalled();
    expect(approveInstalledAppPackage).toHaveBeenCalledTimes(
      mode === ExtensionPackageLifecycleMode.STOPPED ? 1 : 0);
    expect(reserved).toBe(false);
  },
);

test('passes removal through the same outer reservation without an unconditional stopped wrapper', async () => {
  const apply: ApplyExtensionPackageMutation = vi.fn(async (_target, operation) =>
    operation(ExtensionPackageLifecycleMode.HOT));
  const withExtensionPackageMutation: WithExtensionPackageMutation = vi.fn(async operation => operation(apply));
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const f = fixture(undefined, mutateAppPackage, undefined, undefined, withExtensionPackageMutation);
  f.service.delete.mockResolvedValue({ success: true });
  expect(await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' }))
    .toMatchObject({ success: true });
  expect(withExtensionPackageMutation).toHaveBeenCalledOnce();
  expect(f.service.delete).toHaveBeenCalledExactlyOnceWith('feature-plugin', expect.any(Function), apply);
  expect(mutateAppPackage).not.toHaveBeenCalled();
});

test('preserves an unknown local installation without requesting another review or repeating it', async () => {
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const approveInstalledAppPackage = vi.fn(async () => undefined);
  const f = fixture(undefined, mutateAppPackage, undefined, approveInstalledAppPackage);
  f.service.importPath.mockResolvedValue({
    success: false,
    extensionId: 'feature-plugin',
    installSourceInUse: true,
    operationUnconfirmed: true,
    operationFailedStage: PluginOperationStage.INSTALLING,
    error: 'Native installation outcome unknown',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    operation: 'install',
    origin: 'custom',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
  });

  expect(result).toMatchObject({
    success: false,
    installSourceInUse: true,
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.INSTALLING,
    error: 'Native installation outcome unknown',
  });
  expect(result.capabilityReview).toBeUndefined();
  expect(result).not.toHaveProperty('installationCommitted');
  expect(mutateAppPackage).toHaveBeenCalledOnce();
  expect(f.service.importPath).toHaveBeenCalledOnce();
  expect(approveInstalledAppPackage).not.toHaveBeenCalled();
  expect(f.forgetMarketplace).not.toHaveBeenCalled();
});

test('approves only the committed app package inside the existing stopped-Gateway installation owner', async () => {
  const sequence: string[] = [];
  let packageMutationActive = false;
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => {
    sequence.push('stop');
    packageMutationActive = true;
    try {
      return await operation();
    } finally {
      packageMutationActive = false;
      sequence.push('reconnect');
    }
  });
  const approveInstalledAppPackage = vi.fn(async () => {
    expect(packageMutationActive).toBe(true);
    sequence.push('approve');
  });
  const f = fixture(undefined, mutateAppPackage, undefined, approveInstalledAppPackage);
  const installPath = 'C:/installed/中文 app package';
  f.service.importPath.mockImplementation(async () => {
    expect(packageMutationActive).toBe(true);
    sequence.push('install');
    return { success: true, extensionId: 'feature-plugin', installPath };
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  const onProgress = vi.fn();

  const result = await installer.install({
    operation: 'install',
    origin: 'custom',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/selected/source' },
    onProgress,
  });

  expect(result).toMatchObject({ success: true, pluginId: 'feature-plugin', installPath });
  expect(sequence).toEqual(['stop', 'install', 'approve', 'reconnect']);
  expect(mutateAppPackage).toHaveBeenCalledOnce();
  expect(approveInstalledAppPackage).toHaveBeenCalledExactlyOnceWith({
    nativePluginId: 'feature-plugin', installPath,
  });
  expect(onProgress.mock.calls.map(([progress]) => progress.stage)).toEqual([
    PluginOperationStage.VALIDATING,
    PluginOperationStage.PREPARING_RUNTIME,
    PluginOperationStage.REFRESHING_INVENTORY,
  ]);
  expect(f.service.importPath).toHaveBeenCalledOnce();
  expect(f.service.listInstalled).not.toHaveBeenCalled();
  expect(f.service.setEnabled).not.toHaveBeenCalled();
});

test('lets native-only app inspection finish without another package owner or enabling action', async () => {
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const approveInstalledAppPackage = vi.fn(async () => undefined);
  const f = fixture(undefined, mutateAppPackage, undefined, approveInstalledAppPackage);
  f.service.importPath.mockResolvedValue({
    success: true, extensionId: 'native-only', installPath: 'C:/installed/native-only',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    operation: 'install',
    origin: 'marketplace',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/downloaded/native-only' },
  });

  expect(result).toMatchObject({ success: true, pluginId: 'native-only' });
  expect(mutateAppPackage).toHaveBeenCalledOnce();
  expect(approveInstalledAppPackage).toHaveBeenCalledExactlyOnceWith({
    nativePluginId: 'native-only', installPath: 'C:/installed/native-only',
  });
  expect(f.service.importPath).toHaveBeenCalledOnce();
  expect(f.service.setEnabled).not.toHaveBeenCalled();
});

test('keeps the committed installation and app-validation error when runtime recovery also fails', async () => {
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => {
    const receipt = await operation();
    expect(receipt).toMatchObject({
      success: false,
      installationCommitted: true,
      failedStage: PluginOperationStage.VALIDATING,
    });
    throw new Error('Synthetic runtime recovery failure');
  });
  const approveInstalledAppPackage = vi.fn(async () => {
    throw new Error('App artifact hash mismatch at C:/installed/feature-plugin; accessCode=synthetic-secret');
  });
  const f = fixture(undefined, mutateAppPackage, undefined, approveInstalledAppPackage);
  f.service.importPath.mockResolvedValue({
    success: true, extensionId: 'feature-plugin', installPath: 'C:/installed/feature-plugin',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    operation: 'install',
    origin: 'custom',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/selected/source' },
  });

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    pluginId: 'feature-plugin',
    installPath: 'C:/installed/feature-plugin',
    failedStage: PluginOperationStage.VALIDATING,
    refreshWarning: true,
    error: expect.stringContaining(t('extensionAppCodeApprovalFailed')),
  });
  expect(result.error).toContain('App artifact hash mismatch');
  expect(result.error).toContain('Synthetic runtime recovery failure');
  expect(result.error).toContain('C:/installed/feature-plugin');
  expect(result.error).not.toContain('synthetic-secret');
  expect(result).not.toHaveProperty('mutationCompleted');
  expect(result).not.toHaveProperty('runtimeRecoveryPending');
  expect(mutateAppPackage).toHaveBeenCalledOnce();
  expect(approveInstalledAppPackage).toHaveBeenCalledOnce();
  expect(f.service.importPath).toHaveBeenCalledOnce();
  expect(f.forgetMarketplace).toHaveBeenCalledExactlyOnceWith(PluginKind.EXTENSION, 'feature-plugin');
});

test('does not authorize app code when the committed installation has no verified path', async () => {
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const approveInstalledAppPackage = vi.fn(async () => undefined);
  const f = fixture(undefined, mutateAppPackage, undefined, approveInstalledAppPackage);
  f.service.importPath.mockResolvedValue({ success: true, extensionId: 'feature-plugin' });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    operation: 'install',
    origin: 'custom',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
  });

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    pluginId: 'feature-plugin',
    failedStage: PluginOperationStage.CONFIRMING,
    error: t('extensionPackageOwnershipUnconfirmed'),
  });
  expect(approveInstalledAppPackage).not.toHaveBeenCalled();
  expect(f.service.importPath).toHaveBeenCalledOnce();
});

test('does not approve app code after a committed native follow-up failure', async () => {
  const approveInstalledAppPackage = vi.fn(async () => undefined);
  const f = fixture(undefined, async operation => operation(), undefined, approveInstalledAppPackage);
  f.service.importPath.mockResolvedValue({
    success: false,
    extensionId: 'feature-plugin',
    installPath: 'C:/installed/feature-plugin',
    installationCommitted: true,
    operationFailedStage: PluginOperationStage.SAVING_CONFIGURATION,
    error: 'Native allowlist save failed',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    operation: 'install',
    origin: 'custom',
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
  });

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    failedStage: PluginOperationStage.SAVING_CONFIGURATION,
    error: 'Native allowlist save failed',
  });
  expect(approveInstalledAppPackage).not.toHaveBeenCalled();
  expect(f.service.importPath).toHaveBeenCalledOnce();
});

test.each(['install', 'update'])(
  'passes activation preservation only for marketplace updates: %s',
  async operation => {
    const f = fixture();
    f.service.importPath.mockResolvedValue({ success: true, extensionId: 'feature-plugin' });
    const installer = f.installation.registerInstaller.mock.calls[0][0];
    await installer.install({
      operation,
      origin: 'marketplace',
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    });
    expect(f.service.importPath).toHaveBeenCalledWith('C:/source', undefined, undefined, {
      autoAcceptCapabilities: true,
      trustMarketplaceSource: true,
      preserveActivation: operation === 'update',
    });
  },
);

test('failed catalog reads preserve the mutation result and do not invent an enabled state', async () => {
  const f = fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.service.setEnabled.mockResolvedValue({ success: true });
  f.service.listCatalog.mockRejectedValue(new Error('unavailable'));
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'feature-plugin',
      enabled: false,
    }),
  ).toEqual({ success: true, refreshWarning: true });
  expect(f.sender.send).not.toHaveBeenCalled();
  warn.mockRestore();
});

test('local import preserves committed failure evidence without exposing installation paths', async () => {
  const f = fixture();
  f.installation.install.mockResolvedValue({
    success: false,
    pluginId: 'feature-plugin',
    installationCommitted: true,
    installSourceInUse: true,
    installPath: 'C:/private-installation',
    failedStage: 'confirming',
    error: 'confirmation failed',
  });
  const result = await handlers.get(ExtensionIpc.Import)!(f.event, {
    requestId: 'local-committed',
    sourcePath: 'C:/source',
  });
  expect(result).toMatchObject({
    success: false,
    extensionId: 'feature-plugin',
    installationCommitted: true,
    installSourceInUse: true,
    failedStage: 'confirming',
  });
  expect(result).not.toHaveProperty('installPath');
});

test('a partially installed extension still invalidates attached capabilities when its reload fails', async () => {
  const f = fixture();
  f.service.importPath.mockResolvedValue({
    success: false,
    extensionId: 'feature-plugin',
    error: 'restart failed',
  });
  f.service.listCatalog.mockResolvedValue([{ id: 'feature-plugin', enabled: true }]);
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  await expect(
    installer.install({
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
      origin: 'custom',
    }),
  ).resolves.toMatchObject({ success: false, pluginId: 'feature-plugin', error: 'restart failed' });
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
});

test('retains committed installation identity when applying its runtime state fails', async () => {
  const f = fixture();
  f.service.importPath.mockResolvedValue({
    success: false,
    extensionId: 'feature-plugin',
    installationCommitted: true,
    failedStage: 'installing',
    operationFailedStage: 'confirming',
    error: 'restart failed',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  await expect(
    installer.install({
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
      origin: 'marketplace',
    }),
  ).resolves.toMatchObject({
    success: false,
    pluginId: 'feature-plugin',
    installPath: 'C:/installed/feature-plugin',
    installationCommitted: true,
    failedStage: 'confirming',
  });
});

test('retains the native installation receipt when package recovery rejects after installation', async () => {
  const mutate = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => {
    await operation();
    throw new Error('Outbound proxy preparation failed; accessCode=synthetic-secret');
  });
  const f = fixture(undefined, mutate);
  f.service.importPath.mockResolvedValue({
    success: true,
    extensionId: 'feature-plugin/child',
    installPath: 'C:/installed/feature-plugin',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'marketplace',
  });

  expect(result).toMatchObject({
    success: false,
    pluginId: 'feature-plugin/child',
    installPath: 'C:/installed/feature-plugin',
    installationCommitted: true,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
    error: expect.stringContaining('Outbound proxy preparation failed'),
  });
  expect(result.error).not.toContain('synthetic-secret');
  expect(mutate).toHaveBeenCalledOnce();
  expect(f.service.importPath).toHaveBeenCalledOnce();
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin/child', enabled: false,
  });
});

test('retains unknown ownership and the original failure when package recovery also fails', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new Error('Synthetic runtime recovery failure');
  });
  f.service.importPath.mockResolvedValue({
    success: false,
    extensionId: 'feature-plugin',
    operationFailedStage: PluginOperationStage.CONFIRMING,
    installSourceInUse: true,
    operationUnconfirmed: true,
    error: 'Native installation outcome unknown',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'marketplace',
  });
  expect(result).toMatchObject({
    success: false,
    failedStage: PluginOperationStage.CONFIRMING,
    installSourceInUse: true,
    operationUnconfirmed: true,
    refreshWarning: true,
    error: expect.stringMatching(/^Native installation outcome unknown\n/),
  });
  expect(result.error).toContain('Synthetic runtime recovery failure');
  expect(result).not.toHaveProperty('installationCommitted');
  f.installation.install.mockResolvedValue(result);
  expect(await handlers.get(ExtensionIpc.Import)!(f.event, {
    requestId: 'unknown-import', sourcePath: 'C:/source',
  })).toMatchObject({ operationUnconfirmed: true, installSourceInUse: true });
});

test('carries confirmed installation and pending recovery through both custom import projections', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new EnginePreparationPendingError(EnginePreparationPendingCode.LIFECYCLE_CHANGED, 'Retired engine verification');
  });
  f.service.importPath.mockResolvedValue({ success: true, extensionId: 'feature-plugin' });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' }, origin: 'custom',
  });
  expect(result).toMatchObject({
    success: false, installationCommitted: true,
    mutationCompleted: true, runtimeRecoveryPending: true,
    error: expect.stringContaining('Retired engine verification'),
  });
  f.installation.install.mockResolvedValue(result);
  expect(await handlers.get(ExtensionIpc.Import)!(f.event, {
    requestId: 'completed-import', sourcePath: 'C:/source',
  })).toMatchObject({ mutationCompleted: true, runtimeRecoveryPending: true });
  expect(f.service.importPath).toHaveBeenCalledOnce();
});

test('keeps a confirmed removal successful when only its recovery observation is pending', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new EnginePreparationPendingError(EnginePreparationPendingCode.SUPERSEDED, 'Newer engine verification owns recovery');
  });
  f.service.delete.mockResolvedValue({ success: true });
  const result = await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' });

  expect(result).toMatchObject({
    success: true, refreshWarning: true, mutationCompleted: true, runtimeRecoveryPending: true,
  });
  expect(f.service.delete).toHaveBeenCalledOnce();
  expect(f.forgetMarketplace).toHaveBeenCalledWith(PluginKind.EXTENSION, 'feature-plugin');
});

test.each([
  { success: false, operationUnconfirmed: true, error: 'Native removal unconfirmed' },
  { success: true, refreshWarning: true, error: 'Outbound policy cleanup failed' },
])('pending recovery cannot conceal an earlier mutation or cleanup problem: $error', async receipt => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new EnginePreparationPendingError(EnginePreparationPendingCode.STARTING, 'Engine still starting');
  });
  f.service.delete.mockResolvedValue(receipt);
  const result = await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' });

  expect(result).toMatchObject({ ...receipt, error: expect.stringContaining(receipt.error) });
  expect(result.error).toContain(receipt.error);
  expect(result).not.toHaveProperty('mutationCompleted');
  expect(result).not.toHaveProperty('runtimeRecoveryPending');
  expect(f.service.delete).toHaveBeenCalledOnce();
});

test('preserves capability review evidence when the package wrapper subsequently fails', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new Error('Synthetic runtime recovery failure');
  });
  const capabilityReview = { reviewToken: 'replacement-review' };
  f.service.importPath.mockResolvedValue({ success: false, capabilityReview });
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source', reviewToken: 'original-review' },
    origin: 'custom',
  });
  expect(result).toMatchObject({
    success: false, capabilityReview, refreshWarning: true,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
    error: expect.stringContaining('Synthetic runtime recovery failure'),
  });
  expect(result).not.toHaveProperty('installationCommitted');
});

test('does not label a capability-review catalog read failure as runtime recovery failure', async () => {
  const f = fixture();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const capabilityReview = { reviewToken: 'original-review' };
  f.service.importPath.mockResolvedValue({ success: false, extensionId: 'feature-plugin', capabilityReview });
  f.service.listCatalog.mockRejectedValue(new Error('Catalog unavailable'));
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'custom',
  });
  expect(result).toMatchObject({ success: false, capabilityReview, refreshWarning: true });
  expect(result.failedStage).toBeUndefined();
  expect(result.error).toBeUndefined();
  expect(result).not.toHaveProperty('installationCommitted');
});

test.each(['custom', 'marketplace'])(
  'does not install or invent a receipt when the package owner rejects before a %s import', async origin => {
  const f = fixture(undefined, async () => { throw new Error('Package preparation failed'); });
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  await expect(installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin,
  })).rejects.toThrow('Package preparation failed');
  expect(f.service.importPath).not.toHaveBeenCalled();
  expect(f.service.listInstalled).not.toHaveBeenCalled();
});

test('reports completed removal separately from package recovery failure and clears marketplace identity', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new Error('Synthetic outbound environment recovery failure');
  });
  f.service.delete.mockResolvedValue({ success: true });
  f.service.listCatalog.mockResolvedValue([]);
  const result = await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' });
  expect(result).toMatchObject({
    success: true, refreshWarning: true, failedStage: PluginOperationStage.PREPARING_RUNTIME,
    error: expect.stringContaining('Synthetic outbound environment recovery failure'),
  });
  expect(f.service.delete).toHaveBeenCalledOnce();
  expect(f.forgetMarketplace).toHaveBeenCalledWith(PluginKind.EXTENSION, 'feature-plugin');
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin', enabled: false,
  });
});

test('does not turn an unconfirmed removal into success when package recovery also fails', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new Error('Synthetic runtime recovery failure');
  });
  f.service.delete.mockResolvedValue({
    success: false, operationUnconfirmed: true, failedStage: PluginOperationStage.UNINSTALLING,
    error: 'Native removal unconfirmed',
  });
  const result = await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' });
  expect(result).toMatchObject({
    success: false, operationUnconfirmed: true, refreshWarning: true,
    failedStage: PluginOperationStage.UNINSTALLING,
    error: expect.stringMatching(/^Native removal unconfirmed\n/),
  });
  expect(f.forgetMarketplace).not.toHaveBeenCalled();
  expect(f.service.delete).toHaveBeenCalledOnce();
});

test('retains the first post-removal failure and cause when runtime recovery also fails', async () => {
  const f = fixture(undefined, async operation => {
    await operation();
    throw new Error('Gateway port is occupied');
  });
  f.service.delete.mockResolvedValue({
    success: true, refreshWarning: true,
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
    error: 'Plugin uninstalled, but outbound policy config could not be written',
  });
  const result = await handlers.get(ExtensionIpc.Delete)!(f.event, { extensionId: 'feature-plugin' });
  expect(result).toMatchObject({
    success: true, refreshWarning: true,
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
    error: expect.stringMatching(/^Plugin uninstalled, but outbound policy config could not be written\n/),
  });
  expect(result.error).toContain('Gateway port is occupied');
  expect(f.service.delete).toHaveBeenCalledOnce();
  expect(f.forgetMarketplace).toHaveBeenCalledWith(PluginKind.EXTENSION, 'feature-plugin');
});

test('preserves a native failure step while finally refreshing the catalog', async () => {
  const f = fixture();
  f.service.setEnabled.mockImplementation(async (_id, _enabled, _token, report) => {
    report?.('applying_configuration');
    return { success: false, error: 'apply failed', operationUnconfirmed: true };
  });
  const result = await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
  expect(result).toMatchObject({
    success: false,
    error: 'apply failed',
    failedStage: 'applying_configuration',
    operationUnconfirmed: true,
  });
});

test('preserves the verified package path when native installation returns a child identity', async () => {
  const f = fixture();
  f.service.importPath.mockResolvedValue({
    success: true,
    extensionId: 'feature-plugin/child',
    installPath: 'C:/installed/feature-plugin',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'custom',
  });

  expect(result).toMatchObject({
    success: true,
    pluginId: 'feature-plugin/child',
    installPath: 'C:/installed/feature-plugin',
  });
  expect(f.service.listInstalled).not.toHaveBeenCalled();
});

test('exposes unconfirmed source ownership without exposing the temporary source path', async () => {
  const f = fixture();
  f.service.importPath.mockResolvedValue({
    success: false,
    extensionId: 'feature-plugin',
    installSourceInUse: true,
    error: 'Gateway request timed out',
  });
  const installer = f.installation.registerInstaller.mock.calls[0][0];
  const result = await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'marketplace',
  });
  expect(result).toMatchObject({ success: false, installSourceInUse: true });
  expect(result).not.toHaveProperty('installationCommitted');
  expect(f.service.listInstalled).not.toHaveBeenCalled();
  f.installation.install.mockResolvedValue(result);
  const response = await handlers.get(ExtensionIpc.Import)!(f.event, {
    requestId: 'request-1',
    sourcePath: 'C:/source',
  });
  expect(response).toHaveProperty('installSourceInUse', true);
});

test('serialized notifications prevent an older catalog response from arriving after a newer one', async () => {
  const f = fixture();
  let resolve!: (catalog: Array<{ id: string; enabled: boolean }>) => void;
  f.service.setEnabled.mockResolvedValue({ success: true });
  f.service.listCatalog
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce([{ id: 'feature-plugin', enabled: true }]);
  const first = handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'feature-plugin',
    enabled: false,
  });
  await vi.waitFor(() => expect(f.service.listCatalog).toHaveBeenCalledOnce());
  const second = handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
  expect(f.service.setEnabled).toHaveBeenCalledOnce();
  expect(f.service.listCatalog).toHaveBeenCalledOnce();
  resolve([{ id: 'feature-plugin', enabled: false }]);
  await Promise.all([first, second]);
  expect(f.peer.send.mock.calls.map(call => call[1].enabled)).toEqual([false, true]);
});

test('successful mutations still publish the catalog state and skip destroyed web contents', async () => {
  const f = fixture();
  f.service.setEnabled.mockResolvedValue({ success: true });
  f.sender.isDestroyed.mockReturnValue(true);
  await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
  expect(f.sender.send).not.toHaveBeenCalled();
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: false,
  });
});

test('a thrown mutation error still refreshes persisted state without losing the original error', async () => {
  const f = fixture();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  f.service.setEnabled.mockRejectedValue(new Error('Restart failed'));
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'feature-plugin',
      enabled: false,
    }),
  ).toEqual({ success: false, error: 'Restart failed', failedStage: 'queued' });
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: false,
  });
});

test('invalid requests neither mutate plugins nor publish state', async () => {
  const f = fixture();
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, { extensionId: '', enabled: false }),
  ).toMatchObject({ success: false });
  expect(f.service.setEnabled).not.toHaveBeenCalled();
  expect(f.service.listCatalog).not.toHaveBeenCalled();
  expect(f.peer.send).not.toHaveBeenCalled();
});

test('fences pending Agent Team inputs before saving its disabled configuration', async () => {
  let release!: () => void;
  const releaseDisable = vi.fn();
  const fence = vi.fn(
    () =>
      new Promise<() => void>(resolve => {
        release = () => resolve(releaseDisable);
      }),
  );
  const f = fixture(fence);
  f.service.setEnabled.mockResolvedValue({ success: true });
  const disabling = handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'agent-team',
    enabled: false,
  });
  await vi.waitFor(() => expect(fence).toHaveBeenCalledOnce());
  expect(f.service.setEnabled).not.toHaveBeenCalled();
  expect(releaseDisable).not.toHaveBeenCalled();
  const enabling = handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'agent-team',
    enabled: true,
  });
  await Promise.resolve();
  expect(f.service.setEnabled).not.toHaveBeenCalled();
  release();
  await Promise.all([disabling, enabling]);
  expect(f.service.setEnabled.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['agent-team', false],
    ['agent-team', true],
  ]);
  expect(fence).toHaveBeenCalledOnce();
  expect(releaseDisable).toHaveBeenCalledOnce();
});

test('holds admission until native configuration settles and releases before a queued re-enable', async () => {
  const releaseDisable = vi.fn();
  const f = fixture(async () => releaseDisable);
  let finish!: (result: { success: boolean }) => void;
  f.service.setEnabled
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    )
    .mockImplementationOnce(async () => {
      expect(releaseDisable).toHaveBeenCalledOnce();
      return { success: true };
    });
  const disabling = handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'agent-team',
    enabled: false,
  });
  await vi.waitFor(() => expect(f.service.setEnabled).toHaveBeenCalledOnce());
  const enabling = handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'agent-team',
    enabled: true,
  });
  await Promise.resolve();
  expect(f.service.setEnabled).toHaveBeenCalledOnce();
  expect(releaseDisable).not.toHaveBeenCalled();
  finish({ success: true });
  await Promise.all([disabling, enabling]);
  expect(releaseDisable).toHaveBeenCalledOnce();
});

test('releases the disable admission lease after a failed native mutation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const releaseDisable = vi.fn();
  const f = fixture(async () => releaseDisable);
  f.service.setEnabled.mockRejectedValue(new Error('config rejected'));
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'agent-team',
      enabled: false,
    }),
  ).toMatchObject({ success: false, error: 'config rejected' });
  expect(releaseDisable).toHaveBeenCalledOnce();
});

test.each([true, false])('preserves a confirmed toggle when lifecycle completion fails (enabled: %s)', async enabled => {
  const mutate = vi.fn(async <T>(_id: string, _enabled: boolean, operation: () => Promise<T>): Promise<T> => {
    await operation();
    throw new Error('Companion status confirmation failed; accessCode=synthetic-private-code');
  });
  const f = fixture(undefined, undefined, mutate);
  f.service.setEnabled.mockResolvedValue({ success: true, warnings: ['Native warning'] });

  const result = await handlers.get(ExtensionIpc.SetEnabled)!(f.event, { extensionId: 'feature-plugin', enabled });

  expect(result).toMatchObject({
    success: true,
    refreshWarning: true,
    failedStage: PluginOperationStage.CONFIRMING,
    warnings: ['Native warning'],
    error: expect.stringContaining('Companion status confirmation failed'),
  });
  expect(result).not.toHaveProperty('installationCommitted');
  expect(result).not.toHaveProperty('operationUnconfirmed');
  expect((result as { error: string }).error).not.toContain('synthetic-private-code');
  expect(f.service.setEnabled).toHaveBeenCalledOnce();
  expect(mutate).toHaveBeenCalledOnce();
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin', enabled: false,
  });
});

test('keeps an unconfirmed toggle and its native failure ahead of a later lifecycle failure', async () => {
  const f = fixture(undefined, undefined, async (_id, _enabled, operation) => {
    await operation();
    throw new Error('Companion status confirmation failed');
  });
  f.service.setEnabled.mockResolvedValue({
    success: false,
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.DISABLING,
    error: 'Native toggle response was lost',
  });

  const result = await handlers.get(ExtensionIpc.SetEnabled)!(f.event, { extensionId: 'feature-plugin', enabled: false });

  expect(result).toMatchObject({
    success: false,
    operationUnconfirmed: true,
    refreshWarning: true,
    failedStage: PluginOperationStage.DISABLING,
    error: expect.stringMatching(/^Native toggle response was lost\n/),
  });
  expect((result as { error: string }).error).toContain('Companion status confirmation failed');
  expect(result).not.toHaveProperty('installationCommitted');
  expect(f.service.setEnabled).toHaveBeenCalledOnce();
});

test('keeps a toggle capability review and reports a separate lifecycle failure', async () => {
  const f = fixture(undefined, undefined, async (_id, _enabled, operation) => {
    await operation();
    throw new Error('Companion status confirmation failed');
  });
  const capabilityReview = { reviewToken: 'new-toggle-review' };
  f.service.setEnabled.mockResolvedValue({ success: false, capabilityReview });
  const result = await handlers.get(ExtensionIpc.SetEnabled)!(f.event, { extensionId: 'feature-plugin', enabled: true });
  expect(result).toMatchObject({
    success: false, capabilityReview, refreshWarning: true,
    failedStage: PluginOperationStage.CONFIRMING,
    error: expect.stringContaining('Companion status confirmation failed'),
  });
  expect(result).not.toHaveProperty('installationCommitted');
});

test.each([true, false])('does not fabricate a toggle receipt after a rejected lifecycle (before callback: %s)', async beforeCallback => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture(undefined, undefined, async (_id, _enabled, operation) => {
    if (beforeCallback) throw new Error('Enable preflight rejected');
    return operation();
  });
  f.service.setEnabled.mockRejectedValue(new Error('Native toggle did not return'));
  const result = await handlers.get(ExtensionIpc.SetEnabled)!(f.event, { extensionId: 'feature-plugin', enabled: true });
  expect(result).toMatchObject({ success: false, error: beforeCallback ? 'Enable preflight rejected' : 'Native toggle did not return' });
  expect(result).not.toHaveProperty('refreshWarning');
  expect(result).not.toHaveProperty('installationCommitted');
  expect(f.service.setEnabled).toHaveBeenCalledTimes(beforeCallback ? 0 : 1);
});

test('keeps the extension configuration unchanged when the required queue fence fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture(vi.fn().mockRejectedValue(new Error('queue fence failed')));
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'agent-team',
      enabled: false,
    }),
  ).toMatchObject({ success: false, error: 'queue fence failed' });
  expect(f.service.setEnabled).not.toHaveBeenCalled();
});

test('does not invoke the Agent Team queue fence for another extension', async () => {
  const fence = vi.fn();
  const f = fixture(fence);
  f.service.setEnabled.mockResolvedValue({ success: true });
  await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
    extensionId: 'feature-plugin',
    enabled: false,
  });
  expect(f.service.setEnabled).toHaveBeenCalledOnce();
  expect(fence).not.toHaveBeenCalled();
});

test.each([
  [ExtensionIpc.UpdateConfiguration, false],
  [ExtensionIpc.UpdateConfiguration, true],
  [ExtensionIpc.SetEnabled, false],
  [ExtensionIpc.SetEnabled, true],
] as const)('waits for settings application and rollback before TypeSafe %s (rollback: %s)', async (channel, rollback) => {
  const f = fixture();
  let config = { onlineModelProviders: { decision: { selected: true } } };
  const previous = structuredClone(config);
  let finishApplication!: () => void;
  let finishRollback!: () => void;
  const application = new Promise<void>(resolve => { finishApplication = resolve; });
  const compensation = new Promise<void>(resolve => { finishRollback = resolve; });
  const onAppConfigChanged = vi.fn(async (
    _next: unknown,
    _previous: unknown,
    context?: { rollback?: boolean },
  ) => {
    if (context?.rollback) {
      await compensation;
      return;
    }
    await application;
    if (rollback) throw new Error('settings application failed');
  });
  registerStoreHandlers({
    getStore: () => ({
      get: () => config,
      set: (_key: string, value: typeof config) => { config = value; },
      delete: vi.fn(),
    }) as never,
    onAppConfigChanged,
    refreshBuiltinModels: vi.fn(),
  });
  f.service.prepareCatalog.mockImplementation(async () => () => [{
    id: 'typesafe',
    enabled: true,
    managed: config.onlineModelProviders.decision.selected,
    canToggle: !config.onlineModelProviders.decision.selected,
    configurationFields: [{ path: 'serviceUrl', type: 'string', sensitive: false }],
  }]);
  const mutate = async () => config.onlineModelProviders.decision.selected
    ? { success: false, error: 'Managed extension' }
    : { success: true };
  f.service.setEnabled.mockImplementation(mutate);
  f.service.updateConfiguration.mockImplementation(mutate);
  const saving = (handlers.get(AppConfigIpc.Patch)!({}, {
    onlineModelProviders: { decision: { selected: false } },
  }) as Promise<unknown>).then(() => undefined, error => error as Error);
  await vi.waitFor(() => expect(onAppConfigChanged).toHaveBeenCalledOnce());
  const mutation = handlers.get(channel)!(f.event, channel === ExtensionIpc.SetEnabled
    ? { extensionId: 'typesafe', enabled: true }
    : { extensionId: 'typesafe', values: { serviceUrl: 'http://inference.corp/v1' } });
  const listing = handlers.get(ExtensionIpc.List)!();
  await Promise.resolve();
  expect(f.service.setEnabled).not.toHaveBeenCalled();
  expect(f.service.updateConfiguration).not.toHaveBeenCalled();
  expect(f.service.listCatalog).not.toHaveBeenCalled();
  expect(f.service.prepareCatalog).not.toHaveBeenCalled();

  finishApplication();
  if (rollback) {
    await vi.waitFor(() => expect(onAppConfigChanged).toHaveBeenCalledTimes(2));
    expect(config).toEqual(previous);
    expect(f.service.setEnabled).not.toHaveBeenCalled();
    expect(f.service.updateConfiguration).not.toHaveBeenCalled();
    expect(f.service.listCatalog).not.toHaveBeenCalled();
    expect(f.service.prepareCatalog).not.toHaveBeenCalled();
    finishRollback();
  }
  const saved = await saving;
  if (rollback) expect(saved).toBeInstanceOf(Error);
  else expect(saved).toBeUndefined();
  await expect(mutation).resolves.toMatchObject(rollback
    ? { success: false, error: 'Managed extension' }
    : { success: true });
  await expect(listing).resolves.toMatchObject({
    success: true,
    extensions: [{
      id: 'typesafe',
      managed: rollback,
      management: { configure: { allowed: !rollback }, enable: { allowed: !rollback } },
    }],
  });
});

test('saves native configuration without entering the companion package replacement flow', async () => {
  const mutateAppPackage = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const f = fixture(undefined, mutateAppPackage);
  const values = { globalConcurrency: '2' };
  const context = { requestId: 'workflow-config-save' };
  f.service.updateConfiguration.mockResolvedValue({ success: true, pending: true });

  await expect(handlers.get(ExtensionIpc.UpdateConfiguration)!(f.event, {
    extensionId: 'swarm-workflow', values,
  }, context)).resolves.toEqual({ success: true, pending: true });

  expect(f.service.updateConfiguration).toHaveBeenCalledExactlyOnceWith(
    'swarm-workflow', values, expect.any(Function),
  );
  expect(mutateAppPackage).not.toHaveBeenCalled();
  expect(f.sender.send).toHaveBeenCalledWith(PluginOperationIpc.Progress,
    expect.objectContaining({
      ...context, kind: PluginKind.EXTENSION,
      action: PluginOperationAction.SAVE, stage: PluginOperationStage.QUEUED,
    }));
});

test('holds the settings lane through a TypeSafe mutation and keeps other extension edits independent', async () => {
  const f = fixture();
  let finishMutation!: () => void;
  f.service.updateConfiguration.mockImplementation(async (extensionId: string) => {
    if (extensionId === 'typesafe') await new Promise<void>(resolve => { finishMutation = resolve; });
    return { success: true };
  });
  const editing = handlers.get(ExtensionIpc.UpdateConfiguration)!(f.event, {
    extensionId: 'typesafe', values: { serviceUrl: 'http://inference.corp/v1' },
  });
  await vi.waitFor(() => expect(f.service.updateConfiguration).toHaveBeenCalledOnce());
  const settings = vi.fn(async () => undefined);
  const saving = enqueueAppConfigUpdate(settings);

  await expect(handlers.get(ExtensionIpc.UpdateConfiguration)!(f.event, {
    extensionId: 'feature-plugin', values: { endpoint: 'http://feature.corp' },
  })).resolves.toMatchObject({ success: true });
  expect(settings).not.toHaveBeenCalled();

  finishMutation();
  await editing;
  await saving;
  expect(settings).toHaveBeenCalledOnce();
});

test('keeps configuration reads and saves available while catalog discovery waits for the Gateway', async () => {
  const f = fixture();
  let finishDiscovery!: () => void;
  f.service.prepareCatalog.mockImplementation(() => new Promise(resolve => {
    finishDiscovery = () => resolve(() => []);
  }));
  let config = { theme: 'light' };
  registerStoreHandlers({
    getStore: () => ({
      get: () => config,
      set: (_key: string, value: typeof config) => { config = value; },
      delete: vi.fn(),
    }) as never,
    onAppConfigChanged: vi.fn().mockResolvedValue(undefined),
    refreshBuiltinModels: vi.fn(),
  });

  const listing = handlers.get(ExtensionIpc.List)!() as Promise<unknown>;
  await vi.waitFor(() => expect(f.service.prepareCatalog).toHaveBeenCalledOnce());
  const reading = handlers.get('store:get')!({}, 'app_config') as Promise<unknown>;
  const saving = handlers.get(AppConfigIpc.Patch)!({}, { theme: 'dark' }) as Promise<unknown>;
  const readCompleted = vi.fn();
  const saveCompleted = vi.fn();
  void reading.then(readCompleted);
  void saving.then(saveCompleted);
  try {
    await vi.waitFor(() => {
      expect(readCompleted).toHaveBeenCalledWith({ theme: 'light' });
      expect(saveCompleted).toHaveBeenCalledWith({ theme: 'dark' });
    });
  } finally {
    finishDiscovery();
    await Promise.all([listing, reading, saving]);
  }
  await expect(listing).resolves.toEqual({ success: true, extensions: [] });
});

test('projects catalog settings after an overlapping save has finished rolling back', async () => {
  const f = fixture();
  let config = { onlineModelProviders: { decision: { selected: false } } };
  let finishDiscovery!: () => void;
  const project = vi.fn(() => [{
    id: 'typesafe',
    enabled: true,
    managed: config.onlineModelProviders.decision.selected,
    canToggle: !config.onlineModelProviders.decision.selected,
    configurationFields: [],
  }]);
  f.service.prepareCatalog.mockImplementation(() => new Promise(resolve => {
    finishDiscovery = () => resolve(project);
  }));
  let rejectApplication!: (error: Error) => void;
  let finishRollback!: () => void;
  const application = new Promise<void>((_resolve, reject) => { rejectApplication = reject; });
  const rollback = new Promise<void>(resolve => { finishRollback = resolve; });
  const onAppConfigChanged = vi.fn()
    .mockImplementationOnce(() => application)
    .mockImplementationOnce(() => rollback);
  registerStoreHandlers({
    getStore: () => ({
      get: () => config,
      set: (_key: string, value: typeof config) => { config = value; },
      delete: vi.fn(),
    }) as never,
    onAppConfigChanged,
    refreshBuiltinModels: vi.fn(),
  });
  const listing = handlers.get(ExtensionIpc.List)!() as Promise<unknown>;
  await vi.waitFor(() => expect(f.service.prepareCatalog).toHaveBeenCalledOnce());
  const saving = (handlers.get(AppConfigIpc.Patch)!({}, {
    onlineModelProviders: { decision: { selected: true } },
  }) as Promise<unknown>).catch(error => error as Error);
  try {
    await vi.waitFor(() => expect(onAppConfigChanged).toHaveBeenCalledOnce());
    finishDiscovery();
    // Drain the discovery continuation before checking the final projection.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(project).not.toHaveBeenCalled();
    rejectApplication(new Error('settings application failed'));
    await vi.waitFor(() => expect(onAppConfigChanged).toHaveBeenCalledTimes(2));
    expect(project).not.toHaveBeenCalled();
  } finally {
    finishDiscovery();
    rejectApplication(new Error('settings application failed'));
    finishRollback();
    await saving;
    await listing;
  }
  await expect(listing).resolves.toMatchObject({
    success: true,
    extensions: [{
      id: 'typesafe', managed: false,
      management: { configure: { allowed: false }, enable: { allowed: true } },
    }],
  });
});

test.each(['custom', 'marketplace'])(
  'keeps source attribution accurate after an extension import from %s',
  async origin => {
    const f = fixture();
    f.service.importPath.mockResolvedValue({ success: true, extensionId: 'feature-plugin' });
    const installer = f.installation.registerInstaller.mock.calls[0][0];
    await installer.install({
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
      origin,
    });
    if (origin === 'custom')
      expect(f.forgetMarketplace).toHaveBeenCalledWith(PluginKind.EXTENSION, 'feature-plugin');
    else expect(f.forgetMarketplace).not.toHaveBeenCalled();
  },
);

test.each([true, undefined])(
  'only clears ownership after a committed failed local import: %s',
  async installationCommitted => {
    const f = fixture();
    f.service.importPath.mockResolvedValue({
      success: false,
      extensionId: 'feature-plugin',
      installationCommitted,
      error: 'synthetic failure',
    });
    const installer = f.installation.registerInstaller.mock.calls[0][0];

    const result = await installer.install({
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
      origin: 'custom',
    });

    expect(result.success).toBe(false);
    expect(result.installationCommitted).toBe(installationCommitted);
    if (installationCommitted)
      expect(f.forgetMarketplace).toHaveBeenCalledWith(PluginKind.EXTENSION, 'feature-plugin');
    else expect(f.forgetMarketplace).not.toHaveBeenCalled();
  },
);

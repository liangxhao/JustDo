import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AppConfigIpc } from '../../../shared/app/appConfig';
import { ExtensionIpc } from '../../../shared/plugins/extensions';
import { PluginKind } from '../../../shared/plugins/marketplace';
import { PluginOperationIpc } from '../../../shared/plugins/pluginOperation';
import { enqueueAppConfigUpdate } from '../../data/appConfigUpdateQueue';
import type { OpenClawExtensionImportService } from '../../plugins/extensions';
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

function fixture(beforeAgentTeamDisable?: () => Promise<() => void>) {
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
    importPath: vi.fn(),
  };
  const forgetMarketplace = vi.fn();
  const installation = { registerInstaller: vi.fn(), install: vi.fn() };
  registerExtensionHandlers({
    extensionImportService: service as unknown as OpenClawExtensionImportService,
    installationService: installation as unknown as PluginInstallationService,
    beforeAgentTeamDisable,
    onMarketplacePluginDeleted: forgetMarketplace,
  });
  return { service, installation, sender, peer, forgetMarketplace, event: { sender } };
}

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
  await vi.waitFor(() => expect(f.service.setEnabled).toHaveBeenCalledTimes(2));
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

test('rejects Agent Team disable without its Main queue owner integration', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture();
  expect(
    await handlers.get(ExtensionIpc.SetEnabled)!(f.event, {
      extensionId: 'agent-team',
      enabled: false,
    }),
  ).toMatchObject({ success: false, error: 'teamDiscussionUnavailable' });
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

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ExtensionIpc } from '../../../shared/plugins/extensions';
import { PluginKind } from '../../../shared/plugins/marketplace';
import type { OpenClawExtensionImportService } from '../../plugins/extensions';
import type { PluginInstallationService } from '../../plugins/installation';

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
    setEnabled: vi.fn(),
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
  ).toEqual(failure);
  const expected = [ExtensionIpc.Changed, { extensionId: 'feature-plugin', enabled: false }];
  expect(f.sender.send).toHaveBeenCalledWith(...expected);
  expect(f.peer.send).toHaveBeenCalledWith(...expected);
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
  ).toEqual({ success: true });
  expect(f.sender.send).not.toHaveBeenCalled();
  warn.mockRestore();
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
  ).toEqual({ success: false, error: 'Restart failed' });
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
    expect(result).not.toHaveProperty('installationCommitted');
    if (installationCommitted)
      expect(f.forgetMarketplace).toHaveBeenCalledWith(PluginKind.EXTENSION, 'feature-plugin');
    else expect(f.forgetMarketplace).not.toHaveBeenCalled();
  },
);

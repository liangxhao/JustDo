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

function fixture() {
  const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const peer = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  windows.getAllWindows.mockReturnValue([
    { isDestroyed: () => false, webContents: sender },
    { isDestroyed: () => false, webContents: peer },
    { isDestroyed: () => true, webContents: { send: vi.fn() } },
  ]);
  const service = {
    listCatalog: vi.fn().mockResolvedValue([{ id: 'feature-plugin', enabled: false }]),
    setEnabled: vi.fn(),
    delete: vi.fn(),
    importPath: vi.fn(),
  };
  const installation = { registerInstaller: vi.fn(), install: vi.fn() };
  registerExtensionHandlers({
    extensionImportService: service as unknown as OpenClawExtensionImportService,
    installationService: installation as unknown as PluginInstallationService,
  });
  return { service, installation, sender, peer, event: { sender } };
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
  await installer.install({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' },
    origin: 'custom',
    onProgress: vi.fn(),
  });
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, {
    extensionId: 'feature-plugin',
    enabled: true,
  });
});

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
  f.service.importPath.mockResolvedValue({ success: false, extensionId: 'feature-plugin', error: 'restart failed' });
  f.service.listCatalog.mockResolvedValue([{ id: 'feature-plugin', enabled: true }]);
  const installer = f.installation.registerInstaller.mock.calls[0][0];

  await expect(installer.install({ payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:/source' }, origin: 'custom' }))
    .resolves.toMatchObject({ success: false, pluginId: 'feature-plugin', error: 'restart failed' });
  expect(f.peer.send).toHaveBeenCalledWith(ExtensionIpc.Changed, { extensionId: 'feature-plugin', enabled: true });
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

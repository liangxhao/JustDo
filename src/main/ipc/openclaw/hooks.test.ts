import { beforeEach, expect, test, vi } from 'vitest';

import { HookIpc } from '../../../shared/openclaw/hooks';
import type { OpenClawHookStore } from '../../plugins/hooks';
import { PluginInstallationService } from '../../plugins/installation';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerHookHandlers } from './hooks';

const hookReport = {
  workspaceDir: 'C:/workspace',
  managedHooksDir: 'C:/state/hooks',
  hooks: [
    {
      name: 'session-memory',
      hookKey: 'session-memory',
      source: 'openclaw-bundled',
      enabledByConfig: true,
    },
  ],
};

beforeEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
});

test('uses hooks.status as the authoritative hook inventory', async () => {
  const requestGateway = vi.fn().mockResolvedValue(hookReport);
  registerHookHandlers({
    getStore: () => ({}) as OpenClawHookStore,
    requestGateway,
    syncConfig: vi.fn(),
    installationService: new PluginInstallationService(),
  });

  await expect(handlers.get(HookIpc.List)?.()).resolves.toEqual({
    success: true,
    ...hookReport,
  });
  expect(requestGateway).toHaveBeenCalledWith('hooks.status', { agentId: 'main' });
});

test('persists a hook toggle before refreshing its live Gateway status', async () => {
  const requestGateway = vi.fn().mockResolvedValue(hookReport);
  const setEnabled = vi.fn();
  const syncConfig = vi.fn().mockResolvedValue({ hooks: 1 });
  registerHookHandlers({
    getStore: () =>
      ({
        getHook: vi.fn().mockReturnValue({ id: 'session-memory', enabled: true }),
        setEnabled,
      }) as unknown as OpenClawHookStore,
    requestGateway,
    syncConfig,
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, {
      id: 'session-memory',
      enabled: false,
    }),
  ).resolves.toMatchObject({ success: true, hooks: hookReport.hooks });
  expect(setEnabled).toHaveBeenCalledWith('session-memory', false);
  expect(syncConfig).toHaveBeenCalledOnce();
  expect(requestGateway).toHaveBeenCalledTimes(2);
  expect(syncConfig.mock.invocationCallOrder[0]).toBeLessThan(
    requestGateway.mock.invocationCallOrder[1],
  );
});

test('serializes Hook mutations without nesting the shared config sync queue', async () => {
  let releaseFirstSync!: (value: { hooks: number }) => void;
  const firstSync = new Promise<{ hooks: number }>(resolve => {
    releaseFirstSync = resolve;
  });
  const syncConfig = vi
    .fn()
    .mockImplementationOnce(() => firstSync)
    .mockResolvedValue({ hooks: 1 });
  const setEnabled = vi.fn();
  registerHookHandlers({
    getStore: () =>
      ({
        getHook: vi.fn().mockReturnValue({ id: 'session-memory', enabled: true }),
        setEnabled,
      }) as unknown as OpenClawHookStore,
    requestGateway: vi.fn().mockResolvedValue(hookReport),
    syncConfig,
    installationService: new PluginInstallationService(),
  });

  const first = handlers.get(HookIpc.SetEnabled)?.(undefined, {
    id: 'session-memory',
    enabled: false,
  }) as Promise<unknown>;
  const second = handlers.get(HookIpc.SetEnabled)?.(undefined, {
    id: 'session-memory',
    enabled: true,
  }) as Promise<unknown>;
  await vi.waitFor(() => expect(syncConfig).toHaveBeenCalledTimes(1));
  expect(setEnabled).toHaveBeenCalledTimes(1);

  releaseFirstSync({ hooks: 1 });
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(syncConfig).toHaveBeenCalledTimes(2);
  expect(setEnabled).toHaveBeenCalledTimes(2);
});

test('rolls back a newly inserted hook state when configuration sync fails', async () => {
  const requestGateway = vi.fn().mockResolvedValue(hookReport);
  const deleteHook = vi.fn();
  const store = {
    getHook: vi.fn().mockReturnValue(null),
    setEnabled: vi.fn(),
    deleteHook,
  } as unknown as OpenClawHookStore;
  registerHookHandlers({
    getStore: () => store,
    requestGateway,
    syncConfig: vi.fn().mockResolvedValue({ hooks: 0, error: 'sync failed' }),
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, { id: 'session-memory', enabled: false }),
  ).resolves.toEqual({ success: false, error: 'sync failed' });
  expect(deleteHook).toHaveBeenCalledWith('session-memory');
});

test('rolls back a newly inserted hook state when configuration sync throws', async () => {
  const deleteHook = vi.fn();
  registerHookHandlers({
    getStore: () =>
      ({
        getHook: vi.fn().mockReturnValue(null),
        setEnabled: vi.fn(),
        deleteHook,
      }) as unknown as OpenClawHookStore,
    requestGateway: vi.fn().mockResolvedValue(hookReport),
    syncConfig: vi.fn().mockRejectedValue(new Error('sync crashed')),
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, { id: 'session-memory', enabled: false }),
  ).resolves.toEqual({ success: false, error: 'sync crashed' });
  expect(deleteHook).toHaveBeenCalledWith('session-memory');
});

test('rejects malformed and plugin-managed hook mutations', async () => {
  const requestGateway = vi.fn().mockResolvedValue({
    ...hookReport,
    hooks: [{ ...hookReport.hooks[0], managedByPlugin: true }],
  });
  const setEnabled = vi.fn();
  registerHookHandlers({
    getStore: () => ({ setEnabled }) as unknown as OpenClawHookStore,
    requestGateway,
    syncConfig: vi.fn(),
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, { id: 'session-memory', enabled: 'yes' }),
  ).resolves.toEqual({ success: false, error: 'Hook id and enabled state are required' });
  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, { id: 'session-memory', enabled: false }),
  ).resolves.toEqual({ success: false, error: 'Plugin-managed Hooks cannot be changed here' });
  expect(setEnabled).not.toHaveBeenCalled();
});

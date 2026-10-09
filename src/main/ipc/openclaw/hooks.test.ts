import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { HookIpc } from '../../../shared/openclaw/hooks';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { OpenClawConfigSyncService } from '../../openclaw/config/openclawConfigSyncService';
import type { OpenClawHookStore } from '../../plugins/hooks';
import type { OpenClawHookRecord } from '../../plugins/hooks/openclawHookStore';
import { PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';

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

const importRoots: string[] = [];

afterEach(() => {
  for (const root of importRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const createHookImportHarness = (
  hookKey = 'demo-hook',
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-hook-import-test-'));
  importRoots.push(root);
  const sourcePath = path.join(root, 'source');
  const managedHooksDir = path.join(root, 'managed');
  const installedPath = path.join(managedHooksDir, 'demo-hook');
  fs.mkdirSync(sourcePath);
  fs.writeFileSync(
    path.join(sourcePath, 'HOOK.md'),
    '---\nname: demo-hook\ndescription: Demo Hook\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n',
  );
  fs.writeFileSync(path.join(sourcePath, 'handler.js'), 'export default async () => {};\n');
  const records = new Map<string, OpenClawHookRecord>();
  const store = {
    getHook: vi.fn((id: string) => records.get(id) ?? null),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      const record = {
        id,
        config: {},
        createdAt: 1,
        ...records.get(id),
        enabled,
        updatedAt: 2,
      };
      records.set(id, record);
      return record;
    }),
    deleteHook: vi.fn((id: string) => records.delete(id)),
    restoreHook: vi.fn((record: OpenClawHookRecord) => records.set(record.id, record)),
  };
  const refreshPlugins = vi.fn(async () => ({ ok: true, restartRequired: false }));
  const requestGateway = vi.fn(async (method: string) =>
    method === 'plugins.refresh'
      ? refreshPlugins()
      : {
          ...hookReport,
          managedHooksDir,
          hooks: [
            ...hookReport.hooks,
            ...(fs.existsSync(installedPath)
              ? [
                  {
                    name: 'demo-hook',
                    hookKey,
                    source: 'openclaw-managed',
                    baseDir: installedPath,
                    enabledByConfig: records.get(hookKey)?.enabled ?? true,
                    requirementsSatisfied: true,
                  },
                ]
              : []),
          ],
        },
  );
  const syncConfig = vi.fn(
    async () => ({ hooks: records.size }) as { hooks: number; error?: string },
  );
  const installationService = new PluginInstallationService();
  registerHookHandlers({
    getStore: () => store as unknown as OpenClawHookStore,
    requestGateway,
    syncConfig,
    runConfigMutationExclusive: operation =>
      runExclusive ? runExclusive(() => operation(syncConfig)) : operation(syncConfig),
    installationService,
  });
  const importHook = () =>
    handlers.get(HookIpc.Import)!(undefined, sourcePath) as Promise<{
      success: boolean;
      hookId?: string;
      error?: string;
    }>;
  return {
    sourcePath,
    installedPath,
    records,
    store,
    requestGateway,
    refreshPlugins,
    syncConfig,
    installationService,
    importHook,
  };
};

test.each(['demo-hook', 'native-hook-key'])(
  'applies imported Hook configuration before reporting success: %s',
  async hookKey => {
    const harness = createHookImportHarness(hookKey);
    let releaseSync!: (result: { hooks: number }) => void;
    harness.syncConfig.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseSync = resolve;
        }),
    );
    let finished = false;

    const importing = harness.importHook().then(result => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(harness.syncConfig).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(harness.records.get(hookKey)?.enabled).toBe(true);
    expect(fs.existsSync(harness.installedPath)).toBe(true);

    releaseSync({ hooks: 1 });
    await expect(importing).resolves.toMatchObject({ success: true, hookId: hookKey });
    expect(harness.requestGateway.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      harness.syncConfig.mock.invocationCallOrder[0],
    );
  },
);

test('applies Hook imports through the shared installer too', async () => {
  const harness = createHookImportHarness();

  await expect(
    harness.installationService.install({
      operation: MarketplaceInstallOperation.INSTALL,
      origin: PluginInstallOrigin.CUSTOM,
      payload: { kind: PluginKind.HOOK, sourcePath: harness.sourcePath },
    }),
  ).resolves.toMatchObject({ success: true, pluginId: 'demo-hook' });
  expect(harness.records.get('demo-hook')?.enabled).toBe(true);
  expect(harness.syncConfig).toHaveBeenCalledOnce();
});

test('waits for native handler publication when reimporting an already enabled Hook', async () => {
  const harness = createHookImportHarness();
  harness.store.setEnabled('demo-hook', true);
  let release!: (result: { ok: boolean; restartRequired: boolean }) => void;
  harness.refreshPlugins.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  let finished = false;
  const importing = harness.importHook().then(result => {
    finished = true;
    return result;
  });
  await vi.waitFor(() => expect(harness.refreshPlugins).toHaveBeenCalledOnce());
  expect(finished).toBe(false);
  expect(harness.records.get('demo-hook')?.enabled).toBe(true);
  expect(harness.requestGateway).toHaveBeenCalledWith('plugins.refresh', {});

  release({ ok: true, restartRequired: false });
  await expect(importing).resolves.toMatchObject({ success: true });
});

test.each(['rejected', 'restart pending', 'exception'])(
  'rolls back Hook import when native handler publication is %s',
  async failure => {
    const harness = createHookImportHarness();
    if (failure === 'exception')
      harness.refreshPlugins.mockRejectedValueOnce(new Error('refresh failed'));
    else
      harness.refreshPlugins.mockResolvedValueOnce({
        ok: failure !== 'rejected',
        restartRequired: true,
      });

    await expect(harness.importHook()).resolves.toMatchObject({ success: false });
    expect(harness.records.size).toBe(0);
    expect(fs.existsSync(harness.installedPath)).toBe(false);
    expect(harness.syncConfig).toHaveBeenCalledTimes(2);
  },
);

test('holds the global config queue until imported Hook handlers are published', async () => {
  const globalSync = new OpenClawConfigSyncService({} as never);
  const harness = createHookImportHarness('demo-hook', operation =>
    globalSync.runConfigMutationExclusive(operation),
  );
  let release!: (result: { ok: boolean; restartRequired: boolean }) => void;
  harness.refreshPlugins.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const importing = harness.importHook();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const extensionMutation = vi.fn(async () => undefined);
  const extension = globalSync.runConfigMutationExclusive(extensionMutation);
  await Promise.resolve();
  expect(extensionMutation).not.toHaveBeenCalled();

  release({ ok: true, restartRequired: false });
  await expect(importing).resolves.toMatchObject({ success: true });
  await extension;
  expect(extensionMutation).toHaveBeenCalledOnce();
});

test.each([true, false])(
  'forces compensating runtime refresh after an uncertain enabled-Hook import (recovery succeeds=%s)',
  async recoverySucceeds => {
    const harness = createHookImportHarness();
    harness.store.setEnabled('demo-hook', true);
    const previousState = harness.records.get('demo-hook');
    let handlerPublished = false;
    harness.refreshPlugins
      .mockImplementationOnce(async () => {
        handlerPublished = true;
        throw new Error('refresh reply timed out');
      })
      .mockImplementationOnce(async () => {
        expect(fs.existsSync(harness.installedPath)).toBe(false);
        if (!recoverySucceeds) throw new Error('compensating refresh failed');
        handlerPublished = false;
        return { ok: true, restartRequired: false };
      });

    await expect(harness.importHook()).resolves.toMatchObject({
      success: false,
      error: recoverySucceeds
        ? 'refresh reply timed out'
        : 'refresh reply timed out Rollback incomplete: compensating refresh failed',
    });
    expect(harness.records.get('demo-hook')).toEqual(previousState);
    expect(harness.refreshPlugins).toHaveBeenCalledTimes(2);
    expect(handlerPublished).toBe(!recoverySucceeds);
  },
);

test.each(['error result', 'exception'])(
  'removes imported files and state when Hook activation fails: %s',
  async failure => {
    const harness = createHookImportHarness();
    if (failure === 'exception') harness.syncConfig.mockRejectedValueOnce(new Error('sync failed'));
    else harness.syncConfig.mockResolvedValueOnce({ hooks: 0, error: 'sync failed' });

    await expect(harness.importHook()).resolves.toMatchObject({
      success: false,
      error: 'sync failed',
    });
    expect(fs.existsSync(harness.installedPath)).toBe(false);
    expect(harness.records.size).toBe(0);
    expect(harness.syncConfig).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(harness.sourcePath, 'HOOK.md'))).toBe(true);
  },
);

test('restores an existing Hook record when imported Hook activation fails', async () => {
  const harness = createHookImportHarness('native-hook-key');
  const previousState: OpenClawHookRecord = {
    id: 'native-hook-key',
    enabled: false,
    config: { env: { DEMO: 'value' } },
    createdAt: 10,
    updatedAt: 20,
  };
  harness.records.set(previousState.id, previousState);
  harness.syncConfig.mockResolvedValueOnce({ hooks: 0, error: 'sync failed' });

  await expect(harness.importHook()).resolves.toMatchObject({
    success: false,
    error: 'sync failed',
  });
  expect(harness.records.get(previousState.id)).toEqual(previousState);
  expect(fs.existsSync(harness.installedPath)).toBe(false);
});

test('preserves an installed Hook and its state when duplicate import is rejected', async () => {
  const harness = createHookImportHarness();
  fs.mkdirSync(harness.installedPath, { recursive: true });
  fs.writeFileSync(path.join(harness.installedPath, 'HOOK.md'), 'existing package');
  const previousState: OpenClawHookRecord = {
    id: 'demo-hook',
    enabled: false,
    config: {},
    createdAt: 10,
    updatedAt: 20,
  };
  harness.records.set(previousState.id, previousState);

  await expect(harness.importHook()).resolves.toMatchObject({ success: false });
  expect(fs.readFileSync(path.join(harness.installedPath, 'HOOK.md'), 'utf8')).toBe(
    'existing package',
  );
  expect(harness.records.get(previousState.id)).toEqual(previousState);
  expect(harness.syncConfig).not.toHaveBeenCalled();
});

test('queues Hook toggles behind an import that is still applying configuration', async () => {
  const harness = createHookImportHarness();
  let releaseSync!: (result: { hooks: number }) => void;
  harness.syncConfig.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        releaseSync = resolve;
      }),
  );
  const importing = harness.importHook();
  await vi.waitFor(() => expect(harness.syncConfig).toHaveBeenCalledOnce());

  const toggling = handlers.get(HookIpc.SetEnabled)!(undefined, {
    id: 'demo-hook',
    enabled: false,
  });
  await handlers.get(HookIpc.List)!();
  expect(harness.store.setEnabled).toHaveBeenCalledTimes(1);
  expect(harness.records.get('demo-hook')?.enabled).toBe(true);

  releaseSync({ hooks: 1 });
  await expect(importing).resolves.toMatchObject({ success: true });
  await expect(toggling).resolves.toMatchObject({ success: true });
  expect(harness.records.get('demo-hook')?.enabled).toBe(false);
  expect(harness.syncConfig).toHaveBeenCalledTimes(2);
});

test('does not report an activated Hook import as failed when its final status refresh is unavailable', async () => {
  const harness = createHookImportHarness();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  harness.refreshPlugins.mockImplementationOnce(async () => {
    harness.requestGateway.mockRejectedValueOnce(new Error('status temporarily unavailable'));
    return { ok: true, restartRequired: false };
  });

  await expect(harness.importHook()).resolves.toMatchObject({ success: true, hookId: 'demo-hook' });
  expect(harness.records.get('demo-hook')?.enabled).toBe(true);
  expect(fs.existsSync(harness.installedPath)).toBe(true);
});

test('removes copied Hook files when native discovery fails before activation', async () => {
  const harness = createHookImportHarness();
  harness.requestGateway
    .mockResolvedValueOnce({ ...hookReport, managedHooksDir: path.dirname(harness.installedPath) })
    .mockRejectedValueOnce(new Error('discovery failed'));

  await expect(harness.importHook()).resolves.toMatchObject({
    success: false,
    error: 'discovery failed',
  });
  expect(fs.existsSync(harness.installedPath)).toBe(false);
  expect(harness.records.size).toBe(0);
  expect(harness.syncConfig).not.toHaveBeenCalled();
});

test('reports incomplete recovery when the compensating Hook sync also fails', async () => {
  const harness = createHookImportHarness();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  harness.syncConfig
    .mockResolvedValueOnce({ hooks: 0, error: 'activation failed' })
    .mockResolvedValueOnce({ hooks: 0, error: 'recovery failed' });

  await expect(harness.importHook()).resolves.toMatchObject({
    success: false,
    error: 'activation failed Rollback incomplete: recovery failed',
  });
  expect(fs.existsSync(harness.installedPath)).toBe(false);
  expect(harness.records.size).toBe(0);
});

test('uses hooks.status as the authoritative hook inventory', async () => {
  const requestGateway = vi.fn().mockResolvedValue(hookReport);
  registerHookHandlers({
    getStore: () => ({}) as OpenClawHookStore,
    requestGateway,
    syncConfig: vi.fn(),
    installationService: new PluginInstallationService(),
  });

  await expect(handlers.get(HookIpc.List)?.()).resolves.toMatchObject({
    success: true,
    ...hookReport,
  });
  expect(requestGateway).toHaveBeenCalledWith('hooks.status', { agentId: 'main' });
});

test('projects plugin-managed Hook grouping from native parent origins without unlocking actions', async () => {
  const hooks = ['user-demo', 'system-demo'].map(pluginId => ({
    name: `${pluginId}-hook`,
    source: 'openclaw-plugin',
    pluginId,
    managedByPlugin: true,
    enabledByConfig: true,
  }));
  const requestGateway = vi.fn(async (method: string) =>
    method === 'hooks.status'
      ? { ...hookReport, hooks }
      : {
          plugins: [
            { id: 'user-demo', origin: 'global' },
            { id: 'system-demo', origin: 'bundled' },
          ],
        },
  );
  registerHookHandlers({
    getStore: () => ({}) as OpenClawHookStore,
    requestGateway: requestGateway as Parameters<typeof registerHookHandlers>[0]['requestGateway'],
    syncConfig: vi.fn(),
    installationService: new PluginInstallationService(),
  });

  await expect(handlers.get(HookIpc.List)?.()).resolves.toMatchObject({
    success: true,
    hooks: [
      {
        scope: 'personal',
        management: { disable: { allowed: false, reason: 'managed-by-extension', managedById: 'user-demo' } },
      },
      {
        scope: 'system',
        management: { disable: { allowed: false, reason: 'managed-by-extension', managedById: 'system-demo' } },
      },
    ],
  });
  expect(requestGateway).toHaveBeenCalledWith('plugins.list', {});
});

test('keeps plugin Hooks visible when their parent inventory cannot be read', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const hooks = [{ name: 'demo-hook', managedByPlugin: true, pluginId: 'demo' }];
  const requestGateway = vi.fn(async (method: string) => {
    if (method === 'plugins.list') throw new Error('temporarily unavailable');
    return { ...hookReport, hooks };
  });
  registerHookHandlers({
    getStore: () => ({}) as OpenClawHookStore,
    requestGateway: requestGateway as Parameters<typeof registerHookHandlers>[0]['requestGateway'],
    syncConfig: vi.fn(),
    installationService: new PluginInstallationService(),
  });
  await expect(handlers.get(HookIpc.List)?.()).resolves.toMatchObject({
    success: true,
    hooks: [{ name: 'demo-hook', scope: 'extension', management: { disable: { allowed: false } } }],
  });
  expect(warn).toHaveBeenCalledOnce();
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
  ).resolves.toEqual({ success: false, error: 'sync failed Rollback incomplete: sync failed' });
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
  ).resolves.toEqual({ success: false, error: 'sync crashed Rollback incomplete: sync crashed' });
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

test.each([
  [
    'name collision before authoritative key',
    [
      {
        name: 'target-hook',
        hookKey: 'plugin-hook',
        managedByPlugin: true,
      },
      {
        name: 'Custom target',
        hookKey: 'target-hook',
        source: 'openclaw-managed',
      },
    ],
  ],
  [
    'name collision after authoritative key',
    [
      {
        name: 'Custom target',
        hookKey: 'target-hook',
        source: 'openclaw-managed',
      },
      {
        name: 'target-hook',
        hookKey: 'plugin-hook',
        managedByPlugin: true,
      },
    ],
  ],
])('prefers hookKey when resolving a mutation: %s', async (_case, hooks) => {
  const setEnabled = vi.fn();
  registerHookHandlers({
    getStore: () =>
      ({
        getHook: vi.fn().mockReturnValue({ id: 'target-hook', enabled: true }),
        setEnabled,
      }) as unknown as OpenClawHookStore,
    requestGateway: vi.fn().mockResolvedValue({ ...hookReport, hooks }),
    syncConfig: vi.fn().mockResolvedValue({ hooks: 1 }),
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, { id: 'target-hook', enabled: false }),
  ).resolves.toMatchObject({ success: true });
  expect(setEnabled).toHaveBeenCalledWith('target-hook', false);
});

test('falls back to name only for legacy hook entries without hookKey', async () => {
  const setEnabled = vi.fn();
  registerHookHandlers({
    getStore: () =>
      ({
        getHook: vi.fn().mockReturnValue({ id: 'legacy-hook', enabled: true }),
        setEnabled,
      }) as unknown as OpenClawHookStore,
    requestGateway: vi.fn().mockResolvedValue({
      ...hookReport,
      hooks: [{ name: 'legacy-hook', source: 'openclaw-managed' }],
    }),
    syncConfig: vi.fn().mockResolvedValue({ hooks: 1 }),
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get(HookIpc.SetEnabled)?.(undefined, { id: 'legacy-hook', enabled: false }),
  ).resolves.toMatchObject({ success: true });
  expect(setEnabled).toHaveBeenCalledWith('legacy-hook', false);
});

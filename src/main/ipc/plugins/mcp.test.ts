import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, expect, test, vi } from 'vitest';

import {
  MarketplaceInstallOperation,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import { OpenClawConfigSyncService } from '../../openclaw/config/openclawConfigSyncService';
import { PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';
import type { McpServerRecord, McpStore } from '../../plugins/mcp';
import { McpConfigSyncService } from '../../plugins/mcp/mcpConfigSyncService';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerMcpHandlers } from './mcp';

const createStore = () => ({
  listServers: vi.fn(() => [
    {
      id: 'installed-record',
      name: 'Installed MCP',
      registryId: 'catalog-mcp',
    },
  ]),
  updateServer: vi.fn((id: string) => ({ id })),
  createServer: vi.fn(() => ({ id: 'created-record' })),
  getServer: vi.fn((id: string) => ({ id })),
  restoreServer: vi.fn(),
  deleteServer: vi.fn(() => true),
  setEnabled: vi.fn(() => true),
});

const register = (
  store: ReturnType<typeof createStore>,
  listExtensionServers = vi.fn(async () => []),
  discoverExternalServers = vi.fn(),
) => {
  const installationService = new PluginInstallationService();
  registerMcpHandlers({
    getStore: () => store as unknown as McpStore,
    runConfigMutationExclusive: operation => operation(vi.fn(async () => ({ tools: 0 }))),
    probeServer: vi.fn(),
    readResource: vi.fn(),
    installationService,
    listExtensionServers,
    discoverExternalServers,
  });
  return installationService;
};

test('lists user-configured MCP servers without waiting for extension discovery', async () => {
  const store = createStore();
  const listExtensionServers = vi.fn(() => new Promise<never>(() => undefined));
  register(store, listExtensionServers);

  await expect(handlers.get('mcp:list')?.()).resolves.toMatchObject({
    success: true,
    servers: store.listServers(),
  });
  expect(listExtensionServers).not.toHaveBeenCalled();
});

test('discovers OpenClaw-managed MCP servers before returning the list', async () => {
  const store = createStore();
  const discoverExternalServers = vi.fn();
  register(store, vi.fn(async () => []), discoverExternalServers);

  await expect(handlers.get('mcp:list')?.()).resolves.toMatchObject({
    success: true,
    servers: store.listServers(),
  });
  expect(discoverExternalServers).toHaveBeenCalledOnce();
});

test('keeps stored MCP servers visible when external discovery fails', async () => {
  const store = createStore();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  register(store, vi.fn(async () => []), () => {
    throw new Error('invalid native config');
  });

  await expect(handlers.get('mcp:list')?.()).resolves.toMatchObject({
    success: true,
    servers: store.listServers(),
  });
  expect(warn).toHaveBeenCalledWith(
    '[OpenClawMcp] Failed to discover externally installed MCP servers:',
    'invalid native config',
  );
});

test('lists extension-provided MCP servers through a separate handler', async () => {
  const store = createStore();
  const extensionServers = [
    {
      id: 'extension:calendar:calendar',
      name: 'calendar',
      providerId: 'calendar',
      providerName: 'Calendar',
      providerDescription: '',
      enabled: true,
      supported: true,
      scope: 'personal' as const,
    },
  ];
  register(store, vi.fn(async () => extensionServers));

  await expect(handlers.get('mcp:listExtensionServers')?.()).resolves.toMatchObject({
    success: true,
    extensionServers,
  });
  await expect(handlers.get('mcp:listExtensionServers')?.()).resolves.toMatchObject({
    extensionServers: [{ scope: 'personal', management: { disable: { allowed: false, reason: 'managed-by-extension' } } }],
  });
});

test('keeps extension discovery failure isolated from the user-configured list', async () => {
  const store = createStore();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  register(store, vi.fn(async () => Promise.reject(new Error('discovery failed'))));

  await expect(handlers.get('mcp:listExtensionServers')?.()).resolves.toEqual({
    success: false,
    extensionServers: [],
  });
  await expect(handlers.get('mcp:list')?.()).resolves.toMatchObject({
    success: true,
    servers: store.listServers(),
  });
  expect(warn).toHaveBeenCalledWith(
    '[OpenClawMcp] Failed to discover extension-provided MCP servers:',
    'discovery failed',
  );
});

beforeEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
});

test('marketplace MCP update ignores a provider-supplied local target id', async () => {
  const store = createStore();
  const installationService = register(store);

  const result = await installationService.install({
    operation: MarketplaceInstallOperation.UPDATE,
    origin: PluginInstallOrigin.MARKETPLACE,
    marketplacePluginId: 'catalog-mcp',
    payload: {
      kind: PluginKind.MCP,
      targetId: 'unrelated-local-record',
      config: { name: 'Updated MCP', registryId: 'spoofed-catalog-id' },
    },
  });

  expect(result).toEqual({ success: true, pluginId: 'installed-record' });
  expect(store.updateServer).toHaveBeenCalledWith('installed-record', {
    name: 'Updated MCP',
    registryId: 'catalog-mcp',
  });
});

test('marketplace MCP install rejects an existing catalog id', async () => {
  const store = createStore();
  const installationService = register(store);

  const result = await installationService.install({
    operation: MarketplaceInstallOperation.INSTALL,
    origin: PluginInstallOrigin.MARKETPLACE,
    marketplacePluginId: 'catalog-mcp',
    payload: {
      kind: PluginKind.MCP,
      config: { name: 'Duplicate MCP', transportType: 'stdio', command: 'npx' },
    },
  });

  expect(result).toEqual({ success: false, error: 'MCP server is already installed' });
  expect(store.createServer).not.toHaveBeenCalled();
});

test('custom MCP install rejects an invalid per-server request timeout', async () => {
  const store = createStore();
  register(store);

  const result = await handlers.get('mcp:create')?.(
    {},
    {
      name: 'Docs MCP',
      transportType: 'stdio',
      command: 'npx',
      requestTimeoutSeconds: 86_401,
    },
  );

  expect(result).toEqual({
    success: false,
    error: 'MCP request timeout must be an integer between 1 and 86400 seconds.',
  });
  expect(store.createServer).not.toHaveBeenCalled();
});

test('does not report success when an MCP mutation target is missing', async () => {
  const store = createStore();
  store.deleteServer.mockReturnValue(false);
  store.setEnabled.mockReturnValue(false);
  register(store);

  await expect(handlers.get('mcp:delete')?.(undefined, 'missing')).resolves.toEqual({
    success: false,
    error: 'MCP server was not found',
  });
  await expect(
    handlers.get('mcp:setEnabled')?.(undefined, { id: 'missing', enabled: true }),
  ).resolves.toEqual({ success: false, error: 'MCP server was not found' });
});

const createMutationHarness = (
  runExclusive?: Parameters<typeof registerMcpHandlers>[0]['runConfigMutationExclusive'],
) => {
  const original: McpServerRecord = {
    id: 'server',
    name: 'Docs',
    description: 'Original',
    enabled: true,
    transportType: 'http',
    url: 'https://example.com/mcp',
    isBuiltIn: false,
    headers: { 'X-Demo': 'original' },
    openClawConfig: { oauth: { identity: 'per-requester' } },
    createdAt: 10,
    updatedAt: 20,
  };
  const records = new Map([[original.id, original]]);
  const store = {
    listServers: vi.fn(() => [...records.values()]),
    getServer: vi.fn((id: string) => records.get(id) ?? null),
    createServer: vi.fn((data: Partial<McpServerRecord>) => {
      const record = { ...original, ...data, id: 'created' };
      records.set(record.id, record);
      return record;
    }),
    updateServer: vi.fn((id: string, data: Partial<McpServerRecord>) => {
      const previous = records.get(id);
      if (!previous) return null;
      const updated = { ...previous, ...data, updatedAt: 30 };
      records.set(id, updated);
      return updated;
    }),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      const previous = records.get(id);
      if (!previous) return false;
      records.set(id, { ...previous, enabled, updatedAt: 30 });
      return true;
    }),
    deleteServer: vi.fn((id: string) => records.delete(id)),
    restoreServer: vi.fn((record: McpServerRecord) => records.set(record.id, record)),
  };
  const syncConfig = vi.fn(async () => ({ tools: 1 }) as { tools: number; error?: string });
  const discoverExternalServers = vi.fn();
  const onMarketplacePluginDeleted = vi.fn();
  const installationService = new PluginInstallationService();
  registerMcpHandlers({
    getStore: () => store as unknown as McpStore,
    runConfigMutationExclusive: runExclusive ?? (operation => operation(syncConfig)),
    probeServer: vi.fn(),
    readResource: vi.fn(),
    installationService,
    listExtensionServers: vi.fn(async () => []),
    discoverExternalServers,
    onMarketplacePluginDeleted,
  });
  return {
    original,
    records,
    store,
    syncConfig,
    discoverExternalServers,
    onMarketplacePluginDeleted,
    installationService,
  };
};

test.each(['create', 'update', 'delete', 'setEnabled'])(
  'waits for runtime application before reporting MCP %s success',
  async operation => {
    const harness = createMutationHarness();
    let release!: (result: { tools: number }) => void;
    harness.syncConfig.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    let finished = false;
    const args =
      operation === 'create'
        ? [{ name: 'New', transportType: 'http', url: 'https://example.com/new' }]
        : operation === 'update'
          ? ['server', { name: 'Renamed' }]
          : operation === 'delete'
            ? ['server']
            : [{ id: 'server', enabled: false }];
    const mutation = Promise.resolve(handlers.get(`mcp:${operation}`)!(undefined, ...args)).then(
      result => {
        finished = true;
        return result;
      },
    );
    await vi.waitFor(() => expect(harness.syncConfig).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    const listing = handlers.get('mcp:list')!();
    await Promise.resolve();
    expect(harness.discoverExternalServers).not.toHaveBeenCalled();
    expect(harness.onMarketplacePluginDeleted).not.toHaveBeenCalled();

    release({ tools: 1 });
    await expect(mutation).resolves.toMatchObject({ success: true });
    await expect(listing).resolves.toMatchObject({ success: true });
    expect(harness.discoverExternalServers).toHaveBeenCalledOnce();
    if (operation === 'delete') {
      expect(harness.onMarketplacePluginDeleted).toHaveBeenCalledWith(PluginKind.MCP, 'server');
    }
  },
);

test.each(['create', 'update', 'delete', 'setEnabled'])(
  'restores MCP records when applying %s returns a sync error',
  async operation => {
    const harness = createMutationHarness();
    harness.syncConfig.mockResolvedValueOnce({ tools: 0, error: 'application failed' });
    const args =
      operation === 'create'
        ? [{ name: 'New', transportType: 'http', url: 'https://example.com/new' }]
        : operation === 'update'
          ? ['server', { name: 'Renamed', headers: {} }]
          : operation === 'delete'
            ? ['server']
            : [{ id: 'server', enabled: false }];

    await expect(handlers.get(`mcp:${operation}`)!(undefined, ...args)).resolves.toMatchObject({
      success: false,
      error: 'application failed',
    });
    expect([...harness.records.values()]).toEqual([harness.original]);
    expect(harness.syncConfig).toHaveBeenCalledTimes(2);
    expect(harness.onMarketplacePluginDeleted).not.toHaveBeenCalled();
  },
);

test('restores MCP state when the sync throws and reports an incomplete recovery', async () => {
  const harness = createMutationHarness();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  harness.syncConfig
    .mockRejectedValueOnce(new Error('application failed'))
    .mockResolvedValueOnce({ tools: 0, error: 'recovery failed' });

  await expect(
    handlers.get('mcp:setEnabled')!(undefined, { id: 'server', enabled: false }),
  ).resolves.toMatchObject({
    success: false,
    error: 'application failed Rollback incomplete: recovery failed',
  });
  expect(harness.records.get('server')).toEqual(harness.original);
});

test('serializes rapid MCP toggles and manual syncs without dropping the later state', async () => {
  const harness = createMutationHarness();
  let release!: (result: { tools: number }) => void;
  harness.syncConfig.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const disabling = handlers.get('mcp:setEnabled')!(undefined, { id: 'server', enabled: false });
  const enabling = handlers.get('mcp:setEnabled')!(undefined, { id: 'server', enabled: true });
  const manualSync = handlers.get('mcp:syncConfig')!();
  await vi.waitFor(() => expect(harness.syncConfig).toHaveBeenCalledOnce());
  expect(harness.store.setEnabled).toHaveBeenCalledTimes(1);

  release({ tools: 0 });
  await Promise.all([disabling, enabling, manualSync]);
  expect(harness.records.get('server')?.enabled).toBe(true);
  expect(harness.syncConfig).toHaveBeenCalledTimes(3);
});

test('reports a failed manual MCP sync instead of success with an error', async () => {
  const harness = createMutationHarness();
  harness.syncConfig.mockResolvedValueOnce({ tools: 0, error: 'application failed' });
  await expect(handlers.get('mcp:syncConfig')!()).resolves.toEqual({
    success: false,
    tools: 0,
    error: 'application failed',
  });
});

test('the shared MCP installer waits for synchronization too', async () => {
  const harness = createMutationHarness();
  await expect(
    harness.installationService.install({
      operation: MarketplaceInstallOperation.INSTALL,
      origin: PluginInstallOrigin.MARKETPLACE,
      marketplacePluginId: 'catalog-new',
      payload: {
        kind: PluginKind.MCP,
        config: { name: 'New', transportType: 'http', url: 'https://example.com/new' },
      },
    }),
  ).resolves.toMatchObject({ success: true, pluginId: 'created' });
  expect(harness.syncConfig).toHaveBeenCalledOnce();
});

test.each(['delete', 'update'])(
  'does not resurrect an MCP server during %s behind an already queued settings sync',
  async operation => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mcp-config-race-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { servers: { Docs: { url: 'https://example.com/mcp' } } } }),
    );
    let globalSync!: OpenClawConfigSyncService;
    let mcpSync!: McpConfigSyncService;
    const harness = createMutationHarness(mutate =>
      globalSync.runConfigMutationExclusive(({ syncConfig }) =>
        mutate(() => mcpSync.syncConfigAfterExclusiveMutation(syncConfig)),
      ),
    );
    const discoveryStore = {
      ...harness.store,
      getEnabledServers: () => harness.store.listServers().filter(server => server.enabled),
      createDiscoveredServer: vi.fn((record: McpServerRecord) => {
        harness.records.set('rediscovered', { ...record, id: 'rediscovered' });
        return true;
      }),
    };
    globalSync = new OpenClawConfigSyncService({
      getCoworkStore: () => ({ getConfig: () => ({ executionMode: 'local' }) }),
      getMcpStore: () => discoveryStore,
      getOpenClawEngineManager: () => ({
        getStatus: () => ({ phase: 'ready' }),
        getConfigPath: () => configPath,
        getGatewayConfigReloadGeneration: () => 0,
        getGatewayLaunchEnvVars: () => ({}),
        setGatewayLaunchEnvVars: vi.fn(),
      }),
    } as never);
    Object.assign(globalSync, {
      configSync: {
        collectGatewayLaunchEnvVars: () => ({}),
        sync: () => {
          fs.writeFileSync(
            configPath,
            JSON.stringify({
              mcp: {
                servers: Object.fromEntries(
                  harness.store
                    .listServers()
                    .map(server => [server.name, { url: server.url, enabled: server.enabled }]),
                ),
              },
            }),
          );
          return { ok: true, changed: true, configChanged: true, configPath };
        },
      },
    });
    mcpSync = new McpConfigSyncService({
      getMcpStore: () => discoveryStore as unknown as McpStore,
      syncOpenClawConfig: options => globalSync.syncConfig(options),
    });
    let release!: () => void;
    const earlierMutation = globalSync.runConfigMutationExclusive(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const settingsSync = globalSync.syncConfig({ reason: 'settings-change' });
      const args = operation === 'delete' ? ['server'] : ['server', { name: 'Renamed' }];
      const mutation = handlers.get(`mcp:${operation}`)!(undefined, ...args);
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.records.get('server')).toEqual(harness.original);
      release();
      await earlierMutation;
      await expect(settingsSync).resolves.toMatchObject({ success: true });
      await expect(mutation).resolves.toMatchObject({ success: true });
      await globalSync.syncConfig({ reason: 'subsequent-settings-change' });
      expect(discoveryStore.createDiscoveredServer).not.toHaveBeenCalled();
      expect(harness.store.listServers().map(server => server.name)).toEqual(
        operation === 'delete' ? [] : ['Renamed'],
      );
      expect(Object.keys(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcp.servers)).toEqual(
        operation === 'delete' ? [] : ['Renamed'],
      );
    } finally {
      release?.();
      await earlierMutation;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

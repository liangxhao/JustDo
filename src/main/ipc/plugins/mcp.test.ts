import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, expect, test, vi } from 'vitest';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { MCP_TRANSFER_MAX_BYTES, McpTransferIpc } from '../../../shared/plugins/mcpTransfer';
import { PluginOperationIpc, PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { OpenClawConfigSyncService } from '../../openclaw/config/openclawConfigSyncService';
import { mergeNativeMcpOverrides } from '../../openclaw/config/plugins/nativeMcpOverrides';
import { PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';
import type { McpServerRecord, McpStore } from '../../plugins/mcp';
import { syncMcpConfigAfterMutation } from '../../plugins/mcp/mcpConfigSyncService';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const fileDialogs = vi.hoisted(() => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: fileDialogs,
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
    requestGateway: vi.fn(),
    readExtensionDefinition: vi.fn(async () => null),
    getManagedPluginIds: () => [],
    runConfigMutationExclusive: operation => operation(vi.fn(async () => ({ tools: 0 }))),
    probeServer: vi.fn(),
    readResource: vi.fn(),
    installationService,
    listExtensionServers,
    discoverExternalServers,
  });
  return installationService;
};

test('exposes extension parameter reads and native switches without an arbitrary parameter write endpoint', () => {
  handlers.clear();
  register(createStore());
  expect(handlers.has('mcp:extension:readSettings')).toBe(true);
  expect(handlers.has('mcp:extension:setEnabled')).toBe(true);
  expect(handlers.has('mcp:extension:saveSettings')).toBe(false);
});

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
  register(
    store,
    vi.fn(async () => []),
    discoverExternalServers,
  );

  await expect(handlers.get('mcp:list')?.()).resolves.toMatchObject({
    success: true,
    servers: store.listServers(),
  });
  expect(discoverExternalServers).toHaveBeenCalledOnce();
});

test('keeps stored MCP servers visible when external discovery fails', async () => {
  const store = createStore();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  register(
    store,
    vi.fn(async () => []),
    () => {
      throw new Error('invalid native config');
    },
  );

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
  register(
    store,
    vi.fn(async () => extensionServers),
  );

  await expect(handlers.get('mcp:listExtensionServers')?.()).resolves.toMatchObject({
    success: true,
    extensionServers,
  });
  await expect(handlers.get('mcp:listExtensionServers')?.()).resolves.toMatchObject({
    extensionServers: [
      {
        scope: 'personal',
        management: { disable: { allowed: false, reason: 'managed-by-extension' } },
      },
    ],
  });
});

test('keeps extension discovery failure isolated from the user-configured list', async () => {
  const store = createStore();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  register(
    store,
    vi.fn(async () => Promise.reject(new Error('discovery failed'))),
  );

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

  expect(result).toEqual({
    success: false,
    error: 'MCP server is already installed',
    publicReason: 'MCP server is already installed',
    failedStage: PluginOperationStage.VALIDATING,
  });
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
    failedStage: PluginOperationStage.VALIDATING,
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
    failedStage: PluginOperationStage.UNINSTALLING,
  });
  await expect(
    handlers.get('mcp:setEnabled')?.(undefined, { id: 'missing', enabled: true }),
  ).resolves.toEqual({
    success: false,
    error: 'MCP server was not found',
    failedStage: PluginOperationStage.SAVING_CONFIGURATION,
  });
});

const createMutationHarness = (
  runExclusive?: Parameters<typeof registerMcpHandlers>[0]['runConfigMutationExclusive'],
  nativeNames: { extension?: readonly string[]; configured?: readonly string[] } = {},
  getMainWindow?: Parameters<typeof registerMcpHandlers>[0]['getMainWindow'],
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
    createDisabledServers: vi.fn((entries: Partial<McpServerRecord>[]) =>
      entries.map((entry, index) => {
        const id = `imported-${index}`;
        records.set(id, { ...original, ...entry, id, enabled: false, openClawConfig: undefined });
        return id;
      }),
    ),
    deleteServers: vi.fn((ids: string[]) => {
      for (const id of ids) records.delete(id);
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
  const configQueue = new OpenClawConfigSyncService({} as never);
  const discoverExternalServers = vi.fn();
  const onMarketplacePluginDeleted = vi.fn();
  const installationService = new PluginInstallationService();
  registerMcpHandlers({
    getStore: () => store as unknown as McpStore,
    getMainWindow,
    requestGateway: vi.fn(),
    readExtensionDefinition: vi.fn(async () => null),
    getManagedPluginIds: () => [],
    runConfigMutationExclusive: runExclusive ?? (operation =>
      configQueue.runConfigMutationExclusive(() => operation(syncConfig))),
    probeServer: vi.fn(),
    readResource: vi.fn(),
    installationService,
    listExtensionServers: vi.fn(async () =>
      (nativeNames.extension ?? []).map(name => ({
        id: `extension:provider:${name}`,
        name,
        providerId: 'provider',
        providerName: 'Provider',
        providerDescription: '',
        enabled: true,
        supported: true,
      })),
    ),
    getNativeMcpServerNames: () => new Set(nativeNames.configured),
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

const createTransferWindow = () => {
  const frame = {};
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
  };
  const window = {
    webContents: sender,
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
  return { window, event: { sender, senderFrame: frame }, sender };
};

test('requires the current main frame and commits one reviewed batch with correlation', async () => {
  const { window, event, sender } = createTransferWindow();
  const native = { configured: ['native-claimed'], extension: ['extension-claimed'] };
  const harness = createMutationHarness(undefined, native, () => window);
  const preview = handlers.get(McpTransferIpc.PreviewImport)!;
  const commit = handlers.get(McpTransferIpc.CommitImport)!;
  const source = { kind: 'text', text: JSON.stringify({ mcpServers: {
    'native-claimed': { command: 'node' },
    'extension-claimed': { command: 'node' },
    Docs: { command: 'node' },
    Local: { command: 'node', env: { API_TOKEN: 'private-token' } },
    Remote: { url: 'http://localhost:7000/mcp' },
  } }) };

  await expect(preview({ sender, senderFrame: {} }, source)).resolves.toEqual({
    success: false,
    code: 'forbidden',
  });
  const prepared = await preview(event, source);
  expect(prepared).toMatchObject({
    success: true,
    value: { rows: [
      { conflict: true }, { conflict: true }, { conflict: true }, { name: 'Local' }, { name: 'Remote' },
    ] },
  });
  expect(JSON.stringify(prepared)).not.toContain('private-token');
  expect(harness.store.createDisabledServers).not.toHaveBeenCalled();
  expect(harness.syncConfig).not.toHaveBeenCalled();
  expect(harness.discoverExternalServers).not.toHaveBeenCalled();

  const token = (prepared as { value: { token: string } }).value.token;
  const selection = [{ index: 3, name: 'Local copy' }, { index: 4, transportType: 'sse' }];
  native.configured.push('Local copy');
  await expect(commit(event, { token, selection })).resolves.toMatchObject({
    success: false,
    code: 'conflict',
    conflictingIndices: [3],
  });
  expect(harness.store.createDisabledServers).not.toHaveBeenCalled();
  const input = { token, selection: [{ index: 3 }, selection[1]] };
  await expect(commit(event, input, { requestId: 'mcp-import-batch' })).resolves.toMatchObject({
    success: true,
    value: { skipped: 3, imported: [{ name: 'Local' }, { name: 'Remote' }] },
  });
  expect(harness.records.get('imported-0')).toMatchObject({ enabled: false });
  expect(harness.records.get('imported-1')).toMatchObject({ enabled: false, transportType: 'sse' });
  expect(harness.store.createDisabledServers).toHaveBeenCalledOnce();
  expect(harness.syncConfig).toHaveBeenCalledExactlyOnceWith(
    [],
    { requestId: 'mcp-import-batch' },
    ['native-claimed', 'Local copy'],
  );
  await expect(commit(event, input)).resolves.toMatchObject({ success: false, code: 'expired' });
});

test('removes the entire imported batch after an apply error and compensates once', async () => {
  const { window, event } = createTransferWindow();
  const harness = createMutationHarness(undefined, { configured: ['external'] }, () => window);
  const prepared = await handlers.get(McpTransferIpc.PreviewImport)!(event, {
    kind: 'text',
    text: '{"mcpServers":{"First":{"command":"node"},"Second":{"command":"node"}}}',
  });
  const token = (prepared as { value: { token: string } }).value.token;
  harness.syncConfig.mockResolvedValueOnce({ tools: 0, error: 'Native apply failed' });

  await expect(handlers.get(McpTransferIpc.CommitImport)!(event, {
    token,
    selection: [{ index: 0 }, { index: 1 }],
  })).resolves.toMatchObject({
    success: false,
    code: 'apply-failed',
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
  });
  expect([...harness.records.values()]).toEqual([harness.original]);
  expect(harness.store.deleteServers).toHaveBeenCalledExactlyOnceWith(['imported-0', 'imported-1']);
  expect(harness.syncConfig.mock.calls).toEqual([
    [[], undefined, ['external']],
    [['First', 'Second'], undefined, ['external']],
  ]);
});

test('previews only the native dialog selection and enforces the import byte limit', async () => {
  const { window, event } = createTransferWindow();
  const harness = createMutationHarness(undefined, {}, () => window);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-'));
  const filePath = path.join(folder, 'MCP 配置.json');
  const preview = handlers.get(McpTransferIpc.PreviewImport)!;
  try {
    fs.writeFileSync(filePath, Buffer.alloc(MCP_TRANSFER_MAX_BYTES + 1));
    fileDialogs.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
    await expect(preview(event, { kind: 'file' })).resolves.toEqual({
      success: false,
      code: 'too-large',
    });
    fs.writeFileSync(filePath, '{"mcpServers":{"本地":{"command":"node"}}}');
    fileDialogs.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
    await expect(preview(event, { kind: 'file', path: 'ignored.json' })).resolves.toMatchObject({
      success: true,
      value: { sourceLabel: 'MCP 配置.json', rows: [{ name: '本地' }] },
    });
    expect(fileDialogs.showOpenDialog).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ properties: ['openFile'] }),
    );
    expect(harness.store.createDisabledServers).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('masks opted-in header values in the preview and saves the reviewed snapshot', async () => {
  const { window, event } = createTransferWindow();
  const harness = createMutationHarness(undefined, {}, () => window);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-export-'));
  const filePath = path.join(folder, 'mcp.json');
  harness.records.set(harness.original.id, { ...harness.original, openClawConfig: undefined });
  try {
    const preview = handlers.get(McpTransferIpc.PreviewExport)!;
    const ids = [harness.original.id];
    const defaults = await preview(event, { ids });
    const defaultJson = (defaults as { value: { json: string } }).value.json;
    expect(JSON.parse(defaultJson).mcpServers.Docs.headers).toEqual({ 'X-Demo': '' });
    await expect(preview(event, { ids, includeHeaderValues: 'true' })).resolves.toEqual({
      success: false,
      code: 'invalid',
    });
    const prepared = await preview(event, { ids, includeHeaderValues: true });
    const { json, token } = (prepared as { value: { json: string; token: string } }).value;
    expect(JSON.parse(json).mcpServers.Docs.headers).toEqual({ 'X-Demo': '••••' });
    harness.records.delete(harness.original.id);
    fileDialogs.showSaveDialog
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false, filePath });
    const save = handlers.get(McpTransferIpc.SaveExport)!;
    await expect(save(event, token)).resolves.toEqual({ success: false, code: 'cancelled' });
    await expect(save(event, token)).resolves.toEqual({ success: true, value: { filePath, count: 1 } });
    expect(fileDialogs.showSaveDialog).toHaveBeenLastCalledWith(window, expect.objectContaining({
      defaultPath: 'mcp.json',
    }));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      mcpServers: { Docs: { ...JSON.parse(json).mcpServers.Docs, headers: { 'X-Demo': 'original' } } },
    });
    expect(harness.discoverExternalServers).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('reports real queued and runtime-application phases without completing the waiting mutation', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const harness = createMutationHarness();
  let release!: (result: { tools: number }) => void;
  harness.syncConfig.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const sender = { isDestroyed: () => false, send: vi.fn() };
  const first = handlers.get('mcp:setEnabled')!(
    { sender },
    { id: 'server', enabled: false },
    { requestId: 'mcp-disable' },
  );
  const second = handlers.get('mcp:setEnabled')!(
    { sender },
    { id: 'server', enabled: true },
    { requestId: 'mcp-enable' },
  );
  await vi.waitFor(() => expect(harness.syncConfig).toHaveBeenCalledOnce());
  const phases = (requestId: string) =>
    sender.send.mock.calls
      .filter(
        ([channel, progress]) =>
          channel === PluginOperationIpc.Progress && progress.requestId === requestId,
      )
      .map(([, progress]) => progress.stage);
  expect(phases('mcp-disable').at(-1)).toBe(PluginOperationStage.APPLYING_CONFIGURATION);
  expect(phases('mcp-enable')).toEqual([PluginOperationStage.QUEUED]);
  expect(harness.store.setEnabled).toHaveBeenCalledTimes(1);
  release({ tools: 1 });
  await Promise.all([first, second]);
  expect(phases('mcp-enable').at(-1)).toBe(PluginOperationStage.REFRESHING_INVENTORY);
  expect(harness.records.get('server')?.enabled).toBe(true);
});

test('invalid progress context cannot mutate MCP configuration', () => {
  const harness = createMutationHarness();
  expect(() =>
    handlers.get('mcp:setEnabled')!(
      undefined,
      { id: 'server', enabled: false },
      { requestId: '\nbad' },
    ),
  ).toThrow('Invalid plugin operation request id');
  expect(harness.store.setEnabled).not.toHaveBeenCalled();
  expect(harness.syncConfig).not.toHaveBeenCalled();
});

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
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
  });
});

test('correlates explicit MCP sync and rollback broadcasts with the invoking operation', async () => {
  const harness = createMutationHarness();
  const context = { requestId: 'mcp-save-request' };
  harness.syncConfig.mockResolvedValueOnce({ tools: 0, error: 'apply failed' });
  await expect(
    handlers.get('mcp:setEnabled')!({}, { id: 'server', enabled: false }, context),
  ).resolves.toMatchObject({
    success: false,
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
  });
  expect(harness.syncConfig).toHaveBeenNthCalledWith(1, [], context);
  expect(harness.syncConfig).toHaveBeenNthCalledWith(2, [], context);
});

test('passes an installation operation context into the MCP config synchronization', async () => {
  const harness = createMutationHarness();
  const context = { requestId: 'mcp-install-request' };
  await expect(
    handlers.get('mcp:create')!(
      {},
      { name: 'Created', transportType: 'stdio', command: 'node' },
      context,
    ),
  ).resolves.toMatchObject({ success: true });
  expect(harness.syncConfig).toHaveBeenCalledWith([], context);
});

test.each(['create', 'update', 'delete', 'setEnabled'])(
  'keeps completed MCP %s committed when only its final inventory read fails',
  async action => {
    const harness = createMutationHarness();
    harness.syncConfig.mockImplementationOnce(async () => {
      harness.store.listServers.mockImplementation(() => {
        throw new Error('inventory unavailable');
      });
      return { tools: 1 };
    });
    const args =
      action === 'create'
        ? [{ name: 'Created', transportType: 'stdio', command: 'node' }]
        : action === 'update'
          ? ['server', { name: 'Docs' }]
          : action === 'delete'
            ? ['server']
            : [{ id: 'server', enabled: false }];
    const result = await handlers.get(`mcp:${action}`)!({}, ...args);
    expect(result).toEqual({ success: true, refreshWarning: true });
    expect(result).not.toHaveProperty('servers');
    expect(harness.syncConfig).toHaveBeenCalledOnce();
  },
);

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
  'removes a retired product connection sharing an extension name during %s behind a queued sync',
  async operation => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mcp-config-race-'));
    const configPath = path.join(directory, 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { servers: { Docs: { url: 'https://example.com/mcp' } } } }),
    );
    let globalSync!: OpenClawConfigSyncService;
    const harness = createMutationHarness(mutate =>
      globalSync.runConfigMutationExclusive(({ syncConfig }) =>
        mutate(retiredMcpServerNames =>
          syncMcpConfigAfterMutation(
            options => syncConfig({ ...options, retiredMcpServerNames }),
            () => discoveryStore.getEnabledServers().length,
          ),
        ),
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
      getExtensionMcpServerNames: async () => new Set(['Docs']),
      getOpenClawEngineManager: () => ({
        getStatus: () => ({ phase: 'ready' }),
        getConfigPath: () => configPath,
        getGatewayProcessGeneration: () => 0,
        getGatewayLifecycleGeneration: () => 0,
        getGatewayConfigReloadGeneration: () => 0,
        getGatewayLaunchEnvVars: () => ({}),
        setGatewayLaunchEnvVars: vi.fn(),
      }),
    } as never);
    Object.assign(globalSync, {
      configSync: {
        collectGatewayLaunchEnvVars: () => ({}),
        sync: (
          _reason: string,
          extensionNames: ReadonlySet<string>,
          retiredNames: ReadonlySet<string>,
        ) => {
          const previous = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          fs.writeFileSync(
            configPath,
            JSON.stringify({
              mcp: {
                servers: mergeNativeMcpOverrides(
                  previous,
                  Object.fromEntries(
                    harness.store
                      .listServers()
                      .map(server => [server.name, { url: server.url, enabled: server.enabled }]),
                  ),
                  extensionNames,
                  retiredNames,
                ),
              },
            }),
          );
          return { ok: true, changed: true, configChanged: true, configPath };
        },
      },
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

test.each(['create', 'update'])(
  'retires colliding native connections introduced by a failed %s before rollback',
  async operation => {
    let native = { mcp: { servers: { Docs: { url: 'https://example.com/mcp', enabled: true } } } };
    let syncCount = 0;
    const harness = createMutationHarness(mutate =>
      mutate(async retiredNames => {
        native = {
          mcp: {
            servers: mergeNativeMcpOverrides(
              native,
              Object.fromEntries(
                harness.store.listServers().map(server => [
                  server.name,
                  {
                    url: server.url,
                    enabled: server.enabled,
                  },
                ]),
              ),
              new Set(['Docs', 'Attempted']),
              new Set(retiredNames),
            ) as typeof native.mcp.servers,
          },
        };
        syncCount += 1;
        return syncCount === 1 ? { tools: 0, error: 'application unconfirmed' } : { tools: 1 };
      }),
    );
    const config = {
      name: 'Attempted',
      transportType: 'http',
      url: 'https://example.com/attempted',
    };
    const args = operation === 'create' ? [config] : ['server', config];
    await expect(handlers.get(`mcp:${operation}`)!(undefined, ...args)).resolves.toMatchObject({
      success: false,
    });
    expect(syncCount).toBe(2);
    expect(harness.records.get('server')).toEqual(harness.original);
    expect(native.mcp.servers).toEqual({ Docs: { url: harness.original.url, enabled: true } });
  },
);

test.each([
  ['create', { extension: ['Reserved'] }],
  ['update', { extension: ['Reserved'] }],
  ['create', { configured: ['Reserved'] }],
  ['update', { configured: ['Reserved'] }],
] as const)('rejects %s before modifying a native-owned name', async (operation, names) => {
  const harness = createMutationHarness(undefined, names);
  const config = { name: ' Reserved ', transportType: 'http', url: 'https://example.com/new' };
  const args = operation === 'create' ? [config] : ['server', config];
  await expect(handlers.get(`mcp:${operation}`)!(undefined, ...args)).resolves.toMatchObject({
    success: false,
    error: 'mcpNameExists',
  });
  expect(harness.store.createServer).not.toHaveBeenCalled();
  expect(harness.store.updateServer).not.toHaveBeenCalled();
  expect(harness.syncConfig).not.toHaveBeenCalled();
  expect(harness.records.get('server')).toEqual(harness.original);
});

import { beforeEach, expect, test, vi } from 'vitest';

import {
  MarketplaceInstallOperation,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import { PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';
import type { McpStore } from '../../plugins/mcp';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
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
  deleteServer: vi.fn(),
  setEnabled: vi.fn(),
});

const register = (
  store: ReturnType<typeof createStore>,
  listExtensionServers = vi.fn(async () => []),
) => {
  const installationService = new PluginInstallationService();
  registerMcpHandlers({
    getStore: () => store as unknown as McpStore,
    syncConfig: vi.fn(async () => ({ tools: 0 })),
    probeServer: vi.fn(),
    readResource: vi.fn(),
    installationService,
    listExtensionServers,
  });
  return installationService;
};

test('lists user-configured MCP servers without waiting for extension discovery', async () => {
  const store = createStore();
  const listExtensionServers = vi.fn(() => new Promise<never>(() => undefined));
  register(store, listExtensionServers);

  expect(handlers.get('mcp:list')?.()).toEqual({
    success: true,
    servers: store.listServers(),
  });
  expect(listExtensionServers).not.toHaveBeenCalled();
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
    },
  ];
  register(store, vi.fn(async () => extensionServers));

  await expect(handlers.get('mcp:listExtensionServers')?.()).resolves.toEqual({
    success: true,
    extensionServers,
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
  expect(handlers.get('mcp:list')?.()).toEqual({
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

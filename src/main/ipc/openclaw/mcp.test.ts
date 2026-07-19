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

const register = (store: ReturnType<typeof createStore>) => {
  const installationService = new PluginInstallationService();
  registerMcpHandlers({
    getStore: () => store as unknown as McpStore,
    syncConfig: vi.fn(async () => ({ tools: 0 })),
    probeServer: vi.fn(),
    readResource: vi.fn(),
    installationService,
  });
  return installationService;
};

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

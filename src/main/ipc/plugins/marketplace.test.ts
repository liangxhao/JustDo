import { beforeEach, expect, test, vi } from 'vitest';

import {
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  MarketplaceIpc,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import type { PluginManager } from '../../plugins';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerMarketplaceHandlers } from './marketplace';

const createPluginManager = () =>
  ({
    listMarketplaceSources: vi.fn(() => []),
    listMarketplaceCategories: vi.fn(async () => ({ categories: [] })),
    searchMarketplace: vi.fn(async () => ({ items: [] })),
    checkMarketplaceUpdates: vi.fn(async () => ({ updates: [] })),
    getMarketplaceDetail: vi.fn(async () => null),
    installFromMarketplace: vi.fn(async () => ({ success: true })),
  }) as unknown as PluginManager;

beforeEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
});

test('rejects malformed marketplace search input before calling the manager', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Search)?.({}, {
    kind: PluginKind.SKILL,
    query: { unexpected: true },
  });

  expect(response).toEqual({
    success: false,
    error: 'Marketplace query must be a string',
    errorCode: MarketplaceErrorCode.INVALID_REQUEST,
  });
  expect(manager.searchMarketplace).not.toHaveBeenCalled();
});

test('does not expose unexpected provider error details to the renderer or logs', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.searchMarketplace).mockRejectedValue(new Error('Bearer private-token'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Search)?.({}, { kind: PluginKind.SKILL });

  expect(response).toEqual({
    success: false,
    error: 'Marketplace request failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
});

test('constructs a narrow validated install request', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  await handlers.get(MarketplaceIpc.Install)?.({}, {
    sourceId: ' enterprise ',
    pluginId: ' writer ',
    kind: PluginKind.SKILL,
    version: ' 1.2.3 ',
    operation: MarketplaceInstallOperation.UPDATE,
    force: true,
    arbitrary: 'ignored',
  });

  expect(manager.installFromMarketplace).toHaveBeenCalledWith({
    sourceId: 'enterprise',
    pluginId: 'writer',
    kind: PluginKind.SKILL,
    version: '1.2.3',
    operation: MarketplaceInstallOperation.UPDATE,
  });
});

test('rejects Hook marketplace requests', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Search)?.({}, { kind: PluginKind.HOOK });

  expect(response).toEqual({
    success: false,
    error: 'Unsupported marketplace plugin kind',
    errorCode: MarketplaceErrorCode.UNSUPPORTED_KIND,
  });
  expect(manager.searchMarketplace).not.toHaveBeenCalled();
});

test('projects successful install results onto the public response contract', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: true,
    pluginId: ' writer-runtime ',
    restartRequired: false,
    installPath: 'C:\\private-download',
    failedStage: 'extracting',
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.({}, {
    sourceId: 'enterprise',
    pluginId: 'writer',
    kind: PluginKind.SKILL,
  });

  expect(response).toEqual({
    success: true,
    pluginId: 'writer-runtime',
    restartRequired: false,
  });
});

test('does not expose internal installation failure details', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    error: 'Cannot rename C:\\private-download\\secret',
    failedStage: 'installing',
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.({}, {
    sourceId: 'enterprise',
    pluginId: 'writer',
    kind: PluginKind.SKILL,
  });

  expect(response).toEqual({
    success: false,
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
  });
  expect(JSON.stringify(response)).not.toContain('private-download');
});

test('constructs narrow category list and filtered search requests', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  await handlers.get(MarketplaceIpc.ListCategories)?.({}, {
    sourceId: ' enterprise ',
    kind: PluginKind.SKILL,
    ignored: true,
  });
  await handlers.get(MarketplaceIpc.Search)?.({}, {
    kind: PluginKind.SKILL,
    categoryId: ' development ',
  });

  expect(manager.listMarketplaceCategories).toHaveBeenCalledWith({
    sourceId: 'enterprise',
    kind: PluginKind.SKILL,
  });
  expect(manager.searchMarketplace).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    categoryId: 'development',
    query: undefined,
    limit: undefined,
    cursor: undefined,
    sourceId: undefined,
  });
});

test('constructs a narrow validated update-check request', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  await handlers.get(MarketplaceIpc.CheckUpdates)?.({}, {
    kind: PluginKind.SKILL,
    installed: [{ id: ' writer ', version: ' 1.2.3 ', ignored: true }],
    ignored: true,
  });

  expect(manager.checkMarketplaceUpdates).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer', version: '1.2.3' }],
  });
});

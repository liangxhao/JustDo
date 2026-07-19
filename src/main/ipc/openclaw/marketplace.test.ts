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
    searchMarketplace: vi.fn(async () => ({ items: [] })),
    getMarketplaceDetail: vi.fn(async () => null),
    installFromMarketplace: vi.fn(async () => undefined),
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

import { expect, test, vi } from 'vitest';

import { type MarketplacePlugin, PluginKind } from '../../../../shared/plugins/marketplace';
import { PluginMarketplaceService } from './pluginMarketplaceService';
import type { PluginMarketplaceProvider } from './types';

const createProvider = (): PluginMarketplaceProvider => ({
  source: {
    id: 'private-clawhub',
    name: 'Private ClawHub',
    supportedKinds: [PluginKind.SKILL],
  },
  search: vi.fn(async () => []),
  getDetail: vi.fn(async () => null),
  install: vi.fn(async () => undefined),
});

test('searches only providers that support the requested plugin kind', async () => {
  const provider = createProvider();
  const service = new PluginMarketplaceService([provider]);

  const result = await service.search({ kind: PluginKind.EXTENSION });

  expect(result).toEqual([]);
  expect(provider.search).not.toHaveBeenCalled();
});

test('normalizes marketplace search options', async () => {
  const provider = createProvider();
  const plugin: MarketplacePlugin = {
    id: 'writer',
    kind: PluginKind.SKILL,
    name: 'Writer',
    description: 'Writes text',
    sourceId: provider.source.id,
  };
  vi.mocked(provider.search).mockResolvedValue([plugin]);
  const service = new PluginMarketplaceService([provider]);

  const result = await service.search({ kind: PluginKind.SKILL, query: ' writer ', limit: 1000 });

  expect(result).toEqual([plugin]);
  expect(provider.search).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    query: 'writer',
    limit: 100,
  });
});

test('routes installation to its marketplace provider', async () => {
  const provider = createProvider();
  const service = new PluginMarketplaceService([provider]);

  await service.install({
    sourceId: provider.source.id,
    pluginId: ' writer ',
    kind: PluginKind.SKILL,
    version: ' 1.2.3 ',
  });

  expect(provider.install).toHaveBeenCalledWith({
    sourceId: provider.source.id,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
    version: '1.2.3',
  });
});

test('rejects details for a plugin kind the provider does not support', async () => {
  const provider = createProvider();
  const service = new PluginMarketplaceService([provider]);

  await expect(
    service.getDetail({
      sourceId: provider.source.id,
      pluginId: 'extension',
      kind: PluginKind.EXTENSION,
    }),
  ).rejects.toThrow('Marketplace source does not support extension');
  expect(provider.getDetail).not.toHaveBeenCalled();
});

import { expect, test, vi } from 'vitest';

import {
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  type MarketplacePlugin,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import { PluginInstallationService } from '../installation';
import { PluginMarketplaceService } from './pluginMarketplaceService';
import { MarketplaceError, type PluginMarketplaceProvider } from './types';

const createProvider = (): PluginMarketplaceProvider => ({
  source: {
    id: 'enterprise-marketplace',
    name: 'Enterprise Marketplace',
    supportedKinds: [PluginKind.SKILL],
  },
  search: vi.fn(async () => ({ items: [] })),
  getDetail: vi.fn(async () => null),
  prepareInstall: vi.fn(async () => ({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer.zip' },
  })),
});

test('searches only providers that support the requested plugin kind', async () => {
  const provider = createProvider();
  const service = new PluginMarketplaceService([provider]);

  const result = await service.search({ kind: PluginKind.EXTENSION });

  expect(result).toEqual({ items: [] });
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
  vi.mocked(provider.search).mockResolvedValue({ items: [plugin], nextCursor: 'next-page' });
  const service = new PluginMarketplaceService([provider]);

  const result = await service.search({ kind: PluginKind.SKILL, query: ' writer ', limit: 1000 });

  expect(result).toEqual({ items: [plugin], nextCursor: 'next-page' });
  expect(provider.search).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    query: 'writer',
    limit: 100,
  });
});

test('routes installation to its marketplace provider', async () => {
  const provider = createProvider();
  const installationService = new PluginInstallationService();
  const install = vi.fn(async () => ({ success: true, pluginId: 'writer' }));
  installationService.registerInstaller({ kind: PluginKind.SKILL, install });
  const service = new PluginMarketplaceService([provider], installationService);

  await service.install({
    sourceId: provider.source.id,
    pluginId: ' writer ',
    kind: PluginKind.SKILL,
    version: ' 1.2.3 ',
  });

  expect(provider.prepareInstall).toHaveBeenCalledWith({
    sourceId: provider.source.id,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
    version: '1.2.3',
    operation: MarketplaceInstallOperation.INSTALL,
  });
  expect(install).toHaveBeenCalledWith({
    operation: MarketplaceInstallOperation.INSTALL,
    origin: 'marketplace',
    marketplacePluginId: 'writer',
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer.zip' },
  });
});

test('cleans up a prepared marketplace payload after installation', async () => {
  const provider = createProvider();
  const cleanup = vi.fn();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer.zip' },
    cleanup,
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async () => ({ success: false, error: 'invalid package' })),
  });
  const service = new PluginMarketplaceService([provider], installationService);

  await service.install({
    sourceId: provider.source.id,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
  });

  expect(cleanup).toHaveBeenCalledOnce();
});

test('does not turn a successful installation into a failure when cleanup fails', async () => {
  const provider = createProvider();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer.zip' },
    cleanup: vi.fn(async () => {
      throw new Error('temporary file is locked');
    }),
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async () => ({ success: true, pluginId: 'writer' })),
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const service = new PluginMarketplaceService([provider], installationService);

  await expect(
    service.install({
      sourceId: provider.source.id,
      pluginId: 'writer',
      kind: PluginKind.SKILL,
    }),
  ).resolves.toEqual({ success: true, pluginId: 'writer' });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('temporary file is locked');
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

test('rejects duplicate marketplace source ids', () => {
  const provider = createProvider();

  expect(() => new PluginMarketplaceService([provider, createProvider()])).toThrow(
    'Duplicate marketplace source',
  );
});

test('binds results to the provider and rejects an unexpected kind', async () => {
  const provider = createProvider();
  vi.mocked(provider.search).mockResolvedValue({
    items: [
      {
        id: 'writer',
        kind: PluginKind.MCP,
        name: 'Writer',
        description: 'Wrong kind',
        sourceId: 'another-source',
      },
    ],
  });
  const service = new PluginMarketplaceService([provider]);

  await expect(service.search({ kind: PluginKind.SKILL })).rejects.toMatchObject({
    code: MarketplaceErrorCode.INVALID_RESPONSE,
  });
});

test('requires a source when paginating across multiple providers', async () => {
  const first = createProvider();
  const second = createProvider();
  second.source.id = 'second-marketplace';
  const service = new PluginMarketplaceService([first, second]);

  await expect(service.search({ kind: PluginKind.SKILL, cursor: 'next-page' })).rejects.toThrow(
    'pagination requires exactly one source',
  );
});

test('replaces unexpected provider errors with a safe marketplace error', async () => {
  const provider = createProvider();
  vi.mocked(provider.search).mockRejectedValue(
    new MarketplaceError(MarketplaceErrorCode.INVALID_REQUEST, 'Bearer private-token'),
  );
  const service = new PluginMarketplaceService([provider]);

  const error = await service.search({ kind: PluginKind.SKILL }).catch(caught => caught);

  expect(error).toBeInstanceOf(MarketplaceError);
  expect(error).toMatchObject({ code: MarketplaceErrorCode.PROVIDER_FAILURE });
  expect(error.message).not.toContain('private-token');
});

test('returns only allowlisted source and plugin fields', async () => {
  const provider = createProvider();
  const sourceWithPrivateData = provider.source as typeof provider.source & { token: string };
  sourceWithPrivateData.token = 'private-source-token';
  const plugin = {
    id: 'writer',
    kind: PluginKind.SKILL,
    name: 'Writer',
    description: 'Writes text',
    sourceId: 'spoofed-source',
    token: 'private-plugin-token',
  } as MarketplacePlugin & { token: string };
  vi.mocked(provider.search).mockResolvedValue({ items: [plugin] });
  const service = new PluginMarketplaceService([provider]);

  const sources = service.listSources();
  const result = await service.search({ kind: PluginKind.SKILL });

  expect(sources[0]).not.toHaveProperty('token');
  expect(result.items[0]).not.toHaveProperty('token');
  expect(result.items[0].sourceId).toBe(provider.source.id);
});

test('returns only allowlisted detail fields', async () => {
  const provider = createProvider();
  vi.mocked(provider.getDetail).mockResolvedValue({
    id: 'writer',
    kind: PluginKind.SKILL,
    name: 'Writer',
    description: 'Writes text',
    sourceId: provider.source.id,
    readme: '# Writer',
    internalUrl: 'https://private.example',
  } as MarketplacePlugin & { readme: string; internalUrl: string });
  const service = new PluginMarketplaceService([provider]);

  const detail = await service.getDetail({
    sourceId: provider.source.id,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
  });

  expect(detail).not.toHaveProperty('internalUrl');
  expect(detail?.readme).toBe('# Writer');
});

test('rejects a non-string provider cursor', async () => {
  const provider = createProvider();
  vi.mocked(provider.search).mockResolvedValue({
    items: [],
    nextCursor: { token: 'private-token' },
  } as unknown as { items: MarketplacePlugin[]; nextCursor: string });
  const service = new PluginMarketplaceService([provider]);

  await expect(service.search({ kind: PluginKind.SKILL })).rejects.toMatchObject({
    code: MarketplaceErrorCode.INVALID_RESPONSE,
  });
});

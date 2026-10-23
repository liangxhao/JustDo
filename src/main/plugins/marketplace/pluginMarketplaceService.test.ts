import { expect, test, vi } from 'vitest';

import {
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  type MarketplacePlugin,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { PluginInstallationService } from '../installation';
import {
  type MarketplaceInstallRecordStore,
  MarketplaceInstallRegistry,
} from './marketplaceInstallRegistry';
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

const createInstallRegistry = () => {
  const values = new Map<string, unknown>();
  const store: MarketplaceInstallRecordStore = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => values.set(key, value),
  };
  return new MarketplaceInstallRegistry(() => store);
};

test('searches only providers that support the requested plugin kind', async () => {
  const provider = createProvider();
  const service = new PluginMarketplaceService([provider]);

  const result = await service.search({ kind: PluginKind.EXTENSION });

  expect(result).toEqual({ items: [] });
  expect(provider.search).not.toHaveBeenCalled();
});

test('rejects Hook as an unsupported marketplace kind', () => {
  const provider = createProvider();
  provider.source.supportedKinds = [PluginKind.HOOK as never];

  expect(() => new PluginMarketplaceService([provider])).toThrow(
    'Marketplace source id is invalid',
  );
});

test('normalizes marketplace search options', async () => {
  const provider = createProvider();
  const plugin: MarketplacePlugin = {
    id: 'writer',
    kind: PluginKind.SKILL,
    name: 'Writer',
    description: 'Writes text',
    runtimeId: 'writer-runtime',
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

test('returns normalized categories from an optional provider catalog', async () => {
  const provider = createProvider();
  provider.listCategories = vi.fn(async () => [
    { id: ' development ', name: ' 代码开发 ' },
    { id: 'testing', name: '测试' },
  ]);
  const service = new PluginMarketplaceService([provider]);

  expect(service.listSources()[0]).toMatchObject({ supportsCategories: true });
  await expect(
    service.listCategories({ sourceId: provider.source.id, kind: PluginKind.SKILL }),
  ).resolves.toEqual({
    categories: [
      { id: 'development', name: '代码开发' },
      { id: 'testing', name: '测试' },
    ],
  });
});

test('passes a normalized category id to marketplace search', async () => {
  const provider = createProvider();
  const service = new PluginMarketplaceService([provider]);

  await service.search({ kind: PluginKind.SKILL, categoryId: ' development ' });

  expect(provider.search).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    categoryId: 'development',
    query: undefined,
    limit: 20,
  });
});

test('rejects duplicate provider category ids case-insensitively', async () => {
  const provider = createProvider();
  provider.listCategories = vi.fn(async () => [
    { id: 'docs', name: '文档撰写' },
    { id: 'DOCS', name: 'Documentation' },
  ]);
  const service = new PluginMarketplaceService([provider]);

  await expect(
    service.listCategories({ sourceId: provider.source.id, kind: PluginKind.SKILL }),
  ).rejects.toMatchObject({ code: MarketplaceErrorCode.INVALID_RESPONSE });
});

test('returns validated update candidates from optional provider checks', async () => {
  const provider = createProvider();
  provider.checkUpdates = vi.fn(async () => [
    {
      id: 'catalog-writer',
      runtimeId: 'writer',
      kind: PluginKind.SKILL,
      name: 'Writer',
      description: 'Writes text',
      sourceId: provider.source.id,
      installState: MarketplaceInstallState.UPDATE_AVAILABLE,
      version: '2.0.0',
      installedVersion: '1.0.0',
    },
  ]);
  const service = new PluginMarketplaceService([provider]);

  const result = await service.checkUpdates({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer', version: '1.0.0' }],
  });

  expect(provider.checkUpdates).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer', version: '1.0.0' }],
  });
  expect(result.updates).toEqual([
    expect.objectContaining({
      id: 'catalog-writer',
      runtimeId: 'writer',
      installState: MarketplaceInstallState.UPDATE_AVAILABLE,
    }),
  ]);
});

test('ignores providers that do not implement update checks', async () => {
  const service = new PluginMarketplaceService([createProvider()]);

  await expect(
    service.checkUpdates({ kind: PluginKind.SKILL, installed: [{ id: 'writer' }] }),
  ).resolves.toEqual({ updates: [] });
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

test('passes the validated operation context to the installer without leaking it into provider input', async () => {
  const provider = createProvider();
  const installationService = new PluginInstallationService();
  const install = vi.fn(async () => ({ success: true, pluginId: 'writer' }));
  installationService.registerInstaller({ kind: PluginKind.SKILL, install });
  const service = new PluginMarketplaceService([provider], installationService);
  const context = { requestId: 'marketplace-install' };
  await service.install(
    { sourceId: provider.source.id, pluginId: 'writer', kind: PluginKind.SKILL },
    undefined,
    context,
  );
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ operationContext: context }));
  expect(provider.prepareInstall).toHaveBeenCalledWith(
    expect.not.objectContaining({ operationContext: expect.anything() }),
  );
});

test('reports entered preparation, native installation, registry and cleanup stages', async () => {
  const provider = createProvider();
  let providerProgress: ((stage: PluginOperationStage) => void) | undefined;
  provider.prepareInstall = vi.fn(async (_request, context) => {
    providerProgress = context?.onProgress;
    providerProgress?.(PluginOperationStage.EXTRACTING);
    return {
      payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer' },
      cleanup: vi.fn(),
    };
  });
  const installationService = new PluginInstallationService();
  let installerProgress: ((progress: { stage: string; percent: number }) => void) | undefined;
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async request => {
      installerProgress = request.onProgress;
      // A delayed SDK callback cannot make an active install appear to be downloading again.
      providerProgress?.(PluginOperationStage.PREPARING_PACKAGE);
      request.onProgress?.({ stage: PluginOperationStage.ENABLING, percent: 80 });
      return { success: true, pluginId: 'writer' };
    }),
  });
  const service = new PluginMarketplaceService([provider], installationService);
  const progress = vi.fn();

  await service.install(
    { sourceId: provider.source.id, pluginId: 'writer', kind: PluginKind.SKILL },
    progress,
  );
  providerProgress?.(PluginOperationStage.PREPARING_PACKAGE);
  installerProgress?.({ stage: PluginOperationStage.ENABLING, percent: 90 });

  expect(progress.mock.calls.map(([stage]) => stage)).toEqual([
    PluginOperationStage.QUEUED,
    PluginOperationStage.PREPARING_PACKAGE,
    PluginOperationStage.EXTRACTING,
    PluginOperationStage.INSTALLING,
    PluginOperationStage.ENABLING,
    PluginOperationStage.CONFIRMING,
    PluginOperationStage.CLEANING_UP,
  ]);
});

test('does not publish arbitrary provider or installer progress text', async () => {
  const provider = createProvider();
  provider.prepareInstall = vi.fn(async (_request, context) => {
    context?.onProgress?.('Bearer private-token' as PluginOperationStage);
    return { payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer' } };
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async request => {
      request.onProgress?.({ stage: 'C:\\private-download', percent: 20 });
      return { success: true, pluginId: 'writer' };
    }),
  });
  const service = new PluginMarketplaceService([provider], installationService);
  const progress = vi.fn();

  const result = await service.install(
    { sourceId: provider.source.id, pluginId: 'writer', kind: PluginKind.SKILL },
    progress,
  );

  expect(result.success).toBe(true);
  expect(progress.mock.calls.map(([stage]) => stage)).toEqual([
    PluginOperationStage.QUEUED,
    PluginOperationStage.PREPARING_PACKAGE,
    PluginOperationStage.INSTALLING,
    PluginOperationStage.CONFIRMING,
  ]);
});

test('progress observers cannot interrupt a committed installation or its cleanup', async () => {
  const provider = createProvider();
  const cleanup = vi.fn();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer' },
    cleanup,
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async () => ({ success: true, pluginId: 'writer' })),
  });
  const service = new PluginMarketplaceService([provider], installationService);

  const result = await service.install(
    { sourceId: provider.source.id, pluginId: 'writer', kind: PluginKind.SKILL },
    () => {
      throw new Error('The requesting view has closed');
    },
  );

  expect(result).toMatchObject({ success: true, pluginId: 'writer' });
  expect(cleanup).toHaveBeenCalledOnce();
});

test('retains a committed activation failure phase while temporary files are cleaned', async () => {
  const provider = createProvider();
  const cleanup = vi.fn();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer' },
    cleanup,
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async request => {
      request.onProgress?.({ stage: PluginOperationStage.ENABLING, percent: 80 });
      return { success: false, installationCommitted: true, pluginId: 'writer' };
    }),
  });
  const service = new PluginMarketplaceService([provider], installationService);
  const progress = vi.fn();

  const result = await service.install(
    { sourceId: provider.source.id, pluginId: 'writer', kind: PluginKind.SKILL },
    progress,
  );

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    failedStage: PluginOperationStage.ENABLING,
  });
  expect(progress).toHaveBeenLastCalledWith(PluginOperationStage.CLEANING_UP);
  expect(cleanup).toHaveBeenCalledOnce();
});

test('retains the entered failure phase of an installer exception after cleanup', async () => {
  const provider = createProvider();
  const cleanup = vi.fn();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer' },
    cleanup,
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async request => {
      request.onProgress?.({ stage: PluginOperationStage.VALIDATING, percent: 20 });
      throw new Error('Bearer private-token');
    }),
  });
  const service = new PluginMarketplaceService([provider], installationService);
  const progress = vi.fn();

  await expect(
    service.install(
      { sourceId: provider.source.id, pluginId: 'writer', kind: PluginKind.SKILL },
      progress,
    ),
  ).rejects.toMatchObject({
    message: 'Marketplace installation failed',
    failedStage: PluginOperationStage.VALIDATING,
  });
  expect(progress).toHaveBeenLastCalledWith(PluginOperationStage.CLEANING_UP);
  expect(cleanup).toHaveBeenCalledOnce();
});

test('persists marketplace identity and maps update checks back to the runtime id', async () => {
  const provider = createProvider();
  const registry = createInstallRegistry();
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async () => ({
      success: true,
      pluginId: 'writer-runtime',
      installPath: 'C:\\skills\\writer-runtime',
    })),
  });
  const service = new PluginMarketplaceService([provider], installationService, registry);
  await service.install({
    sourceId: provider.source.id,
    pluginId: 'catalog-writer',
    kind: PluginKind.SKILL,
    version: '1.0.0',
  });
  provider.checkUpdates = vi.fn(async request => [
    {
      id: request.installed[0].id,
      kind: PluginKind.SKILL,
      name: 'Writer',
      description: 'Writes text',
      sourceId: provider.source.id,
      version: '2.0.0',
      installState: MarketplaceInstallState.UPDATE_AVAILABLE,
    },
  ]);

  const result = await service.checkUpdates({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer-runtime' }],
  });

  expect(provider.checkUpdates).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    installed: [{ id: 'catalog-writer', runtimeId: 'writer-runtime', version: '1.0.0' }],
  });
  expect(result.updates[0]).toMatchObject({
    id: 'catalog-writer',
    runtimeId: 'writer-runtime',
  });
});

test('records a committed update even when its runtime application fails', async () => {
  const provider = createProvider();
  provider.source.supportedKinds = [PluginKind.EXTENSION];
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:\\downloads\\writer' },
  });
  const registry = createInstallRegistry();
  registry.upsert({
    sourceId: provider.source.id,
    kind: PluginKind.EXTENSION,
    marketplacePluginId: 'catalog-writer',
    runtimeId: 'writer-runtime',
    installedVersion: '1.0.0',
    installPath: 'C:\\extensions\\writer-runtime',
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.EXTENSION,
    install: async () => ({
      success: false,
      installationCommitted: true,
      pluginId: 'writer-runtime',
      installPath: 'C:\\extensions\\writer-runtime',
      error: 'Runtime application failed',
    }),
  });
  const service = new PluginMarketplaceService([provider], installationService, registry);

  const result = await service.install({
    sourceId: provider.source.id,
    pluginId: 'catalog-writer',
    kind: PluginKind.EXTENSION,
    version: '2.0.0',
    operation: MarketplaceInstallOperation.UPDATE,
  });

  expect(result).toMatchObject({ success: false, installationCommitted: true });
  expect(registry.list(PluginKind.EXTENSION)).toEqual([
    expect.objectContaining({ installedVersion: '2.0.0', runtimeId: 'writer-runtime' }),
  ]);
  expect(
    service.resolveInstalled({
      kind: PluginKind.EXTENSION,
      installed: [{ id: 'writer-runtime', installPath: 'C:\\extensions\\writer-runtime' }],
    }),
  ).toEqual([
    {
      runtimeId: 'writer-runtime',
      sourceId: provider.source.id,
      pluginId: 'catalog-writer',
    },
  ]);
});

test('does not disclose a persisted installation to another marketplace source', async () => {
  const first = createProvider();
  const second = createProvider();
  second.source.id = 'second-marketplace';
  first.checkUpdates = vi.fn(async () => []);
  second.checkUpdates = vi.fn(async () => []);
  const registry = createInstallRegistry();
  registry.upsert({
    sourceId: first.source.id,
    kind: PluginKind.SKILL,
    marketplacePluginId: 'catalog-writer',
    runtimeId: 'writer-runtime',
  });
  const service = new PluginMarketplaceService(
    [first, second],
    new PluginInstallationService(),
    registry,
  );

  await service.checkUpdates({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer-runtime' }],
  });

  expect(first.checkUpdates).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    installed: [{ id: 'catalog-writer', runtimeId: 'writer-runtime', version: undefined }],
  });
  expect(second.checkUpdates).not.toHaveBeenCalled();
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

test('retains a prepared source while a dispatched native installation is unconfirmed', async () => {
  const provider = createProvider();
  const cleanup = vi.fn();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer' },
    cleanup,
  });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: async () => ({ success: false, installSourceInUse: true }),
  });
  const registry = createInstallRegistry();
  const service = new PluginMarketplaceService([provider], installationService, registry);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(
      service.install({
        sourceId: provider.source.id,
        pluginId: 'writer',
        kind: PluginKind.SKILL,
      }),
    ).resolves.toMatchObject({ success: false, installSourceInUse: true });
    expect(cleanup).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

test('cleans up a prepared payload when its kind is invalid', async () => {
  const provider = createProvider();
  const cleanup = vi.fn();
  vi.mocked(provider.prepareInstall).mockResolvedValue({
    payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:\\downloads\\wrong' },
    cleanup,
  });
  const service = new PluginMarketplaceService([provider]);

  await expect(
    service.install({
      sourceId: provider.source.id,
      pluginId: 'writer',
      kind: PluginKind.SKILL,
    }),
  ).rejects.toMatchObject({ code: MarketplaceErrorCode.INVALID_RESPONSE });
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

test('supports a minimal provider without a detail endpoint', async () => {
  const provider = createProvider();
  delete provider.getDetail;
  const service = new PluginMarketplaceService([provider]);

  expect(service.listSources()).toEqual([
    expect.objectContaining({ id: provider.source.id, supportsDetail: false }),
  ]);

  await expect(
    service.getDetail({
      sourceId: provider.source.id,
      pluginId: 'writer',
      kind: PluginKind.SKILL,
    }),
  ).resolves.toBeNull();
});

test('serializes concurrent installs of the same marketplace identity', async () => {
  const provider = createProvider();
  let releaseFirst!: () => void;
  const firstPrepared = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  vi.mocked(provider.prepareInstall)
    .mockImplementationOnce(async () => {
      await firstPrepared;
      return { payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer.zip' } };
    })
    .mockResolvedValue({
      payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\downloads\\writer.zip' },
    });
  const installationService = new PluginInstallationService();
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async () => ({ success: true, pluginId: 'writer' })),
  });
  const service = new PluginMarketplaceService([provider], installationService);
  const request = {
    sourceId: provider.source.id,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
  } as const;

  const first = service.install(request);
  await vi.waitFor(() => expect(provider.prepareInstall).toHaveBeenCalledTimes(1));
  const second = service.install(request);
  await Promise.resolve();
  expect(provider.prepareInstall).toHaveBeenCalledTimes(1);

  releaseFirst();
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(provider.prepareInstall).toHaveBeenCalledTimes(2);
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
    runtimeId: 'writer-runtime',
    sourceId: 'spoofed-source',
    downloadCount: 12_345,
    category: { id: 'docs', name: '文档撰写' },
    token: 'private-plugin-token',
  } as MarketplacePlugin & { token: string };
  vi.mocked(provider.search).mockResolvedValue({ items: [plugin] });
  const service = new PluginMarketplaceService([provider]);

  const sources = service.listSources();
  const result = await service.search({ kind: PluginKind.SKILL });

  expect(sources[0]).not.toHaveProperty('token');
  expect(result.items[0]).not.toHaveProperty('token');
  expect(result.items[0].sourceId).toBe(provider.source.id);
  expect(result.items[0].runtimeId).toBe('writer-runtime');
  expect(result.items[0].downloadCount).toBe(12_345);
  expect(result.items[0].category).toEqual({ id: 'docs', name: '文档撰写' });
});

test('rejects an invalid marketplace download count', async () => {
  const provider = createProvider();
  vi.mocked(provider.search).mockResolvedValue({
    items: [
      {
        id: 'writer',
        kind: PluginKind.SKILL,
        name: 'Writer',
        description: 'Writes text',
        sourceId: provider.source.id,
        downloadCount: -1,
      },
    ],
  });

  await expect(
    new PluginMarketplaceService([provider]).search({ kind: PluginKind.SKILL }),
  ).rejects.toMatchObject({ code: MarketplaceErrorCode.INVALID_RESPONSE });
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

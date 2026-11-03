import { beforeEach, expect, test, vi } from 'vitest';

import {
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  MarketplaceIpc,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import {
  PluginOperationAction,
  PluginOperationIpc,
  PluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import type { PluginManager } from '../../plugins';
import { PluginInstallationService } from '../../plugins/installation/pluginInstallationService';
import { PluginInstallOrigin } from '../../plugins/installation/types';
import { MarketplaceError } from '../../plugins/marketplace/types';

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
    resolveMarketplaceInstalled: vi.fn(() => []),
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

  const response = await handlers.get(MarketplaceIpc.Search)?.(
    {},
    {
      kind: PluginKind.SKILL,
      query: { unexpected: true },
    },
  );

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

test('retains explicit unconfirmed install evidence while stripping private installer details', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    installSourceInUse: true,
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.CONFIRMING,
    installPath: 'C:/private-source',
    error: 'private native output',
  });
  registerMarketplaceHandlers(manager);
  const context = { requestId: 'market-unknown' };
  const result = await handlers.get(MarketplaceIpc.Install)!(
    {},
    {
      kind: PluginKind.EXTENSION,
      sourceId: 'enterprise',
      pluginId: 'sample',
    },
    context,
  );
  expect(result).toEqual({
    success: false,
    installSourceInUse: true,
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.CONFIRMING,
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
  });
  expect(manager.installFromMarketplace).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(Function),
    context,
  );
});

test('constructs a narrow validated install request', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  await handlers.get(MarketplaceIpc.Install)?.(
    {},
    {
      sourceId: ' enterprise ',
      pluginId: ' writer ',
      kind: PluginKind.SKILL,
      version: ' 1.2.3 ',
      operation: MarketplaceInstallOperation.UPDATE,
      force: true,
      arbitrary: 'ignored',
    },
  );

  expect(manager.installFromMarketplace).toHaveBeenCalledWith(
    {
      sourceId: 'enterprise',
      pluginId: 'writer',
      kind: PluginKind.SKILL,
      version: '1.2.3',
      operation: MarketplaceInstallOperation.UPDATE,
    },
    expect.any(Function),
  );
});

test('correlates marketplace progress with the requesting sender and closes it on completion', async () => {
  const manager = createPluginManager();
  let report: ((stage: PluginOperationStage) => void) | undefined;
  vi.mocked(manager.installFromMarketplace).mockImplementation(async (_request, onProgress) => {
    report = onProgress;
    onProgress?.(PluginOperationStage.PREPARING_PACKAGE);
    return { success: true, pluginId: 'writer' };
  });
  const send = vi.fn();
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    { sender: { isDestroyed: () => false, send } },
    { sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.SKILL },
    { requestId: 'marketplace-request-1' },
  );
  report?.(PluginOperationStage.INSTALLING);

  expect(response).toMatchObject({ success: true });
  expect(send).toHaveBeenCalledExactlyOnceWith(PluginOperationIpc.Progress, {
    requestId: 'marketplace-request-1',
    kind: PluginKind.SKILL,
    action: PluginOperationAction.INSTALL,
    stage: PluginOperationStage.PREPARING_PACKAGE,
    elapsedMs: expect.any(Number),
  });
});

test.each([null, {}, [], { requestId: '' }, { requestId: 'private/path' }])(
  'rejects malformed progress context before submitting a marketplace mutation: %j',
  async context => {
    const manager = createPluginManager();
    registerMarketplaceHandlers(manager);

    const response = await handlers.get(MarketplaceIpc.Install)?.(
      {},
      { sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.SKILL },
      context,
    );

    expect(response).toEqual({
      success: false,
      error: 'Invalid plugin operation context',
      errorCode: MarketplaceErrorCode.INVALID_REQUEST,
    });
    expect(manager.installFromMarketplace).not.toHaveBeenCalled();
  },
);

test('a destroyed progress recipient cannot fail a marketplace installation', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockImplementation(async (_request, onProgress) => {
    onProgress?.(PluginOperationStage.PREPARING_PACKAGE);
    return { success: true, pluginId: 'writer' };
  });
  const send = vi.fn();
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    { sender: { isDestroyed: () => true, send } },
    { sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.SKILL },
    { requestId: 'marketplace-request-2' },
  );

  expect(response).toMatchObject({ success: true });
  expect(send).not.toHaveBeenCalled();
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

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    {
      sourceId: 'enterprise',
      pluginId: 'writer',
      kind: PluginKind.SKILL,
    },
  );

  expect(response).toEqual({
    success: true,
    pluginId: 'writer-runtime',
    restartRequired: false,
  });
});

test.each([PluginKind.EXTENSION, PluginKind.SKILL])('does not expose raw installation failure details for %s', async kind => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    error: 'Cannot rename C:\\private-download\\secret',
    failedStage: 'installing',
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    {
      sourceId: 'enterprise',
      pluginId: 'writer',
      kind,
    },
  );

  expect(response).toEqual({
    success: false,
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.INSTALLING,
  });
  expect(JSON.stringify(response)).not.toContain('private-download');
});

test('shows an explicitly public host validation reason while keeping private result fields internal', async () => {
  const manager = createPluginManager();
  const reason =
    'package install requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js. This is a plugin packaging issue.';
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    error: 'private native output',
    publicReason: reason,
    failedStage: PluginOperationStage.VALIDATING,
    installPath: 'C:\\private-download',
  });
  registerMarketplaceHandlers(manager);
  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    {
      sourceId: 'enterprise',
      pluginId: 'writer',
      kind: PluginKind.EXTENSION,
    },
  );
  expect(response).toEqual({
    success: false,
    error: reason,
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.VALIDATING,
  });
});

test('preserves extension paths on the second sanitizer pass without changing committed and unknown-result evidence', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    installationCommitted: true,
    operationUnconfirmed: true,
    installSourceInUse: true,
    pluginId: 'writer',
    publicReason: String.raw`Cannot enable plugin at "C:\private source\plugin": accessCode=private-value`,
    error: 'private native output',
    failedStage: PluginOperationStage.ENABLING,
  });
  registerMarketplaceHandlers(manager);
  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    {
      sourceId: 'enterprise',
      pluginId: 'writer',
      kind: PluginKind.EXTENSION,
    },
  );
  expect(response).toMatchObject({
    success: false,
    installationCommitted: true,
    operationUnconfirmed: true,
    installSourceInUse: true,
    pluginId: 'writer',
    error: expect.stringContaining('Cannot enable plugin'),
    failedStage: PluginOperationStage.ENABLING,
  });
  expect(JSON.stringify(response)).not.toContain('private-value');
  expect(JSON.stringify(response)).not.toContain('private native output');
  expect(response).toHaveProperty('error', expect.stringContaining(String.raw`C:\private source\plugin`));
});

test('shows local extension update and backup directories through host service and final IPC sanitization', async () => {
  const directory = String.raw`C:\Users\示例用户\插件 目录\writer`;
  const backupDirectory = String.raw`C:\Users\示例用户\插件 目录\.writer-backup-旧版`;
  const sourcePath = String.raw`C:\Users\示例用户\下载 临时包\writer.zip`;
  const service = new PluginInstallationService();
  service.registerInstaller({
    kind: PluginKind.EXTENSION,
    install: vi.fn(async () => ({
      success: false,
      installationCommitted: true as const,
      operationUnconfirmed: true as const,
      installSourceInUse: true as const,
      pluginId: 'writer',
      installPath: directory,
      failedStage: PluginOperationStage.INSTALLING,
      error: [
        `扩展目录：${directory}`,
        `安装源：${sourcePath}`,
        '占用程序：explorer (PID 12996)',
        `备份恢复目录：${backupDirectory}`,
        'Authorization: Bearer fixture-private-bearer',
        'Cookie: fixture-private-cookie',
        'accessCode="fixture-private-access-code"',
        'Download: https://example.test/private-package?token=fixture-private-query',
        String.raw`    at install (C:\private-stack\installer.js:12:3)`,
      ].join('\n'),
    })),
  });
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockImplementation(async () => service.install({
    operation: MarketplaceInstallOperation.UPDATE,
    origin: PluginInstallOrigin.MARKETPLACE,
    payload: { kind: PluginKind.EXTENSION, sourcePath },
  }));
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.({}, {
    sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.EXTENSION,
    operation: MarketplaceInstallOperation.UPDATE,
  });

  expect(response).toMatchObject({
    success: false, installationCommitted: true, operationUnconfirmed: true,
    installSourceInUse: true, pluginId: 'writer', failedStage: PluginOperationStage.INSTALLING,
    error: expect.stringContaining(directory),
  });
  expect(response).not.toHaveProperty('installPath');
  expect(response).not.toHaveProperty('sourcePath');
  expect(response).not.toHaveProperty('publicReason');
  expect(response).toHaveProperty('error', expect.stringContaining(backupDirectory));
  expect(response).toHaveProperty('error', expect.stringContaining(sourcePath));
  expect(response).toHaveProperty('error', expect.stringContaining('explorer (PID 12996)'));
  const text = JSON.stringify(response);
  expect(text).not.toContain('[REDACTED PATH]');
  for (const privateText of [
    'fixture-private-bearer', 'fixture-private-cookie', 'fixture-private-access-code',
    'fixture-private-query', 'private-package', 'private-stack',
  ]) expect(text).not.toContain(privateText);
  expect(manager.installFromMarketplace).toHaveBeenCalledOnce();
});

test.each([PluginKind.SKILL, PluginKind.MCP])('keeps local path redaction for %s regardless of request visibility hints', async kind => {
  const directory = String.raw`C:\Users\示例用户\private local directory`;
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    publicReason: `Cannot access "${directory}"; accessCode=fixture-private-access-code`,
    failedStage: PluginOperationStage.INSTALLING,
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.({}, {
    sourceId: 'enterprise', pluginId: 'writer', kind, preserveLocalPaths: true,
  });

  expect(response).toMatchObject({ success: false, error: expect.stringContaining('[REDACTED PATH]') });
  const text = JSON.stringify(response);
  expect(text).not.toContain('示例用户');
  expect(text).not.toContain('private local directory');
  expect(text).not.toContain('fixture-private-access-code');
});

test.each([true, false])('preserves completed mutation and pending recovery evidence over marketplace IPC (success: %s)', async success => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success, pluginId: 'writer', mutationCompleted: true, runtimeRecoveryPending: true,
    ...(!success ? { installationCommitted: true, publicReason: 'Recovery verification was superseded' } : {}),
  });
  registerMarketplaceHandlers(manager);
  const response = await handlers.get(MarketplaceIpc.Install)?.({}, {
    sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.EXTENSION,
  });

  expect(response).toMatchObject({ success, mutationCompleted: true, runtimeRecoveryPending: true });
  expect(manager.installFromMarketplace).toHaveBeenCalledOnce();
});

test('keeps the reported failure phase after cleanup progresses', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockImplementation(async (_request, onProgress) => {
    onProgress?.(PluginOperationStage.ENABLING);
    onProgress?.(PluginOperationStage.CLEANING_UP);
    return {
      success: false,
      installationCommitted: true,
      pluginId: 'writer',
      failedStage: PluginOperationStage.ENABLING,
      error: 'private-token',
    };
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    { sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.SKILL },
  );

  expect(response).toMatchObject({
    success: false,
    installationCommitted: true,
    failedStage: PluginOperationStage.ENABLING,
    error: 'Marketplace installation failed',
  });
  expect(JSON.stringify(response)).not.toContain('private-token');
});

test('uses the entered phase for an exception and ignores arbitrary stage strings', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockImplementation(async (_request, onProgress) => {
    onProgress?.(PluginOperationStage.PREPARING_PACKAGE);
    onProgress?.('Bearer private-token' as PluginOperationStage);
    throw new Error('Bearer private-token');
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    { sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.SKILL },
  );

  expect(response).toEqual({
    success: false,
    error: 'Marketplace request failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.PREPARING_PACKAGE,
  });
});

test('uses the service failure phase for an exception after cleanup', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockImplementation(async (_request, onProgress) => {
    onProgress?.(PluginOperationStage.CLEANING_UP);
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_RESPONSE,
      'Marketplace source returned an invalid installation payload',
      PluginOperationStage.PREPARING_PACKAGE,
    );
  });
  registerMarketplaceHandlers(manager);

  const response = await handlers.get(MarketplaceIpc.Install)?.(
    {},
    { sourceId: 'enterprise', pluginId: 'writer', kind: PluginKind.SKILL },
  );

  expect(response).toMatchObject({
    success: false,
    failedStage: PluginOperationStage.PREPARING_PACKAGE,
  });
});

test('preserves confirmed commit evidence without exposing runtime failure details', async () => {
  const manager = createPluginManager();
  vi.mocked(manager.installFromMarketplace).mockResolvedValue({
    success: false,
    pluginId: ' writer-runtime ',
    installationCommitted: true,
    installPath: 'C:\\private-download',
    error: 'Cannot apply private credential',
  });
  registerMarketplaceHandlers(manager);

  expect(
    await handlers.get(MarketplaceIpc.Install)?.(
      {},
      {
        sourceId: 'enterprise',
        pluginId: 'writer',
        kind: PluginKind.EXTENSION,
      },
    ),
  ).toEqual({
    success: false,
    pluginId: 'writer-runtime',
    installationCommitted: true,
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
  });
});

test('constructs narrow category list and filtered search requests', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);

  await handlers.get(MarketplaceIpc.ListCategories)?.(
    {},
    {
      sourceId: ' enterprise ',
      kind: PluginKind.SKILL,
      ignored: true,
    },
  );
  await handlers.get(MarketplaceIpc.Search)?.(
    {},
    {
      kind: PluginKind.SKILL,
      categoryId: ' development ',
    },
  );

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

  await handlers.get(MarketplaceIpc.CheckUpdates)?.(
    {},
    {
      kind: PluginKind.SKILL,
      installed: [{ id: ' writer ', version: ' 1.2.3 ', ignored: true }],
      ignored: true,
    },
  );

  expect(manager.checkMarketplaceUpdates).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer', version: '1.2.3' }],
  });
});

test('validates inventory reconciliation and strips unrelated fields', async () => {
  const manager = createPluginManager();
  registerMarketplaceHandlers(manager);
  const request = {
    kind: PluginKind.SKILL,
    installed: [{ id: ' writer ', installPath: ' /skills/writer ', secret: 'discard' }],
  };
  expect(await handlers.get(MarketplaceIpc.ResolveInstalled)?.({}, request)).toEqual({
    success: true,
    installations: [],
  });
  expect(manager.resolveMarketplaceInstalled).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    installed: [{ id: 'writer', installPath: '/skills/writer' }],
  });
  const invalid = await handlers.get(MarketplaceIpc.ResolveInstalled)?.(
    {},
    { kind: PluginKind.SKILL, installed: [{ id: 'writer', installPath: {} }] },
  );
  expect(invalid).toMatchObject({
    success: false,
    errorCode: MarketplaceErrorCode.INVALID_REQUEST,
  });
  expect(manager.resolveMarketplaceInstalled).toHaveBeenCalledTimes(1);
});

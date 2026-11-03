import { expect, test, vi } from 'vitest';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { PluginInstallationService } from './pluginInstallationService';
import { PluginInstallOrigin } from './types';

test('routes a shared install request to the owning plugin installer', async () => {
  const service = new PluginInstallationService();
  const install = vi.fn(async () => ({ success: true, pluginId: 'writer' }));
  service.registerInstaller({ kind: PluginKind.SKILL, install });
  const request = {
    operation: MarketplaceInstallOperation.UPDATE,
    origin: PluginInstallOrigin.CUSTOM,
    payload: { kind: PluginKind.SKILL, sourcePath: 'C:\\skills\\writer.zip' },
  } as const;

  await expect(service.install(request)).resolves.toEqual({
    success: true,
    pluginId: 'writer',
  });
  expect(install).toHaveBeenCalledWith(request);
});

test('returns a typed failure when a plugin kind has no installer', async () => {
  const service = new PluginInstallationService();

  await expect(
    service.install({
      operation: MarketplaceInstallOperation.INSTALL,
      origin: PluginInstallOrigin.MARKETPLACE,
      payload: { kind: PluginKind.HOOK, sourcePath: 'C:\\hooks\\demo.zip' },
    }),
  ).resolves.toEqual({
    success: false,
    error: 'No plugin installer registered for hook',
  });
});

test('rejects duplicate installers for the same plugin kind', () => {
  const service = new PluginInstallationService();
  const installer = {
    kind: PluginKind.EXTENSION,
    install: vi.fn(async () => ({ success: true })),
  };
  service.registerInstaller(installer);

  expect(() => service.registerInstaller(installer)).toThrow(
    'Plugin installer already registered for extension',
  );
});

test('issues a public reason for a returned host validation failure without publishing private output', async () => {
  const service = new PluginInstallationService();
  const reason =
    'package install requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js. This is a plugin packaging issue.';
  service.registerInstaller({
    kind: PluginKind.EXTENSION,
    install: vi.fn(async () => ({ success: false, error: reason, failedStage: 'validating' })),
  });
  await expect(
    service.install({
      operation: MarketplaceInstallOperation.INSTALL,
      origin: PluginInstallOrigin.MARKETPLACE,
      payload: { kind: PluginKind.EXTENSION, sourcePath: 'C:\\downloads\\package' },
    }),
  ).resolves.toMatchObject({ success: false, publicReason: reason, failedStage: 'validating' });
});

test('does not turn an unexpected installer exception into a public reason', async () => {
  const service = new PluginInstallationService();
  service.registerInstaller({
    kind: PluginKind.MCP,
    install: vi.fn(async () => {
      throw new Error('Bearer private-provider-token');
    }),
  });
  await expect(
    service.install({
      operation: MarketplaceInstallOperation.INSTALL,
      origin: PluginInstallOrigin.MARKETPLACE,
      payload: { kind: PluginKind.MCP, config: {} },
    }),
  ).rejects.toThrow('Bearer private-provider-token');
});

test('keeps extension update source, installation and backup directories in a credential-sanitized host reason', async () => {
  const service = new PluginInstallationService();
  const sourcePath = String.raw`C:\Downloads\插件 更新包.zip`;
  const installPath = String.raw`C:\runtime\extensions\插件 目录`;
  const backupPath = String.raw`C:\runtime\extensions\.backup\插件 目录`;
  service.registerInstaller({
    kind: PluginKind.EXTENSION,
    install: vi.fn(async () => ({
      success: false,
      installPath,
      failedStage: 'installing',
      error: [
        `Extension directory: "${installPath}"`,
        `Source archive: "${sourcePath}"`,
        `Backup recovery path: "${backupPath}"`,
        'Authorization: Bearer fixture-private-authorization',
        'Cookie: fixture-private-cookie',
      ].join('\n'),
    })),
  });

  const result = await service.install({
    operation: MarketplaceInstallOperation.UPDATE,
    origin: PluginInstallOrigin.MARKETPLACE,
    payload: { kind: PluginKind.EXTENSION, sourcePath },
  });

  expect(result).toMatchObject({ success: false, failedStage: 'installing' });
  for (const directory of [sourcePath, installPath, backupPath]) {
    expect(result.publicReason).toContain(directory);
  }
  expect(result.publicReason).not.toContain('[REDACTED PATH]');
  expect(result.publicReason).not.toContain('fixture-private-');
});

test('keeps path redaction for other host installer kinds', async () => {
  const service = new PluginInstallationService();
  const directory = String.raw`C:\private-source\skill`;
  service.registerInstaller({
    kind: PluginKind.SKILL,
    install: vi.fn(async () => ({ success: false, error: `Cannot read "${directory}"` })),
  });

  const result = await service.install({
    operation: MarketplaceInstallOperation.UPDATE,
    origin: PluginInstallOrigin.MARKETPLACE,
    payload: { kind: PluginKind.SKILL, sourcePath: directory },
  });

  expect(result.publicReason).toContain('[REDACTED PATH]');
  expect(result.publicReason).not.toContain('private-source');
});

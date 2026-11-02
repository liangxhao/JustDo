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

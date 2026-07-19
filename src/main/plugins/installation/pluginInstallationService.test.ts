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

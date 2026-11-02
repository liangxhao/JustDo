import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  resolveBuilderProductMetadata,
  normalizeStableVersion,
  validatePackageVersions,
} = require('../../scripts/packaging/electron-builder-product-metadata.cjs');

describe('electron-builder product metadata', () => {
  it.each([
    ['JustDo', 'com.justdo.app'],
    ['Wedax', 'com.wedax.app'],
    ['ABC', 'com.abc.app'],
  ])('derives the appId for %s', (productName, appId) => {
    expect(resolveBuilderProductMetadata(productName)).toEqual({ productName, appId });
  });

  it('normalizes productName casing before deriving the appId', () => {
    expect(resolveBuilderProductMetadata('JustDo').appId).toBe(
      resolveBuilderProductMetadata('JUSTDO').appId,
    );
  });

  it.each([undefined, '', 'Wedax App', 'Wedax2', '辅助器', 'con', 'NUL'])(
    'rejects invalid productName %j',
    productName => {
      expect(() => resolveBuilderProductMetadata(productName)).toThrow(/productName/);
    },
  );
});

describe('packaging delivery versions', () => {
  it('accepts the startup version format without changing package metadata', () => {
    const metadata = Object.freeze({
      version: 'v2026.11.2',
      openclaw: Object.freeze({ version: '2026.10.7' }),
    });

    expect(validatePackageVersions(metadata)).toEqual({
      appVersion: '2026.11.2', runtimeVersion: '2026.10.7',
    });
    expect(metadata.version).toBe('v2026.11.2');
    expect(normalizeStableVersion('0.1.0')).toBe('0.1.0');
  });

  it.each([
    [{ version: 'v2026.11.02', openclaw: { version: 'v2026.10.7' } }, 'package.json.version', 'v2026.11.02'],
    [{ version: 'v2026.11.2', openclaw: { version: 'v2026.10.07' } }, 'package.json.openclaw.version', 'v2026.10.07'],
    [{ version: 'v2026.11.2' }, 'package.json.openclaw.version', 'undefined'],
  ])('rejects invalid package versions with actionable field and value details: %j', (metadata, field, value) => {
    expect(() => validatePackageVersions(metadata)).toThrow(field);
    expect(() => validatePackageVersions(metadata)).toThrow(value);
    expect(() => validatePackageVersions(metadata)).toThrow('2026.11.2');
    expect(() => validatePackageVersions(metadata)).toThrow('leading zeros');
  });

  it.each(['2026.11', '2026.11.2-beta.1', '2026.11.2+build', ' 2026.11.2', '2026.11.2\n', 'V2026.11.2', '9007199254740992.0.0', 2026])(
    'rejects versions that startup cannot compare: %j',
    value => expect(() => normalizeStableVersion(value)).toThrow('stable numeric version'),
  );

  it('rejects an invalid version before configuring installer scripts, including prepackaged builds', () => {
    const configureInstaller = vi.fn();
    const configUrl = new URL('../../electron-builder.config.cjs', import.meta.url);
    const metadata = { version: 'v2026.11.02', openclaw: { version: 'v2026.10.7' } };
    const load = (id: string) => {
      if (id === './electron-builder.json') return {};
      if (id === './package.json') return metadata;
      if (id === './scripts/packaging/electron-builder-product-metadata.cjs')
        return { resolveBuilderProductMetadata, validatePackageVersions };
      if (id === './scripts/packaging/windows-installer-script.cjs')
        return { configureWindowsInstallerScript: configureInstaller };
      throw new Error(`Unexpected dependency before version validation: ${id}`);
    };

    expect(() => runInNewContext(readFileSync(configUrl, 'utf8'), {
      require: load, process: { env: {} }, __dirname: fileURLToPath(new URL('.', configUrl)),
      module: { exports: {} },
    })).toThrow('package.json.version');
    expect(configureInstaller).not.toHaveBeenCalled();
  });

  it('rejects an effective metadata override before packaging resources are prepared', async () => {
    const { beforePack } = require('../../scripts/packaging/electron-builder-hooks.cjs');
    await expect(beforePack({
      packager: { info: { metadata: {
        version: 'v2026.11.02', openclaw: { version: 'v2026.10.7' },
      } } },
    })).rejects.toThrow('package.json.version');
  });
});

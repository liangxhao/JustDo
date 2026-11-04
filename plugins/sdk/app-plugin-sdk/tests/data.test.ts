import { describe, expect, it } from 'vitest';

import { parseAppPluginManifest } from '../contracts';
import { assertPluginDataId, parsePluginDataOwner, resolvePluginDataDirectory } from '../data';

const manifest = {
  manifestVersion: 1, apiVersion: 1, id: 'example-plugin', nativePluginId: 'example-plugin',
  version: '1.0.0', entries: { main: 'main.mjs', browser: 'browser.mjs' },
  capabilities: [], commands: [], slots: [],
};

describe('private plugin data SDK contracts', () => {
  it('retains an exact declaration and clones its required file list', () => {
    const data = { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['selection.json'] } };
    const result = parseAppPluginManifest({ ...manifest, data });
    expect(result.data).toEqual(data);
    data.migrateLegacyDirectory.requiredFiles.push('another.json');
    expect(result.data?.migrateLegacyDirectory?.requiredFiles).toEqual(['selection.json']);
    expect(parseAppPluginManifest(manifest).data).toBeUndefined();
  });

  it('retains the optional durable data policy in the manifest and ownership record', () => {
    const data = { directory: 'managed-v1', retention: 'retain' };
    expect(parseAppPluginManifest({ ...manifest, data }).data).toEqual(data);
    const owner = { schemaVersion: 1, pluginId: 'example-plugin',
      dataId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', retention: 'retain' };
    expect(parsePluginDataOwner(owner)).toEqual(owner);
    expect(Object.isFrozen(parsePluginDataOwner(owner))).toBe(true);
    for (const retention of [undefined, null, false, 'delete', 'unknown'])
      expect(() => parsePluginDataOwner({ ...owner, retention })).toThrow();
    expect(() => parsePluginDataOwner({ ...owner, extra: true })).toThrow();
  });

  it.each([
    { directory: 'arbitrary' },
    { directory: 'managed-v1', path: 'C:/anything' },
    { directory: 'managed-v1', retention: 'delete' },
    { directory: 'managed-v1', retention: false },
    { directory: 'managed-v1', migrateLegacyDirectory: true },
    { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: [] } },
    { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['../file'] } },
    { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['C:\\file'] } },
    { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['a', 'a'] } },
  ])('rejects unsupported or path-bearing declarations: %j', data => {
    expect(() => parseAppPluginManifest({ ...manifest, data })).toThrow();
  });

  it.each(['../other', '..', 'a/b', 'a\\b', 'NUL', 'con', 'con.model', 'com1', ''])('rejects unsafe owner %s', owner => {
    expect(() => assertPluginDataId(owner)).toThrow();
  });

  it('rejects loose ownership records and never creates missing directories', () => {
    const owner = { schemaVersion: 1, pluginId: 'example-plugin', dataId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    expect(parsePluginDataOwner(owner)).toEqual(owner);
    expect(Object.isFrozen(parsePluginDataOwner(owner))).toBe(true);
    expect(() => parsePluginDataOwner({ ...owner, path: '/anywhere' })).toThrow();
    expect(() => parsePluginDataOwner({ ...owner, dataId: '../bad' })).toThrow();
    expect(() => resolvePluginDataDirectory('relative', 'example-plugin')).toThrow();
  });
});

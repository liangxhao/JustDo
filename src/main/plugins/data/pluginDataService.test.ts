import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLUGIN_DATA_OWNER_FILE,resolvePluginDataDirectory } from '../../../../plugins/sdk/app-plugin-sdk/data';
import {
  inspectPluginData,
  preparePluginDataDirectory,
  preparePluginDataRemoval,
  removePluginData,
} from './pluginDataService';

let state: string;
const declaration = { directory: 'managed-v1' } as const;
const retainedDeclaration = { directory: 'managed-v1', retention: 'retain' } as const;
const migration = { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['selection.json'] } } as const;
const managed = (owner = 'sample') => path.join(state, 'plugin-data', owner);
beforeEach(async () => { state = await mkdtemp(path.join(os.tmpdir(), 'plugin-data-test-')); });
afterEach(async () => {
  if (path.dirname(path.resolve(state)) !== path.resolve(os.tmpdir()) || !path.basename(state).startsWith('plugin-data-test-'))
    throw new Error('Unsafe test cleanup');
  await rm(state, { recursive: true, force: true });
});

describe('managed private plugin data', () => {
  it('prepares a receipt owned directory shared by Main and Native, preserving its identity across updates', async () => {
    expect(await inspectPluginData(state, ['sample'])).toEqual({ exists: false, bytes: 0, canDelete: true });
    expect(existsSync(path.join(state, 'plugin-data'))).toBe(false);
    const directory = await preparePluginDataDirectory(state, 'sample', declaration);
    expect(resolvePluginDataDirectory(state, 'sample')).toBe(directory);
    const owner = await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8');
    expect(Object.keys(JSON.parse(owner)).sort()).toEqual(['dataId', 'pluginId', 'schemaVersion']);
    expect(() => resolvePluginDataDirectory(state, 'sample', { retention: 'retain' }))
      .toThrow('retention is unavailable');
    await writeFile(path.join(directory, 'model'), 'model-bytes');
    expect(await preparePluginDataDirectory(state, 'sample', declaration)).toBe(directory);
    expect(await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8')).toBe(owner);
    expect(await inspectPluginData(state, ['sample'])).toEqual({ exists: true,
      bytes: Buffer.byteLength(owner) + 11, canDelete: true });
  });

  it('retains protected runtime records even when a later manifest omits retention', async () => {
    const directory = await preparePluginDataDirectory(state, 'sample', retainedDeclaration);
    const owner = await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8');
    expect(JSON.parse(owner)).toMatchObject({ schemaVersion: 1, pluginId: 'sample', retention: 'retain' });
    expect(resolvePluginDataDirectory(state, 'sample', { retention: 'retain' })).toBe(directory);
    await writeFile(path.join(directory, 'receipt'), 'unsettled-run');
    expect(await inspectPluginData(state, ['sample'])).toEqual({ exists: true,
      bytes: Buffer.byteLength(owner) + Buffer.byteLength('unsettled-run'), canDelete: false, retained: true });
    await preparePluginDataDirectory(state, 'sample', declaration);
    expect(await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8')).toBe(owner);
    await expect(preparePluginDataRemoval(state, ['sample'])).rejects.toThrow('must be retained');
    expect(await readFile(path.join(directory, 'receipt'), 'utf8')).toBe('unsettled-run');
  });

  it('atomically strengthens an existing owner policy without replacing its data identity', async () => {
    const directory = await preparePluginDataDirectory(state, 'sample', declaration);
    const original = JSON.parse(await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8'));
    await writeFile(path.join(directory, 'receipt'), 'keep');
    await preparePluginDataDirectory(state, 'sample', retainedDeclaration);
    expect(JSON.parse(await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8')))
      .toEqual({ ...original, retention: 'retain' });
    expect((await readdir(directory)).sort()).toEqual([PLUGIN_DATA_OWNER_FILE, 'receipt']);
    expect(await readFile(path.join(directory, 'receipt'), 'utf8')).toBe('keep');
  });

  it('refuses cleanup of a package containing any retained owner', async () => {
    await preparePluginDataDirectory(state, 'sample', declaration);
    await preparePluginDataDirectory(state, 'child', retainedDeclaration);
    const info = await inspectPluginData(state, ['sample', 'child']);
    expect(info).toMatchObject({ exists: true, canDelete: false, retained: true });
    expect(info.bytes).toBeGreaterThan(0);
    await expect(preparePluginDataRemoval(state, ['sample', 'child'])).rejects.toThrow('must be retained');
    expect(existsSync(path.join(managed('sample'), PLUGIN_DATA_OWNER_FILE))).toBe(true);
    expect(existsSync(path.join(managed('child'), PLUGIN_DATA_OWNER_FILE))).toBe(true);
  });

  it('rechecks a strengthened retention policy before deleting any owner in a captured package', async () => {
    await preparePluginDataDirectory(state, 'sample', declaration);
    await preparePluginDataDirectory(state, 'child', declaration);
    const snapshot = await preparePluginDataRemoval(state, ['sample', 'child']);
    await preparePluginDataDirectory(state, 'child', retainedDeclaration);
    await expect(removePluginData(snapshot)).rejects.toThrow('must be retained');
    expect(existsSync(path.join(managed('sample'), PLUGIN_DATA_OWNER_FILE))).toBe(true);
    expect(JSON.parse(await readFile(path.join(managed('child'), PLUGIN_DATA_OWNER_FILE), 'utf8')).retention)
      .toBe('retain');
  });

  it('fails closed for a malformed retained marker without deleting another selected owner', async () => {
    await preparePluginDataDirectory(state, 'sample', declaration);
    await preparePluginDataDirectory(state, 'child', declaration);
    const snapshot = await preparePluginDataRemoval(state, ['sample', 'child']);
    const marker = path.join(managed('child'), PLUGIN_DATA_OWNER_FILE);
    const original = JSON.parse(await readFile(marker, 'utf8'));
    await writeFile(marker, JSON.stringify({ ...original, retention: 'unknown' }));
    await expect(removePluginData(snapshot)).rejects.toThrow('Invalid plugin data owner');
    expect(existsSync(path.join(managed('sample'), PLUGIN_DATA_OWNER_FILE))).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it('migrates only the declared same-owner legacy tree without copying model bytes', async () => {
    const legacy = path.join(state, 'sample');
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'selection.json'), '{}');
    await writeFile(path.join(legacy, 'model'), 'model-bytes');
    const before = await lstat(path.join(legacy, 'model'));
    await preparePluginDataDirectory(state, 'sample', { ...migration, migrateLegacyDirectory: { requiredFiles: ['selection.json'] } });
    expect(existsSync(legacy)).toBe(false);
    const after = await lstat(path.join(managed(), 'model'));
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await readFile(path.join(managed(), 'model'), 'utf8')).toBe('model-bytes');
  });

  it('leaves both directories intact rather than merging a migration conflict', async () => {
    await preparePluginDataDirectory(state, 'sample', declaration);
    await mkdir(path.join(state, 'sample'));
    await writeFile(path.join(state, 'sample', 'selection.json'), '{}');
    await expect(preparePluginDataDirectory(state, 'sample', { ...migration,
      migrateLegacyDirectory: { requiredFiles: ['selection.json'] } })).rejects.toThrow('conflict');
    expect(existsSync(path.join(state, 'sample', 'selection.json'))).toBe(true);
    expect(existsSync(path.join(managed(), PLUGIN_DATA_OWNER_FILE))).toBe(true);
  });

  it('does not claim a legacy directory without its declared layout or a reserved state directory', async () => {
    await mkdir(path.join(state, 'sample'));
    await writeFile(path.join(state, 'sample', 'unrelated'), 'keep');
    await expect(preparePluginDataDirectory(state, 'sample', { ...migration,
      migrateLegacyDirectory: { requiredFiles: ['selection.json'] } })).rejects.toThrow('declared layout');
    expect(existsSync(path.join(state, 'sample', PLUGIN_DATA_OWNER_FILE))).toBe(false);
    await mkdir(path.join(state, 'agents'));
    await writeFile(path.join(state, 'agents', 'selection.json'), '{}');
    await expect(preparePluginDataDirectory(state, 'agents', { ...migration,
      migrateLegacyDirectory: { requiredFiles: ['selection.json'] } })).rejects.toThrow('reserved');
    expect(existsSync(path.join(state, 'agents', 'selection.json'))).toBe(true);
  });

  it('refuses an unowned tree instead of reporting it as removable', async () => {
    await mkdir(managed(), { recursive: true });
    await writeFile(path.join(managed(), 'model'), 'keep');
    expect(await inspectPluginData(state, ['sample'])).toMatchObject({ exists: true, bytes: 0, canDelete: false });
    await expect(preparePluginDataRemoval(state, ['sample'])).rejects.toThrow();
    expect(await readFile(path.join(managed(), 'model'), 'utf8')).toBe('keep');
  });

  it('rejects linked roots and linked or hardlinked files without following their targets', async () => {
    const outside = path.join(state, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(state, 'plugin-data'), 'junction');
    expect(await inspectPluginData(state, ['sample'])).toMatchObject({ canDelete: false });
    await rm(path.join(state, 'plugin-data'));
    await preparePluginDataDirectory(state, 'sample', declaration);
    await writeFile(path.join(outside, 'keep'), 'private');
    await link(path.join(outside, 'keep'), path.join(managed(), 'hardlink'));
    expect(await inspectPluginData(state, ['sample'])).toMatchObject({ exists: true, canDelete: false });
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('private');
  });

  it('removes only the recorded managed owners, retaining history, old data and unrelated plugins', async () => {
    for (const owner of ['sample', 'child', 'other']) {
      const directory = await preparePluginDataDirectory(state, owner, declaration);
      await mkdir(path.join(directory, 'models'));
      await writeFile(path.join(directory, 'models', 'data'), owner);
    }
    await mkdir(path.join(state, 'sample'));
    await writeFile(path.join(state, 'sample', 'history'), 'keep');
    const snapshot = await preparePluginDataRemoval(state, ['sample', 'child']);
    await removePluginData(snapshot);
    expect(existsSync(managed('sample'))).toBe(false);
    expect(existsSync(managed('child'))).toBe(false);
    expect(await readFile(path.join(managed('other'), 'models', 'data'), 'utf8')).toBe('other');
    expect(await readFile(path.join(state, 'sample', 'history'), 'utf8')).toBe('keep');
    await expect(removePluginData(snapshot)).rejects.toThrow('unavailable');
  });

  it('checks all owners before deletion and rejects a newly added file without removing the first owner', async () => {
    await preparePluginDataDirectory(state, 'sample', declaration);
    await preparePluginDataDirectory(state, 'child', declaration);
    const snapshot = await preparePluginDataRemoval(state, ['sample', 'child']);
    await writeFile(path.join(managed('child'), 'late'), 'keep');
    await expect(removePluginData(snapshot)).rejects.toThrow('changed before removal');
    expect(existsSync(path.join(managed('sample'), PLUGIN_DATA_OWNER_FILE))).toBe(true);
    expect(await readFile(path.join(managed('child'), 'late'), 'utf8')).toBe('keep');
  });

  it('rejects a replacement owner and an unrecorded replacement directory', async () => {
    await preparePluginDataDirectory(state, 'sample', declaration);
    const first = await preparePluginDataRemoval(state, ['sample']);
    await writeFile(path.join(managed(), PLUGIN_DATA_OWNER_FILE), JSON.stringify({ schemaVersion: 1,
      pluginId: 'sample', dataId: randomUUID() }));
    await expect(removePluginData(first)).rejects.toThrow('changed before removal');
    const second = await preparePluginDataRemoval(state, ['sample']);
    await rename(managed(), path.join(state, 'previous'));
    await preparePluginDataDirectory(state, 'sample', declaration);
    await expect(removePluginData(second)).rejects.toThrow('changed before removal');
    expect(existsSync(path.join(managed(), PLUGIN_DATA_OWNER_FILE))).toBe(true);
  });

  it('fails closed if a selected tree appears after the pre-uninstall snapshot', async () => {
    const snapshot = await preparePluginDataRemoval(state, ['sample']);
    await preparePluginDataDirectory(state, 'sample', declaration);
    await expect(removePluginData(snapshot)).rejects.toThrow('root changed');
    expect(existsSync(managed())).toBe(true);
  });
});

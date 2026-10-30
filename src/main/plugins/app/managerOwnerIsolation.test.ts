import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { AppPluginError } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppResourceParticipant } from '../../../../plugins/sdk/app-plugin-sdk/main';
import { artifactDigest, inspectAppArtifact, retainAppArtifact } from './artifact';
import { type AppCandidate, AppPluginManager } from './manager';
import { AppProtectionJournal } from './protectionJournal';
import type { AppHostResources } from './registry';

const id = 'owner-fixture';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const releases: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
});

async function fixture(layout: 'damaged' | 'missing-retained' | 'removed' | 'missing-native-root' | 'missing-native-inventory' | 'unknown', id = 'owner-fixture') {
  const root = await mkdtemp(path.join(tmpdir(), 'app-owner-isolation-'));
  releases.push(() => rm(root, { recursive: true, force: true }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  releases.push(() => warn.mockRestore());
  const nativeRoot = path.join(root, 'runtime', 'dist', 'extensions', id);
  const sourceRoot = path.join(nativeRoot, 'app');
  const retentionRoot = path.join(root, 'retained');
  await mkdir(sourceRoot, { recursive: true });
  const native = 'export default {};';
  await writeFile(path.join(nativeRoot, 'index.js'), native);
  const manifest: AppPluginManifest = {
    manifestVersion: 1, apiVersion: 1, id, nativePluginId: id, version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' },
    capabilities: [], commands: [], slots: [],
  };
  const content = {
    'main.mjs': 'export const register = () => ({ commands: [] });',
    'browser.mjs': 'export const register = () => {};',
    'native.binding.json': JSON.stringify({ entry: 'index.js', profile: 'single-file-v1', sha256: sha(native) }),
  };
  const files = Object.fromEntries(Object.entries(content).map(([name, text]) => [name, sha(text)]));
  const hash = artifactDigest(manifest, files);
  for (const [name, text] of Object.entries(content)) await writeFile(path.join(sourceRoot, name), text);
  await writeFile(path.join(sourceRoot, 'app.artifact.json'), JSON.stringify({ manifest, files, hash }));
  await retainAppArtifact(await inspectAppArtifact(sourceRoot), retentionRoot);

  const sqlite = new DatabaseSync(':memory:');
  releases.push(() => sqlite.close());
  const database = {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    transaction: (operation: () => unknown) => () => {
      sqlite.exec('BEGIN');
      try {
        const result = operation();
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Database.Database;
  const journal = new AppProtectionJournal(database);
  journal.replace(id, hash, ['source']);
  sqlite.exec("CREATE TABLE owner_metadata (value TEXT); INSERT INTO owner_metadata VALUES ('kept');");
  const inventory = vi.fn(() => ['source']);
  const participant: AppResourceParticipant = {
    protectedResources: inventory,
    expandResources: ids => [...ids],
    acquireDeletion: () => () => undefined,
    isDeleting: () => false,
    isManaged: resource => resource === 'source',
    prepareDelete: async () => undefined,
    deleteManaged: async () => false,
  };
  let candidates: AppCandidate[] = [{ root: sourceRoot, nativeRoot, trusted: true,
    bundled: true, identity: { id, hash } }];
  if (layout === 'removed') candidates = [];
  if (layout === 'missing-native-root' || layout === 'missing-native-inventory') {
    // The immutable app artifact still exists independently of the removed Native directory.
    candidates[0] = { ...candidates[0], root: path.join(retentionRoot, id, hash) };
    await rm(layout === 'missing-native-root' ? nativeRoot : path.dirname(nativeRoot), { recursive: true });
  } else if (layout === 'damaged' || layout === 'missing-retained') {
    await writeFile(path.join(sourceRoot, 'main.mjs'), '// changed bytes');
    if (layout === 'missing-retained') await rm(retentionRoot, { recursive: true });
  }
  const loadModule = vi.fn(async (_url: string) => ({ register: () => ({
    commands: [], resources: participant,
  }) }));
  const manager = new AppPluginManager({
    retentionRoot,
    candidates: async () => {
      if (layout === 'unknown') throw new Error('inventory unavailable');
      return candidates;
    },
    resources: { getDatabase: () => database } as AppHostResources,
    readDesiredEnabled: () => false,
    isGatewayConnected: () => false,
    broadcast: () => {},
    loadModule,
    withStoppedGateway: operation => operation(),
  });
  releases.push(() => manager.dispose());
  await manager.prepare();
  manager.initializeDatabase(database);
  await manager.activate();
  return { manager, journal, loadModule, inventory, hash,
    metadata: () => sqlite.prepare('SELECT * FROM owner_metadata').all(),
    reinstall: async () => {
      candidates = [{ root: sourceRoot, nativeRoot, trusted: true, bundled: true, identity: { id, hash } }];
      await manager.mutatePackage(async () => undefined);
    },
  };
}

test('restores the precise bundled cleanup owner from journal trust without an external approval history', async () => {
  const f = await fixture('damaged');
  expect(f.manager.snapshot()).toEqual([]);
  expect(f.loadModule).toHaveBeenCalledOnce();
  expect(f.loadModule.mock.calls[0][0]).toContain(f.hash);
  expect(f.inventory).not.toHaveBeenCalled();
  expect(() => f.manager.registry.assertResourceOwners(['source'])).not.toThrow();
  expect(f.manager.registry.registrations()).toHaveLength(1);
  expect(f.manager.registry.registrations()[0].commands).toEqual([]);
});

test('a damaged owner without retained bytes protects its resources without poisoning unrelated deletion', async () => {
  const f = await fixture('missing-retained');
  expect(f.journal.allOwners()).toHaveLength(1);
  expect(() => f.manager.registry.assertResourceOwners(['source'])).toThrow(AppPluginError.Unavailable);
  expect(() => f.manager.registry.assertResourceOwners(['ordinary'])).not.toThrow();
  expect(f.loadModule).not.toHaveBeenCalled();
});

test('complete absence retires journal ownership instead of restoring an abandoned plugin', async () => {
  const f = await fixture('removed');
  expect(f.journal.allOwners()).toEqual([]);
  expect(f.manager.registry.registrations()).toEqual([]);
  expect(f.loadModule).not.toHaveBeenCalled();
  expect(f.inventory).not.toHaveBeenCalled();
  expect(f.metadata()).toEqual([{ value: 'kept' }]);
  expect(() => f.manager.registry.assertResourceOwners(['source'])).not.toThrow();
  await expect(f.manager.registry.preparePackageMutation()).resolves.toBeUndefined();
});

test('a removed Native root inventories trusted Main before detaching and preserves its metadata', async () => {
  const f = await fixture('missing-native-root');
  expect(f.inventory).toHaveBeenCalled();
  expect(f.metadata()).toEqual([{ value: 'kept' }]);
  expect(f.journal.allOwners()).toEqual([]);
  expect(f.manager.snapshot()).toEqual([]);
  expect(() => f.manager.registry.assertResourceOwners(['source'])).not.toThrow();
  await expect(f.manager.registry.preparePackageMutation()).resolves.toBeUndefined();
});

test('unknown discovery retains ownership and global destructive-operation protection', async () => {
  const f = await fixture('unknown');
  expect(f.journal.allOwners()).toHaveLength(1);
  expect(() => f.manager.registry.assertResourceOwners(['ordinary'])).toThrow(AppPluginError.Unavailable);
  await expect(f.manager.registry.preparePackageMutation()).rejects.toThrow('appPluginCleanupUnresolved');
});

test('a missing whole Native inventory is unknown and does not detach existing metadata ownership', async () => {
  const f = await fixture('missing-native-inventory');
  expect(f.journal.allOwners()).toEqual([{ ownerId: id, artifactHash: f.hash }]);
  expect(f.metadata()).toEqual([{ value: 'kept' }]);
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  expect(f.inventory).toHaveBeenCalled();
});

test('reinstall inventories retained metadata after an explicit removal without reopening old business', async () => {
  const f = await fixture('removed');
  expect(f.journal.allOwners()).toEqual([]);
  await f.reinstall();
  expect(f.metadata()).toEqual([{ value: 'kept' }]);
  expect(f.journal.allOwners()).toEqual([{ ownerId: id, artifactHash: f.hash }]);
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  expect(f.inventory).toHaveBeenCalled();
});

test.each(['agent-team', 'swarm-workflow'])(
  '%s can be absent without locking ordinary sessions and can rediscover retained records after reinstall',
  async ownerId => {
    const f = await fixture('removed', ownerId);
    expect(() => f.manager.registry.assertResourceOwners(['source', 'ordinary'])).not.toThrow();
    await expect(f.manager.mutate('other-capability', false, async () => 'disabled')).resolves.toBe('disabled');
    expect(f.manager.registry.registrations()).toEqual([]);
    expect(f.metadata()).toEqual([{ value: 'kept' }]);
    await f.reinstall();
    expect(f.journal.allOwners()).toEqual([{ ownerId, artifactHash: f.hash }]);
    expect(f.metadata()).toEqual([{ value: 'kept' }]);
  },
);

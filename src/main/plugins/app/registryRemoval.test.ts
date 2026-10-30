import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

import type { AppMainHost } from '../../../../plugins/sdk/app-plugin-sdk/main';
import type { VerifiedAppArtifact } from './artifact';
import { type AppHostResources, AppPluginRegistry } from './registry';

const artifact: VerifiedAppArtifact = {
  root: 'C:/removed-fixture',
  artifact: {
    hash: 'a'.repeat(64), files: {},
    manifest: {
      manifestVersion: 1, apiVersion: 1, id: 'removed-fixture', nativePluginId: 'removed-fixture',
      version: '1.0.0', entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [], commands: [], slots: [],
    },
  },
};

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
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
  const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
  registry.initializeDatabase(database);
  sqlite.exec("CREATE TABLE plugin_data (value TEXT); INSERT INTO plugin_data VALUES ('pending');");
  const resources = { getDatabase: () => database } as AppHostResources;
  return { sqlite, database, registry, resources, close: () => { registry.dispose(); sqlite.close(); } };
}

test('removal detaches only its owner, including when implementation bytes are gone', async () => {
  const f = fixture();
  try {
    const insert = f.sqlite.prepare('INSERT INTO app_plugin_resources VALUES (?, ?, ?)');
    insert.run('removed-fixture', 'a'.repeat(64), 'source');
    insert.run('healthy-fixture', 'b'.repeat(64), 'source');
    f.registry.blockResourceAdmission('removed-fixture');
    f.registry.removeOwner('removed-fixture');
    expect(f.registry.hasUnresolvedInventory()).toBe(false);
    expect(() => f.registry.assertResourceOwners(['ordinary'])).not.toThrow();
    expect(() => f.registry.assertResourceOwners(['source'])).toThrow();
    expect(f.registry.resourceOwners()).toEqual([
      { ownerId: 'healthy-fixture', artifactHash: 'b'.repeat(64) },
    ]);
    await expect(f.registry.mutate('other-plugin', false, async () => 'disabled')).resolves.toBe('disabled');
  } finally { f.close(); }
});

test('removal preserves product metadata and revokes retained database and native effects', async () => {
  const f = fixture();
  const native = vi.fn();
  let host!: AppMainHost;
  const dispose = vi.fn();
  try {
    await f.registry.prepare(artifact, {
      ...f.resources,
      requestGateway: native,
      getSessions: () => ({ deleteSession: native }),
    } as unknown as AppHostResources, async () => ({
      register: current => { host = current; return { commands: [], dispose }; },
    }));
    f.registry.removeOwner('removed-fixture');
    f.registry.removeOwner('removed-fixture');
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.sqlite.prepare('SELECT value FROM plugin_data').get()).toEqual({ value: 'pending' });
    expect(() => host.getDatabase().prepare('DELETE FROM plugin_data').run()).toThrow();
    expect(() => host.requestGateway('sessions.delete', {})).toThrow();
    expect(() => host.getSessions().deleteSession('borrowed-source')).toThrow();
    expect(native).not.toHaveBeenCalled();
    expect(f.registry.snapshot()).toEqual([]);
    await expect(f.registry.preparePackageMutation()).resolves.toBeUndefined();
  } finally { f.close(); }
});

test('a borrowed cleanup instance retires once through its original registry', async () => {
  const f = fixture();
  const target = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
  const dispose = vi.fn();
  try {
    await f.registry.prepare(artifact, f.resources, async () => ({
      register: () => ({ commands: [], dispose }),
    }));
    f.sqlite.prepare('INSERT INTO app_plugin_resources VALUES (?, ?, ?)')
      .run('removed-fixture', 'a'.repeat(64), 'source');
    target.initializeDatabase(f.database);
    target.retainCleanupOwners(f.registry);
    target.removeOwner('removed-fixture');
    f.registry.removeOwner('removed-fixture');
    target.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => f.registry.assertResourceOwners(['source'])).not.toThrow();
    await expect(f.registry.preparePackageMutation()).resolves.toBeUndefined();
    expect(f.sqlite.prepare('SELECT value FROM plugin_data').get()).toEqual({ value: 'pending' });
  } finally { target.dispose(); f.close(); }
});

// Real Manager/Registry/journal SQL. Native identity is a fixture, never a Gateway proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildSync } from 'esbuild';

const temporary = await mkdtemp(path.join(tmpdir(), 'app-inventory-veto-'));
const sqlite = new DatabaseSync(':memory:');
let manager;
try {
  const filename = path.resolve('src/main/plugins/app/manager.ts');
  const compiled = new Module(filename);
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(
    buildSync({
      stdin: {
        contents: ['manager', 'artifact']
          .map(
            name =>
              `export * from ${JSON.stringify(path.resolve('src/main/plugins/app', `${name}.ts`))};`,
          )
          .join('\n'),
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    }).outputFiles[0].text,
    filename,
  );
  const { AppPluginManager, artifactDigest } = compiled.exports;
  const native = 'export default {};';
  const sha = text => createHash('sha256').update(text).digest('hex');
  const manifest = {
    manifestVersion: 1,
    apiVersion: 1,
    id: 'inventory-fixture',
    nativePluginId: 'inventory-fixture',
    version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' },
    capabilities: [],
    slots: [],
    commands: ['create'],
  };
  const artifactRoot = path.join(temporary, 'artifact');
  await mkdir(artifactRoot);
  const contents = {
    'main.mjs': `export function register(host) {
      let projections = 0;
      return {
        commands: [{ id: 'create', invoke: () => host.getSessions().createSession('created', '', 'auto') }],
        resources: {
          protectedResources() {
            if (++projections >= 3) throw new Error('metadata store unreadable');
            return ['protected-source'];
          },
          expandResources(ids) { return [...ids]; },
          acquireDeletion() { return () => {}; },
          isDeleting() { return false; },
          isManaged() { return false; },
          async prepareDelete() {},
          async deleteManaged() { return false; }
        },
        async beforePackageMutation() {}
      };
    }`,
    'browser.mjs': 'export const register = () => {};',
    'native.binding.json': JSON.stringify({
      entry: 'index.js',
      profile: 'single-file-v1',
      sha256: sha(native),
    }),
  };
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [name, sha(text)]),
  );
  for (const [name, text] of Object.entries(contents))
    await writeFile(path.join(artifactRoot, name), text);
  await writeFile(
    path.join(artifactRoot, 'app.artifact.json'),
    JSON.stringify({ manifest, files, hash: artifactDigest(manifest, files) }),
  );
  await writeFile(path.join(temporary, 'index.js'), native);
  // Adapt Node's private SQLite connection without rebuilding Electron's native driver.
  const database = {
    exec: sql => sqlite.exec(sql),
    prepare: sql => sqlite.prepare(sql),
    transaction: operation => () => {
      sqlite.exec('BEGIN');
      try {
        const value = operation();
        sqlite.exec('COMMIT');
        return value;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let businessEffects = 0;
  let coldLeases = 0;
  let packageEffects = 0;
  manager = new AppPluginManager({
    retentionRoot: path.join(temporary, 'retained'),
    resources: {
      getSessions: () => ({
        createSession() {
          businessEffects++;
          return { id: 'created' };
        },
      }),
      requestConnectedGateway: async method => {
        assert.equal(method, `${manifest.id}.app.handshake`);
        return {
          pluginId: manifest.id,
          registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          processId: 123,
          gatewayMethods: [],
          nativeEntry: path.join(temporary, 'index.js'),
          sourceSha256: sha(native),
        };
      },
    },
    readDesiredEnabled: () => true,
    candidates: async () => [{ root: artifactRoot, nativeRoot: temporary, trusted: true }],
    broadcast() {},
    isGatewayConnected: () => true,
    withStoppedGateway: async operation => {
      coldLeases++;
      return operation();
    },
  });
  await manager.prepare();
  manager.initializeDatabase(database);
  await manager.activate();
  await manager.refresh();
  const before = manager.snapshot()[0];
  assert.equal(before.state, 'active');
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM app_plugin_resources').get().count, 1);

  // The initial inventory and first preflight succeed; the fenced second preflight fails.
  await assert.rejects(
    manager.mutatePackage(async () => {
      packageEffects++;
    }),
    /appPluginCleanupUnresolved/u,
  );
  const after = manager.snapshot()[0];
  assert.equal(after.state, 'blocked');
  assert.notEqual(after.epoch, before.epoch);
  const command = await manager.invoke({
    id: manifest.id,
    epoch: after.epoch,
    command: 'create',
    args: [],
  });
  assert.deepEqual(command, { success: false, error: 'appPluginUnavailable' });
  assert.equal(businessEffects, 0);
  assert.equal(packageEffects, 0);
  assert.equal(coldLeases, 0);
  assert.equal(manager.snapshot()[0].state, 'blocked');
  assert.throws(
    () => manager.sessions.acquireDeletion(['protected-source']),
    /appPluginUnavailable/u,
  );
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM app_plugin_resources').get().count, 1);
  console.log(
    JSON.stringify({
      realManager: true,
      realRegistry: true,
      realJournalSQL: true,
      fixtureNativeIdentity: true,
      checks: {
        failedInventoryRemainsBlocked: after.state === 'blocked',
        businessEffectsBlocked: businessEffects === 0,
        packageUntouched: packageEffects === 0 && coldLeases === 0,
        oldEpochRetired: after.epoch !== before.epoch,
        ownershipAndDeletionFencePreserved: true,
      },
    }),
  );
} finally {
  manager?.dispose();
  sqlite.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-inventory-veto-'));
  await rm(temporary, { recursive: true, force: true });
}

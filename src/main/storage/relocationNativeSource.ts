import { NATIVE_RELOCATION_FAILURE_DETAILS } from './relocationNativeFailure';
import { NATIVE_RELOCATION_PLUGINS } from './relocationNativePlugins';

/** Runs only in the admitted bundled Node; native owners retain all SQL and lease authority. */
export const NATIVE_RELOCATION_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(process.argv[1]);
const { identity, contract, profileRoot, stateDir, configPath, snapshotDir } = input;
const cancelled = new AbortController();
let releasing = false;
let check;
process.on('message', value => {
  if (value?.type === 'release') releasing = true;
  else if (value?.type === 'abort') cancelled.abort(new Error('Relocation custody was aborted.'));
  else if (value?.type === 'check' && typeof value.id === 'string') check = value.id;
});
process.on('disconnect', () => cancelled.abort(new Error('Relocation custody lost its parent.')));
if (!process.connected || globalThis.storageOwnerAbortedBeforeStart)
  cancelled.abort(new Error('Relocation custody was interrupted before admission.'));
const current = () => cancelled.signal.throwIfAborted();
const send = value => { if (process.connected) process.send(value); };
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(fs.realpathSync.native(process.execPath), fs.realpathSync.native(identity.executable));
assert.equal(hash(fs.readFileSync(path.join(identity.runtimeRoot, 'runtime-patch-manifest.json'))), identity.manifestSha256);
assert.equal(process.env.OPENCLAW_STATE_DIR, stateDir);
assert.equal(process.env.OPENCLAW_CONFIG_PATH, configPath);
const owners = new Map();
const native = async (role, symbol) => {
  current();
  const entry = contract.modules[role];
  assert.ok(entry?.exports[symbol], 'Relocation native owner is not admitted.');
  let module = owners.get(role);
  if (!module) {
    const file = path.join(identity.runtimeRoot, entry.path);
    assert.equal(hash(fs.readFileSync(file)), entry.sha256, 'Relocation native owner bytes changed.');
    module = await import(pathToFileURL(file).href);
    owners.set(role, module);
  }
  current();
  assert.equal(typeof module[entry.exports[symbol]], 'function');
  return module[entry.exports[symbol]];
};
${NATIVE_RELOCATION_PLUGINS}
${NATIVE_RELOCATION_FAILURE_DETAILS}
const relativeOwned = filename => {
  const relative = path.relative(profileRoot, path.resolve(filename));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Relocation refuses databases outside the profile.');
  return relative;
};
let closeAgents;
let closeState;
let failure;
try {
  const configBytes = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
  const cfg = configBytes
    ? createRequire(path.join(identity.runtimeRoot, 'package.json'))('json5').parse(configBytes.toString('utf8'))
    : {};
  const assertConfig = () => {
    current();
    assert.equal(fs.existsSync(configPath), configBytes !== undefined, 'Native configuration changed.');
    if (configBytes) assert.ok(fs.readFileSync(configPath).equals(configBytes), 'Native configuration changed.');
  };
  closeAgents = await native('agentLifecycle', 'closeOpenClawAgentDatabasesAsync');
  closeState = await native('stateLifecycle', 'closeOpenClawStateDatabaseAsync');
  (await native('schemaContracts', 'prepareOpenClawDatabaseSchemaContracts'))();
  const lock = await native('maintenanceLock', 'withDoctorSqliteMaintenanceLock');
  const readScope = await native('readScope', 'withSqliteReadOnlyWorkerScope');
  await readScope(async () => lock({ env: process.env, operation: 'data directory relocation', run: async authority => {
    const preflight = await native('preflight', 'prepareDoctorDatabasePreflight');
    const report = await preflight({ cfg, preserveSourceArtifacts: true });
    for (const field of ['incompatible', 'indeterminate', 'agentRefusals', 'deferredSchemaPublications', 'pendingMigrations'])
      assert.deepEqual(report[field] ?? [], [], 'Source native schemas must already be ready.');
    const discovery = report.agentDatabaseMigrationDiscovery?.discovery;
    assert.deepEqual(discovery?.failures ?? [], [], 'Source native inventory is incomplete.');
    assert.deepEqual(discovery?.unverifiedTargets ?? [], [], 'Source native inventory has an unknown owner.');
    const statePath = (await native('paths', 'resolveOpenClawStateSqlitePath'))(process.env);
    const quarantinePath = (await native('storagePaths', 'resolveQuarantineStorePath'))(process.env);
    assert.ok(fs.existsSync(statePath) || !(discovery?.targets ?? []).length, 'Agent history exists without native shared state.');
    const files = [...new Set([...(discovery?.targets ?? []).map(row => row.path),
      ...[statePath, quarantinePath].filter(file => fs.existsSync(file))])];
    const identities = files.map(file => {
      relativeOwned(file);
      const real = fs.realpathSync.native(file);
      relativeOwned(real);
      const stat = fs.lstatSync(file, { bigint: true });
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'Native database must be an owned regular file.');
      return { file, real, dev: stat.dev, ino: stat.ino };
    });
    const assertSources = () => {
      current(); authority.assertCurrent(); assertConfig();
      for (const row of identities) {
        const stat = fs.lstatSync(row.file, { bigint: true });
        assert.ok(stat.isFile() && stat.nlink === 1n && stat.dev === row.dev && stat.ino === row.ino &&
          fs.realpathSync.native(row.file) === row.real, 'Native source identity changed.');
      }
    };
    const protect = async maintenance => {
      const assertHeld = () => { assertSources(); maintenance?.assertOwned(); };
      const plugins = await inspectManagedPluginRelocation(cfg);
      const snapshot = await native('snapshot', 'createVerifiedSqliteSnapshot');
      const sanitizer = await native('sanitizer', 'sanitizeOpenClawStateLeaseRows');
      const replacements = {};
      const excluded = [];
      for (const [index, file] of files.entries()) {
        assertHeld();
        const target = path.join(snapshotDir, String(index) + '.sqlite');
        const saved = await snapshot({ sourcePath: file, targetPath: target, preserveRowIds: true,
          transform: sanitizer, beforePublish: assertHeld });
        assertHeld();
        assert.equal(saved.path, target);
        replacements[relativeOwned(file)] = target;
        for (const suffix of ['-wal', '-shm', '-journal']) excluded.push(relativeOwned(file + suffix));
      }
      const paths = (await native('gatewayPaths', 'resolveGatewayLockPaths'))(process.env);
      for (const file of [paths.configLockPath, paths.stateLockPath, paths.ownerLockPath]) {
        const relative = path.relative(profileRoot, file);
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) excluded.push(relative);
      }
      assertHeld();
      plugins.assertLinks();
      send({ type: 'held', identity: { runtimeBuildId: identity.runtimeBuildId },
        replaceFiles: replacements, excludeRelativePaths: excluded,
        managedPlugins: { paths: plugins.paths, peers: plugins.peers } });
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            // Native owners maintain their leases while we wait for a request.
            if (check === undefined && !releasing) { current(); return; }
            assertHeld();
            plugins.assertLinks();
            if (check !== undefined) {
              send({ type: 'healthy', id: check });
              check = undefined;
            }
            if (releasing) { clearInterval(timer); resolve(); }
          } catch (error) { clearInterval(timer); reject(error); }
        }, 100);
      });
    };
    assertSources();
    if (fs.existsSync(statePath)) {
      const lease = await native('lease', 'withAgentDatabaseMaintenanceLease');
      await lease({ env: process.env, schemaPolicy: 'existing', processBound: true }, protect);
    } else await protect();
    assertSources();
  }}), { signal: cancelled.signal, deadlineOwnedByCaller: true });
} catch (error) { failure = error; }
finally {
  for (const close of [closeAgents, closeState]) {
    try { await close?.(); }
    catch (error) { failure ??= error; }
  }
}
if (failure || !releasing || cancelled.signal.aborted) {
  send({ type: 'failure', ...relocationNativeFailureDetails(failure, [profileRoot, snapshotDir]) });
  process.exitCode = 1;
} else send({ type: 'released' });
if (process.connected) process.disconnect();
`;

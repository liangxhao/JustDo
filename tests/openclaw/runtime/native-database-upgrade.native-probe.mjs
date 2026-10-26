// Real native maintenance, isolated synthetic databases. Never starts a Gateway or reads user history.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const expectedVersion = `v${require('../../../package.json').openclaw.version.replace(/^v/u, '')}`;
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeRoot = fs.realpathSync(process.argv[2]);
const upstream = path.resolve(process.argv[3]);
const archivedDiagnostic = process.argv.includes('--archived-diagnostic');
const { verifyFrozenOpenClawRuntime, verifyOpenClawPatchManifest } = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const manifest = archivedDiagnostic
  ? verifyFrozenOpenClawRuntime(runtimeRoot, { expectedVersion, requireBundle: true }).manifest
  : verifyOpenClawPatchManifest(runtimeRoot, { expectedVersion, requireBundle: true });
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtimeRoot, 'node-runtime/node.exe')));
const evidenceRoot = path.resolve('.agent-tasks/runtime/native-database-upgrade');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidenceDir = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
const build = require('esbuild');
const compiled = path.join(evidenceDir, 'nativeDatabaseUpgradeRuntime.cjs');
await build.build({ entryPoints: [path.join(repository, 'src/main/startup/upgrade/nativeDatabaseUpgradeRuntime.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: compiled });
const { NativeDatabaseUpgradeRuntime } = require(compiled);
const identityModule = path.join(evidenceDir, 'nativeDatabaseIdentity.cjs');
await build.build({ entryPoints: [path.join(repository, 'src/main/startup/upgrade/nativeDatabaseIdentity.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: identityModule });
const { admitNativeDatabaseRuntime } = require(identityModule);
const asar = require('@electron/asar');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const contract = JSON.parse(fs.readFileSync(path.join(repository, 'src/main/startup/upgrade/nativeDatabaseContract.json')));
for (const module of Object.values(contract.modules)) {
  const bytes = fs.readFileSync(path.join(runtimeRoot, module.path));
  assert.equal(digest(bytes), module.sha256);
  assert.ok(asar.extractFile(path.join(runtimeRoot, 'gateway.asar'), module.path).equals(bytes));
}
const identity = { runtimeRoot, executable: process.execPath, runtimeVersion: manifest.openclawVersion,
  runtimeBuildId: digest(fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'))),
  manifestSha256: digest(fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'))), schemaVersions: contract.schemaVersions };
const report = { identity, scope: archivedDiagnostic
  ? 'current Main adapter + immutable archived native owners; excludes current recipe/fresh artifact acceptance'
  : 'current Main adapter + strictly admitted final native artifact', checks: [] };
const profiles = [];
let activeProfile;
for (const key of Object.keys(process.env)) if (/^OPENCLAW_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete process.env[key];
const currentConfig = { agents: { ownership: 'explicit', entries: { main: {} }, defaults: { systemAgent: { agentId: 'main' } } }, plugins: { enabled: false } };
function profile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-database-upgrade-'));
  profiles.push(root); activeProfile = root;
  Object.assign(process.env, { OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_NO_RESPAWN: '1' });
  return { root, env: { ...process.env }, config: path.join(root, 'openclaw.json') };
}
profile();
async function owner(file, symbol) {
  const source = fs.readFileSync(path.join(runtimeRoot, 'dist', file), 'utf8');
  assert.ok(asar.extractFile(path.join(runtimeRoot, 'gateway.asar'), 'dist/' + file).equals(Buffer.from(source)));
  const tail = source.slice(source.lastIndexOf('\nexport {'));
  const match = tail.match(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]'));
  assert.ok(match, symbol);
  return (await import(pathToFileURL(path.join(runtimeRoot, 'dist', file)).href))[match[1] ?? symbol];
}
const prepare = await owner('openclaw-database-schema-contracts-DxUwD7Ji.mjs', 'prepareOpenClawDatabaseSchemaContracts'); prepare();
const openState = await owner('openclaw-state-db-RDcuGEfu.mjs', 'openOpenClawStateDatabase');
const openAgent = await owner('openclaw-agent-db-aORp2dHQ.mjs', 'openOpenClawAgentDatabase');
const closeAgents = await owner('openclaw-agent-db-lifecycle-BQIr8Oj2.mjs', 'closeOpenClawAgentDatabasesAsync');
const closeState = await owner('openclaw-state-db-cache-Cv7NmmpS.mjs', 'closeOpenClawStateDatabaseAsync');
const fixture24 = path.join(upstream, 'test/fixtures/sqlite/openclaw-agent-schema-v24.sql');
assert.equal(digest(fs.readFileSync(fixture24)), 'dde8e6165f12b428f9fdbae0e8e4ce4d76802fc2f6f0443232b7a303bd6fe087');
function adapter(p, extra = {}) {
  const deps = { getRuntimeRoot: () => runtimeRoot, stateDir: p.root, configPath: p.config, gatewayStopped: () => true,
    spawn: (...args) => {
      const child = spawn(...args);
      const capture = fs.createWriteStream(path.join(evidenceDir, 'native-child-' + child.pid + '.log'));
      child.stdout?.on('data', chunk => capture.write(chunk));
      child.stderr?.on('data', chunk => capture.write(chunk)); child.once('close', () => capture.end());
      return child;
    }, ...extra };
  // Old artifacts are admitted only for this explicitly labelled diagnostic; production has no such fallback.
  if (archivedDiagnostic) deps.admit = async () => identity;
  else deps.admit = root => admitNativeDatabaseRuntime(root, { readArchiveModule: async (archive, file) => asar.extractFile(archive, file) });
  return new NativeDatabaseUpgradeRuntime(deps);
}
async function seed(version = 24) {
  const p = profile(); fs.writeFileSync(p.config, JSON.stringify(currentConfig));
  const shared = openState({ env: p.env }); p.shared = shared.path;
  await closeState();
  p.agent = path.join(p.root, 'agents/main/agent/openclaw-agent.sqlite'); fs.mkdirSync(path.dirname(p.agent), { recursive: true });
  const sql = version === 24 ? fs.readFileSync(fixture24, 'utf8')
    : fs.readFileSync(path.join(upstream, 'test/fixtures/sqlite/openclaw-agent-schema-v22.sql'), 'utf8');
  const db = new DatabaseSync(p.agent);
  try {
    db.exec(sql); db.exec('PRAGMA user_version=' + version);
    db.prepare("INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES('primary','agent',?,'main',1,1)").run(version);
    db.exec(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES('agent:main:main','fixture-history','{"sessionId":"fixture-history","updatedAt":1}',1);
      INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES('fixture-history','agent:main:main',1,1)`);
    db.prepare('INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)').run('fixture-history', 0,
      JSON.stringify({ type: 'message', id: 'synthetic-message', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic preserved database history' }] } }), 1);
  } finally { db.close(); }
  return p;
}
function inspectSeed(p) {
  const db = new DatabaseSync(p.agent, { readOnly: true });
  try { return { version: db.prepare('PRAGMA user_version').get().user_version,
    sid: db.prepare('SELECT current_session_id FROM session_nodes').get().current_session_id,
    event: db.prepare('SELECT event_json FROM transcript_events WHERE session_id=?').get('fixture-history').event_json }; }
  finally { db.close(); }
}
try {
  // Exercise real installer shape: no duplicate gateway.asar. Only Main admission runs
  // here; this selected-owner fixture does not claim a complete executable dependency graph.
  const packed = fs.mkdtempSync(path.join(os.tmpdir(), 'native-database-packed-admission-')); profiles.push(packed);
  for (const file of new Set(['package.json', 'runtime-build-info.json', 'runtime-patch-manifest.json', 'npm-shrinkwrap.json',
    'gateway-bundle.mjs', 'node-runtime/node-runtime-manifest.json', path.relative(runtimeRoot, process.execPath),
    ...Object.values(contract.modules).map(module => module.path)])) {
    const target = path.join(packed, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(runtimeRoot, file), target);
  }
  if (archivedDiagnostic) {
    // An explicit diagnostic producer-proof fixture, never a modification or acceptance of the old artifact.
    const canonical = value => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
    const copiedManifest = JSON.parse(fs.readFileSync(path.join(packed, 'runtime-patch-manifest.json')));
    copiedManifest.nativeDatabaseOwners = { contractSha256: digest(JSON.stringify(canonical(contract))),
      modules: Object.entries(contract.modules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([role, module]) => ({ role, ...module })) };
    fs.writeFileSync(path.join(packed, 'runtime-patch-manifest.json'), JSON.stringify(copiedManifest));
  }
  assert.equal(fs.existsSync(path.join(packed, 'gateway.asar')), false);
  assert.equal((await admitNativeDatabaseRuntime(packed)).runtimeVersion, expectedVersion);
  fs.appendFileSync(path.join(packed, contract.modules.agent.path), '\n// controlled copied-owner mutation');
  await assert.rejects(() => admitNativeDatabaseRuntime(packed), /missing or inconsistent/);
  report.checks.push('real packed-shape selected-owner admission without duplicate ASAR succeeds; copied native-owner tampering still refuses');

  const expected25 = { version: 25, sid: 'fixture-history', event: JSON.stringify({ type: 'message', id: 'synthetic-message', parentId: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic preserved database history' }] } }) };
  const fresh = profile(); const a = adapter(fresh); const before = fs.readdirSync(fresh.root);
  await assert.doesNotReject(() => a.identity());
  assert.deepEqual(await a.inspect(), { needsUpgrade: false });
  assert.deepEqual(fs.readdirSync(fresh.root), before, 'fresh inspection does not initialize configuration or databases');
  const state = openState({ env: fresh.env }); assert.equal(state.db.prepare('PRAGMA user_version').get().user_version, 20);
  const agent = openAgent({ env: fresh.env, agentId: 'main' }); assert.equal(agent.db.prepare('PRAGMA user_version').get().user_version, 25);
  await closeAgents(); await closeState();
  assert.deepEqual(await adapter(fresh).inspect(), { needsUpgrade: false });
  const reopened = openAgent({ env: fresh.env, agentId: 'main' }); assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 25);
  await closeAgents(); await closeState();
  report.checks.push('fresh no-write inspect; native create shared20/agent25; joined close, actual startup readiness and reopen25');

  const old = await seed(); const configBefore = fs.readFileSync(old.config); const oldBytes = fs.readFileSync(old.agent);
  const upgrade = adapter(old); assert.deepEqual(await upgrade.inspect(), { needsUpgrade: true });
  assert.ok(fs.readFileSync(old.agent).equals(oldBytes), 'routing inspection preserves schema24 bytes');
  const activities = []; await upgrade.upgrade(activity => activities.push(activity));
  assert.ok(activities.includes('nativeBackup') && activities.includes('nativeUpgrade') && activities.includes('nativeVerify'));
  assert.deepEqual(inspectSeed(old), expected25);
  assert.ok(fs.readFileSync(old.config).equals(configBefore));
  const backups = fs.readdirSync(path.dirname(old.agent)).filter(file => file.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const saved = new DatabaseSync(path.join(path.dirname(old.agent), backups[0]), { readOnly: true });
  try { assert.equal(saved.prepare('PRAGMA user_version').get().user_version, 24); }
  finally { saved.close(); }
  assert.deepEqual(await adapter(old).inspect(), { needsUpgrade: false });
  await adapter(old).upgrade();
  assert.deepEqual(inspectSeed(old), expected25);
  assert.equal(fs.readdirSync(path.dirname(old.agent)).filter(file => file.endsWith('.bak')).length, 1);
  report.checks.push('real v24 source fixture → native full backup group → native schema25; preserved identity/config; exact readiness; rerun does not replace original backup');

  for (const kind of ['older', 'newer', 'corrupt']) {
    const p = await seed(kind === 'older' ? 22 : 24);
    if (kind === 'newer') { const db = new DatabaseSync(p.agent); db.exec('PRAGMA user_version=26; UPDATE schema_meta SET schema_version=26'); db.close(); }
    if (kind === 'corrupt') fs.writeFileSync(p.agent, 'deliberately invalid synthetic database');
    const before = fs.readFileSync(p.agent); await assert.rejects(() => adapter(p).inspect());
    if (kind !== 'corrupt') await assert.rejects(() => adapter(p).inspect(), error => error.code === 'STARTUP_NATIVE_SCHEMA_UNSUPPORTED');
    await assert.rejects(() => adapter(p).upgrade());
    assert.ok(fs.readFileSync(p.agent).equals(before));
    assert.equal(fs.readdirSync(p.root, { recursive: true }).filter(file => file.endsWith('.bak')).length, 0);
  }
  for (const version of [19,21]) {
    const p = await seed(); const db = new DatabaseSync(p.shared);
    db.exec('PRAGMA user_version=' + version + '; UPDATE schema_meta SET schema_version=' + version); db.close();
    const bytes = fs.readFileSync(p.shared); await assert.rejects(() => adapter(p).inspect());
    await assert.rejects(() => adapter(p).upgrade());
    assert.ok(fs.readFileSync(p.shared).equals(bytes));
    assert.equal(fs.readdirSync(p.root, { recursive: true }).filter(file => file.endsWith('.bak')).length, 0);
  }
  report.checks.push('genuine agent22/future26/corrupt and shared19/21 refuse before any backup; typed agent-version refusals preserve original bytes');

  const leased = await seed();
  fs.writeFileSync(leased.config, JSON.stringify({ ...currentConfig, agents: { ...currentConfig.agents, entries: { main: {}, worker: {} } } }));
  openAgent({ env: leased.env, agentId: 'worker' });
  try {
    const live = adapter(leased); await live.inspect(); const activities = [];
    await assert.rejects(() => live.upgrade(value => activities.push(value)), error => {
      assert.equal(error.code, undefined, 'native active-lease refusal has no typed errno'); return true;
    });
    assert.ok(!activities.includes('nativeBackup'), 'active native writer must refuse before creating a backup group');
    assert.equal(fs.readdirSync(path.dirname(leased.agent)).filter(file => file.endsWith('.bak')).length, 0);
    assert.deepEqual(inspectSeed(leased), { ...expected25, version: 24 });
  } finally { await closeAgents(); await closeState(); }
  await adapter(leased).upgrade(); assert.deepEqual(inspectSeed(leased), expected25);
  report.checks.push('real embedded native worker lease refuses before any backup/schema mutation; after joined release the explicit retry completes');

  const busy = await seed(); const busyRuntime = adapter(busy); await busyRuntime.inspect();
  const busyDb = new DatabaseSync(busy.shared); busyDb.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(() => busyRuntime.upgrade(), error => {
      assert.equal(error.code, 'SQLITE_BUSY', 'actual structured native SQLite busy reaches startup advice'); return true;
    });
    assert.deepEqual(inspectSeed(busy), { ...expected25, version: 24 });
    assert.equal(fs.readdirSync(path.dirname(busy.agent)).filter(file => file.endsWith('.bak')).length, 0);
  } finally { busyDb.exec('ROLLBACK'); busyDb.close(); }
  const free = adapter(busy); await free.inspect(); await free.upgrade(); assert.deepEqual(inspectSeed(busy), expected25);
  report.checks.push('actual shared SQLite busy transaction refuses with no agent backup/schema change; joined release then explicit native retry succeeds');

  const rollback = await seed();
  const lock = await owner(path.basename(contract.modules.maintenanceLock.path), 'withDoctorSqliteMaintenanceLock');
  const lease = await owner(path.basename(contract.modules.lease.path), 'withAgentDatabaseMaintenanceLease');
  const migrate = await owner(path.basename(contract.modules.migration.path), 'migrateOpenClawAgentDatabaseForMaintenance');
  const getScope = await owner(path.basename(contract.modules.resourceScope.path), 'getOpenClawDatabaseMaintenanceScope');
  const backup = await owner(path.basename(contract.modules.backup.path), 'backupDoctorSqliteDatabases');
  let checks = 0;
  await assert.rejects(() => lock({ env: rollback.env, operation: 'synthetic native transaction rollback', protectedPaths: [rollback.shared, rollback.agent],
    run: async authority => lease({ env: rollback.env, schemaPolicy: 'existing', processBound: true }, async maintenance => {
      await backup({ env: rollback.env, pendingDatabasePaths: [rollback.agent, rollback.shared], databasePaths: [rollback.agent, rollback.shared], authority, requireSnapshots: true });
      getScope().addAgentSchemaMigrationCheck(() => { if (++checks === 2) throw new Error('controlled native transaction custody loss'); });
      await migrate({ agentId: 'main', pathname: rollback.agent }, maintenance);
    }) }), /controlled native transaction custody loss/);
  await closeAgents(); await closeState(); assert.ok(checks >= 2);
  assert.deepEqual(inspectSeed(rollback), { ...expected25, version: 24 });
  const retainedBackup = fs.readdirSync(path.dirname(rollback.agent)).find(file => file.endsWith('.bak'));
  const retainedBytes = fs.readFileSync(path.join(path.dirname(rollback.agent), retainedBackup));
  const retry = adapter(rollback); await retry.inspect(); await retry.upgrade();
  assert.deepEqual(inspectSeed(rollback), expected25);
  assert.ok(fs.readFileSync(path.join(path.dirname(rollback.agent), retainedBackup)).equals(retainedBytes));
  report.checks.push('actual native end-of-transaction authority loss rolls schema25 publication back to24; native original backup retained and Main explicit reinspection/retry succeeds');

  const interrupted = await seed(); const interruptedRuntime = adapter(interrupted); await interruptedRuntime.inspect();
  let stop; await assert.rejects(() => interruptedRuntime.upgrade(activity => {
    if (activity === 'nativeBackup' && !stop) stop = interruptedRuntime.stop();
  }), /interrupted|unconfirmed/);
  await stop;
  const observed = inspectSeed(interrupted); assert.ok([24,25].includes(observed.version)); assert.equal(observed.sid, 'fixture-history');
  const recovered = adapter(interrupted); await recovered.inspect(); await recovered.upgrade();
  assert.deepEqual(inspectSeed(interrupted), expected25);
  report.checks.push('real IPC cancellation joins own child and returns unknown; fresh inspection then explicit retry reconciles24/25 and preserves identity');
} catch (error) {
  report.failure = { message: error.message, stack: error.stack, activeProfile }; throw error;
} finally {
  const errors = [];
  for (const close of [closeAgents, closeState]) try { await close(); } catch (error) { errors.push(String(error)); }
  report.profiles = profiles; report.cleanClose = errors.length === 0;
  if (errors.length) report.cleanupFailures = errors;
  fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log('NATIVE_DATABASE_UPGRADE=' + JSON.stringify({ evidenceDir, ...report }));
  if (errors.length) throw new Error('Native database fixture cleanup failed.');
}

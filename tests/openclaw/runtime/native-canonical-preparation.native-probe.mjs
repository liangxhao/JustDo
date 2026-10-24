// Actual application child + unchanged native owners, using only isolated synthetic databases.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeRoot = fs.realpathSync(process.argv[2]);
const archivedDiagnostic = process.argv.includes('--archived-diagnostic');
const observe = process.argv.indexOf('--observe');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtimeRoot, 'node-runtime/node.exe')));
for (const key of Object.keys(process.env))
  if (/^OPENCLAW_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete process.env[key];
const asar = require('@electron/asar');
const contract = JSON.parse(fs.readFileSync(path.join(repository, 'src/main/startup/upgrade/nativeDatabaseContract.json')));
async function owner(file, symbol) {
  const relative = 'dist/' + file;
  const bytes = fs.readFileSync(path.join(runtimeRoot, relative));
  assert.ok(asar.extractFile(path.join(runtimeRoot, 'gateway.asar'), relative).equals(bytes));
  const source = bytes.toString();
  const tail = source.slice(source.lastIndexOf('\nexport {'));
  const matches = [...tail.matchAll(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]', 'g'))];
  assert.equal(matches.length, 1, symbol);
  return (await import(pathToFileURL(path.join(runtimeRoot, relative)).href))[matches[0][1] ?? symbol];
}
function bind(root) {
  Object.assign(process.env, { OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_NO_RESPAWN: '1' });
  return { root, env: { ...process.env }, config: path.join(root, 'openclaw.json'),
    agent: path.join(root, 'agents/main/agent/openclaw-agent.sqlite'), shared: path.join(root, 'state/openclaw.sqlite') };
}
if (observe >= 0) {
  const p = bind(path.resolve(process.argv[observe + 1]));
  const options = { agentId: process.argv[observe + 3] ?? 'main', env: p.env,
    ...(process.argv[observe + 2] !== '-' ? { path: path.resolve(process.argv[observe + 2]) } : {}) };
  const prepare = await owner('openclaw-database-schema-contracts-DxUwD7Ji.mjs', 'prepareOpenClawDatabaseSchemaContracts'); prepare();
  const open = await owner('openclaw-agent-db-readonly-open-BCj4NoY3.mjs', 'openOpenClawAgentDatabaseReadOnly');
  const ready = await owner('openclaw-agent-db-validation-cache-BNrrZWI-.mjs', 'hasOpenClawAgentCanonicalValidation');
  const validation = await owner('openclaw-agent-db-validation-cache-BNrrZWI-.mjs', 'getOpenClawAgentDatabaseValidation');
  const pending = await owner('session-canonical-validation-niO-sagy.mjs', 'hasPendingCanonicalSessionValidation');
  const certify = await owner('session-canonical-validation-readiness-C_kdXYHx.mjs', 'certifySessionCanonicalValidationPending');
  const closeAgents = await owner('openclaw-agent-db-lifecycle-CsUDPIt5.mjs', 'closeOpenClawAgentDatabasesAsync');
  const closeState = await owner('openclaw-state-db-cache-C8EtTs-m.mjs', 'closeOpenClawStateDatabaseAsync');
  const read = open(options); assert.equal(read.found, true);
  const value = { ready: ready(read.database), pending: pending(read.database), integrityReceipt: !!validation(read.database), workers: 0 };
  read.database.close();
  const undispatched = new Error('test observed native worker admission');
  try { await certify(options, async () => { value.workers++; throw undispatched; }); }
  catch (error) { if (error !== undispatched) throw error; }
  await closeAgents(); await closeState();
  console.log('CANONICAL_OBSERVATION=' + JSON.stringify(value));
} else {
  const evidenceRoot = path.join(repository, '.agent-tasks/runtime/native-canonical-preparation');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
  const verifier = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
  // Diagnostic mode never accepts an archived artifact as a current production build.
  const manifest = archivedDiagnostic
    ? verifier.verifyFrozenOpenClawRuntime(runtimeRoot, { expectedVersion: 'v2026.10.6', requireBundle: true }).manifest
    : verifier.verifyOpenClawPatchManifest(runtimeRoot, { expectedVersion: 'v2026.10.6', requireBundle: true });
  for (const selected of Object.values(contract.modules)) {
    const bytes = fs.readFileSync(path.join(runtimeRoot, selected.path));
    assert.equal(digest(bytes), selected.sha256);
    assert.ok(asar.extractFile(path.join(runtimeRoot, 'gateway.asar'), selected.path).equals(bytes));
  }
  const identity = { runtimeRoot, executable: process.execPath, runtimeVersion: manifest.openclawVersion,
    runtimeBuildId: digest(fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'))),
    manifestSha256: digest(fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'))), schemaVersions: contract.schemaVersions };
  const startedAt = Date.now();
  const report = { identity, children: [], scope: archivedDiagnostic
    ? 'diagnostic: current production source/transport + archived frozen native modules; excludes current 18-owner producer admission'
    : 'strict current artifact admission + actual application source/transport + unchanged native owners', checks: [], profiles: [] };
  const build = require('esbuild');
  const compiled = path.join(evidence, 'adapter.cjs');
  await build.build({ entryPoints: [path.join(repository, 'src/main/startup/upgrade/nativeDatabaseUpgradeRuntime.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: compiled });
  const { NativeDatabaseUpgradeRuntime } = require(compiled);
  const admission = path.join(evidence, 'admission.cjs');
  await build.build({ entryPoints: [path.join(repository, 'src/main/startup/upgrade/nativeDatabaseIdentity.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: admission });
  const { admitNativeDatabaseRuntime } = require(admission);
  const cfg = { agents: { ownership: 'explicit', entries: { main: {} }, defaults: { systemAgent: { agentId: 'main' } } }, plugins: { enabled: false } };
  bind(fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-import-')));
  const prepare = await owner('openclaw-database-schema-contracts-DxUwD7Ji.mjs', 'prepareOpenClawDatabaseSchemaContracts'); prepare();
  const openState = await owner('openclaw-state-db-C4vt0QCr.mjs', 'openOpenClawStateDatabase');
  const openAgent = await owner('openclaw-agent-db-DwWR59YS.mjs', 'openOpenClawAgentDatabase');
  const write = await owner('openclaw-agent-db-DwWR59YS.mjs', 'runOpenClawAgentWriteTransaction');
  const revoke = await owner('openclaw-agent-db-validation-cache-BNrrZWI-.mjs', 'invalidateOpenClawAgentCanonicalValidation');
  const closeAgents = await owner('openclaw-agent-db-lifecycle-CsUDPIt5.mjs', 'closeOpenClawAgentDatabasesAsync');
  const closeState = await owner('openclaw-state-db-cache-C8EtTs-m.mjs', 'closeOpenClawStateDatabaseAsync');
  const rowEvent = JSON.stringify({ type: 'message', id: 'synthetic-message', parentId: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic canonical preservation fixture.' }] } });
  async function seed() {
    const p = bind(fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-preparation-'))); report.profiles.push(p.root);
    fs.writeFileSync(p.config, JSON.stringify(cfg));
    const state = openState({ env: p.env }); assert.equal(state.db.prepare('PRAGMA user_version').get().user_version, 20);
    const agent = openAgent({ env: p.env, agentId: 'main' });
    assert.equal(agent.db.prepare('PRAGMA user_version').get().user_version, 25);
    agent.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = agent.db.prepare('INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES(?,?,?,1,1)');
      for (let n = 0; n < 260; n++) {
        const sid = 'synthetic-' + n;
        insert.run('agent:main:' + sid, sid, JSON.stringify({ sessionId: sid, updatedAt: 1 }));
      }
      agent.db.exec("INSERT INTO session_canonical_validation_pending SELECT session_key FROM session_nodes; INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES('synthetic-0','agent:main:synthetic-0',1,1)");
      agent.db.prepare('INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)').run('synthetic-0', 0, rowEvent, 1);
      agent.db.exec('COMMIT');
    } catch (error) { agent.db.exec('ROLLBACK'); throw error; }
    await closeAgents(); await closeState(); return p;
  }
  function adapter(p, preload) {
    return new NativeDatabaseUpgradeRuntime({ getRuntimeRoot: () => runtimeRoot, stateDir: p.root, configPath: p.config,
      gatewayStopped: () => true, ...(archivedDiagnostic ? { admit: async () => identity }
        : { admit: root => admitNativeDatabaseRuntime(root, { readArchiveModule: async (archive, file) => asar.extractFile(archive, file) }) }),
      spawn: (exe, args, options) => {
        const childStartedAt = Date.now();
        const operation = JSON.parse(args.at(-1)).operation;
        const child = spawn(exe, [...(preload ? ['--import', preload] : []), ...args], options);
        const log = fs.createWriteStream(path.join(evidence, 'child-' + child.pid + '.log'));
        child.stdout?.on('data', bytes => log.write(bytes)); child.stderr?.on('data', bytes => log.write(bytes));
        child.once('close', (code, signal) => {
          report.children.push({ pid: child.pid, operation, elapsedMs: Date.now() - childStartedAt, code, signal });
          log.end();
        }); return child;
      } });
  }
  function observeFresh(p, file = '-', agentId = 'main') {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), runtimeRoot, '--observe', p.root, file, agentId],
      { encoding: 'utf8', timeout: 30000, env: process.env });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.signal, null);
    const match = result.stdout.match(/CANONICAL_OBSERVATION=(.+)/); assert.ok(match, result.stdout + result.stderr);
    return JSON.parse(match[1]);
  }
  function history(p) {
    const db = new DatabaseSync(p.agent, { readOnly: true });
    try { return { schema: db.prepare('PRAGMA user_version').get().user_version,
      nodes: db.prepare('SELECT session_key,current_session_id,entry_json FROM session_nodes ORDER BY session_key').all(),
      event: db.prepare('SELECT event_json FROM transcript_events WHERE session_id=?').get('synthetic-0').event_json }; }
    finally { db.close(); }
  }
  const backups = p => [path.dirname(p.agent), path.dirname(p.shared)].flatMap(dir => fs.readdirSync(dir)
    .filter(file => file.endsWith('.bak')).map(file => path.join(dir, file)));
  try {
    const empty = bind(fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-empty-'))); report.profiles.push(empty.root);
    const beforeEmpty = fs.readdirSync(empty.root);
    await adapter(empty).inspect(); await adapter(empty).prepareCanonical();
    assert.deepEqual(fs.readdirSync(empty.root), beforeEmpty);
    report.checks.push('empty fleet preparation does not create configuration, state, or backup');
    const p = await seed(); const before = history(p); const configBytes = fs.readFileSync(p.config);
    assert.deepEqual(observeFresh(p), { ready: false, pending: true, integrityReceipt: false, workers: 1 });
    const a = adapter(p); assert.deepEqual(await a.inspect(), { needsUpgrade: false });
    const activities = []; await a.prepareCanonical(activity => activities.push(activity));
    assert.ok(activities.includes('nativeBackup'));
    assert.deepEqual(history(p), before); assert.ok(fs.readFileSync(p.config).equals(configBytes));
    const saved = backups(p); assert.equal(saved.length, 2);
    const originalBytes = saved.map(file => ({ file, sha256: digest(fs.readFileSync(file)) }));
    const prior = { root: p.root, agent: saved.find(file => path.dirname(file) === path.dirname(p.agent)) };
    assert.deepEqual(history(prior), before, 'the native snapshot precedes canonical writing and preserves history');
    const savedAgent = new DatabaseSync(prior.agent, { readOnly: true });
    try {
      assert.equal(savedAgent.prepare('SELECT count(*) AS count FROM session_canonical_validation_pending').get().count, 260);
      assert.equal(savedAgent.prepare('SELECT canonical_ready FROM session_key_contract WHERE id=1').get().canonical_ready, null);
    } finally { savedAgent.close(); }
    const freshObservation = observeFresh(p);
    assert.deepEqual(freshObservation, { ready: true, pending: false, integrityReceipt: false, workers: 0 });
    const again = adapter(p); await again.inspect(); const noBackup = [];
    await again.prepareCanonical(activity => noBackup.push(activity));
    assert.ok(!noBackup.includes('nativeBackup')); assert.deepEqual(history(p), before);
    assert.deepEqual(saved.map(file => ({ file, sha256: digest(fs.readFileSync(file)) })), originalBytes);
    report.checks.push('actual SOURCE and transport: full native backup precedes canonical writes; joined new process accepts persisted proof, rerun dispatches zero workers/backups and preserves rows/events/config');
    const copied = path.join(p.root, 'copied.sqlite'); fs.copyFileSync(p.agent, copied);
    assert.deepEqual(observeFresh(p, copied), { ready: false, pending: false, integrityReceipt: false, workers: 1 });
    const replacement = path.join(p.root, 'replacement.sqlite'); fs.copyFileSync(p.agent, replacement);
    fs.renameSync(p.agent, p.agent + '.preserved'); fs.renameSync(replacement, p.agent);
    assert.deepEqual(observeFresh(p), { ready: false, pending: false, integrityReceipt: false, workers: 1 });
    const replaced = adapter(p); await replaced.inspect(); await replaced.prepareCanonical();
    assert.equal(observeFresh(p).workers, 0);
    report.checks.push('copied bytes and same-path physical replacement cannot borrow the original native receipt; actual SOURCE certifies replacement afresh');
    bind(p.root); write(database => revoke(database), { agentId: 'main', env: p.env });
    await closeAgents(); await closeState(); assert.equal(observeFresh(p).workers, 1);
    const corruptBackup = backups(p).find(file => path.dirname(file) === path.dirname(p.shared) && !saved.includes(file));
    assert.ok(corruptBackup);
    fs.writeFileSync(corruptBackup, 'controlled invalid synthetic backup');
    const refusal = adapter(p); await refusal.inspect(); await assert.rejects(() => refusal.prepareCanonical(), /backup/i);
    assert.equal(observeFresh(p).workers, 1); assert.deepEqual(history(p), before);
    report.checks.push('native receipt revocation requires work; corrupt native original backup group refuses before any canonical write, leaves native proof unready and history unchanged');
    const late = await seed(); const lateHistory = history(late);
    const delayed = path.join(evidence, 'delay-native-commit.mjs');
    fs.writeFileSync(delayed, `import {Worker} from 'node:worker_threads';\nimport fs from 'node:fs';\nconst emit=Worker.prototype.emit;let held=false;Worker.prototype.emit=function(type,value,...args){if(!held&&type==='message'&&value?.type==='commit-request'){held=true;fs.writeFileSync(${JSON.stringify(path.join(evidence, 'delayed-commit-observed'))},'native commit request delayed beyond its 5s gate');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5400);}return Reflect.apply(emit,this,[type,value,...args]);};\n`);
    const delayedRuntime = adapter(late, pathToFileURL(delayed).href); await delayedRuntime.inspect();
    await assert.rejects(() => delayedRuntime.prepareCanonical(), /commit checkpoint expired|commit decision|commit.*refused/i);
    assert.ok(fs.existsSync(path.join(evidence, 'delayed-commit-observed')));
    assert.equal(observeFresh(late).workers, 1); assert.deepEqual(history(late), lateHistory);
    report.checks.push('real native commit request delivered after its 5s gate is refused by unchanged native authorization; actual SOURCE emits no success and preserves rows/events');
    report.passed = true;
  } catch (error) { report.failure = { message: error.message, stack: error.stack }; throw error; }
  finally {
    const closed = await Promise.allSettled([closeAgents(), closeState()]);
    report.cleanClose = closed.every(value => value.status === 'fulfilled');
    report.elapsedMs = Date.now() - startedAt;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log('NATIVE_CANONICAL_PREPARATION=' + JSON.stringify({ evidence, ...report }));
    assert.equal(report.cleanClose, true);
  }
}

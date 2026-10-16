// Real prepared-runtime storage owners; synthetic state only, no Gateway/model.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const runtime = path.resolve(process.argv[2] ?? 'vendor/openclaw-runtime/current');
const mode = process.argv[3];
const state = process.argv[4];
const dist = path.join(runtime, 'dist');
const cases = ['backup-update', 'update-rollback', 'deletion', 'error-close', 'exit', 'crash'];
const readers = new Set();

function environment(directory) {
  return {
    ...process.env,
    OPENCLAW_HOME: directory,
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json'),
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    NODE_COMPILE_CACHE: path.join(directory, '.compile-cache'),
  };
}

function initialize(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const config = {
    agents: { ownership: 'explicit', entries: { main: {}, worker: {} } },
    plugins: { allow: [], entries: {} },
    update: { checkOnStart: false, auto: { enabled: false } },
  };
  fs.writeFileSync(path.join(directory, 'openclaw.json'), JSON.stringify(config));
  return config;
}

// Resolve real export aliases from the pinned package, without modifying it or
// replacing any native owner, checkpoint, authority check, or error handler.
async function native(prefix, name) {
  const matches = [];
  for (const file of fs
    .readdirSync(dist)
    .filter(file => file.startsWith(prefix) && file.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    if (!source.includes(`function ${name}(`)) continue;
    const exports = source.slice(source.lastIndexOf('\nexport {'));
    const alias = exports.match(new RegExp(`\\b${name}(?: as (\\w+))?\\s*[,}]`));
    if (alias) matches.push({ file, alias: alias[1] ?? name });
  }
  assert.equal(matches.length, 1, `one native exported implementation: ${name}`);
  const match = matches[0];
  return (await import(pathToFileURL(path.join(dist, match.file)).href))[match.alias];
}

const agentPath = (directory, agentId = 'main') =>
  path.join(directory, 'agents', agentId, 'agent/openclaw-agent.sqlite');
const rows = database =>
  database
    .prepare('SELECT id, value FROM retirement_witness ORDER BY id')
    .all()
    .map(row => ({ ...row }));
const values = database => rows(database).map(row => row.value);

async function agent(agentId = 'main') {
  const open = await native('openclaw-agent-db-', 'openOpenClawAgentDatabase');
  return open({ agentId, path: agentPath(state, agentId), env: process.env });
}

async function closeAll() {
  await (
    await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync')
  )();
  await (
    await native('openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync')
  )();
}

function integrity(database) {
  assert.deepEqual(
    database
      .prepare('PRAGMA integrity_check')
      .all()
      .map(row => Object.values(row)[0]),
    ['ok'],
  );
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
}

function receipt(directory, pathname) {
  const quarantine = new DatabaseSync(path.join(directory, 'state/openclaw-quarantine.sqlite'), {
    readOnly: true,
  });
  const shared = new DatabaseSync(path.join(directory, 'state/openclaw.sqlite'), {
    readOnly: true,
  });
  try {
    return {
      integrity: quarantine
        .prepare('SELECT clean_close FROM agent_integrity_verifications WHERE path = ?')
        .get(pathname),
      leases: shared
        .prepare('SELECT COUNT(*) AS count FROM agent_database_leases WHERE path = ?')
        .get(pathname).count,
    };
  } finally {
    quarantine.close();
    shared.close();
  }
}

function family(pathname) {
  return ['', '-wal', '-shm', '-journal'].flatMap(suffix => {
    const file = `${pathname}${suffix}`;
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    return [
      {
        suffix,
        ino: stat.ino,
        digest: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      },
    ];
  });
}

async function pinnedAgent() {
  const database = await agent();
  database.db.exec(
    "CREATE TABLE retirement_witness(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retirement_witness VALUES(11, 'before-reader');",
  );
  const reader = new DatabaseSync(database.path, { readOnly: true });
  readers.add(reader);
  reader.exec('BEGIN');
  assert.deepEqual(values(reader), ['before-reader']);
  database.db.exec("INSERT INTO retirement_witness VALUES(29, 'after-reader')");
  const close = await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabaseByPath');
  assert.equal(close(database.path, 'main'), true);
  assert.equal(database.db.isOpen, false);
  assert.equal(database.walMaintenance.health.state, 'blocked');
  const proof = receipt(state, database.path);
  assert.notEqual(
    proof.integrity?.clean_close,
    1,
    'an incomplete checkpoint must not become a clean receipt',
  );
  assert.equal(proof.leases, 0, 'the exact closed handle must release its native lease');
  assert.deepEqual(values(reader), ['before-reader']);
  return { database, reader, proof };
}

async function backupUpdate() {
  let database, reader;
  if (mode === 'backup-update') ({ database, reader } = await pinnedAgent());
  else {
    database = await agent();
    database.db.exec(
      "CREATE TABLE retirement_witness(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retirement_witness VALUES(11, 'before-reader'), (29, 'after-reader')",
    );
    await (
      await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabaseByPath')
    )(database.path, 'main');
  }
  const snapshot = await native('sqlite-snapshot-', 'createVerifiedSqliteSnapshot');
  const targetPath = path.join(state, 'backup.sqlite');
  const backup = await snapshot({ sourcePath: database.path, targetPath });
  assert.ok(backup.sha256 && backup.sizeBytes > 0);
  const standalone = new DatabaseSync(targetPath, { readOnly: true });
  try {
    assert.deepEqual(values(standalone), ['before-reader', 'after-reader']);
    assert.equal(Object.values(standalone.prepare('PRAGMA journal_mode').get())[0], 'delete');
    integrity(standalone);
  } finally {
    standalone.close();
  }
  assert.equal(fs.existsSync(`${targetPath}-wal`), false);
  assert.equal(fs.existsSync(`${targetPath}-shm`), false);
  if (reader) assert.deepEqual(values(reader), ['before-reader']);
  await assert.rejects(snapshot({ sourcePath: database.path, targetPath }), /already exists/);

  const input = {
    backupRoot: path.join(state, 'retained-package'),
    stateDir: state,
    stagingRoot: path.join(state, 'snapshot-scratch'),
    config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8')),
    env: process.env,
  };
  fs.mkdirSync(`${input.backupRoot}.databases`);
  fs.mkdirSync(input.stagingRoot);
  const createRun = await native('update-run-ledger-', 'createUpdateRun');
  const run = createRun({ trigger: 'cli' }, { env: process.env });
  const discover = await native(
    'update-candidate-state-',
    'discoverUpdateStateSchemaInspectionInProcess',
  );
  const capture = await native('update-database-backup-', 'createUpdateDatabaseBackupInProcess');
  const updateBackup = await capture({
    ...input,
    inspectionPlan: await discover(input),
  });
  const entry = updateBackup.databases.find(entry => entry.path === database.path);
  assert.ok(entry, 'the actual update inventory must include the uncheckpointed Agent database');
  const updateCopy = new DatabaseSync(entry.snapshotPath, { readOnly: true });
  try {
    assert.deepEqual(rows(updateCopy), [
      { id: 11, value: 'before-reader' },
      { id: 29, value: 'after-reader' },
    ]);
    integrity(updateCopy);
  } finally {
    updateCopy.close();
  }

  const candidate = await agent();
  candidate.db.exec(
    "INSERT INTO retirement_witness VALUES(47, 'candidate'); CREATE TABLE candidate_only(value TEXT)",
  );
  await closeAll();
  const generations = await native('update-database-generations-', 'readUpdateDatabaseGenerations');
  // 10.4 rollback binds the complete before/after write receipt to this
  // backup. The fixture owns the synthetic candidate writes above.
  updateBackup.migration = {
    name: 'synthetic candidate writes',
    backup: updateBackup.directory,
    from: updateBackup.sourceGenerations,
    to: generations([
      ...updateBackup.databases.map(entry => entry.path),
      ...updateBackup.missingPaths,
    ]),
  };
  const restore = await native('update-command-post-update-', 'restoreFailedUpdateDatabases');
  const params = {
    backup: updateBackup,
    runId: run.runId,
    env: process.env,
    assertCurrent: () => {},
    result: { steps: [] },
  };
  const before = family(database.path);
  if (reader) {
    await assert.rejects(restore(params), error => {
      assert.match(String(error.cause), /another SQLite connection is active/);
      return true;
    });
    assert.deepEqual(
      family(database.path),
      before,
      'refused rollback must preserve the original file family',
    );
    assert.equal(fs.existsSync(`${database.path}.migrated-${run.runId}`), false);
    assert.deepEqual(values(reader), ['before-reader']);
    reader.close();

    // 10.4 fingerprints logical writes, so checkpoint-only file changes do
    // not revoke a receipt. An unreceipted writer must still revoke it.
    const laterWriter = await agent();
    laterWriter.db.exec("INSERT INTO retirement_witness VALUES(71, 'unknown-later-writer')");
    await closeAll();
    assert.equal(await restore(params), false);
    assert.equal(params.result.reason, 'state-migrated-no-rollback');
    const preserved = await agent();
    assert.deepEqual(values(preserved.db), [
      'before-reader', 'after-reader', 'candidate', 'unknown-later-writer',
    ]);
    integrity(preserved.db);
    await closeAll();
    return;
  }

  const assertUntouched = before => {
    assert.deepEqual(family(database.path), before);
    assert.equal(fs.existsSync(`${database.path}.migrated-${run.runId}`), false);
  };
  const foreign = child('hold-maintenance', state);
  try {
    const [ready] = await once(foreign.process, 'message', { signal: AbortSignal.timeout(30000) });
    assert.equal(ready.ready, true);
    const unchanged = family(database.path);
    await assert.rejects(restore(params), error => {
      assert.match(
        String(error.cause),
        /failed to acquire gateway state ownership|exclusive state ownership/i,
      );
      return true;
    });
    assertUntouched(unchanged);
    foreign.process.send('release');
    await foreign.done();
  } finally {
    await foreign.stop();
  }
  const unchanged = family(database.path);
  const stale = {
    ...params,
    backup: {
      ...updateBackup,
      migration: {
        ...updateBackup.migration,
        to: {
          ...updateBackup.migration.to,
          [database.path]: '0'.repeat(64),
        },
      },
    },
    result: { steps: [] },
  };
  assert.equal(await restore(stale), false);
  assert.equal(stale.result.reason, 'state-migrated-no-rollback');
  assertUntouched(unchanged);
  const wrongBackup = {
    ...params,
    backup: {
      ...updateBackup,
      migration: { ...updateBackup.migration, backup: updateBackup.directory + '-other' },
    },
    result: { steps: [] },
  };
  assert.equal(await restore(wrongBackup), false);
  assert.equal(wrongBackup.result.reason, 'state-migrated-no-rollback');
  assertUntouched(unchanged);
  const damaged = {
    ...params,
    backup: {
      ...updateBackup,
      databases: updateBackup.databases.map(entry => ({ ...entry, sha256: '0'.repeat(64) })),
    },
    result: { steps: [] },
  };
  await assert.rejects(restore(damaged), error => {
    assert.match(String(error.cause), /snapshot changed/);
    return true;
  });
  assertUntouched(unchanged);
  const didRestore = await restore(params);
  assert.equal(didRestore, true, JSON.stringify(params.result));
  const restored = await agent();
  assert.deepEqual(values(restored.db), ['before-reader', 'after-reader']);
  assert.equal(
    restored.db
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'candidate_only'")
      .get().count,
    0,
  );
  integrity(restored.db);
  await closeAll();
  assert.equal(receipt(state, database.path).integrity.clean_close, 1);
}

async function withMaintenance(run) {
  const acquire = await native('gateway-lock-', 'acquireGatewayLock');
  const owner = await acquire({
    env: process.env,
    role: 'sqlite-maintenance',
    allowInTests: true,
    timeoutMs: 0,
  });
  assert.ok(owner);
  try {
    return await owner.run(() => run(owner));
  } finally {
    await owner.release();
  }
}

async function deletion() {
  const { database, reader } = await pinnedAgent();
  await closeAll();
  const prepare = await native('openclaw-state-db-cache-', 'prepareOpenClawStateDatabaseRemoval');
  await assert.rejects(
    prepare(database.path, () => {}),
    /requires the installation's maintenance owner/,
  );
  await withMaintenance(async owner => {
    const before = family(database.path);
    await assert.rejects(
      prepare(database.path, () => owner.assertCurrent()),
      /another SQLite connection is active/,
    );
    assert.deepEqual(family(database.path), before);
    assert.deepEqual(values(reader), ['before-reader']);
  });
  reader.close();
  await withMaintenance(async owner => {
    const exclusion = await prepare(database.path, () => owner.assertCurrent());
    try {
      exclusion.assertCurrent();
      // This test owns only this fresh synthetic Agent file family.
      assert.ok(database.path.startsWith(`${state}${path.sep}`));
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        fs.rmSync(`${database.path}${suffix}`, { force: true });
      assert.deepEqual(family(database.path), []);
    } finally {
      exclusion.release();
    }
  });
  const recreated = await agent();
  assert.equal(
    recreated.db
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'retirement_witness'")
      .get().count,
    0,
  );
  integrity(recreated.db);
  const prepareAgentDelete = await native('agent-delete-databases-', 'prepareAgentDeleteDatabases');
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
  const foreign = child('hold-agent', state);
  try {
    const [ready] = await once(foreign.process, 'message', { signal: AbortSignal.timeout(30000) });
    assert.equal(ready.ready, true);
    const workerPath = agentPath(state, 'worker');
    const before = family(workerPath);
    await assert.rejects(
      prepareAgentDelete(config, 'worker', path.dirname(workerPath), { env: process.env }),
      error => error.name === 'OpenClawAgentDatabaseLeaseActiveError',
    );
    assert.deepEqual(family(workerPath), before);
    assert.equal(
      recreated.db.isOpen,
      true,
      'deleting another agent must not close this exact native owner',
    );
    foreign.process.send('release');
    await foreign.done();
    const plan = await prepareAgentDelete(config, 'worker', path.dirname(workerPath), {
      env: process.env,
    });
    assert.ok(plan.fileGroups.some(group => group[0] === workerPath));
    assert.ok(plan.fileGroups.flat().every(file => !file.startsWith(recreated.path)));
    assert.equal(recreated.db.isOpen, true);
  } finally {
    await foreign.stop();
  }
  await closeAll();
}

async function errorClose() {
  const database = await agent();
  database.db.close();
  assert.equal(database.walMaintenance.close(), false);
  assert.equal(database.walMaintenance.health.state, 'error');
  const close = await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabaseByPath');
  close(database.path, 'main');
  const proof = receipt(state, database.path);
  assert.notEqual(proof.integrity?.clean_close, 1);
  assert.equal(proof.leases, 0);
  await closeAll();
}

async function writer() {
  const database = await agent();
  if (!database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='retirement_witness'").get())
    database.db.exec('CREATE TABLE retirement_witness(id INTEGER PRIMARY KEY, value TEXT)');
  database.db.exec("INSERT INTO retirement_witness VALUES(29, 'after-reader')");
  if (mode === 'write-crash') {
    database.db.exec("BEGIN; INSERT INTO retirement_witness VALUES(47, 'uncommitted')");
    process.send({ ready: true });
    setInterval(() => {}, 1000);
    return;
  }
  // Native process-exit cache callbacks must close handles and preserve receipts.
  process.exit(0);
}

async function reopened() {
  const database = await agent();
  assert.deepEqual(values(database.db), ['before-reader', 'after-reader']);
  integrity(database.db);
  database.db.exec("INSERT INTO retirement_witness VALUES(61, 'continued')");
  await closeAll();
  const proof = receipt(state, database.path);
  assert.equal(proof.leases, 0);
  assert.notEqual(proof.integrity?.clean_close, 1, 'the parent still pins the old WAL snapshot');
}

function child(caseName, directory) {
  const processChild = spawn(process.execPath, [script, runtime, caseName, directory], {
    env: environment(directory),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  processChild.stdout.on('data', chunk => (output += chunk));
  processChild.stderr.on('data', chunk => (output += chunk));
  let settled = false,
    timedOut = false;
  const exited = once(processChild, 'close');
  void exited.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const kill = () => {
    if (settled || !processChild.pid) return;
    if (process.platform === 'win32')
      spawnSync('taskkill.exe', ['/PID', String(processChild.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    else {
      try {
        process.kill(-processChild.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, 120000);
  return {
    process: processChild,
    stop: async () => {
      clearTimeout(timeout);
      kill();
      await exited.catch(() => {});
    },
    done: async (expectedCode = 0, expectedSignal) => {
      try {
        const [code, signal] = await exited;
        assert.equal(timedOut, false, `${caseName} timed out`);
        assert.equal(code, expectedCode, `${caseName}: ${signal ?? ''}\n${output.slice(-6000)}`);
        if (expectedSignal) assert.equal(signal, expectedSignal);
        return output;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function restartCase(directory, caseName) {
  Object.assign(process.env, environment(directory));
  const database = await agent();
  database.db.exec(
    "CREATE TABLE retirement_witness(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retirement_witness VALUES(11, 'before-reader')",
  );
  await closeAll();
  const reader = new DatabaseSync(database.path, { readOnly: true });
  readers.add(reader);
  reader.exec('BEGIN');
  assert.deepEqual(values(reader), ['before-reader']);
  let running, reopenedChild;
  try {
    running = child(caseName === 'crash' ? 'write-crash' : 'write-exit', directory);
    if (caseName === 'crash') {
      const [message] = await once(running.process, 'message', {
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(message.ready, true);
      running.process.kill('SIGKILL');
      await running.done(null, 'SIGKILL');
    } else await running.done();
    assert.deepEqual(values(reader), ['before-reader']);
    const proof = receipt(directory, database.path);
    assert.notEqual(proof.integrity?.clean_close, 1);
    if (caseName === 'exit')
      assert.equal(
        proof.leases,
        0,
        'native exit callbacks must settle the exact lease before reopening',
      );
    reopenedChild = child('reopen', directory);
    await reopenedChild.done();
  } finally {
    await reopenedChild?.stop();
    await running?.stop();
    reader.close();
  }
  const fresh = await agent();
  assert.deepEqual(values(fresh.db), ['before-reader', 'after-reader', 'continued']);
  integrity(fresh.db);
  await closeAll();
  assert.equal(receipt(directory, database.path).integrity.clean_close, 1);
}

if (mode) {
  assert.ok(
    state &&
      path.dirname(state) === os.tmpdir() &&
      path.basename(state).startsWith('retirement-lifecycle-'),
  );
  Object.assign(process.env, environment(state));
  if (mode === 'hold-agent') {
    const held = await agent('worker');
    held.db.exec(
      "CREATE TABLE retirement_witness(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retirement_witness VALUES(11, 'foreign-owner')",
    );
    try {
      process.send({ ready: true });
      const [command] = await once(process, 'message', { signal: AbortSignal.timeout(30000) });
      assert.equal(command, 'release');
    } finally {
      await closeAll();
    }
    process.disconnect();
  } else if (mode === 'hold-maintenance') {
    await withMaintenance(async () => {
      process.send({ ready: true });
      const [command] = await once(process, 'message', { signal: AbortSignal.timeout(30000) });
      assert.equal(command, 'release');
    });
    process.disconnect();
  } else if (mode.startsWith('write-')) await writer();
  else
    try {
      if (['backup-update', 'update-rollback'].includes(mode)) await backupUpdate();
      else if (mode === 'deletion') await deletion();
      else if (mode === 'error-close') await errorClose();
      else if (mode === 'reopen') await reopened();
      else if (['exit', 'crash'].includes(mode)) await restartCase(state, mode);
      else throw new Error(`Unknown lifecycle case: ${mode}`);
      console.log(JSON.stringify({ check: mode, passed: true }));
    } finally {
      for (const reader of readers) if (reader.isOpen) reader.close();
      await closeAll();
    }
} else {
  for (const caseName of cases) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-lifecycle-'));
    initialize(directory);
    const running = child(caseName, directory);
    try {
      console.log(await running.done());
      const resolved = fs.realpathSync(directory);
      assert.equal(resolved, path.resolve(directory));
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('retirement-lifecycle-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch (error) {
      console.error(JSON.stringify({ failedCase: caseName, state: directory }));
      throw error;
    } finally {
      await running.stop();
    }
  }
  console.log(JSON.stringify({ check: 'sqlite-retirement-lifecycle', passed: cases }));
}

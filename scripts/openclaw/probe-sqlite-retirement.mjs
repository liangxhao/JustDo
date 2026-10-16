import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const nativeOnly = process.argv.includes('--native-only');
const CONTRACT = 'SQLITE_RETIREMENT_CHECKPOINT_V2026_10_4';
const runtime = path.resolve(process.argv[2] ?? 'vendor/openclaw-runtime/current');
const dist = path.join(runtime, 'dist');
const file = readdirSync(dist).find(name => /^sqlite-wal-.*\.mjs$/.test(name));
assert.ok(file, 'prepared native WAL module required');
const nativePath = path.join(dist, file);
const original = readFileSync(nativePath, 'utf8');
const alias = original.match(/configureSqliteWalMaintenance as (\w+)/)?.[1];
assert.ok(alias, 'native maintenance export required');
const nativeRequire = createRequire(nativePath);

async function check(moduleUrl, expectBlockedWrite) {
  const state = mkdtempSync(path.join(os.tmpdir(), 'wal-retirement-probe-'));
  const databasePath = path.join(state, 'database.sqlite');
  const writer = new DatabaseSync(databasePath);
  let reader, worker;
  try {
    writer.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250; CREATE TABLE work(value INTEGER); INSERT INTO work VALUES(1);',
    );
    reader = new DatabaseSync(databasePath);
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM work').all();
    writer.exec('INSERT INTO work VALUES(2)');
    worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      (async () => {
        const module = await import(workerData.moduleUrl);
        const db = new DatabaseSync(workerData.databasePath);
        try {
          const maintenance = module[workerData.alias](db, { busyTimeoutMs: 2000, checkpointIntervalMs: 0, databasePath: workerData.databasePath });
          parentPort.postMessage({ state: 'closing' });
          const start = Date.now();
          await maintenance.stop();
          const checkpointComplete = maintenance.close();
          parentPort.postMessage({ state: 'closed', checkpointComplete, elapsedMs: Date.now() - start, busyTimeout: db.prepare('PRAGMA busy_timeout').get().timeout });
        } finally { db.close(); }
      })().catch(error => { throw error; });
    `,
      { eval: true, workerData: { moduleUrl, databasePath, alias } },
    );
    const messages = [];
    const exited = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code =>
        code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)),
      );
    });
    // Attach immediately so a setup error cannot become an unhandled rejection.
    void exited.catch(() => {});
    await new Promise((resolve, reject) => {
      worker.on('message', message => {
        messages.push(message);
        if (message.state === 'closing') resolve();
      });
      worker.once('error', reject);
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    let blocked = false;
    try {
      writer.exec('BEGIN IMMEDIATE; INSERT INTO work VALUES(3); COMMIT');
    } catch (error) {
      assert.equal(
        error.errcode & 255,
        5,
        'only actual SQLite writer contention reproduces the defect',
      );
      blocked = true;
    }
    assert.equal(
      blocked,
      expectBlockedWrite,
      'retiring a reader-blocked connection must not hold the foreground writer lock',
    );
    assert.deepEqual(
      reader
        .prepare('SELECT value FROM work')
        .all()
        .map(row => row.value),
      [1],
      'the original reader keeps its snapshot',
    );
    reader.exec('ROLLBACK');
    reader.close();
    reader = undefined;
    await exited;
    const close = messages.find(message => message.state === 'closed');
    assert.ok(close);
    assert.equal(
      close.checkpointComplete,
      expectBlockedWrite,
      'a busy checkpoint remains unconfirmed until readers release',
    );
    assert.deepEqual(
      writer
        .prepare('SELECT value FROM work')
        .all()
        .map(row => row.value),
      expectBlockedWrite ? [1, 2] : [1, 2, 3],
    );
    console.log(
      JSON.stringify({
        check: expectBlockedWrite ? 'pristine-lock-reproduced' : 'nonblocking-retirement',
        state,
        foregroundWriteBlocked: blocked,
        close,
      }),
    );
  } finally {
    if (reader?.isOpen) reader.close();
    if (writer.isOpen) writer.close();
    await worker?.terminate();
  }
}

if (!original.includes(CONTRACT)) await check(pathToFileURL(nativePath).href, true);
if (!nativeOnly) {
  const { transform } = require('../patches/v2026.10.4/025-nonblocking-sqlite-retirement.cjs').__testing;
  const patched = transform(original, nativePath).replace(/from ("[^"\n]+")/g, (all, specifier) => {
    const name = JSON.parse(specifier);
    if (name.startsWith('node:')) return all;
    const target = name.startsWith('.') ? path.resolve(dist, name) : nativeRequire.resolve(name);
    return `from ${JSON.stringify(pathToFileURL(target).href)}`;
  });
  const patchedUrl = `data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`;

  await check(patchedUrl, false);
}

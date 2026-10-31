import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { DB_FILENAME } from '../../core/appConstants';
import { createHistoryBackup, verifyHistoryBackup, verifyHistorySourcesBeforeIsolation } from './historyBackup';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'history-source-fence-'));
  roots.push(source);
  const backup = path.join(source, 'backups', 'history');
  const files = {
    jsonl: path.join('openclaw', 'state', 'agents', 'main', 'sessions', 'original.jsonl'),
    index: path.join('openclaw', 'state', 'agents', 'main', 'sessions', 'sessions.json'),
    sqlite: path.join('openclaw', 'state', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'),
    media: path.join('openclaw', 'state', 'media', 'nested', 'attachment.txt'),
  };
  for (const [name, relative] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), name === 'index' ? '{}' : `original ${name}`);
  }
  const db = new Database(path.join(source, DB_FILENAME));
  try { db.exec('CREATE TABLE metadata(value TEXT)'); } finally { db.close(); }
  await createHistoryBackup(source, backup);
  return { source, backup, files };
}

test('the source fence uses the same selective inventory as the committed history backup', async () => {
  const f = await fixture();
  expect(verifyHistoryBackup(f.backup).files.map(file => file.path).sort())
    .toEqual([DB_FILENAME, ...Object.values(f.files)].sort());
  expect(() => verifyHistorySourcesBeforeIsolation(f.source, f.backup)).not.toThrow();
});

test('an active JSONL changed after backup cannot pass the isolation retry fence', async () => {
  const f = await fixture();
  fs.appendFileSync(path.join(f.source, f.files.jsonl), '\nnew historical message');
  expect(() => verifyHistorySourcesBeforeIsolation(f.source, f.backup)).toThrow(/changed after backup/);
});

test('a newly included session file cannot pass the isolation retry fence', async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.source, path.dirname(f.files.jsonl), 'new.jsonl'), 'new session');
  expect(() => verifyHistorySourcesBeforeIsolation(f.source, f.backup)).toThrow(/changed after backup/);
});

test('a removed attachment cannot pass the isolation retry fence', async () => {
  const f = await fixture();
  fs.unlinkSync(path.join(f.source, f.files.media));
  expect(() => verifyHistorySourcesBeforeIsolation(f.source, f.backup)).toThrow(/changed after backup/);
});

test('irrelevant configuration and trajectory changes do not block isolation', async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.source, 'openclaw', 'state', 'openclaw.json'), '{}');
  fs.writeFileSync(path.join(f.source, path.dirname(f.files.sqlite), 'models.json'), '{}');
  fs.writeFileSync(path.join(f.source, path.dirname(f.files.jsonl), 'original.trajectory.jsonl'), 'new diagnostic trace');
  expect(() => verifyHistorySourcesBeforeIsolation(f.source, f.backup)).not.toThrow();
});

test('the product database source is not compared to its consistent backup snapshot', async () => {
  const f = await fixture();
  const db = new Database(path.join(f.source, DB_FILENAME));
  try { db.exec("INSERT INTO metadata VALUES('changed product metadata')"); } finally { db.close(); }
  expect(() => verifyHistorySourcesBeforeIsolation(f.source, f.backup)).not.toThrow();
});

test('an unavailable linked product database is rejected instead of silently omitted', async () => {
  const f = await fixture();
  const product = path.join(f.source, DB_FILENAME);
  const destination = path.join(f.source, 'backups', 'linked-product');
  const lstat = fs.lstatSync.bind(fs);
  const exists = fs.existsSync.bind(fs);
  // Model a broken file link without requiring Windows symlink privileges.
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => String(file) === product
    ? { isSymbolicLink: () => true } as fs.Stats : lstat(file)) as typeof fs.lstatSync);
  vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file) === product ? false : exists(file));

  await expect(createHistoryBackup(f.source, destination)).rejects.toThrow(/linked directory/);

  expect(fs.readFileSync(product).length).toBeGreaterThan(0);
  expect(exists(path.join(destination, 'manifest.json'))).toBe(false);
});

test('a failed initial source pragma closes the database and preserves the original error', async () => {
  const f = await fixture();
  const failure = Object.assign(new Error('source pragma failed'), { code: 'SQLITE_IOERR' });
  vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(() => { throw failure; });
  const close = vi.spyOn(Database.prototype, 'close');

  await expect(createHistoryBackup(f.source, path.join(f.source, 'backups', 'failed'))).rejects.toBe(failure);

  expect(close).toHaveBeenCalledOnce();
  const product = path.join(f.source, DB_FILENAME);
  expect(close.mock.contexts[0]).toMatchObject({ name: product, open: false });
  const renamed = `${product}.closed-after-failure`;
  fs.renameSync(product, renamed);
  expect(fs.existsSync(product)).toBe(false);
  expect(fs.existsSync(renamed)).toBe(true);
});

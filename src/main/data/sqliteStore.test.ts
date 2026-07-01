import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { DB_FILENAME } from '../core/appConstants';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { SqliteStore } from './sqliteStore';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-sqlite-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deletes legacy schema database and creates a fresh database', () => {
  const dir = createTempDir();
  const dbPath = path.join(dir, DB_FILENAME);
  const db = new BetterSqlite3(dbPath);
  const now = Date.now();

  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
    );
  `);
  db.prepare(
    `INSERT INTO cowork_sessions (id, title, status, cwd, created_at, updated_at)
     VALUES ('legacy-session', 'legacy', 'idle', '/tmp', ?, ?)`,
  ).run(now, now);
  db.close();

  const store = SqliteStore.create(dir);
  const migratedDb = store.getDatabase();
  const columns = migratedDb.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
  const indexes = migratedDb.pragma('index_list(cowork_sessions)') as Array<{ name: string }>;
  const legacyRow = migratedDb
    .prepare("SELECT id FROM cowork_sessions WHERE id = 'legacy-session'")
    .get();

  expect(columns.map(column => column.name)).toEqual(
    expect.arrayContaining(['agent_id', 'group_id', 'pinned', 'active_skill_ids']),
  );
  expect(indexes.map(index => index.name)).toContain('idx_cowork_sessions_agent_order');
  expect(legacyRow).toBeUndefined();

  store.close();
});

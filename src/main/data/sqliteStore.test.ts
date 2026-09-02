import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { DB_FILENAME } from '../core/appConstants';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { CoworkStore } from './coworkStore';
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
  const resultTable = migratedDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_run_receipts'",
    )
    .get();
  const cleanupTable = migratedDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_result_cleanup'",
    )
    .get();
  const sessionRunsTable = migratedDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_session_runs'")
    .get();
  const messageCacheTable = migratedDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'")
    .get();

  expect(columns.map(column => column.name)).toEqual(
    expect.arrayContaining(['agent_id', 'group_id', 'pinned', 'active_skill_ids', 'model_ref']),
  );
  expect(columns.map(column => column.name)).not.toContain('claude_session_id');
  expect(indexes.map(index => index.name)).toContain('idx_cowork_sessions_agent_order');
  expect(legacyRow).toBeUndefined();
  expect(resultTable).toEqual({ name: 'scheduled_task_run_receipts' });
  expect(cleanupTable).toEqual({ name: 'scheduled_task_result_cleanup' });
  expect(sessionRunsTable).toEqual({ name: 'cowork_session_runs' });
  expect(messageCacheTable).toBeUndefined();

  store.close();
});

test('adds model_ref, keeps product sessions, and removes the redundant message cache', () => {
  const dir = createTempDir();
  const dbPath = path.join(dir, DB_FILENAME);
  const db = new BetterSqlite3(dbPath);
  const now = Date.now();

  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      execution_mode TEXT,
      active_skill_ids TEXT,
      agent_id TEXT NOT NULL,
      group_id TEXT,
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
      sequence INTEGER,
      thinking_content TEXT,
      model_name TEXT,
      usage TEXT
    );
  `);
  db.prepare(
    `INSERT INTO cowork_sessions
      (id, title, status, cwd, agent_id, created_at, updated_at)
     VALUES ('kept-session', 'kept', 'idle', '/tmp', 'main', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO cowork_messages
      (id, session_id, type, content, created_at, sequence)
     VALUES ('cached-message', 'kept-session', 'assistant', 'duplicate', ?, 1)`,
  ).run(now);
  db.close();

  const store = SqliteStore.create(dir);
  const migratedDb = store.getDatabase();
  const columns = migratedDb.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
  const keptRow = migratedDb
    .prepare("SELECT id FROM cowork_sessions WHERE id = 'kept-session'")
    .get();
  const messageCacheTable = migratedDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'")
    .get();

  expect(columns.map(column => column.name)).toContain('model_ref');
  expect(keptRow).toEqual({ id: 'kept-session' });
  expect(messageCacheTable).toBeUndefined();
  store.close();
});

test('persists one idempotent user run and cascades it with the session', () => {
  const dir = createTempDir();
  const sqlite = SqliteStore.create(dir);
  const db = sqlite.getDatabase();
  db.prepare(
    `INSERT INTO cowork_sessions
      (id, title, status, cwd, agent_id, created_at, updated_at)
     VALUES ('session-1', 'Session', 'idle', '/tmp', 'main', 1, 1)`,
  ).run();
  const store = new CoworkStore(db);

  const first = store.beginSessionRun({
    sessionId: 'session-1',
    clientTurnId: 'turn-1',
    startedAt: 1_000,
    modelRef: 'openai/gpt-5',
  });
  const duplicate = store.beginSessionRun({
    sessionId: 'session-1',
    clientTurnId: 'turn-1',
    startedAt: 9_000,
  });
  expect(duplicate).toEqual(first);
  expect(first.rootRunId).toBe('turn-1');

  expect(store.finishSessionRun(first.id, 'completed', 6_000)).toMatchObject({
    startedAt: 1_000,
    endedAt: 6_000,
    state: 'completed',
  });
  db.prepare("DELETE FROM cowork_sessions WHERE id = 'session-1'").run();
  expect(store.getSessionRuns('session-1')).toEqual([]);
  sqlite.close();
});

test('rejects a client turn reused by another session and interrupts open runs on startup', () => {
  const dir = createTempDir();
  const sqlite = SqliteStore.create(dir);
  const db = sqlite.getDatabase();
  for (const id of ['session-1', 'session-2']) {
    db.prepare(
      `INSERT INTO cowork_sessions
        (id, title, status, cwd, agent_id, created_at, updated_at)
       VALUES (?, 'Session', 'idle', '/tmp', 'main', 1, 1)`,
    ).run(id);
  }
  const store = new CoworkStore(db);
  const timing = store.beginSessionRun({
    sessionId: 'session-1',
    clientTurnId: 'turn-1',
    startedAt: 1_000,
  });

  expect(() =>
    store.beginSessionRun({
      sessionId: 'session-2',
      clientTurnId: 'turn-1',
      startedAt: 2_000,
    }),
  ).toThrow('another session');

  expect(store.interruptOpenSessionRuns(10_000)).toBe(1);
  expect(store.getSessionRun(timing.id)).toMatchObject({
    startedAt: 10_000,
    acceptedAt: 10_000,
    endedAt: 10_000,
    state: 'aborted',
  });
  expect(store.interruptOpenSessionRuns(11_000)).toBe(0);
  expect(store.reopenSessionRun(timing.id)).toMatchObject({
    startedAt: 10_000,
    acceptedAt: 10_000,
    state: 'running',
  });
  expect(store.getSessionRun(timing.id)).toEqual(
    expect.not.objectContaining({ endedAt: expect.any(Number) }),
  );
  sqlite.close();
});

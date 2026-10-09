import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { CoworkPlanHandoffState } from '../../shared/cowork/interactions/planHandoff';
import { PRODUCT_NAME_LOWERCASE } from '../../shared/productMetadata';
import { DB_FILENAME } from '../core/appConstants';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`test-cipher:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^test-cipher:/, ''),
  },
}));

import { CoworkStore } from './coworkStore';
import { SqliteStore } from './sqliteStore';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-sqlite-store-'));
  tempDirs.push(dir);
  return dir;
}

test('persists builtin references without changing unrelated legacy credentials', () => {
  const store = SqliteStore.create(createTempDir());
  try {
    const config = { providers: { builtin_models: { apiKey: 'builtin-fixture-key' } }, api: { key: 'legacy-fixture-key' } };
    store.set('app_config', config);
    const row = store.getDatabase().prepare('SELECT value FROM kv WHERE key = ?').get('app_config') as { value: string };
    expect(row.value).not.toContain('builtin-fixture-key');
    expect(row.value).toContain('legacy-fixture-key');
    expect(store.get('app_config')).toEqual({ ...config, providers: { builtin_models: { apiKey: '' } } });
  } finally { store.close(); }
});

test('converts existing plaintext credentials when opening a database', () => {
  const directory = createTempDir();
  const initial = SqliteStore.create(directory);
  const config = { providers: { builtin_models: { apiKey: 'legacy-builtin-fixture' } } };
  initial.getDatabase().prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run('app_config', JSON.stringify(config), Date.now());
  initial.close();
  const reopened = SqliteStore.create(directory);
  try {
    const row = reopened.getDatabase().prepare('SELECT value FROM kv WHERE key = ?').get('app_config') as { value: string };
    expect(row.value).not.toContain('legacy-builtin-fixture');
    expect(reopened.get('app_config')).toEqual({ providers: { builtin_models: { apiKey: '' } } });
  } finally { reopened.close(); }
});

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
  const resultColumns = migratedDb.pragma('table_info(scheduled_task_run_receipts)') as Array<{
    name: string;
  }>;
  const cleanupTable = migratedDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_result_cleanup'",
    )
    .get();
  const tombstoneTable = migratedDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_result_tombstones'",
    )
    .get();
  const sessionRunsTable = migratedDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_session_runs'")
    .get();
  const removedSessionSegmentsTable = migratedDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_session_segments'",
    )
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
  expect(resultColumns.map(column => column.name)).toContain('system_managed');
  expect(cleanupTable).toEqual({ name: 'scheduled_task_result_cleanup' });
  expect(tombstoneTable).toEqual({ name: 'scheduled_task_result_tombstones' });
  expect(sessionRunsTable).toEqual({ name: 'cowork_session_runs' });
  expect(removedSessionSegmentsTable).toBeUndefined();
  expect(messageCacheTable).toBeUndefined();

  store.close();
});

test('adds compatible session metadata, keeps product sessions, and removes the redundant message cache', () => {
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
    CREATE TABLE scheduled_task_run_receipts (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      session_id TEXT,
      session_key TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      error TEXT,
      delivery_status TEXT,
      delivery_error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      observed_at INTEGER NOT NULL,
      read_at INTEGER,
      updated_at INTEGER NOT NULL
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
  db.prepare(
    `INSERT INTO scheduled_task_run_receipts
      (run_id, task_id, task_name, status, started_at, observed_at, updated_at)
     VALUES ('kept-result', 'task-1', 'Task', 'success', 1000, 1001, 1001)`,
  ).run();
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
  const resultColumns = migratedDb.pragma('table_info(scheduled_task_run_receipts)') as Array<{
    name: string;
  }>;
  const keptResult = migratedDb
    .prepare(
      "SELECT run_id, system_managed FROM scheduled_task_run_receipts WHERE run_id = 'kept-result'",
    )
    .get();

  expect(columns.map(column => column.name)).toEqual(
    expect.arrayContaining([
      'model_ref',
      'forked_from_session_id',
      'forked_from_session_title',
      'forked_from_entry_id',
    ]),
  );
  const forkForeignKey = (
    migratedDb.pragma('foreign_key_list(cowork_sessions)') as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>
  ).find(key => key.from === 'forked_from_session_id');
  expect(forkForeignKey).toMatchObject({ table: 'cowork_sessions', on_delete: 'SET NULL' });
  expect(keptRow).toEqual({ id: 'kept-session' });
  expect(messageCacheTable).toBeUndefined();
  expect(resultColumns.map(column => column.name)).toContain('system_managed');
  expect(keptResult).toEqual({ run_id: 'kept-result', system_managed: 0 });
  store.close();

  const reopened = SqliteStore.create(dir);
  expect(
    reopened
      .getDatabase()
      .prepare(
        "SELECT run_id, system_managed FROM scheduled_task_run_receipts WHERE run_id = 'kept-result'",
      )
      .get(),
  ).toEqual({ run_id: 'kept-result', system_managed: 0 });
  reopened.close();
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

test('allows consecutive plans to use the same canonical implementation session', () => {
  const dir = createTempDir();
  const sqlite = SqliteStore.create(dir);
  const db = sqlite.getDatabase();
  db.prepare(
    `INSERT INTO cowork_sessions
      (id, title, status, cwd, agent_id, created_at, updated_at)
     VALUES ('session-plan', 'Session', 'idle', ?, 'main', 1, 1)`,
  ).run(dir);
  const store = new CoworkStore(db);
  const sessionKey = 'agent:main:justdo:session-plan';

  for (const [index, planId] of ['plan-1', 'plan-2'].entries()) {
    store.createPlanHandoff({
      sessionId: 'session-plan',
      planId,
      planningSessionKey: sessionKey,
      artifact: {
        sessionId: 'session-plan',
        planId,
        workspaceRoot: dir,
        relativePath: path.join(
          `.${PRODUCT_NAME_LOWERCASE}`,
          'plans',
          'session-plan',
          `${planId}.md`,
        ),
        sha256: String(index + 1).repeat(64),
        byteLength: 10,
      },
      presentedAt: index + 1,
    });
    store.transitionPlanHandoff({
      planId,
      expectedState: CoworkPlanHandoffState.Presented,
      nextState: CoworkPlanHandoffState.Dispatching,
      implementationSessionKey: sessionKey,
      transitionedAt: index + 10,
    });
    store.transitionPlanHandoff({
      planId,
      expectedState: CoworkPlanHandoffState.Dispatching,
      nextState: CoworkPlanHandoffState.Admitted,
      implementationGatewaySessionId: 'gateway-session-1',
      implementationRunId: `run-${index + 1}`,
      transitionedAt: index + 20,
    });
    store.transitionPlanHandoff({
      planId,
      expectedState: CoworkPlanHandoffState.Admitted,
      nextState: CoworkPlanHandoffState.Resolved,
      transitionedAt: index + 30,
    });
  }

  expect(store.listPlanHandoffs('session-plan')).toHaveLength(2);
  sqlite.close();
});

test('rebuilds the obsolete unique implementation-session Plan table', () => {
  const dir = createTempDir();
  const initial = SqliteStore.create(dir);
  initial.close();
  const dbPath = path.join(dir, DB_FILENAME);
  const legacy = new BetterSqlite3(dbPath);
  legacy.exec(`
    DROP TABLE cowork_plan_handoffs;
    CREATE TABLE cowork_plan_handoffs (
      plan_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      planning_session_key TEXT NOT NULL,
      artifact_workspace_root TEXT NOT NULL,
      artifact_relative_path TEXT NOT NULL UNIQUE,
      artifact_sha256 TEXT NOT NULL,
      artifact_byte_length INTEGER NOT NULL,
      state TEXT NOT NULL,
      implementation_session_key TEXT UNIQUE,
      implementation_gateway_session_id TEXT,
      implementation_run_id TEXT,
      error TEXT,
      presented_at INTEGER NOT NULL,
      dispatch_started_at INTEGER,
      admitted_at INTEGER,
      resolved_at INTEGER,
      failed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
    );
  `);
  legacy.close();

  const reopened = SqliteStore.create(dir);
  const implementationIndexes = (
    reopened.getDatabase().pragma('index_list(cowork_plan_handoffs)') as Array<{
      name: string;
      unique: number;
    }>
  ).filter(index => {
    if (index.unique !== 1) return false;
    const columns = reopened
      .getDatabase()
      .prepare('SELECT name FROM pragma_index_info(?)')
      .all(index.name) as Array<{ name: string }>;
    return columns.some(column => column.name === 'implementation_session_key');
  });

  expect(implementationIndexes).toEqual([]);
  reopened.close();
});

test('keeps legacy handoff provenance readable after upgrading existing sessions', () => {
  const dir = createTempDir();
  const original = SqliteStore.create(dir);
  const initialDb = original.getDatabase();
  initialDb.exec('DROP INDEX idx_cowork_handoff_request');
  initialDb.exec('ALTER TABLE cowork_sessions DROP COLUMN handoff_request_id');
  initialDb.exec('ALTER TABLE cowork_sessions DROP COLUMN handoff_from_session_id');
  initialDb.exec('ALTER TABLE cowork_sessions DROP COLUMN handoff_from_session_title');
  const before = new CoworkStore(initialDb).createSession('Existing', '/project');
  original.close();
  const reopened = SqliteStore.create(dir);
  try {
    const store = new CoworkStore(reopened.getDatabase());
    expect(store.getSession(before.id)?.title).toBe('Existing');
    const session = store.createSession('Review', '/project');
    reopened
      .getDatabase()
      .prepare(
        'UPDATE cowork_sessions SET handoff_from_session_id = ?, handoff_from_session_title = ?, handoff_request_id = ? WHERE id = ?',
      )
      .run(before.id, before.title, 'legacy-retry', session.id);
    expect(store.getSession(session.id)?.handoffSource).toEqual({
      sessionId: before.id,
      title: 'Existing',
    });
    store.deleteSession(before.id);
    expect(store.getSession(session.id)?.handoffSource).toEqual({ title: 'Existing' });
  } finally { reopened.close(); }
});


test('upgrades assistant deletion metadata and keeps tombstones across restart', () => {
  const directory = createTempDir();
  const initial = SqliteStore.create(directory);
  const profile = { id: 'review', name: 'Reviewer', description: '', icon: '', model: '', enabled: true, isDefault: false };
  new CoworkStore(initial.getDatabase()).saveAgentProfile(profile);
  initial.getDatabase().exec('ALTER TABLE agents DROP COLUMN deleted_at');
  initial.close();
  const migrated = SqliteStore.create(directory);
  const store = new CoworkStore(migrated.getDatabase());
  expect(store.getAgent('review')?.enabled).toBe(true);
  store.deleteAgent('review');
  migrated.close();
  const reopened = SqliteStore.create(directory);
  try {
    expect(new CoworkStore(reopened.getDatabase()).getAgent('review')).toMatchObject({ name: 'Reviewer', enabled: false, deletedAt: expect.any(Number) });
  } finally { reopened.close(); }
});

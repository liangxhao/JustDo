/** Unit tests for CoworkStore product metadata. */
import { beforeEach, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock electron so the import of coworkStore.ts succeeds in Node
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock' },
}));

// ---------------------------------------------------------------------------
// Now import the class under test
// ---------------------------------------------------------------------------
import BetterSqlite3 from 'better-sqlite3';

import { createDefaultAgentRuntimeSettings } from '../../shared/openclaw/agentRuntimeSettings';
import { CoworkStore } from './coworkStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: BetterSqlite3.Database;
let store: CoworkStore;

/** Initialise a fresh in-memory database with the minimum schema. */
function setupDb(): void {
  db = new BetterSqlite3(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      execution_mode TEXT NOT NULL DEFAULT 'local',
      permission_mode TEXT,
      model_ref TEXT,
      active_skill_ids TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      identity TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // CoworkStore only needs (db)
  store = new CoworkStore(db);
}

/** Insert a session row directly. */
function insertSession(id: string, updatedAt: number = Date.now()): void {
  const createdAt = updatedAt;
  db.prepare(
    `INSERT INTO cowork_sessions (id, title, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids, agent_id, created_at, updated_at)
     VALUES (?, 'test', 'idle', 0, '/tmp', '', 'local', '[]', 'main', ?, ?)`,
  ).run(id, createdAt, updatedAt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupDb();
});

test('sessions do not expose a local transcript cache', () => {
  const sid = 'sess-1';
  insertSession(sid);

  expect(store.getSession(sid)).not.toHaveProperty('messages');
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'").get(),
  ).toBeUndefined();
});

test('session metadata updates do not change recent activity time', () => {
  const sid = 'sess-metadata';
  const activityTime = 1_700_000_000_000;
  insertSession(sid, activityTime);

  store.updateSession(sid, {
    title: 'renamed',
    status: 'running',
    cwd: '/other',
    executionMode: 'sandbox',
    permissionMode: 'ask',
    modelRef: 'provider/model',
  });

  const session = store.getSession(sid);
  expect(session).toMatchObject({
    title: 'renamed',
    status: 'running',
    cwd: '/other',
    executionMode: 'sandbox',
    permissionMode: 'ask',
    modelRef: 'provider/model',
    updatedAt: activityTime,
  });
});

test('persists terminal goal execution snapshots and removes them with the session', () => {
  const sid = 'sess-goal-execution';
  insertSession(sid);
  store.setGoalExecutionSnapshot({
    sessionId: sid,
    goalId: 'goal-1',
    phase: 'awaiting_confirmation',
    continuationCount: 2,
    updatedAt: 123,
  });

  expect(store.getGoalExecutionSnapshot(sid)).toMatchObject({
    goalId: 'goal-1',
    phase: 'awaiting_confirmation',
  });

  store.deleteSession(sid);
  expect(store.getGoalExecutionSnapshot(sid)).toBeNull();
});

test('resetting stale running sessions does not change recent activity time', () => {
  const sid = 'sess-running';
  const activityTime = 1_700_000_000_000;
  insertSession(sid, activityTime);
  db.prepare("UPDATE cowork_sessions SET status = 'running' WHERE id = ?").run(sid);

  expect(store.resetRunningSessions()).toBe(1);
  expect(store.getSession(sid)).toMatchObject({ status: 'idle', updatedAt: activityTime });
});

test('backfillEmptyAgentModels assigns the current default model to empty agents only', () => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, model, icon, skill_ids, enabled, is_default, description, system_prompt, identity, created_at, updated_at)
     VALUES
     ('main', 'main', '', '', '[]', 1, 1, '', '', '', ?, ?),
     ('writer', 'Writer', '', '', '[]', 1, 0, '', '', '', ?, ?),
     ('stockexpert', 'Stock Expert', 'qwen3.5-plus', '', '[]', 1, 0, '', '', '', ?, ?)`,
  ).run(now, now, now, now, now, now);

  expect(store.backfillEmptyAgentModels('deepseek-v3.2')).toBe(2);

  const rows = (
    db.prepare(`SELECT id, model FROM agents ORDER BY id`).all() as Array<{
      id: string;
      model: string;
    }>
  ).map(r => [r.id, r.model]);
  expect(rows).toEqual([
    ['main', 'deepseek-v3.2'],
    ['stockexpert', 'qwen3.5-plus'],
    ['writer', 'deepseek-v3.2'],
  ]);
});

test('persists versioned Agent runtime settings and recovers from corrupt data', () => {
  const defaults = createDefaultAgentRuntimeSettings();
  expect(store.getAgentRuntimeSettings()).toEqual(defaults);

  const configured = {
    ...defaults,
    subagents: {
      ...defaults.subagents,
      delegationMode: 'prefer' as const,
      maxConcurrent: 6,
      runTimeoutSeconds: 1800,
      maxSpawnDepth: 2,
    },
  };
  store.setAgentRuntimeSettings(configured);
  expect(store.getAgentRuntimeSettings()).toEqual(configured);

  db.prepare("UPDATE cowork_config SET value = 'not-json' WHERE key = ?").run(
    'agentRuntimeSettings:v1',
  );
  expect(store.getAgentRuntimeSettings()).toEqual(defaults);
});

test('renames current provider refs across agents, sessions, and runtime settings', () => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents
      (id, name, model, created_at, updated_at)
     VALUES ('main', 'Main', 'acmeproxy/model-a', ?, ?)`,
  ).run(now, now);
  insertSession('session-rename', now);
  db.prepare('UPDATE cowork_sessions SET model_ref = ? WHERE id = ?').run(
    'AcmeProxy/model-b',
    'session-rename',
  );
  const runtimeSettings = createDefaultAgentRuntimeSettings();
  runtimeSettings.subagents.model = 'acmeproxy/model-c';
  store.setAgentRuntimeSettings(runtimeSettings);

  expect(store.renameCurrentModelProviderRefs({ acmeproxy: 'newproxy' })).toEqual({
    agents: 1,
    sessions: 1,
    runtimeSettings: 1,
  });
  expect(store.getAgent('main')?.model).toBe('newproxy/model-a');
  expect(store.getSessionModelRef('session-rename')).toBe('newproxy/model-b');
  expect(store.getSession('session-rename')?.modelRef).toBe('newproxy/model-b');
  expect(store.getAgentRuntimeSettings().subagents.model).toBe('newproxy/model-c');
});

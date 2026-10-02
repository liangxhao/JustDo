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
import { createDefaultExternalAgentSettings } from '../../shared/openclaw/externalAgents';
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
      native_session_key TEXT,
      native_parent_session_id TEXT,
      forked_from_session_id TEXT REFERENCES cowork_sessions(id) ON DELETE SET NULL,
      forked_from_session_title TEXT,
      forked_from_entry_id TEXT,
      handoff_from_session_id TEXT REFERENCES cowork_sessions(id) ON DELETE SET NULL,
      handoff_from_session_title TEXT,
      handoff_request_id TEXT UNIQUE,
      active_skill_ids TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      group_id TEXT,
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
    CREATE TABLE IF NOT EXISTS cowork_session_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      client_turn_id TEXT NOT NULL UNIQUE,
      root_run_id TEXT,
      model_ref TEXT,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      accepted_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
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
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'")
      .get(),
  ).toBeUndefined();
});

test('persists fork provenance, follows a live source title, and keeps a snapshot after deletion', () => {
  const source = store.createSession('Original', '/tmp');
  const fork = store.createSession('Fork', '/tmp', 'local', [], 'main', 'full', undefined, {
    sessionId: source.id,
    title: source.title,
    entryId: 'entry-1',
  });

  expect(store.getSession(fork.id)?.forkSource).toEqual({
    sessionId: source.id,
    title: 'Original',
    entryId: 'entry-1',
  });

  store.updateSession(source.id, { title: 'Renamed original' });
  expect(store.getSession(fork.id)?.forkSource).toEqual({
    sessionId: source.id,
    title: 'Renamed original',
    entryId: 'entry-1',
  });

  store.deleteSession(source.id);
  expect(store.getSession(fork.id)?.forkSource).toEqual({
    title: 'Original',
    entryId: 'entry-1',
  });
});

test('copies terminal run metadata with stable transcript run ids', () => {
  const source = store.createSession('Source', '/tmp');
  const target = store.createSession('Target', '/tmp');
  const completed = store.beginSessionRun({
    sessionId: source.id,
    clientTurnId: 'justdo-1700000000000-source',
    startedAt: 1_700_000_000_000,
    modelRef: 'provider/model',
  });
  store.bindSessionRunRootRun(completed.id, 'gateway-run-1');
  store.finishSessionRun(completed.id, 'completed', 1_700_000_002_000);

  expect(store.copyTerminalSessionRuns(source.id, target.id)).toBe(1);
  expect(store.getSessionRuns(target.id)).toEqual([
    expect.objectContaining({
      sessionId: target.id,
      rootRunId: 'gateway-run-1',
      modelRef: 'provider/model',
      state: 'completed',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_002_000,
    }),
  ]);
  expect(store.getSessionRuns(target.id)[0]?.clientTurnId).not.toBe('justdo-1700000000000-source');
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

test('persists versioned external Agent settings and recovers from corrupt data', () => {
  const defaults = createDefaultExternalAgentSettings();
  expect(store.getExternalAgentSettings()).toEqual(defaults);

  const configured = {
    ...defaults,
    permissionMode: 'read-only' as const,
    agents: {
      ...defaults.agents,
      codex: { ...defaults.agents.codex, enabled: false },
      claude: { enabled: true },
    },
  };
  store.setExternalAgentSettings(configured);
  expect(store.getExternalAgentSettings()).toEqual(configured);

  db.prepare("UPDATE cowork_config SET value = 'not-json' WHERE key = ?").run(
    'externalAgentSettings:v1',
  );
  expect(store.getExternalAgentSettings()).toEqual(defaults);
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

test('agent profiles keep exactly one default and preserve inherited models and role files', () => {
  const base = {
    name: 'Research',
    description: '',
    icon: '',
    model: '',
    enabled: true,
    isDefault: true,
  };
  store.saveAgentProfile({ ...base, id: 'research' });
  store.updateAgent('research', { systemPrompt: 'legacy rules' });
  store.saveAgentProfile({ ...base, id: 'review' });
  expect(
    store
      .listAgents()
      .filter(agent => agent.isDefault)
      .map(agent => agent.id),
  ).toEqual(['review']);
  expect(store.getAgent('research')).toMatchObject({
    model: '',
    systemPrompt: 'legacy rules',
    isDefault: false,
  });
  store.saveAgentProfile({ ...base, id: 'research', enabled: false, isDefault: false });
  expect(store.getAgent('research')?.enabled).toBe(false);
});

test('deleting an assistant retains identity and sessions but prevents reactivation', () => {
  db.exec('ALTER TABLE agents ADD COLUMN deleted_at INTEGER');
  const profile = {
    id: 'review',
    name: 'Reviewer',
    description: 'Review code',
    icon: '',
    model: '',
    enabled: true,
    isDefault: false,
  };
  store.saveAgentProfile(profile);
  const session = store.createSession('Review history', '/tmp', 'local', [], 'review');
  store.deleteAgent('review');
  expect(store.getAgent('review')).toMatchObject({
    name: 'Reviewer',
    enabled: false,
    deletedAt: expect.any(Number),
  });
  expect(store.getSession(session.id)?.agentId).toBe('review');
  expect(store.listAgents().find(agent => agent.id === 'review')?.name).toBe('Reviewer');
  expect(() => store.saveAgentProfile(profile)).toThrow('agentUnavailable');
  expect(() => store.updateAgent('review', { enabled: true })).toThrow('agentUnavailable');
  expect(() => store.deleteAgent('review')).not.toThrow();
});

test('assistant deletion refuses a running local session and main', () => {
  db.exec('ALTER TABLE agents ADD COLUMN deleted_at INTEGER');
  const profile = {
    id: 'review',
    name: 'Reviewer',
    description: '',
    icon: '',
    model: '',
    enabled: true,
    isDefault: false,
  };
  store.saveAgentProfile(profile);
  store.saveAgentProfile({ ...profile, id: 'main', isDefault: true });
  const session = store.createSession('Running', '/tmp', 'local', [], 'review');
  store.updateSession(session.id, { status: 'running' });
  expect(() => store.deleteAgent('review')).toThrow('agentBusy');
  expect(() => store.deleteAgent('main')).toThrow('agentMainRequired');
  expect(store.getAgent('review')?.enabled).toBe(true);
});

test('assistant switching is opt-in and persists without changing existing session ownership', () => {
  expect(store.getConfig().allowMainAgentSwitch).toBe(false);
  store.setConfig({ allowMainAgentSwitch: true });
  expect(store.getConfig().allowMainAgentSwitch).toBe(true);
  const chat = store.createSession('Research', 'C:/project', 'local', [], 'research');
  store.setConfig({ allowMainAgentSwitch: false });
  expect(store.getConfig().allowMainAgentSwitch).toBe(false);
  expect(store.getSession(chat.id)?.agentId).toBe('research');
});

test('retains native worktree identity and its own permissions across metadata reloads', () => {
  const parent = store.createSession('Parent', '/source', 'local', [], 'main', 'full');
  const key = 'agent:main:subagent:child';
  const child = store.adoptNativeSession(key, parent, 'Child', '/worktree', 'ask');
  const reloaded = new CoworkStore(db);

  expect(reloaded.getSessionByNativeKey(key)).toMatchObject({
    id: child.id, cwd: '/worktree', permissionMode: 'ask',
    nativeSessionKey: key, nativeParentSessionId: parent.id,
  });
  expect(reloaded.listSessions().find(summary => summary.id === child.id))
    .toMatchObject({ nativeSessionKey: key });
  expect(reloaded.adoptNativeSession(key, parent, 'Duplicate', '/other', 'full').id).toBe(child.id);
  expect(reloaded.listSessions()).toHaveLength(2);
});

test('hides the worktree checkbox by default and persists only its visibility preference', () => {
  expect(store.getConfig().showWorktreeCheckbox).toBe(false);
  store.setConfig({ showWorktreeCheckbox: true });
  const reloaded = new CoworkStore(db);
  expect(reloaded.getConfig().showWorktreeCheckbox).toBe(true);
  reloaded.setConfig({ showWorktreeCheckbox: false });
  expect(store.getConfig().showWorktreeCheckbox).toBe(false);
});

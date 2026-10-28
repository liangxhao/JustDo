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
import path from 'path';

import { createDefaultAgentRuntimeSettings } from '../../shared/agents/agentRuntimeSettings';
import { SESSION_SUMMARY_BATCH_LIMIT } from '../../shared/cowork/sessionDirectory';
import { createDefaultExternalAgentSettings } from '../../shared/integrations/externalAgents';
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
      execution_mode TEXT NOT NULL DEFAULT 'local',
      permission_mode TEXT,
      model_ref TEXT,
      source TEXT,
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
      deleted_at INTEGER,
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
    `INSERT INTO cowork_sessions (id, title, status, pinned, cwd, execution_mode, active_skill_ids, agent_id, created_at, updated_at)
     VALUES (?, 'test', 'idle', 0, '/tmp', 'local', '[]', 'main', ?, ?)`,
  ).run(id, createdAt, updatedAt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupDb();
});

test('reads a lightweight complete directory and only requested summaries without session detail reads', () => {
  for (let index = 0; index < 205; index += 1) insertSession(`session-${index}`, index);
  db.prepare('UPDATE cowork_sessions SET group_id = ?, pinned = 1 WHERE id = ?').run(
    'manual',
    'session-0',
  );
  const details = vi.spyOn(store, 'getSession').mockImplementation(() => {
    throw new Error('Navigation projections must not read full session details.');
  });

  const directory = store.listSessionDirectory();
  const page = store.readSessionSummaries(['session-0', 'session-3', 'session-3', 'missing']);

  expect(directory).toHaveLength(205);
  expect(directory[0]).toMatchObject({ id: 'session-0', groupId: 'manual', pinned: true });
  expect(directory[0]).not.toHaveProperty('title');
  expect(directory[0]).not.toHaveProperty('historyBinding');
  expect(page.map(session => session.id)).toEqual(['session-0', 'session-3']);
  expect(page[0]).toMatchObject({ title: 'test', groupId: 'manual' });
  expect(store.readSessionSummaries([])).toEqual([]);
  expect(() =>
    store.readSessionSummaries(
      Array.from({ length: SESSION_SUMMARY_BATCH_LIMIT + 1 }, (_, index) => `session-${index}`),
    ),
  ).toThrow('At most');
  expect(store.listSessionSearchSummaries()).toHaveLength(205);
  expect(details).not.toHaveBeenCalled();
});

test('projects external origins and historical identities and hides holding sessions from every navigation read', () => {
  db.exec(`CREATE TABLE cowork_external_sessions (
    cowork_session_id TEXT PRIMARY KEY, source TEXT, status TEXT, openclaw_session_key TEXT
  );
  CREATE TABLE history_session_bindings (
    session_id TEXT PRIMARY KEY, session_key TEXT, native_session_id TEXT, availability TEXT
  );`);
  insertSession('cli', 5);
  insertSession('chrome', 4);
  insertSession('historical', 3);
  insertSession('holding', 2);
  insertSession('other-agent', 1);
  db.prepare('UPDATE cowork_sessions SET source = ? WHERE id = ?').run(
    'browser-extension',
    'chrome',
  );
  db.prepare('UPDATE cowork_sessions SET agent_id = ? WHERE id = ?').run(
    'specialist',
    'other-agent',
  );
  db.prepare('INSERT INTO cowork_external_sessions VALUES (?, ?, ?, ?)').run(
    'cli',
    'cli',
    'completed',
    'agent:main:cli:one',
  );
  const history = db.prepare('INSERT INTO history_session_bindings VALUES (?, ?, ?, ?)');
  history.run('historical', 'agent:main:historical', 'native-history', 'native');
  history.run('holding', 'agent:main:harness:justdo-team-holding:one', 'native-holding', 'native');

  const directory = store.listSessionDirectory('main');
  const summaries = store.readSessionSummaries(['historical', 'holding']);

  expect(directory.map(session => session.id)).toEqual(['cli', 'chrome', 'historical']);
  expect(directory[0].external).toEqual({
    origin: 'cli',
    status: 'completed',
    readOnly: true,
    sessionKey: 'agent:main:cli:one',
  });
  expect(directory[1]).toMatchObject({ source: 'browser-extension' });
  expect(directory[2]).toMatchObject({ nativeSessionKey: 'agent:main:historical' });
  expect(summaries).toEqual([
    expect.objectContaining({
      id: 'historical',
      nativeSessionKey: 'agent:main:historical',
      historyBinding: {
        sessionKey: 'agent:main:historical',
        nativeSessionId: 'native-history',
        availability: 'native',
      },
    }),
  ]);
  expect(store.listSessionSearchSummaries().map(session => session.id)).not.toContain('holding');
});

test('preserves manual group metadata when a full conversation is opened', () => {
  insertSession('grouped');
  db.prepare('UPDATE cowork_sessions SET group_id = ? WHERE id = ?').run('manual', 'grouped');
  expect(store.getSession('grouped')).toMatchObject({ groupId: 'manual' });
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

test('groups Swarm and browser artifact workspaces under their parent project in recent directories', () => {
  const project = path.resolve('测试项目');
  const other = path.resolve('other-project');
  const lookalike = path.join(project, '.agent-tasks-extra', 'notes');
  const entries = [
    { cwd: project, updatedAt: 1000 },
    { cwd: other, updatedAt: 2000 },
    {
      cwd: path.join(project, '.agent-tasks', 'swarm', 'flow', 'batch', 'item', 'attempt-1'),
      updatedAt: 3000,
    },
    { cwd: path.join(project, '.agent-tasks', 'browser-artifacts'), updatedAt: 4000 },
    { cwd: lookalike, updatedAt: 5000 },
  ];
  for (const entry of entries) {
    const session = store.createSession('Workspace', entry.cwd);
    db.prepare('UPDATE cowork_sessions SET updated_at=? WHERE id=?').run(
      entry.updatedAt,
      session.id,
    );
  }

  expect(store.listRecentCwds()).toEqual([lookalike, project, other]);
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

test('copies branch timing only through the exact native cut run', () => {
  const source = store.createSession('Source', '/tmp');
  const target = store.createSession('Branch', '/tmp');
  for (const [index, state] of ['completed', 'completed', 'failed'].entries()) {
    const timing = store.beginSessionRun({
      sessionId: source.id,
      clientTurnId: `input-${index}`,
      startedAt: 100 + index,
    });
    store.bindSessionRunRootRun(timing.id, `native-${index}`);
    store.finishSessionRun(timing.id, state as 'completed' | 'failed', 200 + index);
  }
  expect(
    store.copyTerminalSessionRuns(source.id, target.id, new Set(['native-0', 'native-1'])),
  ).toBe(2);
  expect(store.getSessionRuns(target.id).map(run => run.rootRunId)).toEqual([
    'native-0',
    'native-1',
  ]);
  expect(store.getLatestSessionRun(target.id)?.state).toBe('completed');
});

test('does not guess a timing cutoff when the native run is absent from product receipts', () => {
  const source = store.createSession('Source', '/tmp');
  const target = store.createSession('Branch', '/tmp');
  const timing = store.beginSessionRun({
    sessionId: source.id,
    clientTurnId: 'input',
    startedAt: 1,
  });
  store.finishSessionRun(timing.id, 'completed', 2);
  expect(store.copyTerminalSessionRuns(source.id, target.id, new Set(['unknown']))).toBe(0);
  expect(store.getSessionRuns(target.id)).toEqual([]);
});

test('does not copy later run timing when start times tie and receipt UUID order differs', () => {
  const source = store.createSession('Source', '/tmp');
  const target = store.createSession('Branch', '/tmp');
  const first = store.beginSessionRun({
    sessionId: source.id,
    clientTurnId: 'first',
    startedAt: 1,
  });
  store.bindSessionRunRootRun(first.id, 'cut-run');
  store.finishSessionRun(first.id, 'completed', 2);
  const later = store.beginSessionRun({
    sessionId: source.id,
    clientTurnId: 'later',
    startedAt: 1,
  });
  store.bindSessionRunRootRun(later.id, 'later-run');
  store.finishSessionRun(later.id, 'failed', 3);
  db.prepare('UPDATE cowork_session_runs SET id = ? WHERE id = ?').run('z-cut', first.id);
  db.prepare('UPDATE cowork_session_runs SET id = ? WHERE id = ?').run('a-later', later.id);

  expect(store.copyTerminalSessionRuns(source.id, target.id, new Set(['cut-run']))).toBe(1);
  expect(store.getSessionRuns(target.id).map(run => run.rootRunId)).toEqual(['cut-run']);
});

test('filters receipts abandoned by native rewind even when their timing precedes the cut', () => {
  const source = store.createSession('Source', '/tmp');
  const target = store.createSession('Copy', '/tmp');
  for (const [index, root] of ['kept', 'abandoned', 'cut'].entries()) {
    const timing = store.beginSessionRun({
      sessionId: source.id,
      clientTurnId: root,
      startedAt: index,
    });
    store.bindSessionRunRootRun(timing.id, root);
    store.finishSessionRun(timing.id, 'completed', index + 1);
  }
  expect(store.copyTerminalSessionRuns(source.id, target.id, new Set(['kept', 'cut']))).toBe(2);
  expect(store.getSessionRuns(target.id).map(run => run.rootRunId)).toEqual(['kept', 'cut']);
});

test('persists unfinished branch fences across store instances and list refreshes, then clears on deletion', () => {
  const target = store.createSession('Unconfirmed copy', '/tmp');
  store.markSessionBranchPending(target.id);
  const reopened = new CoworkStore(db);
  expect(reopened.getSession(target.id)?.branchCreationPending).toBe(true);
  expect(reopened.listSessions().find(item => item.id === target.id)?.branchCreationPending).toBe(
    true,
  );
  reopened.clearSessionBranchPending(target.id);
  expect(store.getSession(target.id)?.branchCreationPending).toBeUndefined();
  store.markSessionBranchPending(target.id);
  store.deleteSession(target.id);
  expect(reopened.isSessionBranchPending(target.id)).toBe(false);
  const batch = store.createSession('Batch', '/tmp');
  store.markSessionBranchPending(batch.id);
  store.deleteSessions([batch.id]);
  expect(reopened.isSessionBranchPending(batch.id)).toBe(false);
  store.markSessionBranchPending('missing');
  expect(reopened.isSessionBranchPending('missing')).toBe(false);
});

test.each([false, true])(
  'rolls back product deletion if branch-fence cleanup fails (batch: %s)',
  batch => {
    const target = store.createSession('Unfinished', '/tmp');
    store.markSessionBranchPending(target.id);
    db.exec(`CREATE TRIGGER prevent_branch_fence_removal BEFORE DELETE ON cowork_config
    WHEN OLD.key LIKE 'sessionBranchPending:%' BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END;`);
    expect(() =>
      batch ? store.deleteSessions([target.id]) : store.deleteSession(target.id),
    ).toThrow('cleanup failed');
    const reopened = new CoworkStore(db);
    expect(reopened.getSession(target.id)?.branchCreationPending).toBe(true);
  },
);

test('persists recent conversation activity across store instances and list reads', () => {
  insertSession('history', 1_700_000_000_000);
  insertSession('other', 1_700_100_000_000);
  const activityTime = 1_700_200_000_000;

  store.recordSessionActivity('history', activityTime);

  const reloaded = new CoworkStore(db);
  expect(reloaded.getSession('history')).toMatchObject({
    createdAt: 1_700_000_000_000,
    updatedAt: activityTime,
  });
  expect(reloaded.listSessions().map(session => session.id)).toEqual(['history', 'other']);
  expect(reloaded.getSession('other')?.updatedAt).toBe(1_700_100_000_000);
});

test('ignores older or invalid activity and never recreates a deleted session', () => {
  const activityTime = 1_700_200_000_000;
  insertSession('history', activityTime);

  for (const timestamp of [activityTime - 1, activityTime, NaN, Infinity, -1]) {
    store.recordSessionActivity('history', timestamp);
  }
  store.recordSessionActivity('deleted', activityTime);

  expect(store.getSession('history')?.updatedAt).toBe(activityTime);
  expect(store.listSessions().map(session => session.id)).toEqual(['history']);
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
    id: child.id,
    cwd: '/worktree',
    permissionMode: 'ask',
    nativeSessionKey: key,
    nativeParentSessionId: parent.id,
  });
  expect(reloaded.listSessions().find(summary => summary.id === child.id)).toMatchObject({
    nativeSessionKey: key,
  });
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

test('rejects pending-input native adoption and omits reserved rows from user conversations', () => {
  const parent = store.createSession('Parent', '/source', 'local');
  const key = 'agent:main:harness:justdo-team-holding:room:1';
  expect(() => store.adoptNativeSession(key, parent, 'Pending', '/source')).toThrow(
    'teamDiscussionInvalidInput',
  );
  expect(() => store.bindNativeSession(parent.id, key, null)).toThrow('teamDiscussionInvalidInput');
  expect(store.listSessions()).toHaveLength(1);
  db.prepare('UPDATE cowork_sessions SET native_session_key = ? WHERE id = ?').run(key, parent.id);
  expect(store.listSessions()).toEqual([]);
  expect(store.listSessions('main')).toEqual([]);
});

test('creates a product conversation with the Main-reserved preview identity atomically', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const created = store.createSession(
    'Adopted canvas',
    '/tmp',
    'local',
    [],
    'main',
    'auto',
    undefined,
    undefined,
    undefined,
    id,
  );
  expect(created.id).toBe(id);
  expect(store.getSession(id)?.title).toBe('Adopted canvas');
  expect(() =>
    store.createSession(
      'Duplicate',
      '/tmp',
      'local',
      [],
      'main',
      'auto',
      undefined,
      undefined,
      undefined,
      id,
    ),
  ).toThrow();
  expect(store.getSession(id)?.title).toBe('Adopted canvas');
  expect(() =>
    store.createSession(
      'Invalid',
      '/tmp',
      'local',
      [],
      'main',
      'auto',
      undefined,
      undefined,
      undefined,
      '../other',
    ),
  ).toThrow('Invalid reserved session identity');
});

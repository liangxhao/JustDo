import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { DB_FILENAME } from '../../core/appConstants';
import { CoworkStore } from '../../data/coworkStore';
import { GroupStore } from '../../data/groupStore';
import { SqliteStore } from '../../data/sqliteStore';
import { planLegacyHistory, restoreHistoryMetadata, stageLegacyHistory } from './legacyHistory';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const roots: string[] = [];
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-metadata-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function legacyIndex(directory: string): void {
  const db = new Database(path.join(directory, DB_FILENAME));
  try {
    db.exec(`CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,title TEXT,agent_id TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER);
      INSERT INTO cowork_sessions VALUES ('first','First','main','',1000,2000);
      INSERT INTO cowork_sessions VALUES ('second','Second','main','',1000,2000);
      INSERT INTO cowork_sessions VALUES ('other','Other','research','',1000,2000);`);
  } finally {
    db.close();
  }
}

function legacyGroups(directory: string): void {
  const db = new Database(path.join(directory, DB_FILENAME));
  try {
    db.exec(`ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER;
      ALTER TABLE cowork_sessions ADD COLUMN group_id TEXT;
      CREATE TABLE session_groups (
        id TEXT PRIMARY KEY,name TEXT,color TEXT,sort_order INTEGER,created_at INTEGER);
      INSERT INTO session_groups VALUES ('a-work','工作','#ff0000',99,10);
      INSERT INTO session_groups VALUES ('b-work','工作','#00ff00',-5,20);
      INSERT INTO session_groups VALUES ('empty','空分组','#000000',1,30);
      UPDATE cowork_sessions SET pinned=1,group_id='a-work' WHERE id IN ('first','other');
      UPDATE cowork_sessions SET pinned=0,group_id='missing-group' WHERE id='second';`);
  } finally {
    db.close();
  }
}

test('migration retains only group names, admitted membership and session pin flags', () => {
  const source = root();
  legacyIndex(source);
  legacyGroups(source);
  const plan = planLegacyHistory(source);
  expect(plan.groups).toEqual([
    { id: 'a-work', name: '工作' },
    { id: 'b-work', name: '工作' },
    { id: 'empty', name: '空分组' },
  ]);
  expect(plan.conversations.map(({ id, pinned, groupId }) => ({ id, pinned, groupId }))).toEqual([
    { id: 'first', pinned: true, groupId: 'a-work' },
    { id: 'second', pinned: false, groupId: null },
  ]);
  const store = SqliteStore.create(root());
  try {
    const db = store.getDatabase();
    const startedAt = Date.now();
    restoreHistoryMetadata(db, plan, 'metadata-migration');
    const groups = new GroupStore(db).listGroups();
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.color).toBe('#6366f1');
      expect(group.sortOrder).toBe(0);
      expect(group.createdAt).toBeGreaterThanOrEqual(startedAt);
    }
    const cowork = new CoworkStore(db);
    expect(cowork.getSession('first')).toMatchObject({ pinned: true, groupId: 'a-work' });
    expect(cowork.getSession('second')).toMatchObject({ pinned: false, groupId: null });
    expect(cowork.getSession('other')).toBeNull();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    restoreHistoryMetadata(db, plan, 'metadata-migration');
    expect(new GroupStore(db).listGroups()).toEqual(groups);
    expect(cowork.listSessions()).toHaveLength(2);
  } finally {
    store.close();
  }
});

test.each([false, true])('legacy history without a group table uses defaults (pin fields: %s)', pinFields => {
  const source = root();
  legacyIndex(source);
  if (pinFields) {
    const old = new Database(path.join(source, DB_FILENAME));
    try {
      old.exec(`ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER;
        ALTER TABLE cowork_sessions ADD COLUMN group_id TEXT;
        UPDATE cowork_sessions SET pinned=1,group_id='missing-group' WHERE id='first';`);
    } finally {
      old.close();
    }
  }
  const plan = planLegacyHistory(source);
  expect(plan.groups).toEqual([]);
  const store = SqliteStore.create(root());
  try {
    restoreHistoryMetadata(store.getDatabase(), plan, 'no-groups-migration');
    const cowork = new CoworkStore(store.getDatabase());
    expect(cowork.getSession('first')).toMatchObject({ pinned: pinFields, groupId: null });
    expect(cowork.getSession('second')).toMatchObject({ pinned: false, groupId: null });
  } finally {
    store.close();
  }
});

test('failed metadata recovery rolls back groups and pins, and conflicting retries preserve current data', () => {
  const source = root();
  legacyIndex(source);
  legacyGroups(source);
  const plan = planLegacyHistory(source);
  const store = SqliteStore.create(root());
  try {
    const db = store.getDatabase();
    db.exec(`CREATE TRIGGER fail_history_binding BEFORE INSERT ON history_session_bindings
      WHEN NEW.session_id='second' BEGIN SELECT RAISE(ABORT,'interrupted metadata'); END;`);
    expect(() => restoreHistoryMetadata(db, plan, 'metadata-migration')).toThrow('interrupted metadata');
    for (const table of ['session_groups', 'cowork_sessions', 'history_session_bindings'])
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    db.exec('DROP TRIGGER fail_history_binding');
    restoreHistoryMetadata(db, plan, 'metadata-migration');
    const groups = new GroupStore(db);
    groups.updateGroup('a-work', { name: '当前分组' });
    expect(() => restoreHistoryMetadata(db, plan, 'metadata-migration')).toThrow(/group conflicts/);
    expect(groups.getGroup('a-work')?.name).toBe('当前分组');
    groups.updateGroup('a-work', { name: '工作' });
    db.prepare('UPDATE cowork_sessions SET pinned=0,group_id=NULL WHERE id=?').run('first');
    expect(() => restoreHistoryMetadata(db, plan, 'metadata-migration')).toThrow(/conflicts with the import receipt/);
    expect(new CoworkStore(db).getSession('first')).toMatchObject({ pinned: false, groupId: null });
  } finally {
    store.close();
  }
});

function nativeIndex(directory: string, entries: Record<string, unknown>): void {
  const folder = path.join(directory, 'openclaw/state/agents/main/sessions');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'sessions.json'), JSON.stringify(entries));
}

test('migration preserves exact native child terminal snapshots without restoring runtime control', () => {
  const source = root();
  legacyIndex(source);
  nativeIndex(source, {
    'agent:main:subagent:done': {
      sessionId: 'child-done', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
      status: 'done', lastRunId: 'child-run-done', startedAt: 1000, endedAt: 2000, runtimeMs: 1000,
      modelOverride: 'old/model', pendingFinalDelivery: { unwanted: true }, abortedLastRun: true,
    },
    'agent:main:subagent:failed': {
      sessionId: 'child-failed', spawnedBy: 'agent:main:justdo:first', updatedAt: 3000,
      status: 'failed', lastRunId: 'child-run-failed', endedAt: 3000,
      lastRunError: 'Provider failed', subagentRecovery: { automaticAttempts: 5 },
    },
  });
  const plan = planLegacyHistory(source);
  expect(plan.agents[0].entries['agent:main:subagent:done']).toEqual({
    sessionId: 'child-done', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
    status: 'done', lastRunId: 'child-run-done', startedAt: 1000, endedAt: 2000, runtimeMs: 1000,
  });
  expect(plan.agents[0].entries['agent:main:subagent:failed']).toEqual({
    sessionId: 'child-failed', spawnedBy: 'agent:main:justdo:first', updatedAt: 3000,
    status: 'failed', lastRunId: 'child-run-failed', endedAt: 3000, lastRunError: 'Provider failed',
  });
  const target = root();
  stageLegacyHistory(source, target, plan);
  const index = JSON.parse(fs.readFileSync(path.join(target, 'agents/main/sessions/sessions.json'), 'utf8'));
  expect(index['agent:main:subagent:done']).toMatchObject({ status: 'done', lastRunId: 'child-run-done' });
  expect(index['agent:main:subagent:failed']).toMatchObject({ status: 'failed', lastRunError: 'Provider failed' });
});

test('migration gives every historical child a binary outcome without inventing execution evidence', () => {
  const source = root();
  legacyIndex(source);
  const parent = 'agent:main:justdo:first';
  nativeIndex(source, {
    'agent:main:subagent:content': { sessionId: 'content', spawnedBy: parent, updatedAt: 2000 },
    'agent:main:subagent:unknown': {
      sessionId: 'unknown', spawnedBy: parent, updatedAt: 2000, status: 'unknown',
    },
    'agent:main:subagent:missing-run': {
      sessionId: 'missing-run', spawnedBy: parent, updatedAt: 2000, status: 'done', endedAt: 2000,
    },
    'agent:main:subagent:still-active': {
      sessionId: 'still-active', spawnedBy: parent, updatedAt: 2000, status: 'done',
      lastRunId: 'old-run', lifecycleRunId: 'new-run', endedAt: 2000,
    },
    'agent:main:subagent:running': {
      sessionId: 'running', spawnedBy: parent, updatedAt: 2000, status: 'running',
      lastRunId: 'running-run', endedAt: 2000,
    },
    'agent:main:subagent:new-writer': {
      sessionId: 'new-writer', spawnedBy: parent, updatedAt: 2000, status: 'done',
      lastRunId: 'old-run', activeWriterRunId: 'admitted-new-run', endedAt: 2000,
    },
    'agent:main:subagent:invalid-time': {
      sessionId: 'invalid-time', spawnedBy: parent, updatedAt: 2000, status: 'failed',
      lastRunId: 'invalid-time-run', startedAt: 3000, endedAt: 2000,
    },
    'agent:main:justdo:first': {
      sessionId: 'root-first', updatedAt: 2000, status: 'done', lastRunId: 'root-run', endedAt: 2000,
    },
  });
  fs.writeFileSync(path.join(source, 'openclaw/state/agents/main/sessions/content.jsonl'),
    '{"type":"session","version":3,"id":"content"}\n' +
    '{"type":"message","id":"answer","message":{"role":"assistant","content":[{"type":"text","text":"Finished"}],"stopReason":"stop"}}\n');
  const plan = planLegacyHistory(source);
  for (const [key, entry] of Object.entries(plan.agents[0].entries)) {
    if (key === 'agent:main:justdo:first') {
      expect(entry).not.toHaveProperty('status');
      continue;
    }
    expect(entry.status).toBe(['missing-run', 'still-active', 'new-writer'].includes(entry.sessionId)
      ? 'done' : 'failed');
    expect(entry).not.toHaveProperty('lastRunId');
    expect(entry).not.toHaveProperty('lifecycleRunId');
    expect(entry).not.toHaveProperty('activeWriterRunId');
    expect(entry).not.toHaveProperty('executionSettled');
    expect(entry).not.toHaveProperty('endedAt');
  }
  const target = root();
  stageLegacyHistory(source, target, plan);
  const staged = JSON.parse(fs.readFileSync(path.join(target, 'agents/main/sessions/sessions.json'), 'utf8'));
  for (const entry of Object.values(staged) as Record<string, unknown>[])
    if (entry.spawnedBy) expect(['done', 'failed']).toContain(entry.status);
});

test.each(['interrupted', 'killed', 'timeout'])(
  'migration normalizes a recorded %s child to failure while preserving its real run metadata', status => {
    const source = root();
    legacyIndex(source);
    nativeIndex(source, {
      'agent:main:subagent:stopped': {
        sessionId: 'child-stopped', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
        status, lastRunId: 'stopped-run', startedAt: 1000, endedAt: 2000, lastRunError: 'Stopped',
      },
    });
    expect(planLegacyHistory(source).agents[0].entries['agent:main:subagent:stopped']).toEqual({
      sessionId: 'child-stopped', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
      status: 'failed', lastRunId: 'stopped-run', startedAt: 1000, endedAt: 2000, lastRunError: 'Stopped',
    });
  },
);

test('different canonical parent identities reject migration instead of choosing a historical owner', () => {
  const source = root();
  legacyIndex(source);
  nativeIndex(source, {
    'Agent:Main:JustDo:Child': {
      sessionId: 'aliased-child', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
    },
    'agent:main:justdo:child': {
      sessionId: 'aliased-child', spawnedBy: 'agent:main:justdo:second', updatedAt: 2000,
    },
  });
  expect(() => planLegacyHistory(source)).toThrow(/historical parent association/);
});

test.each([
  { firstStatus: 'done', conflict: { status: 'running', lifecycleRunId: 'new-active-run' }, outcome: 'done', snapshot: true },
  { firstStatus: 'done', conflict: { status: 'done', lastRunId: 'different-terminal-run' }, outcome: 'done', snapshot: false },
  { firstStatus: 'failed', conflict: { status: 'timeout', lastRunId: 'different-terminal-run' }, outcome: 'failed', snapshot: false },
  { firstStatus: 'failed', conflict: { status: 'done', lastRunId: undefined }, outcome: 'done', snapshot: false },
  { firstStatus: 'timeout', conflict: { status: 'killed', lastRunId: 'different-terminal-run' }, outcome: 'failed', snapshot: false },
])('migration normalizes conflicting canonical aliases to the selected binary result: %o', ({ firstStatus, conflict, outcome, snapshot }) => {
  const terminal = {
    sessionId: 'aliased-child', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
    status: firstStatus, lastRunId: 'terminal-run', startedAt: 1000, endedAt: 2000,
  };
  const conflicting = { ...terminal, ...conflict };
  const normalized: string[] = [];
  for (const aliases of [
    [terminal, conflicting], [conflicting, terminal], [terminal, conflicting, terminal],
  ]) {
    const source = root();
    legacyIndex(source);
    const keys = ['Agent:Main:JustDo:Child', 'agent:main:justdo:child', 'AGENT:MAIN:JUSTDO:CHILD'];
    nativeIndex(source, Object.fromEntries(aliases.map((entry, index) => [keys[index], entry])));
    const plan = planLegacyHistory(source);
    const entry = plan.agents[0].entries['agent:main:justdo:child'];
    expect(entry).toMatchObject({ sessionId: 'aliased-child', spawnedBy: 'agent:main:justdo:first' });
    expect(entry.status).toBe(outcome);
    expect(entry).not.toHaveProperty('lifecycleRunId');
    expect(entry).not.toHaveProperty('executionSettled');
    if (snapshot) {
      expect(entry).toMatchObject({ startedAt: 1000, endedAt: 2000 });
      expect(['terminal-run', 'different-terminal-run']).toContain(entry.lastRunId);
    } else {
      for (const field of ['lastRunId', 'startedAt', 'endedAt', 'runtimeMs', 'lastRunError'])
        expect(entry).not.toHaveProperty(field);
    }
    normalized.push(JSON.stringify(entry));
  }
  expect(new Set(normalized).size).toBe(1);
});

test('identical terminal snapshots on canonical aliases remain recoverable', () => {
  const source = root();
  legacyIndex(source);
  const terminal = {
    sessionId: 'aliased-child', spawnedBy: 'agent:main:justdo:first', updatedAt: 2000,
    status: 'failed', lastRunId: 'terminal-run', endedAt: 2000, lastRunError: 'Provider failed',
  };
  nativeIndex(source, {
    'Agent:Main:JustDo:Child': terminal,
    'agent:main:justdo:child': { ...terminal, updatedAt: 3000 },
  });
  expect(planLegacyHistory(source).agents[0].entries['agent:main:justdo:child']).toMatchObject({
    sessionId: 'aliased-child', status: 'failed', lastRunId: 'terminal-run',
    endedAt: 2000, lastRunError: 'Provider failed',
  });
});

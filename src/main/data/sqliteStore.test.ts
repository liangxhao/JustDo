import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { CoworkPlanHandoffState } from '../../shared/cowork/interactions/planHandoff';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { PRODUCT_NAME_LOWERCASE } from '../../shared/productMetadata';
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

test('a root config file is ignored when creating and reopening the product store', () => {
  const directory = createTempDir();
  const legacyFile = path.join(directory, 'config.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ app_config: { language: 'old' }, oldSetting: true }));
  const read = fs.readFileSync.bind(fs);
  const legacyRead = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (String(file) === legacyFile) throw new Error('legacy settings must not be read');
    return read(file, options);
  });
  const initial = SqliteStore.create(directory);
  try {
    expect(initial.get('app_config')).toBeUndefined();
    expect(initial.get('oldSetting')).toBeUndefined();
    expect(initial.getDatabase().prepare('SELECT key FROM kv').all()).toEqual([]);
  } finally { initial.close(); }
  const reopened = SqliteStore.create(directory);
  try {
    expect(reopened.get('oldSetting')).toBeUndefined();
    reopened.set('app_config', { language: 'new' });
  } finally { reopened.close(); }
  const current = SqliteStore.create(directory);
  try {
    expect(current.get('app_config')).toEqual({ language: 'new' });
    expect(legacyRead.mock.calls.some(([file]) => String(file) === legacyFile)).toBe(false);
  } finally { current.close(); }
});

test('retains extension creation source across updates and database reopen without creating user groups', () => {
  const directory = createTempDir();
  const initial = SqliteStore.create(directory);
  const cowork = new CoworkStore(initial.getDatabase());
  const desktop = cowork.createSession('Desktop', '/tmp');
  const extension = cowork.createSession(
    'Browser',
    '/tmp',
    'local',
    [],
    'main',
    'auto',
    undefined,
    undefined,
    CoworkSessionSource.BrowserExtension,
  );
  expect(extension.source).toBe(CoworkSessionSource.BrowserExtension);
  cowork.updateSession(extension.id, { title: 'Renamed browser conversation' });
  cowork.setSessionPinned(extension.id, true);
  initial.close();

  const reopened = SqliteStore.create(directory);
  try {
    const loaded = new CoworkStore(reopened.getDatabase());
    expect(loaded.getSession(extension.id)).toMatchObject({
      source: CoworkSessionSource.BrowserExtension,
      title: 'Renamed browser conversation',
      pinned: true,
    });
    for (const sessions of [loaded.listSessions(), loaded.listSessions('main')]) {
      expect(sessions.find(session => session.id === extension.id)?.source).toBe(
        CoworkSessionSource.BrowserExtension,
      );
      expect(sessions.find(session => session.id === desktop.id)?.source).toBeUndefined();
    }
    expect(reopened.getDatabase().prepare('SELECT id FROM session_groups').all()).toEqual([]);
  } finally {
    reopened.close();
  }
});

test('keeps builtin credentials out of persisted settings and preserves user credentials across reopen', () => {
  const directory = createTempDir();
  const store = SqliteStore.create(directory);
  const config = { providers: { builtin_models: { apiKey: 'builtin-fixture-key' } }, api: { key: 'user-api-key' } };
  try {
    store.set('app_config', config);
    const row = store.getDatabase().prepare('SELECT value FROM kv WHERE key = ?').get('app_config') as { value: string };
    expect(row.value).not.toContain('builtin-fixture-key');
    expect(row.value).toContain('user-api-key');
    expect(store.get('app_config')).toEqual({ ...config, providers: { builtin_models: { apiKey: '' } } });
  } finally { store.close(); }
  const reopened = SqliteStore.create(directory);
  try {
    expect(reopened.get('app_config')).toEqual({ ...config, providers: { builtin_models: { apiKey: '' } } });
  } finally { reopened.close(); }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to open an unbacked legacy cache and preserves its schema and contents', () => {
  const directory = createTempDir();
  const file = path.join(directory, DB_FILENAME);
  const old = new BetterSqlite3(file);
  old.exec("CREATE TABLE cowork_messages(id TEXT,content TEXT); INSERT INTO cowork_messages VALUES('old','history');");
  old.close();
  const before = fs.readFileSync(file);
  expect(() => SqliteStore.create(directory)).toThrow(/backed up/);
  expect(fs.readFileSync(file)).toEqual(before);
  const preserved = new BetterSqlite3(file, { readonly: true });
  expect(preserved.prepare('SELECT content FROM cowork_messages').get()).toEqual({ content: 'history' });
  preserved.close();
});

test('creates complete current metadata and retains product sessions and receipts across reopen', () => {
  const dir = createTempDir();
  const store = SqliteStore.create(dir);
  const db = store.getDatabase();
  const session = new CoworkStore(db).createSession(
    'kept', '/tmp', 'local', [], 'main', 'ask', 'current/selected',
  );
  db.prepare(
    `INSERT INTO scheduled_task_run_receipts
      (run_id, task_id, task_name, system_managed, status, started_at, observed_at, updated_at)
     VALUES ('kept-result', 'task-1', 'Task', 1, 'success', 1000, 1001, 1001)`,
  ).run();
  const columns = db.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
  const messageCacheTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'")
    .get();

  expect(columns.map(column => column.name)).toEqual(
    expect.arrayContaining([
      'permission_mode',
      'model_ref',
      'source',
      'native_session_key',
      'native_parent_session_id',
      'handoff_from_session_id',
      'handoff_from_session_title',
      'handoff_request_id',
      'forked_from_session_id',
      'forked_from_session_title',
      'forked_from_entry_id',
    ]),
  );
  const forkForeignKey = (
    db.pragma('foreign_key_list(cowork_sessions)') as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>
  ).find(key => key.from === 'forked_from_session_id');
  expect(forkForeignKey).toMatchObject({ table: 'cowork_sessions', on_delete: 'SET NULL' });
  const externalColumns = db.pragma('table_info(cowork_external_sessions)') as Array<{ name: string }>;
  expect(externalColumns.map(column => column.name)).toEqual(expect.arrayContaining([
    'agent_id', 'openclaw_session_key', 'execution_run_id', 'native_session_id', 'lifecycle_revision', 'execution_state',
  ]));
  expect(messageCacheTable).toBeUndefined();
  const schema = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
  store.close();

  const reopened = SqliteStore.create(dir);
  try {
    expect(new CoworkStore(reopened.getDatabase()).getSession(session.id)).toMatchObject({
      title: 'kept', permissionMode: 'ask', modelRef: 'current/selected',
    });
    expect(reopened.getDatabase().prepare(
      "SELECT run_id, system_managed FROM scheduled_task_run_receipts WHERE run_id = 'kept-result'",
    ).get()).toEqual({ run_id: 'kept-result', system_managed: 1 });
    expect(reopened.getDatabase().prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  } finally { reopened.close(); }
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

test('keeps handoff provenance readable after reopening current sessions', () => {
  const dir = createTempDir();
  const original = SqliteStore.create(dir);
  const initialDb = original.getDatabase();
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
      .run(before.id, before.title, 'handoff-request', session.id);
    expect(store.getSession(session.id)?.handoffSource).toEqual({
      sessionId: before.id,
      title: 'Existing',
    });
    store.deleteSession(before.id);
    expect(store.getSession(session.id)?.handoffSource).toEqual({ title: 'Existing' });
  } finally { reopened.close(); }
});


test('reopening current history bindings preserves already adopted session choices', () => {
  const directory = createTempDir();
  const initial = SqliteStore.create(directory);
  const store = new CoworkStore(initial.getDatabase());
  const session = store.createSession(
    'restored previously',
    '/tmp',
    'local',
    [],
    'main',
    'ask',
    'current/selected',
  );
  initial
    .getDatabase()
    .prepare(
      `INSERT INTO history_session_bindings
    (session_id,session_key,native_session_id,availability,source_agent_id,source_session_key,transaction_id)
    VALUES (?,?,?,'native','main',?,'previous')`,
    )
    .run(session.id, 'agent:main:restored', 'native', 'agent:main:restored');
  initial.close();
  const reopened = SqliteStore.create(directory);
  try {
    const current = new CoworkStore(reopened.getDatabase());
    current.setConfig({ permissionMode: 'full' });
    expect(current.applyHistorySessionDefaults(session.id)).toBe(false);
    expect(current.getSession(session.id)).toMatchObject({
      permissionMode: 'ask',
      modelRef: 'current/selected',
    });
  } finally {
    reopened.close();
  }
});

test('keeps current assistant deletion metadata and tombstones across restart', () => {
  const directory = createTempDir();
  const initial = SqliteStore.create(directory);
  const profile = { id: 'review', name: 'Reviewer', description: '', icon: '', model: '', enabled: true, isDefault: false };
  new CoworkStore(initial.getDatabase()).saveAgentProfile(profile);
  initial.close();
  const current = SqliteStore.create(directory);
  const store = new CoworkStore(current.getDatabase());
  expect(store.getAgent('review')?.enabled).toBe(true);
  store.deleteAgent('review');
  current.close();
  const reopened = SqliteStore.create(directory);
  try {
    expect(new CoworkStore(reopened.getDatabase()).getAgent('review')).toMatchObject({ name: 'Reviewer', enabled: false, deletedAt: expect.any(Number) });
  } finally { reopened.close(); }
});

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { HistoryRecoveryKind } from '../../../shared/app/startup/history';
import { StartupRoute, StartupStage } from '../../../shared/app/startup/routing';
import { StartupCompatibilityErrorCode } from '../../../shared/app/startup/versionPolicy';
import { DB_FILENAME } from '../../core/appConstants';
import { CoworkStore } from '../../data/coworkStore';
import { SqliteStore } from '../../data/sqliteStore';
import { SessionRpc } from '../../engine/gateway/sessionRpc';
import { SessionPermissionModeCoordinator } from '../../openclaw/permissions/sessionPermissionModeCoordinator';
import { createHistoryBackup, verifyHistoryBackup } from '../history/historyBackup';
import {
  canonicalHistoryKey,
  convertCachedHistory,
  planLegacyHistory,
  restoreHistoryMetadata,
  stageLegacyHistory,
  verifyRestoredHistoryBindings,
} from '../history/legacyHistory';
import { AppInitialization } from '../initialization/appInitialization';
import { classifyInstallation } from './classifyInstallation';
import { StartupCoordinator } from './startupCoordinator';
import {
  newStartupJournal,
  readStartupJournal,
  STARTUP_STATE_FILE,
  writeStartupJson,
} from './startupState';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
const roots: string[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-history-'));
  roots.push(dir);
  return dir;
};
const progress = () => ({ advance: vi.fn(), reportActivity: vi.fn(), setHistorySummary: vi.fn() });
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function legacy(dir: string, wal = false) {
  const db = new Database(path.join(dir, DB_FILENAME));
  if (wal) {
    db.pragma('journal_mode=WAL');
    db.pragma('wal_autocheckpoint=0');
  }
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,agent_id TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE cowork_messages(id TEXT,session_id TEXT,type TEXT,content TEXT,created_at INTEGER,sequence INTEGER);
    INSERT INTO kv VALUES('app_config','{"language":"en","plugins":{"old":true}}',1);`);
  const insert = db.prepare('INSERT INTO cowork_sessions VALUES(?,?,?,?,?,?)');
  for (const [id, title] of [
    ['native', '原生标题'],
    ['cache', '缓存标题'],
    ['missing', '缺失正文'],
  ])
    insert.run(id, title, 'main', process.cwd(), 1000, 2000);
  db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?)').run(
    'm1',
    'cache',
    'user',
    'historical user',
    1100,
    1,
  );
  db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?)').run(
    'm2',
    'cache',
    'tool_use',
    'historical tool snapshot',
    1200,
    2,
  );
  const folder = path.join(dir, 'openclaw/state/agents/main/sessions');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'sessions.json'),
    JSON.stringify({
      'agent:main:justdo:native': {
        sessionId: 'original-native',
        updatedAt: 2000,
        sessionFile: 'C:/old-machine/sessions/original-native.jsonl',
        modelOverride: 'old/model',
        skillsSnapshot: { unwanted: true },
        goal: { active: true },
      },
      'agent:main:subagent:child': {
        sessionId: 'original-child',
        spawnedBy: 'agent:main:justdo:native',
        parentSessionId: 'original-native',
        updatedAt: 2000,
      },
    }),
  );
  fs.writeFileSync(
    path.join(folder, 'original-native.jsonl'),
    '{"type":"session","version":3,"id":"original-native"}\n',
  );
  fs.writeFileSync(
    path.join(folder, 'original-child.jsonl'),
    '{"type":"session","version":3,"id":"original-child"}\n',
  );
  fs.writeFileSync(path.join(folder, 'original-native.trajectory.jsonl'), 'excluded trajectory');
  fs.writeFileSync(path.join(dir, 'credentials.json'), 'discarded settings');
  if (!wal) db.close();
  return db;
}

test('a different delivery cannot resume a pending JSONL migration or modify its real product database and history', async () => {
  const directory = root();
  legacy(directory);
  const target = { appVersion: 'v2026.10.20', runtimeVersion: 'v2026.10.7', runtimeBuildId: 'a'.repeat(64) };
  writeStartupJson(path.join(directory, STARTUP_STATE_FILE), {
    ...newStartupJournal(StartupRoute.Migration), targetIdentity: target,
  });
  const retained = [DB_FILENAME, 'credentials.json', STARTUP_STATE_FILE,
    'openclaw/state/agents/main/sessions/sessions.json',
    'openclaw/state/agents/main/sessions/original-native.jsonl',
    'openclaw/state/agents/main/sessions/original-child.jsonl'];
  const before = retained.map(file => fs.readFileSync(path.join(directory, file)));
  const native = {
    identity: vi.fn(async () => ({ runtimeVersion: 'v2026.10.6', runtimeBuildId: 'b'.repeat(64) })),
    inspect: vi.fn(async () => ({ needsUpgrade: false })),
    upgrade: vi.fn(async () => {}),
  };
  expect(classifyInstallation(directory).route).toBe(StartupRoute.Migration);
  const coordinator = await StartupCoordinator.prepare(directory, { appVersion: target.appVersion, native });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toMatchObject({
    code: StartupCompatibilityErrorCode.VersionUnconfirmed,
  });
  expect(native.inspect).not.toHaveBeenCalled();
  expect(native.upgrade).not.toHaveBeenCalled();
  retained.forEach((file, index) => expect(fs.readFileSync(path.join(directory, file))).toEqual(before[index]));
  expect(fs.existsSync(path.join(directory, 'backups'))).toBe(false);
});

test('classifies fresh, published JSONL upgrade and current reinstall from actual data, independent of display marker', () => {
  const fresh = root();
  expect(classifyInstallation(fresh).route).toBe(StartupRoute.Fresh);
  const old = root();
  legacy(old);
  expect(classifyInstallation(old).route).toBe(StartupRoute.Migration);
  const current = root();
  const store = SqliteStore.create(current);
  store.set('app_config', { language: 'en' });
  store.close();
  expect(fs.existsSync(path.join(current, '.justdo-initialized'))).toBe(false);
  expect(classifyInstallation(current).route).toBe(StartupRoute.Normal);
  fs.mkdirSync(path.join(current, 'backups/old/openclaw/state/agents/main/sessions'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(current, 'backups/old/openclaw/state/agents/main/sessions/sessions.json'),
    '{"old":{}}',
  );
  expect(classifyInstallation(current).route).toBe(StartupRoute.Normal);
  expect(new StartupCoordinator(current).route).toBe(StartupRoute.Normal);
});

test('an unfinished normal upgrade requires the same current product generation and never recreates a missing index', () => {
  const target = root();
  const store = SqliteStore.create(target);
  store.set('app_config', { retained: true });
  store.close();
  writeStartupJson(path.join(target, STARTUP_STATE_FILE), {
    ...newStartupJournal(StartupRoute.Upgrade),
    targetIdentity: { appVersion: 'v2026.10.20', runtimeVersion: 'v2026.10.6', runtimeBuildId: 'a'.repeat(64) },
  });
  expect(classifyInstallation(target).route).toBe(StartupRoute.Upgrade);
  const retained = path.join(target, 'retained-product.sqlite');
  fs.renameSync(path.join(target, DB_FILENAME), retained);
  const before = fs.readFileSync(retained);
  expect(() => classifyInstallation(target)).toThrow(/generation changed/);
  expect(fs.existsSync(path.join(target, DB_FILENAME))).toBe(false);
  expect(fs.readFileSync(retained)).toEqual(before);
});

test('an application-only release uses the normal screen and preserves the actual current product database', async () => {
  const directory = root();
  const store = SqliteStore.create(directory);
  store.set('app_config', { language: 'en', retained: true });
  store.close();
  const previous = { appVersion: 'v2026.10.19', runtimeVersion: 'v2026.10.6', runtimeBuildId: 'a'.repeat(64) };
  const target = { ...previous, appVersion: 'v2026.10.20', runtimeBuildId: 'b'.repeat(64) };
  writeStartupJson(path.join(directory, STARTUP_STATE_FILE), {
    ...newStartupJournal(StartupRoute.Normal), stage: StartupStage.Complete, completedIdentity: previous,
  });
  const before = fs.readFileSync(path.join(directory, DB_FILENAME));
  const native = {
    identity: vi.fn(async () => ({ runtimeVersion: target.runtimeVersion, runtimeBuildId: target.runtimeBuildId })),
    inspect: vi.fn(async () => ({ needsUpgrade: false })),
    upgrade: vi.fn(async () => {}),
  };
  const coordinator = await StartupCoordinator.prepare(directory, { appVersion: target.appVersion, native });
  expect(coordinator.route).toBe(StartupRoute.Normal);
  const initialization = new AppInitialization(directory, coordinator.route, vi.fn());
  expect(initialization.getState()).toMatchObject({ route: StartupRoute.Normal, firstLaunch: false, totalSteps: 4 });
  await coordinator.prepareBeforeStore(initialization);
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(native.inspect).toHaveBeenCalledTimes(2);
  expect(native.upgrade).not.toHaveBeenCalled();
  expect(readStartupJournal(directory)?.completedIdentity).toEqual(target);
  expect(fs.readFileSync(path.join(directory, DB_FILENAME))).toEqual(before);
  expect(fs.existsSync(path.join(directory, 'backups'))).toBe(false);
});

test.each([
  ['ENOSPC', HistoryRecoveryKind.Space],
  ['EBUSY', HistoryRecoveryKind.Busy],
  ['EPERM', HistoryRecoveryKind.Access],
])(
  'a %s backup failure preserves the source and restarts from an uncommitted backup',
  async (code, kind) => {
    const source = root();
    legacy(source);
    const coordinator = new StartupCoordinator(source);
    const initialization = new AppInitialization(source, StartupRoute.Migration, vi.fn());
    const failure = Object.assign(new Error('backup unavailable'), { code });
    const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(failure);
    await expect(coordinator.prepareBeforeStore(initialization)).rejects.toBe(failure);
    initialization.fail(failure);
    expect(initialization.getState()).toMatchObject({
      historyRecovery: kind,
      failure: { error: { code } },
    });
    expect(fs.readFileSync(path.join(source, 'credentials.json'), 'utf8')).toBe(
      'discarded settings',
    );
    expect(
      fs.existsSync(path.join(source, 'openclaw/state/agents/main/sessions/sessions.json')),
    ).toBe(true);
    expect(readStartupJournal(source)?.stage).toBe(StartupStage.Backup);
    copy.mockRestore();
    await new StartupCoordinator(source).prepareBeforeStore(progress());
    expect(readStartupJournal(source)?.stage).toBe(StartupStage.Initialize);
  },
);

test('unknown/corrupt and mixed active generations preserve their source and block database admission', async () => {
  const invalid = root();
  fs.writeFileSync(path.join(invalid, DB_FILENAME), 'unrecognized bytes');
  const coordinator = new StartupCoordinator(invalid);
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow();
  expect(fs.readFileSync(path.join(invalid, DB_FILENAME), 'utf8')).toBe('unrecognized bytes');
  const mixed = root();
  legacy(mixed);
  const native = path.join(mixed, 'openclaw/state/agents/main/agent');
  fs.mkdirSync(native);
  fs.writeFileSync(path.join(native, 'openclaw-agent.sqlite'), 'untouched');
  expect(() => classifyInstallation(mixed)).toThrow(/Mixed/);
  expect(() => SqliteStore.create(mixed)).toThrow(/backed up/);
});

test('missing workspaces remain recoverable metadata, contribute to the result, and use current defaults only once', async () => {
  const source = root();
  legacy(source);
  const validWorkspace = path.join(root(), '中文 project');
  fs.mkdirSync(validWorkspace);
  const missingWorkspace = path.join(root(), 'missing');
  const internalWorkspace = path.join(source, 'old-project');
  fs.mkdirSync(internalWorkspace);
  fs.writeFileSync(
    path.join(internalWorkspace, 'project.txt'),
    'discarded under the approved policy',
  );
  const old = new Database(path.join(source, DB_FILENAME));
  old.prepare('UPDATE cowork_sessions SET cwd=? WHERE id=?').run(validWorkspace, 'native');
  old.prepare('UPDATE cowork_sessions SET cwd=? WHERE id=?').run(missingWorkspace, 'cache');
  old.prepare('UPDATE cowork_sessions SET cwd=? WHERE id=?').run(internalWorkspace, 'missing');
  old.close();
  const coordinator = new StartupCoordinator(source);
  await coordinator.prepareBeforeStore(progress());
  const store = SqliteStore.create(source);
  try {
    const report = progress();
    await coordinator.restoreHistory(
      store.getDatabase(),
      path.join(source, 'openclaw/state'),
      report,
      async mode => {
        if (mode === 'import') {
          const index = path.join(source, 'openclaw/state/agents/main/sessions/sessions.json');
          fs.renameSync(index, `${index}.imported`);
        }
        return JSON.stringify(
          mode === 'verify'
            ? { verified: true, entries: 4, conversations: 3 }
            : mode === 'inspect'
              ? {
                  targets: [
                    { agentId: 'main', sqliteEntries: 4, dbStats: { integrityCheck: 'ok' } },
                  ],
                }
              : { targets: [] },
        );
      },
    );
    expect(report.setHistorySummary.mock.lastCall).toEqual([
      expect.objectContaining({
        conversations: 3,
        unavailableConversations: 1,
        unavailableWorkspaces: 2,
      }),
      coordinator.getHistoryBackupDirectory(),
    ]);
    coordinator.complete();
    expect(new StartupCoordinator(source).route).toBe(StartupRoute.Normal);
    const cowork = new CoworkStore(store.getDatabase());
    expect(cowork.getSession('cache')).toMatchObject({
      cwd: missingWorkspace,
      historyBinding: { workspaceUnavailable: true },
    });
    expect(cowork.getSession('native')).toMatchObject({
      cwd: validWorkspace,
      historyBinding: { workspaceUnavailable: false },
    });
    cowork.setConfig({ permissionMode: 'ask' });
    expect(cowork.applyHistorySessionDefaults('native')).toBe(true);
    expect(cowork.getSession('native')).toMatchObject({
      permissionMode: 'ask',
      cwd: validWorkspace,
    });
    expect(cowork.getSession('native')?.modelRef).toBeUndefined();
    cowork.updateSession('native', { permissionMode: 'auto', modelRef: 'current/chosen' });
    cowork.setConfig({ permissionMode: 'full' });
    expect(cowork.applyHistorySessionDefaults('native')).toBe(false);
    expect(cowork.getSession('native')).toMatchObject({
      permissionMode: 'auto',
      modelRef: 'current/chosen',
    });
    const fresh = cowork.createSession(
      'fresh',
      validWorkspace,
      'local',
      [],
      'main',
      'ask',
      'current/fresh',
    );
    expect(cowork.applyHistorySessionDefaults(fresh.id)).toBe(false);
    expect(cowork.getSession(fresh.id)?.modelRef).toBe('current/fresh');
    cowork.setConfig({ permissionMode: 'ask' });
    const prepare = vi.fn().mockResolvedValue(undefined);
    const permissions = new SessionPermissionModeCoordinator({
      getCoworkStore: () => cowork,
      isSessionActive: () => false,
      prepareSession: prepare,
    });
    await expect(permissions.setSessionMode('cache', 'full')).resolves.toEqual({ success: true });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'full' }));
    expect(cowork.getSession('cache')?.permissionMode).toBe('full');
    expect(cowork.applyHistorySessionDefaults('cache')).toBe(false);
    const rpc = new SessionRpc({
      store: cowork,
      getGatewayClient: () =>
        ({
          request: vi.fn().mockResolvedValue({ resolved: { model: 'current/selected' } }),
        }) as never,
    });
    await expect(rpc.patchModel('missing', 'current/selected')).resolves.toMatchObject({
      ok: true,
      modelRef: 'current/selected',
    });
    expect(cowork.applyHistorySessionDefaults('missing')).toBe(false);
    expect(cowork.getSession('missing')).toMatchObject({
      permissionMode: 'ask',
      modelRef: 'current/selected',
    });
  } finally {
    store.close();
  }
});

test('consistent selective backup contains committed WAL rows, omits settings/trajectories and detects tampering', async () => {
  const source = root();
  const live = legacy(source, true);
  const backup = path.join(root(), 'history');
  try {
    live.prepare('UPDATE cowork_sessions SET title=? WHERE id=?').run('WAL中的标题', 'native');
    await createHistoryBackup(source, backup);
    const snapshot = new Database(path.join(backup, DB_FILENAME), { readonly: true });
    expect(snapshot.prepare('SELECT title FROM cowork_sessions WHERE id=?').get('native')).toEqual({
      title: 'WAL中的标题',
    });
    snapshot.close();
    const manifest = verifyHistoryBackup(backup);
    expect(manifest.files.some(file => /trajectory|credentials|backups/.test(file.path))).toBe(
      false,
    );
    fs.appendFileSync(path.join(backup, DB_FILENAME), 'tamper');
    expect(() => verifyHistoryBackup(backup)).toThrow(/verification/);
  } finally {
    live.close();
  }
});

test.each(['before-admission', 'during-backup'])(
  'missing product history metadata stops %s without isolating the native source',
  async phase => {
    const source = root();
    legacy(source);
    const existing = phase === 'during-backup' ? new StartupCoordinator(source) : null;
    fs.unlinkSync(path.join(source, DB_FILENAME));
    const coordinator = existing ?? new StartupCoordinator(source);
    await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(
      /conversation index is missing/,
    );
    expect(() => planLegacyHistory(source)).toThrow(/conversation index is missing/);
    expect(fs.readFileSync(path.join(source, 'credentials.json'), 'utf8')).toBe(
      'discarded settings',
    );
    expect(
      fs.existsSync(path.join(source, 'openclaw/state/agents/main/sessions/sessions.json')),
    ).toBe(true);
  },
);

test.each(['original-native-topic-123.jsonl', '历史正文.jsonl', 'original-native-100%.jsonl'])(
  'localizes native transcript pointer %s and preserves it instead of a stale canonical file',
  filename => {
    const source = root();
    legacy(source);
    const folder = path.join(source, 'openclaw/state/agents/main/sessions');
    const content =
      fs.readFileSync(path.join(folder, 'original-native.jsonl'), 'utf8') +
      '{"type":"message","id":"topic-message","message":{"role":"user","content":"topic history"}}\n';
    fs.writeFileSync(path.join(folder, filename), content);
    const index = JSON.parse(fs.readFileSync(path.join(folder, 'sessions.json'), 'utf8'));
    index['agent:main:justdo:native'].sessionFile = `C:/previous-machine/history/${filename}`;
    fs.writeFileSync(path.join(folder, 'sessions.json'), JSON.stringify(index));
    const plan = planLegacyHistory(source);
    expect(plan.conversations.find(row => row.id === 'native')).toMatchObject({
      availability: 'native',
      nativeSessionId: 'original-native',
    });
    const target = root();
    stageLegacyHistory(source, target, plan);
    const restoredFile = path.join(target, 'agents/main/sessions', filename);
    expect(fs.readFileSync(restoredFile, 'utf8')).toBe(content);
    const restored = JSON.parse(
      fs.readFileSync(path.join(target, 'agents/main/sessions/sessions.json'), 'utf8'),
    );
    expect(restored['agent:main:justdo:native'].sessionFile).toBe(restoredFile);
    expect(restored['agent:main:subagent:child'].spawnedBy).toBe('agent:main:justdo:native');
  },
);

test('localizes Unicode and percent compaction references without changing their historical bytes', () => {
  const source = root();
  legacy(source);
  const folder = path.join(source, 'openclaw/state/agents/main/sessions');
  const index = JSON.parse(fs.readFileSync(path.join(folder, 'sessions.json'), 'utf8'));
  const files = ['压缩前历史.jsonl', 'original-native-100%.jsonl'];
  const content = fs.readFileSync(path.join(folder, 'original-native.jsonl'), 'utf8');
  for (const filename of files) fs.writeFileSync(path.join(folder, filename), content);
  index['agent:main:justdo:native'].compactionCheckpoints = [
    {
      preCompaction: { sessionFile: `C:\\old-machine\\history\\${files[0]}` },
      postCompaction: { sessionFile: `C:/old-machine/history/${files[1]}` },
    },
  ];
  fs.writeFileSync(path.join(folder, 'sessions.json'), JSON.stringify(index));
  const target = root();
  stageLegacyHistory(source, target, planLegacyHistory(source));
  const restoredFolder = path.join(target, 'agents/main/sessions');
  const restored = JSON.parse(fs.readFileSync(path.join(restoredFolder, 'sessions.json'), 'utf8'));
  expect(restored['agent:main:justdo:native'].compactionCheckpoints).toEqual([
    {
      preCompaction: { sessionFile: path.join(restoredFolder, files[0]) },
      postCompaction: { sessionFile: path.join(restoredFolder, files[1]) },
    },
  ]);
  for (const filename of files)
    expect(fs.readFileSync(path.join(restoredFolder, filename), 'utf8')).toBe(content);
});

test('an empty historical workspace is preserved for folder selection rather than rejecting history', () => {
  const source = root();
  legacy(source);
  const old = new Database(path.join(source, DB_FILENAME));
  old.prepare('UPDATE cowork_sessions SET cwd=NULL WHERE id=?').run('native');
  old.close();
  const plan = planLegacyHistory(source);
  const target = SqliteStore.create(root());
  try {
    restoreHistoryMetadata(target.getDatabase(), plan, 'missing-folder');
    expect(new CoworkStore(target.getDatabase()).getSession('native')).toMatchObject({
      title: '原生标题',
      cwd: '',
      historyBinding: { nativeSessionId: 'original-native', workspaceUnavailable: true },
    });
  } finally {
    target.close();
  }
});

test('history metadata commits durably before its journal, restores the normal policy and only checks receipts on resume', () => {
  const source = root();
  legacy(source);
  const plan = planLegacyHistory(source);
  const store = SqliteStore.create(root());
  const db = store.getDatabase();
  try {
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    db.exec(`CREATE TRIGGER assert_durable_history BEFORE INSERT ON history_session_bindings BEGIN
      SELECT CASE WHEN (SELECT synchronous FROM pragma_synchronous) != 2
        THEN RAISE(ABORT, 'historical receipts need durable commit') END; END;`);
    restoreHistoryMetadata(db, plan, 'migration-test');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    db.prepare('UPDATE cowork_sessions SET title=? WHERE id=?').run('current title', 'native');
    expect(() => verifyRestoredHistoryBindings(db, plan, 'migration-test')).not.toThrow();
    expect(() => restoreHistoryMetadata(db, plan, 'migration-test')).toThrow(
      /conflicts with the import receipt/,
    );
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.prepare('SELECT title FROM cowork_sessions WHERE id=?').get('native')).toEqual({
      title: 'current title',
    });
    db.prepare('DELETE FROM history_session_bindings WHERE session_id=?').run('native');
    expect(() => verifyRestoredHistoryBindings(db, plan, 'migration-test')).toThrow(
      /binding is missing or changed/,
    );
  } finally {
    store.close();
  }
});

test('empty history checkpoints preceding schema and default writes before the generation can complete', () => {
  const source = root();
  legacy(source);
  const plan = planLegacyHistory(source);
  plan.agents = [];
  plan.conversations = [];
  const target = root();
  const store = SqliteStore.create(target);
  const db = store.getDatabase();
  try {
    db.pragma('wal_autocheckpoint=0');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec(
      "CREATE TABLE startup_durable_default(value TEXT); INSERT INTO startup_durable_default VALUES('prepared');",
    );
    expect(fs.statSync(path.join(target, `${DB_FILENAME}-wal`)).size).toBeGreaterThan(0);
    restoreHistoryMetadata(db, plan, 'empty-history-test');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    const standalone = path.join(root(), DB_FILENAME);
    fs.copyFileSync(path.join(target, DB_FILENAME), standalone);
    const snapshot = new Database(standalone, { readonly: true, fileMustExist: true });
    try {
      expect(snapshot.prepare('SELECT value FROM startup_durable_default').get()).toEqual({
        value: 'prepared',
      });
    } finally {
      snapshot.close();
    }
  } finally {
    store.close();
  }
});

test('recovers an interrupted native import without another backup, environment replacement or transcript restaging', async () => {
  const target = root();
  legacy(target);
  const first = new StartupCoordinator(target);
  await first.prepareBeforeStore(progress());
  const journal = readStartupJournal(target)!;
  expect(journal.stage).toBe(StartupStage.Initialize);
  const backup = path.join(target, 'backups', journal.transactionId, 'history');
  const plan = planLegacyHistory(backup);
  expect(plan.summary).toMatchObject({
    conversations: 3,
    cachedConversations: 1,
    unavailableConversations: 1,
  });
  expect(plan.agents[0].entries['agent:main:justdo:native']).not.toHaveProperty('modelOverride');
  expect(plan.agents[0].entries['agent:main:subagent:child']).toMatchObject({
    parentSessionId: 'original-native',
    spawnedBy: 'agent:main:justdo:native',
  });
  const store = SqliteStore.create(target);
  try {
    const state = path.join(target, 'openclaw/state');
    const index = path.join(state, 'agents/main/sessions/sessions.json');
    await expect(
      first.restoreHistory(store.getDatabase(), state, progress(), async () => {
        fs.renameSync(index, `${index}.imported`);
        throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');
    expect(readStartupJournal(target)?.stage).toBe(StartupStage.ImportHistory);
    expect(store.getDatabase().prepare('SELECT id FROM cowork_sessions').all()).toHaveLength(0);
    const resume = new StartupCoordinator(target);
    await resume.prepareBeforeStore(progress());
    await resume.restoreHistory(store.getDatabase(), state, progress(), async mode => {
      expect(fs.existsSync(index)).toBe(false);
      if (mode === 'import') return '{"targets":[]}';
      if (mode === 'verify')
        return JSON.stringify({ verified: true, entries: 4, conversations: 3 });
      return JSON.stringify({
        targets: [{ agentId: 'main', sqliteEntries: 4, dbStats: { integrityCheck: 'ok' } }],
      });
    });
    const cowork = new CoworkStore(store.getDatabase());
    expect(cowork.listSessions()).toHaveLength(3);
    expect(cowork.getSession('native')).toMatchObject({
      title: '原生标题',
      status: 'idle',
      pinned: false,
      activeSkillIds: [],
      historyBinding: {
        nativeSessionId: 'original-native',
        sessionKey: 'agent:main:justdo:native',
      },
    });
    expect(store.get('app_config')).toBeUndefined();
    expect(
      store
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE name='cowork_messages'")
        .get(),
    ).toBeUndefined();
    const checked = new StartupCoordinator(target);
    const runNative = vi.fn();
    await checked.restoreHistory(store.getDatabase(), state, progress(), runNative);
    expect(runNative).not.toHaveBeenCalled();
    resume.complete();
    expect(new StartupCoordinator(target).route).toBe(StartupRoute.Normal);
    expect(fs.readdirSync(path.join(target, 'backups'))).toEqual([journal.transactionId]);
    expect(fs.existsSync(path.join(target, 'backups', journal.transactionId, 'retired'))).toBe(
      false,
    );
  } finally {
    store.close();
  }
});

test.each([true, false])(
  'refreshes an uncommitted snapshot after interruption (manifest=%s) while retaining its candidate',
  async committedManifest => {
    const target = root();
    legacy(target);
    const journal = newStartupJournal(StartupRoute.Migration);
    writeStartupJson(path.join(target, STARTUP_STATE_FILE), journal);
    const transaction = path.join(target, 'backups', journal.transactionId);
    const history = path.join(transaction, 'history');
    await createHistoryBackup(target, history);
    if (!committedManifest) fs.unlinkSync(path.join(history, 'manifest.json'));
    const staleRelative = 'openclaw/state/agents/main/sessions/removed.jsonl';
    fs.writeFileSync(path.join(history, staleRelative), 'uncommitted stale input');
    const source = new Database(path.join(target, DB_FILENAME));
    source
      .prepare('UPDATE cowork_sessions SET title=? WHERE id=?')
      .run('newly committed title', 'native');
    source.close();
    const coordinator = new StartupCoordinator(target);
    await coordinator.prepareBeforeStore(progress());
    expect(planLegacyHistory(history).conversations.find(row => row.id === 'native')?.title).toBe(
      'newly committed title',
    );
    const previous = fs
      .readdirSync(transaction)
      .find(name => name.startsWith('history-uncommitted-'))!;
    expect(previous).toBeDefined();
    expect(fs.existsSync(path.join(history, staleRelative))).toBe(false);
    expect(fs.readFileSync(path.join(transaction, previous, staleRelative), 'utf8')).toBe(
      'uncommitted stale input',
    );
    expect(
      planLegacyHistory(path.join(transaction, previous)).conversations.find(
        row => row.id === 'native',
      )?.title,
    ).toBe('原生标题');
    expect(coordinator.stage).toBe(StartupStage.Initialize);
  },
);

test('a stale pre-backup journal cannot replace a current-generation profile', async () => {
  const target = root();
  const store = SqliteStore.create(target);
  store.set('app_config', { retained: true });
  store.close();
  writeStartupJson(
    path.join(target, STARTUP_STATE_FILE),
    newStartupJournal(StartupRoute.Migration),
  );
  const coordinator = new StartupCoordinator(target);
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(/generation changed/);
  const preserved = SqliteStore.create(target);
  expect(preserved.get('app_config')).toEqual({ retained: true });
  preserved.close();
  expect(fs.existsSync(path.join(target, 'backups'))).toBe(false);
});

test('a missing native transcript falls back to surviving cache without replacing its native identity or child links', () => {
  const source = root();
  legacy(source);
  fs.unlinkSync(path.join(source, 'openclaw/state/agents/main/sessions/original-native.jsonl'));
  const db = new Database(path.join(source, DB_FILENAME));
  db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?)').run(
    'recoverable',
    'native',
    'user',
    'surviving cached content',
    1200,
    1,
  );
  db.close();
  const plan = planLegacyHistory(source);
  expect(plan.conversations.find(row => row.id === 'native')).toMatchObject({
    availability: 'cache',
    nativeSessionId: 'original-native',
  });
  const target = root();
  stageLegacyHistory(source, target, plan);
  expect(
    fs.readFileSync(path.join(target, 'agents/main/sessions/original-native.jsonl'), 'utf8'),
  ).toContain('surviving cached content');
  const entries = JSON.parse(
    fs.readFileSync(path.join(target, 'agents/main/sessions/sessions.json'), 'utf8'),
  );
  expect(entries['agent:main:subagent:child']).toMatchObject({
    spawnedBy: 'agent:main:justdo:native',
    parentSessionId: 'original-native',
  });
});

test('cached tool evidence stays historical text and cannot replay a native tool or settled run', () => {
  const source = root();
  legacy(source);
  const plan = planLegacyHistory(source);
  const session = plan.conversations.find(row => row.id === 'cache')!;
  const events = convertCachedHistory(session, [
    { id: 'user', type: 'user', content: 'old question', created_at: 1100 },
    {
      id: 'tool',
      type: 'tool_use',
      content: 'old tool args',
      created_at: 1200,
      metadata: JSON.stringify({
        toolName: 'exec',
        toolInput: { command: 'historical argument' },
        toolUseId: 'old-call',
        isStreaming: true,
      }),
    },
  ])
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(events[1].message.content[0].text).toBe('old question');
  expect(events[2].message.content[0].text).toContain('old tool args');
  expect(events[2].message.content[0].text).toContain('historical argument');
  expect(events[2].message.content[0].text).not.toContain('isStreaming');
  expect(events[2].parentId).toBe(events[1].id);
  expect(events[2].message.content[0].type).toBe('text');
  expect(JSON.stringify(events)).not.toMatch(/toolCall|executionSettled|runId/);
});

test('uses native canonical rules for the old product namespace while preserving opaque external peers', () => {
  expect(canonicalHistoryKey('agent:main:multica:AbC')).toBe('agent:main:multica:abc');
  expect(canonicalHistoryKey('agent:main:matrix:group:!AbC:Host')).toBe(
    'agent:main:matrix:group:!AbC:Host',
  );
  const dir = root();
  legacy(dir);
  const db = new Database(path.join(dir, DB_FILENAME));
  db.exec(`CREATE TABLE cowork_external_sessions (cowork_session_id TEXT,source TEXT,external_session_key TEXT,
    openclaw_session_key TEXT,openclaw_session_id TEXT);
    INSERT INTO cowork_external_sessions VALUES('native','multica','AbC','agent:main:multica:AbC',NULL);`);
  db.close();
  const index = path.join(dir, 'openclaw/state/agents/main/sessions/sessions.json');
  const entries = JSON.parse(fs.readFileSync(index, 'utf8'));
  entries['agent:main:multica:abc'] = entries['agent:main:justdo:native'];
  delete entries['agent:main:justdo:native'];
  fs.writeFileSync(index, JSON.stringify(entries));
  const row = planLegacyHistory(dir).conversations.find(row => row.id === 'native');
  expect(row).toMatchObject({
    availability: 'native',
    nativeSessionId: 'original-native',
    sessionKey: 'agent:main:multica:abc',
    originalBinding: { sessionKey: 'agent:main:multica:AbC' },
  });
});

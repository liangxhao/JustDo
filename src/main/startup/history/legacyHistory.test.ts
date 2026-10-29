import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { DB_FILENAME } from '../../core/appConstants';
import { CoworkStore } from '../../data/coworkStore';
import { GroupStore } from '../../data/groupStore';
import { SqliteStore } from '../../data/sqliteStore';
import { planLegacyHistory, restoreHistoryMetadata } from './legacyHistory';

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

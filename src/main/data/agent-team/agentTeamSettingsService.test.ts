import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { defaultAgentTeamSettings } from '../../../shared/cowork/agent-team/agentTeamSettings';
import { AgentTeamSettingsService } from './agentTeamSettingsService';
import { CollaborationStore, initializeCollaborationTables } from './collaborationStore';
import { initializeTeamDiscussionTables, TeamDiscussionStore } from './teamDiscussionStore';

let db: Database.Database;
let service: AgentTeamSettingsService;
let collaboration: CollaborationStore;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE agents(id TEXT PRIMARY KEY,enabled INTEGER);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT);
    INSERT INTO agents VALUES ('alice',1),('bob',1);
    INSERT INTO cowork_sessions VALUES ('a','alice','idle'),('b','bob','idle');`);
  initializeCollaborationTables(db);
  initializeTeamDiscussionTables(db);
  service = new AgentTeamSettingsService(db);
  collaboration = new CollaborationStore(db);
  collaboration.createRoom({
    id: 'peer',
    anchorSessionId: 'a',
    members: [
      { agentId: 'alice', sessionId: 'a', sessionKey: 'agent:alice:justdo:a' },
      { agentId: 'bob', sessionId: 'b', sessionKey: 'agent:bob:justdo:b' },
    ],
  });
  new TeamDiscussionStore(db).create({
    id: 'group',
    title: 'Group',
    members: [
      { agentId: 'alice', name: 'Alice' },
      { agentId: 'bob', name: 'Bob' },
    ],
    rounds: 2,
    revision: 1,
    generation: 0,
    state: 'ready',
    cwd: '/project',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  });
});
afterEach(() => db.close());
it('saves preferences atomically offline and rejects stale or invalid writes without changing saved values', () => {
  const value = defaultAgentTeamSettings();
  value.discussion.maxConcurrent = 1;
  expect(service.save(value, 0)).toMatchObject({ revision: 1, value });
  expect(() => service.save(defaultAgentTeamSettings(), 0)).toThrow('agentTeamSettingsConflict');
  expect(() => service.save({ ...value, permissionMode: 'full' }, 1)).toThrow(
    'agentTeamSettingsInvalid',
  );
  expect(service.read().value.discussion.maxConcurrent).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM kv').get()).toEqual({ n: 1 });
});
it('keeps team settings separate from membership revisions and permits only tighter overrides', () => {
  const value = defaultAgentTeamSettings();
  value.discussion.maxConcurrent = 2;
  service.save(value, 0);
  expect(() => service.saveTeam('discussion', 'group', { maxConcurrent: 3 }, 0)).toThrow(
    'agentTeamSettingsOverrideExceeded',
  );
  service.saveTeam('discussion', 'group', { maxConcurrent: 1 }, 0);
  expect(service.readTeam('discussion', 'group').team).toEqual({
    revision: 1,
    value: { maxConcurrent: 1 },
  });
  expect(() => service.saveTeam('discussion', 'group', {}, 0)).toThrow('agentTeamSettingsConflict');
  expect(new TeamDiscussionStore(db).get('group')?.revision).toBe(1);
  expect(() => service.readTeam('discussion', 'foreign')).toThrow('teamDiscussionNotFound');
});
it('freezes the user-round budget, charges failures and unknowns, and checks dedupe before a full budget', () => {
  const value = defaultAgentTeamSettings();
  value.collaboration.messageBudget = 4;
  service.save(value, 0);
  collaboration.beginRound('peer', 'first');
  const send = (call: string) =>
    collaboration.enqueue('peer', 'first', 'agent:alice:justdo:a', call, 'origin', {
      to: 'bob',
      message: 'Work',
    });
  const first = send('one');
  collaboration.transition(first.id, 'queued', 'failed');
  const unknown = send('two');
  collaboration.transition(unknown.id, 'queued', 'dispatching');
  collaboration.transition(unknown.id, 'dispatching', 'unknown');
  send('three');
  send('four');
  expect(send('one').id).toBe(first.id);
  value.collaboration.messageBudget = 16;
  service.save(value, 1);
  collaboration.beginRound('peer', 'first');
  expect(() => send('five')).toThrow('collaborationBudgetExceeded');
  collaboration.beginRound('peer', 'next');
  for (let i = 0; i < 5; i++)
    collaboration.enqueue('peer', 'next', 'agent:alice:justdo:a', `next-${i}`, 'origin', {
      to: 'bob',
      message: 'Next',
    });
  expect(collaboration.listDeliveries('peer')).toHaveLength(9);
});
it('initializes added product columns idempotently and retains old room inheritance', () => {
  initializeCollaborationTables(db);
  initializeTeamDiscussionTables(db);
  expect(service.readTeam('collaboration', 'peer').team).toEqual({ revision: 0, value: {} });
  expect(service.readTeam('discussion', 'group').memberCount).toBe(2);
});

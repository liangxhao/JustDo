import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAgentTeamSettings } from '../../app/contracts/agentTeamSettings';
import {
  COLLABORATION_MESSAGE_BUDGET,
  type CollaborationRoom,
} from '../../app/contracts/collaboration';
import { CollaborationStore, initializeCollaborationTables } from './collaborationStore';

const room: CollaborationRoom = {
  id: 'room',
  anchorSessionId: 'session-a',
  members: ['a', 'b', 'c'].map(agentId => ({
    agentId,
    sessionId: `session-${agentId}`,
    sessionKey: `agent:${agentId}:justdo:session-${agentId}`,
  })),
};
let db: Database.Database;
let store: CollaborationStore;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, enabled INTEGER);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, agent_id TEXT, status TEXT);
    INSERT INTO agents VALUES ('a',1),('b',1),('c',1);
    INSERT INTO cowork_sessions VALUES ('session-a','a','idle'),('session-b','b','idle'),('session-c','c','idle');`);
  initializeCollaborationTables(db);
  store = new CollaborationStore(db);
  store.createRoom(room);
  store.beginRound(room.id, 'turn', room.anchorSessionId);
});
afterEach(() => db.close());
const send = (call = 'call', message = 'Review the change') =>
  store.enqueue(room.id, 'turn', room.members[0].sessionKey, call, 'source-run', {
    to: 'b',
    message,
  });

describe('peer collaboration metadata', () => {
  it('rejects member batch creation and reopening without changing existing receipts or budgets', () => {
    send();
    const rounds = db.prepare('SELECT * FROM collaboration_rounds').all();
    const deliveries = db.prepare('SELECT * FROM collaboration_deliveries').all();

    expect(() => store.beginRound(room.id, 'member-turn', 'session-b'))
      .toThrow('collaborationInvalidRound');
    expect(() => store.beginRound(room.id, 'turn', 'session-b'))
      .toThrow('collaborationInvalidRound');

    expect(db.prepare('SELECT * FROM collaboration_rounds').all()).toEqual(rounds);
    expect(db.prepare('SELECT * FROM collaboration_deliveries').all()).toEqual(deliveries);
    store.beginRound(room.id, 'organizer-turn', 'session-a');
    expect(store.rounds(room.id).map(round => round.id)).toEqual(['turn', 'organizer-turn']);
  });

  it('enforces a reduced roster cap for fresh deliveries without changing accepted receipts', () => {
    const first = send();
    store.transition(first.id, 'queued', 'dispatching');
    store.transition(first.id, 'dispatching', 'accepted', 'native-run');
    const settings = defaultAgentTeamSettings();
    settings.collaboration.maxMembers = 2;
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
      'agentTeam.settings',
      JSON.stringify({ version: 1, revision: 1, value: settings }),
      1,
    );

    expect(send()).toMatchObject({ id: first.id, state: 'accepted', runId: 'native-run' });
    expect(() => send('fresh')).toThrow('agentTeamSettingsMembersExceeded');
    store.beginRound(room.id, 'next-turn', room.anchorSessionId);
    expect(() =>
      store.enqueue(room.id, 'next-turn', room.members[0].sessionKey, 'next-call', 'next-run', {
        to: 'b',
        message: 'New work',
      }),
    ).toThrow('agentTeamSettingsMembersExceeded');
    store.recordExecution(room.members[1].sessionKey, 'native-run', 'completed');

    expect(store.listDeliveries(room.id)).toEqual([
      expect.objectContaining({ id: first.id, state: 'accepted', executionOutcome: 'completed' }),
    ]);
    expect(store.getRoom(room.id)?.members).toHaveLength(3);
    expect(() => store.stopRounds(room.id)).not.toThrow();
  });

  it('checks the current roster cap when committing a room or a prepared member', () => {
    const settings = defaultAgentTeamSettings();
    settings.collaboration.maxMembers = 2;
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
      'agentTeam.settings',
      JSON.stringify({ version: 1, revision: 1, value: settings }),
      1,
    );
    db.exec(
      "INSERT INTO agents VALUES ('d',1); INSERT INTO cowork_sessions VALUES ('session-d','d','idle')",
    );

    expect(() =>
      store.addMember(room.id, {
        agentId: 'd',
        sessionId: 'session-d',
        sessionKey: 'agent:d:justdo:session-d',
      }),
    ).toThrow('agentTeamSettingsMembersExceeded');
    expect(store.getRoom(room.id)?.members).toHaveLength(3);
    db.prepare('DELETE FROM collaboration_rooms WHERE id = ?').run(room.id);
    expect(() => store.createRoom(room)).toThrow('agentTeamSettingsMembersExceeded');
    expect(store.listRooms()).toEqual([]);
  });

  it.each(['completed', 'failed'] as const)(
    'preserves a historical %s batch when stopping later work',
    outcome => {
      const first = send();
      store.transition(first.id, 'queued', 'dispatching');
      store.transition(first.id, 'dispatching', 'accepted', 'first-run');
      store.recordExecution(room.members[1].sessionKey, 'first-run', outcome);
      store.sealRound(room.id, 'turn', 'first-closing');
      store.recordExecution(room.members[0].sessionKey, 'first-closing', 'completed');
      const historical = store.rounds(room.id)[0];
      expect(historical.state).toBe(outcome === 'completed' ? 'settled' : 'failed');
      store.beginRound(room.id, 'next-open', room.anchorSessionId);
      store.enqueue(room.id, 'next-open', room.members[0].sessionKey, 'next-call', 'next-run', {
        to: 'b',
        message: 'Next task',
      });
      store.beginRound(room.id, 'next-closing', room.anchorSessionId);
      store.sealRound(room.id, 'next-closing', 'next-closing-run');

      store.stopRounds(room.id);

      expect(store.rounds(room.id)).toEqual([
        historical,
        { id: 'next-open', state: 'stopped', pending: 1 },
        { id: 'next-closing', closingRunId: 'next-closing-run', state: 'stopped', pending: 0 },
      ]);
      expect(() => send('late-historical-send')).toThrow('collaborationInvalidRound');
      store.recordExecution(room.members[0].sessionKey, 'next-closing-run', 'completed');
      store.stopRounds(room.id);
      expect(store.listRoomEntries()[0].rounds[0]).toEqual(historical);
      expect(store.rounds(room.id)[2].state).toBe('stopped');
    },
  );

  it('lists real ordered batches for navigation without changing room membership', () => {
    const first = send();
    store.transition(first.id, 'queued', 'dispatching');
    store.transition(first.id, 'dispatching', 'accepted', 'first-run');
    store.recordExecution(room.members[1].sessionKey, 'first-run', 'completed');
    store.stopRounds(room.id);
    store.beginRound(room.id, 'next-turn', room.anchorSessionId);
    store.enqueue(room.id, 'next-turn', room.members[0].sessionKey, 'next-call', 'next-run', {
      to: 'c',
      message: 'Review the next change',
    });
    store.beginRound(room.id, 'discovery-only', room.anchorSessionId);
    const reopened = new CollaborationStore(db);
    const entries = reopened.listRoomEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject(room);
    expect(entries[0].rounds).toEqual([
      { id: 'turn', state: 'stopped', pending: 0 },
      { id: 'next-turn', state: 'open', pending: 1 },
    ]);
    expect(Object.keys(entries[0]).sort()).toEqual(['anchorSessionId', 'id', 'members', 'rounds']);
    db.prepare('DELETE FROM collaboration_rooms WHERE id = ?').run(room.id);
    expect(reopened.listRoomEntries()).toEqual([]);
  });
  it('keeps independent native sessions and accepts directed replies without a spawn relationship', () => {
    const outbound = send();
    store.transition(outbound.id, 'queued', 'dispatching');
    store.transition(outbound.id, 'dispatching', 'accepted', 'native-run');
    const reply = store.enqueue(
      room.id,
      'turn',
      room.members[1].sessionKey,
      'reply',
      'source-run',
      {
        to: 'a',
        message: 'Review complete',
        inReplyTo: outbound.id,
      },
    );
    expect(reply).toMatchObject({ from: 'b', to: 'a', inReplyTo: outbound.id, state: 'queued' });
    expect(store.getRoomForSession('session-c')?.id).toBe(room.id);
  });

  it('rejects forged source fields, non-members, self-send and undelivered reply references', () => {
    expect(() =>
      store.enqueue('room', 'turn', room.members[0].sessionKey, 'x', 'source-run', {
        from: 'c',
        to: 'b',
        message: 'forged',
      }),
    ).toThrow('collaborationInvalidMessage');
    expect(() =>
      store.enqueue('room', 'turn', 'agent:a:justdo:other', 'x', 'source-run', {
        to: 'b',
        message: 'outside room',
      }),
    ).toThrow('collaborationInvalidRecipient');
    expect(() =>
      store.enqueue('room', 'turn', room.members[0].sessionKey, 'x', 'source-run', {
        to: 'a',
        message: 'self',
      }),
    ).toThrow('collaborationInvalidRecipient');
    const queued = send();
    expect(() =>
      store.enqueue('room', 'turn', room.members[1].sessionKey, 'reply', 'source-run', {
        to: 'a',
        message: 'reply',
        inReplyTo: queued.id,
      }),
    ).toThrow('collaborationInvalidReply');
  });

  it('reuses the receipt for identical retries and rejects changed inputs without retaining message bodies', () => {
    const first = send();
    expect(send().id).toBe(first.id);
    expect(() => send('call', 'Changed payload')).toThrow('collaborationDuplicateConflict');
    expect(store.listDeliveries('room')).toHaveLength(1);
    const raw = db.prepare('SELECT * FROM collaboration_deliveries').get();
    expect(JSON.stringify(raw)).not.toContain('Review the change');
  });

  it('scopes tool-call identity to its native run and keeps accepted receipts immutable', () => {
    const first = send();
    const otherRun = store.enqueue(
      'room',
      'turn',
      room.members[0].sessionKey,
      'call',
      'other-run',
      {
        to: 'b',
        message: 'Review the change',
      },
    );
    expect(otherRun.id).not.toBe(first.id);
    const dispatched = store.transition(first.id, 'queued', 'dispatching');
    expect(dispatched.updatedAt).toBeGreaterThan(first.updatedAt);
    store.transition(first.id, 'dispatching', 'accepted', 'native-run');
    expect(() => store.transition(first.id, 'accepted', 'accepted', 'different-run')).toThrow();
    expect(store.getDelivery(first.id)?.runId).toBe('native-run');
  });

  it('persists the per-user-turn budget across store recreation and counts failed attempts', () => {
    for (let index = 0; index < COLLABORATION_MESSAGE_BUDGET; index++) {
      const delivery = send(`call-${index}`);
      store.transition(delivery.id, 'queued', 'failed');
    }
    store = new CollaborationStore(db);
    store.beginRound('room', 'turn', room.anchorSessionId);
    expect(() => send('excess')).toThrow('collaborationBudgetExceeded');
    expect(send('call-0').state).toBe('failed');
  });

  it('fails closed after deletion or disabling of a peer', () => {
    db.prepare("UPDATE agents SET enabled = 0 WHERE id = 'b'").run();
    expect(() => send()).toThrow('collaborationInvalidMembers');
    db.prepare("UPDATE agents SET enabled = 1 WHERE id = 'b'").run();
    db.prepare("DELETE FROM cowork_sessions WHERE id = 'session-b'").run();
    expect(() => send()).toThrow('collaborationInvalidRecipient');
  });

  it('recovers interrupted admission as unknown and never returns it to a send queue', () => {
    const uncertain = send();
    store.transition(uncertain.id, 'queued', 'dispatching');
    const queued = send('queued');
    store.recoverInterrupted();
    expect(store.getDelivery(uncertain.id)?.state).toBe('unknown');
    expect(store.getDelivery(queued.id)?.state).toBe('failed');
    expect(() => store.transition(uncertain.id, 'unknown', 'dispatching')).toThrow();
    expect(() => store.transition(uncertain.id, 'unknown', 'accepted')).toThrow();
    expect(store.transition(uncertain.id, 'unknown', 'accepted', 'verified-native-run').state).toBe(
      'accepted',
    );
  });

  it('rejects stale transitions rather than overwriting a newer native receipt', () => {
    const delivery = send();
    store.transition(delivery.id, 'queued', 'dispatching');
    expect(() => store.transition(delivery.id, 'queued', 'failed')).toThrow(
      'collaborationStateConflict',
    );
  });

  it('upgrades additively and cascades room deletion without deleting agent sessions', () => {
    initializeCollaborationTables(db);
    const delivery = send();
    store.transition(delivery.id, 'queued', 'dispatching');
    store.transition(delivery.id, 'dispatching', 'accepted', 'run');
    store.enqueue('room', 'turn', room.members[1].sessionKey, 'reply', 'source-run', {
      to: 'a',
      message: 'reply',
      inReplyTo: delivery.id,
    });
    db.prepare("DELETE FROM collaboration_rooms WHERE id = 'room'").run();
    expect(store.listDeliveries('room')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cowork_sessions').get()).toEqual({ count: 3 });
  });
});

it('seals admission separately from recipient and organizer whole-run outcomes', () => {
  const delivery = send();
  store.transition(delivery.id, 'queued', 'dispatching');
  // Whole-run evidence may arrive before native admission acknowledgement.
  store.recordExecution(room.members[1].sessionKey, 'native-run', 'completed');
  store.sealRound(room.id, 'turn', 'closing-run');
  expect(() => send('late-send')).toThrow('collaborationInvalidRound');
  expect(store.rounds(room.id)[0]).toMatchObject({ state: 'closing', pending: 1 });
  store.transition(delivery.id, 'dispatching', 'accepted', 'native-run');
  expect(store.listDeliveries(room.id)[0]).toMatchObject({
    state: 'accepted',
    executionOutcome: 'completed',
  });
  expect(store.rounds(room.id)[0]).toMatchObject({ state: 'closing', pending: 0 });
  store.recordExecution(room.members[0].sessionKey, 'closing-run', 'completed');
  expect(store.rounds(room.id)[0]).toMatchObject({
    state: 'settled',
    pending: 0,
    closingRunId: 'closing-run',
  });
});

it('does not match another session outcome or mark an unsealed batch complete', () => {
  const delivery = send();
  store.transition(delivery.id, 'queued', 'dispatching');
  store.transition(delivery.id, 'dispatching', 'accepted', 'native-run');
  store.recordExecution(room.members[2].sessionKey, 'native-run', 'completed');
  expect(store.rounds(room.id)[0]).toMatchObject({ state: 'open', pending: 1 });
  store.recordExecution(room.members[1].sessionKey, 'native-run', 'failed');
  expect(store.rounds(room.id)[0]).toMatchObject({ state: 'open', pending: 0 });
  store.sealRound(room.id, 'turn', 'closing-run');
  store.recordExecution(room.members[0].sessionKey, 'closing-run', 'completed');
  expect(store.rounds(room.id)[0].state).toBe('failed');
});

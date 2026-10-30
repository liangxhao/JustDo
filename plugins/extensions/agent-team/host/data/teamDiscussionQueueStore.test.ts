import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { TeamDiscussionRoom } from '../../app/contracts/teamDiscussion';
import { pendingInputFingerprint, TeamDiscussionQueueStore } from './teamDiscussionQueueStore';
import { initializeTeamDiscussionTables, TeamDiscussionStore } from './teamDiscussionStore';

let native: DatabaseSync;
let queue: TeamDiscussionQueueStore;
let metadata: TeamDiscussionStore;
const room: TeamDiscussionRoom = {
  id: 'room',
  title: 'Test',
  members: [
    { agentId: 'a', name: 'A' },
    { agentId: 'b', name: 'B' },
  ],
  rounds: 2,
  revision: 1,
  generation: 0,
  state: 'ready',
  cwd: '/fixture',
  permissionMode: 'ask',
  createdAt: 1,
  updatedAt: 1,
};
const send = {
  roomId: 'room',
  requestId: 'first',
  expectedRevision: 1,
  message: 'Sensitive pending input',
  rounds: 2,
  selectedAgentIds: ['a'],
};
const resources = { settingsRevision: 1, maxRounds: 4, maxTurns: 8, maxConcurrent: 2 };
const identity = {
  roomId: 'room',
  generation: 1,
  agentId: 'a',
  sessionKey: 'agent:a:harness:retired-holding:room:1',
  sessionId: 'native',
  lifecycleRevision: 'revision',
};
beforeEach(() => {
  native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys = ON');
  const db = {
    exec: (sql: string) => native.exec(sql),
    prepare: (sql: string) => native.prepare(sql),
    transaction:
      <T>(fn: () => T) =>
      () => {
        native.exec('BEGIN IMMEDIATE');
        try {
          const result = fn();
          native.exec('COMMIT');
          return result;
        } catch (error) {
          native.exec('ROLLBACK');
          throw error;
        }
      },
  } as unknown as Database.Database;
  initializeTeamDiscussionTables(db);
  metadata = new TeamDiscussionStore(db);
  metadata.create(room);
  queue = metadata.queue;
});
afterEach(() => native.close());
const reserve = (requestId = send.requestId) =>
  queue.reserve(room, { ...send, requestId }, 'policy', resources);
function saved(requestId = send.requestId) {
  const input = reserve(requestId);
  queue.setIdentity(input, identity, input.fingerprint, 'attachments');
  queue.confirm(input, `entry-${requestId}`);
  return queue.get(room.id, requestId)!;
}
it('persists only closed metadata and native locators, never the queued body', () => {
  saved();
  const rows = native.prepare('SELECT * FROM team_discussion_pending_inputs').all();
  expect(JSON.stringify(rows)).not.toContain(send.message);
  expect(rows[0]).toMatchObject({ state: 'queued', entry_id: 'entry-first' });
});
it('allows three simultaneous receipts including uncertain and blocked slots', () => {
  const first = reserve();
  reserve('second');
  reserve('third');
  expect(() => reserve('fourth')).toThrow('teamDiscussionQueueFull');
  queue.transition(first, ['receiving'], 'receiving_unknown');
  expect(() => reserve('fourth')).toThrow('teamDiscussionOutcomeUnknown');
  queue.cancel(room.id, 'first');
  expect(reserve('fourth').state).toBe('receiving');
});
it('replays the same request without another slot and rejects a changed fingerprint', () => {
  const first = saved();
  expect(reserve()).toEqual(first);
  expect(() => queue.reserve(room, { ...send, message: 'changed' }, 'policy', resources)).toThrow(
    'teamDiscussionRequestConflict',
  );
  expect(queue.list(room.id, true)).toHaveLength(1);
});
it('canonicalizes recipient sets without broadening them', () => {
  expect(pendingInputFingerprint({ ...send, selectedAgentIds: ['a', 'b'] })).toBe(
    pendingInputFingerprint({ ...send, selectedAgentIds: ['b', 'a'] }),
  );
  expect(() =>
    queue.reserve(room, { ...send, selectedAgentIds: ['missing'] }, 'policy', resources),
  ).toThrow('teamDiscussionInvalidMembers');
});
it('does not revive a cancelled receipt with a late save acknowledgement', () => {
  const first = reserve();
  queue.setIdentity(first, identity, first.fingerprint, 'attachments');
  queue.cancel(room.id, 'first');
  expect(queue.confirm(first, 'late-entry')).toBe(false);
  expect(queue.get(room.id, 'first')?.state).toBe('cancelled');
});
it('fences all pending input generations before allowing a new request', () => {
  const first = reserve();
  queue.setIdentity(first, identity, first.fingerprint, 'attachments');
  expect(queue.cancelAll(room.id)).toBe(2);
  expect(queue.confirm(first, 'late')).toBe(false);
  expect(reserve('new').generation).toBe(2);
});
it('keeps native saved receipts through restart while receiving and dispatch are uncertain', () => {
  saved();
  reserve('receiving');
  queue.recover();
  expect(queue.get(room.id, 'first')?.state).toBe('queued');
  expect(queue.get(room.id, 'receiving')?.state).toBe('receiving_unknown');
  expect(queue.generation(room.id)).toBe(1);
});
it('claims only the FIFO head and rejects duplicate claims', () => {
  const first = saved();
  const second = saved('second');
  expect(queue.claim(second)).toBe(false);
  expect(queue.claim(first)).toBe(true);
  expect(queue.claim(first)).toBe(false);
  expect(() => queue.cancel(room.id, 'first')).toThrow('teamDiscussionBusy');
});
it('blocks dispatch until current work and every summary have settled', () => {
  const first = saved();
  native
    .prepare(
      "UPDATE team_discussion_rooms SET state = 'running',active_discussion_id = 'previous' WHERE id = ?",
    )
    .run(room.id);
  expect(queue.claim(first)).toBe(false);
  native
    .prepare(
      "UPDATE team_discussion_rooms SET state = 'ready',active_discussion_id = NULL WHERE id = ?",
    )
    .run(room.id);
  native
    .prepare(
      "INSERT INTO team_discussion_runs(id,room_id,request_id,fingerprint,revision,generation,state,created_at,updated_at) VALUES ('previous',?,'prior','fingerprint',1,0,'completed',1,1)",
    )
    .run(room.id);
  native
    .prepare("INSERT INTO team_discussion_summaries VALUES ('previous',?,'unknown',NULL,1)")
    .run(room.id);
  expect(queue.claim(first)).toBe(false);
});
it('reserves the matching queue head and prevents ordinary sends from jumping ahead', () => {
  const first = saved();
  expect(() => metadata.reserve({ ...send, requestId: 'ordinary' })).toThrow('teamDiscussionBusy');
  expect(queue.claim(first)).toBe(true);
  expect(metadata.reserve(send, undefined, resources, send.requestId).reused).toBe(false);
});
it('cannot change a roster while received inputs reference it', () => {
  saved();
  expect(() => metadata.updateMembers(room.id, 1, room.members)).toThrow('teamDiscussionBusy');
});

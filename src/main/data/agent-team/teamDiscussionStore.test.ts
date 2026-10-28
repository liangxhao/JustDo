import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type TeamDiscussionRoom,
  TeamDiscussionState,
} from '../../../shared/cowork/agent-team/teamDiscussion';
import { initializeTeamDiscussionTables, TeamDiscussionStore } from './teamDiscussionStore';

// Run the actual SQL with Node's SQLite in this test. This does not switch the
// shared dependency's Electron ABI or replace the production database driver.
let native: DatabaseSync;
let store: TeamDiscussionStore;
const room: TeamDiscussionRoom = {
  id: 'room',
  title: 'Fixture',
  members: [
    { agentId: 'alice', name: 'Alice' },
    { agentId: 'bob', name: 'Bob' },
  ],
  rounds: 2,
  revision: 1,
  generation: 0,
  state: TeamDiscussionState.READY,
  createdAt: 1,
  updatedAt: 1,
  cwd: '/fixture',
  permissionMode: 'ask',
};
const input = {
  roomId: 'room',
  requestId: 'request',
  expectedRevision: 1,
  message: 'Private prompt fixture',
  selectedAgentIds: ['alice'],
  rounds: 2,
};
beforeEach(() => {
  native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys = ON');
  const db = {
    exec: (sql: string) => native.exec(sql),
    prepare: (sql: string) => native.prepare(sql),
    transaction:
      <T>(operation: () => T) =>
      () => {
        native.exec('BEGIN IMMEDIATE');
        try {
          const result = operation();
          native.exec('COMMIT');
          return result;
        } catch (error) {
          native.exec('ROLLBACK');
          throw error;
        }
      },
  } as unknown as Database.Database;
  initializeTeamDiscussionTables(db);
  store = new TeamDiscussionStore(db);
  store.create(room);
});
afterEach(() => native.close());

describe('group discussion admission and recovery', () => {
  it('reserves before native acceptance and blocks another request', () => {
    const reserved = store.reserve(input);
    expect(store.get('room')).toMatchObject({
      state: 'submitting',
      activeDiscussionId: reserved.discussionId,
    });
    expect(() => store.reserve({ ...input, requestId: 'second' })).toThrow('teamDiscussionBusy');
    expect(
      native.prepare('SELECT COUNT(*) AS count FROM team_discussion_runs').get(),
    ).toMatchObject({ count: 1 });
  });
  it('replays identical requests but rejects changed content with the same key', () => {
    const first = store.reserve(input);
    expect(store.reserve(input)).toEqual({ ...first, reused: true });
    expect(() => store.reserve({ ...input, message: 'Different task' })).toThrow(
      'teamDiscussionRequestConflict',
    );
    expect(() => store.reserve({ ...input, selectedAgentIds: ['bob'] })).toThrow(
      'teamDiscussionRequestConflict',
    );
  });
  it('never broadens invalid recipients into a broadcast', () => {
    expect(() => store.reserve({ ...input, selectedAgentIds: ['removed'] })).toThrow(
      'teamDiscussionInvalidMembers',
    );
    expect(() => store.reserve({ ...input, selectedAgentIds: undefined })).toThrow(
      'teamDiscussionInvalidMembers',
    );
    expect(store.get('room')?.state).toBe('ready');
  });
  it('retains the slot after a restart before native acceptance is known', () => {
    const first = store.reserve(input);
    store.recoverInterrupted();
    expect(store.get('room')).toMatchObject({
      state: 'interrupted',
      generation: 1,
      activeDiscussionId: first.discussionId,
    });
    expect(() => store.reserve({ ...input, requestId: 'second' })).toThrow('teamDiscussionBusy');
    expect(store.transition('room', first.discussionId, 0, 'completed')).toBe(false);
  });
  it('fences late completions after stopping and settles only the frozen generation', () => {
    const first = store.reserve(input);
    store.transition('room', first.discussionId, 0, 'running');
    const frozen = store.freeze('room');
    expect(frozen.generation).toBe(1);
    expect(store.freeze('room').generation).toBe(1);
    expect(store.transition('room', first.discussionId, 0, 'completed')).toBe(false);
    expect(store.transition('room', first.discussionId, 1, 'cancelled')).toBe(true);
    expect(store.reserve({ ...input, requestId: 'next' }).reused).toBe(false);
  });
  it('keeps multiple physical executions and rejects rewriting an existing identity', () => {
    const run = store.reserve(input);
    const execution = {
      discussionId: run.discussionId,
      agentId: 'alice',
      sessionKey: 'agent:alice:justdo-team:group:room',
      sessionId: 'session-a',
      lifecycleRevision: 'revision-a',
      runId: 'run-1',
    };
    store.recordExecution(execution);
    store.recordExecution(execution);
    store.recordExecution({ ...execution, runId: 'run-2' });
    expect(store.executions(run.discussionId)).toHaveLength(2);
    expect(() => store.recordExecution({ ...execution, sessionId: 'rebound-session' })).toThrow(
      'teamDiscussionExecutionConflict',
    );
    expect(store.executions(run.discussionId)[0].sessionId).toBe('session-a');
  });
  it('does not persist the request body in product metadata', () => {
    store.reserve(input);
    const rows = native.prepare('SELECT * FROM team_discussion_runs').all();
    expect(JSON.stringify(rows)).not.toContain(input.message);
    expect(rows[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

it('reinitializes the current schema without changing user request idempotency', () => {
  const original = store.reserve(input);
  const adapter = {
    exec: (sql: string) => native.exec(sql),
    prepare: (sql: string) => native.prepare(sql),
  } as unknown as Database.Database;
  initializeTeamDiscussionTables(adapter);
  initializeTeamDiscussionTables(adapter);
  expect(store.initiator(original.discussionId)).toBeUndefined();
  expect(store.reserve(input)).toMatchObject({ discussionId: original.discussionId, reused: true });
});

function enableSummary(): void {
  native
    .prepare(
      'UPDATE team_discussion_rooms SET source_session_id = ?, summary_source_json = ? WHERE id = ?',
    )
    .run(
      'source',
      JSON.stringify({
        agentId: 'main',
        sessionKey: 'agent:main:justdo:source',
        sessionId: 'native-source',
        lifecycleRevision: 'rev',
      }),
      'room',
    );
}

it('atomically creates a single result handoff for a failed batch without storing its body', () => {
  enableSummary();
  const run = store.reserve(input);
  expect(store.transition('room', run.discussionId, run.generation, 'failed')).toBe(true);
  expect(store.summary(run.discussionId)).toMatchObject({
    discussionId: run.discussionId,
    state: 'pending',
  });
  expect(store.get('room')?.latestRun?.state).toBe('failed');
  expect(store.transition('room', run.discussionId, run.generation, 'failed')).toBe(false);
  const rows = native.prepare('SELECT * FROM team_discussion_summaries').all();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(input.message);
});

it('rolls back terminal state when the transaction cannot persist its result handoff', () => {
  enableSummary();
  const run = store.reserve(input);
  native.exec(
    "CREATE TRIGGER fail_summary BEFORE INSERT ON team_discussion_summaries BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END",
  );

  expect(() => store.transition('room', run.discussionId, run.generation, 'failed')).toThrow(
    'outbox unavailable',
  );

  expect(store.get('room')).toMatchObject({
    state: 'submitting',
    activeDiscussionId: run.discussionId,
  });
  expect(store.get('room')?.latestRun?.state).toBe('submitting');
  expect(store.summary(run.discussionId)).toBeUndefined();
});

it('preserves stop suppression across restart and never creates a handoff for late completion', () => {
  enableSummary();
  const run = store.reserve(input);
  store.freeze('room');
  store.recoverInterrupted();
  const recovered = store.get('room')!;
  expect(recovered.state).toBe('stopping');
  expect(store.transition('room', run.discussionId, recovered.generation, 'completed')).toBe(true);
  expect(store.summary(run.discussionId)).toBeUndefined();
  const next = store.reserve({ ...input, requestId: 'explicit-new-batch' });
  store.transition('room', next.discussionId, next.generation, 'completed');
  expect(store.summary(next.discussionId)?.state).toBe('pending');
});

it('does not let a late running receipt erase a persistent summary cancellation', () => {
  enableSummary();
  const run = store.reserve(input);
  store.transition('room', run.discussionId, run.generation, 'completed');
  store.cancelSummaries('room');
  store.updateSummary(run.discussionId, 'running', 'late-run');
  expect(store.summary(run.discussionId)?.state).toBe('stopping');
  store.updateSummary(run.discussionId, 'cancelled');
  store.updateSummary(run.discussionId, 'delivered', 'late-run');
  expect(store.summary(run.discussionId)?.state).toBe('cancelled');
});

it.each(['pending', 'running', 'unknown', 'stopping'] as const)(
  'keeps %s summaries fenced for all room mutations while allowing exact request replay',
  state => {
    enableSummary();
    const run = store.reserve(input);
    store.transition('room', run.discussionId, run.generation, 'completed');
    if (state === 'stopping') store.cancelSummaries('room');
    else store.updateSummary(run.discussionId, state);
    expect(store.reserve(input)).toMatchObject({ discussionId: run.discussionId, reused: true });
    expect(() => store.reserve({ ...input, requestId: 'new' })).toThrow('teamDiscussionBusy');
    expect(() => store.updateMembers('room', 1, room.members)).toThrow('teamDiscussionBusy');
    expect(() => store.beginDelete('room')).toThrow('teamDiscussionBusy');
    expect(store.get('room')?.state).toBe('ready');
  },
);

it('does not use the bounded summary worker list as a deletion guard', () => {
  for (let index = 0; index < 17; index++) {
    const id = 'other-' + index;
    store.create({
      ...room,
      id,
      sourceSessionId: 'source',
      summarySource: {
        agentId: 'main',
        sessionKey: 'agent:main:justdo:source',
        sessionId: 'native-source',
        lifecycleRevision: 'rev',
      },
    });
    const previous = store.reserve({ ...input, roomId: id });
    store.transition(id, previous.discussionId, previous.generation, 'completed');
    native
      .prepare('UPDATE team_discussion_summaries SET updated_at = 1 WHERE discussion_id = ?')
      .run(previous.discussionId);
  }
  enableSummary();
  const run = store.reserve(input);
  store.transition('room', run.discussionId, run.generation, 'completed');
  expect(store.pendingSummaries().some(summary => summary.roomId === 'room')).toBe(false);
  expect(() => store.beginDelete('room')).toThrow('teamDiscussionBusy');
});

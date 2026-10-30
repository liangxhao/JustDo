import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppMainHost, AppSession } from '@app-plugin/sdk/main';
import {
  discussionMemberSessionKey,
  TeamDiscussionGateway,
  type TeamDiscussionRoom,
} from '../contracts/teamDiscussion';
import { initializeCollaborationTables } from './data/collaborationStore';
import { initializeTeamDiscussionTables, TeamDiscussionStore } from './data/teamDiscussionStore';
import { resolveTeamExecutionSession } from './executionSession';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function fixture(borrowed = false, standalone = false) {
  const sqlite = new DatabaseSync(':memory:');
  cleanups.push(() => sqlite.close());
  const database = {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    transaction:
      <T>(operation: () => T) =>
      () => {
        sqlite.exec('BEGIN');
        try {
          const value = operation();
          sqlite.exec('COMMIT');
          return value;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
  } as unknown as Database.Database;
  initializeCollaborationTables(database);
  initializeTeamDiscussionTables(database);
  const groups = new TeamDiscussionStore(database);
  const room: TeamDiscussionRoom = {
    id: 'room-a',
    title: 'Discussion',
    rounds: 1,
    revision: 1,
    generation: 0,
    state: 'ready',
    cwd: 'C:/project',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
    ...(standalone ? {} : { sourceSessionId: 'product-root' }),
    ...(borrowed
      ? {
          summarySource: {
            agentId: 'role',
            sessionKey: 'agent:role:justdo:product-root',
            sessionId: 'native-child',
            lifecycleRevision: 'child-revision',
          },
        }
      : {}),
    members: [
      {
        agentId: 'role',
        name: 'Role',
        sessionId: 'native-child',
        lifecycleRevision: 'child-revision',
        ...(borrowed ? { ownership: 'source', sessionKey: 'agent:role:justdo:product-root' } : {}),
      },
      {
        agentId: 'other',
        name: 'Other',
        sessionId: 'native-other',
        lifecycleRevision: 'other-revision',
      },
    ],
  };
  groups.create(room);
  const reserved = groups.reserve({
    roomId: room.id,
    requestId: 'request-a',
    expectedRevision: 1,
    message: 'Private group prompt',
    selectedAgentIds: ['role'],
    rounds: 1,
  });
  const query = {
    sessionKey: discussionMemberSessionKey(room, 'role'),
    nativeSessionId: 'native-child',
    lifecycleRevision: 'child-revision',
    runId: 'run-a',
  };
  const owners = new Map<string, AppSession>([
    [
      'product-root',
      {
        id: 'product-root',
        agentId: 'role',
        title: 'Source',
        cwd: room.cwd,
        executionMode: 'local',
        permissionMode: 'ask',
      },
    ],
  ]);
  const description = {
    session: {
      key: query.sessionKey,
      sessionId: query.nativeSessionId,
      lifecycleRevision: query.lifecycleRevision,
      activeRunIds: [query.runId],
    },
  };
  const status = {
    roomId: room.id,
    discussionId: reserved.discussionId,
    executions: [
      {
        discussionId: reserved.discussionId,
        agentId: 'role',
        sessionKey: query.sessionKey,
        sessionId: query.nativeSessionId,
        lifecycleRevision: query.lifecycleRevision,
        runId: query.runId,
        outcome: 'running',
      },
    ],
  };
  const request = vi.fn(async (method: string) =>
    method === TeamDiscussionGateway.Status ? status : description,
  );
  const host = {
    getDatabase: () => database,
    getSessions: () => ({ getSession: (id: string) => owners.get(id) ?? null }),
    requestConnectedGateway: request,
    assertActive: vi.fn(),
  } as unknown as AppMainHost;
  return { host, query, groups, room, reserved, owners, request, status, description, sqlite };
}

it.each([false, true])(
  'uses the exact Native run before Main receipt reconciliation (borrowed: %s)',
  async borrowed => {
    const f = fixture(borrowed);
    expect(f.groups.executions(f.reserved.discussionId)).toEqual([]);
    expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
      ownerSessionId: 'product-root',
      label: 'Role · Discussion',
    });
    expect(f.request.mock.calls.map(call => call[0])).toEqual([
      TeamDiscussionGateway.Status,
      'sessions.describe',
    ]);
  },
);

it('claims a standalone group without inventing a product session', async () => {
  const f = fixture(false, true);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    label: 'Role · Discussion',
  });
});

it.each(['foreign-run', 'reset-incarnation', 'foreign-revision'] as const)(
  'rejects %s evidence',
  async change => {
    const f = fixture(true);
    if (change === 'foreign-run') f.status.executions[0].runId = 'other-run';
    if (change === 'reset-incarnation') f.description.session.sessionId = 'replacement-child';
    if (change === 'foreign-revision')
      f.description.session.lifecycleRevision = 'replacement-revision';
    expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
  },
);

it('drops a borrowed owner deleted while Native identity is being read', async () => {
  const f = fixture(true);
  let complete!: (description: typeof f.description) => void;
  let started!: () => void;
  const reading = new Promise<void>(resolve => {
    started = resolve;
  });
  f.request.mockImplementation(async method => {
    if (method === TeamDiscussionGateway.Status) return f.status;
    started();
    return new Promise(resolve => {
      complete = resolve;
    });
  });
  const resolving = resolveTeamExecutionSession(f.host, f.query);
  await reading;
  f.owners.clear();
  complete(f.description);
  expect(await resolving).toBeNull();
});

it('withdraws an already-stopping discussion instead of showing a late question', async () => {
  const f = fixture();
  f.groups.freeze(f.room.id);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
});

it.each(['room', 'discussion', 'finished-run'] as const)(
  'rejects mismatched discussion %s evidence',
  async change => {
    const f = fixture();
    if (change === 'room') f.status.roomId = 'foreign-room';
    if (change === 'discussion') f.status.discussionId = 'foreign-discussion';
    if (change === 'finished-run') f.description.session.activeRunIds = [];
    expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
  },
);

it('does not retain a group association when Stop changes its generation during the identity read', async () => {
  const f = fixture();
  f.request.mockImplementation(async method => {
    if (method === TeamDiscussionGateway.Status) return f.status;
    f.groups.freeze(f.room.id);
    return f.description;
  });
  expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
});

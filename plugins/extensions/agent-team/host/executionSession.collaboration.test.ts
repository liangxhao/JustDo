import { DatabaseSync } from 'node:sqlite';

import type { AppExecutionSessionQuery, AppMainHost, AppSession } from '@app-plugin/sdk/main';
import { createResourceScope } from '@app-plugin/sdk/resources';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import { CollaborationGateway } from '../contracts/collaboration';
import { register } from './app';
import { CollaborationStore, initializeCollaborationTables } from './data/collaborationStore';
import { initializeTeamDiscussionTables } from './data/teamDiscussionStore';
import { resolveTeamExecutionSession } from './executionSession';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function fixture() {
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
          const result = operation();
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
  } as unknown as Database.Database;
  sqlite.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, enabled INTEGER);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, agent_id TEXT, status TEXT);
    INSERT INTO agents VALUES ('organizer',1),('member',1);
    INSERT INTO cowork_sessions VALUES ('product-root','organizer','idle'),('product-member','member','idle');`);
  initializeCollaborationTables(database);
  initializeTeamDiscussionTables(database);
  const peers = new CollaborationStore(database);
  const key = 'agent:member:justdo:product-member';
  const room = peers.createRoom({
    id: 'room',
    anchorSessionId: 'product-root',
    members: [
      {
        agentId: 'organizer',
        sessionId: 'product-root',
        sessionKey: 'agent:organizer:justdo:product-root',
      },
      { agentId: 'member', sessionId: 'product-member', sessionKey: key },
    ],
  });
  const sessions = new Map<string, AppSession>([
    [
      'product-root',
      {
        id: 'product-root',
        agentId: 'organizer',
        title: 'Original conversation',
        cwd: 'C:/project',
        executionMode: 'local',
        permissionMode: 'ask',
      },
    ],
    [
      'product-member',
      {
        id: 'product-member',
        agentId: 'member',
        title: 'Private member conversation',
        cwd: 'C:/project',
        executionMode: 'local',
        permissionMode: 'ask',
        nativeSessionKey: key,
        historyBinding: { sessionKey: key, nativeSessionId: 'native-member' },
      },
    ],
  ]);
  const query: AppExecutionSessionQuery = {
    sessionKey: key,
    nativeSessionId: 'native-member',
    lifecycleRevision: 'revision-member',
    runId: 'current-run',
    ownerPluginId: 'agent-team',
  };
  const description = {
    session: {
      key,
      sessionId: query.nativeSessionId,
      lifecycleRevision: query.lifecycleRevision,
      activeRunIds: [query.runId!],
    },
  };
  const request = vi.fn(async () => description);
  const host = {
    getDatabase: () => database,
    getSessions: () => ({
      getSession: (id: string) => sessions.get(id) ?? null,
      getAgent: (id: string) => ({ id, name: id === 'member' ? 'Worker' : 'Organizer' }),
    }),
    requestConnectedGateway: request,
    assertActive: vi.fn(),
  } as unknown as AppMainHost;
  function incoming(runId = query.runId!, state: 'dispatching' | 'accepted' = 'accepted') {
    peers.beginRound(room.id, 'organizer-turn', room.anchorSessionId);
    const delivery = peers.enqueue(
      room.id,
      'organizer-turn',
      room.members.find(member => member.sessionId === room.anchorSessionId)!.sessionKey,
      'send-' + runId,
      'organizer-run',
      { to: 'member', message: 'Private delegated task' },
    );
    peers.transition(delivery.id, 'queued', 'dispatching', runId);
    if (state === 'accepted') peers.transition(delivery.id, 'dispatching', 'accepted', runId);
    return delivery;
  }
  return { host, query, peers, room, sessions, sqlite, request, description, incoming };
}

function appFixture() {
  const f = fixture();
  f.sqlite.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const sessions = {
    ...f.host.getSessions(),
    getSessionByNativeKey: (key: string) =>
      [...f.sessions.values()].find(session => session.nativeSessionKey === key) ?? null,
    getSessionRunByClientTurnId: () => null,
    getSessionRuns: () => [],
    getGoalExecutionSnapshot: () => null,
  };
  const sessionsChanged = vi.fn();
  const executionSessionsChanged = vi.fn();
  const nativeListeners = new Set<(event: { event: string; payload: unknown }) => void>();
  const resolved = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === CollaborationGateway.Resolve) {
      const result = params as { requestId: string; result: unknown };
      resolved.get(result.requestId)?.resolve(result.result);
    }
    return { ok: true };
  });
  Object.assign(f.host, {
    getSessions: () => sessions,
    sessionsChanged,
    executionSessionsChanged,
    getRuntime: () => ({ captureGatewayResponseContext: () => ({ isCurrent: () => true }) }),
    getExecution: () => ({ stopSession: async () => undefined }),
    ensureReady: async () => undefined,
    requestGateway,
    isEnabled: () => true,
    onNativeEvent: (listener: (event: { event: string; payload: unknown }) => void) => {
      nativeListeners.add(listener);
      return () => nativeListeners.delete(listener);
    },
  });
  const registration = register(f.host);
  const invoke = (command: string, input: string) =>
    registration.commands.find(item => item.id === command)!.invoke(input);
  // Initialize the recovered coordinator before recording a new dispatch.
  void invoke('collaboration.read', 'product-root');
  const resources = createResourceScope({ signal: f.host.signal });
  registration.onEnable!(resources);
  cleanups.unshift(() => {
    resources.dispose();
    registration.dispose?.();
  });
  async function nativeResult(deliveryId: string, runId: string) {
    const requestId = 'receipt-' + deliveryId;
    const response = Promise.withResolvers<unknown>();
    resolved.set(requestId, response);
    for (const listener of nativeListeners)
      listener({
        event: CollaborationGateway.Requested,
        payload: {
          requestId,
          operation: 'native-result',
          sessionKey: 'agent:organizer:justdo:product-root',
          sourceRunId: 'organizer-run',
          toolCallId: 'send-unconfirmed-run',
          input: { deliveryId, runId, status: 'accepted' },
        },
      });
    return response.promise;
  }
  return { ...f, registration, invoke, nativeResult, sessionsChanged, executionSessionsChanged };
}

it('keeps a direct member user turn in the member conversation, even when Native identifies Team as its owner', async () => {
  const f = fixture();
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
  });
  expect(f.peers.rounds(f.room.id)).toEqual([]);
  expect(f.peers.listDeliveries(f.room.id)).toEqual([]);
});

it('does not borrow an unrelated earlier delivery or open round for a direct member turn', async () => {
  const f = fixture();
  f.incoming('old-peer-run');
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
  });
});

it('promotes a pending source only after the exact Native ACK arrives', async () => {
  const f = fixture();
  const delivery = f.incoming('unconfirmed-run', 'dispatching');
  f.sqlite
    .prepare('UPDATE collaboration_deliveries SET run_id = NULL WHERE id = ?')
    .run(delivery.id);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
    pending: true,
  });
  f.peers.transition(delivery.id, 'dispatching', 'accepted', f.query.runId);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-root',
    label: 'Worker',
  });
});

it('does not promote a pending source when the ACK identifies another Native run', async () => {
  const f = fixture();
  const delivery = f.incoming('unconfirmed-run', 'dispatching');
  f.sqlite
    .prepare('UPDATE collaboration_deliveries SET run_id = NULL WHERE id = ?')
    .run(delivery.id);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toMatchObject({ pending: true });
  f.peers.transition(delivery.id, 'dispatching', 'accepted', 'another-native-run');
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
  });
});

it('retains an unknown send without a run receipt as pending instead of inferring a source', async () => {
  const f = fixture();
  const delivery = f.incoming('unconfirmed-run', 'dispatching');
  f.sqlite
    .prepare('UPDATE collaboration_deliveries SET run_id = NULL WHERE id = ?')
    .run(delivery.id);
  f.peers.transition(delivery.id, 'dispatching', 'unknown');
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
    pending: true,
  });
});

it('keeps a fresh member turn local after an older collaboration was stopped', async () => {
  const f = fixture();
  f.incoming('old-peer-run');
  f.peers.stopRounds(f.room.id);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
  });
});

it('does not guess parent association before the incoming Native run ID is confirmed', async () => {
  const f = fixture();
  const delivery = f.incoming('unconfirmed-run', 'dispatching');
  f.sqlite
    .prepare('UPDATE collaboration_deliveries SET run_id = NULL WHERE id = ?')
    .run(delivery.id);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
    pending: true,
  });
});

it.each(['dispatching', 'accepted'] as const)(
  'maps an exact live %s incoming delivery to the organizer without exposing private task text',
  async state => {
    const f = fixture();
    f.incoming(f.query.runId, state);
    expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
      ownerSessionId: 'product-root',
      label: 'Worker',
    });
  },
);

it('keeps accepted work attached while the organizer seals the round', async () => {
  const f = fixture();
  f.incoming();
  f.peers.sealRound(f.room.id, 'organizer-turn', 'closing-run');
  expect(await resolveTeamExecutionSession(f.host, f.query)).toMatchObject({
    ownerSessionId: 'product-root',
  });
});

it('withdraws a stopped incoming run instead of moving its question into the member conversation', async () => {
  const f = fixture();
  f.incoming();
  f.peers.stopRounds(f.room.id);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
});

it('does not repurpose an uncertain exact delivery as a direct member turn', async () => {
  const f = fixture();
  const delivery = f.incoming(f.query.runId, 'dispatching');
  f.peers.transition(delivery.id, 'dispatching', 'unknown');
  expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
});

it('rejects two deliveries claiming the same Native run instead of selecting one', async () => {
  const f = fixture();
  f.incoming();
  const duplicate = f.peers.enqueue(
    f.room.id,
    'organizer-turn',
    f.room.members.find(member => member.sessionId === f.room.anchorSessionId)!.sessionKey,
    'duplicate-call',
    'organizer-run',
    { to: 'member', message: 'Another receipt' },
  );
  f.peers.transition(duplicate.id, 'queued', 'dispatching');
  f.peers.transition(duplicate.id, 'dispatching', 'accepted', f.query.runId);
  expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
});

it.each(['completed', 'failed', 'cancelled'] as const)(
  'does not treat a %s delivery receipt as a live parent association',
  async outcome => {
    const f = fixture();
    f.incoming();
    f.peers.recordExecution(f.query.sessionKey, f.query.runId!, outcome);
    expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
  },
);

it.each([
  'member-native-id',
  'native-incarnation',
  'native-revision',
  'inactive-run',
  'missing-member',
  'deleted-room',
] as const)(
  'rejects %s rather than attaching an unrelated execution to a conversation',
  async change => {
    const f = fixture();
    f.incoming();
    if (change === 'member-native-id')
      f.sessions.get('product-member')!.historyBinding!.nativeSessionId = 'replacement';
    if (change === 'native-incarnation') f.description.session.sessionId = 'replacement';
    if (change === 'native-revision') f.description.session.lifecycleRevision = 'replacement';
    if (change === 'inactive-run') f.description.session.activeRunIds = ['another-run'];
    if (change === 'missing-member') f.sessions.delete('product-member');
    if (change === 'deleted-room') f.peers.beginDeletion(f.room.id);
    expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
  },
);

it.each(['delete-member', 'delete-source', 'replace-binding', 'stop-round'] as const)(
  'rechecks %s after awaiting Native identity',
  async change => {
    const f = fixture();
    f.incoming();
    f.request.mockImplementationOnce(async () => {
      if (change === 'delete-member') f.sessions.delete('product-member');
      if (change === 'delete-source') f.sessions.delete('product-root');
      if (change === 'replace-binding')
        f.sessions.get('product-member')!.historyBinding!.nativeSessionId = 'replacement';
      if (change === 'stop-round') f.peers.stopRounds(f.room.id);
      return f.description;
    });
    expect(await resolveTeamExecutionSession(f.host, f.query)).toBeNull();
  },
);

it('does not label a member-only user turn as missing when its old organizer was removed', async () => {
  const f = fixture();
  f.sessions.delete('product-root');
  expect(await resolveTeamExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'product-member',
    label: 'Worker',
  });
});

it('requires an exact run before attempting source discovery', async () => {
  const f = fixture();
  expect(await resolveTeamExecutionSession(f.host, { ...f.query, runId: undefined })).toBeNull();
  expect(f.request).not.toHaveBeenCalled();
});

it('notifies the host after a real Native ACK and lets the same pending question acquire its exact organizer source', async () => {
  const f = appFixture();
  const delivery = f.incoming('unconfirmed-run', 'dispatching');
  f.sqlite
    .prepare('UPDATE collaboration_deliveries SET run_id = NULL WHERE id = ?')
    .run(delivery.id);
  expect(await f.registration.resolveExecutionSession!(f.query)).toMatchObject({ pending: true });
  expect(f.executionSessionsChanged).not.toHaveBeenCalled();
  expect(await f.nativeResult(delivery.id, f.query.runId!)).toEqual({ ok: true });
  expect(f.sessionsChanged).toHaveBeenCalledOnce();
  expect(f.executionSessionsChanged).toHaveBeenCalledOnce();
  expect(await f.registration.resolveExecutionSession!(f.query)).toEqual({
    ownerSessionId: 'product-root',
    label: 'Worker',
  });
  await f.invoke('collaboration.read', 'product-root');
  expect(f.executionSessionsChanged).toHaveBeenCalledOnce();
});

it('notifies source withdrawal on Stop without materializing new graphs or completing a delivery', async () => {
  const f = appFixture();
  f.incoming();
  const before = f.peers.listDeliveries(f.room.id);
  const stopped = await f.invoke('collaboration.stop', 'product-root');
  expect(stopped).toMatchObject({ success: true });
  expect(f.executionSessionsChanged).toHaveBeenCalled();
  expect(f.sessionsChanged).toHaveBeenCalledTimes(f.executionSessionsChanged.mock.calls.length);
  expect(f.peers.listDeliveries(f.room.id)).toEqual(before);
  expect(await f.registration.resolveExecutionSession!(f.query)).toBeNull();
});

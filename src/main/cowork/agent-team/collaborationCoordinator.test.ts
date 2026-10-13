import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
import {
  CollaborationStore,
  initializeCollaborationTables,
} from '../../data/agent-team/collaborationStore';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../engine';
import { CollaborationCoordinator } from './collaborationCoordinator';

let db: Database.Database;
let metadata: CollaborationStore;
let coordinator: CollaborationCoordinator;
const request = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const runtimeStatus = vi.fn();
const prepare = vi.fn();
const notifyChanged = vi.fn();
const onSessionDeleted = vi.fn();
const createAssistant = vi.fn();
const discussion = vi.fn();
const stopDiscussions = vi.fn();
const getRuntime = vi.fn<() => OpenClawRuntimeAdapter | null>();
const key = (id: string) => `agent:${id}:justdo:${id}`;
beforeEach(() => {
  getRuntime.mockReset().mockReturnValue(null);
  vi.useFakeTimers();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, enabled INTEGER);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, agent_id TEXT, status TEXT);
    INSERT INTO agents VALUES ('a',1),('b',1),('c',1);
    INSERT INTO cowork_sessions VALUES ('a','a','idle'),('b','b','idle'),('c','c','idle');`);
  initializeCollaborationTables(db);
  metadata = new CollaborationStore(db);
  metadata.createRoom({
    id: 'room',
    anchorSessionId: 'a',
    members: ['a', 'b', 'c'].map(agentId => ({
      agentId,
      sessionId: agentId,
      sessionKey: key(agentId),
    })),
  });
  stopDiscussions.mockReset().mockResolvedValue(undefined);
  discussion.mockReset().mockImplementation(async (_source, _input, _identity, guard) => {
    guard();
    return { roomId: 'group' };
  });
  notifyChanged.mockReset();
  onSessionDeleted.mockReset();
  createAssistant.mockReset().mockImplementation(async (_input, _identity, assertActive) => {
    assertActive();
    return { status: 'created', agentId: 'new-agent' };
  });
  prepare.mockReset().mockResolvedValue(undefined);
  request.mockReset().mockResolvedValue({ ok: true });
  start.mockReset().mockResolvedValue(undefined);
  stop.mockReset().mockResolvedValue(undefined);
  runtimeStatus.mockReset().mockResolvedValue({ known: true, running: false });
  const store = {
    getSession: (id: string) =>
      db
        .prepare('SELECT id, agent_id AS agentId, status FROM cowork_sessions WHERE id = ?')
        .get(id),
    createSession: (
      _title: string,
      _cwd: string,
      _mode: string,
      _skills: unknown,
      agentId: string,
    ) => {
      const id = `peer-${agentId}`;
      db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?)').run(id, agentId, 'idle');
      return { id };
    },
    deleteSession: (id: string) => db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run(id),
    listPlanHandoffs: (id: string) => [{ artifact: { workspaceRoot: `workspace-${id}` } }],
    listAgents: () => db.prepare('SELECT id, enabled, id AS name FROM agents').all(),
    getAgent: (id: string) =>
      db.prepare('SELECT id, enabled, id AS name FROM agents WHERE id = ?').get(id),
    getSessionRuns: (id: string) =>
      id === 'a'
        ? [{ clientTurnId: 'user-turn', rootRunId: 'user-run', state: 'running' }]
        : id === 'c'
          ? [{ clientTurnId: 'other-turn', rootRunId: 'other-run' }]
          : [],
  } as unknown as CoworkStore;
  const router = {
    prepareSession: prepare,
    startSession: start,
    stopSession: stop,
    getSessionRuntimeStatus: runtimeStatus,
    onSessionDeleted,
  } as unknown as CoworkEngineRouter;
  coordinator = new CollaborationCoordinator({
    onSessionsChanged: notifyChanged,
    createAssistant,
    discussion,
    stopDiscussions,
    getDatabase: () => db,
    getStore: () => store,
    getRouter: () => router,
    getRuntime,
    requestGateway: request,
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  db.close();
});
const ensure = (from = 'a', agentId = 'b', runId = 'user-run', call = 'call') =>
  coordinator.handle({
    requestId: call,
    operation: 'ensure',
    sessionKey: key(from),
    sourceRunId: runId,
    toolCallId: call,
    expiresAt: Date.now() + 8000,
    input: { agentId },
  });

describe('individual collaboration member cancellation', () => {
  const input = {
    sourceSessionId: 'a',
    roomId: 'room',
    targetSessionKey: key('b'),
    nativeSessionId: 'native-b',
    runId: 'peer-run',
  };
  const available = () => {
    request.mockImplementation(async method =>
      method === 'sessions.describe'
        ? { session: { key: key('b'), sessionId: 'native-b', activeRunIds: ['peer-run'] } }
        : { ok: true, status: 'aborted', abortedRunId: 'peer-run' },
    );
  };
  it('uses exact native cancellation without stopping other peers, closing rounds or inventing terminal proof', async () => {
    available();
    metadata.beginRound('room', 'user-run');
    await expect(coordinator.stopMember(input)).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith('sessions.abort', {
      key: key('b'),
      runId: 'peer-run',
    });
    expect(stop).not.toHaveBeenCalled();
    expect(stopDiscussions).not.toHaveBeenCalled();
    expect(metadata.rounds('room')[0].state).toBe('open');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM collaboration_execution_receipts').get(),
    ).toEqual({ count: 0 });
  });

  it.each([
    { sourceSessionId: 'b' },
    { roomId: 'other-room' },
    { targetSessionKey: key('outsider') },
    { runId: '' },
    { runId: 123 },
    { clearQueued: true },
  ])('rejects invalid or unrelated identities before native cancellation: %j', async override => {
    available();
    await expect(coordinator.stopMember({ ...input, ...override })).rejects.toThrow();
    expect(request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
  });

  it.each([
    { key: key('c') },
    { sessionId: 'replacement-native' },
    { activeRunIds: ['replacement-run'] },
    { activeRunIds: [] },
  ])('refuses stale native snapshots without cancelling replacement work: %j', async override => {
    request.mockResolvedValue({
      session: { key: key('b'), sessionId: 'native-b', activeRunIds: ['peer-run'], ...override },
    });
    await expect(coordinator.stopMember(input)).rejects.toThrow('collaborationStateConflict');
    expect(request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
  });

  it('rechecks membership after the asynchronous native read', async () => {
    available();
    request.mockImplementation(async () => {
      metadata.markMemberDeleted('room', 'b');
      return { session: { key: key('b'), sessionId: 'native-b', activeRunIds: ['peer-run'] } };
    });
    await expect(coordinator.stopMember(input)).rejects.toThrow('collaborationInvalidRecipient');
    expect(request).toHaveBeenCalledOnce();
  });

  it('uses the native live history identity when an embedded owner omits the complete run set', async () => {
    request.mockImplementation(async method => {
      if (method === 'sessions.describe')
        return { session: { key: key('b'), sessionId: 'native-b', hasActiveRun: true } };
      if (method === 'chat.history')
        return {
          sessionId: 'native-b',
          sessionInfo: { key: key('b'), sessionId: 'native-b' },
          inFlightRun: { runId: 'peer-run' },
          messages: [{ content: 'Never retained by the coordinator' }],
        };
      return { ok: true, status: 'aborted', abortedRunId: 'peer-run' };
    });
    await expect(coordinator.stopMember(input)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith('chat.history', {
      sessionKey: key('b'),
      limit: 1,
      maxBytes: 16_384,
    });
    expect(request).toHaveBeenLastCalledWith('sessions.abort', {
      key: key('b'),
      runId: 'peer-run',
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'replacement' },
    { sessionInfo: { key: key('c'), sessionId: 'native-b' } },
    { sessionInfo: { key: key('b'), sessionId: 'replacement' } },
    { inFlightRun: { runId: 'replacement-run' } },
    { inFlightRun: undefined },
  ])('rejects mismatched embedded live identities before cancellation: %j', async override => {
    request.mockImplementation(async method =>
      method === 'sessions.describe'
        ? { session: { key: key('b'), sessionId: 'native-b', hasActiveRun: true } }
        : {
            sessionId: 'native-b',
            sessionInfo: { key: key('b'), sessionId: 'native-b' },
            inFlightRun: { runId: 'peer-run' },
            ...override,
          },
    );
    await expect(coordinator.stopMember(input)).rejects.toThrow('collaborationStateConflict');
    expect(request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
  });

  it('refuses missing active evidence instead of cancelling by session key', async () => {
    request.mockResolvedValue({
      session: { key: key('b'), sessionId: 'native-b', hasActiveRun: false },
    });
    await expect(coordinator.stopMember(input)).rejects.toThrow('collaborationStateConflict');
    expect(request).toHaveBeenCalledOnce();
  });

  it('rechecks ownership after reading the embedded live snapshot', async () => {
    request.mockImplementation(async method => {
      if (method === 'sessions.describe')
        return { session: { key: key('b'), sessionId: 'native-b', hasActiveRun: true } };
      metadata.markMemberDeleted('room', 'b');
      return {
        sessionId: 'native-b',
        sessionInfo: { key: key('b'), sessionId: 'native-b' },
        inFlightRun: { runId: 'peer-run' },
      };
    });
    await expect(coordinator.stopMember(input)).rejects.toThrow('collaborationInvalidRecipient');
    expect(request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
  });

  it.each([
    { ok: false, status: 'aborted', abortedRunId: 'peer-run' },
    { ok: true, status: 'pending', abortedRunId: 'peer-run' },
    { ok: true, status: 'aborted', abortedRunId: 'other-run' },
  ])('does not report an unconfirmed or mismatched Stop as success: %j', async result => {
    available();
    request.mockImplementation(async method =>
      method === 'sessions.describe'
        ? { session: { key: key('b'), sessionId: 'native-b', activeRunIds: ['peer-run'] } }
        : result,
    );
    await expect(coordinator.stopMember(input)).rejects.toThrow('collaborationStopFailed');
  });

  it('accepts an exact run finishing before cancellation without fabricating an outcome', async () => {
    available();
    request
      .mockResolvedValueOnce({
        session: { key: key('b'), sessionId: 'native-b', activeRunIds: ['peer-run'] },
      })
      .mockResolvedValueOnce({ ok: true, status: 'no-active-run', abortedRunId: null });
    await expect(coordinator.stopMember(input)).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM collaboration_execution_receipts').get(),
    ).toEqual({ count: 0 });
  });
});

it('joins all member cancellations and duplicate room Stops before reporting a partial failure', async () => {
  let release!: () => void;
  stop.mockImplementation(id =>
    id === 'b'
      ? Promise.reject(new Error('b unavailable'))
      : id === 'c'
        ? new Promise<void>(resolve => (release = resolve))
        : Promise.resolve(),
  );
  const first = coordinator.stop('a');
  const second = coordinator.stop('a');
  const firstOutcome = vi.fn();
  const secondOutcome = vi.fn();
  const observedFirst = first.catch(firstOutcome);
  const observedSecond = second.catch(secondOutcome);
  await Promise.resolve();
  await Promise.resolve();
  expect(firstOutcome).not.toHaveBeenCalled();
  expect(secondOutcome).not.toHaveBeenCalled();
  expect(stop.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  release();
  await Promise.all([observedFirst, observedSecond]);
  expect(firstOutcome).toHaveBeenCalledWith(expect.objectContaining({ message: 'b unavailable' }));
  expect(secondOutcome).toHaveBeenCalledWith(expect.objectContaining({ message: 'b unavailable' }));
});

describe('source-mediated collaboration continuation preparation', () => {
  const input = { sourceSessionId: 'a', roomId: 'room', targetSessionKey: key('b') };
  const available = () => {
    getRuntime.mockReturnValue({
      getPlanMode: async () => ({ enabled: false }),
      getGoalExecution: () => null,
    } as unknown as OpenClawRuntimeAdapter);
    request.mockImplementation(async method =>
      method === 'collaboration.health' ? { version: 2 } : { session: { sessionId: 'native-a' } },
    );
  };
  it('prepares the exact source and target without starting or forwarding any execution', async () => {
    available();
    await expect(coordinator.prepareContinuation(input)).resolves.toEqual({
      ...input,
      sourceAgentId: 'a',
      targetAgentId: 'b',
      targetSessionId: 'b',
    });
    expect(start).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  });
  it('refuses disabled extensions, Goal sessions and uncertain members', async () => {
    available();
    request.mockResolvedValue({ version: 1 });
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow(
      'collaborationRuntimeUnavailable',
    );
    available();
    request.mockImplementation(async method =>
      method === 'collaboration.health' ? { version: 2 } : { session: { goal: { id: 'goal' } } },
    );
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow(
      'collaborationContinuationUnavailable',
    );
    available();
    runtimeStatus.mockResolvedValue({ known: false, running: false });
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow('agentBusy');
    expect(start).not.toHaveBeenCalled();
  });
  it('rechecks member disable and source deletion after asynchronous idle reads', async () => {
    available();
    runtimeStatus.mockImplementation(async () => {
      db.prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run('b');
      return { known: true, running: false };
    });
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow(
      'collaborationInvalidRecipient',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('refuses a pending Plan review even when Plan execution is disabled', async () => {
    available();
    request.mockImplementation(async method =>
      method === 'collaboration.health'
        ? { version: 2 }
        : {
            session: {
              pluginExtensions: [
                {
                  pluginId: 'plan-mode',
                  namespace: 'state',
                  value: { enabled: false, awaitingReview: { requestId: 'review' } },
                },
              ],
            },
          },
    );
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow(
      'collaborationContinuationUnavailable',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('rechecks Plan review and new delivery admission after idle lookup', async () => {
    available();
    let awaitingReview = false;
    request.mockImplementation(async method =>
      method === 'collaboration.health'
        ? { version: 2 }
        : {
            session: {
              pluginExtensions: [
                {
                  pluginId: 'plan-mode',
                  namespace: 'state',
                  value: {
                    enabled: false,
                    ...(awaitingReview ? { awaitingReview: { requestId: 'review' } } : {}),
                  },
                },
              ],
            },
          },
    );
    runtimeStatus.mockImplementation(async () => {
      awaitingReview = true;
      return { known: true, running: false };
    });
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow(
      'collaborationContinuationUnavailable',
    );
    available();
    metadata.beginRound('room', 'new');
    runtimeStatus.mockImplementation(async () => {
      metadata.enqueue('room', 'new', key('a'), 'late-tool', 'late-run', {
        to: 'b',
        message: 'Fresh work',
      });
      return { known: true, running: false };
    });
    await expect(coordinator.prepareContinuation(input)).rejects.toThrow('agentBusy');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('peer execution coordination', () => {
  it('reads only room-owned delivery messages through the native lookup', async () => {
    metadata.beginRound('room', 'round');
    const delivery = metadata.enqueue('room', 'round', key('a'), 'call', 'run', {
      to: 'b',
      message: 'Review these changes',
    });
    request.mockResolvedValueOnce({
      messages: [{ deliveryId: delivery.id, message: { role: 'user', content: 'Review' } }],
    });

    await expect(coordinator.readMessages('a', [delivery.id])).resolves.toEqual([
      { deliveryId: delivery.id, message: { role: 'user', content: 'Review' } },
    ]);
    expect(request).toHaveBeenLastCalledWith('collaboration.messages', {
      lookups: [
        expect.objectContaining({
          deliveryId: delivery.id,
          receiptId: delivery.id,
          sessionId: 'b',
          sessionKey: key('b'),
          sourceSessionKey: key('a'),
        }),
      ],
    });
    await expect(coordinator.readMessages('a', ['foreign'])).rejects.toThrow(
      'collaborationInvalidMessage',
    );
  });
  it('shows an expired native acknowledgement as unknown instead of retrying the send', async () => {
    await coordinator.handle({
      requestId: 'send',
      operation: 'native-send',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'send',
      input: { sessionKey: key('b'), message: 'Review' },
    });
    await vi.advanceTimersByTimeAsync(61000);
    expect(coordinator.read('a').deliveries[0].state).toBe('unknown');
    expect(start).not.toHaveBeenCalled();
  });
  it('records native admission and allows its recipient to reply in the same round', async () => {
    await coordinator.handle({
      requestId: 'send',
      operation: 'native-send',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'send',
      input: { sessionKey: key('b'), message: 'Review' },
    });
    const delivery = coordinator.read('a').deliveries[0];
    expect(delivery.state).toBe('dispatching');
    expect(start).not.toHaveBeenCalled();
    await coordinator.handle({
      requestId: 'receipt',
      operation: 'native-result',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'send',
      input: { deliveryId: delivery.id, status: 'accepted', runId: 'native-peer-run' },
    });
    await coordinator.handle({
      requestId: 'reply',
      operation: 'native-send',
      sessionKey: key('b'),
      sourceRunId: 'native-peer-run',
      toolCallId: 'reply',
      input: { sessionKey: key('a'), message: 'Reviewed' },
    });
    expect(coordinator.read('a').deliveries.map(item => item.roundId)).toEqual([
      'user-turn',
      'user-turn',
    ]);
    await coordinator.handle({
      requestId: 'foreign',
      operation: 'native-send',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'foreign',
      input: { sessionKey: 'agent:b:justdo:elsewhere', message: 'No' },
    });
    expect(request).toHaveBeenLastCalledWith('collaboration.resolve', {
      requestId: 'foreign',
      result: { error: 'collaborationInvalidRecipient' },
    });
  });
  it('accepts a fast native recipient reply while the sender acknowledgement is in flight', async () => {
    await coordinator.handle({
      requestId: 'send',
      operation: 'native-send',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'send',
      expiresAt: Date.now() + 8000,
      input: { sessionKey: key('b'), message: 'Review' },
    });
    const delivery = coordinator.read('a').deliveries[0];
    const reply = coordinator.handle({
      requestId: 'reply',
      operation: 'native-send',
      sessionKey: key('b'),
      sourceRunId: 'native-peer-run',
      toolCallId: 'reply',
      expiresAt: Date.now() + 8000,
      input: { sessionKey: key('a'), message: 'Reviewed' },
    });
    await Promise.resolve();
    await coordinator.handle({
      requestId: 'receipt',
      operation: 'native-result',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'send',
      expiresAt: Date.now() + 8000,
      input: { deliveryId: delivery.id, status: 'accepted', runId: 'native-peer-run' },
    });
    await reply;

    expect(coordinator.read('a').deliveries.map(item => item.roundId)).toEqual([
      'user-turn',
      'user-turn',
    ]);
    expect(request).toHaveBeenCalledWith(
      'collaboration.resolve',
      expect.objectContaining({
        requestId: 'reply',
        result: expect.objectContaining({ sessionKey: key('a') }),
      }),
    );
  });
  it('keeps the task frozen after partial deletion and retries only remaining native sessions', async () => {
    request.mockImplementation(async (method, input) => {
      if (method === 'sessions.delete' && input.key === key('b'))
        throw new Error('Gateway offline');
      return { ok: true };
    });
    await expect(coordinator.deleteTask('a')).rejects.toThrow('Gateway offline');
    expect(coordinator.read('a').room?.deleting).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cowork_sessions').get()).toEqual({ n: 3 });
    request.mockClear().mockResolvedValue({ ok: true });
    runtimeStatus.mockImplementation(async id => ({ known: id !== 'a', running: false }));
    await expect(coordinator.deleteTask('a')).resolves.toBe(true);
    expect(
      request.mock.calls.filter(call => call[0] === 'sessions.delete').map(call => call[1].key),
    ).toEqual([key('b'), key('c')]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cowork_sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 3 });
    for (const id of ['a', 'b', 'c']) {
      expect(onSessionDeleted).toHaveBeenCalledWith(id, id, [key(id)], [`workspace-${id}`]);
    }
  });
  it('exposes native creation only to a live main-conversation call', async () => {
    await coordinator.handle({
      requestId: 'create',
      operation: 'create',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'create-call',
      input: { name: 'Review' },
    });
    expect(createAssistant).toHaveBeenCalledWith(
      { name: 'Review' },
      JSON.stringify([key('a'), 'user-run', 'create-call']),
      expect.any(Function),
    );
    expect(request).toHaveBeenCalledWith('collaboration.resolve', {
      requestId: 'create',
      result: { status: 'created', agentId: 'new-agent' },
    });
    createAssistant.mockClear();
    await coordinator.handle({
      requestId: 'blocked',
      operation: 'create',
      sessionKey: key('b'),
      sourceRunId: 'user-run',
      toolCallId: 'create-call',
      input: {},
    });
    expect(createAssistant).not.toHaveBeenCalled();
  });
  it('lets a nested main turn prepare the next peer in the same collaboration round', async () => {
    db.prepare("DELETE FROM collaboration_members WHERE agent_id = 'c'").run();
    metadata.beginRound('room', 'user-turn');
    const inbound = metadata.enqueue('room', 'user-turn', key('b'), 'reply', 'peer-run', {
      to: 'a',
      message: 'Research is ready for review.',
    });
    metadata.transition(inbound.id, 'queued', 'dispatching');
    metadata.transition(inbound.id, 'dispatching', 'accepted', 'nested-main-run');

    await coordinator.handle({
      requestId: 'prepare-reviewer',
      operation: 'ensure',
      sessionKey: key('a'),
      sourceRunId: 'nested-main-run',
      toolCallId: 'prepare-reviewer',
      expiresAt: Date.now() + 8000,
      input: { agentId: 'c' },
    });

    expect(metadata.getRoom('room')!.members.map(member => member.agentId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(prepare).toHaveBeenCalledWith('peer-c');
    expect(request).toHaveBeenLastCalledWith('collaboration.resolve', {
      requestId: 'prepare-reviewer',
      result: {
        member: { agentId: 'c', sessionId: 'peer-c', sessionKey: 'agent:c:justdo:peer-c' },
      },
    });
  });
  it('cancels initial setup when Stop occurs during native preparation', async () => {
    db.prepare('DELETE FROM collaboration_rooms').run();
    prepare.mockImplementationOnce(async () => {
      await coordinator.stop('a');
    });
    await ensure();
    expect(metadata.getRoomForSession('a')).toBeUndefined();
    expect(db.prepare("SELECT id FROM cowork_sessions WHERE id = 'peer-b'").get()).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
  it('waits for native admission before a fast nested main turn recruits another peer', async () => {
    db.prepare("DELETE FROM collaboration_members WHERE agent_id = 'c'").run();
    metadata.beginRound('room', 'user-turn');
    const inbound = metadata.enqueue('room', 'user-turn', key('b'), 'reply', 'peer-run', {
      to: 'a',
      message: 'Ready for the next assistant.',
    });
    metadata.transition(inbound.id, 'queued', 'dispatching');

    const pending = ensure('a', 'c', 'nested-main-run', 'prepare-next');
    await Promise.resolve();
    expect(prepare).not.toHaveBeenCalled();
    await coordinator.handle({
      requestId: 'receipt',
      operation: 'native-result',
      sessionKey: key('b'),
      sourceRunId: 'peer-run',
      toolCallId: 'reply',
      input: { deliveryId: inbound.id, status: 'accepted', runId: 'nested-main-run' },
    });
    await pending;

    expect(prepare).toHaveBeenCalledWith('peer-c');
    expect(request).toHaveBeenLastCalledWith('collaboration.resolve', {
      requestId: 'prepare-next',
      result: {
        member: { agentId: 'c', sessionId: 'peer-c', sessionKey: 'agent:c:justdo:peer-c' },
      },
    });
  });
  it('cleans up failed native preparation and never publishes a fake member', async () => {
    db.prepare('DELETE FROM collaboration_rooms').run();
    prepare.mockRejectedValueOnce(new Error('unavailable'));
    await ensure();
    expect(metadata.listRooms()).toHaveLength(0);
    expect(request).toHaveBeenCalledWith('sessions.delete', { key: 'agent:b:justdo:peer-b' });
  });
  it('does not allow peers to recruit new assistants', async () => {
    db.prepare("DELETE FROM collaboration_members WHERE agent_id = 'c'").run();
    await ensure('b', 'c', 'peer-run');
    expect(prepare).not.toHaveBeenCalled();
    expect(metadata.getRoom('room')!.members).toHaveLength(2);
  });
  it('lists available assistants before a room exists without broadening Subagent permissions', async () => {
    db.prepare('DELETE FROM collaboration_rooms').run();
    await coordinator.handle({ requestId: 'lookup', operation: 'members', sessionKey: key('a') });
    expect(request).toHaveBeenCalledWith('collaboration.resolve', {
      requestId: 'lookup',
      result: {
        limits: {
          collaboration: { maxMembers: 12, messageBudget: 16 },
          discussion: {
            maxMembers: 6,
            defaultRounds: 2,
            maxRounds: 4,
            maxTurns: null,
            maxConcurrent: null,
            organizerParticipates: false,
          },
        },
        members: [],
        available: [
          { agentId: 'b', name: 'b' },
          { agentId: 'c', name: 'c' },
        ],
      },
    });
  });
});

it('routes discussion organization only from the live anchor conversation', async () => {
  const payload = {
    requestId: 'discussion',
    operation: 'discussion',
    sessionKey: key('a'),
    sourceRunId: 'user-run',
    toolCallId: 'group-call',
    input: { action: 'create' },
  };
  await coordinator.handle(payload);
  expect(discussion).toHaveBeenCalledWith(
    'a',
    payload.input,
    JSON.stringify([key('a'), 'user-run', 'group-call']),
    expect.any(Function),
  );
  discussion.mockClear();
  await coordinator.handle({ ...payload, sessionKey: key('b') });
  expect(discussion).not.toHaveBeenCalled();
  await coordinator.stop('a');
  await coordinator.handle(payload);
  expect(discussion).not.toHaveBeenCalled();
});

it('holds nested source deletion leases for every collaboration member until all owners release them', () => {
  const releaseOuter = coordinator.acquireSourceDeletion(['a']);
  const releaseInner = coordinator.acquireSourceDeletion(['b']);
  for (const id of ['a', 'b', 'c']) expect(coordinator.isSourceDeleting(id)).toBe(true);

  releaseOuter();
  releaseOuter();
  for (const id of ['a', 'b', 'c']) expect(coordinator.isSourceDeleting(id)).toBe(true);
  releaseInner();
  for (const id of ['a', 'b', 'c']) expect(coordinator.isSourceDeleting(id)).toBe(false);
});

it('does not leave partial source deletion leases when reading member runs fails', () => {
  const localCoordinator = new CollaborationCoordinator({
    getDatabase: () => db,
    getStore: () =>
      ({
        getSessionRuns: (id: string) => {
          if (id === 'b') throw new Error('run metadata unavailable');
          return [];
        },
      }) as unknown as CoworkStore,
    getRouter: () => ({}) as CoworkEngineRouter,
    getRuntime: () => null,
    requestGateway: request,
  });

  expect(() => localCoordinator.acquireSourceDeletion(['a'])).toThrow('run metadata unavailable');

  for (const id of ['a', 'b', 'c']) expect(localCoordinator.isSourceDeleting(id)).toBe(false);
});

it('freezes new native discussion requests before awaiting source deletion checks', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {
    release = resolve;
  });
  stopDiscussions.mockImplementation(() => waiting);
  const deleting = coordinator.deleteTask('a');
  for (const id of ['a', 'b', 'c']) {
    expect(coordinator.isSourceDeleting(id)).toBe(true);
    expect(stopDiscussions).toHaveBeenCalledWith(id, true);
  }

  await coordinator.handle({
    requestId: 'during-delete',
    operation: 'discussion',
    sessionKey: key('a'),
    sourceRunId: 'user-run',
    toolCallId: 'group-call',
    expiresAt: Date.now() + 8000,
    input: { action: 'create' },
  });

  expect(discussion).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith('collaboration.resolve', {
    requestId: 'during-delete',
    result: { error: 'collaborationDeletePending' },
  });
  expect(stop).not.toHaveBeenCalled();
  release();
  await expect(deleting).resolves.toBe(true);
  for (const id of ['a', 'b', 'c']) expect(coordinator.isSourceDeleting(id)).toBe(false);
});

it('preserves every task member when a peer owns an unresolved linked discussion', async () => {
  stopDiscussions.mockImplementation(async source => {
    if (source === 'b') throw new Error('teamDiscussionBusy');
  });

  await expect(coordinator.deleteTask('a')).rejects.toThrow('teamDiscussionBusy');

  for (const id of ['a', 'b', 'c']) {
    expect(stopDiscussions).toHaveBeenCalledWith(id, true);
    expect(coordinator.isSourceDeleting(id)).toBe(false);
  }
  expect(stop).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM cowork_sessions').get()).toEqual({ n: 3 });
});

it('rejects an in-flight discussion guard after a deletion lease has marked its source run', async () => {
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => {
    resume = resolve;
  });
  discussion.mockImplementation(async (_source, _input, _identity, guard) => {
    await waiting;
    guard();
    return { roomId: 'late-group' };
  });
  const pending = coordinator.handle({
    requestId: 'in-flight',
    operation: 'discussion',
    sessionKey: key('a'),
    sourceRunId: 'user-run',
    toolCallId: 'group-call',
    expiresAt: Date.now() + 8000,
    input: { action: 'create' },
  });
  expect(discussion).toHaveBeenCalledOnce();
  const release = coordinator.acquireSourceDeletion(['a']);
  release();
  resume();
  await pending;

  expect(request).toHaveBeenCalledWith('collaboration.resolve', {
    requestId: 'in-flight',
    result: { error: 'agentUnavailable' },
  });
});

it('rejects a peer send awakened by a late native admission while source deletion is pending', async () => {
  metadata.beginRound('room', 'user-turn');
  const incoming = metadata.enqueue('room', 'user-turn', key('a'), 'original-send', 'user-run', {
    to: 'b',
    message: 'Review the changes',
  });
  metadata.transition(incoming.id, 'queued', 'dispatching');
  const pending = coordinator.handle({
    requestId: 'peer-followup',
    operation: 'native-send',
    sessionKey: key('b'),
    sourceRunId: 'native-peer-run',
    toolCallId: 'peer-followup',
    expiresAt: Date.now() + 8000,
    input: { sessionKey: key('c'), message: 'Check my findings' },
  });
  const release = coordinator.acquireSourceDeletion(['a']);
  await coordinator.handle({
    requestId: 'original-receipt',
    operation: 'native-result',
    sessionKey: key('a'),
    sourceRunId: 'user-run',
    toolCallId: 'original-send',
    input: { deliveryId: incoming.id, status: 'accepted', runId: 'native-peer-run' },
  });
  await pending;

  expect(request).toHaveBeenCalledWith('collaboration.resolve', {
    requestId: 'peer-followup',
    result: { error: 'collaborationDeletePending' },
  });
  expect(metadata.listDeliveries('room')).toHaveLength(1);
  release();
});

it('keeps an old native peer run fenced after deletion releases its lease before the admission ACK', async () => {
  metadata.beginRound('room', 'user-turn');
  const incoming = metadata.enqueue('room', 'user-turn', key('a'), 'original-send', 'user-run', {
    to: 'b',
    message: 'Review the changes',
  });
  metadata.transition(incoming.id, 'queued', 'dispatching');
  const release = coordinator.acquireSourceDeletion(['a']);
  release();
  await coordinator.handle({
    requestId: 'late-receipt',
    operation: 'native-result',
    sessionKey: key('a'),
    sourceRunId: 'user-run',
    toolCallId: 'original-send',
    input: { deliveryId: incoming.id, status: 'accepted', runId: 'late-peer-run' },
  });
  await coordinator.handle({
    requestId: 'after-release',
    operation: 'native-send',
    sessionKey: key('b'),
    sourceRunId: 'late-peer-run',
    toolCallId: 'after-release',
    expiresAt: Date.now() + 8000,
    input: { sessionKey: key('c'), message: 'Continue working' },
  });

  expect(metadata.getDelivery(incoming.id)?.state).toBe('accepted');
  expect(metadata.listDeliveries('room')).toHaveLength(1);
  expect(request).toHaveBeenCalledWith('collaboration.resolve', {
    requestId: 'after-release',
    result: { error: 'collaborationInvalidRound' },
  });
});

it('does not publish a nested main turn recruit after deletion starts during native preparation', async () => {
  db.prepare("DELETE FROM collaboration_members WHERE agent_id = 'c'").run();
  metadata.beginRound('room', 'user-turn');
  const incoming = metadata.enqueue('room', 'user-turn', key('b'), 'reply', 'peer-run', {
    to: 'a',
    message: 'Ready for review',
  });
  metadata.transition(incoming.id, 'queued', 'dispatching');
  metadata.transition(incoming.id, 'dispatching', 'accepted', 'nested-main-run');
  let finishPrepare!: () => void;
  prepare.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finishPrepare = resolve;
      }),
  );
  const pending = ensure('a', 'c', 'nested-main-run', 'late-recruit');
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  const release = coordinator.acquireSourceDeletion(['a']);
  finishPrepare();
  await pending;

  expect(metadata.getRoom('room')?.members.map(member => member.agentId)).toEqual(['a', 'b']);
  expect(db.prepare("SELECT id FROM cowork_sessions WHERE id = 'peer-c'").get()).toBeUndefined();
  expect(request).toHaveBeenCalledWith('sessions.delete', { key: 'agent:c:justdo:peer-c' });
  expect(start).not.toHaveBeenCalled();
  release();
});

it('still stops task peers when stopping a linked discussion fails', async () => {
  stopDiscussions.mockRejectedValueOnce(new Error('offline'));
  await expect(coordinator.stop('a')).rejects.toThrow('offline');
  expect(stop.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
});

it('joins a synchronous sessionStopped cascade before dispatching another member stop', async () => {
  let cascading: Promise<void> | undefined;
  stop.mockImplementationOnce(() => {
    // Preparation-only native cancellation can emit sessionStopped synchronously.
    cascading = coordinator.stop('a');
    return Promise.resolve();
  });

  await coordinator.stop('a');
  await cascading;

  expect(stop.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
});

it('closes collaboration admission before yielding to native cancellation', async () => {
  metadata.beginRound('room', 'user-turn');
  const admitted = metadata.enqueue('room', 'user-turn', key('a'), 'first-send', 'user-run', {
    to: 'b',
    message: 'Work',
  });
  metadata.transition(admitted.id, 'queued', 'dispatching');
  metadata.transition(admitted.id, 'dispatching', 'accepted', 'peer-run');

  const stopping = coordinator.stop('a');

  expect(metadata.rounds('room').every(round => round.state === 'stopped')).toBe(true);
  const forwarding = coordinator.handle({
    requestId: 'late-send',
    operation: 'native-send',
    sessionKey: key('b'),
    sourceRunId: 'peer-run',
    toolCallId: 'late-send',
    input: { sessionKey: key('c'), message: 'Keep working' },
  });
  await Promise.all([stopping, forwarding]);
  expect(metadata.listDeliveries('room')).toHaveLength(1);
});

it('uses only whole-run terminal lifecycle evidence for collaboration progress', () => {
  metadata.beginRound('room', 'user-turn');
  const delivery = metadata.enqueue('room', 'user-turn', key('a'), 'call', 'user-run', {
    to: 'b',
    message: 'Work',
  });
  metadata.transition(delivery.id, 'queued', 'dispatching');
  metadata.transition(delivery.id, 'dispatching', 'accepted', 'peer-run');
  for (const data of [
    { phase: 'finishing', executionSettled: true },
    { phase: 'error' },
    { phase: 'end', executionSettled: false },
  ]) {
    coordinator.observeExecution({
      stream: 'lifecycle',
      sessionKey: key('b'),
      runId: 'peer-run',
      data,
    });
  }
  expect(coordinator.read('a').deliveries[0].executionOutcome).toBeUndefined();
  coordinator.observeExecution({
    stream: 'lifecycle',
    sessionKey: key('b'),
    runId: 'peer-run',
    data: { phase: 'end', executionSettled: true },
  });
  expect(coordinator.read('a').deliveries[0].executionOutcome).toBe('completed');
});

it('waits for native admission when an organizer seals immediately after peer feedback', async () => {
  metadata.beginRound('room', 'user-turn');
  const incoming = metadata.enqueue('room', 'user-turn', key('b'), 'reply', 'peer-run', {
    to: 'a',
    message: 'Results',
  });
  metadata.transition(incoming.id, 'queued', 'dispatching');
  const sealing = coordinator.handle({
    requestId: 'seal',
    operation: 'seal',
    sessionKey: key('a'),
    sourceRunId: 'closing-run',
    toolCallId: 'seal-tool',
    expiresAt: Date.now() + 8000,
    input: { seal: true },
  });
  await coordinator.handle({
    requestId: 'native-ack',
    operation: 'native-result',
    sessionKey: key('b'),
    sourceRunId: 'peer-run',
    toolCallId: 'reply',
    expiresAt: Date.now() + 8000,
    input: { deliveryId: incoming.id, status: 'accepted', runId: 'closing-run' },
  });
  await vi.advanceTimersByTimeAsync(1000);
  await sealing;
  expect(metadata.rounds('room')[0]).toMatchObject({
    closingRunId: 'closing-run',
    state: 'closing',
  });
});

const reviewFixture = () => {
  metadata.beginRound('room', 'user-turn');
  const admit = (to: string, runId: string) => {
    const item = metadata.enqueue('room', 'user-turn', key('a'), runId, 'user-run', {
      to,
      message: 'Task',
    });
    metadata.transition(item.id, 'queued', 'dispatching');
    metadata.transition(item.id, 'dispatching', 'accepted', runId);
    return item.id;
  };
  const worker = admit('b', 'work-run');
  const reviewer = admit('c', 'review-run');
  coordinator.observeExecution({
    stream: 'lifecycle',
    sessionKey: key('b'),
    runId: 'work-run',
    data: { phase: 'end', executionSettled: true },
  });
  return { worker, reviewer };
};

it('accepts exact independent review metadata only from its admitted reviewer run', async () => {
  const { worker, reviewer } = reviewFixture();
  await coordinator.handle({
    requestId: 'report',
    operation: 'review',
    sessionKey: key('c'),
    sourceRunId: 'review-run',
    toolCallId: 'report-tool',
    input: { review: { deliveryIds: [worker], verdict: 'passed' } },
  });
  expect(request).toHaveBeenLastCalledWith('collaboration.resolve', {
    requestId: 'report',
    result: {
      review: expect.objectContaining({
        reviewDeliveryId: reviewer,
        verdict: 'passed',
        state: 'pending',
      }),
    },
  });
  coordinator.observeExecution({
    stream: 'lifecycle',
    sessionKey: key('c'),
    runId: 'review-run',
    data: { phase: 'end', executionSettled: true },
  });
  expect(coordinator.read('a').reviews).toEqual([expect.objectContaining({ state: 'confirmed' })]);
  await coordinator.handle({ requestId: 'members', operation: 'members', sessionKey: key('a') });
  expect(request).toHaveBeenLastCalledWith('collaboration.resolve', {
    requestId: 'members',
    result: expect.objectContaining({
      deliveries: expect.arrayContaining([
        expect.objectContaining({ id: worker, executionOutcome: 'completed' }),
      ]),
      reviews: expect.arrayContaining([expect.objectContaining({ state: 'confirmed' })]),
    }),
  });
});

it.each(['unchanged', 'disabled', 'reassigned'] as const)(
  'rechecks %s reviewer identity after waiting for a delayed native acknowledgement',
  async identity => {
    const { worker, reviewer } = reviewFixture();
    db.prepare(
      "UPDATE collaboration_deliveries SET state='dispatching',run_id=NULL WHERE id=?",
    ).run(reviewer);
    const reporting = coordinator.handle({
      requestId: 'report',
      operation: 'review',
      sessionKey: key('c'),
      sourceRunId: 'review-run',
      toolCallId: 'report-tool',
      expiresAt: Date.now() + 8000,
      input: { review: { deliveryIds: [worker], verdict: 'passed' } },
    });
    if (identity === 'disabled') db.prepare("UPDATE agents SET enabled=0 WHERE id='c'").run();
    if (identity === 'reassigned')
      db.prepare("UPDATE cowork_sessions SET agent_id='b' WHERE id='c'").run();
    await coordinator.handle({
      requestId: 'native-ack',
      operation: 'native-result',
      sessionKey: key('a'),
      sourceRunId: 'user-run',
      toolCallId: 'review-run',
      expiresAt: Date.now() + 8000,
      input: { deliveryId: reviewer, status: 'accepted', runId: 'review-run' },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await reporting;
    expect(coordinator.read('a').reviews).toHaveLength(identity === 'unchanged' ? 1 : 0);
  },
);

it('bounds admission waiting and never guesses a review run when the acknowledgement is missing', async () => {
  const { worker, reviewer } = reviewFixture();
  db.prepare("UPDATE collaboration_deliveries SET state='dispatching',run_id=NULL WHERE id=?").run(
    reviewer,
  );
  const reporting = coordinator.handle({
    requestId: 'report',
    operation: 'review',
    sessionKey: key('c'),
    sourceRunId: 'review-run',
    toolCallId: 'report-tool',
    input: { review: { deliveryIds: [worker], verdict: 'passed' } },
  });
  await vi.advanceTimersByTimeAsync(2000);
  await reporting;
  expect(coordinator.read('a').reviews).toEqual([]);
});

it('rejects mixed actions, forged review identity and expired review calls', async () => {
  const { worker } = reviewFixture();
  const payload = {
    requestId: 'report',
    operation: 'review',
    sessionKey: key('c'),
    sourceRunId: 'review-run',
    toolCallId: 'report-tool',
    input: { review: { deliveryIds: [worker], verdict: 'passed' } },
  };
  for (const invalid of [
    { ...payload, input: { ...payload.input, agentId: 'b' } },
    { ...payload, sourceRunId: 'forged' },
    { ...payload, expiresAt: Date.now() - 1 },
  ]) {
    await coordinator.handle(invalid);
    expect(request).toHaveBeenLastCalledWith('collaboration.resolve', {
      requestId: 'report',
      result: expect.objectContaining({ error: expect.any(String) }),
    });
  }
  expect(coordinator.read('a').reviews).toEqual([]);
});

it('does not accept a review after its task has stopped', async () => {
  const { worker } = reviewFixture();
  await coordinator.stop('a');
  await coordinator.handle({
    requestId: 'report',
    operation: 'review',
    sessionKey: key('c'),
    sourceRunId: 'review-run',
    toolCallId: 'report-tool',
    input: { review: { deliveryIds: [worker], verdict: 'passed' } },
  });
  expect(coordinator.read('a').reviews).toEqual([]);
});

import { AsyncResource } from 'node:async_hooks';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { AppPluginError, parseAppPluginManifest } from '../../packages/app-plugin-sdk/contracts';
import type { AppMainRegistration } from '../../packages/app-plugin-sdk/main';
import { appNativeDispatchMethod } from '../../packages/app-plugin-sdk/native-contract';
import { CollaborationGateway } from '../../plugins/extensions/agent-team/contracts/collaboration';
import {
  TeamDiscussionGateway as Gateway,
  teamDiscussionSessionKey,
  type TeamDiscussionRoom,
} from '../../plugins/extensions/agent-team/contracts/teamDiscussion';
import { register } from '../../plugins/extensions/agent-team/host/app';
import { CollaborationStore } from '../../plugins/extensions/agent-team/host/data/collaborationStore';
import { TeamDiscussionStore } from '../../plugins/extensions/agent-team/host/data/teamDiscussionStore';
import { CoworkStore } from '../../src/main/data/coworkStore';
import { SqliteStore } from '../../src/main/data/sqliteStore';
import { bindPluginGatewayClient } from '../../src/main/engine/gateway/pluginRequestBinding';
import type { GatewayClientLike } from '../../src/main/engine/gateway/types';
import { type AppHostResources, AppPluginRegistry } from '../../src/main/plugins/app/registry';
import { AppSessionParticipants } from '../../src/main/plugins/app/sessionParticipants';

vi.mock('electron', () => ({ app: {}, ipcMain: { handle: vi.fn() } }));

const fixtures: Array<{ close(): void }> = [];
afterEach(() => {
  fixtures.splice(0).forEach(fixture => fixture.close());
  vi.useRealTimers();
});

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const managedKey = (session: { id: string; agentId: string }) =>
  `agent:${session.agentId}:justdo:${session.id}`;

/** Real product schema, stores, registry scopes, and Team entry. Only native I/O is a port. */
async function fixture(initiallyEnabled = false) {
  vi.useFakeTimers();
  // Native Node timers inherit their creator's ALS stores. Fake timers dispatch
  // manually, so preserve that real scheduling contract when advancing the clock.
  const interval = globalThis.setInterval;
  const intervalContext = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation((callback, delay, ...args) =>
      interval(AsyncResource.bind(callback), delay, ...args),
    );
  const root = mkdtempSync(path.join(tmpdir(), 'agent-team-lifecycle-'));
  const product = SqliteStore.create(root);
  const database = product.getDatabase();
  const sessions = new CoworkStore(database);
  for (const id of ['main', 'alice', 'bob'])
    sessions.saveAgentProfile({
      id,
      name: id,
      description: '',
      icon: '',
      model: '',
      enabled: true,
      isDefault: id === 'main',
    });
  const source = sessions.createSession('Source', root, 'local', [], 'main', 'ask');
  const peer = sessions.createSession('Peer', root, 'local', [], 'alice', 'ask');
  const manifest = parseAppPluginManifest(
    JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '../../plugins/extensions/agent-team/app.plugin.json'),
        'utf8',
      ),
    ),
  );
  const binding = {
    pluginId: manifest.nativePluginId,
    registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    processId: 123,
    gatewayMethods: [],
  };
  let enabled = initiallyEnabled;
  let proofAvailable = true;
  let current = true;
  const statuses = new Map<string, Record<string, unknown>>();
  const holdingStates = new Map<string, string>();
  const calls: Array<{ method: string; params: Record<string, unknown>; bound: boolean }> = [];
  const nativeRequest = vi.fn(async (wireMethod: string, value?: unknown) => {
    const bound = wireMethod === appNativeDispatchMethod(manifest.nativePluginId);
    const envelope = value as { method: string; params?: unknown };
    const method = bound ? envelope.method : wireMethod;
    const params = ((bound ? envelope.params : value) as Record<string, unknown> | undefined) ?? {};
    calls.push({ method, params, bound });
    if (method === Gateway.Status || method === Gateway.Stop) {
      if (!enabled) throw new Error('teamDiscussionDisabled');
      return statuses.get(String(params.discussionId)) ?? { state: 'unknown' };
    }
    if (method === Gateway.OfflineControl) {
      if (enabled) throw new Error('teamDiscussionBusy');
      if (params.operation === 'summary-stop') return { state: 'cancelled' };
      return statuses.get(String(params.discussionId)) ?? { state: 'unknown' };
    }
    if (method === Gateway.HoldingCancel) return { cancelled: true };
    if (method === Gateway.HoldingStatus)
      return {
        state: holdingStates.get(String(params.requestId)) ?? 'unknown',
        requestId: params.requestId,
        fingerprint: params.fingerprint,
        entryId: `entry-${params.requestId}`,
      };
    if (method === CollaborationGateway.Health) return { version: 2 };
    if (method === CollaborationGateway.Resolve) return { ok: true };
    if (method === Gateway.Close)
      return {
        members: (params.agentIds as string[]).map(agentId => ({
          agentId,
          sessionId: `member-${agentId}`,
          lifecycleRevision: 'revision',
          sessionRoot: root,
          permissionMode: 'guarded',
        })),
      };
    if (method === 'sessions.describe') {
      const candidate = sessions.getSession(String(params.key).split(':').at(-1) ?? '');
      const session = candidate && managedKey(candidate) === params.key ? candidate : null;
      return {
        session: session
          ? {
              key: params.key,
              agentId: session.agentId,
              sessionId: `native-${session.id}`,
              lifecycleRevision: `revision-${session.id}`,
            }
          : null,
      };
    }
    if (method === 'sessions.delete') return { ok: true };
    throw new Error(`Unexpected native method: ${method}`);
  });
  const client = bindPluginGatewayClient({
    request: nativeRequest,
    start() {},
    stop() {},
  } as unknown as GatewayClientLike);
  const request = <T>(method: string, params?: unknown) => client.request<T>(method, params);
  const nativeListeners = new Set<Parameters<AppHostResources['onNativeEvent']>[0]>();
  const stopListeners = new Set<Parameters<AppHostResources['onSessionStopped']>[0]>();
  const stopped = vi.fn(async (_id: string) => undefined);
  const execution = {
    prepareSession: vi.fn(async (id: string) => ({
      sessionKey: managedKey(sessions.getSession(id)!),
      gatewaySessionId: `native-${id}`,
    })),
    getSessionRuntimeStatus: vi.fn(async () => ({
      known: true,
      running: false,
      mainRunning: false,
      subagentRunning: false,
    })),
    stopSession: stopped,
    onSessionDeleted: vi.fn(),
  };
  const runtime = {
    captureGatewayResponseContext: () => ({ isCurrent: () => current }),
    getPlanMode: async () => ({ enabled: false }),
    getGoalExecution: () => null,
    getSessionKeysForSession: (id: string) => [managedKey(sessions.getSession(id)!)],
    getGatewayClient: () => client,
  };
  const registry = new AppPluginRegistry(() => ({
    enabled: enabled && proofAvailable,
    confirmed: proofAvailable,
    configurationEnabled: enabled,
    ...(proofAvailable ? { binding } : {}),
  }));
  const resources: AppHostResources = {
    getDatabase: () => database,
    getNativeStateDirectory: () => root,
    getSessions: () => sessions,
    getExecution: () => execution,
    getRuntime: () => runtime,
    ensureReady: vi.fn(async () => undefined),
    requestGateway: request,
    requestConnectedGateway: request,
    onNativeEvent: listener => {
      nativeListeners.add(listener);
      return () => {
        nativeListeners.delete(listener);
      };
    },
    onSessionStopped: listener => {
      stopListeners.add(listener);
      return () => {
        stopListeners.delete(listener);
      };
    },
    sessionsChanged: vi.fn(),
    createAssistant: vi.fn(async (_input, _identity, assertActive) => {
      assertActive();
      return { status: 'created', agentId: 'created' };
    }),
  };
  let registration!: AppMainRegistration;
  await registry.prepare(
    { root, artifact: { manifest, hash: 'a'.repeat(64), files: {} } },
    resources,
    async () => ({ register: host => (registration = register(host)) }),
  );
  registry.initializeDatabase(database);
  registry.activate();
  await flush();
  expect(registry.snapshot()[0].state).toBe(initiallyEnabled ? 'active' : 'cleanup');
  const metadata = new TeamDiscussionStore(database);
  const collaboration = new CollaborationStore(database);
  const participants = new AppSessionParticipants(registry);
  let closed = false;
  const result = {
    registry,
    registration,
    metadata,
    collaboration,
    participants,
    source,
    peer,
    sessions,
    execution,
    nativeRequest,
    calls,
    statuses,
    holdingStates,
    resources,
    emit(event: string, payload: unknown) {
      for (const listener of nativeListeners) listener({ event, payload });
    },
    invoke: (command: string, ...args: unknown[]) =>
      registry.invoke({
        id: manifest.id,
        epoch: registry.snapshot()[0].epoch,
        command,
        args,
      }),
    async setEnabled(value: boolean) {
      await registry.mutate(manifest.id, value, async () => {
        enabled = value;
      });
      await flush();
    },
    setProofAvailable(value: boolean) {
      proofAvailable = value;
      registry.refresh();
    },
    room(id = 'room', linked = true): TeamDiscussionRoom {
      const room: TeamDiscussionRoom = {
        id,
        title: id,
        cwd: root,
        permissionMode: 'ask',
        readOnly: true,
        members: ['alice', 'bob'].map(agentId => ({
          agentId,
          name: agentId,
          sessionId: `member-${agentId}`,
          lifecycleRevision: 'revision',
        })),
        rounds: 2,
        revision: 1,
        generation: 0,
        state: 'ready',
        createdAt: 1,
        updatedAt: 1,
        ...(linked
          ? {
              sourceSessionId: source.id,
              summarySource: {
                agentId: source.agentId,
                sessionKey: managedKey(source),
                sessionId: `native-${source.id}`,
                lifecycleRevision: `revision-${source.id}`,
              },
            }
          : {}),
      };
      metadata.create(room);
      return room;
    },
    close() {
      if (closed) return;
      closed = true;
      registry.dispose();
      intervalContext.mockRestore();
      current = false;
      product.close();
      expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
      expect(path.basename(root)).toMatch(/^agent-team-lifecycle-/u);
      rmSync(root, { recursive: true, force: true });
    },
  };
  fixtures.push(result);
  return result;
}

const send = (roomId: string, requestId = 'request') => ({
  roomId,
  requestId,
  expectedRevision: 1,
  message: 'Private native input',
  selectedAgentIds: [],
  rounds: 2,
});

it('reconciles exact discussion receipts while disabled without admitting work or history', async () => {
  const f = await fixture();
  const room = f.room();
  const run = f.metadata.reserve(send(room.id));
  f.statuses.set(run.discussionId, {
    roomId: room.id,
    discussionId: run.discussionId,
    state: 'completed',
    executions: [
      {
        discussionId: run.discussionId,
        agentId: 'alice',
        sessionKey: teamDiscussionSessionKey(room.id, 'alice'),
        sessionId: 'member-alice',
        lifecycleRevision: 'revision',
        runId: 'native-run',
        outcome: 'completed',
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(3000);

  expect(f.metadata.get(room.id)).toMatchObject({ state: 'ready' });
  expect(f.metadata.get(room.id)?.activeDiscussionId).toBeUndefined();
  expect(f.metadata.executions(run.discussionId)).toMatchObject([{ runId: 'native-run' }]);
  expect(f.metadata.summary(run.discussionId)?.state).toBe('cancelled');
  expect(await f.invoke('discussion.read', room.id)).toMatchObject({
    success: false,
    error: AppPluginError.Unavailable,
  });
  expect(f.calls.every(call => !call.bound)).toBe(true);
  expect(
    f.calls.some(call =>
      [
        Gateway.Prepare,
        Gateway.Start,
        Gateway.HoldingRead,
        Gateway.History,
        Gateway.Summary,
      ].includes(call.method as never),
    ),
  ).toBe(false);
  expect(f.resources.ensureReady).not.toHaveBeenCalled();

  f.close();
  const count = f.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.calls).toHaveLength(count);
});

it('does not treat hot disable and re-enable as interrupted-process recovery', async () => {
  const f = await fixture(true);
  const room = f.room();
  const run = f.metadata.reserve(send(room.id));
  f.metadata.transition(room.id, run.discussionId, run.generation, 'running');
  f.statuses.set(run.discussionId, {
    roomId: room.id,
    discussionId: run.discussionId,
    state: 'running',
    executions: [],
  });
  await f.setEnabled(false);
  await f.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);

  expect(f.metadata.get(room.id)).toMatchObject({ state: 'running', generation: 0 });
  expect(f.calls.filter(call => call.method === Gateway.Status)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.calls.filter(call => call.method === Gateway.Status)).toHaveLength(2);
  expect(f.registry.snapshot()[0].state).toBe('active');
});

it('retains unknown holding receipts and cleans only persisted cancellation while disabled', async () => {
  const f = await fixture();
  const room = f.room('holding', false);
  const resources = { settingsRevision: 0, maxRounds: 4, maxTurns: 8, maxConcurrent: 2 };
  const queue = f.metadata.queue;
  const first = queue.reserve(room, send(room.id, 'saved'), 'policy', resources);
  const identity = {
    roomId: room.id,
    generation: first.generation,
    agentId: 'alice',
    sessionKey: `agent:alice:harness:justdo-team-holding:${room.id}:${first.generation}`,
    sessionId: 'holding-native',
    lifecycleRevision: 'holding-revision',
  };
  queue.setIdentity(first, identity, first.fingerprint, 'attachments');
  queue.confirm(first, 'saved-entry');
  const unknown = queue.reserve(room, send(room.id, 'uncertain'), 'policy', resources);
  queue.setIdentity(unknown, identity, unknown.fingerprint, 'attachments');
  queue.transition(unknown, ['receiving'], 'receiving_unknown');
  queue.cancel(room.id, first.requestId);
  f.holdingStates.set(unknown.requestId, 'unknown');
  await vi.advanceTimersByTimeAsync(3000);

  expect(queue.get(room.id, first.requestId)?.state).toBe('cancelled');
  expect(queue.get(room.id, unknown.requestId)?.state).toBe('receiving_unknown');
  expect(f.calls).toContainEqual(
    expect.objectContaining({
      method: Gateway.HoldingCancel,
      params: expect.objectContaining({
        roomId: room.id,
        generation: first.generation,
        requestIds: [first.requestId],
      }),
      bound: false,
    }),
  );
  expect(
    f.calls.some(call =>
      [Gateway.HoldingRead, Gateway.Health, Gateway.Prepare, Gateway.Start].includes(
        call.method as never,
      ),
    ),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.calls.filter(call => call.method === Gateway.HoldingCancel)).toHaveLength(1);
  const generation = queue.cancelAll(room.id);
  await vi.advanceTimersByTimeAsync(3000);
  expect(queue.generation(room.id)).toBe(generation);
  expect(f.calls).toContainEqual({
    method: Gateway.HoldingCancel,
    bound: false,
    params: { roomId: room.id, generation },
  });
});

it('keeps exact whole-run metadata reconciliation available after business entry is withdrawn', async () => {
  const f = await fixture();
  f.collaboration.createRoom({
    id: 'collaboration',
    anchorSessionId: f.source.id,
    members: [f.source, f.peer].map(session => ({
      agentId: session.agentId,
      sessionId: session.id,
      sessionKey: managedKey(session),
    })),
  });
  f.collaboration.beginRound('collaboration', 'turn');
  const delivery = f.collaboration.enqueue(
    'collaboration',
    'turn',
    managedKey(f.source),
    'tool',
    'source-run',
    { to: f.peer.agentId, message: 'Native-only body' },
  );
  f.collaboration.transition(delivery.id, 'queued', 'dispatching');
  f.collaboration.transition(delivery.id, 'dispatching', 'accepted', 'peer-run');
  const receipt = {
    stream: 'lifecycle',
    sessionKey: managedKey(f.peer),
    runId: 'peer-run',
    data: { phase: 'end', executionSettled: true },
  };
  f.emit('agent', { ...receipt, data: { phase: 'end', executionSettled: false } });
  expect(f.collaboration.listDeliveries('collaboration')[0]?.executionOutcome).toBeUndefined();
  f.emit('agent', receipt);
  expect(f.collaboration.listDeliveries('collaboration')[0]?.executionOutcome).toBe('completed');
  expect(await f.invoke('collaboration.read', f.source.id)).toMatchObject({ success: false });
  expect(f.calls).toHaveLength(0);
});

it('uses the real Team deletion participant and native compare-delete for the entire cohort', async () => {
  const f = await fixture();
  f.collaboration.createRoom({
    id: 'collaboration',
    anchorSessionId: f.source.id,
    members: [f.source, f.peer].map(session => ({
      agentId: session.agentId,
      sessionId: session.id,
      sessionKey: managedKey(session),
    })),
  });
  const release = f.participants.acquireDeletion([f.peer.id]);
  try {
    expect(f.participants.isDeleting(f.source.id)).toBe(true);
    expect(await f.participants.deleteManaged(f.peer.id)).toBe(true);
  } finally {
    release();
  }

  expect(f.sessions.getSession(f.source.id)).toBeNull();
  expect(f.sessions.getSession(f.peer.id)).toBeNull();
  const deletes = f.calls.filter(call => call.method === 'sessions.delete');
  expect(deletes).toHaveLength(2);
  for (const session of [f.source, f.peer])
    expect(deletes).toContainEqual({
      method: 'sessions.delete',
      bound: false,
      params: {
        key: managedKey(session),
        agentId: session.agentId,
        expectedSessionId: `native-${session.id}`,
        expectedLifecycleRevision: `revision-${session.id}`,
      },
    });
});

it('rejects a late business status response after disable and re-enable without recovering the room again', async () => {
  const f = await fixture(true);
  const room = f.room('late', false);
  const run = f.metadata.reserve(send(room.id));
  f.metadata.transition(room.id, run.discussionId, run.generation, 'running');
  f.statuses.set(run.discussionId, {
    roomId: room.id,
    discussionId: run.discussionId,
    state: 'completed',
    executions: [],
  });
  const original = f.nativeRequest.getMockImplementation()!;
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => {
    finish = resolve;
  });
  let entered = false;
  f.nativeRequest.mockImplementation(async (method, value) => {
    const result = await original(method, value);
    if (!entered && (value as { method?: string })?.method === Gateway.Status) {
      entered = true;
      await waiting;
    }
    return result;
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(entered).toBe(true);
  await f.setEnabled(false);
  await f.setEnabled(true);
  f.statuses.set(run.discussionId, {
    roomId: room.id,
    discussionId: run.discussionId,
    state: 'running',
    executions: [],
  });
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.metadata.get(room.id)).toMatchObject({
    state: 'running',
    generation: 0,
    activeDiscussionId: run.discussionId,
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.metadata.get(room.id)?.state).toBe('running');
});

it('does not cancel or start a pending summary merely because the Main native proof is unavailable', async () => {
  const f = await fixture(true);
  const room = f.room('proof');
  const run = f.metadata.reserve(send(room.id));
  f.metadata.transition(room.id, run.discussionId, run.generation, 'completed');
  f.setProofAvailable(false);
  await vi.advanceTimersByTimeAsync(3000);

  expect(f.metadata.summary(run.discussionId)?.state).toBe('pending');
  expect(
    f.calls.some(
      call => call.method === Gateway.OfflineControl && call.params.operation === 'summary-stop',
    ),
  ).toBe(true);
  expect(f.calls.some(call => call.method === Gateway.Summary)).toBe(false);
  expect(f.registry.snapshot()[0].state).toBe('cleanup');
});

it('settles an unknown FIFO admission only from an exact existing offline run receipt', async () => {
  const f = await fixture();
  const room = f.room('fifo', false);
  const queue = f.metadata.queue;
  const input = queue.reserve(room, send(room.id), 'policy', {
    settingsRevision: 0,
    maxRounds: 4,
    maxTurns: 8,
    maxConcurrent: 2,
  });
  queue.setIdentity(
    input,
    {
      roomId: room.id,
      generation: input.generation,
      agentId: 'alice',
      sessionKey: `agent:alice:harness:justdo-team-holding:${room.id}:${input.generation}`,
      sessionId: 'holding-native',
      lifecycleRevision: 'holding-revision',
    },
    input.fingerprint,
    'attachments',
  );
  queue.confirm(input, 'entry');
  expect(queue.claim(queue.get(room.id, input.requestId)!)).toBe(true);
  const run = f.metadata.reserve(send(room.id), undefined, undefined, input.requestId);
  queue.transition(input, ['dispatching'], 'unknown');
  f.statuses.set(run.discussionId, {
    roomId: 'foreign',
    discussionId: run.discussionId,
    state: 'completed',
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(queue.get(room.id, input.requestId)?.state).toBe('unknown');
  f.statuses.set(run.discussionId, {
    roomId: room.id,
    discussionId: run.discussionId,
    state: 'completed',
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(queue.get(room.id, input.requestId)?.state).toBe('dispatched');
  expect(f.metadata.latestRun(room.id)?.state).toBe('completed');
  expect(
    f.calls.some(call =>
      [Gateway.Start, Gateway.HoldingRead, Gateway.Prepare].includes(call.method as never),
    ),
  ).toBe(false);
});

it('routes native discovery, assistant creation, invitation and delivery through the actual Team host entry', async () => {
  const f = await fixture(true);
  f.sessions.beginSessionRun({
    sessionId: f.source.id,
    clientTurnId: 'source-run',
    startedAt: Date.now(),
  });
  const request = async (requestId: string, operation: string, input: unknown) => {
    f.emit(CollaborationGateway.Requested, {
      requestId,
      operation,
      input,
      sessionKey: managedKey(f.source),
      sourceRunId: 'source-run',
      toolCallId: requestId,
      expiresAt: Date.now() + 60000,
    });
    await vi.advanceTimersByTimeAsync(0);
    return f.calls.find(
      call => call.method === CollaborationGateway.Resolve && call.params.requestId === requestId,
    )?.params.result as Record<string, unknown> | undefined;
  };
  expect(await request('discover', 'members', {})).toMatchObject({
    members: [],
    available: expect.arrayContaining([expect.objectContaining({ agentId: 'bob' })]),
  });
  expect(await request('create', 'create', { name: 'New assistant' })).toMatchObject({
    status: 'created',
  });
  expect(f.resources.createAssistant).toHaveBeenCalledOnce();
  const invited = await request('invite', 'ensure', { agentId: 'bob' });
  const member = invited?.member as { sessionId: string; sessionKey: string };
  expect(member).toMatchObject({
    agentId: 'bob',
    sessionKey: expect.stringContaining('agent:bob:'),
  });
  expect(f.sessions.getSession(member.sessionId)).toMatchObject({
    agentId: 'bob',
    cwd: f.source.cwd,
    permissionMode: f.source.permissionMode,
  });
  expect(f.execution.prepareSession).toHaveBeenCalledExactlyOnceWith(member.sessionId);
  await request('invite-again', 'ensure', { agentId: 'bob' });
  expect(f.execution.prepareSession).toHaveBeenCalledOnce();
  const accepted = await request('send', 'native-send', {
    sessionKey: member.sessionKey,
    message: 'Private peer input',
  });
  expect(accepted).toMatchObject({ deliveryId: expect.any(String), sessionKey: member.sessionKey });
  const deliveryId = accepted!.deliveryId as string;
  // Native result belongs to the same tool call as the admitted send.
  f.emit(CollaborationGateway.Requested, {
    requestId: 'send-result',
    operation: 'native-result',
    sessionKey: managedKey(f.source),
    sourceRunId: 'source-run',
    toolCallId: 'send',
    expiresAt: Date.now() + 60000,
    input: { deliveryId, runId: 'peer-native-run', status: 'accepted' },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.collaboration.getDelivery(deliveryId)).toMatchObject({
    state: 'accepted',
    runId: 'peer-native-run',
  });
  expect(
    f.calls.filter(call => call.method === CollaborationGateway.Resolve).every(call => call.bound),
  ).toBe(true);
  await f.setEnabled(false);
  expect(await request('closed', 'create', {})).toBeUndefined();
  expect(f.resources.createAssistant).toHaveBeenCalledOnce();
});

it('deletes owned discussion members through the plugin command without deleting its borrowed source', async () => {
  const f = await fixture(true);
  const room = f.room('borrowed');
  f.metadata.updateMembers(room.id, room.revision, [
    {
      agentId: f.source.agentId,
      name: 'Source',
      ownership: 'source',
      sessionKey: managedKey(f.source),
      sessionId: `native-${f.source.id}`,
      lifecycleRevision: `revision-${f.source.id}`,
    },
    room.members[0],
  ]);
  expect(await f.invoke('discussion.delete', room.id)).toMatchObject({ success: true });
  expect(f.metadata.get(room.id)).toBeUndefined();
  expect(f.sessions.getSession(f.source.id)).not.toBeNull();
  expect(f.calls.filter(call => call.method === Gateway.Close)).toMatchObject([
    { params: { roomId: room.id, agentIds: ['alice'] } },
  ]);
  expect(f.calls.filter(call => call.method === 'sessions.delete')).toMatchObject([
    {
      params: {
        key: teamDiscussionSessionKey(room.id, 'alice'),
        expectedSessionId: 'member-alice',
        expectedLifecycleRevision: 'revision',
      },
    },
  ]);
  expect(
    f.calls.some(
      call => call.method === 'sessions.delete' && call.params.key === managedKey(f.source),
    ),
  ).toBe(false);
});

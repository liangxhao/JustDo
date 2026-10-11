import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  TeamDiscussionGateway as Gateway,
  type TeamDiscussionRoom,
} from '../../../../shared/cowork/agent-team/teamDiscussion';
import { initializeTeamDiscussionTables } from '../../../data/agent-team/teamDiscussionStore';
import type { CoworkStore } from '../../../data/coworkStore';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
import { TeamDiscussionCoordinator } from './teamDiscussion';

let db: DatabaseSync;
let coordinator: TeamDiscussionCoordinator;
let root: string;
const request = vi.fn();
const connectedRequest = vi.fn();
const changed = vi.fn();
const ensureReady = vi.fn<() => Promise<void>>();
const createSession = vi.fn(() => ({ id: 'linked-task' }));
const isSourceDeleting = vi.fn<(sessionId: string) => boolean>();
const isExtensionEnabled = vi.fn<() => boolean>();
const disabledAgents = new Set<string>();
const send = {
  roomId: 'room',
  requestId: 'request',
  expectedRevision: 1,
  message: 'Discuss this',
  selectedAgentIds: [],
  rounds: 2,
};
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'team-coordinator-'));
  db = new DatabaseSync(':memory:');
  const adapter = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    transaction:
      <T>(operation: () => T) =>
      () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const value = operation();
          db.exec('COMMIT');
          return value;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
  } as unknown as Database.Database;
  initializeTeamDiscussionTables(adapter);
  request
    .mockReset()
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === Gateway.Prepare)
        return {
          members: (params.agentIds as string[]).map(agentId => ({
            agentId,
            sessionId: `session-${agentId}`,
            lifecycleRevision: 'revision',
            sessionRoot: root,
            permissionMode: 'read-only',
          })),
        };
      if (method === Gateway.Validate) return { valid: true };
      if (method === Gateway.Start)
        return {
          roomId: (params.room as TeamDiscussionRoom).id,
          discussionId: params.discussionId,
          state: 'running',
          executions: [],
        };
      if (method === Gateway.History) return { messages: [] };
      if (method === Gateway.Summary && params.operation === 'source')
        return { source: { sessionId: 'native-source', lifecycleRevision: 'source-revision' } };
      return { state: 'unknown' };
    });
  createSession.mockClear();
  connectedRequest.mockReset().mockRejectedValue(new Error('offline'));
  changed.mockReset();
  ensureReady.mockReset().mockResolvedValue(undefined);
  isSourceDeleting.mockReset().mockReturnValue(false);
  isExtensionEnabled.mockReset().mockReturnValue(true);
  disabledAgents.clear();
  coordinator = new TeamDiscussionCoordinator({
    isExtensionEnabled,
    isSourceDeleting,
    getDatabase: () => adapter,
    getStore: () =>
      ({
        getAgent: (id: string) => ({ id, name: id, enabled: !disabledAgents.has(id) }),
        getSession: (id: string) =>
          ['source', 'other', 'linked-task'].includes(id)
            ? { id, agentId: 'main', cwd: root, permissionMode: 'ask' }
            : undefined,
        createSession,
      }) as unknown as CoworkStore,
    ensureReady,
    requestGateway: request,
    requestConnectedGateway: connectedRequest,
    onChanged: changed,
  });
  const room: TeamDiscussionRoom = {
    id: 'room',
    title: 'Discussion',
    cwd: root,
    permissionMode: 'ask',
    readOnly: true,
    members: ['alice', 'bob'].map(agentId => ({
      agentId,
      name: agentId,
      sessionId: `session-${agentId}`,
      lifecycleRevision: 'revision',
    })),
    rounds: 2,
    revision: 1,
    generation: 0,
    state: 'ready',
    createdAt: 1,
    updatedAt: 1,
  };
  coordinator.metadata.create(room);
});
afterEach(() => {
  coordinator.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function mockHolding() {
  const original = request.getMockImplementation()!;
  const entries = new Map<
    string,
    { send: typeof send; fingerprint: string; entryId: string; identity: Record<string, unknown> }
  >();
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === Gateway.Health) return { available: true };
    if (method === Gateway.HoldingPrepare)
      return {
        ...params,
        sessionKey: `agent:${params.agentId}:harness:justdo-team-holding:${params.roomId}:${params.generation}`,
        sessionId: 'holding-native',
        lifecycleRevision: 'holding-revision',
      };
    if (method === Gateway.HoldingCancel) return { cancelled: true };
    if (method === Gateway.HoldingSave) {
      const input = params.send as typeof send;
      const entry = {
        send: input,
        identity: params.identity as Record<string, unknown>,
        fingerprint: params.fingerprint as string,
        entryId: `entry-${input.requestId}`,
      };
      entries.set(input.requestId, entry);
      return { state: 'saved', requestId: input.requestId, ...entry };
    }
    if (method === Gateway.HoldingRead || method === Gateway.HoldingStatus) {
      const entry = entries.get(params.requestId as string);
      return entry
        ? { state: 'saved', requestId: params.requestId, ...entry }
        : { state: 'unknown' };
    }
    return original(method, params);
  });
  connectedRequest.mockImplementation((...args) => request(...args));
  return entries;
}

function deferGatewayRequest(target: string, operation?: string) {
  const original = request.getMockImplementation()!;
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => {
    resume = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => {
    entered = resolve;
  });
  request.mockImplementation(async (method, params) => {
    if (method === target && (operation === undefined || params.operation === operation)) {
      entered();
      await waiting;
    }
    return original(method, params);
  });
  return { reached, resume };
}

async function disableAndReenable(): Promise<void> {
  const release = await coordinator.cancelPendingForDisable();
  isExtensionEnabled.mockReturnValue(false);
  release();
  isExtensionEnabled.mockReturnValue(true);
}

it.each([
  ['send', 'stop'],
  ['enqueue', 'stop'],
  ['send', 'disable'],
  ['enqueue', 'disable'],
] as const)(
  'rejects an old %s continuation after %s completes during validation',
  async (action, cancel) => {
    mockHolding();
    const validation = deferGatewayRequest(Gateway.Validate);
    const pending = coordinator[action](send);
    await validation.reached;

    if (cancel === 'stop') await coordinator.stop('room');
    else await disableAndReenable();
    validation.resume();

    await expect(pending).rejects.toThrow('teamDiscussionSessionChanged');
    expect(coordinator.metadata.latestRun('room')).toBeUndefined();
    expect(coordinator.metadata.queue.list('room')).toHaveLength(0);
    expect(
      request.mock.calls.some(([method]) => [Gateway.Start, Gateway.HoldingSave].includes(method)),
    ).toBe(false);

    const fresh = await coordinator[action]({ ...send, requestId: 'fresh' });
    expect(action === 'send' ? fresh.state : fresh.pendingInputs?.[0].state).toBe(
      action === 'send' ? 'running' : 'queued',
    );
  },
);

it('keeps admission fenced until every overlapping Stop has completed', async () => {
  let resumeSecond!: () => void;
  const secondCancel = new Promise<void>(resolve => {
    resumeSecond = resolve;
  });
  let cancellationCount = 0;
  connectedRequest.mockImplementation(async method => {
    if (method === Gateway.HoldingCancel && ++cancellationCount === 2) await secondCancel;
    return { cancelled: true };
  });

  const first = coordinator.stop('room');
  const second = coordinator.stop('room');
  await first;
  await expect(coordinator.send(send)).rejects.toThrow('teamDiscussionBusy');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);

  resumeSecond();
  await second;
  expect((await coordinator.send({ ...send, requestId: 'after-stops' })).state).toBe('running');
});

it('rejects a new direct send when a member is disabled during validation', async () => {
  const validation = deferGatewayRequest(Gateway.Validate);
  const pending = coordinator.send(send);
  await validation.reached;
  disabledAgents.add('alice');
  validation.resume();

  await expect(pending).rejects.toThrow('teamDiscussionInvalidMembers');
  expect(coordinator.metadata.latestRun('room')).toBeUndefined();
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('rechecks member admission after product reservation before starting the native batch', async () => {
  changed.mockImplementationOnce(() => disabledAgents.add('alice'));

  await expect(coordinator.send(send)).rejects.toThrow('teamDiscussionInvalidMembers');

  expect(coordinator.metadata.latestRun('room')?.state).toBe('failed');
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('stores pending input in the native holding session without starting another active discussion', async () => {
  mockHolding();
  await coordinator.send({ ...send, requestId: 'active' });
  const room = await coordinator.enqueue(send);
  expect(room.pendingInputs).toEqual([
    expect.objectContaining({ requestId: 'request', state: 'queued' }),
  ]);
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(1);
  expect(
    JSON.stringify(db.prepare('SELECT * FROM team_discussion_pending_inputs').all()),
  ).not.toContain(send.message);
  expect((await coordinator.read('room')).room.pendingInputs?.[0].message).toBe(send.message);
});
it('dispatches a saved FIFO input only after the prior native receipt settles', async () => {
  mockHolding();
  const active = await coordinator.send({ ...send, requestId: 'active' });
  await coordinator.enqueue(send);
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (method: string, params: Record<string, unknown>) =>
    method === Gateway.Status
      ? {
          roomId: 'room',
          discussionId: active.activeDiscussionId,
          state: 'completed',
          executions: [],
        }
      : implementation(method, params),
  );
  ensureReady.mockClear();
  await coordinator.reconcile();
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(2);
  expect(coordinator.metadata.queue.get('room', 'request')?.state).toBe('dispatched');
  expect(ensureReady).not.toHaveBeenCalled();
});
it('does not dispatch pending input while any source summary remains uncertain', async () => {
  mockHolding();
  const active = await coordinator.send({ ...send, requestId: 'active' });
  await coordinator.enqueue(send);
  coordinator.metadata.transition(
    'room',
    active.activeDiscussionId!,
    active.generation,
    'completed',
  );
  db.prepare("INSERT INTO team_discussion_summaries VALUES (?,?,'unknown',NULL,1)").run(
    active.activeDiscussionId!,
    'room',
  );
  await coordinator.reconcile();
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(1);
  expect(coordinator.metadata.queue.get('room', 'request')?.state).toBe('queued');
});
it('keeps a saved input uncertain after lost ACK and reconciles only by native read', async () => {
  mockHolding();
  await coordinator.send({ ...send, requestId: 'active' });
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    const result = await implementation(method, params);
    if (method === Gateway.HoldingSave) throw new Error('lost acknowledgement');
    return result;
  });
  await expect(coordinator.enqueue(send)).rejects.toThrow('teamDiscussionOutcomeUnknown');
  expect(coordinator.metadata.queue.get('room', 'request')?.state).toBe('receiving_unknown');
  await coordinator.enqueue(send);
  await coordinator.reconcile();
  expect(request.mock.calls.filter(([method]) => method === Gateway.HoldingSave)).toHaveLength(1);
  expect(coordinator.metadata.queue.get('room', 'request')?.state).toBe('queued');
});
it('cancels an in-flight save before a late native acknowledgement can confirm it', async () => {
  mockHolding();
  let completeSave!: (value: unknown) => void;
  let entered!: () => void;
  const saving = new Promise<void>(resolve => {
    entered = resolve;
  });
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    const result = await implementation(method, params);
    if (method === Gateway.HoldingSave) {
      entered();
      return new Promise(resolve => {
        completeSave = resolve;
      });
    }
    return result;
  });
  const pending = coordinator.enqueue(send);
  await saving;
  await coordinator.stop('room');
  completeSave({
    state: 'saved',
    requestId: send.requestId,
    fingerprint: coordinator.metadata.queue.get('room', send.requestId)?.nativeFingerprint,
    entryId: 'late',
  });
  await pending;
  expect(coordinator.metadata.queue.get('room', send.requestId)?.state).toBe('cancelled');
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(0);
});
it('blocks a queued input if its stable attachment snapshot has changed', async () => {
  const entries = mockHolding();
  await coordinator.send({ ...send, requestId: 'active' });
  const attachment = path.join(root, 'chosen.txt');
  writeFileSync(attachment, 'Original selected attachment');
  await coordinator.enqueue({ ...send, attachmentPaths: [attachment] });
  const stored = entries.get(send.requestId)!.send as typeof send & { attachmentPaths: string[] };
  writeFileSync(stored.attachmentPaths[0], 'Changed after native save');
  const active = coordinator.metadata.get('room')!;
  coordinator.metadata.transition(
    'room',
    active.activeDiscussionId!,
    active.generation,
    'completed',
  );
  await coordinator.reconcile();
  expect(coordinator.metadata.queue.get('room', send.requestId)).toMatchObject({
    state: 'blocked',
    reason: 'teamDiscussionAttachmentChanged',
  });
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(1);
});

it('admits concurrent identical queue requests only once including attachment staging', async () => {
  mockHolding();
  const attachment = path.join(root, 'picked.txt');
  writeFileSync(attachment, 'Immutable input');
  await Promise.all([
    coordinator.enqueue({ ...send, attachmentPaths: [attachment] }),
    coordinator.enqueue({ ...send, attachmentPaths: [attachment] }),
  ]);
  expect(request.mock.calls.filter(([method]) => method === Gateway.HoldingSave)).toHaveLength(1);
  expect(coordinator.metadata.queue.list('room')).toHaveLength(1);
  expect(coordinator.metadata.queue.get('room', send.requestId)?.state).toBe('queued');
});

it('rejects queue admission if a summary becomes unknown during validation', async () => {
  mockHolding();
  const active = await coordinator.send({ ...send, requestId: 'active' });
  coordinator.metadata.transition('room', active.activeDiscussionId!, 0, 'completed');
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    const result = await implementation(method, params);
    if (method === Gateway.Validate)
      db.prepare("INSERT INTO team_discussion_summaries VALUES (?,?,'unknown',NULL,1)").run(
        active.activeDiscussionId!,
        'room',
      );
    return result;
  });
  await expect(coordinator.enqueue(send)).rejects.toThrow('teamDiscussionOutcomeUnknown');
  expect(coordinator.metadata.queue.list('room')).toHaveLength(0);
  expect(request.mock.calls.some(([method]) => method === Gateway.HoldingSave)).toBe(false);
});

it('blocks dispatch with an actionable reason when global resources tighten', async () => {
  mockHolding();
  await coordinator.enqueue(send);
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  settings.discussion.maxRounds = 1;
  settings.discussion.defaultRounds = 1;
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
    'agentTeam.settings',
    JSON.stringify({ version: 1, revision: 1, value: settings }),
    1,
  );
  await coordinator.reconcile();
  expect(coordinator.metadata.queue.get('room', send.requestId)).toMatchObject({
    state: 'blocked',
    reason: 'teamDiscussionResourcesChanged',
  });
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('cleans holding sessions with public archive, owner unlock and exact archived delete', async () => {
  mockHolding();
  await coordinator.enqueue(send);
  let deleted = false;
  const identity = coordinator.metadata.queue.get('room', send.requestId)!.identity!;
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (method === Gateway.Close) return { members: [] };
    if (method === Gateway.HoldingClose)
      return params.phase === 'unlock'
        ? { identity }
        : { closed: true, identities: deleted ? [] : [identity] };
    if (method === 'sessions.delete' && params.key === identity.sessionKey) deleted = true;
    return implementation(method, params);
  });
  await coordinator.delete('room');
  const calls = request.mock.calls;
  const archive = calls.findIndex(
    ([method, params]) => method === 'sessions.patch' && params.key === identity.sessionKey,
  );
  const unlock = calls.findIndex(
    ([method, params]) => method === Gateway.HoldingClose && params.phase === 'unlock',
  );
  const remove = calls.findIndex(
    ([method, params]) => method === 'sessions.delete' && params.key === identity.sessionKey,
  );
  expect(archive).toBeLessThan(unlock);
  expect(unlock).toBeLessThan(remove);
  expect(calls[remove][1]).toMatchObject({
    archivedOnly: true,
    expectedSessionId: identity.sessionId,
    expectedLifecycleRevision: identity.lifecycleRevision,
  });
  expect(coordinator.metadata.get('room')).toBeUndefined();
});

it('keeps admission closed throughout an explicit disable configuration lease', async () => {
  mockHolding();
  await coordinator.enqueue(send);
  const release = await coordinator.cancelPendingForDisable();
  expect(coordinator.metadata.queue.get('room', send.requestId)?.state).toBe('cancelled');
  await expect(coordinator.enqueue({ ...send, requestId: 'during-disable' })).rejects.toThrow(
    'teamDiscussionBusy',
  );
  await expect(coordinator.send({ ...send, requestId: 'during-disable' })).rejects.toThrow(
    'teamDiscussionBusy',
  );
  release();
  release();
  await expect(coordinator.enqueue({ ...send, requestId: 'after-enable' })).resolves.toMatchObject({
    id: 'room',
  });
});

it.each([false, true])(
  'fences a pre-disable validation after config lease release (enabled=%s)',
  async enabled => {
    mockHolding();
    const implementation = request.getMockImplementation()!;
    let complete!: () => void;
    let entered!: () => void;
    const validating = new Promise<void>(resolve => {
      entered = resolve;
    });
    request.mockImplementation(async (method, params) => {
      if (method === Gateway.Validate) {
        entered();
        await new Promise<void>(resolve => {
          complete = resolve;
        });
      }
      return implementation(method, params);
    });
    const pending = coordinator.enqueue(send);
    await validating;
    const release = await coordinator.cancelPendingForDisable();
    isExtensionEnabled.mockReturnValue(enabled);
    release();
    complete();
    await expect(pending).rejects.toThrow(
      enabled ? 'teamDiscussionSessionChanged' : 'teamDiscussionDisabled',
    );
    expect(coordinator.metadata.queue.list('room')).toHaveLength(0);
    expect(request.mock.calls.some(([method]) => method === Gateway.HoldingPrepare)).toBe(false);
  },
);

it('keeps the same request attachment snapshot isolated between rooms in one project', async () => {
  mockHolding();
  const second = { ...coordinator.metadata.get('room')!, id: 'second-room' };
  coordinator.metadata.create(second);
  const file = path.join(root, 'attachment.txt');
  writeFileSync(file, 'first content');
  await coordinator.enqueue({ ...send, attachmentPaths: [file] });
  writeFileSync(file, 'second content');
  await coordinator.enqueue({ ...send, roomId: second.id, attachmentPaths: [file] });
  const saves = request.mock.calls.filter(([method]) => method === Gateway.HoldingSave);
  const first = saves[0][1].send.attachmentPaths[0];
  const other = saves[1][1].send.attachmentPaths[0];
  expect(first).not.toBe(other);
  expect(readFileSync(first, 'utf8')).toBe('first content');
  expect(readFileSync(other, 'utf8')).toBe('second content');
  expect(saves[0][1].identity.generation).toBe(1);
});

it('settles a cancelled queue claim when Stop wins before native admission', async () => {
  mockHolding();
  await coordinator.enqueue(send);
  const implementation = request.getMockImplementation()!;
  let releaseRead!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => {
    entered = resolve;
  });
  request.mockImplementation(async (method, params) => {
    if (method === Gateway.HoldingRead) {
      entered();
      await new Promise<void>(resolve => {
        releaseRead = resolve;
      });
    }
    return implementation(method, params);
  });
  const dispatch = coordinator.reconcile();
  await reading;
  await coordinator.stop('room');
  releaseRead();
  await dispatch;
  expect(coordinator.metadata.queue.get('room', send.requestId)?.state).toBe('cancelled');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('reads an exact older batch instead of substituting the latest twenty', async () => {
  for (let i = 0; i < 23; i++) {
    const run = coordinator.metadata.reserve({ ...send, requestId: `batch-${i}` });
    coordinator.metadata.transition('room', run.discussionId, run.generation, 'completed');
  }
  const oldest = coordinator.metadata.runIds('room')[0];
  expect((await coordinator.read('room')).discussionIds).not.toContain(oldest);
  request.mockClear();
  const result = await coordinator.read('room', undefined, [oldest]);
  expect(result.discussionIds).toEqual([oldest]);
  expect(result.runs).toEqual([
    expect.objectContaining({ discussionId: oldest, state: 'completed' }),
  ]);
  expect(result.previousCursor).toBeUndefined();
  expect(request).toHaveBeenCalledWith(
    Gateway.History,
    expect.objectContaining({ discussionIds: [oldest] }),
  );
});

it('rejects unknown, duplicate, and mixed paginated batch requests before reading native history', async () => {
  await expect(coordinator.read('room', undefined, ['foreign'])).rejects.toThrow(
    'teamDiscussionInvalidInput',
  );
  await expect(coordinator.read('room', undefined, ['a', 'a'])).rejects.toThrow(
    'teamDiscussionInvalidInput',
  );
  await expect(coordinator.read('room', 'cursor', ['a'])).rejects.toThrow(
    'teamDiscussionInvalidInput',
  );
  expect(request).not.toHaveBeenCalled();
});

it('reconciles completion without any panel or transcript read', async () => {
  const run = coordinator.metadata.reserve(send);
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'completed',
    executions: [],
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')?.latestRun?.state).toBe('completed');
  expect(changed).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  expect(connectedRequest.mock.calls.every(([method]) => method === Gateway.Status)).toBe(true);
});

it('does not let a late completion override a newer stop generation', async () => {
  const run = coordinator.metadata.reserve(send);
  connectedRequest.mockImplementation(async () => {
    coordinator.metadata.freeze('room');
    return { roomId: 'room', discussionId: run.discussionId, state: 'completed' };
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')?.state).toBe('stopping');
  expect(changed).not.toHaveBeenCalled();
});

it('retains an unknown batch while the Gateway is offline without restarting or resending', async () => {
  coordinator.metadata.reserve(send);
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')?.state).toBe('submitting');
  expect(request).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it('projects a bound uncertain receipt without releasing its slot and restores confirmed execution', async () => {
  bindSummarySource();
  const run = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', run.discussionId, 0, 'running');
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'unknown',
    executions: [],
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')).toMatchObject({
    state: 'interrupted',
    activeDiscussionId: run.discussionId,
    latestRun: { state: 'interrupted' },
  });
  expect(coordinator.metadata.summary(run.discussionId)).toBeUndefined();
  expect(() => coordinator.metadata.reserve({ ...send, requestId: 'second' })).toThrow(
    'teamDiscussionBusy',
  );
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'running',
    executions: [],
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')?.state).toBe('running');
  coordinator.metadata.freeze('room');
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'unknown',
    executions: [],
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')?.state).toBe('stopping');
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'running',
    executions: [],
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')?.state).toBe('stopping');
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'cancelled',
    executions: [],
  });
  await coordinator.reconcile();
  expect(coordinator.metadata.get('room')).toMatchObject({
    state: 'ready',
    latestRun: { state: 'cancelled' },
  });
  expect(coordinator.metadata.summary(run.discussionId)).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});

it('rejects native commands before acquiring the room slot', async () => {
  request.mockResolvedValue({ valid: false, error: 'teamDiscussionCommandsUnavailable' });
  await expect(coordinator.send({ ...send, message: '/reset' })).rejects.toThrow(
    'teamDiscussionCommandsUnavailable',
  );
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
  expect(coordinator.metadata.runIds('room')).toHaveLength(0);
});

it('keeps one native submission when the renderer retries concurrently', async () => {
  await Promise.all([coordinator.send(send), coordinator.send(send)]);
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(1);
  await expect(coordinator.send({ ...send, requestId: 'another' })).rejects.toThrow(
    'teamDiscussionBusy',
  );
});

it('retains a lost acknowledgement and reconciles without resending', async () => {
  bindSummarySource();
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === Gateway.Validate) return { valid: true };
    if (method === Gateway.Start) throw new Error('Disconnected after admission');
    if (method === Gateway.Status)
      return {
        roomId: 'room',
        discussionId: params.discussionId,
        state: 'completed',
        executions: [],
      };
    return { messages: [] };
  });
  await expect(coordinator.send(send)).rejects.toThrow('teamDiscussionOutcomeUnknown');
  expect(coordinator.metadata.get('room')?.state).toBe('submitting');
  const discussionId = coordinator.metadata.latestRun('room')!.discussionId;
  expect(coordinator.metadata.summary(discussionId)).toBeUndefined();
  expect((await coordinator.read('room')).room.state).toBe('ready');
  expect(coordinator.metadata.summary(discussionId)?.state).toBe('pending');
  await coordinator.send(send);
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(1);
});

it('copies attachments into the room project and sends native read-only identities', async () => {
  const source = path.join(root, '资料.txt');
  writeFileSync(source, 'Synthetic attachment');
  await coordinator.send({ ...send, attachmentPaths: [source] });
  const params = request.mock.calls.find(([method]) => method === Gateway.Start)![1];
  const staged = params.send.attachmentPaths[0];
  expect(path.relative(root, staged).startsWith('.agent-tasks')).toBe(true);
  expect(readFileSync(staged, 'utf8')).toBe('Synthetic attachment');
  expect(
    params.members.every(
      (member: { permissionMode: string }) => member.permissionMode === 'read-only',
    ),
  ).toBe(true);
});

it('releases admission if attachment staging fails before native dispatch', async () => {
  await expect(
    coordinator.send({ ...send, attachmentPaths: [path.join(root, 'missing')] }),
  ).rejects.toThrow();
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('resumes partial deletion with compare-and-delete guards', async () => {
  let fail = true;
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'sessions.delete' && String(params.key).includes('bob') && fail)
      throw new Error('offline');
    return {};
  });
  await expect(coordinator.delete('room')).rejects.toThrow('offline');
  expect(coordinator.metadata.get('room')?.members[0].deleted).toBe(true);
  fail = false;
  await coordinator.delete('room');
  const calls = request.mock.calls.filter(([method]) => method === 'sessions.delete');
  expect(calls.filter(([, params]) => String(params.key).includes('alice'))).toHaveLength(1);
  expect(
    calls.every(
      ([, params]) => params.expectedLifecycleRevision === 'revision' && params.expectedSessionId,
    ),
  ).toBe(true);
  expect(coordinator.metadata.get('room')).toBeUndefined();
});

it('creates a linked task exactly once without executing a model', () => {
  expect(coordinator.createTask({ roomId: 'room', requestId: 'handoff' })).toBe('linked-task');
  expect(coordinator.createTask({ roomId: 'room', requestId: 'handoff' })).toBe('linked-task');
  expect(createSession).toHaveBeenCalledOnce();
  expect(coordinator.metadata.get('room')?.linkedTaskIds).toEqual(['linked-task']);
  expect(request).not.toHaveBeenCalled();
});

it('lets an explicitly linked task read its exact discussion reference without organizer privileges', async () => {
  const batch = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', batch.discussionId, batch.generation, 'completed');
  const input = { action: 'read', roomId: 'room', discussionIds: [batch.discussionId] };
  await expect(coordinator.fromAgent('linked-task', input, 'before-link', vi.fn())).rejects.toThrow(
    'teamDiscussionNotFound',
  );

  const taskId = coordinator.createTask({ roomId: 'room', requestId: 'reference' });
  await expect(
    coordinator.fromAgent(taskId, input, 'reference-read', vi.fn()),
  ).resolves.toMatchObject({
    discussionIds: [batch.discussionId],
    runs: [expect.objectContaining({ discussionId: batch.discussionId, state: 'completed' })],
  });
  expect(request).toHaveBeenCalledWith(
    Gateway.History,
    expect.objectContaining({ roomId: 'room', discussionIds: [batch.discussionId] }),
  );
  await expect(coordinator.fromAgent('other', input, 'unlinked-read', vi.fn())).rejects.toThrow(
    'teamDiscussionNotFound',
  );
  for (const action of ['send', 'stop', 'configure']) {
    await expect(
      coordinator.fromAgent(
        taskId,
        { action, roomId: 'room', message: 'Start another round', organizerParticipates: true },
        `linked-${action}`,
        vi.fn(),
      ),
    ).rejects.toThrow('teamDiscussionNotFound');
  }
  expect(coordinator.metadata.get('room')?.sourceSessionId).toBeUndefined();
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('resumes deletion after a committed native delete loses its acknowledgement', async () => {
  const deleted = new Set<string>();
  let disconnected = true;
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    const key = String(params.key);
    if (method === 'sessions.delete') {
      if (deleted.has(key)) throw new Error('Session changed before deletion');
      deleted.add(key);
      if (disconnected) throw new Error('Acknowledgement lost');
    }
    if (method === 'sessions.describe') {
      if (disconnected) throw new Error('Disconnected');
      return { session: deleted.has(key) ? null : { sessionId: 'existing-session' } };
    }
    return {};
  });

  await expect(coordinator.delete('room')).rejects.toThrow('Acknowledgement lost');
  expect(coordinator.metadata.get('room')?.members[0].deleted).toBeUndefined();
  disconnected = false;
  await coordinator.delete('room');

  expect(deleted.size).toBe(2);
  expect(coordinator.metadata.get('room')).toBeUndefined();
  const calls = request.mock.calls.filter(([method]) => method === 'sessions.delete');
  expect(calls).toHaveLength(3);
  expect(calls.every(([, params]) => params.expectedLifecycleRevision === 'revision')).toBe(true);
});

it('keeps deletion pending when native history now belongs to a replacement session', async () => {
  request.mockImplementation(async (method: string) => {
    if (method === 'sessions.delete') throw new Error('Session changed before deletion');
    if (method === 'sessions.describe')
      return { session: { sessionId: 'replacement', lifecycleRevision: 'replacement-revision' } };
    return {};
  });

  await expect(coordinator.delete('room')).rejects.toThrow('Session changed before deletion');

  expect(coordinator.metadata.get('room')?.state).toBe('deleting');
  expect(coordinator.metadata.get('room')?.members.every(member => !member.deleted)).toBe(true);
  const calls = request.mock.calls.filter(([method]) => method === 'sessions.delete');
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toMatchObject({
    expectedSessionId: 'session-alice',
    expectedLifecycleRevision: 'revision',
  });
});

it('hydrates quotes only from matching native room entries before admission', async () => {
  const previous = coordinator.metadata.reserve({ ...send, requestId: 'previous' });
  coordinator.metadata.transition('room', previous.discussionId, 0, 'completed');
  request.mockImplementation(async (method: string) => {
    if (method === Gateway.Validate) return { valid: true };
    if (method === Gateway.History) return { messages: [] };
    return {};
  });
  await expect(
    coordinator.send({
      ...send,
      quotes: [{ messageId: 'forged', discussionId: previous.discussionId }],
    }),
  ).rejects.toThrow('teamDiscussionQuoteUnavailable');
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});
it('paginates discussion runs without losing older history', async () => {
  for (let index = 0; index < 23; index++) {
    const run = coordinator.metadata.reserve({ ...send, requestId: `page-${index}` });
    coordinator.metadata.transition('room', run.discussionId, 0, 'completed');
  }
  const latest = await coordinator.read('room');
  expect(latest.discussionIds).toHaveLength(20);
  expect(latest.previousCursor).toBeTruthy();
  const earlier = await coordinator.read('room', latest.previousCursor);
  expect(earlier.discussionIds).toHaveLength(3);
  expect(earlier.previousCursor).toBeUndefined();
  expect(new Set([...earlier.discussionIds!, ...latest.discussionIds!]).size).toBe(23);
});

it('lets the organizing agent create a room in the source project and attributes its public message correctly', async () => {
  const result = (await coordinator.fromAgent(
    'source',
    {
      action: 'create',
      title: 'Design discussion',
      agentIds: ['alice', 'bob'],
      message: 'Discuss architecture',
      cwd: '/untrusted',
      permissionMode: 'full',
      initiator: { kind: 'organizer', agentId: 'forged', name: 'Forged' },
    },
    'tool-identity',
    vi.fn(),
  )) as { roomId: string };
  expect(coordinator.metadata.get(result.roomId)).toMatchObject({
    sourceSessionId: 'source',
    cwd: root,
    readOnly: true,
    permissionMode: 'ask',
  });
  const discussionId = coordinator.metadata.runIds(result.roomId)[0];
  expect(coordinator.metadata.initiator(discussionId)).toBe('main');
  expect(request.mock.calls.find(([method]) => method === Gateway.Start)?.[1]).toMatchObject({
    initiator: { kind: 'organizer', agentId: 'main' },
  });
  request.mockImplementation(async (method: string) =>
    method === Gateway.History
      ? {
          messages: [
            {
              id: 'native-entry',
              discussionId,
              role: 'user',
              text: 'Discuss architecture',
              mediaUrls: [],
              timestamp: 1,
            },
          ],
        }
      : { state: 'unknown' },
  );
  expect((await coordinator.read(result.roomId)).messages[0]).toMatchObject({
    role: 'assistant',
    agentId: 'main',
    text: 'Discuss architecture',
  });
  await expect(
    coordinator.fromAgent(
      'other',
      { action: 'read', roomId: result.roomId },
      'other-tool',
      vi.fn(),
    ),
  ).rejects.toThrow('teamDiscussionNotFound');
});

it('does not start members when the organizing native run stops during preparation', async () => {
  let active = true;
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[0] === Gateway.Prepare) active = false;
    return result;
  });
  await expect(
    coordinator.fromAgent(
      'source',
      { action: 'create', title: 'Design', agentIds: ['alice', 'bob'], message: 'Discuss' },
      'stopped-tool',
      () => {
        if (!active) throw new Error('stopped');
      },
    ),
  ).rejects.toThrow('stopped');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('stops only active discussions belonging to the stopped source task', async () => {
  db.prepare('UPDATE team_discussion_rooms SET source_session_id = ? WHERE id = ?').run(
    'source',
    'room',
  );
  const unrelated = {
    ...coordinator.metadata.get('room')!,
    id: 'unrelated',
    sourceSessionId: 'other',
  };
  coordinator.metadata.create(unrelated);
  coordinator.metadata.reserve(send);
  coordinator.metadata.reserve({ ...send, roomId: 'unrelated' });
  const stop = vi
    .spyOn(coordinator, 'stop')
    .mockImplementation(async id => coordinator.metadata.get(String(id))!);
  await coordinator.stopForSource('source');
  expect(stop).toHaveBeenCalledExactlyOnceWith('room');
});

it('waits for every linked discussion cancellation before reporting a partial failure', async () => {
  db.prepare('UPDATE team_discussion_rooms SET source_session_id = ? WHERE id = ?').run(
    'source',
    'room',
  );
  coordinator.metadata.create({ ...coordinator.metadata.get('room')!, id: 'second-room' });
  const failure = new Error('Cancellation unavailable');
  let finish!: (room: TeamDiscussionRoom) => void;
  const stop = vi.spyOn(coordinator, 'stop').mockImplementation(id =>
    id === 'room'
      ? Promise.reject(failure)
      : new Promise<TeamDiscussionRoom>(resolve => {
          finish = resolve;
        }),
  );
  const rejected = vi.fn();
  const stopping = coordinator.stopForSource('source').catch(rejected);
  await new Promise<void>(resolve => setImmediate(resolve));

  expect(stop.mock.calls.map(([id]) => id)).toEqual(['room', 'second-room']);
  expect(rejected).not.toHaveBeenCalled();
  finish(coordinator.metadata.get('second-room')!);
  await stopping;
  expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
});

const summarySource = {
  agentId: 'main',
  sessionKey: 'agent:main:justdo:source',
  sessionId: 'native-source',
  lifecycleRevision: 'source-revision',
};
function bindSummarySource(): void {
  db.prepare(
    'UPDATE team_discussion_rooms SET source_session_id = ?, summary_source_json = ? WHERE id = ?',
  ).run('source', JSON.stringify(summarySource), 'room');
}

it('persists summary cancellation before a holding cleanup acknowledgement arrives', async () => {
  bindSummarySource();
  mockHolding();
  const previous = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', previous.discussionId, previous.generation, 'completed');
  const cleanup = deferGatewayRequest(Gateway.HoldingCancel);
  const stopping = coordinator.stop('room');
  await cleanup.reached;

  expect(coordinator.metadata.summary(previous.discussionId)?.state).toBe('stopping');
  await coordinator.reconcile();
  expect(
    request.mock.calls.some(
      ([method, params]) => method === Gateway.Summary && params.operation === 'start',
    ),
  ).toBe(false);

  cleanup.resume();
  await stopping;
});

it('rechecks a later summary after Stop cancels it while an earlier summary request is awaiting', async () => {
  bindSummarySource();
  mockHolding();
  const first = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', first.discussionId, first.generation, 'completed');
  coordinator.metadata.create({ ...coordinator.metadata.get('room')!, id: 'second' });
  const second = coordinator.metadata.reserve({ ...send, roomId: 'second' });
  coordinator.metadata.transition('second', second.discussionId, second.generation, 'completed');
  db.prepare('UPDATE team_discussion_summaries SET updated_at = ? WHERE discussion_id = ?').run(
    1,
    first.discussionId,
  );
  db.prepare('UPDATE team_discussion_summaries SET updated_at = ? WHERE discussion_id = ?').run(
    2,
    second.discussionId,
  );
  let releaseFirst!: () => void;
  const firstWaiting = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const firstReached = new Promise<void>(resolve => {
    firstEntered = resolve;
  });
  let releaseCleanup!: () => void;
  const cleanupWaiting = new Promise<void>(resolve => {
    releaseCleanup = resolve;
  });
  let cleanupEntered!: () => void;
  const cleanupReached = new Promise<void>(resolve => {
    cleanupEntered = resolve;
  });
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (
      method === Gateway.Summary &&
      params.discussionId === first.discussionId &&
      params.operation === 'start'
    ) {
      firstEntered();
      await firstWaiting;
      return { state: 'delivered' };
    }
    if (method === Gateway.HoldingCancel && params.roomId === 'second') {
      cleanupEntered();
      await cleanupWaiting;
      return { cancelled: true };
    }
    if (method === Gateway.Summary && params.discussionId === second.discussionId)
      return { state: 'cancelled' };
    return original(method, params);
  });

  const reconciling = coordinator.reconcile();
  await firstReached;
  const stopping = coordinator.stop('second');
  await cleanupReached;
  releaseFirst();
  await reconciling;

  expect(
    request.mock.calls.some(
      ([method, params]) =>
        method === Gateway.Summary &&
        params.discussionId === second.discussionId &&
        params.operation === 'start',
    ),
  ).toBe(false);
  expect(coordinator.metadata.summary(second.discussionId)?.state).toBe('cancelled');
  releaseCleanup();
  await stopping;
});

it('rejects a prepared room after explicit disable and re-enable invalidates its preparation', async () => {
  const preparation = deferGatewayRequest(Gateway.Prepare);
  const pending = coordinator.create({
    id: 'new-room',
    title: 'New discussion',
    agentIds: ['alice', 'bob'],
    rounds: 2,
    cwd: root,
    permissionMode: 'ask',
  });
  await preparation.reached;
  await disableAndReenable();
  preparation.resume();

  await expect(pending).rejects.toThrow('teamDiscussionSessionChanged');
  expect(coordinator.metadata.get('new-room')?.state).toBe('prepare_failed');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('rejects a model create after disable and re-enable occurs during source description', async () => {
  const description = deferGatewayRequest(Gateway.Summary, 'source');
  const pending = coordinator.fromAgent(
    'source',
    { action: 'create', title: 'New discussion', agentIds: ['alice', 'bob'], message: 'Discuss' },
    'create-operation',
    () => {},
  );
  await description.reached;
  await disableAndReenable();
  description.resume();

  await expect(pending).rejects.toThrow('teamDiscussionSessionChanged');
  expect(coordinator.metadata.list()).toHaveLength(1);
  expect(
    request.mock.calls.some(([method]) => [Gateway.Prepare, Gateway.Start].includes(method)),
  ).toBe(false);
});

it.each(['stop', 'disable'] as const)(
  'rejects an old participation update after %s during native validation',
  async cancel => {
    bindSummarySource();
    mockHolding();
    const description = deferGatewayRequest(Gateway.Summary, 'source');
    const pending = coordinator.setParticipation({
      roomId: 'room',
      expectedRevision: 1,
      enabled: true,
    });
    await description.reached;
    if (cancel === 'stop') await coordinator.stop('room');
    else await disableAndReenable();
    description.resume();

    await expect(pending).rejects.toThrow('teamDiscussionSessionChanged');
    expect(coordinator.metadata.get('room')?.revision).toBe(1);
    expect(coordinator.metadata.get('room')?.members).toHaveLength(2);
  },
);

it('rechecks the current member cap when committing organizer participation after native validation', async () => {
  bindSummarySource();
  const description = deferGatewayRequest(Gateway.Summary, 'source');
  const pending = coordinator.setParticipation({
    roomId: 'room',
    expectedRevision: 1,
    enabled: true,
  });
  await description.reached;
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  settings.discussion.maxMembers = 2;
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
    'agentTeam.settings',
    JSON.stringify({ version: 1, revision: 1, value: settings }),
    1,
  );
  description.resume();

  await expect(pending).rejects.toThrow('agentTeamSettingsMembersExceeded');
  expect(coordinator.metadata.get('room')?.revision).toBe(1);
  expect(coordinator.metadata.get('room')?.members).toHaveLength(2);
});

it('persists stopping both pending summaries and the current batch before Gateway readiness fails', async () => {
  bindSummarySource();
  const previous = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', previous.discussionId, previous.generation, 'completed');
  // Reproduce a persisted overlap admitted by the previous implementation.
  coordinator.metadata.updateSummary(previous.discussionId, 'delivered');
  const current = coordinator.metadata.reserve({ ...send, requestId: 'next' });
  db.prepare("UPDATE team_discussion_summaries SET state = 'pending' WHERE discussion_id = ?").run(
    previous.discussionId,
  );
  ensureReady.mockRejectedValueOnce(new Error('Gateway unavailable'));

  await expect(coordinator.stop('room')).rejects.toThrow('Gateway unavailable');

  expect(coordinator.metadata.summary(previous.discussionId)?.state).toBe('stopping');
  expect(coordinator.metadata.get('room')?.state).toBe('stopping');
  expect(
    db
      .prepare('SELECT summary_suppressed FROM team_discussion_runs WHERE id = ?')
      .get(current.discussionId),
  ).toMatchObject({ summary_suppressed: 1 });
  expect(request).not.toHaveBeenCalled();
});

it('retries native cancellation after restart instead of merely polling a stopped batch', async () => {
  bindSummarySource();
  const run = coordinator.metadata.reserve(send);
  coordinator.metadata.freeze('room');
  coordinator.metadata.recoverInterrupted();
  connectedRequest.mockResolvedValue({
    roomId: 'room',
    discussionId: run.discussionId,
    state: 'completed',
    executions: [],
  });

  await coordinator.reconcile();

  expect(connectedRequest).toHaveBeenCalledExactlyOnceWith(Gateway.Stop, {
    roomId: 'room',
    discussionId: run.discussionId,
  });
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
  expect(coordinator.metadata.summary(run.discussionId)).toBeUndefined();
});

it('continues stopping current members when cancelling an earlier summary loses its acknowledgement', async () => {
  bindSummarySource();
  const previous = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', previous.discussionId, 0, 'completed');
  coordinator.metadata.updateSummary(previous.discussionId, 'delivered');
  const current = coordinator.metadata.reserve({ ...send, requestId: 'current' });
  db.prepare("UPDATE team_discussion_summaries SET state = 'pending' WHERE discussion_id = ?").run(
    previous.discussionId,
  );
  request.mockImplementation(async (method: string) => {
    if (method === Gateway.Stop)
      return {
        roomId: 'room',
        discussionId: current.discussionId,
        state: 'cancelled',
        executions: [],
      };
    throw new Error('Summary acknowledgement lost');
  });

  await expect(coordinator.stop('room')).rejects.toThrow('Summary acknowledgement lost');

  expect(request).toHaveBeenCalledWith(Gateway.Stop, {
    roomId: 'room',
    discussionId: current.discussionId,
  });
  expect(coordinator.metadata.summary(previous.discussionId)?.state).toBe('stopping');
  expect(coordinator.metadata.get('room')?.latestRun?.state).toBe('cancelled');
});

it('rejects participation after a competing send acquires the room during native identity validation', async () => {
  bindSummarySource();
  request.mockImplementation(async (method: string) => {
    if (method === Gateway.Summary) {
      coordinator.metadata.reserve(send);
      return { source: summarySource };
    }
    return {};
  });

  await expect(
    coordinator.setParticipation({ roomId: 'room', expectedRevision: 1, enabled: true }),
  ).rejects.toThrow('teamDiscussionStaleRevision');

  expect(coordinator.metadata.get('room')?.members.map(member => member.agentId)).toEqual([
    'alice',
    'bob',
  ]);
  expect(coordinator.metadata.get('room')?.revision).toBe(1);
});

it('allows one ordinary member plus the source and refuses removing the source below the minimum', async () => {
  const created = await coordinator.create(
    {
      id: 'pair',
      title: 'Pair',
      cwd: root,
      permissionMode: 'ask',
      readOnly: true,
      sourceSessionId: 'source',
      agentIds: ['alice'],
      rounds: 2,
    },
    summarySource,
    true,
  );

  expect(created.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agentId: 'alice' }),
      expect.objectContaining({ agentId: 'main', ownership: 'source', sessionId: 'native-source' }),
    ]),
  );
  expect(created.members).toHaveLength(2);
  await expect(
    coordinator.setParticipation({
      roomId: 'pair',
      expectedRevision: created.revision,
      enabled: false,
    }),
  ).rejects.toThrow('teamDiscussionInvalidMembers');
  expect(coordinator.metadata.get('pair')?.members).toHaveLength(2);
});

it('rejects seven participants before creating metadata or preparing any native member', async () => {
  await expect(
    coordinator.create(
      {
        id: 'oversized',
        title: 'Too many',
        cwd: root,
        permissionMode: 'ask',
        readOnly: true,
        sourceSessionId: 'source',
        agentIds: ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'],
        rounds: 2,
      },
      summarySource,
      true,
    ),
  ).rejects.toThrow('teamDiscussionInvalidMembers');
  expect(coordinator.metadata.get('oversized')).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});

it('deletes room-owned native sessions while preserving the borrowed source session', async () => {
  bindSummarySource();
  coordinator.metadata.updateMembers('room', 1, [
    ...coordinator.metadata.get('room')!.members,
    { ...summarySource, name: 'Main', ownership: 'source' },
  ]);
  request.mockResolvedValue({});

  await coordinator.delete('room');

  const deletedKeys = request.mock.calls
    .filter(([method]) => method === 'sessions.delete')
    .map(([, params]) => params.key);
  expect(deletedKeys).toEqual([
    'agent:alice:justdo-team:group:room',
    'agent:bob:justdo-team:group:room',
  ]);
  expect(deletedKeys).not.toContain(summarySource.sessionKey);
  expect(coordinator.metadata.get('room')).toBeUndefined();
});

it('does not let repeated old summary transport failures starve newer summaries', async () => {
  bindSummarySource();
  for (let i = 0; i < 17; i++) {
    const run = coordinator.metadata.reserve({ ...send, requestId: 'audit-' + i });
    coordinator.metadata.transition('room', run.discussionId, run.generation, 'completed');
    coordinator.metadata.updateSummary(run.discussionId, 'delivered');
  }
  const last = coordinator.metadata.latestRun('room')!.discussionId;
  // Exercise the poller's bounded batch with historical overlapping outbox rows.
  db.prepare(
    "UPDATE team_discussion_summaries SET state = CASE WHEN discussion_id = ? THEN 'pending' ELSE 'unknown' END",
  ).run(last);
  db.prepare(
    "UPDATE team_discussion_summaries SET updated_at = CASE WHEN state = 'unknown' THEN 1 ELSE 2 END",
  ).run();
  for (let i = 0; i < 4; i++) await coordinator.reconcile();
  expect(connectedRequest.mock.calls.some(([, args]) => args.discussionId === last)).toBe(true);
});

it('blocks new admission, organizer changes and deletion while a source summary is unknown', async () => {
  bindSummarySource();
  const run = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', run.discussionId, run.generation, 'completed');
  coordinator.metadata.updateSummary(run.discussionId, 'unknown', 'summary-run');
  await expect(coordinator.send({ ...send, requestId: 'new' })).rejects.toThrow(
    'teamDiscussionBusy',
  );
  await expect(
    coordinator.setParticipation({ roomId: 'room', expectedRevision: 1, enabled: true }),
  ).rejects.toThrow('teamDiscussionBusy');
  await expect(coordinator.delete('room')).rejects.toThrow('teamDiscussionBusy');
  await expect(coordinator.stopForSource('source', true)).rejects.toThrow('teamDiscussionBusy');
  await expect(coordinator.stopForSource('source')).resolves.toBeUndefined();
  expect(
    request.mock.calls.some(([method]) => [Gateway.Close, 'sessions.delete'].includes(method)),
  ).toBe(false);
  expect(coordinator.metadata.get('room')).toBeDefined();
  expect(coordinator.metadata.summary(run.discussionId)?.state).toBe('stopping');
});

it('keeps a summary cancellation that wins while a failed poll is pending', async () => {
  bindSummarySource();
  const run = coordinator.metadata.reserve(send);
  coordinator.metadata.transition('room', run.discussionId, run.generation, 'completed');
  coordinator.metadata.updateSummary(run.discussionId, 'running');
  connectedRequest.mockImplementation(async () => {
    coordinator.metadata.cancelSummaries('room');
    throw new Error('Native transport unavailable');
  });

  await coordinator.reconcile();

  expect(coordinator.metadata.summary(run.discussionId)?.state).toBe('stopping');
});

it('does not enqueue a summary when source-bound attachment staging fails before admission', async () => {
  bindSummarySource();
  await expect(
    coordinator.send({ ...send, attachmentPaths: [path.join(root, 'missing')] }),
  ).rejects.toThrow();
  const run = coordinator.metadata.latestRun('room')!;
  expect(run.state).toBe('failed');
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
  expect(coordinator.metadata.summary(run.discussionId)).toBeUndefined();
});

it('freezes per-batch settings and applies tighter defaults only to the next distinct request', async () => {
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  settings.discussion.maxConcurrent = 1;
  settings.discussion.maxTurns = 3;
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
    'agentTeam.settings',
    JSON.stringify({ version: 1, revision: 1, value: settings }),
    1,
  );
  await coordinator.send(send);
  expect(request).toHaveBeenCalledWith(
    Gateway.Start,
    expect.objectContaining({
      resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 3, maxConcurrent: 1 },
    }),
  );
  settings.discussion.maxRounds = 1;
  settings.discussion.defaultRounds = 1;
  db.prepare('UPDATE kv SET value = ?').run(
    JSON.stringify({ version: 1, revision: 2, value: settings }),
  );
  request.mockClear();
  await coordinator.send(send);
  expect(request.mock.calls.filter(([method]) => method === Gateway.Start)).toHaveLength(0);
  const admitted = coordinator.metadata.latestRun('room')!;
  coordinator.metadata.transition('room', admitted.discussionId, 0, 'completed');
  await expect(coordinator.send({ ...send, requestId: 'new' })).rejects.toThrow(
    'agentTeamSettingsRoundsExceeded',
  );
  await coordinator.send({ ...send, requestId: 'new', rounds: 1 });
  expect(request).toHaveBeenCalledWith(
    Gateway.Start,
    expect.objectContaining({
      resources: { settingsRevision: 2, maxRounds: 1, maxTurns: 2, maxConcurrent: 1 },
    }),
  );
});

it('applies a reduced member cap to new direct sends while retaining accepted runs and retries', async () => {
  const room = coordinator.metadata.get('room')!;
  coordinator.metadata.updateMembers(room.id, room.revision, [
    ...room.members,
    { agentId: 'carol', name: 'Carol', sessionId: 'session-carol', lifecycleRevision: 'revision' },
  ]);
  const original = { ...send, expectedRevision: 2 };
  await coordinator.send(original);
  const active = coordinator.metadata.latestRun('room')!;
  const resources = coordinator.metadata.resources('room', original.requestId);
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  settings.discussion.maxMembers = 2;
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
    'agentTeam.settings',
    JSON.stringify({ version: 1, revision: 1, value: settings }),
    1,
  );
  request.mockClear();

  expect((await coordinator.send(original)).activeDiscussionId).toBe(active.discussionId);
  expect(coordinator.metadata.resources('room', original.requestId)).toEqual(resources);
  coordinator.metadata.transition('room', active.discussionId, 0, 'completed');
  await expect(coordinator.send({ ...original, requestId: 'new' })).rejects.toThrow(
    'agentTeamSettingsMembersExceeded',
  );

  expect(coordinator.metadata.runs('room')).toHaveLength(1);
  expect(coordinator.metadata.get('room')?.members).toHaveLength(3);
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('rejects over-limit new rosters without changing old room members or launching Gateway', async () => {
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  settings.discussion.maxMembers = 2;
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
    'agentTeam.settings',
    JSON.stringify({ version: 1, revision: 1, value: settings }),
    1,
  );
  request.mockClear();
  ensureReady.mockClear();
  await expect(
    coordinator.create({
      id: 'too-many',
      title: 'Too many',
      agentIds: ['alice', 'bob', 'carol'],
      rounds: 2,
      cwd: root,
      permissionMode: 'ask',
    }),
  ).rejects.toThrow('agentTeamSettingsMembersExceeded');
  expect(coordinator.metadata.get('room')?.members).toHaveLength(2);
  expect(coordinator.metadata.get('too-many')).toBeUndefined();
  expect(ensureReady).not.toHaveBeenCalled();
});

it('blocks creation, sends and organizer changes while the source deletion lease is held', async () => {
  bindSummarySource();
  isSourceDeleting.mockReturnValue(true);
  request.mockClear();

  await expect(coordinator.send(send)).rejects.toThrow('teamDiscussionBusy');
  await expect(
    coordinator.setParticipation({ roomId: 'room', expectedRevision: 1, enabled: true }),
  ).rejects.toThrow('teamDiscussionBusy');
  await expect(
    coordinator.create(
      {
        id: 'new-room',
        title: 'New discussion',
        agentIds: ['alice', 'bob'],
        rounds: 1,
        cwd: root,
        permissionMode: 'ask',
        sourceSessionId: 'source',
      },
      summarySource,
    ),
  ).rejects.toThrow('teamDiscussionBusy');

  expect(request).not.toHaveBeenCalled();
  expect(coordinator.metadata.latestRun('room')).toBeUndefined();
  expect(coordinator.metadata.get('new-room')).toBeUndefined();
  expect(coordinator.metadata.get('room')?.revision).toBe(1);
});

it('rejects a send when source deletion begins during native input validation', async () => {
  bindSummarySource();
  request.mockImplementation(async method => {
    if (method === Gateway.Validate) {
      isSourceDeleting.mockReturnValue(true);
      return { valid: true };
    }
    return {};
  });

  await expect(coordinator.send(send)).rejects.toThrow('teamDiscussionBusy');

  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
  expect(coordinator.metadata.latestRun('room')).toBeUndefined();
  expect(coordinator.metadata.get('room')?.state).toBe('ready');
});

it('does not publish a prepared room as ready after its source begins deletion', async () => {
  const nativeRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    const result = await nativeRequest(method, params);
    if (method === Gateway.Prepare) isSourceDeleting.mockReturnValue(true);
    return result;
  });

  await expect(
    coordinator.create(
      {
        id: 'late-room',
        title: 'Late discussion',
        agentIds: ['alice', 'bob'],
        rounds: 1,
        cwd: root,
        permissionMode: 'ask',
        sourceSessionId: 'source',
      },
      summarySource,
    ),
  ).rejects.toThrow('teamDiscussionBusy');

  expect(coordinator.metadata.get('late-room')?.state).toBe('prepare_failed');
  expect(coordinator.metadata.get('late-room')?.members.every(member => !member.sessionId)).toBe(
    true,
  );
  expect(request.mock.calls.some(([method]) => method === Gateway.Start)).toBe(false);
});

it('rejects a borrowed source update when deletion starts during native identity validation', async () => {
  bindSummarySource();
  request.mockImplementation(async method => {
    if (method === Gateway.Summary) {
      isSourceDeleting.mockReturnValue(true);
      return { source: summarySource };
    }
    return {};
  });

  await expect(
    coordinator.setParticipation({ roomId: 'room', expectedRevision: 1, enabled: true }),
  ).rejects.toThrow('teamDiscussionBusy');

  expect(coordinator.metadata.get('room')?.revision).toBe(1);
  expect(coordinator.metadata.get('room')?.members.map(member => member.agentId)).toEqual([
    'alice',
    'bob',
  ]);
});

it('checks rooms added after the initial source stop snapshot before confirming deletion', async () => {
  bindSummarySource();
  const stopping = coordinator.stopForSource('source', true);
  coordinator.metadata.create({
    ...coordinator.metadata.get('room')!,
    id: 'late-linked-room',
    summarySource: undefined,
  });
  coordinator.metadata.reserve({ ...send, roomId: 'late-linked-room' });

  await expect(stopping).rejects.toThrow('teamDiscussionBusy');
  expect(coordinator.metadata.get('late-linked-room')?.activeDiscussionId).toBeDefined();
});

it('replays exact accepted input after a roster revision without reading the Gateway or resetting its resources', async () => {
  await coordinator.send(send);
  const accepted = coordinator.metadata.latestRun('room')!;
  coordinator.metadata.transition('room', accepted.discussionId, 0, 'completed');
  db.prepare('UPDATE team_discussion_rooms SET revision = revision + 1 WHERE id = ?').run('room');
  request.mockClear();
  ensureReady.mockClear();
  await coordinator.send(send);
  expect(request).not.toHaveBeenCalled();
  expect(ensureReady).not.toHaveBeenCalled();
  await expect(coordinator.send({ ...send, message: 'Changed request' })).rejects.toThrow(
    'teamDiscussionRequestConflict',
  );
  expect(coordinator.metadata.resources('room', send.requestId)).toMatchObject({
    maxRounds: 4,
    maxTurns: 4,
    maxConcurrent: 2,
  });
});

it('uses configured model defaults, counts the source as a member and freezes omitted arguments on replay', async () => {
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  Object.assign(settings.discussion, {
    maxMembers: 2,
    defaultRounds: 1,
    maxConcurrent: 1,
    organizerParticipates: true,
  });
  const save = (revision: number) =>
    db
      .prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)')
      .run('agentTeam.settings', JSON.stringify({ version: 1, revision, value: settings }), 1);
  save(1);
  const input = { action: 'create', title: 'Defaults', agentIds: ['alice'], message: 'Discuss' };
  const result = (await coordinator.fromAgent('source', input, 'settings-defaults', vi.fn())) as {
    roomId: string;
  };
  const room = coordinator.metadata.get(result.roomId)!;
  expect(room.rounds).toBe(1);
  expect(room.members).toEqual([
    expect.objectContaining({ agentId: 'alice' }),
    expect.objectContaining({ agentId: 'main', ownership: 'source' }),
  ]);
  const run = coordinator.metadata.latestRun(room.id)!;
  expect(coordinator.metadata.resources(room.id, run.requestId)).toMatchObject({
    settingsRevision: 1,
    maxConcurrent: 1,
    maxTurns: 2,
  });
  await expect(
    coordinator.fromAgent(
      'source',
      { ...input, agentIds: ['alice', 'bob'] },
      'source-over-limit',
      vi.fn(),
    ),
  ).rejects.toThrow('agentTeamSettingsMembersExceeded');
  coordinator.metadata.transition(room.id, run.discussionId, 0, 'completed');
  Object.assign(settings.discussion, {
    defaultRounds: 4,
    organizerParticipates: false,
    maxTurns: 1,
  });
  save(2);
  request.mockClear();
  await coordinator.fromAgent('source', input, 'settings-defaults', vi.fn());
  expect(request).not.toHaveBeenCalled();
  expect(coordinator.metadata.resources(room.id, run.requestId)?.maxTurns).toBe(2);
});

it('legacy admitted model send retains its omitted rounds when defaults change', async () => {
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  db.prepare('UPDATE team_discussion_rooms SET source_session_id = ? WHERE id = ?').run(
    'source',
    'room',
  );
  const input = { action: 'send', roomId: 'room', message: 'Legacy send' };
  await coordinator.fromAgent('source', input, 'legacy-replay', vi.fn());
  const admitted = coordinator.metadata.latestRun('room')!;
  coordinator.metadata.transition('room', admitted.discussionId, 0, 'completed');
  db.prepare(
    'UPDATE team_discussion_runs SET requested_rounds = NULL, resources_json = NULL WHERE id = ?',
  ).run(admitted.discussionId);
  const { defaultAgentTeamSettings } =
    await import('../../../../shared/cowork/agent-team/agentTeamSettings');
  const settings = defaultAgentTeamSettings();
  settings.discussion.defaultRounds = 1;
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run(
    'agentTeam.settings',
    JSON.stringify({ version: 1, revision: 1, value: settings }),
    1,
  );
  request.mockClear();
  await expect(
    coordinator.fromAgent('source', input, 'legacy-replay', vi.fn()),
  ).resolves.toMatchObject({ accepted: true });
  expect(request).not.toHaveBeenCalled();
});

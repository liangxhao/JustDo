import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDiscussionHolding } from '../../../../openclaw-extensions/runtime-services/agent-team/discussion/discussion-holding';
import {
  serializeTeamDiscussionSend,
  TeamDiscussionGateway as Gateway,
} from '../../../../src/shared/cowork/agent-team/teamDiscussion';

const sdk = vi.hoisted(() => ({ append: vi.fn(), read: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  appendSessionTranscriptMessageByIdentity: sdk.append,
  readSessionTranscriptRawDelta: sdk.read,
}));
const roots: string[] = [];
const gate = () => {
  let release!: () => void;
  return {
    promise: new Promise<void>(resolve => {
      release = resolve;
    }),
    release: () => release(),
  };
};
const send = (requestId = 'request') => ({
  roomId: 'room',
  requestId,
  expectedRevision: 1,
  message: 'PRIVATE_PENDING_BODY',
  selectedAgentIds: [],
  rounds: 1,
});
const digest = (value: ReturnType<typeof send>) =>
  createHash('sha256').update(serializeTeamDiscussionSend(value)).digest('hex');
function fixture(state?: { root: string; entries: Map<string, any>; events: Map<string, any[]> }) {
  const root = state?.root ?? mkdtempSync(path.join(os.tmpdir(), 'team-holding-test-'));
  if (!state) roots.push(root);
  const entries = state?.entries ?? new Map<string, any>();
  const events = state?.events ?? new Map<string, any[]>();
  const methods = new Map<string, (...args: any[]) => Promise<any>>();
  const hooks = new Map<string, (...args: any[]) => any>();
  let service!: { start(context: { stateDir: string }): void; stop(): void };
  let enabled = true;
  let before: ReturnType<typeof gate> | undefined;
  let after: ReturnType<typeof gate> | undefined;
  let creating: ReturnType<typeof gate> | undefined;
  let restoreOnDelete = false;
  let count = 0;
  sdk.append.mockImplementation(async params => {
    await before?.promise;
    params.beforeFreshMessageCommit();
    const rows = events.get(params.sessionKey) ?? [];
    const previous = rows.find(row => row.message.idempotencyKey === params.message.idempotencyKey);
    if (previous) return { appended: false, messageId: previous.id, message: previous.message };
    const id = `entry-${++count}`;
    rows.push({ type: 'message', id, message: structuredClone(params.message) });
    events.set(params.sessionKey, rows);
    await after?.promise;
    return { appended: true, messageId: id, message: params.message };
  });
  sdk.read.mockImplementation(async params => ({
    kind: 'page',
    events: (events.get(params.sessionKey) ?? []).map((event, seq) => ({ event, seq })),
    cursor: 'done',
    hasMore: false,
    serializedBytes: 1,
  }));
  const request = vi.fn(async (method, params) => {
    const entry = entries.get(params.key);
    if (restoreOnDelete && method === 'sessions.delete') entry.archivedAt = undefined;
    if (
      !entry ||
      entry.sessionId !== params.expectedSessionId ||
      entry.lifecycleRevision !== params.expectedLifecycleRevision
    )
      throw new Error('teamDiscussionSessionChanged');
    if (method === 'sessions.patch') {
      entry.archivedAt = Date.now();
      entry.lifecycleRevision += '-archive';
      return {};
    }
    if (
      entry.archivedAt === undefined ||
      entry.modelSelectionLocked === true ||
      params.archivedOnly !== true
    )
      throw new Error('not archived');
    entries.delete(params.key);
    events.delete(params.key);
    return {};
  });
  registerDiscussionHolding({
    runtime: {
      config: { current: () => ({ plugins: { entries: { 'agent-team': { enabled } } } }) },
      agent: {
        session: {
          getSessionEntry: ({ sessionKey }: any) => entries.get(sessionKey),
          createSessionEntry: async (params: any) => {
            await creating?.promise;
            const entry = {
              ...params.initialEntry,
              sessionId: `native-${++count}`,
              lifecycleRevision: `revision-${count}`,
              sessionRoot: params.sessionRoot,
              permissionMode: params.permissionMode,
            };
            entries.set(params.key, entry);
            return { key: params.key, sessionId: entry.sessionId, entry };
          },
          patchSessionEntry: async (params: any) => {
            const entry = entries.get(params.sessionKey);
            Object.assign(entry, params.update(entry));
            entry.lifecycleRevision += '-unlock';
            return entry;
          },
        },
      },
      gateway: { request },
    },
    registerAgentHarness: vi.fn(),
    on: (name: string, hook: (...args: any[]) => any) => hooks.set(name, hook),
    registerService: (value: typeof service) => {
      service = value;
    },
    registerGatewayMethod: (name: string, method: (...args: any[]) => Promise<any>) =>
      methods.set(name, method),
  } as never);
  service.start({ stateDir: root });
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      void methods.get(method)!({
        params,
        respond: (ok: boolean, value: unknown, error: { message: string }) =>
          ok ? resolve(value) : reject(new Error(error.message)),
      });
    });
  const prepare = (generation = 1) =>
    call(Gateway.HoldingPrepare, {
      roomId: 'room',
      generation,
      agentId: 'main',
      cwd: path.resolve('.'),
    });
  const save = (identity: any, value = send()) =>
    call(Gateway.HoldingSave, { identity, send: value, fingerprint: digest(value) });
  const cleanup = async (identity: any) => {
    await request('sessions.patch', {
      key: identity.sessionKey,
      archived: true,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
    });
    const archived = (
      await call(Gateway.HoldingClose, { roomId: identity.roomId })
    ).identities.find((value: any) => value.sessionKey === identity.sessionKey);
    const unlocked = (
      await call(Gateway.HoldingClose, {
        roomId: identity.roomId,
        phase: 'unlock',
        identity: archived,
      })
    ).identity;
    await request('sessions.delete', {
      key: unlocked.sessionKey,
      archivedOnly: true,
      deleteTranscript: true,
      expectedSessionId: unlocked.sessionId,
      expectedLifecycleRevision: unlocked.lifecycleRevision,
    });
    return call(Gateway.HoldingClose, { roomId: identity.roomId });
  };
  return {
    root,
    entries,
    events,
    prepare,
    save,
    call,
    service,
    request,
    hooks,
    cleanup,
    before(value: ReturnType<typeof gate>) {
      before = value;
    },
    after(value: ReturnType<typeof gate>) {
      after = value;
    },
    creating(value: ReturnType<typeof gate>) {
      creating = value;
    },
    disable() {
      enabled = false;
    },
    restoreOnDelete() {
      restoreOnDelete = true;
    },
  };
}
beforeEach(() => {
  sdk.append.mockReset();
  sdk.read.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('native pending discussion input', () => {
  it('stores only native custom bodies and returns an exact verified input', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const saved = await f.save(identity);
    expect(saved.state).toBe('saved');
    const read = await f.call(Gateway.HoldingRead, {
      identity,
      requestId: 'request',
      fingerprint: digest(send()),
      entryId: saved.entryId,
    });
    expect(read.send).toEqual(send());
    expect(sdk.append.mock.calls[0][0].message).toMatchObject({
      role: 'custom',
      customType: 'agent-team-holding-input',
      display: false,
      excludeFromContext: true,
      idempotencyKey: 'agent-team-holding:room:1:request',
      __openclaw: {
        agentTeamHolding: {
          roomId: 'room',
          generation: 1,
          requestId: 'request',
          fingerprint: digest(send()),
        },
      },
    });
    expect(f.entries.get(identity.sessionKey).pluginExtensions).toEqual({
      'runtime-services': { holding: { roomId: 'room', generation: 1 } },
    });
    const contents = (directory: string): string =>
      readdirSync(directory, { withFileTypes: true })
        .map(entry =>
          entry.isDirectory()
            ? contents(path.join(directory, entry.name))
            : readFileSync(path.join(directory, entry.name), 'utf8'),
        )
        .join('');
    expect(contents(f.root)).not.toContain('PRIVATE_PENDING_BODY');
    expect(await f.save(identity)).toEqual(saved);
    expect(sdk.append).toHaveBeenCalledTimes(1);
  });
  it.each(['marker', 'custom-type', 'idempotency-prefix'])(
    'does not reinterpret a historical holding %s during native readback',
    async kind => {
      const f = fixture();
      const identity = await f.prepare();
      const saved = await f.save(identity);
      const message = f.events.get(identity.sessionKey)![0].message;
      if (kind === 'marker') {
        message.__openclaw.justdoTeamHolding = message.__openclaw.agentTeamHolding;
        delete message.__openclaw.agentTeamHolding;
      } else if (kind === 'custom-type') {
        message.customType = 'justdo-team-holding-input';
      } else {
        message.idempotencyKey = 'justdo-team-holding:room:1:request';
      }
      await expect(
        f.call(Gateway.HoldingRead, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
          entryId: saved.entryId,
        }),
      ).rejects.toThrow();
      expect(sdk.append).toHaveBeenCalledTimes(1);
      await f.cleanup(identity);
      expect(f.entries.has(identity.sessionKey)).toBe(false);
    },
  );
  it('rejects a changed request fingerprint without another native append', async () => {
    const f = fixture();
    const identity = await f.prepare();
    await f.save(identity);
    await expect(f.save(identity, { ...send(), message: 'changed' })).rejects.toThrow(
      'teamDiscussionExecutionConflict',
    );
    expect(sdk.append).toHaveBeenCalledTimes(1);
  });
  it('does not confirm an idempotent native ACK carrying a different custom body', async () => {
    const f = fixture();
    const identity = await f.prepare();
    sdk.append.mockImplementationOnce(async params => ({
      appended: false,
      messageId: 'foreign-entry',
      message: {
        ...params.message,
        content: [{ type: 'text', text: 'different body' }],
      },
    }));
    expect((await f.save(identity)).state).toBe('unknown');
    expect((await f.save(identity)).state).toBe('unknown');
    expect(sdk.append).toHaveBeenCalledOnce();
  });
  it('retains cancellation received before the save request', async () => {
    const f = fixture();
    const identity = await f.prepare();
    await f.call(Gateway.HoldingCancel, { roomId: 'room', generation: 1, requestIds: ['request'] });
    expect((await f.save(identity)).state).toBe('cancelled');
    expect(sdk.append).not.toHaveBeenCalled();
  });
  it('does not write when cancellation wins the native commit fence', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const barrier = gate();
    f.before(barrier);
    const saving = f.save(identity);
    await vi.waitFor(() => expect(sdk.append).toHaveBeenCalledOnce());
    await f.call(Gateway.HoldingCancel, { roomId: 'room', generation: 1, requestIds: ['request'] });
    barrier.release();
    expect((await saving).state).toBe('cancelled');
    expect(f.events.get(identity.sessionKey)).toBeUndefined();
  });
  it('never revives a cancelled input after a late native ACK', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const barrier = gate();
    f.after(barrier);
    const saving = f.save(identity);
    await vi.waitFor(() => expect(f.events.get(identity.sessionKey)).toHaveLength(1));
    await f.call(Gateway.HoldingCancel, { roomId: 'room', generation: 1, requestIds: ['request'] });
    barrier.release();
    expect((await saving).state).toBe('cancelled');
    expect(
      (
        await f.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
        })
      ).state,
    ).toBe('cancelled');
  });
  it('keeps a duplicate receiving request uncertain instead of appending again', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const barrier = gate();
    f.before(barrier);
    const saving = f.save(identity);
    await vi.waitFor(() => expect(sdk.append).toHaveBeenCalledOnce());
    expect((await f.save(identity)).state).toBe('unknown');
    expect(sdk.append).toHaveBeenCalledOnce();
    barrier.release();
    expect((await saving).state).toBe('saved');
  });
  it('advances the cancellation epoch and leaves later same-epoch work intact on replay', async () => {
    const f = fixture();
    const old = await f.prepare();
    await f.save(old);
    await f.call(Gateway.HoldingCancel, { roomId: 'room', generation: 2 });
    expect(
      (
        await f.call(Gateway.HoldingStatus, {
          identity: old,
          requestId: 'request',
          fingerprint: digest(send()),
        })
      ).state,
    ).toBe('cancelled');
    await expect(f.prepare(1)).rejects.toThrow('teamDiscussionHoldingCancelled');
    const identity = await f.prepare(2);
    await f.save(identity, send('second'));
    await f.call(Gateway.HoldingCancel, { roomId: 'room', generation: 2 });
    expect(
      (
        await f.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'second',
          fingerprint: digest(send('second')),
        })
      ).state,
    ).toBe('saved');
  });
  it('preserves saved inputs through a normal service restart', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const saved = await f.save(identity);
    f.service.stop();
    const next = fixture(f);
    expect(await next.prepare()).toEqual(identity);
    expect(
      (
        await next.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
          entryId: saved.entryId,
        })
      ).state,
    ).toBe('saved');
  });
  it('recovers a committed uncertain input by raw native evidence without a second append', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const barrier = gate();
    f.after(barrier);
    const saving = f.save(identity);
    await vi.waitFor(() => expect(f.events.get(identity.sessionKey)).toHaveLength(1));
    f.service.stop();
    const next = fixture(f);
    expect((await next.save(identity)).state).toBe('unknown');
    expect(sdk.append).toHaveBeenCalledOnce();
    expect(
      (
        await next.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
        })
      ).state,
    ).toBe('saved');
    barrier.release();
    expect((await saving).state).toBe('unknown');
    expect(
      (
        await next.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
        })
      ).state,
    ).toBe('saved');
  });
  it('does not resend uncertain input when the native entry is absent after restart', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const barrier = gate();
    f.before(barrier);
    const saving = f.save(identity);
    await vi.waitFor(() => expect(sdk.append).toHaveBeenCalledOnce());
    f.service.stop();
    const next = fixture(f);
    expect(
      (
        await next.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
        })
      ).state,
    ).toBe('unknown');
    expect((await next.save(identity)).state).toBe('unknown');
    expect(sdk.append).toHaveBeenCalledOnce();
    barrier.release();
    expect((await saving).state).toBe('unknown');
    expect(f.events.get(identity.sessionKey)).toBeUndefined();
  });
  it('durably cancels saved inputs on explicit plugin disable', async () => {
    const f = fixture();
    const identity = await f.prepare();
    await f.save(identity);
    f.disable();
    f.service.stop();
    const next = fixture(f);
    expect(
      (
        await next.call(Gateway.HoldingStatus, {
          identity,
          requestId: 'request',
          fingerprint: digest(send()),
        })
      ).state,
    ).toBe('cancelled');
  });
  it('keeps required-owner cancellation and precise cleanup available while Team is disabled', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const saved = await f.save(identity);
    f.disable();
    await expect(f.prepare()).rejects.toThrow('teamDiscussionDisabled');
    await expect(f.save(identity)).rejects.toThrow('teamDiscussionDisabled');
    const input = {
      identity,
      requestId: 'request',
      fingerprint: digest(send()),
      entryId: saved.entryId,
    };
    await expect(f.call(Gateway.HoldingRead, input)).rejects.toThrow('teamDiscussionDisabled');
    await expect(f.call(Gateway.HoldingStatus, input)).rejects.toThrow('teamDiscussionDisabled');
    await expect(f.call(Gateway.HoldingCancel, { roomId: 'room', generation: 2 })).resolves.toEqual(
      { cancelled: true },
    );
    expect((await f.call(Gateway.HoldingClose, { roomId: 'room' })).identities).toEqual([identity]);
    expect((await f.cleanup(identity)).identities).toEqual([]);
    expect(f.entries.has(identity.sessionKey)).toBe(false);
  });
  it('blocks an altered native message and never returns another entry', async () => {
    const f = fixture();
    const identity = await f.prepare();
    const saved = await f.save(identity);
    f.events.get(identity.sessionKey)![0].message.excludeFromContext = false;
    await expect(
      f.call(Gateway.HoldingRead, {
        identity,
        requestId: 'request',
        fingerprint: digest(send()),
        entryId: saved.entryId,
      }),
    ).rejects.toThrow('teamDiscussionExecutionConflict');
  });
  it('never reads a borrowed session or a replacement native incarnation', async () => {
    const f = fixture();
    const identity = await f.prepare();
    await f.save(identity);
    await expect(
      f.call(Gateway.HoldingRead, {
        identity: { ...identity, sessionKey: 'agent:main:justdo:borrowed' },
        requestId: 'request',
        fingerprint: digest(send()),
      }),
    ).rejects.toThrow('teamDiscussionInvalidInput');
    f.entries.get(identity.sessionKey).sessionId = 'replacement';
    await expect(
      f.call(Gateway.HoldingRead, { identity, requestId: 'request', fingerprint: digest(send()) }),
    ).rejects.toThrow('teamDiscussionSessionChanged');
  });
  it('archives, owner-unlocks and precisely deletes before recording cleanup', async () => {
    const f = fixture();
    const identity = await f.prepare();
    await f.save(identity);
    const closed = await f.call(Gateway.HoldingClose, { roomId: 'room' });
    expect(closed.identities).toEqual([identity]);
    expect(f.request).not.toHaveBeenCalled();
    expect((await f.cleanup(identity)).identities).toEqual([]);
    expect(f.entries.size).toBe(0);
    expect(f.request.mock.calls.map(call => call[0])).toEqual([
      'sessions.patch',
      'sessions.delete',
    ]);
    expect(f.request.mock.calls[1][1]).toMatchObject({
      archivedOnly: true,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: 'revision-1-archive-unlock',
    });
    await expect(f.prepare(2)).rejects.toThrow('teamDiscussionNotFound');
  });
  it('retains a closed tombstone when explicit restore races deletion', async () => {
    const f = fixture();
    const identity = await f.prepare();
    f.restoreOnDelete();
    await f.call(Gateway.HoldingClose, { roomId: 'room' });
    await expect(f.cleanup(identity)).rejects.toThrow('not archived');
    expect(f.entries.has(identity.sessionKey)).toBe(true);
    expect(f.hooks.get('before_agent_run')!({}, { sessionKey: identity.sessionKey })).toMatchObject(
      { outcome: 'block' },
    );
    await expect(f.prepare(2)).rejects.toThrow('teamDiscussionNotFound');
  });
  it('finishes exact archived deletion after retirement removes the unlocked holder mirror', async () => {
    const f = fixture();
    const identity = await f.prepare();
    await f.save(identity);
    await f.call(Gateway.HoldingClose, { roomId: 'room' });
    await f.request('sessions.patch', {
      key: identity.sessionKey,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
    });
    const archived = (await f.call(Gateway.HoldingClose, { roomId: 'room' })).identities[0];
    const unlocked = (
      await f.call(Gateway.HoldingClose, { roomId: 'room', phase: 'unlock', identity: archived })
    ).identity;
    f.service.stop();
    f.entries.get(identity.sessionKey).pluginExtensions = undefined;
    const next = fixture(f);

    expect((await next.call(Gateway.HoldingClose, { roomId: 'room' })).identities).toEqual([
      unlocked,
    ]);
    expect(
      (
        await next.call(Gateway.HoldingClose, {
          roomId: 'room',
          phase: 'unlock',
          identity: unlocked,
        })
      ).identity,
    ).toEqual(unlocked);
    await expect(next.prepare(2)).rejects.toThrow('teamDiscussionNotFound');
    await expect(next.save(unlocked, send('next-request'))).rejects.toThrow(
      'teamDiscussionHoldingCancelled',
    );
    await next.request('sessions.delete', {
      key: unlocked.sessionKey,
      archivedOnly: true,
      expectedSessionId: unlocked.sessionId,
      expectedLifecycleRevision: unlocked.lifecycleRevision,
    });
    expect((await next.call(Gateway.HoldingClose, { roomId: 'room' })).identities).toEqual([]);
    expect(next.entries.has(identity.sessionKey)).toBe(false);
    expect(sdk.append).toHaveBeenCalledOnce();
  });
  it.each([
    { sessionId: 'replacement' },
    { lifecycleRevision: 'replacement-revision' },
    { sessionRoot: 'another-root' },
    { agentHarnessId: 'another-harness' },
    { modelSelectionLocked: true },
    { archivedAt: undefined },
    { pluginExtensions: { 'runtime-services': { holding: { roomId: 'foreign' } } } },
  ])('rejects a mirrorless cleanup with altered native custody %j', async alteration => {
    const f = fixture();
    const identity = await f.prepare();
    await f.call(Gateway.HoldingClose, { roomId: 'room' });
    await f.request('sessions.patch', {
      key: identity.sessionKey,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
    });
    const archived = (await f.call(Gateway.HoldingClose, { roomId: 'room' })).identities[0];
    await f.call(Gateway.HoldingClose, { roomId: 'room', phase: 'unlock', identity: archived });
    f.service.stop();
    Object.assign(f.entries.get(identity.sessionKey), { pluginExtensions: undefined }, alteration);
    const next = fixture(f);

    await expect(next.call(Gateway.HoldingClose, { roomId: 'room' })).rejects.toThrow(
      'teamDiscussionSessionChanged',
    );
    expect(next.entries.has(identity.sessionKey)).toBe(true);
    expect(next.request).not.toHaveBeenCalled();
  });
  it('waits for a late owned creation and cleans it without reopening the closed room', async () => {
    const f = fixture();
    const barrier = gate();
    f.creating(barrier);
    const preparing = f.prepare();
    preparing.catch(() => {});
    await Promise.resolve();
    const closing = f.call(Gateway.HoldingClose, { roomId: 'room' });
    barrier.release();
    await expect(preparing).rejects.toThrow('teamDiscussionHoldingCancelled');
    const closed = await closing;
    expect(closed.identities).toHaveLength(1);
    await f.cleanup(closed.identities[0]);
    expect(f.entries.size).toBe(0);
  });
});

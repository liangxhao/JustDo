import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { registerCustody } from '../../custody/service';
import { CUSTODY_RPC as RPC, INERT_CUSTODY_HARNESS } from '../../sdk/custody';
import { CUSTODY_PROVIDER_KEY, custodyResourceId } from '../../sdk/custody-client';

const sdk = vi.hoisted(() => ({ append: vi.fn(), read: vi.fn(), dispatch: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({ appendSessionTranscriptMessageByIdentity: sdk.append, readSessionTranscriptRawDelta: sdk.read }));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({ dispatchGatewayMethod: sdk.dispatch }));
const roots: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^custody-test-/u);
    rmSync(root, { recursive: true, force: true });
  }
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'custody-test-')); roots.push(root);
  const lifecycle = new AbortController();
  const methods = new Map<string, (request: any) => Promise<void>>();
  const entries = new Map<string, any>();
  const rows = new Map<string, any[]>();
  const scope = randomUUID(); let active = true; let sequence = 0;
  let before: ReturnType<typeof barrier> | undefined; let after: ReturnType<typeof barrier> | undefined; let creating: ReturnType<typeof barrier> | undefined;
  let event: (value: any) => void = () => undefined;
  let service!: { start(context: unknown): void; stop(): void };
  const owner = { pluginId: 'example', registrationId: randomUUID(), isCurrent: () => active,
    assertCurrent: () => { if (!active) throw new Error('Retired writer'); }, onRetire: () => () => undefined };
  sdk.append.mockReset().mockImplementation(async params => {
    await before?.promise; params.beforeFreshMessageCommit();
    const events = rows.get(params.sessionKey) ?? [];
    const previous = events.find(row => row.message.idempotencyKey === params.message.idempotencyKey);
    if (previous) return { appended: false, messageId: previous.id, message: previous.message };
    const id = 'entry-' + ++sequence;
    events.push({ type: 'message', id, message: structuredClone(params.message) }); rows.set(params.sessionKey, events);
    await after?.promise; return { appended: true, messageId: id, message: params.message };
  });
  sdk.read.mockReset().mockImplementation(async params => ({ kind: 'page', events: (rows.get(params.sessionKey) ?? []).map((value, seq) => ({ event: value, seq })), cursor: 'end', hasMore: false, serializedBytes: 1 }));
  sdk.dispatch.mockReset().mockResolvedValue({ ok: true, payload: { status: 'aborted' } });
  const harness = vi.fn(); const hooks = new Map<string, any>();
  registerCustody({
    id: 'runtime-services', lifecycle: { signal: lifecycle.signal, runInBackgroundContext: (run: () => unknown) => run() },
    logger: { error: vi.fn() }, runtime: { config: { current: () => ({}) }, events: { onAgentEvent: (listener: typeof event) => { event = listener; return () => { event = () => undefined; }; } },
      agent: { session: {
        getSessionEntry: ({ sessionKey }: any) => entries.get(sessionKey),
        createSessionEntry: async (params: any) => { await creating?.promise; entries.set(params.key, { ...params.initialEntry, sessionId: 'native-' + ++sequence, lifecycleRevision: 'revision-' + sequence, sessionRoot: params.sessionRoot, permissionMode: params.permissionMode }); },
        patchSessionEntry: async (params: any) => { const current = entries.get(params.sessionKey); Object.assign(current, params.update(current)); current.lifecycleRevision += '-unlock'; },
      } },
    }, registerAgentHarness: harness, on: (name: string, listener: any) => hooks.set(name, listener),
    registerService: (value: typeof service) => { service = value; }, registerGatewayMethod: (name: string, callback: any) => methods.set(name, callback),
  } as never, { scope, resolve: token => token === 'writer' && active ? owner : undefined, dispose() {} });
  service.start({ stateDir: root }); stops.push(() => { service.stop(); lifecycle.abort(); });
  const call = (method: string, params: any, options: { authority?: boolean; signal?: AbortSignal; noAuthority?: boolean } = {}) => new Promise<any>((resolve, reject) => {
    void methods.get(method)!({ params, signal: options.signal, client: { connect: { client: { mode: 'backend' } } },
      hasCurrentClientAuthority: options.noAuthority ? undefined : () => options.authority !== false,
      respond: (ok: boolean, value: unknown, error: any) => ok ? resolve(value) : reject(new Error(error.message)) });
  });
  const resourceId = custodyResourceId('example', 'scope');
  const writer = { ownerToken: 'writer', providerScope: scope };
  const prepare = (epoch = 1) => call(RPC.prepare, { ...writer, scopeId: 'scope', epoch, agentId: 'main', cwd: path.resolve('.') }, { noAuthority: true });
  const append = (identity: any, payload = 'PRIVATE_OPAQUE_BODY', operationId = 'input') => call(RPC.append, { ...writer, identity, payload, operationId, sha256: sha(payload) }, { noAuthority: true });
  const locator = (identity: any, payload = 'PRIVATE_OPAQUE_BODY', operationId = 'input') => ({ identity, resourceId, epoch: identity.epoch, operationId, sha256: sha(payload) });
  const port = () => (Reflect.get(globalThis, Symbol.for(CUSTODY_PROVIDER_KEY)) as Map<string, any>).get(scope);
  return { root, scope, resourceId, writer, prepare, append, locator, call, entries, rows, service, harness, hooks, owner, port, emit: (value: any) => event(value),
    retire: () => { active = false; }, before: (value: ReturnType<typeof barrier>) => { before = value; }, after: (value: ReturnType<typeof barrier>) => { after = value; }, creating: (value: ReturnType<typeof barrier>) => { creating = value; } };
}

test('stores opaque body only in native inert storage and checks exact readback without a second append', async () => {
  const f = fixture(); const identity = await f.prepare(); const receipt = await f.append(identity);
  expect(receipt.state).toBe('saved');
  const saved = await f.call(RPC.read, { ...f.writer, ...f.locator(identity) }, { noAuthority: true });
  expect(saved.payload).toBe('PRIVATE_OPAQUE_BODY');
  expect(f.harness.mock.calls[0][0].id).toBe(INERT_CUSTODY_HARNESS);
  expect(f.hooks.get('before_agent_run')({}, { sessionKey: identity.sessionKey })).toMatchObject({ outcome: 'block' });
  const contents = (directory: string): string => readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory() ? contents(path.join(directory, entry.name)) : readFileSync(path.join(directory, entry.name), 'utf8')).join('');
  expect(contents(f.root)).not.toContain('PRIVATE_OPAQUE_BODY');
  expect(await f.append(identity)).toEqual(receipt); expect(sdk.append).toHaveBeenCalledOnce();
  expect(await f.call(RPC.inspect, { ...f.writer, ...f.locator(identity) }, { noAuthority: true })).toMatchObject({ state: 'saved' });
  await expect(f.call(RPC.inspect, f.locator(identity), { noAuthority: true })).rejects.toThrow();
});

test('a receiving duplicate and lost acknowledgement remain unknown and reconcile only from exact native evidence', async () => {
  const f = fixture(); const identity = await f.prepare(); const wait = barrier(); f.after(wait);
  const first = f.append(identity); await vi.waitFor(() => expect(f.rows.get(identity.sessionKey)).toHaveLength(1));
  expect(await f.append(identity)).toMatchObject({ state: 'unknown' });
  f.retire(); wait.release(); await expect(first).rejects.toThrow('unavailable');
  expect(await f.call(RPC.inspect, f.locator(identity))).toMatchObject({ state: 'saved' });
  expect(sdk.append).toHaveBeenCalledOnce();
});

test('cancellation wins the native commit fence and a late ACK never revives a cancelled receipt', async () => {
  const f = fixture(); const identity = await f.prepare(); const wait = barrier(); f.before(wait);
  const pending = f.append(identity); await vi.waitFor(() => expect(sdk.append).toHaveBeenCalledOnce());
  await f.call(RPC.cancel, { resourceId: f.resourceId, epoch: 1, operationIds: ['input'] }); wait.release();
  expect(await pending).toMatchObject({ state: 'cancelled' }); expect(f.rows.size).toBe(0);
});

test('epoch advance is monotonic and replay does not cancel later work in the new epoch', async () => {
  const f = fixture(); const first = await f.prepare(); await f.append(first);
  await f.call(RPC.cancel, { resourceId: f.resourceId, epoch: 2 });
  const second = await f.prepare(2); await f.append(second);
  await f.call(RPC.cancel, { resourceId: f.resourceId, epoch: 2 });
  expect(await f.call(RPC.inspect, f.locator(first))).toMatchObject({ state: 'cancelled' });
  expect(await f.call(RPC.inspect, f.locator(second))).toMatchObject({ state: 'saved' });
  await expect(f.prepare(1)).rejects.toThrow();
});

test('borrowed and replacement native identities cannot be read or unlocked', async () => {
  const f = fixture(); const identity = await f.prepare(); await f.append(identity);
  await expect(f.call(RPC.read, { ...f.writer, ...f.locator({ ...identity, sessionKey: 'agent:main:source' }) })).rejects.toThrow();
  f.entries.get(identity.sessionKey).sessionId = 'replacement';
  await expect(f.call(RPC.inspect, f.locator(identity))).rejects.toThrow();
  await expect(f.call(RPC.unlock, { identity })).rejects.toThrow();
});

test('close waits for late native preparation and only unlocks its exact archived incarnation', async () => {
  const f = fixture(); const wait = barrier(); f.creating(wait);
  const pending = f.prepare(); await vi.waitFor(() => expect(f.entries.size).toBe(0));
  const closing = f.call(RPC.close, { resourceId: f.resourceId }); wait.release();
  await expect(pending).rejects.toThrow(); const closed = await closing;
  expect(closed.identities).toHaveLength(1); const value = closed.identities[0];
  await expect(f.call(RPC.unlock, { identity: value })).rejects.toThrow();
  f.entries.get(value.sessionKey).archivedAt = 1;
  const unlocked = await f.call(RPC.unlock, { identity: value }); expect(unlocked.identity.lifecycleRevision).toContain('unlock');
  await expect(f.prepare(2)).rejects.toThrow();
});

test('request retirement fences an in-flight native append independently of owner liveness', async () => {
  const f = fixture(); const identity = await f.prepare(); const wait = barrier(); f.before(wait); const caller = new AbortController();
  const pending = f.call(RPC.append, { ...f.writer, identity, payload: 'opaque', operationId: 'input', sha256: sha('opaque') }, { signal: caller.signal, noAuthority: true });
  await vi.waitFor(() => expect(sdk.append).toHaveBeenCalledOnce()); caller.abort(); wait.release();
  await expect(pending).rejects.toThrow(); expect(f.rows.size).toBe(0);
});

test('execution facts require exact whole-run terminal, current incarnation and separate cleanup', async () => {
  const f = fixture(); const operationId = sha('operation'); const subject = { agentId: 'main', sessionKey: 'agent:main:source', sessionId: 'source-native', lifecycleRevision: 'r1', runId: 'run' };
  f.entries.set(subject.sessionKey, { sessionId: subject.sessionId, lifecycleRevision: subject.lifecycleRevision });
  const write = (cleanupComplete: boolean, subjects = [subject]) => f.port().writeExecutionReceipt('writer', { operationId, inputSha256: sha('input'), subjects, cleanupComplete });
  write(false);
  f.emit({ seq: -1, stream: 'lifecycle', runId: 'run', sessionKey: subject.sessionKey, sessionId: subject.sessionId, data: { phase: 'end', executionSettled: true } });
  expect((await f.call(RPC.receiptInspect, { ownerId: 'example', operationId })).receipt.settledRunIds).toEqual([]);
  f.emit({ seq: 1, stream: 'lifecycle', runId: 'run', sessionKey: subject.sessionKey, sessionId: subject.sessionId, data: { phase: 'end', executionSettled: true } });
  expect((await f.call(RPC.receiptInspect, { ownerId: 'example', operationId })).receipt.state).toBe('open');
  write(true); expect((await f.call(RPC.receiptInspect, { ownerId: 'example', operationId })).receipt).toMatchObject({ state: 'settled', subjects: [{ outcome: 'completed' }] });
  expect(() => write(true, [subject, { ...subject, runId: 'other' }])).toThrow('cannot be extended');
});

test('maintenance cancellation uses enrolled exact native runs under the original operator and never fabricates settlement', async () => {
  const f = fixture(); const operationId = sha('cancel'); const subject = { agentId: 'main', sessionKey: 'agent:main:source', sessionId: 'native', lifecycleRevision: 'r1', runId: 'exact-run' };
  f.entries.set(subject.sessionKey, { sessionId: 'native', lifecycleRevision: 'r1' });
  f.port().writeExecutionReceipt('writer', { operationId, inputSha256: sha('input'), subjects: [subject], cleanupComplete: false });
  f.retire(); const result = await f.call(RPC.receiptCancel, { ownerId: 'example', operationId });
  expect(sdk.dispatch).toHaveBeenCalledExactlyOnceWith('sessions.abort', { key: subject.sessionKey, runId: 'exact-run' });
  expect(result.receipt).toMatchObject({ state: 'unknown', cancelRequested: true, settledRunIds: [], cleanupComplete: false });
  f.entries.get(subject.sessionKey).lifecycleRevision = 'replacement'; sdk.dispatch.mockClear();
  await expect(f.call(RPC.receiptCancel, { ownerId: 'example', operationId })).rejects.toThrow(); expect(sdk.dispatch).not.toHaveBeenCalled();
});

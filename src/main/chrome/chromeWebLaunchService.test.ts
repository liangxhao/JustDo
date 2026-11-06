import { EventEmitter } from 'node:events';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock' } }));

import { canonicalWebLaunchInput, type WebLaunchInput, type WebLaunchSource } from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import type { ChromeExtensionStreamEvent } from '../../shared/chrome/chromeExtensionStream';
import { CoworkStore } from '../data/coworkStore';
import type { NativeRunTerminalReceipt } from '../engine/gateway/types';
import type { CoworkNativeAcceptedBinding } from '../engine/types';
import type { ChromeExtensionTrustedSendHooks } from './chromeAppServerTypes';
import { ChromeWebLaunchService } from './chromeWebLaunchService';
import { ChromeWebLaunchStore } from './chromeWebLaunchStore';
import { buildStrictWebLaunchContext, webLaunchDigest } from './chromeWebLaunchValidation';

const databases: Database.Database[] = [];
const services: ChromeWebLaunchService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const db of databases.splice(0)) db.close(); });
const source: WebLaunchSource = { chromeInstanceId: 'browser-1', windowInstanceId: 'window-1', windowId: 1, tabId: 10, frameId: 0, documentId: 'doc-1', channelGeneration: 1, origin: 'https://business.example' };
const input: WebLaunchInput = { prompt: 'Synthetic private request marker', context: { text: 'Synthetic private context marker' }, mode: 'send', result: 'final' };
const binding = { sessionKey: 'agent:main:fixture:web', nativeSessionId: 'native-session-1', lifecycleRevision: 'revision-1', clientGeneration: 3 };
const tick = async () => { for (let count = 0; count < 20; count += 1) await Promise.resolve(); };

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY,title TEXT,status TEXT,cwd TEXT,execution_mode TEXT,permission_mode TEXT,active_skill_ids TEXT,agent_id TEXT,model_ref TEXT,forked_from_session_id TEXT,forked_from_session_title TEXT,forked_from_entry_id TEXT,source TEXT,pinned INTEGER,created_at INTEGER,updated_at INTEGER);`);
  const cowork = new CoworkStore(db);
  vi.spyOn(cowork, 'getConfig').mockReturnValue({ workingDirectory: path.resolve('.'), executionMode: 'local', permissionMode: 'full' } as never);
  vi.spyOn(cowork, 'getSession').mockImplementation(id => db.prepare('SELECT id,source FROM cowork_sessions WHERE id = ?').get(id) as never);
  let now = 1000;
  let stream: ((event: ChromeExtensionStreamEvent) => void) | undefined;
  let terminal: NativeRunTerminalReceipt | null = null;
  let latestHooks: ChromeExtensionTrustedSendHooks | undefined;
  let latestBinding: CoworkNativeAcceptedBinding | undefined;
  let history: unknown[] = [];
  let beforeSend: (() => Promise<void>) | undefined;
  let beforeMessageRead: (() => Promise<void>) | undefined;
  const wire = vi.fn();
  const changed = vi.fn();
  const threadCreated = vi.fn();
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'sessions.describe') return { session: { key: binding.sessionKey, sessionId: binding.nativeSessionId, lifecycleRevision: binding.lifecycleRevision } };
    if (method === 'chat.message.get') {
      await beforeMessageRead?.();
      const id = (params as { messageId: string }).messageId;
      const message = history.find(value => (value as { __openclaw?: { id?: string } }).__openclaw?.id === id);
      return message ? { ok: true, message } : { ok: false };
    }
    return {};
  });
  const client = { request };
  const runtime = Object.assign(new EventEmitter(), {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => binding.clientGeneration,
    getRunTerminalReceipt: () => terminal,
    fetchSessionHistoryByKey: vi.fn(async () => ({ messages: history })),
  });
  const chat = {
    subscribeThreadEvents: vi.fn(async (_id: string, listener: (event: ChromeExtensionStreamEvent) => void) => { stream = listener; return vi.fn(); }),
    sendMessage: vi.fn(async (value: { clientTurnId: string; sessionId: string }, hooks: ChromeExtensionTrustedSendHooks) => {
      latestHooks = hooks;
      await beforeSend?.();
      hooks.assertCurrent();
      hooks.finalSyncAdmission?.(binding);
      wire();
      latestBinding = { ...binding, nativeRunId: `native-${wire.mock.calls.length}`, clientTurnId: value.clientTurnId };
      hooks.onNativeAccepted?.(latestBinding);
      return { sessionId: value.sessionId, runId: value.clientTurnId, nativeRunId: latestBinding.nativeRunId };
    }),
  };
  const deps = { getDatabase: () => db, getStore: () => cowork, chat: chat as never, getRuntime: () => runtime as never, now: () => now, onChanged: changed, onThreadCreated: threadCreated };
  const service = new ChromeWebLaunchService(deps);
  services.push(service);
  service.writeSite({ expectedRevision: 0, origin: source.origin, enabled: true, allowSend: true, allowResult: true });
  const prepare = (options: { source?: WebLaunchSource; input?: WebLaunchInput; requestId?: string; clickSequence?: number; documentLeaseId?: string } = {}) => {
    const value = options.input ?? input;
    return service.prepare({ source: options.source ?? source, requestId: options.requestId ?? 'request-1', clickSequence: options.clickSequence ?? 1, bindingRevision: 1,
      payloadDigest: webLaunchDigest(canonicalWebLaunchInput(value)), input: value, ...(options.documentLeaseId ? { documentLeaseId: options.documentLeaseId } : {}) });
  };
  const actual = { prompt: input.prompt, context: input.context, permissionMode: 'ask' };
  const submit = (prepared: ReturnType<typeof prepare>, extra: Record<string, unknown> = {}) => service.submit({ launchId: prepared.receipt.launchId, composeRevision: prepared.internal.composeRevision, input: actual, submission: 'automatic', shareResult: true, ...extra });
  const ref = (prepared: ReturnType<typeof prepare>, changedSource = source) => ({ launchId: prepared.receipt.launchId, documentLeaseId: prepared.internal.documentLeaseId, source: changedSource });
  const finish = (text = 'SYNTHETIC_FINAL', status: 'completed' | 'failed' = 'completed', accepted = latestBinding) => {
    expect(accepted).toBeDefined();
    terminal = { runId: accepted!.nativeRunId, sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId, lifecycleGeneration: null, clientGeneration: 3, agentSeq: 9, status, executionSettled: true, endedAt: now };
    history = [{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', __openclaw: { id: 'message-final', runId: accepted!.nativeRunId } }];
    stream?.({ kind: 'agent', event: { ...binding, sessionId: binding.nativeSessionId, runId: accepted!.nativeRunId, agentSeq: 9, stream: 'lifecycle', data: { phase: status === 'completed' ? 'end' : 'error', executionSettled: true, terminalReply: { disposition: 'visible', text } } } } as never);
  };
  return { db, cowork, service, deps, prepare, submit, ref, chat, wire, changed, threadCreated, runtime, request, finish,
    get hooks() { return latestHooks; },
    get accepted() { return latestBinding; },
    set beforeSend(value: (() => Promise<void>) | undefined) { beforeSend = value; },
    set beforeMessageRead(value: (() => Promise<void>) | undefined) { beforeMessageRead = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    state: () => new ChromeWebLaunchStore(() => db, () => now).read(),
  };
}

describe('webpage launch admission and persistence', () => {
  it('atomically creates one ask session and only persists hashes/metadata', () => {
    const f = fixture();
    const first = f.prepare();
    expect(f.prepare()).toEqual(first);
    expect(f.db.prepare('SELECT source,permission_mode FROM cowork_sessions').all()).toEqual([{ source: 'chrome-extension', permission_mode: 'ask' }]);
    const serialized = JSON.stringify(f.state());
    expect(serialized).not.toContain(input.prompt);
    expect(serialized).not.toContain(input.context!.text);
    expect(Object.keys(f.state().receipts)).toHaveLength(1);
    expect(f.threadCreated).toHaveBeenCalledTimes(1);
  });

  it('rolls back both metadata and product session if creation fails; publishes no success', () => {
    const f = fixture();
    const original = f.cowork.createSession.bind(f.cowork);
    vi.spyOn(f.cowork, 'createSession').mockImplementation((...args) => { original(...args); throw new Error('fixture failure'); });
    f.changed.mockClear();
    expect(() => f.prepare()).toThrow();
    expect(f.db.prepare('SELECT count(*) AS count FROM cowork_sessions').get()).toEqual({ count: 0 });
    expect(Object.keys(f.state().receipts)).toHaveLength(0);
    expect(Object.keys(f.state().leases)).toHaveLength(0);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.threadCreated).not.toHaveBeenCalled();
  });

  it('restores a lost prepare ACK by exact document/request ID without preparing again', async () => {
    const f = fixture();
    const prepared = f.prepare();
    expect(await f.service.read({ source, requestId: 'request-1' })).toEqual(prepared);
    await expect(f.service.read({ source: { ...source, documentId: 'another' }, requestId: 'request-1' })).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('consumes rejected clicks, and rejects stale sequences after abandoned receipt/lease cleanup', () => {
    const f = fixture();
    const prepared = f.prepare();
    expect(() => f.prepare({ requestId: 'busy', clickSequence: 2 })).toThrow('COMPOSER_BUSY');
    f.service.abandon({ launchId: prepared.receipt.launchId, confirm: true });
    expect(() => f.prepare({ requestId: 'busy', clickSequence: 2 })).toThrow('EXPIRED');
    expect(() => f.prepare()).toThrow('EXPIRED');
    expect(f.prepare({ requestId: 'fresh', clickSequence: 3 }).receipt.request.status).toBe('drafted');
  });

  it('allows a higher channel only for the same live lease and rejects retired channels', async () => {
    const f = fixture(); const prepared = f.prepare();
    expect((await f.service.read(f.ref(prepared, { ...source, channelGeneration: 2 }))).receipt.launchId).toBe(prepared.receipt.launchId);
    await expect(f.service.read(f.ref(prepared))).rejects.toThrow('EXPIRED');
    f.service.revokeDocument({ source: { ...source, channelGeneration: 2 }, documentLeaseId: prepared.internal.documentLeaseId, reason: 'pagehide' });
    await expect(f.service.read(f.ref(prepared, { ...source, channelGeneration: 3 }))).rejects.toThrow('EXPIRED');
  });

  it('does not silently extend the automatic/confirmation deadline on revisions', () => {
    const f = fixture(); const prepared = f.prepare();
    f.advance(1000);
    const revised = f.service.revise({ launchId: prepared.receipt.launchId, expectedComposeRevision: 1, input: { prompt: 'changed', permissionMode: 'ask' } });
    f.advance(10_000);
    const again = f.service.revise({ launchId: prepared.receipt.launchId, expectedComposeRevision: 2, input: { prompt: 'changed again', permissionMode: 'ask' } });
    expect(again.internal.deadlineAt).toBe(revised.internal.deadlineAt);
    f.advance(900_000);
    expect(() => f.service.submit({ launchId: again.receipt.launchId, composeRevision: 3, input: { prompt: 'changed again', permissionMode: 'ask' }, submission: 'confirmed', shareResult: false })).toThrow('EXPIRED');
  });

  it('never treats object prototype keys as receipt or lease records', async () => {
    const f = fixture();
    await expect(f.service.stop({ launchId: '__proto__' })).rejects.toThrow('EXPIRED');
    expect(() => f.service.abandon({ launchId: 'constructor', confirm: true })).toThrow('EXPIRED');
    expect((Object.prototype as { notSent?: boolean }).notSent).toBeUndefined();
  });

  it('reports an explicit unsent cancellation as cancelled, not expired', () => {
    const f = fixture(); const prepared = f.prepare();
    const result = f.service.cancel(f.ref(prepared));
    expect(result.receipt.request.status).toBe('cancelled');
    expect(result.receipt.execution).toEqual({ status: 'not-started', executionSettled: false });
  });
});

describe('webpage owned sender and exact results', () => {
  it('claims only one send despite repeated submit requests', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); f.submit(prepared);
    await tick();
    expect(f.wire).toHaveBeenCalledTimes(1);
    expect(f.chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.state().receipts[prepared.receipt.launchId].nativeBinding?.nativeRunId).toBe('native-1');
  });

  it('fences a revised automatic owner and requires a fresh confirmed attempt', async () => {
    const f = fixture(); const prepared = f.prepare();
    let release!: () => void;
    f.beforeSend = () => new Promise(resolve => { release = resolve; });
    f.submit(prepared); await tick();
    const revised = f.service.revise({ launchId: prepared.receipt.launchId, expectedComposeRevision: 1, input: { prompt: 'human edit', permissionMode: 'ask' } });
    release(); await tick();
    expect(f.wire).not.toHaveBeenCalled();
    expect(f.state().receipts[prepared.receipt.launchId].notSent).toBe(true);
    expect(() => f.submit(revised, { input: { prompt: 'human edit', permissionMode: 'ask' } })).toThrow('CONFIRMATION_REQUIRED');
    f.beforeSend = undefined;
    f.submit(revised, { submission: 'confirmed', input: { prompt: 'human edit', permissionMode: 'ask' } });
    await tick(); expect(f.wire).toHaveBeenCalledTimes(1);
  });

  it('preserves stop intent before a native ID exists, without issuing an unbound abort', async () => {
    const f = fixture(); const prepared = f.prepare();
    let release!: () => void;
    f.beforeSend = () => new Promise(resolve => { release = resolve; });
    f.submit(prepared); await tick();
    await f.service.stop({ launchId: prepared.receipt.launchId });
    release(); await tick();
    expect(f.wire).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    expect(f.state().receipts[prepared.receipt.launchId].notSent).toBe(true);
  });

  it('retains a Stop on unknown dispatch and aborts only the later explicit native ACK identity', async () => {
    const f = fixture(); const prepared = f.prepare();
    let hooks!: ChromeExtensionTrustedSendHooks;
    f.chat.sendMessage.mockImplementation(async (_value, trusted) => {
      hooks = trusted;
      trusted.finalSyncAdmission?.(binding);
      throw Object.assign(new Error('synthetic lost ACK'), { requestSent: true });
    });
    f.submit(prepared); await tick();
    await f.service.stop({ launchId: prepared.receipt.launchId });
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    const stored = f.state().receipts[prepared.receipt.launchId];
    const lateAck = { ...binding, nativeRunId: 'explicit-ack-run', clientTurnId: stored.clientTurnId! };
    hooks.onNativeAccepted?.(lateAck);
    await tick();
    expect(f.request).toHaveBeenCalledWith('sessions.abort', { key: binding.sessionKey, runId: 'explicit-ack-run' });
    expect(f.state().receipts[prepared.receipt.launchId].executionSettled).toBe(false);
    expect(f.state().receipts[prepared.receipt.launchId].errorCode).toBeUndefined();
    expect(f.state().unknownOrigins).not.toContain(source.origin);
    expect(f.chat.sendMessage).toHaveBeenCalledTimes(1);
    f.finish('SYNTHETIC_LATE_FINAL', 'completed', lateAck);
    const final = await f.service.read(f.ref(prepared));
    expect(final.receipt.execution.status).toBe('completed');
    expect(final.receipt.error).toBeUndefined();
  });

  it('keeps a crashed dispatched run unknown and permits explicit abandonment without retry', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); await tick();
    f.service.close();
    const replacement = new ChromeWebLaunchService(f.deps);
    expect((await replacement.read(f.ref(prepared))).receipt.execution.status).toBe('unknown');
    replacement.abandon({ launchId: prepared.receipt.launchId, confirm: true });
    const fresh = replacement.prepare({ source, requestId: 'new-request', clickSequence: 2, bindingRevision: 1, input, payloadDigest: webLaunchDigest(canonicalWebLaunchInput(input)) });
    expect(fresh.internal.requiresUnknownConfirmation).toBe(true);
    expect(() => replacement.submit({ launchId: fresh.receipt.launchId, composeRevision: 1, input: { prompt: input.prompt, context: input.context }, submission: 'automatic', shareResult: true })).toThrow('UNKNOWN_EXECUTION');
    expect(f.wire).toHaveBeenCalledTimes(1);
    replacement.close();
  });

  it('changes an unproved running receipt to unknown when the selected Gateway generation changes', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); await tick();
    expect(f.state().receipts[prepared.receipt.launchId].executionStatus).toBe('running');
    let release!: () => void;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe') await new Promise<void>(resolve => { release = resolve; });
      return original(method, params);
    });
    f.finish(); await tick();
    const observing = f.service.observations();
    f.runtime.getGatewayClientGeneration = () => 4;
    release();
    const observations = await observing;
    expect(observations.observations[0].receipt.execution).toEqual({ status: 'unknown', executionSettled: false });
    expect(observations.observations[0].receipt.error?.code).toBe('UNKNOWN_EXECUTION');
    expect(f.wire).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
  });

  it('treats a generic accepted return without explicit native binding as unknown across windows', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.chat.sendMessage.mockImplementationOnce(async (value, trusted) => {
      trusted.finalSyncAdmission?.(binding);
      f.wire();
      return { sessionId: value.sessionId, runId: value.clientTurnId, nativeRunId: value.clientTurnId };
    });
    f.submit(prepared); await tick();
    expect(f.state().receipts[prepared.receipt.launchId].errorCode).toBe('UNKNOWN_EXECUTION');
    const otherWindow = f.prepare({ requestId: 'other-window', source: { ...source, windowId: 2, windowInstanceId: 'window-2' } });
    expect(otherWindow.internal.requiresUnknownConfirmation).toBe(true);
    expect(() => f.submit(otherWindow)).toThrow('UNKNOWN_EXECUTION');
    expect(f.wire).toHaveBeenCalledTimes(1);
  });

  it('does not erase an abandoned unknown tombstone when a separately confirmed task completes', async () => {
    const f = fixture(); const first = f.prepare();
    f.chat.sendMessage.mockImplementationOnce(async (value, trusted) => {
      trusted.finalSyncAdmission?.(binding);
      return { sessionId: value.sessionId, runId: value.clientTurnId, nativeRunId: value.clientTurnId };
    });
    f.submit(first); await tick();
    f.service.abandon({ launchId: first.receipt.launchId, confirm: true });
    const next = f.prepare({ requestId: 'confirmed-new', clickSequence: 2 });
    f.submit(next, { submission: 'confirmed', confirmNewTask: true }); await tick();
    f.finish(); await f.service.read(f.ref(next));
    const third = f.prepare({ requestId: 'third-new', clickSequence: 3 });
    expect(third.internal.requiresUnknownConfirmation).toBe(true);
  });

  it('keeps an explicitly unsent preparation failure in an editable external confirmation', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.chat.sendMessage.mockRejectedValueOnce(Object.assign(new Error('fixture preparation unavailable'), { requestSent: false }));
    f.submit(prepared); await tick();
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.request.status).toBe('awaiting-confirmation');
    expect(result.internal.requiresSendConfirmation).toBe(true);
    expect(result.receipt.execution).toEqual({ status: 'not-started', executionSettled: false });
    expect(() => f.submit(result)).toThrow('CONFIRMATION_REQUIRED');
  });

  it('returns only the exact final message and keeps result bodies out of metadata', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); await tick(); f.finish();
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.execution).toEqual({ status: 'completed', executionSettled: true });
    expect(result.receipt.output).toEqual({ status: 'available', text: 'SYNTHETIC_FINAL', format: 'text' });
    expect(JSON.stringify(f.state())).not.toContain('SYNTHETIC_FINAL');
    expect(JSON.stringify(await f.service.observations())).not.toContain('SYNTHETIC_FINAL');
    const repeated = await f.service.read(f.ref(prepared));
    expect(repeated.receipt.output.text).toBe('SYNTHETIC_FINAL');
  });

  it('holds a terminal that precedes the ACK without admitting or losing its exact final candidate', async () => {
    const f = fixture(); const prepared = f.prepare();
    let acknowledge!: () => void;
    let accepted!: CoworkNativeAcceptedBinding;
    f.chat.sendMessage.mockImplementation(async (value, trusted) => {
      trusted.finalSyncAdmission?.(binding);
      accepted = { ...binding, nativeRunId: 'early-final-run', clientTurnId: value.clientTurnId };
      await new Promise<void>(resolve => { acknowledge = resolve; });
      trusted.onNativeAccepted?.(accepted);
      return { sessionId: value.sessionId, runId: value.clientTurnId, nativeRunId: accepted.nativeRunId };
    });
    f.submit(prepared); await tick();
    f.finish('SYNTHETIC_EARLY_FINAL', 'completed', accepted); await tick();
    const before = await f.service.read(f.ref(prepared));
    expect(before.receipt.execution.executionSettled).toBe(false);
    expect(before.receipt.output.text).toBeUndefined();
    acknowledge(); await tick();
    expect((await f.service.read(f.ref(prepared))).receipt.output.text).toBe('SYNTHETIC_EARLY_FINAL');
  });

  it('rechecks result permission after native message read and withholds a raced revocation', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); await tick(); f.finish();
    f.beforeMessageRead = async () => {
      f.service.writeSite({ expectedRevision: 1, origin: source.origin, enabled: true, allowSend: true, allowResult: false });
    };
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.output.status).toBe('withheld');
    expect(result.receipt.output.text).toBeUndefined();
    expect(result.receipt.execution.status).toBe('completed');
  });

  it('enforces the final outer synchronous release fence after an inner result reader returns', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); await tick(); f.finish();
    await f.service.read(f.ref(prepared));
    const access = f.service as unknown as { readResult: (id: string) => Promise<string | undefined> };
    vi.spyOn(access, 'readResult').mockImplementation(async () => {
      queueMicrotask(() => f.service.cancel(f.ref(prepared)));
      return 'SYNTHETIC_FINAL';
    });
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.output.text).toBeUndefined();
    expect(result.receipt.output.status).toBe('withheld');
  });

  it('retires body candidates and owner metadata when an old complete receipt is pruned', async () => {
    const f = fixture(); const prepared = f.prepare();
    f.submit(prepared); await tick(); f.finish(); await tick();
    const access = f.service as unknown as { owners: Map<string, { candidates: Map<string, unknown> }> };
    expect(access.owners.get(prepared.receipt.launchId)?.candidates.size).toBe(1);
    f.advance(31 * 60_000);
    f.prepare({ requestId: 'next-request', clickSequence: 2 });
    expect(access.owners.has(prepared.receipt.launchId)).toBe(false);
  });

  it('never reads reply bodies for result:none and preserves failed execution independently', async () => {
    const f = fixture(); const prepared = f.prepare({ input: { ...input, result: 'none' } });
    f.submit(prepared, { shareResult: false }); await tick(); f.finish('NATIVE_ERROR_BODY', 'failed');
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.execution).toEqual({ status: 'failed', executionSettled: true });
    expect(result.receipt.output).toEqual({ status: 'not-requested' });
    expect(f.runtime.fetchSessionHistoryByKey).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === 'chat.message.get')).toBe(false);
    expect(JSON.stringify(result.receipt)).not.toContain('NATIVE_ERROR_BODY');
  });

  it('exposes only safe closed errors at the RPC boundary', async () => {
    const f = fixture();
    vi.spyOn(f.cowork, 'getConfig').mockImplementation(() => { throw new Error('secret-native-error-with-local-path'); });
    const operation = f.service.getOperations()['chrome/webLaunch/prepare']!;
    await expect(operation({ source, requestId: 'request', clickSequence: 1, bindingRevision: 1, input, payloadDigest: webLaunchDigest(canonicalWebLaunchInput(input)) })).rejects.toMatchObject({ publicError: { code: 'INTERNAL_ERROR', messageKey: 'webLaunchErrorINTERNAL_ERROR' } });
  });
});

describe('strict webpage context', () => {
  it('accounts for escaping and envelope overhead instead of truncating context', () => {
    expect(buildStrictWebLaunchContext(source.origin, 'small <value>')).toContain('\\u003cvalue\\u003e');
    expect(() => buildStrictWebLaunchContext(source.origin, '<'.repeat(5000))).toThrow('CONTEXT_TOO_LARGE');
  });
});

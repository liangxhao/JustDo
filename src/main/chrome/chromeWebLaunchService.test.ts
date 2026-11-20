import { EventEmitter } from 'node:events';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock' } }));

import { canonicalWebLaunchInput, type WebLaunchInput, WebLaunchMethod, type WebLaunchReceipt, type WebLaunchSource } from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import type { ChromeExtensionStreamEvent } from '../../shared/chrome/chromeExtensionStream';
import { CoworkStore } from '../data/coworkStore';
import type { NativeRunTerminalReceipt } from '../engine/gateway/types';
import type { CoworkNativeAcceptedBinding } from '../engine/types';
import { wrapChromeWebLaunchOperation } from './chromeAppServerProtocol';
import type { ChromeExtensionTrustedSendHooks } from './chromeAppServerTypes';
import { ChromeWebLaunchService } from './chromeWebLaunchService';
import { ChromeWebLaunchStore } from './chromeWebLaunchStore';
import { buildStrictWebLaunchContext, webLaunchActualDigest, webLaunchDigest } from './chromeWebLaunchValidation';

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
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY,title TEXT,status TEXT,cwd TEXT,execution_mode TEXT,permission_mode TEXT,active_skill_ids TEXT,agent_id TEXT,model_ref TEXT,forked_from_session_id TEXT,forked_from_session_title TEXT,forked_from_entry_id TEXT,source TEXT,pinned INTEGER,created_at INTEGER,updated_at INTEGER,native_session_key TEXT,native_parent_session_id TEXT,group_id TEXT);
    CREATE TABLE cowork_config (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE cowork_session_runs (session_id TEXT NOT NULL);`);
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
  const sessionsChanged = vi.fn();
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
  const deps = { getDatabase: () => db, getStore: () => cowork, chat: chat as never, getRuntime: () => runtime as never, now: () => now, onChanged: changed, onSessionsChanged: sessionsChanged };
  const service = new ChromeWebLaunchService(deps);
  services.push(service);
  service.writeSite({ expectedRevision: 0, origin: source.origin, enabled: true, allowSend: true, allowResult: true });
  const prepare = (options: { source?: WebLaunchSource; input?: WebLaunchInput; requestId?: string; clickSequence?: number; documentLeaseId?: string; connectionOnly?: true; expectedPolicyRevision?: number; expectedQueuedPolicyRevision?: number } = {}) => {
    const value = options.input ?? input;
    return service.prepare({ source: options.source ?? source, requestId: options.requestId ?? 'request-1', clickSequence: options.clickSequence ?? 1, bindingRevision: 1,
      payloadDigest: webLaunchDigest(canonicalWebLaunchInput(value)), input: value, ...(options.documentLeaseId ? { documentLeaseId: options.documentLeaseId } : {}),
      ...(options.connectionOnly !== undefined ? { connectionOnly: options.connectionOnly } : {}),
      ...(options.expectedPolicyRevision !== undefined ? { expectedPolicyRevision: options.expectedPolicyRevision } : {}),
      ...(options.expectedQueuedPolicyRevision !== undefined ? { expectedQueuedPolicyRevision: options.expectedQueuedPolicyRevision } : {}) });
  };
  const actual = { prompt: input.prompt, context: input.context, permissionMode: 'full' };
  const submit = (prepared: ReturnType<typeof prepare>, extra: Record<string, unknown> = {}) => service.submit({ launchId: prepared.receipt.launchId, composeRevision: prepared.internal.composeRevision, input: actual, submission: 'automatic', shareResult: true, ...extra });
  const ref = (prepared: ReturnType<typeof prepare>, changedSource = source) => ({ launchId: prepared.receipt.launchId, documentLeaseId: prepared.internal.documentLeaseId, source: changedSource });
  const finish = (text = 'SYNTHETIC_FINAL', status: 'completed' | 'failed' = 'completed', accepted = latestBinding, mediaUrls?: string[]) => {
    expect(accepted).toBeDefined();
    terminal = { runId: accepted!.nativeRunId, sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId, lifecycleGeneration: null, clientGeneration: 3, agentSeq: 9, status, executionSettled: true, endedAt: now };
    history = [{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', __openclaw: { id: 'message-final', runId: accepted!.nativeRunId },
      ...(mediaUrls ? { openclawDelivery: { mediaUrls } } : {}) }];
    stream?.({ kind: 'agent', event: { ...binding, sessionId: binding.nativeSessionId, runId: accepted!.nativeRunId, agentSeq: 9, stream: 'lifecycle', data: { phase: status === 'completed' ? 'end' : 'error', executionSettled: true, terminalReply: { disposition: 'visible', text } } } } as never);
  };
  return { db, cowork, service, deps, prepare, submit, ref, chat, wire, changed, sessionsChanged, runtime, request, finish,
    get hooks() { return latestHooks; },
    get accepted() { return latestBinding; },
    set beforeSend(value: (() => Promise<void>) | undefined) { beforeSend = value; },
    set beforeMessageRead(value: (() => Promise<void>) | undefined) { beforeMessageRead = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    state: () => new ChromeWebLaunchStore(() => db, () => now).read(),
  };
}

describe('webpage launch admission and persistence', () => {
  it('atomically creates one Full session and only persists hashes/metadata', () => {
    const f = fixture();
    const title = 'Review the order and identify unfinished shipments';
    const requestInput = { ...input, prompt: `  \r\n\t \r\n  ${title} and include vendors.\r\n${input.prompt}` };
    const first = f.prepare({ input: requestInput });
    expect(f.prepare({ input: requestInput })).toEqual(first);
    expect(first.internal.permissionMode).toBe('full');
    expect(f.db.prepare('SELECT title,source,permission_mode FROM cowork_sessions').all()).toEqual([
      { title, source: 'chrome-extension', permission_mode: 'full' },
    ]);
    const serialized = JSON.stringify(f.state());
    expect(serialized).not.toContain(title);
    expect(serialized).not.toContain(input.prompt);
    expect(serialized).not.toContain(input.context!.text);
    expect(Object.keys(f.state().receipts)).toHaveLength(1);
    expect(f.cowork.listSessions()).toHaveLength(1);
    expect(f.cowork.listSessions(undefined, { excludePendingFirstSend: true })).toEqual([]);
    expect(f.sessionsChanged).not.toHaveBeenCalled();
  });

  it.each([false, true])('recognizes a pre-upgrade draft without hiding a detached chat with run records (%s)', hasRuns => {
    const f = fixture();
    const { internal: { threadId } } = f.prepare();
    f.cowork.clearSessionPendingFirstSend(threadId);
    if (hasRuns) f.db.prepare('INSERT INTO cowork_session_runs (session_id) VALUES (?)').run(threadId);

    services.push(new ChromeWebLaunchService(f.deps));

    expect(f.cowork.listSessionSearchSummaries().map(row => row.id)).toEqual(hasRuns ? [threadId] : []);
    expect(f.sessionsChanged).toHaveBeenCalledTimes(hasRuns ? 0 : 1);
  });

  it('requires manual sending for the connection request and honors the next click automatically', async () => {
    const f = fixture();
    const prepared = f.prepare({ connectionOnly: true, expectedPolicyRevision: f.service.sites().revision });
    expect(prepared.internal.requiresSendConfirmation).toBe(true);
    expect(prepared.internal.requiresResultConsent).toBe(true);
    expect(prepared.receipt.request.status).toBe('awaiting-confirmation');
    expect(prepared.receipt.output.status).toBe('awaiting-consent');
    const stored = f.state().receipts[prepared.receipt.launchId];
    expect(stored).toMatchObject({ autoAllowed: false, shareResult: false, mode: input.mode, result: input.result,
      payloadDigest: webLaunchDigest(canonicalWebLaunchInput(input)) });
    const submit = wrapChromeWebLaunchOperation(f.service.getOperations()[WebLaunchMethod.Submit]!);
    await expect(submit({
      launchId: prepared.receipt.launchId,
      composeRevision: prepared.internal.composeRevision,
      input: { prompt: input.prompt, context: input.context, permissionMode: 'full' },
      submission: 'automatic',
      shareResult: true,
    })).rejects.toMatchObject({ data: { code: 'CONFIRMATION_REQUIRED', requestSent: false } });
    expect(f.wire).not.toHaveBeenCalled();
    f.submit(prepared, { submission: 'confirmed', shareResult: true });
    await tick();
    expect(f.wire).toHaveBeenCalledTimes(1);
    expect(f.chat.sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      permissionMode: 'full',
    }), expect.anything());
    expect(f.state().receipts[prepared.receipt.launchId].shareResult).toBe(true);
    f.finish('FIRST_REPLY');
    expect((await f.service.read(f.ref(prepared))).receipt.output.text).toBe('FIRST_REPLY');

    const next = f.prepare({ requestId: 'request-2', clickSequence: 2 });
    expect(next.internal.requiresSendConfirmation).toBe(false);
    expect(next.internal.requiresResultConsent).toBe(false);
    f.submit(next);
    await tick();
    expect(f.wire).toHaveBeenCalledTimes(2);
    expect(f.chat.sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      permissionMode: 'full',
    }), expect.anything());
    f.finish('NEXT_REPLY');
    expect((await f.service.read(f.ref(next))).receipt.output.text).toBe('NEXT_REPLY');
    expect(f.service.sites().revision).toBe(1);
  });

  it('preserves an existing Ask draft whose metadata predates the permission field', async () => {
    const f = fixture();
    const prepared = f.prepare();
    const { launchId } = prepared.receipt;
    const actual = { prompt: input.prompt, context: input.context };
    const store = new ChromeWebLaunchStore(f.deps.getDatabase, f.deps.now);
    store.mutate(state => {
      const stored = state.receipts[launchId];
      delete stored.permissionMode;
      stored.actualDigest = webLaunchActualDigest(actual);
    });
    f.db.prepare('UPDATE cowork_sessions SET permission_mode = ? WHERE id = ?')
      .run('ask', prepared.internal.threadId);
    f.service.close();
    const restored = new ChromeWebLaunchService(f.deps);
    services.push(restored);

    const { internal } = await restored.read(f.ref(prepared));
    expect(internal).toMatchObject({ permissionMode: 'ask', requiresSendConfirmation: true });
    expect(() => restored.submit({
      launchId, composeRevision: internal.composeRevision, input: { ...actual, permissionMode: 'full' },
      submission: 'confirmed', shareResult: true,
    })).toThrow('COMPOSE_CHANGED');
    restored.submit({
      launchId, composeRevision: internal.composeRevision, input: actual,
      submission: 'confirmed', shareResult: true,
    });
    await tick();

    expect(f.chat.sendMessage).toHaveBeenCalledOnce();
    expect(f.chat.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'ask',
    }), expect.anything());
  });

  it('applies one sending preference to future clicks without changing accepted runs or requested results', async () => {
    const f = fixture();
    expect(f.service.sites().sendMode).toBe('website');
    const first = f.prepare();
    f.submit(first);
    await tick();

    const draftPreference = f.service.setSendMode({ expectedRevision: 1, sendMode: 'draft' });
    expect(draftPreference.sites[0].revision).toBe(1);
    expect(() => f.service.setSendMode({ expectedRevision: 1, sendMode: 'send' })).toThrow('POLICY_CONFLICT');
    expect(() => f.service.setSendMode({ expectedRevision: 2, sendMode: 'invalid' })).toThrow('INVALID_REQUEST');
    f.finish('ACCEPTED_REPLY');
    expect((await f.service.read(f.ref(first))).receipt.output.text).toBe('ACCEPTED_REPLY');

    const draft = f.prepare({ requestId: 'draft-override', clickSequence: 2 });
    expect(draft.internal).toMatchObject({ effectiveMode: 'draft', requiresSendConfirmation: true });
    expect(() => f.submit(draft)).toThrow('CONFIRMATION_REQUIRED');
    f.service.cancel(f.ref(draft));

    f.service.setSendMode({ expectedRevision: 2, sendMode: 'send' });
    const secondSite = { ...source, origin: 'https://other.example', documentId: 'doc-2' };
    const connected = f.service.writeSite({
      expectedRevision: 3, origin: secondSite.origin, enabled: true, allowSend: true, allowResult: true,
    });
    const stateOnly: WebLaunchInput = { ...input, mode: 'draft', result: 'none' };
    const firstOnSite = f.prepare({
      source: secondSite, requestId: 'connection', input: stateOnly,
      connectionOnly: true, expectedPolicyRevision: connected.revision,
    });
    expect(firstOnSite.internal.requiresSendConfirmation).toBe(true);
    f.service.cancel(f.ref(firstOnSite, secondSite));

    const direct = f.prepare({ source: secondSite, requestId: 'direct-override', clickSequence: 2, input: stateOnly });
    expect(direct.internal).toMatchObject({ effectiveMode: 'send', requiresSendConfirmation: false });
    expect(direct.receipt.output.status).toBe('not-requested');
    f.submit(direct, { shareResult: false });
    await tick();
    expect(f.wire).toHaveBeenCalledTimes(2);
    f.finish('PRIVATE_REPLY');
    expect((await f.service.read(f.ref(direct, secondSite))).receipt.output).toEqual({ status: 'not-requested' });

    f.service.setSendMode({ expectedRevision: connected.revision, sendMode: 'website' });
    const next = f.prepare({ source: secondSite, requestId: 'site-choice', clickSequence: 3, input: stateOnly });
    expect(next.internal).toMatchObject({ effectiveMode: 'draft', requiresSendConfirmation: true });
  });

  it('rejects stale connection consent against the global policy revision without creating a session', () => {
    const f = fixture();
    const captured = f.service.sites().revision;
    f.service.writeSite({ expectedRevision: captured, origin: 'https://another.example', enabled: true, allowSend: false, allowResult: false });
    const state = f.state();
    expect(() => f.prepare({ connectionOnly: true, expectedPolicyRevision: captured })).toThrow('POLICY_CONFLICT');
    expect(f.state()).toEqual(state);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_sessions').get()).toEqual({ count: 0 });
    expect(f.sessionsChanged).not.toHaveBeenCalled();
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
  });

  it('requires a fresh click after the queued task loses its policy generation', () => {
    const f = fixture();
    const captured = f.service.sites().revision;
    f.service.setSendMode({ expectedRevision: captured, sendMode: 'send' });
    expect(() => f.prepare({ expectedQueuedPolicyRevision: captured })).toThrow('POLICY_CONFLICT');
    expect(f.sessionsChanged).not.toHaveBeenCalled();
    expect(f.prepare({ requestId: 'fresh-click', clickSequence: 2,
      expectedQueuedPolicyRevision: f.service.sites().revision })).toMatchObject({
      receipt: { requestId: 'fresh-click' }, internal: { effectiveMode: 'send' },
    });
  });

  it('releases an expired unsent draft when refreshing the window observations', async () => {
    const f = fixture();
    const waiting = f.prepare();
    f.advance(16 * 60_000);
    expect((await f.service.observations()).observations[0].receipt).toMatchObject({
      launchId: waiting.receipt.launchId, request: { status: 'expired' },
      execution: { executionSettled: false },
    });
    expect(f.prepare({ requestId: 'next', clickSequence: 2 }).receipt.requestId).toBe('next');
  });

  it('does not treat connection-only admission as permission to enable a revoked origin', () => {
    const f = fixture();
    f.service.writeSite({ expectedRevision: f.service.sites().revision, origin: source.origin, enabled: false, allowSend: false, allowResult: false });
    const state = f.state();
    expect(() => f.prepare({ connectionOnly: true, expectedPolicyRevision: state.policyRevision })).toThrow('SITE_NOT_ALLOWED');
    expect(f.state()).toEqual(state);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_sessions').get()).toEqual({ count: 0 });
    expect(f.sessionsChanged).not.toHaveBeenCalled();
    expect(f.wire).not.toHaveBeenCalled();
  });

  it('does not reinterpret an existing automatic receipt as a connection-only card', () => {
    const f = fixture();
    f.prepare();
    expect(() => f.prepare({ connectionOnly: true, expectedPolicyRevision: f.service.sites().revision })).toThrow('REQUEST_CONFLICT');
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_sessions').get()).toEqual({ count: 1 });
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
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
    expect(f.sessionsChanged).not.toHaveBeenCalled();
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

  it('starts a new conversation after another tab prunes the expired lease of the still-open page', async () => {
    const f = fixture();
    const first = f.prepare();
    f.submit(first);
    await tick();
    f.finish('FIRST_REPLY');
    expect((await f.service.read(f.ref(first))).receipt.execution.executionSettled).toBe(true);

    f.advance(24 * 60 * 60_000);
    const otherSource = { ...source, tabId: 11, documentId: 'other-document' };
    const other = f.prepare({ source: otherSource });
    expect(f.state().leases[first.internal.documentLeaseId]).toBeUndefined();
    const busyClick = { requestId: 'busy-click', clickSequence: 2 };
    expect(() => f.prepare(busyClick)).toThrow('COMPOSER_BUSY');
    expect(Object.keys(f.state().leases)).toEqual([other.internal.documentLeaseId]);
    f.service.cancel(f.ref(other, otherSource));
    expect(() => f.prepare()).toThrow('EXPIRED');
    expect(() => f.prepare(busyClick)).toThrow('EXPIRED');

    const next = f.prepare({ requestId: 'new-click', clickSequence: 3 });
    expect(next.internal.documentLeaseId).not.toBe(first.internal.documentLeaseId);
    expect(next.internal.threadId).not.toBe(first.internal.threadId);
    await expect(f.service.read(f.ref(first))).rejects.toThrow('EXPIRED');
    f.submit(next);
    await tick();
    expect(f.chat.sendMessage.mock.calls.map(([message]) => message.sessionId)).toEqual([
      first.internal.threadId,
      next.internal.threadId,
    ]);
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

  it('closes an unsent draft when its website connection is revoked', async () => {
    const f = fixture();
    const prepared = f.prepare();

    f.service.writeSite({ expectedRevision: 1, origin: source.origin, enabled: false, allowSend: false, allowResult: false });

    const { observations } = await f.service.observations();
    expect(observations).toContainEqual(expect.objectContaining({ receipt: expect.objectContaining({
      launchId: prepared.receipt.launchId,
      request: { status: 'cancelled' },
      delivery: { status: 'revoked' },
    }) }));
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
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

  it('fences an automatic Full owner when the user revises the same draft to Ask', async () => {
    const f = fixture(); const prepared = f.prepare();
    const downgraded = { prompt: input.prompt, context: input.context, permissionMode: 'ask' };
    expect(() => f.submit(prepared, { input: downgraded })).toThrow('COMPOSE_CHANGED');
    let release!: () => void;
    f.beforeSend = () => new Promise(resolve => { release = resolve; });
    f.submit(prepared); await tick();
    const revised = f.service.revise({ launchId: prepared.receipt.launchId, expectedComposeRevision: 1, input: downgraded });
    release(); await tick();
    expect(f.wire).not.toHaveBeenCalled();
    expect(f.state().receipts[prepared.receipt.launchId].notSent).toBe(true);
    expect(revised.internal).toMatchObject({ permissionMode: 'ask', requiresSendConfirmation: true });
    expect(() => f.submit(revised, { input: downgraded })).toThrow('CONFIRMATION_REQUIRED');
    f.beforeSend = undefined;
    f.submit(revised, { submission: 'confirmed', input: downgraded });
    await tick(); expect(f.wire).toHaveBeenCalledTimes(1);
    expect(f.chat.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      permissionMode: 'ask',
    }), expect.anything());
  });

  it('preserves stop intent before a native ID exists, without issuing an unbound abort', async () => {
    const f = fixture(); const prepared = f.prepare();
    let release!: () => void;
    f.beforeSend = () => new Promise(resolve => { release = resolve; });
    f.submit(prepared); await tick();
    const stopped = await f.service.stop({ launchId: prepared.receipt.launchId });
    expect(stopped.internal).not.toHaveProperty('notSent');
    release(); await tick();
    expect(f.wire).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    expect(f.state().receipts[prepared.receipt.launchId].notSent).toBe(true);
    const { observations } = await f.service.observations();
    expect(observations[0].internal.notSent).toBe(true);
    expect(observations[0].receipt).not.toHaveProperty('notSent');
  });

  it('rejects a delayed confirmed submission or edit after Stop closes the draft', async () => {
    const f = fixture();
    const prepared = f.prepare();
    const { launchId } = prepared.receipt;

    const stopped = await f.service.stop({ launchId });
    expect(stopped.receipt.request.status).toBe('cancelled');
    expect(stopped.internal.notSent).toBe(true);
    expect(() => f.submit(prepared, { submission: 'confirmed' })).toThrow('EXPIRED');
    expect(() => f.service.revise({
      launchId, expectedComposeRevision: prepared.internal.composeRevision,
      input: { prompt: 'A delayed edit', permissionMode: 'ask' },
    })).toThrow('EXPIRED');
    expect(f.state().receipts[launchId].requestStatus).toBe('cancelled');
    expect(f.chat.sendMessage).not.toHaveBeenCalled();

    const restarted = new ChromeWebLaunchService(f.deps);
    services.push(restarted);
    expect(f.state().receipts[launchId].requestStatus).toBe('cancelled');
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
    const stopped = await f.service.stop({ launchId: prepared.receipt.launchId });
    expect(stopped.internal).not.toHaveProperty('notSent');
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

  it.each(['confirmed', 'automatic'] as const)(
    'applies the %s launch confirmation when an earlier run loses its ACK before dispatch',
    async submission => {
      const f = fixture();
      let resolveOldSend!: () => void;
      const oldSend = new Promise<void>(resolve => { resolveOldSend = resolve; });
      f.chat.sendMessage.mockImplementationOnce(async (value, trusted) => {
        trusted.finalSyncAdmission?.(binding);
        f.wire();
        await oldSend;
        return { sessionId: value.sessionId, runId: value.clientTurnId, nativeRunId: value.clientTurnId };
      });
      const first = f.prepare();
      f.submit(first);
      await tick();

      const secondSource = {
        ...source, windowId: 2, windowInstanceId: 'window-2', tabId: 11, documentId: 'doc-2',
      };
      const next = f.prepare({ requestId: 'other-window', source: secondSource });
      expect(next.internal.requiresUnknownConfirmation).toBe(false);
      let releaseNewSend!: () => void;
      f.beforeSend = () => new Promise(resolve => { releaseNewSend = resolve; });
      f.submit(next, { submission, confirmNewTask: true });
      await tick();
      expect(f.wire).toHaveBeenCalledTimes(1);

      resolveOldSend();
      await tick();
      const previous = await f.service.read(f.ref(first));
      expect(previous.receipt.execution).toEqual({ status: 'unknown', executionSettled: false });
      expect(previous.receipt.error?.code).toBe('UNKNOWN_EXECUTION');
      releaseNewSend();
      await tick();

      const current = await f.service.read(f.ref(next, secondSource));
      if (submission === 'confirmed') {
        expect(f.wire).toHaveBeenCalledTimes(2);
        expect(current.receipt.execution).toEqual({ status: 'running', executionSettled: false });
      } else {
        expect(f.wire).toHaveBeenCalledTimes(1);
        expect(current.receipt.execution).toEqual({ status: 'not-started', executionSettled: false });
        expect(current.receipt.error?.code).toBe('UNKNOWN_EXECUTION');
      }
      expect((await f.service.read(f.ref(first))).receipt.execution).toEqual(previous.receipt.execution);
    },
  );

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

  it('returns the exact final result after one confirmed send without granting future automatic return', async () => {
    const f = fixture();
    const policy = f.service.writeSite({ expectedRevision: 1, origin: source.origin, enabled: true, allowSend: true, allowResult: false });
    const prepared = f.prepare();
    expect(() => f.submit(prepared)).toThrow('CONFIRMATION_REQUIRED');
    f.submit(prepared, { submission: 'confirmed' });
    await tick();
    expect(f.wire).toHaveBeenCalledOnce();
    expect(f.service.sites()).toEqual(policy);
    f.finish(undefined, undefined, undefined, ['/private/final-report.pdf']);
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.execution).toEqual({ status: 'completed', executionSettled: true });
    expect(result.receipt.output).toEqual({
      status: 'available', text: 'SYNTHETIC_FINAL', format: 'text',
      artifacts: [{ name: 'final-report.pdf', kind: 'document', mimeType: 'application/pdf' }],
    });
    expect(JSON.stringify(result.receipt)).not.toContain('/private/');
    expect(JSON.stringify(f.state())).not.toContain('SYNTHETIC_FINAL');
    expect(JSON.stringify(f.state())).not.toContain('final-report.pdf');
    expect(JSON.stringify(await f.service.observations())).not.toContain('SYNTHETIC_FINAL');
    expect(JSON.stringify(await f.service.observations())).not.toContain('final-report.pdf');
    const repeated = await f.service.read(f.ref(prepared));
    expect(repeated.receipt.output).toEqual(result.receipt.output);
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
    const access = f.service as unknown as {
      readResult: (id: string) => Promise<Pick<WebLaunchReceipt['output'], 'text' | 'artifacts'> | undefined>;
    };
    vi.spyOn(access, 'readResult').mockImplementation(async () => {
      queueMicrotask(() => f.service.cancel(f.ref(prepared)));
      return { artifacts: [{ name: 'chart.png', kind: 'image' }] };
    });
    const result = await f.service.read(f.ref(prepared));
    expect(result.receipt.output).toEqual({ status: 'withheld' });
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

  it('keeps the exact result of a long run when another click arrives before the first read', async () => {
    const f = fixture();
    const prepared = f.prepare();
    f.submit(prepared);
    await tick();
    f.advance(31 * 60_000);
    f.finish('LONG_RUN_FINAL');
    await tick();

    f.prepare({ requestId: 'next-request', clickSequence: 2 });
    const { receipt } = await f.service.read(f.ref(prepared));

    expect(receipt.execution).toEqual({ status: 'completed', executionSettled: true });
    expect(receipt.output.text).toBe('LONG_RUN_FINAL');
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

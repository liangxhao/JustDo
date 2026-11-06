import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppServerConnection } from '../../appServer/appServerConnection';
import { CliAppServerBinding } from '../../integrations/externalAgent/cliAppServerBinding';
import type { CodexAppServerBackend } from '../../integrations/externalAgent/codexAppServerBackend';
import { ExternalAgentCancelledError } from '../../integrations/externalAgent/externalAgentTypes';
import { BrowserAppServerHub } from './browserAppServerBinding';
import type { BrowserExtensionChatApi } from './browserAppServerTypes';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
  const thread = { id: 'same-wire-id', cwd: process.cwd(), agentId: 'main', modelRef: 'provider/model' };
  const browserThread = {
    ...thread, title: 'Browser conversation', permissionMode: 'auto' as const,
    createdAt: 1_000, updatedAt: 1_000, status: 'running',
  };
  const disposeStream = vi.fn();
  const api: BrowserExtensionChatApi = {
    listSessions: vi.fn(() => [browserThread]),
    getThread: vi.fn(() => browserThread),
    setThreadName: vi.fn((_id, name) => { browserThread.title = name; return browserThread; }),
    getHistory: vi.fn(async () => ({ threadId: thread.id, messages: [], runs: [], identityRevision: 'browser-test' })),
    getModels: vi.fn(async () => [{ id: thread.modelRef, name: 'Browser model', isDefault: true }]),
    startThread: vi.fn(async () => browserThread),
    subscribeThreadEvents: vi.fn(async () => disposeStream),
    getMessages: vi.fn(async () => [{ role: 'user', text: 'Browser input' }]),
    getComposerOptions: vi.fn(async () => ({ modelRef: thread.modelRef,
      models: [{ id: thread.modelRef, name: 'Browser model' }], permissionMode: 'auto' as const })),
    readManagedImage: vi.fn(async () => 'data:image/png;base64,aGVsbG8='),
    getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: true })),
    getTurnState: vi.fn(async () => ({ id: 'browser-turn', status: 'unknown' as const, executionSettled: false })),
    consumeTurnError: vi.fn(() => undefined),
    sendMessage: vi.fn(async request => ({ sessionId: thread.id, runId: request.clientTurnId! })),
    interruptThread: vi.fn(async () => {}),
  };
  let externalName = 'Console conversation';
  const describeExternal = () => ({ ...thread, name: externalName, createdAt: 1000, updatedAt: 1000,
    permissionMode: 'full' as const, status: 'completed' as const });
  const backend: CodexAppServerBackend = {
    models: vi.fn(() => [{ id: 'provider/model', name: 'Configured', isDefault: true }]),
    start: vi.fn(async () => thread),
    resume: vi.fn(async () => thread),
    describe: vi.fn(describeExternal),
    list: vi.fn(() => [describeExternal()]),
    setName: vi.fn((_id, name) => { externalName = name; }),
    history: vi.fn(async () => ({ threadId: thread.id, messages: [], runs: [], identityRevision: 'external-test' })),
    run: vi.fn(async () => 'Console answer'),
  };
  const hub = new BrowserAppServerHub(api, 'test-version');
  hub.activate();
  cleanup.push(() => hub.stop());
  const connect = (browser: boolean) => {
    const output: Array<Record<string, unknown>> = [];
    const connection = new AppServerConnection(
      context => browser ? hub.connect(context) : new CliAppServerBinding(backend, context),
      value => output.push(value as Record<string, unknown>),
    );
    cleanup.push(() => connection.close());
    const request = async (method: string, params = {}) => {
      const id = output.length + 1;
      await connection.receive({ id, method, params });
      return output.findLast(value => value.id === id)!;
    };
    const initialize = async () => {
      await request('initialize', {
        clientInfo: { name: 'chrome-extension', version: 'untrusted' },
        capabilities: { browser: true },
      });
      await connection.receive({ method: 'initialized' });
    };
    return { connection, output, request, initialize };
  };
  return { connect, api, backend, thread, disposeStream };
}

describe.each([true, false])('real app-server binding through the shared engine (browser: %s)', browser => {
  it('validates the same handshake and request envelope before either domain can run work', async () => {
    const h = fixture();
    const peer = h.connect(browser);
    expect(await peer.request('thread/start')).toMatchObject({ error: { code: -32600 } });
    expect(await peer.request('initialize', { clientInfo: { name: 'client' } }))
      .toMatchObject({ error: { code: -32602 } });
    await peer.initialize();
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1, false]) {
      await peer.connection.receive({ id, method: 'thread/start', params: {} });
      expect(peer.output.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
    }
    for (const params of [null, [], 'message']) {
      await peer.connection.receive({ id: 'bad-params', method: 'turn/start', params });
      expect(peer.output.at(-1)).toMatchObject({ id: 'bad-params', error: { code: -32600 } });
    }
    await peer.connection.receive({ method: 'thread/start', params: {} });
    await peer.connection.receive({ method: 'turn/start', params: {} });
    expect(h.api.startThread).not.toHaveBeenCalled();
    expect(h.backend.start).not.toHaveBeenCalled();
    expect(h.api.sendMessage).not.toHaveBeenCalled();
    expect(h.backend.run).not.toHaveBeenCalled();
    expect(await peer.request('unsupported/method')).toMatchObject({ error: { code: -32601 } });
  });

  it('routes the same standard text input while preserving endpoint-specific execution', async () => {
    const h = fixture();
    const peer = h.connect(browser);
    await peer.initialize();
    expect(await peer.request('thread/start', browser ? {} : { cwd: h.thread.cwd }))
      .toMatchObject({ result: { thread: { id: h.thread.id, cwd: h.thread.cwd } } });
    const params = { threadId: h.thread.id, input: [{ type: 'text', text: 'Shared input' }] };
    expect(await peer.request('turn/start', params)).toHaveProperty('result.turn');
    await tick();
    if (browser) {
      expect(h.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Shared input',
      }), expect.objectContaining({ assertCurrent: expect.any(Function) }));
      expect(h.backend.run).not.toHaveBeenCalled();
    } else {
      expect(h.backend.start).toHaveBeenCalledExactlyOnceWith({ cwd: h.thread.cwd, model: undefined });
      expect(h.backend.run).toHaveBeenCalledWith(
        h.thread, expect.any(String), 'Shared input', expect.any(Function), expect.any(AbortSignal), {},
      );
      expect(h.api.sendMessage).not.toHaveBeenCalled();
    }
  });

  it('routes standard models, metadata and names to the selected binding without reading history', async () => {
    const h = fixture();
    const peer = h.connect(browser);
    await peer.initialize();
    expect(await peer.request('model/list')).toMatchObject({ result: { data: [{ id: h.thread.modelRef }] } });
    expect(await peer.request('thread/list')).toMatchObject({ result: { data: [{ id: h.thread.id }] } });
    expect(await peer.request('thread/read', { threadId: h.thread.id }))
      .toMatchObject({ result: { thread: { id: h.thread.id, turns: [] } } });
    expect(h.api.getHistory).not.toHaveBeenCalled();
    expect(h.backend.history).not.toHaveBeenCalled();
    expect(await peer.request('thread/name/set', { threadId: h.thread.id, name: 'Updated title' }))
      .toHaveProperty('result');
    expect(await peer.request('thread/read', { threadId: h.thread.id }))
      .toMatchObject({ result: { thread: { name: 'Updated title' } } });
    if (browser) {
      expect(h.api.getModels).toHaveBeenCalledOnce();
      expect(h.api.setThreadName).toHaveBeenCalledExactlyOnceWith(h.thread.id, 'Updated title');
      expect(h.backend.models).not.toHaveBeenCalled();
      expect(h.backend.setName).not.toHaveBeenCalled();
    } else {
      expect(h.backend.models).toHaveBeenCalledOnce();
      expect(h.backend.setName).toHaveBeenCalledExactlyOnceWith(h.thread.id, 'Updated title');
      expect(h.api.getModels).not.toHaveBeenCalled();
      expect(h.api.setThreadName).not.toHaveBeenCalled();
    }
  });
});

it('does not mix capabilities or same-ID execution ownership between browser and console bindings', async () => {
  const h = fixture();
  const browser = h.connect(true);
  const consolePeer = h.connect(false);
  await browser.initialize();
  await consolePeer.initialize();
  expect(await browser.request('thread/list')).toHaveProperty('result.data');
  for (const method of ['browser/thread/image', 'browser/composer/options', 'browser/extension/pair'])
    expect(await consolePeer.request(method, { threadId: h.thread.id })).toHaveProperty('error');
  expect(await consolePeer.request('thread/read', { threadId: h.thread.id }))
    .toMatchObject({ result: { thread: { name: 'Console conversation', turns: [] } } });
  expect(h.api.getMessages).not.toHaveBeenCalled();
  expect(h.api.getComposerOptions).not.toHaveBeenCalled();
  expect(h.backend.models).not.toHaveBeenCalled();

  let consoleSignal!: AbortSignal;
  h.backend.run = vi.fn((_thread, _run, _text, _notify, signal) => new Promise((_resolve, reject) => {
    consoleSignal = signal;
    signal.addEventListener('abort', () => reject(new ExternalAgentCancelledError('Confirmed cancellation')));
  }));
  await consolePeer.request('thread/start');
  await consolePeer.request('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'Console input' }] });
  await tick();
  await browser.request('thread/resume', { threadId: h.thread.id, excludeTurns: true });
  await browser.connection.close();
  expect(consoleSignal.aborted).toBe(false);
  expect(h.api.interruptThread).not.toHaveBeenCalled();
  expect(h.disposeStream).toHaveBeenCalledOnce();
  await consolePeer.connection.close();
  expect(consoleSignal.aborted).toBe(true);
  expect(h.api.interruptThread).not.toHaveBeenCalled();
  const replacement = h.connect(true);
  await replacement.initialize();
  expect(await replacement.request('thread/read', { threadId: h.thread.id })).toMatchObject({
    result: { thread: { browser: { activeTurn: {
      id: 'browser-turn', status: 'unknown', executionSettled: false,
    } } } },
  });
  expect(h.api.sendMessage).not.toHaveBeenCalled();
  expect(h.backend.run).toHaveBeenCalledOnce();
});

it('exposes browser-only image and composer routes under their explicit namespace without legacy aliases', async () => {
  const h = fixture();
  const browser = h.connect(true);
  const external = h.connect(false);
  await browser.initialize();
  await external.initialize();
  for (const peer of [browser, external]) {
    for (const method of ['thread/image', 'composer/options'])
      expect(await peer.request(method, { threadId: h.thread.id }))
        .toMatchObject({ error: { code: -32601 } });
  }
  expect(h.api.getComposerOptions).not.toHaveBeenCalled();
  expect(h.api.readManagedImage).not.toHaveBeenCalled();
  expect(await browser.request('browser/composer/options', { threadId: h.thread.id }))
    .toMatchObject({ result: { modelRef: h.thread.modelRef, permissionMode: 'auto' } });
  expect(await browser.request('browser/thread/image', { threadId: h.thread.id, source: 'media:approved' }))
    .toMatchObject({ result: { dataUrl: 'data:image/png;base64,aGVsbG8=' } });
  for (const method of ['browser/composer/options', 'browser/thread/image'])
    expect(await external.request(method, { threadId: h.thread.id }))
      .toMatchObject({ error: { code: -32601 } });
  expect(h.api.getComposerOptions).toHaveBeenCalledOnce();
  expect(h.api.readManagedImage).toHaveBeenCalledOnce();
});

it('rejects browser turn extensions on the native entry before dispatch, including an empty browser object', async () => {
  const h = fixture();
  const external = h.connect(false);
  await external.initialize();
  await external.request('thread/start');
  for (const browser of [{}, { pageContext: { url: 'https://internal.example/' } }]) {
    expect(await external.request('turn/start', {
      threadId: h.thread.id, input: [{ type: 'text', text: 'Must not send' }], browser,
    })).toMatchObject({ error: { code: -32602 } });
  }
  expect(h.backend.run).not.toHaveBeenCalled();
  expect(h.api.sendMessage).not.toHaveBeenCalled();
});

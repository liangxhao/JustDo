import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserAppServerHub } from '../browser/extension/browserAppServerBinding';
import type { BrowserExtensionChatApi } from '../browser/extension/browserAppServerTypes';
import { CliAppServerBinding } from '../integrations/externalAgent/cliAppServerBinding';
import type { CodexAppServerBackend } from '../integrations/externalAgent/codexAppServerBackend';
import { ExternalAgentCancelledError } from '../integrations/externalAgent/externalAgentTypes';
import { AppServerConnection } from './appServerConnection';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
  const thread = { id: 'same-wire-id', cwd: process.cwd(), agentId: 'main' };
  const browserThread = {
    ...thread, title: 'Browser conversation', permissionMode: 'auto' as const,
    createdAt: 1_000, updatedAt: 1_000, status: 'running',
  };
  const disposeStream = vi.fn();
  const api: BrowserExtensionChatApi = {
    listSessions: vi.fn(() => [browserThread]),
    startThread: vi.fn(async () => browserThread),
    subscribeThreadEvents: vi.fn(async () => disposeStream),
    getMessages: vi.fn(async () => [{ role: 'user', text: 'Browser input' }]),
    getComposerOptions: vi.fn(async () => ({ models: [], permissionMode: 'auto' as const })),
    getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: true })),
    getTurnState: vi.fn(async () => ({ id: 'browser-turn', status: 'unknown' as const, executionSettled: false })),
    consumeTurnError: vi.fn(() => undefined),
    sendMessage: vi.fn(async () => ({ sessionId: thread.id, runId: 'browser-turn' })),
    interruptThread: vi.fn(async () => {}),
  };
  const backend: CodexAppServerBackend = {
    models: vi.fn(() => [{ id: 'provider/model', name: 'Configured', isDefault: true }]),
    start: vi.fn(async () => thread),
    resume: vi.fn(async () => thread),
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
      await request('initialize', { clientInfo: { name: 'untrusted caller' } });
      if (browser) await connection.receive({ method: 'initialized' });
    };
    return { connection, output, request, initialize };
  };
  return { connect, api, backend, thread, disposeStream };
}

describe.each([true, false])('real app-server binding through the shared engine (browser: %s)', browser => {
  it('routes create and start through the same protocol while preserving endpoint-specific input', async () => {
    const h = fixture();
    const peer = h.connect(browser);
    await peer.initialize();
    expect(await peer.request('thread/start', browser ? { title: 'Browser title' } : { cwd: h.thread.cwd }))
      .toMatchObject({ result: { thread: { id: h.thread.id, cwd: h.thread.cwd } } });
    const params = browser
      ? { threadId: h.thread.id, message: 'Browser input', pageContext: { url: 'https://internal.example/' } }
      : { threadId: h.thread.id, input: [{ type: 'text', text: 'Console input' }] };
    expect(await peer.request('turn/start', params)).toHaveProperty('result.turn');
    await tick();
    if (browser) {
      expect(h.api.startThread).toHaveBeenCalledExactlyOnceWith('Browser title');
      expect(h.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Browser input', pageContext: { url: 'https://internal.example/' },
      }));
      expect(h.backend.run).not.toHaveBeenCalled();
    } else {
      expect(h.backend.start).toHaveBeenCalledExactlyOnceWith({ cwd: h.thread.cwd, model: undefined });
      expect(h.backend.run).toHaveBeenCalledWith(
        h.thread, expect.any(String), 'Console input', expect.any(Function), expect.any(AbortSignal),
      );
      expect(h.api.sendMessage).not.toHaveBeenCalled();
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
  for (const method of ['thread/list', 'thread/read', 'thread/image', 'composer/options', 'browser/extension/pair'])
    expect(await consolePeer.request(method, { threadId: h.thread.id })).toHaveProperty('error');
  for (const method of ['thread/resume', 'model/list', 'thread/name/set'])
    expect(await browser.request(method, { threadId: h.thread.id })).toHaveProperty('error');
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
  await browser.request('thread/read', { threadId: h.thread.id });
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
    result: { activeTurn: { id: 'browser-turn', status: 'unknown', executionSettled: false } },
  });
  expect(h.api.sendMessage).not.toHaveBeenCalled();
  expect(h.backend.run).toHaveBeenCalledOnce();
});

import { describe, expect, it, vi } from 'vitest';

import { AppServerConnection } from './appServerConnection';
import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerNotificationMethod,
} from './appServerProtocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function fixture(strict = true) {
  const output: Array<Record<string, unknown>> = [];
  let context!: AppServerConnectionContext;
  const binding: AppServerBinding = {
    initialization: {
      result: { userAgent: 'configured endpoint', platformOs: 'win32' },
      requireInitializedNotification: strict,
      executeNotifications: strict,
      errorStyle: strict ? 'standard' : 'console',
    },
    threads: { start: vi.fn(async () => ({ thread: { id: 'owned', cwd: '/task' } })) },
    turns: { start: vi.fn(async () => ({ turn: { id: 'turn' } })), interrupt: vi.fn(() => ({})) },
    onDisconnect: vi.fn(),
  };
  const session = new AppServerConnection(value => {
    context = value;
    return binding;
  }, value => output.push(value as Record<string, unknown>));
  const request = (method: string, params = {}, id: string | number = output.length + 1) =>
    session.receive({ id, method, params });
  const initialize = async (params = {}) => {
    await request('initialize', params);
    if (strict) await session.receive({ method: 'initialized' });
  };
  return { session, binding, output, request, initialize, get context() { return context; } };
}

describe.each([true, false])('shared app-server connection (strict handshake: %s)', strict => {
  it('rejects malformed raw frames and IDs without invoking operations', async () => {
    const h = fixture(strict);
    await h.session.receiveRaw('{broken');
    expect(h.output.pop()).toMatchObject({ id: null, error: { code: -32700 } });
    for (const payload of [null, [], { id: {} }, { id: null, method: 'thread/start' },
      { id: Number.NaN, method: 'thread/start' }, { id: 1 }]) {
      await h.session.receive(payload);
      expect(h.output.pop()).toMatchObject({ id: null, error: { code: -32600 } });
    }
    expect(h.binding.threads.start).not.toHaveBeenCalled();
  });

  it('uses the configured capabilities without trusting clientInfo or requested capabilities', async () => {
    const h = fixture(strict);
    await h.initialize({
      clientInfo: { name: 'browser-extension', title: 'privileged client' },
      capabilities: { experimentalApi: true, browserPairing: true, threadList: true },
    });
    for (const method of ['thread/list', 'thread/read', 'thread/image', 'composer/options',
      'browser/extension/pair', 'thread/resume', 'model/list', 'thread/unsubscribe', 'thread/name/set']) {
      await h.request(method);
      expect(h.output.pop()).toMatchObject({ error: { code: strict ? -32601 : -32000 } });
    }
    expect(h.binding.threads.start).not.toHaveBeenCalled();
    await h.request('thread/start');
    expect(h.output.pop()).toMatchObject({ result: { thread: { id: 'owned' } } });
  });

  it('does not let a pending start block an interrupt', async () => {
    const h = fixture(strict);
    const pending = deferred<Record<string, unknown>>();
    h.binding.turns.start = vi.fn(() => pending.promise);
    await h.initialize();
    const starting = h.request('turn/start', {}, 'start');
    await h.request('turn/interrupt', { threadId: 'owned', turnId: 'turn' }, 'stop');
    expect(h.binding.turns.interrupt).toHaveBeenCalledExactlyOnceWith({ threadId: 'owned', turnId: 'turn' });
    expect(h.output.at(-1)).toEqual({ id: 'stop', result: {} });
    pending.resolve({ turn: { id: 'turn' } });
    await starting;
    expect(h.output.at(-1)).toEqual({ id: 'start', result: { turn: { id: 'turn' } } });
  });

  it('filters exact notification names and keeps responses independent of notification preferences', async () => {
    const h = fixture(strict);
    await h.initialize({ capabilities: { optOutNotificationMethods: ['turn/started', 'item/*', null] } });
    const count = h.output.length;
    h.context.notify(AppServerNotificationMethod.TurnStarted, { turnId: 'turn' });
    expect(h.output).toHaveLength(count);
    h.context.notify(AppServerNotificationMethod.ItemStarted, { item: { id: 'item' } });
    expect(h.output.at(-1)).toEqual({ method: 'item/started', params: { item: { id: 'item' } } });
    await h.request('turn/start', {}, 'start');
    expect(h.output.at(-1)).toMatchObject({ id: 'start', result: { turn: { id: 'turn' } } });
  });

  it('closes once, forwards the exact reason and discards pending replies and later notifications', async () => {
    const h = fixture(strict);
    const pending = deferred<Record<string, unknown>>();
    h.binding.threads.start = vi.fn(() => pending.promise);
    await h.initialize();
    const starting = h.request('thread/start');
    const reason = new Error('Transport lost');
    const closed = h.session.close(reason);
    expect(h.context.isClosed()).toBe(true);
    expect(h.session.close(new Error('Later close'))).toBe(closed);
    await closed;
    expect(h.binding.onDisconnect).toHaveBeenCalledExactlyOnceWith(reason);
    const count = h.output.length;
    pending.resolve({ thread: { id: 'late' } });
    await starting;
    h.context.notify(AppServerNotificationMethod.TurnCompleted, {});
    await h.session.receiveRaw('invalid');
    await h.request('thread/start');
    expect(h.output).toHaveLength(count);
    expect(h.binding.threads.start).toHaveBeenCalledOnce();
  });
});

it('requires Chrome initialized notification and rejects duplicate initialize', async () => {
  const h = fixture();
  await h.session.receive({ method: 'initialized' });
  await h.request('thread/start');
  expect(h.output.pop()).toMatchObject({ error: { code: -32002 } });
  await h.request('initialize');
  expect(h.output.at(-1)).toMatchObject({ result: { userAgent: 'configured endpoint' } });
  await h.request('thread/start');
  expect(h.output.pop()).toMatchObject({ error: { code: -32002 } });
  await h.request('initialize');
  expect(h.output.pop()).toMatchObject({ error: { code: -32600 } });
  await h.session.receive({ method: 'initialized' });
  await h.request('thread/start');
  expect(h.binding.threads.start).toHaveBeenCalledOnce();
});

it('preserves explicitly unsent versus uncertain Chrome turn errors', async () => {
  const h = fixture();
  await h.initialize();
  for (const [error, requestSent] of [
    [Object.assign(new Error('Rejected before dispatch'), { requestSent: false }), false],
    [new Error('Acceptance unknown'), true],
  ] as const) {
    h.binding.turns.start = vi.fn(() => { throw error; });
    await h.request('turn/start');
    expect(h.output.pop()).toMatchObject({ error: { code: -32603, data: { requestSent } } });
  }
});

it('executes Chrome notifications without responses and keeps console notifications side effect free', async () => {
  for (const strict of [true, false]) {
    const h = fixture(strict);
    await h.initialize();
    const count = h.output.length;
    await h.session.receive({ method: 'thread/start' });
    expect(h.binding.threads.start).toHaveBeenCalledTimes(strict ? 1 : 0);
    expect(h.output).toHaveLength(count);
    h.binding.turns.start = vi.fn(() => { throw new Error('Notification failure'); });
    await h.session.receive({ method: 'turn/start' });
    expect(h.output).toHaveLength(count);
  }
});

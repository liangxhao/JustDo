import { describe, expect, it, vi } from 'vitest';

import { AppServerConnection } from './appServerConnection';
import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerErrorCode,
  AppServerErrorStyle,
  AppServerMethod,
  AppServerNotificationMethod,
  AppServerRequestMethod,
  AppServerRpcError,
} from './appServerProtocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function fixture(
  strict = true,
  errorStyle: AppServerBinding['initialization']['errorStyle'] = strict ? 'standard' : 'console',
) {
  const output: Array<Record<string, unknown>> = [];
  let context!: AppServerConnectionContext;
  const binding: AppServerBinding = {
    initialization: {
      result: { userAgent: 'configured endpoint', platformOs: 'win32' },
      requireInitializedNotification: strict,
      executeNotifications: strict && errorStyle !== AppServerErrorStyle.Codex,
      errorStyle,
    },
    threads: { start: vi.fn(async () => ({ thread: { id: 'owned', cwd: '/task' } })) },
    turns: { start: vi.fn(async () => ({ turn: { id: 'turn' } })), interrupt: vi.fn(() => ({})) },
    onDisconnect: vi.fn(),
  };
  const send = vi.fn((value: unknown) => output.push(value as Record<string, unknown>));
  const session = new AppServerConnection(value => {
    context = value;
    return binding;
  }, send);
  const request = (method: string, params = {}, id: string | number = output.length + 1) =>
    session.receive({ id, method, params });
  const initialize = async (params = errorStyle === AppServerErrorStyle.Codex
    ? { clientInfo: { name: 'protocol-test', version: '1' } }
    : {}) => {
    await request('initialize', params);
    if (strict) await session.receive({ method: 'initialized' });
  };
  return { session, binding, output, send, request, initialize, get context() { return context; } };
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
      clientInfo: { name: 'caller', title: 'privileged client' },
      capabilities: { experimentalApi: true, extraRoutes: true, threadList: true },
    });
    for (const method of ['thread/list', 'thread/read', 'extension/read', 'thread/resume', 'model/list', 'thread/unsubscribe', 'thread/name/set']) {
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

describe('server-owned extension routes', () => {
  it('routes only exact own function entries after the standard handshake', async () => {
    const h = fixture(true, AppServerErrorStyle.Codex);
    const read = vi.fn(() => ({ value: 'owned' }));
    const inherited = vi.fn(() => ({ value: 'inherited' }));
    const extensions = Object.create({ 'extension/inherited': inherited }) as Record<string, unknown>;
    extensions['extension/read'] = read;
    extensions['extension/invalid'] = { value: 'not an operation' };
    h.binding.extensions = extensions as AppServerBinding['extensions'];
    await h.request('extension/read');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32600 } });
    expect(read).not.toHaveBeenCalled();
    await h.initialize();
    await h.request('extension/read', { key: 'entry' });
    expect(read).toHaveBeenCalledExactlyOnceWith({ key: 'entry' });
    expect(h.output.at(-1)).toMatchObject({ result: { value: 'owned' } });
    for (const method of ['extension/read/extra', 'extension/inherited', 'extension/invalid', 'toString']) {
      await h.request(method);
      expect(h.output.at(-1)).toMatchObject({ error: { code: -32601 } });
    }
    expect(inherited).not.toHaveBeenCalled();
  });

  it('cannot install extensions through client declarations or replace standard routes', async () => {
    const h = fixture(true, AppServerErrorStyle.Codex);
    const override = vi.fn(() => ({ replaced: true }));
    h.binding.extensions = Object.fromEntries(Object.values(AppServerMethod).map(method => [method, override]));
    await h.initialize({ clientInfo: { name: 'privileged caller', version: '1' },
      capabilities: { experimentalApi: true, extensions: { 'extension/read': true } } });
    expect(h.output.at(-1)).toHaveProperty('result.userAgent', 'configured endpoint');
    await h.request('thread/start');
    expect(h.binding.threads.start).toHaveBeenCalledOnce();
    for (const method of ['model/list', 'thread/read', 'thread/loaded/list', 'initialized', 'extension/read']) {
      await h.request(method);
      expect(h.output.at(-1)).toMatchObject({ error: { code: -32601 } });
    }
    await h.request('initialize');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32600 } });
    expect(override).not.toHaveBeenCalled();
  });

  it.each([AppServerErrorStyle.Standard, AppServerErrorStyle.Console, AppServerErrorStyle.Codex])(
    'requires a request ID independently of the configured core notification policy: %s', async style => {
      const h = fixture(true, style);
      const execute = vi.fn(() => ({ accepted: true }));
      h.binding.extensions = { 'extension/execute': execute };
      await h.initialize();
      const before = h.output.length;
      await h.session.receive({ method: 'extension/execute', params: {} });
      expect(execute).not.toHaveBeenCalled();
      expect(h.output).toHaveLength(before);
      await h.request('extension/execute', { value: 1 });
      expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 1 });
      expect(h.output.at(-1)).toHaveProperty('result.accepted', true);
    },
  );

  it('filters extension notifications by exact name while keeping request responses independent', async () => {
    const h = fixture(true, AppServerErrorStyle.Codex);
    h.binding.extensions = { 'extension/refresh': () => ({ value: 'current' }) };
    await h.initialize({ clientInfo: { name: 'client', version: '1' },
      capabilities: { optOutNotificationMethods: ['extension/changed', 'extension/refresh', 'extension/*'] } });
    const before = h.output.length;
    h.context.notify('extension/changed', { value: 'hidden' });
    expect(h.output).toHaveLength(before);
    h.context.notify('extension/changed/detail', { value: 'visible' });
    expect(h.output.at(-1)).toEqual({ method: 'extension/changed/detail', params: { value: 'visible' } });
    await h.request('extension/refresh');
    expect(h.output.at(-1)).toHaveProperty('result.value', 'current');
  });

  it('publishes only explicit typed public error data', async () => {
    const h = fixture(true, AppServerErrorStyle.Codex);
    h.binding.extensions = { 'extension/read': () => {
      throw new AppServerRpcError(AppServerErrorCode.Internal, 'UNAVAILABLE', {
        code: 'UNAVAILABLE', messageKey: 'extensionUnavailable',
      });
    } };
    await h.initialize();
    await h.request('extension/read');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32603, message: 'UNAVAILABLE',
      data: { code: 'UNAVAILABLE', messageKey: 'extensionUnavailable' } } });
    h.binding.extensions = { 'extension/read': () => {
      throw Object.assign(new Error('Service failed.'), {
        data: { privateContext: 'must stay internal' }, publicError: { privateContext: 'must stay internal' },
      });
    } };
    await h.request('extension/read');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32000, message: 'Service failed.' } });
    expect(h.output.at(-1)).not.toHaveProperty('error.data');
  });

  it('preserves typed data and gives an explicit turn-send flag precedence over conflicting metadata', async () => {
    const h = fixture(true, AppServerErrorStyle.Codex);
    h.binding.turns.start = () => {
      throw Object.assign(new AppServerRpcError(AppServerErrorCode.InvalidParams, 'Invalid input.', {
        code: 'INVALID_INPUT', requestSent: false,
      }), { requestSent: true });
    };
    await h.initialize();
    await h.request('turn/start');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32602,
      data: { code: 'INVALID_INPUT', requestSent: true } } });
  });
});

it('requires the configured initialized notification and rejects duplicate initialize', async () => {
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

it.each([AppServerErrorStyle.Standard, AppServerErrorStyle.Console, AppServerErrorStyle.Codex])(
  'preserves only explicit turn send certainty independently of error policy: %s', async style => {
    const h = fixture(true, style);
    await h.initialize();
    for (const [error, requestSent] of [
      [Object.assign(new Error('Rejected before dispatch'), { requestSent: false }), false],
      [Object.assign(new Error('Accepted before output failure'), { requestSent: true }), true],
    ] as const) {
      h.binding.turns.start = vi.fn(() => { throw error; });
      await h.request('turn/start');
      expect(h.output.pop()).toMatchObject({
        error: { code: style === AppServerErrorStyle.Standard ? -32603 : -32000, data: { requestSent } },
      });
    }
    for (const error of [new Error('Acceptance unknown'),
      new AppServerRpcError(AppServerErrorCode.InvalidParams, 'Invalid input.'),
      Object.assign(new Error('Invalid certainty flag'), { requestSent: 'false' })]) {
      h.binding.turns.start = vi.fn(() => { throw error; });
      await h.request('turn/start');
      expect(h.output.pop()).not.toHaveProperty('error.data');
    }
    h.binding.threads.start = vi.fn(() => {
      throw Object.assign(new Error('Not a turn send'), { requestSent: false });
    });
    await h.request('thread/start');
    expect(h.output.pop()).not.toHaveProperty('error.data');
  },
);

it('preserves legacy notification policies independently of the Codex policy', async () => {
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

describe('Codex client policy', () => {
  const create = () => fixture(true, AppServerErrorStyle.Codex);

  it('commits initialize state only after validation and waits for initialized', async () => {
    const h = create();
    await h.session.receive({ method: 'initialized' });
    await h.request('thread/start');
    expect(h.output.pop()).toMatchObject({ error: { code: -32600 } });
    await h.request('initialize', {
      clientInfo: { name: 'client' },
      capabilities: { optOutNotificationMethods: ['thread/name/updated'] },
    });
    expect(h.output.pop()).toMatchObject({ error: { code: -32602 } });
    await h.session.receive({ method: 'initialized' });
    await h.request('thread/start');
    expect(h.output.pop()).toMatchObject({ error: { code: -32600 } });

    await h.request('initialize', { clientInfo: { name: 'client', version: '1' } });
    expect(h.output.at(-1)).toHaveProperty('result');
    await h.request('thread/start');
    expect(h.output.pop()).toMatchObject({ error: { code: -32600 } });
    await h.request('initialize', { clientInfo: { name: 'client', version: '2' } });
    expect(h.output.pop()).toMatchObject({ error: { code: -32600 } });
    await h.session.receive({ method: 'initialized' });
    await h.request('thread/start');
    expect(h.binding.threads.start).toHaveBeenCalledOnce();
    h.context.notify(AppServerNotificationMethod.ThreadNameUpdated, {
      threadId: 'owned', threadName: 'Updated',
    });
    expect(h.output.at(-1)).toMatchObject({ method: 'thread/name/updated' });
  });

  it.each([
    { clientInfo: undefined },
    { clientInfo: null },
    { clientInfo: { name: 'client' } },
    { clientInfo: { name: 1, version: '1' } },
    { clientInfo: { name: 'client', version: 1 } },
    { clientInfo: { name: 'bad\rname', version: '1' } },
    { clientInfo: { name: 'client', version: '1', title: 1 } },
    { capabilities: [] },
    { capabilities: { experimentalApi: 'true' } },
    { capabilities: { requestAttestation: null } },
    { capabilities: { explicitGatewayOauth: 1 } },
    { capabilities: { mcpServerOpenaiFormElicitation: [] } },
    { capabilities: { optOutNotificationMethods: 'turn/completed' } },
    { capabilities: { optOutNotificationMethods: ['turn/completed', null] } },
    { capabilities: { extensions: [] } },
  ])('rejects malformed initialize fields without granting capabilities: %j', async invalid => {
    const h = create();
    await h.request('initialize', {
      clientInfo: { name: 'client', version: '1' },
      ...invalid,
    });
    expect(h.output.pop()).toMatchObject({ error: { code: -32602 } });
    await h.request('thread/start');
    expect(h.binding.threads.start).not.toHaveBeenCalled();
  });

  it('accepts typed capabilities but does not expand the server binding', async () => {
    const h = create();
    await h.initialize({
      clientInfo: { name: 'client', version: '1', title: null },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        explicitGatewayOauth: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: ['thread/status/changed', 'thread/*'],
        extensions: { example: { enabled: true } },
        threadList: true,
      },
    });
    await h.request('thread/list');
    expect(h.output.pop()).toMatchObject({ error: { code: -32601 } });
    const count = h.output.length;
    h.context.notify(AppServerNotificationMethod.ThreadStatusChanged, { threadId: 'owned' });
    expect(h.output).toHaveLength(count);
    h.context.notify(AppServerNotificationMethod.ThreadNameUpdated, { threadId: 'owned' });
    expect(h.output.at(-1)).toMatchObject({ method: 'thread/name/updated' });
  });

  it('accepts absent or null optional initialize fields', async () => {
    const h = create();
    await h.initialize({ clientInfo: { name: 'client', version: '1' }, capabilities: null });
    await h.request('thread/start');
    expect(h.binding.threads.start).toHaveBeenCalledOnce();
  });

  it('accepts empty client name and version strings allowed by the official schema', async () => {
    const h = create();
    await h.initialize({ clientInfo: { name: '', version: '' } });
    await h.request('thread/start');
    expect(h.binding.threads.start).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}])('accepts initialized notification params: %j', async params => {
    const h = create();
    await h.request('initialize', { clientInfo: { name: 'client', version: '1' } });
    await h.session.receive({ method: 'initialized', ...(params === undefined ? {} : { params }) });
    await h.request('thread/start');
    expect(h.binding.threads.start).toHaveBeenCalledOnce();
  });

  it('rejects unsafe numeric IDs and non-object params before dispatch', async () => {
    const h = create();
    await h.initialize();
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await h.session.receive({ id, method: 'thread/start', params: {} });
      expect(h.output.pop()).toMatchObject({ id: null, error: { code: -32600 } });
    }
    for (const params of [null, [], 'text', 1]) {
      await h.session.receive({ id: 'malformed', method: 'thread/start', params });
      expect(h.output.pop()).toMatchObject({ id: 'malformed', error: { code: -32600 } });
    }
    expect(h.binding.threads.start).not.toHaveBeenCalled();
    await h.session.receive({ id: 'valid', method: 'thread/start' });
    expect(h.binding.threads.start).toHaveBeenCalledExactlyOnceWith({});
  });

  it('does not execute business notifications and routes loaded-list only when bound', async () => {
    const h = create();
    await h.initialize();
    const count = h.output.length;
    await h.session.receive({ method: 'thread/start', params: {} });
    expect(h.output).toHaveLength(count);
    expect(h.binding.threads.start).not.toHaveBeenCalled();
    await h.request('thread/loaded/list');
    expect(h.output.pop()).toMatchObject({ error: { code: -32601 } });
    h.binding.threads.loadedList = vi.fn(() => ({ data: ['owned'], nextCursor: null }));
    await h.request('thread/loaded/list', { limit: 1 });
    expect(h.binding.threads.loadedList).toHaveBeenCalledExactlyOnceWith({ limit: 1 });
    expect(h.output.pop()).toMatchObject({ result: { data: ['owned'], nextCursor: null } });
  });

  it('preserves typed protocol errors and classifies other business failures conservatively', async () => {
    const h = create();
    await h.initialize();
    h.binding.turns.start = vi.fn(() => {
      throw new AppServerRpcError(AppServerErrorCode.InvalidParams, 'Unsupported input.');
    });
    await h.request('turn/start');
    expect(h.output.pop()).toMatchObject({ error: { code: -32602, message: 'Unsupported input.' } });
    h.binding.turns.start = vi.fn(() => { throw new Error('Backend admission failed.'); });
    await h.request('turn/start');
    expect(h.output.pop()).toMatchObject({ error: { code: -32000, message: 'Backend admission failed.' } });
  });
});

it('preserves legacy Standard params coercion and numeric IDs', async () => {
  const h = fixture();
  await h.initialize();
  await h.session.receive({ id: 1.5, method: 'thread/start', params: [] });
  expect(h.binding.threads.start).toHaveBeenCalledExactlyOnceWith({});
  expect(h.output.at(-1)).toMatchObject({ id: 1.5, result: { thread: { id: 'owned' } } });
  h.binding.turns.start = vi.fn(() => {
    throw new AppServerRpcError(AppServerErrorCode.InvalidParams, 'Invalid input.');
  });
  await h.request('turn/start');
  const response = h.output.pop();
  expect(response).toMatchObject({
    error: { code: -32603 },
  });
  expect(response).not.toHaveProperty('error.data');
});

it('retires protocol admission synchronously when detached output fails', async () => {
  const h = fixture(true, AppServerErrorStyle.Codex);
  const pending = deferred<Record<string, unknown>>();
  h.binding.threads.start = vi.fn(() => pending.promise);
  await h.initialize();
  const starting = h.request('thread/start');
  const beforeFailure = [...h.output];
  const reason = new Error('Detached notification could not be delivered.');

  h.context.fail!(reason);
  expect(h.context.isClosed()).toBe(true);
  await h.request('thread/start');
  await h.request('turn/start');
  h.context.notify(AppServerNotificationMethod.ThreadNameUpdated, { threadId: 'owned' });
  h.context.fail!(new Error('Repeated failure'));
  pending.resolve({ thread: { id: 'owned' } });
  await starting;
  await h.session.close();

  expect(h.binding.threads.start).toHaveBeenCalledOnce();
  expect(h.binding.turns.start).not.toHaveBeenCalled();
  expect(h.binding.onDisconnect).toHaveBeenCalledExactlyOnceWith(reason);
  expect(h.output).toEqual(beforeFailure);
});

it('observes detached failure cleanup rejection without reopening the protocol', async () => {
  const h = fixture();
  const cleanupFailure = new Error('Native cleanup failed.');
  h.binding.onDisconnect = vi.fn(async () => { throw cleanupFailure; });
  h.context.fail!(new Error('Output failed.'));
  await expect(h.session.close()).rejects.toBe(cleanupFailure);
  await h.request('thread/start');
  expect(h.context.isClosed()).toBe(true);
  expect(h.binding.threads.start).not.toHaveBeenCalled();
  expect(h.output).toEqual([]);
});

describe('Codex server requests', () => {
  const create = () => fixture(true, AppServerErrorStyle.Codex);
  const params = { threadId: 'owned', turnId: 'turn', itemId: 'tool' };

  it('requires the initialized handshake and exposes experimental opt-in only after success', async () => {
    const h = create();
    expect(h.context.isExperimentalApiEnabled!()).toBe(false);
    await expect(h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params)).rejects.toThrow('unavailable');
    await h.request('initialize', {
      clientInfo: { name: 'client', version: '1' }, capabilities: { experimentalApi: true },
    });
    expect(h.context.isExperimentalApiEnabled!()).toBe(false);
    await expect(h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params)).rejects.toThrow('unavailable');
    await h.session.receive({ method: 'initialized' });
    expect(h.context.isExperimentalApiEnabled!()).toBe(true);
    await h.session.close();
    expect(h.context.isExperimentalApiEnabled!()).toBe(false);
  });

  it('routes only matching client responses and keeps request IDs direction-specific', async () => {
    const h = create();
    await h.initialize();
    let resolved = false;
    const pending = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params)
      .then(result => { resolved = true; return result; });
    const id = h.output.at(-1)!.id;
    expect(typeof id).toBe('string');
    await h.session.receive({ id: 'unknown', result: { decision: 'accept' } });
    await h.session.receive({ id, method: 'model/list', params: {} });
    expect(resolved).toBe(false);
    expect(h.output.at(-1)).toMatchObject({ id, error: { code: -32601 } });
    await h.session.receive({ id, result: { decision: 'decline' } });
    await expect(pending).resolves.toEqual({ decision: 'decline' });
    expect(h.output.at(-1)).toMatchObject({
      method: 'serverRequest/resolved', params: { requestId: id, threadId: 'owned' },
    });
    const count = h.output.length;
    await h.session.receive({ id, result: { decision: 'accept' } });
    expect(h.output).toHaveLength(count);
    await h.session.close();
  });

  it.each([
    { result: {}, error: { code: -32601, message: 'Unsupported' } },
    { error: { message: 'Missing code' } },
    { error: null },
  ])('rejects ambiguous or malformed client responses without granting: %j', async response => {
    const h = create();
    await h.initialize();
    const pending = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params);
    const rejected = expect(pending).rejects.toThrow('Invalid client response');
    await h.session.receive({ id: h.output.at(-1)!.id, ...response });
    await rejected;
    await h.session.close();
  });

  it('preserves a valid client error as a rejected request', async () => {
    const h = create();
    await h.initialize();
    const pending = h.context.request!(AppServerRequestMethod.ToolUserInput, params);
    const rejected = expect(pending).rejects.toMatchObject({ code: -32601, message: 'Not supported.' });
    await h.session.receive({ id: h.output.at(-1)!.id, error: { code: -32601, message: 'Not supported.' } });
    await rejected;
    await h.session.close();
  });

  it('withdraws aborted requests and never reuses their IDs for a later request', async () => {
    const h = create();
    await h.initialize();
    const cancellation = new AbortController();
    const first = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params, { signal: cancellation.signal });
    const firstId = h.output.at(-1)!.id;
    const rejected = expect(first).rejects.toThrow('cancelled');
    cancellation.abort();
    await rejected;
    let resolved = false;
    const second = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params)
      .then(result => { resolved = true; return result; });
    const secondId = h.output.at(-1)!.id;
    expect(secondId).not.toBe(firstId);
    await h.session.receive({ id: firstId, result: { decision: 'accept' } });
    expect(resolved).toBe(false);
    await h.session.receive({ id: secondId, result: { decision: 'decline' } });
    await expect(second).resolves.toEqual({ decision: 'decline' });
    await h.session.close();
  });

  it('rejects pending requests before waiting for native disconnect cleanup', async () => {
    const h = create();
    const cleanup = deferred<void>();
    h.binding.onDisconnect = vi.fn(() => cleanup.promise);
    await h.initialize();
    const pending = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params);
    const id = h.output.at(-1)!.id;
    const rejected = expect(pending).rejects.toThrow('closed');
    const closed = h.session.close();
    await rejected;
    expect(h.context.isClosed()).toBe(true);
    const count = h.output.length;
    await h.session.receive({ id, result: { decision: 'accept' } });
    await h.request('turn/start');
    expect(h.output).toHaveLength(count);
    expect(h.binding.turns.start).not.toHaveBeenCalled();
    cleanup.resolve();
    await closed;
  });

  it('times out a request without granting or cancelling an unrelated turn', async () => {
    vi.useFakeTimers();
    const h = create();
    try {
      await h.initialize();
      const pending = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params, { timeoutMs: 10 });
      const rejected = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(h.context.isClosed()).toBe(false);
      expect(h.binding.turns.interrupt).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await h.session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds unanswered requests and releases them on cancellation', async () => {
    const h = create();
    await h.initialize();
    const cancellations = Array.from({ length: 64 }, () => new AbortController());
    const pending = cancellations.map(cancellation =>
      h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params, { signal: cancellation.signal })
        .catch(error => error));
    await expect(h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params)).rejects.toThrow('Too many');
    cancellations.forEach(cancellation => cancellation.abort());
    expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true);
    const next = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params);
    const rejected = expect(next).rejects.toThrow('closed');
    await h.session.close();
    await rejected;
  });

  it('retires the protocol synchronously when a server request cannot be sent', async () => {
    const h = create();
    await h.initialize();
    h.send.mockImplementationOnce(() => { throw new Error('Transport write failed.'); });
    const pending = h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params);
    expect(h.context.isClosed()).toBe(true);
    await expect(pending).rejects.toThrow('request output failed');
    await h.request('thread/start');
    await h.session.close();
    expect(h.binding.threads.start).not.toHaveBeenCalled();
    expect(h.binding.onDisconnect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'App-server request output failed.' }));
  });

  it('keeps legacy Standard response handling unchanged and does not enable server requests', async () => {
    const h = fixture();
    await h.initialize({ capabilities: { experimentalApi: true } });
    await h.session.receive({ id: 'unrequested', result: {} });
    expect(h.output.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(h.context.isExperimentalApiEnabled!()).toBe(false);
    await expect(h.context.request!(AppServerRequestMethod.CommandExecutionApproval, params)).rejects.toThrow('unavailable');
    await h.session.close();
  });

  it('routes native history methods only to explicitly installed operations', async () => {
    const h = create();
    await h.initialize();
    await h.request('thread/turns/list');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32601 } });
    h.binding.threads.turnsList = vi.fn(() => ({ data: [] }));
    h.binding.threads.itemsList = vi.fn(() => ({ data: [] }));
    await h.request('thread/turns/list', { threadId: 'owned' });
    await h.request('thread/items/list', { threadId: 'owned' });
    expect(h.binding.threads.turnsList).toHaveBeenCalledExactlyOnceWith({ threadId: 'owned' });
    expect(h.binding.threads.itemsList).toHaveBeenCalledExactlyOnceWith({ threadId: 'owned' });
    await h.session.close();
  });
});

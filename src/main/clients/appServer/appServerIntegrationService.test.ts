import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { isAppServerPort } from '../../../shared/integrations/appServerIntegration';
import type { ExternalAgentBackendFactory } from '../shared/externalAgentBackend';
import {
  type ExternalAgentBackend,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from '../shared/externalAgentTypes';
import { AppServerIntegrationService } from './appServerIntegrationService';
import { AppServerSessionManager } from './client/appServerSessionManager';
import { AppServerNotificationMethod } from './protocol/appServerProtocol';
import type { AppServerWebSocketServerOptions } from './protocol/appServerWebSocketServer';

const services: AppServerIntegrationService[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const service of services.splice(0)) await service.stop();
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function memorySettings() {
  let saved = { port: 0, token: randomBytes(32).toString('hex') };
  return {
    get: vi.fn(() => ({ ...saved })),
    setPort: vi.fn((port: number) => {
      if (!isAppServerPort(port)) throw new Error('Invalid application connection port.');
      saved = { ...saved, port };
      return { ...saved };
    }),
    regenerateToken: vi.fn(() => {
      saved = { ...saved, token: randomBytes(32).toString('hex') };
      return { ...saved };
    }),
  };
}

function fixture(run?: ExternalAgentBackend['run']) {
  const backends: ExternalAgentBackend[] = [];
  const connect = vi.fn(() => {
    const thread = { id: randomUUID(), cwd: process.cwd(), agentId: 'main', modelRef: 'provider/model' };
    const backend: ExternalAgentBackend = {
      models: vi.fn(() => [{ id: 'provider/model', name: 'Configured', isDefault: true }]),
      start: vi.fn(async options => ({ ...thread, cwd: options.cwd })),
      resume: vi.fn(async id => ({ ...thread, id })),
      describe: vi.fn(id => ({ ...thread, id, name: 'Fixture', createdAt: 1000, updatedAt: 2000,
        permissionMode: 'full' as const, status: 'completed' as const })),
      run: run ?? vi.fn(async () => 'Exact answer'),
    };
    backends.push(backend);
    return backend;
  });
  const sessionManager = new AppServerSessionManager({
    backend: { connect, activeTaskCount: 0 } as unknown as ExternalAgentBackendFactory,
    createResources: () => ({ prepare: async () => () => {}, close: async () => {} }),
  });
  let cwd = process.cwd();
  const getDefaultCwd = vi.fn(() => cwd);
  const settings = memorySettings();
  const service = new AppServerIntegrationService({ sessionManager, getDefaultCwd, settings });
  services.push(service);
  return { service, sessionManager, settings, backends, connect, getDefaultCwd, setCwd: (value: string) => { cwd = value; } };
}

async function open(service: AppServerIntegrationService) {
  const config = service.getConnectionConfig();
  const socket = new WebSocket(config.url, { headers: config.headers });
  sockets.push(socket);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let nextId = 0;
  const request = async (method: string, params = {}) => {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(messages.some(message => message.id === id)).toBe(true));
    return messages.find(message => message.id === id)!;
  };
  await request('initialize', {
    clientInfo: { name: 'privileged-client', version: 'untrusted' },
    capabilities: { unregisteredTools: true },
  });
  socket.send(JSON.stringify({ method: 'initialized' }));
  return { socket, messages, request };
}

async function rejectedHandshake(url: string, headers: Record<string, string> = {}): Promise<number> {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => reject(new Error('Unexpected authenticated connection.')));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', reject);
  });
}

describe('native-client WebSocket app-server', () => {
  it('stopping its listener preserves a stdio peer owned by the same manager', async () => {
    const f = fixture();
    const messages: Array<Record<string, unknown>> = [];
    const stdio = f.sessionManager.connect(process.cwd(), {}, value => messages.push(value as Record<string, unknown>));
    try {
      await stdio.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'stdio', version: '1' } } });
      await stdio.receive({ method: 'initialized' });
      await stdio.receive({ id: 2, method: 'thread/start', params: {} });
      const stdioId = (messages.find(value => value.id === 2)!.result as { thread: { id: string } }).thread.id;
      await f.service.start();
      const native = await open(f.service);
      const started = await native.request('thread/start');
      const nativeId = (started.result as { thread: { id: string } }).thread.id;
      expect(f.sessionManager.loadedThreadIds().sort()).toEqual([stdioId, nativeId].sort());

      await f.service.stop();

      expect(f.sessionManager.loadedThreadIds()).toEqual([stdioId]);
      await stdio.receive({ id: 3, method: 'model/list', params: {} });
      expect(messages.find(value => value.id === 3)).toMatchObject({ result: { data: [{ id: 'provider/model' }] } });
    } finally {
      await stdio.close();
    }
  });

  it('requires its own Bearer credential without an Origin and never exposes it in status', async () => {
    const f = fixture();
    expect(f.service.getStatus()).toMatchObject({ running: false, url: '', configuredPort: 0, restartRequired: false });
    expect(() => f.service.getConnectionConfig()).toThrow('not running');
    await f.service.start();
    const config = f.service.getConnectionConfig();
    expect(config.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/app-server$/u);
    expect(config.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/u);
    expect(f.service.getStatus()).toEqual({ running: true, url: config.url, configuredPort: 0, restartRequired: false });
    expect(JSON.stringify(f.service.getStatus())).not.toContain('Bearer');
    expect(JSON.stringify(f.service.getStatus())).not.toContain(config.headers.Authorization.slice(7));
    for (const headers of [
      {},
      { Authorization: 'Bearer wrong' },
      { Authorization: `Bearer ${'é'.repeat(64)}` },
      { Authorization: `Bearer ${'é'.repeat(32)}` },
      { ...config.headers, Origin: 'custom-extension://untrusted' },
      { ...config.headers, Origin: 'https://untrusted.example' },
      { ...config.headers, Origin: '' },
    ]) expect(await rejectedHandshake(config.url, headers)).toBe(401);
    expect(await rejectedHandshake(`${config.url}?token=${config.headers.Authorization.slice(7)}`)).toBe(401);
    expect(f.connect).not.toHaveBeenCalled();
    const peer = await open(f.service);
    expect(await peer.request('model/list')).toMatchObject({
      result: { data: [{ id: 'provider/model' }] },
    });
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it('uses standard capabilities and item events, and snapshots the managed cwd per connection', async () => {
    const f = fixture();
    await f.service.start();
    const first = await open(f.service);
    f.setCwd(process.env.TEMP || process.cwd());
    const created = await first.request('thread/start');
    const threadId = ((created.result as { thread: { id: string } }).thread).id;
    expect(f.backends[0].start).toHaveBeenCalledWith({ cwd: process.cwd(), model: undefined });
    expect(await first.request('thread/read', { threadId })).toHaveProperty('result.thread.id', threadId);
    for (const method of ['thread/list', 'extension/privateAction']) {
      expect(await first.request(method, { threadId })).toHaveProperty('error');
    }
    expect(await first.request('turn/start', { threadId, input: [{ type: 'text', text: 'Question' }] }))
      .toHaveProperty('result.turn.id');
    await vi.waitFor(() => expect(first.messages).toContainEqual(expect.objectContaining({
      method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ status: 'completed' }) }),
    })));
    expect(first.messages).toContainEqual(expect.objectContaining({ method: 'item/agentMessage/delta' }));
    expect(first.messages).toContainEqual(expect.objectContaining({ method: 'item/completed' }));
    const standardNotifications = new Set<string>(Object.values(AppServerNotificationMethod));
    expect(first.messages.filter(message => typeof message.method === 'string')
      .every(message => standardNotifications.has(message.method as string))).toBe(true);

    const second = await open(f.service);
    const storedId = randomUUID();
    expect(await second.request('thread/resume', { threadId: storedId, excludeTurns: true })).toHaveProperty('result.thread.id', storedId);
    expect(f.backends[1].resume).toHaveBeenCalledWith(storedId, { model: undefined });
    expect(f.getDefaultCwd).toHaveBeenCalledTimes(2);
  });

  it('returns protocol parse errors from the shared engine and keeps the connection usable', async () => {
    const f = fixture();
    await f.service.start();
    const peer = await open(f.service);
    peer.socket.send('{');
    await vi.waitFor(() => expect(peer.messages).toContainEqual({
      id: null, error: { code: -32700, message: 'Parse error.' },
    }));
    expect(await peer.request('model/list')).toHaveProperty('result.data');
  });

  it('interrupts an exact owned turn and waits for the backend cancellation before terminal output', async () => {
    const terminal = deferred();
    let signal!: AbortSignal;
    const f = fixture(async (_thread, _run, _text, _event, nativeSignal) => {
      signal = nativeSignal;
      await terminal.promise;
      throw new ExternalAgentCancelledError('Exact native cancellation.');
    });
    try {
      await f.service.start();
      const peer = await open(f.service);
      const created = await peer.request('thread/start');
      const threadId = (created.result as { thread: { id: string } }).thread.id;
      const started = await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Wait' }] });
      const turnId = (started.result as { turn: { id: string } }).turn.id;
      await vi.waitFor(() => expect(signal).toBeDefined());
      expect(await peer.request('turn/interrupt', { threadId, turnId: randomUUID() })).toHaveProperty('error');
      expect(signal.aborted).toBe(false);
      expect(await peer.request('turn/interrupt', { threadId, turnId })).toHaveProperty('result');
      expect(signal.aborted).toBe(true);
      expect(peer.messages.some(message => message.method === 'turn/completed')).toBe(false);
      terminal.resolve();
      await vi.waitFor(() => expect(peer.messages).toContainEqual(expect.objectContaining({
        method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ id: turnId, status: 'interrupted' }) }),
      })));
    } finally {
      terminal.resolve();
    }
  });

  it('disconnects only its own execution and retains detached native drains until stop settles', async () => {
    const terminals = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    const f = fixture(async (_thread, _run, _text, _event, signal) => {
      const ordinal = signals.push(signal) - 1;
      await terminals[ordinal].promise;
      throw new ExternalAgentCancelledError('Exact native cancellation.');
    });
    try {
      await f.service.start();
      const peers = [await open(f.service), await open(f.service)];
      for (const peer of peers) {
        const created = await peer.request('thread/start');
        const threadId = (created.result as { thread: { id: string } }).thread.id;
        await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Wait' }] });
      }
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      peers[0].socket.close(1000);
      await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
      expect(signals[1].aborted).toBe(false);
      let stopped = false;
      const stopping = f.service.stop().then(() => { stopped = true; });
      expect(f.service.getStatus()).toMatchObject({ running: false, url: '', configuredPort: 0, restartRequired: false });
      expect(() => f.service.getConnectionConfig()).toThrow('not running');
      await vi.waitFor(() => expect(signals[1].aborted).toBe(true));
      await tick();
      expect(stopped).toBe(false);
      terminals.forEach(terminal => terminal.resolve());
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      terminals.forEach(terminal => terminal.resolve());
    }
  });

  it('retains an uncertain execution controller until WebSocket close', async () => {
    let signal!: AbortSignal;
    const f = fixture(async (_thread, _run, _text, _event, nativeSignal) => {
      signal = nativeSignal;
      throw new ExternalAgentOutcomeUnknownError('Native outcome is unknown.');
    });
    await f.service.start();
    const peer = await open(f.service);
    const created = await peer.request('thread/start');
    const threadId = (created.result as { thread: { id: string } }).thread.id;
    await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Wait' }] });
    await vi.waitFor(() => expect(peer.messages).toContainEqual(expect.objectContaining({
      method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining('EXECUTION_UNKNOWN') }) }) }),
    })));
    expect(signal.aborted).toBe(false);
    peer.socket.close(1000);
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it('retains its saved credential on restart', async () => {
    const f = fixture();
    const firstStart = f.service.start();
    expect(f.service.start()).toBe(firstStart);
    await firstStart;
    const before = f.service.getConnectionConfig();
    await f.service.stop();
    await f.service.start();
    const after = f.service.getConnectionConfig();
    expect(after.headers.Authorization).toEqual(before.headers.Authorization);
    await open(f.service);
  });

  it('stages a fixed port and regenerated token without interrupting current connections or work', async () => {
    const terminal = deferred();
    let signal!: AbortSignal;
    const f = fixture(async (_thread, _run, _text, _event, nativeSignal) => {
      signal = nativeSignal;
      await terminal.promise;
      return 'Finished';
    });
    try {
      await f.service.start();
      const before = f.service.getConnectionConfig();
      const port = Number(new URL(before.url).port);
      const peer = await open(f.service);
      const created = await peer.request('thread/start');
      const threadId = (created.result as { thread: { id: string } }).thread.id;
      await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Wait' }] });
      await vi.waitFor(() => expect(signal).toBeDefined());

      expect(f.service.setPort(port)).toMatchObject({ configuredPort: port, restartRequired: true });
      expect(f.service.setPort(0)).toMatchObject({ configuredPort: 0, restartRequired: false });
      f.service.regenerateToken();
      expect(f.service.setPort(port)).toMatchObject({ restartRequired: true });
      expect(f.service.getConnectionConfig()).toEqual(before);
      expect(JSON.stringify(f.service.getStatus())).not.toContain(f.settings.get().token);
      expect(signal.aborted).toBe(false);
      expect(peer.socket.readyState).toBe(WebSocket.OPEN);
      await open(f.service);
      terminal.resolve();
      await vi.waitFor(() => expect(peer.messages.some(message => message.method === 'turn/completed')).toBe(true));

      await f.service.stop();
      await f.service.start();
      const after = f.service.getConnectionConfig();
      expect(after.url).toBe(before.url);
      expect(after.headers.Authorization).not.toBe(before.headers.Authorization);
      expect(f.service.getStatus()).toMatchObject({ configuredPort: port, restartRequired: false });
      expect(await rejectedHandshake(after.url, before.headers)).toBe(401);
      await open(f.service);
    } finally {
      terminal.resolve();
    }
  });

  it('keeps the current credential and port when saving fails', async () => {
    const f = fixture();
    await f.service.start();
    const before = f.service.getConnectionConfig();
    f.settings.setPort.mockImplementationOnce(() => { throw new Error('Save failed.'); });
    f.settings.regenerateToken.mockImplementationOnce(() => { throw new Error('Save failed.'); });
    expect(() => f.service.setPort(43210)).toThrow('Save failed');
    expect(() => f.service.regenerateToken()).toThrow('Save failed');
    expect(f.service.getStatus()).toMatchObject({ configuredPort: 0, restartRequired: false });
    expect(f.service.getConnectionConfig()).toEqual(before);
    await open(f.service);
  });

  it('reports an occupied fixed port without falling back to a random port', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const address = occupied.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener.');
      const f = fixture();
      f.service.setPort(address.port);
      await expect(f.service.start()).rejects.toHaveProperty('code', 'EADDRINUSE');
      expect(f.service.getStatus()).toEqual({
        running: false, url: '', configuredPort: address.port, restartRequired: false, failure: 'port-in-use',
      });
      expect(() => f.service.getConnectionConfig()).toThrow('not running');
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe('WebSocket service lifecycle fencing', () => {
  it('rejects unreadable settings without creating a listener or replacing credentials', async () => {
    const settings = memorySettings();
    settings.get.mockImplementation(() => { throw new Error('Sensitive file contents'); });
    const createServer = vi.fn();
    const service = new AppServerIntegrationService({
      sessionManager: { connect: vi.fn() }, getDefaultCwd: () => process.cwd(), settings, createServer,
    });
    services.push(service);
    await expect(service.start()).rejects.toThrow('Application connection settings are unavailable.');
    expect(createServer).not.toHaveBeenCalled();
    expect(settings.regenerateToken).not.toHaveBeenCalled();
  });

  it('keeps the startup snapshot when settings change before the listener is ready', async () => {
    const started = deferred();
    const settings = memorySettings();
    const original = settings.get();
    let running = false;
    let transportOptions!: AppServerWebSocketServerOptions;
    const server = {
      get running() { return running; },
      start: vi.fn(async () => { await started.promise; running = true; }),
      stop: vi.fn(async () => { running = false; }),
      getUrl: () => 'ws://127.0.0.1:1234/app-server',
    };
    const service = new AppServerIntegrationService({
      sessionManager: { connect: vi.fn() }, getDefaultCwd: () => process.cwd(), settings,
      createServer: options => { transportOptions = options; return server; },
    });
    services.push(service);
    const starting = service.start();
    service.setPort(23456);
    service.regenerateToken();
    started.resolve();
    await starting;
    expect(transportOptions.port).toBe(original.port);
    expect(service.getConnectionConfig().headers.Authorization).toBe(`Bearer ${original.token}`);
    expect(service.getStatus()).toMatchObject({ running: true, configuredPort: 23456, restartRequired: true });
    expect(server.stop).not.toHaveBeenCalled();
  });

  it('can retry a failed listener only after its startup cleanup finishes', async () => {
    const cleanup = deferred();
    const failure = new Error('Listener failed.');
    const transports = [0, 1].map(index => ({
      running: false,
      start: vi.fn(async () => {
        if (!index) throw failure;
        transports[index].running = true;
      }),
      stop: vi.fn(async () => { if (!index) await cleanup.promise; }),
      getUrl: () => `ws://127.0.0.1:${1234 + index}/app-server`,
    }));
    const createServer = vi.fn(() => transports[createServer.mock.calls.length - 1]);
    const service = new AppServerIntegrationService({
      sessionManager: { connect: vi.fn() }, getDefaultCwd: () => process.cwd(), settings: memorySettings(), createServer,
    });
    services.push(service);
    const first = service.start();
    const failed = expect(first).rejects.toBe(failure);
    await tick();
    expect(service.getStatus()).toMatchObject({ running: false, url: '', configuredPort: 0, restartRequired: false });
    expect(service.start()).toBe(first);
    expect(createServer).toHaveBeenCalledOnce();
    cleanup.resolve();
    await failed;
    await service.start();
    expect(service.getStatus()).toEqual({ running: true, url: transports[1].getUrl(), configuredPort: 0, restartRequired: false });
  });

  it('does not start a queued replacement after a second stop revokes it', async () => {
    const cleanup = deferred();
    const transports = [0, 1].map(index => ({
      running: false,
      start: vi.fn(async () => { transports[index].running = true; }),
      stop: vi.fn(async () => { if (!index) await cleanup.promise; }),
      getUrl: () => `ws://127.0.0.1:${1234 + index}/app-server`,
    }));
    const createServer = vi.fn(() => transports[createServer.mock.calls.length - 1]);
    const service = new AppServerIntegrationService({
      sessionManager: { connect: vi.fn() }, getDefaultCwd: () => process.cwd(), settings: memorySettings(), createServer,
    });
    services.push(service);
    await service.start();
    const stopped = service.stop();
    const replacement = service.start();
    await tick();
    expect(transports[1].start).not.toHaveBeenCalled();
    const stoppedAgain = service.stop();
    cleanup.resolve();
    await Promise.all([stopped, replacement, stoppedAgain]);
    expect(transports[1].start).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ running: false, url: '', configuredPort: 0, restartRequired: false });
  });

  it('revokes pending startup immediately and never republishes its late listener or credential', async () => {
    const started = deferred();
    const stopped = deferred();
    let running = false;
    let transportOptions!: AppServerWebSocketServerOptions;
    const server = {
      get running() { return running; },
      start: vi.fn(async () => { await started.promise; running = true; }),
      stop: vi.fn(async () => { await stopped.promise; running = false; }),
      getUrl: () => 'ws://127.0.0.1:1234/app-server',
    };
    const sessionManager = { connect: vi.fn() };
    const service = new AppServerIntegrationService({
      sessionManager, getDefaultCwd: () => process.cwd(), settings: memorySettings(),
      createServer: options => { transportOptions = options; return server; },
    });
    services.push(service);
    const starting = service.start();
    await tick();
    const stopping = service.stop();
    expect(service.getStatus()).toMatchObject({ running: false, url: '', configuredPort: 0, restartRequired: false });
    expect(() => service.getConnectionConfig()).toThrow('not running');
    expect(transportOptions.authorize({ headers: {} } as IncomingMessage, new URL(server.getUrl()))).toBe(false);
    expect(() => transportOptions.createConnection(vi.fn())).toThrow('not running');
    expect(transportOptions.createTransportError?.('Broken output')).toBeInstanceOf(ExternalAgentStreamError);
    started.resolve();
    stopped.resolve();
    await Promise.all([starting, stopping]);
    expect(server.start).toHaveBeenCalledOnce();
    expect(server.stop).toHaveBeenCalledOnce();
    expect(sessionManager.connect).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ running: false, url: '', configuredPort: 0, restartRequired: false });
  });
});

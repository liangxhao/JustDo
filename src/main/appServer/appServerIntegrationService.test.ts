import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentCommandService } from '../integrations/externalAgent/agentCommandService';
import type { ExternalAgentBackendFactory } from '../integrations/externalAgent/externalAgentBackend';
import {
  type ExternalAgentBackend,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from '../integrations/externalAgent/externalAgentTypes';
import { AppServerIntegrationService } from './appServerIntegrationService';
import type { AppServerWebSocketServerOptions } from './appServerWebSocketServer';

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

function fixture(run?: ExternalAgentBackend['run']) {
  const backends: ExternalAgentBackend[] = [];
  const connect = vi.fn(() => {
    const thread = { id: randomUUID(), cwd: process.cwd(), agentId: 'main' };
    const backend: ExternalAgentBackend = {
      models: vi.fn(() => [{ id: 'provider/model', name: 'Configured', isDefault: true }]),
      start: vi.fn(async options => ({ ...thread, cwd: options.cwd })),
      resume: vi.fn(async id => ({ ...thread, id })),
      run: run ?? vi.fn(async () => 'Exact answer'),
    };
    backends.push(backend);
    return backend;
  });
  const commandService = new AgentCommandService({
    backend: { connect, activeTaskCount: 0 } as unknown as ExternalAgentBackendFactory,
    createResources: () => ({ prepare: async () => () => {}, close: async () => {} }),
    getStatus: vi.fn(),
  });
  let cwd = process.cwd();
  const getDefaultCwd = vi.fn(() => cwd);
  const service = new AppServerIntegrationService({ commandService, getDefaultCwd });
  services.push(service);
  return { service, backends, connect, getDefaultCwd, setCwd: (value: string) => { cwd = value; } };
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
    clientInfo: { name: 'chrome-extension', version: 'untrusted' },
    capabilities: { browser: true },
  });
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
  it('requires its own Bearer credential without an Origin and never exposes it in status', async () => {
    const f = fixture();
    expect(f.service.getStatus()).toEqual({ running: false, url: '' });
    expect(() => f.service.getConnectionConfig()).toThrow('not running');
    await f.service.start();
    const config = f.service.getConnectionConfig();
    expect(config.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/app-server$/u);
    expect(config.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/u);
    expect(f.service.getStatus()).toEqual({ running: true, url: config.url });
    expect(JSON.stringify(f.service.getStatus())).not.toContain('Bearer');
    expect(JSON.stringify(f.service.getStatus())).not.toContain(config.headers.Authorization.slice(7));
    for (const headers of [
      {},
      { Authorization: 'Bearer wrong' },
      { Authorization: `Bearer ${'é'.repeat(64)}` },
      { Authorization: `Bearer ${'é'.repeat(32)}` },
      { ...config.headers, Origin: 'chrome-extension://untrusted' },
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
    for (const method of ['thread/list', 'thread/read', 'thread/image', 'composer/options', 'browser/extension/pair']) {
      expect(await first.request(method, { threadId })).toHaveProperty('error');
    }
    expect(await first.request('turn/start', { threadId, input: [{ type: 'text', text: 'Question' }] }))
      .toHaveProperty('result.turn.id');
    await vi.waitFor(() => expect(first.messages).toContainEqual(expect.objectContaining({
      method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ status: 'completed' }) }),
    })));
    expect(first.messages).toContainEqual(expect.objectContaining({ method: 'item/agentMessage/delta' }));
    expect(first.messages).toContainEqual(expect.objectContaining({ method: 'item/completed' }));
    expect(first.messages.some(message => message.method === 'thread/stream')).toBe(false);

    const second = await open(f.service);
    const storedId = randomUUID();
    expect(await second.request('thread/resume', { threadId: storedId })).toHaveProperty('result.thread.id', storedId);
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
      expect(f.service.getStatus()).toEqual({ running: false, url: '' });
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

  it('rotates its credential on restart and never accepts the previous instance token', async () => {
    const f = fixture();
    const firstStart = f.service.start();
    expect(f.service.start()).toBe(firstStart);
    await firstStart;
    const before = f.service.getConnectionConfig();
    await f.service.stop();
    await f.service.start();
    const after = f.service.getConnectionConfig();
    expect(after.headers.Authorization).not.toEqual(before.headers.Authorization);
    expect(await rejectedHandshake(after.url, before.headers)).toBe(401);
    await open(f.service);
  });
});

describe('WebSocket service lifecycle fencing', () => {
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
      commandService: { connectAppServer: vi.fn() }, getDefaultCwd: () => process.cwd(), createServer,
    });
    services.push(service);
    const first = service.start();
    const failed = expect(first).rejects.toBe(failure);
    await tick();
    expect(service.getStatus()).toEqual({ running: false, url: '' });
    expect(service.start()).toBe(first);
    expect(createServer).toHaveBeenCalledOnce();
    cleanup.resolve();
    await failed;
    await service.start();
    expect(service.getStatus()).toEqual({ running: true, url: transports[1].getUrl() });
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
      commandService: { connectAppServer: vi.fn() }, getDefaultCwd: () => process.cwd(), createServer,
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
    expect(service.getStatus()).toEqual({ running: false, url: '' });
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
    const commandService = { connectAppServer: vi.fn() };
    const service = new AppServerIntegrationService({
      commandService, getDefaultCwd: () => process.cwd(),
      createServer: options => { transportOptions = options; return server; },
    });
    services.push(service);
    const starting = service.start();
    await tick();
    const stopping = service.stop();
    expect(service.getStatus()).toEqual({ running: false, url: '' });
    expect(() => service.getConnectionConfig()).toThrow('not running');
    expect(transportOptions.authorize({ headers: {} } as IncomingMessage, new URL(server.getUrl()))).toBe(false);
    expect(() => transportOptions.createConnection(vi.fn())).toThrow('not running');
    expect(transportOptions.createTransportError?.('Broken output')).toBeInstanceOf(ExternalAgentStreamError);
    started.resolve();
    stopped.resolve();
    await Promise.all([starting, stopping]);
    expect(server.start).toHaveBeenCalledOnce();
    expect(server.stop).toHaveBeenCalledOnce();
    expect(commandService.connectAppServer).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ running: false, url: '' });
  });
});

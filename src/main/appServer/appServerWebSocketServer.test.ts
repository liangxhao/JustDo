import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  type AppServerWebSocketConnection,
  AppServerWebSocketServer,
  type AppServerWebSocketServerOptions,
} from './appServerWebSocketServer';

const servers: AppServerWebSocketServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(servers.splice(0).map(server => server.stop()));
});

class OutputFailure extends Error {}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
};
const ticks = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const open = async (
  url: string,
  headers: Record<string, string> = { authorization: 'Bearer test' },
) => {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
};
const closed = (socket: WebSocket) =>
  new Promise<void>(resolve => socket.once('close', () => resolve()));

function fixture(options: Partial<AppServerWebSocketServerOptions> = {}) {
  let send!: (value: unknown) => void;
  const close = vi.fn(async (_reason?: Error) => {});
  const receiveRaw = vi.fn(async (_raw: string) => {});
  const session = { close, receiveRaw };
  const createConnection = vi.fn((write: typeof send) => {
    send = write;
    return session;
  });
  const createTransportError = vi.fn((message: string) => new OutputFailure(message));
  const server = new AppServerWebSocketServer({
    authorize: request => request.headers.authorization === 'Bearer test',
    createConnection,
    createTransportError,
    ...options,
  });
  servers.push(server);
  return {
    server,
    close,
    receiveRaw,
    createConnection,
    createTransportError,
    send: (value: unknown) => send(value),
  };
}

describe('shared app-server WebSocket transport', () => {
  it('binds loopback and forwards raw text without parsing RPC or sharing credentials', async () => {
    const f = fixture();
    await f.server.start();
    const url = new URL(f.server.getUrl());
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/app-server');
    expect(url.search).toBe('');
    const socket = await open(url.href);
    socket.send('not JSON and not an RPC method');
    await vi.waitFor(() =>
      expect(f.receiveRaw).toHaveBeenCalledWith('not JSON and not an RPC method'),
    );
    const result = new Promise<string>(resolve =>
      socket.once('message', data => resolve(data.toString())),
    );
    f.send({ own: 'response' });
    expect(JSON.parse(await result)).toEqual({ own: 'response' });
  });

  it('rejects unauthorized peers and paths before creating a session', async () => {
    const f = fixture();
    await f.server.start();
    await expect(open(f.server.getUrl(), { authorization: 'Bearer wrong' })).rejects.toThrow();
    await expect(open(f.server.getUrl().replace('/app-server', '/other'))).rejects.toThrow();
    expect(f.createConnection).not.toHaveBeenCalled();
  });

  it('singleflights startup and fences a stop racing the bind, then starts a fresh generation', async () => {
    const f = fixture();
    const first = f.server.start();
    expect(f.server.start()).toBe(first);
    const rejected = expect(first).rejects.toThrow('cancelled');
    const stopped = f.server.stop();
    expect(f.server.running).toBe(false);
    await rejected;
    await stopped;
    expect(() => f.server.getUrl()).toThrow('not running');
    await f.server.start();
    await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    expect(f.server.running).toBe(true);
  });

  it('cleans a bind failure and can retry after the requested port becomes available', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    const f = fixture({ port: address.port });
    try {
      await expect(f.server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(f.server.running).toBe(false);
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
    await f.server.start();
    await open(f.server.getUrl());
    expect(f.server.running).toBe(true);
  });

  it('runs pending requests concurrently so an admission wait cannot block interruption', async () => {
    const f = fixture();
    const pending = deferred<void>();
    f.receiveRaw.mockImplementation(raw =>
      raw === 'pending admission' ? pending.promise : Promise.resolve(),
    );
    await f.server.start();
    const socket = await open(f.server.getUrl());
    socket.send('pending admission');
    socket.send('interrupt');
    await vi.waitFor(() =>
      expect(f.receiveRaw.mock.calls.map(([raw]) => raw)).toEqual([
        'pending admission',
        'interrupt',
      ]),
    );
    pending.resolve();
  });

  it.each(['frames', 'bytes'])(
    'bounds pending input %s and preserves the failure reason until domain close',
    async kind => {
      const f = fixture(
        kind === 'frames' ? { maxPendingInputFrames: 1 } : { maxPendingInputBytes: 4 },
      );
      const pending = deferred<void>();
      f.receiveRaw.mockReturnValueOnce(pending.promise);
      await f.server.start();
      const socket = await open(f.server.getUrl());
      socket.send(kind === 'frames' ? 'first' : '€');
      await vi.waitFor(() => expect(f.receiveRaw).toHaveBeenCalledOnce());
      socket.send(kind === 'frames' ? 'second' : 'aa');
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
      expect(f.close.mock.calls[0][0]).toBeInstanceOf(OutputFailure);
      expect(f.receiveRaw).toHaveBeenCalledOnce();
      await f.server.stop();
      pending.resolve();
    },
  );

  it('retains late ordinary handlers in the connection cap without blocking stop or a fresh listener', async () => {
    const f = fixture({ maxConnections: 1 });
    const pending = deferred<void>();
    f.receiveRaw.mockReturnValueOnce(pending.promise);
    await f.server.start();
    const socket = await open(f.server.getUrl());
    socket.send('pending ordinary read');
    await vi.waitFor(() => expect(f.receiveRaw).toHaveBeenCalledOnce());
    await f.server.stop();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(undefined);
    await f.server.start();
    await expect(open(f.server.getUrl())).rejects.toThrow();
    expect(f.createConnection).toHaveBeenCalledOnce();
    pending.resolve();
    await ticks();
    await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledTimes(2));
  });

  it.each(['binary', 'oversized'])(
    'rejects an unsupported %s input frame before domain dispatch',
    async kind => {
      const f = fixture();
      await f.server.start();
      const socket = await open(f.server.getUrl());
      socket.send(kind === 'binary' ? Buffer.from('binary') : 'x'.repeat(8 * 1024 * 1024 + 1));
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
      expect(f.close.mock.calls[0][0]).toBeInstanceOf(OutputFailure);
      expect(f.receiveRaw).not.toHaveBeenCalled();
    },
  );

  it('keeps a disconnected native drain within the connection cap and stop wait', async () => {
    const f = fixture({ maxConnections: 1 });
    const nativeDrain = deferred<void>();
    f.close.mockReturnValueOnce(nativeDrain.promise);
    await f.server.start();
    const socket = await open(f.server.getUrl());
    const disconnected = closed(socket);
    socket.terminate();
    await disconnected;
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    await expect(open(f.server.getUrl())).rejects.toThrow();
    expect(f.createConnection).toHaveBeenCalledOnce();
    const reason = f.close.mock.calls[0][0];
    expect(reason).toBeInstanceOf(OutputFailure);
    let stopped = false;
    const stopping = f.server.stop().then(() => {
      stopped = true;
    });
    await ticks();
    expect(stopped).toBe(false);
    nativeDrain.resolve();
    await stopping;
    expect(f.close).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it('drains a factory that resolves after stop without admitting buffered input or reviving the listener', async () => {
    const factory = deferred<AppServerWebSocketConnection>();
    const nativeDrain = deferred<void>();
    const close = vi.fn(() => nativeDrain.promise);
    const receiveRaw = vi.fn(async () => {});
    const createConnection = vi.fn(() => factory.promise);
    const f = fixture({ createConnection });
    await f.server.start();
    const socket = await open(f.server.getUrl());
    await vi.waitFor(() => expect(createConnection).toHaveBeenCalledOnce());
    socket.send('never admit');
    await ticks();
    let stopped = false;
    const stopping = f.server.stop().then(() => {
      stopped = true;
    });
    factory.resolve({ close, receiveRaw });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(f.server.running).toBe(false);
    expect(stopped).toBe(false);
    expect(receiveRaw).not.toHaveBeenCalled();
    nativeDrain.resolve();
    await stopping;
  });

  it('queues a fresh start behind native cleanup and lets a later stop cancel that queued start', async () => {
    const f = fixture();
    const nativeDrain = deferred<void>();
    f.close.mockReturnValueOnce(nativeDrain.promise);
    await f.server.start();
    await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    const stopping = f.server.stop();
    const restarting = f.server.start();
    const rejected = expect(restarting).rejects.toThrow('cancelled');
    expect(f.server.running).toBe(false);
    expect(f.server.stop()).toBe(stopping);
    nativeDrain.resolve();
    await stopping;
    await rejected;
    expect(f.server.running).toBe(false);
    await f.server.start();
    expect(f.server.running).toBe(true);
  });

  it('reports a per-frame output overflow with the exact endpoint failure type', async () => {
    const f = fixture({ maxOutputFrameBytes: 8 });
    await f.server.start();
    await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    let failure: unknown;
    try {
      f.send({ too: 'large' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OutputFailure);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledExactlyOnceWith(failure));
  });

  it('counts in-flight send callbacks, releases capacity, and bounds total pending output', async () => {
    const f = fixture({ maxOutputFrameBytes: 32, maxPendingOutputBytes: 20 });
    await f.server.start();
    const client = await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    const callbacks: Array<(error?: Error) => void> = [];
    const original = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data,
      options,
      callback,
    ) {
      if (this === client) return original.call(this, data, options, callback);
      const complete = typeof options === 'function' ? options : callback;
      if (complete) callbacks.push(complete);
    });
    f.send('12345678'); // Ten encoded bytes including the JSON quotes.
    callbacks[0]();
    f.send('12345678');
    f.send('12345678');
    expect(callbacks).toHaveLength(3);
    expect(() => f.send('12345678')).toThrow(OutputFailure);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  });

  it('includes the WebSocket buffered amount in the output bound', async () => {
    const f = fixture({ maxOutputFrameBytes: 32, maxPendingOutputBytes: 20 });
    await f.server.start();
    await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(20);
    expect(() => f.send('x')).toThrow(OutputFailure);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  });

  it('turns an asynchronous socket send failure into an endpoint output failure', async () => {
    const f = fixture();
    await f.server.start();
    const client = await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    const original = WebSocket.prototype.send;
    let fail!: (error: Error) => void;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data,
      options,
      callback,
    ) {
      if (this === client) return original.call(this, data, options, callback);
      fail = (typeof options === 'function' ? options : callback)!;
    });
    f.send({ response: 'safe' });
    fail(new Error('private underlying socket detail'));
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    const failure = f.close.mock.calls[0][0];
    expect(failure).toBeInstanceOf(OutputFailure);
    expect(failure?.message).not.toContain('private');
    expect(failure).toBe(f.createTransportError.mock.results[0].value);
  });

  it('keeps a normal peer close distinct from a failed output transport', async () => {
    const f = fixture();
    await f.server.start();
    const socket = await open(f.server.getUrl());
    await vi.waitFor(() => expect(f.createConnection).toHaveBeenCalledOnce());
    const disconnected = closed(socket);
    socket.close(1000);
    await disconnected;
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledExactlyOnceWith(undefined));
    expect(f.createTransportError).not.toHaveBeenCalled();
  });
});

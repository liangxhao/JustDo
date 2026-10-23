import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

const MAX_INPUT_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_PENDING_INPUT_FRAMES = 64;
const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;
const TransportPhase = { Starting: 'starting', Running: 'running', Stopping: 'stopping' } as const;

export interface AppServerWebSocketConnection {
  receiveRaw: (raw: string) => Promise<void>;
  close: (reason?: Error) => Promise<void>;
}

export interface AppServerWebSocketServerOptions {
  authorize: (request: IncomingMessage, url: URL) => boolean;
  createConnection: (
    send: (message: unknown) => void,
  ) => AppServerWebSocketConnection | Promise<AppServerWebSocketConnection>;
  port?: number;
  maxConnections?: number;
  maxPendingInputFrames?: number;
  maxPendingInputBytes?: number;
  maxOutputFrameBytes?: number;
  maxPendingOutputBytes?: number;
  /** Lets each endpoint preserve its domain's distinction between cancellation and lost output. */
  createTransportError?: (message: string) => Error;
}

interface TransportRun {
  generation: number;
  phase: (typeof TransportPhase)[keyof typeof TransportPhase];
  server: Server;
  webSockets: WebSocketServer;
  sockets: Set<Socket>;
  abort: AbortController;
  closing?: Promise<void>;
}

interface Peer {
  run: TransportRun;
  socket: WebSocket;
  closed: boolean;
  failure?: Error;
  pendingInputFrames: number;
  pendingInputBytes: number;
  pendingOutputBytes: number;
  drained: boolean;
  receives: Set<Promise<void>>;
  closeObserved: Promise<void>;
  observeClose: () => void;
}

const limit = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid transport buffer limit.');
  return value;
};

/** Loopback framing and resource limits only; authentication and RPC belong to their endpoints. */
export class AppServerWebSocketServer {
  private generation = 0;
  private run?: TransportRun;
  private starting?: { generation: number; promise: Promise<void> };
  private stopping?: Promise<void>;
  private readonly peers = new Set<Peer>();
  private readonly drains = new Set<Promise<void>>();
  private readonly maxConnections: number;
  private readonly maxPendingInputFrames: number;
  private readonly maxPendingInputBytes: number;
  private readonly maxOutputFrameBytes: number;
  private readonly maxPendingOutputBytes: number;

  constructor(private readonly options: AppServerWebSocketServerOptions) {
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new Error('Invalid transport port.');
    this.maxConnections = limit(options.maxConnections, DEFAULT_MAX_CONNECTIONS);
    this.maxPendingInputFrames = limit(options.maxPendingInputFrames, DEFAULT_PENDING_INPUT_FRAMES);
    this.maxPendingInputBytes = limit(options.maxPendingInputBytes, MAX_INPUT_FRAME_BYTES);
    this.maxOutputFrameBytes = limit(options.maxOutputFrameBytes, MAX_INPUT_FRAME_BYTES);
    this.maxPendingOutputBytes = limit(options.maxPendingOutputBytes, DEFAULT_OUTPUT_BYTES);
  }

  get running(): boolean {
    return Boolean(this.run && this.isCurrent(this.run) && this.run.server.listening);
  }

  getUrl(): string {
    const address = this.running ? this.run?.server.address() : undefined;
    if (!address || typeof address === 'string')
      throw new Error('App-server transport is not running.');
    return `ws://127.0.0.1:${address.port}/app-server`;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    const generation = this.generation;
    if (this.starting?.generation === generation) return this.starting.promise;
    const stopping = this.stopping;
    const promise = (async () => {
      if (stopping) await stopping;
      if (generation !== this.generation) throw new Error('App-server startup was cancelled.');
      const run = this.createRun(generation);
      this.run = run;
      try {
        await this.listen(run);
        if (
          this.run !== run ||
          generation !== this.generation ||
          run.phase !== TransportPhase.Starting
        ) {
          throw new Error('App-server startup was cancelled.');
        }
        run.phase = TransportPhase.Running;
      } catch (error) {
        if (this.run === run) this.run = undefined;
        await this.closeRun(run);
        throw error;
      }
    })().finally(() => {
      if (this.starting?.promise === promise) this.starting = undefined;
    });
    this.starting = { generation, promise };
    return promise;
  }

  stop(): Promise<void> {
    // Fence upgrades and pending factories before yielding to any close/drain work.
    this.generation += 1;
    const run = this.run;
    this.run = undefined;
    if (run) run.phase = TransportPhase.Stopping;
    for (const peer of this.peers) this.closePeer(peer);
    const closing = run ? this.closeRun(run) : Promise.resolve();
    if (this.stopping) return this.stopping;
    const starting = this.starting?.promise;
    const promise = (async () => {
      await Promise.allSettled([closing, ...(starting ? [starting] : [])]);
      // Socket closure is separate from a session's native execution drain.
      while (this.drains.size) await Promise.allSettled([...this.drains]);
    })().finally(() => {
      if (this.stopping === promise) this.stopping = undefined;
    });
    this.stopping = promise;
    return promise;
  }

  private isCurrent(run: TransportRun): boolean {
    return (
      this.run === run && run.generation === this.generation && run.phase === TransportPhase.Running
    );
  }

  private transportError(message: string): Error {
    try {
      return this.options.createTransportError?.(message) ?? new Error(message);
    } catch {
      return new Error(message);
    }
  }

  private createRun(generation: number): TransportRun {
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
    });
    const run: TransportRun = {
      generation,
      phase: TransportPhase.Starting,
      server,
      webSockets: new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_FRAME_BYTES }),
      sockets: new Set(),
      abort: new AbortController(),
    };
    server.on('connection', socket => {
      if (
        run.phase === TransportPhase.Stopping ||
        run.sockets.size >= this.maxConnections ||
        this.peers.size >= this.maxConnections
      ) {
        socket.destroy();
        return;
      }
      run.sockets.add(socket);
      socket.once('close', () => run.sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1');
      } catch {
        socket.destroy();
        return;
      }
      let authorized = false;
      try {
        authorized = url.pathname === '/app-server' && this.options.authorize(request, url);
      } catch {
        /* Authentication errors never disclose credentials. */
      }
      if (!this.isCurrent(run) || !authorized || this.peers.size >= this.maxConnections) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      run.webSockets.handleUpgrade(request, socket, head, connection =>
        this.accept(run, connection),
      );
    });
    server.on('error', () => {
      if (!this.isCurrent(run)) return;
      for (const peer of this.peers) this.failPeer(peer, 'The app-server listener failed.');
      void this.stop();
    });
    return run;
  }

  private listen(run: TransportRun): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        run.server.off('error', failed);
        run.server.off('close', closed);
        run.server.off('listening', listening);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => failed(new Error('App-server startup was cancelled.'));
      const listening = () => {
        cleanup();
        resolve();
      };
      run.server.once('error', failed);
      run.server.once('close', closed);
      run.server.once('listening', listening);
      try {
        run.server.listen({
          port: this.options.port ?? 0,
          host: '127.0.0.1',
          signal: run.abort.signal,
        });
      } catch (error) {
        failed(error instanceof Error ? error : new Error('App-server startup failed.'));
      }
    });
  }

  private closeRun(run: TransportRun): Promise<void> {
    if (run.closing) return run.closing;
    run.phase = TransportPhase.Stopping;
    run.abort.abort();
    for (const socket of run.sockets) socket.destroy();
    run.closing = Promise.all([
      new Promise<void>(resolve => {
        run.server.close(() => resolve());
      }),
      new Promise<void>(resolve => {
        run.webSockets.close(() => resolve());
      }),
    ]).then(() => {});
    return run.closing;
  }

  private accept(run: TransportRun, socket: WebSocket): void {
    if (!this.isCurrent(run) || this.peers.size >= this.maxConnections) {
      socket.terminate();
      return;
    }
    let observeClose!: () => void;
    const peer: Peer = {
      run,
      socket,
      closed: false,
      pendingInputFrames: 0,
      pendingInputBytes: 0,
      pendingOutputBytes: 0,
      drained: false,
      receives: new Set(),
      closeObserved: new Promise(resolve => {
        observeClose = resolve;
      }),
      observeClose: () => observeClose(),
    };
    this.peers.add(peer);
    const ready = Promise.resolve().then(async () => {
      if (peer.closed || !this.isCurrent(run)) return undefined;
      const connection = await this.options.createConnection(message => this.send(peer, message));
      if (peer.closed || !this.isCurrent(run)) this.closePeer(peer);
      return connection;
    });
    void ready.catch(() => this.failPeer(peer, 'The app-server session could not be created.'));
    const drain = ready
      .then(
        async connection => {
          await peer.closeObserved;
          await Promise.allSettled([
            ...(connection ? [Promise.resolve().then(() => connection.close(peer.failure))] : []),
          ]);
        },
        () => {},
      )
      .finally(() => {
        // A browser detach must not await ordinary late RPC results. Retain
        // their quota separately so reconnects cannot accumulate hung handlers.
        peer.drained = true;
        this.releasePeer(peer);
        this.drains.delete(drain);
      });
    this.drains.add(drain);
    socket.on('message', (data, binary) => {
      if (peer.closed) return;
      if (binary) {
        this.failPeer(peer, 'Binary app-server frames are unavailable.');
        return;
      }
      const raw = data.toString('utf8');
      const bytes = Buffer.byteLength(raw);
      if (
        bytes > MAX_INPUT_FRAME_BYTES ||
        peer.pendingInputFrames >= this.maxPendingInputFrames ||
        peer.pendingInputBytes + bytes > this.maxPendingInputBytes
      ) {
        this.failPeer(peer, 'App-server input exceeded the pending buffer limit.');
        return;
      }
      peer.pendingInputFrames += 1;
      peer.pendingInputBytes += bytes;
      const receive = ready
        .then(async connection => {
          if (connection && !peer.closed && this.isCurrent(run)) await connection.receiveRaw(raw);
        })
        .catch(() => {
          this.failPeer(peer, 'App-server input processing failed.');
        })
        .finally(() => {
          peer.pendingInputFrames -= 1;
          peer.pendingInputBytes -= bytes;
          peer.receives.delete(receive);
          this.releasePeer(peer);
        });
      peer.receives.add(receive);
    });
    socket.once('error', () => this.failPeer(peer, 'The app-server WebSocket transport failed.'));
    socket.once('close', code => {
      if (!peer.closed && this.isCurrent(run) && code !== 1000 && code !== 1001) {
        this.failPeer(peer, 'The app-server connection closed before transport completion.');
      } else this.closePeer(peer);
    });
  }

  private releasePeer(peer: Peer): void {
    if (peer.drained && !peer.receives.size) this.peers.delete(peer);
  }

  private closePeer(peer: Peer): void {
    if (peer.closed) return;
    peer.closed = true;
    peer.observeClose();
    peer.socket.terminate();
  }

  private failPeer(peer: Peer, message: string): Error {
    peer.failure ??= this.transportError(message);
    this.closePeer(peer);
    return peer.failure;
  }

  private send(peer: Peer, value: unknown): void {
    if (peer.closed) return;
    let raw: string;
    try {
      const encoded = JSON.stringify(value);
      if (typeof encoded !== 'string') throw new Error('Invalid output.');
      raw = encoded;
    } catch {
      throw this.failPeer(peer, 'App-server output could not be serialized.');
    }
    const bytes = Buffer.byteLength(raw);
    if (
      bytes > this.maxOutputFrameBytes ||
      peer.pendingOutputBytes + peer.socket.bufferedAmount + bytes > this.maxPendingOutputBytes
    ) {
      throw this.failPeer(peer, 'App-server output exceeded the pending buffer limit.');
    }
    if (peer.socket.readyState !== WebSocket.OPEN)
      throw this.failPeer(peer, 'The app-server output transport is unavailable.');
    peer.pendingOutputBytes += bytes;
    let completed = false;
    const complete = (error?: Error) => {
      if (completed) return;
      completed = true;
      peer.pendingOutputBytes -= bytes;
      if (error) this.failPeer(peer, 'The app-server output transport failed.');
    };
    try {
      peer.socket.send(raw, complete);
    } catch {
      complete(this.failPeer(peer, 'The app-server output transport failed.'));
      throw peer.failure;
    }
  }
}

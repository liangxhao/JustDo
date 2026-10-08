import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  decodeMulticaBridgeLines,
  encodeMulticaBridgeMessage,
  getMulticaBridgeEndpoint,
  MULTICA_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  MULTICA_BRIDGE_MAX_CONNECTIONS,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  MULTICA_MAX_REQUEST_BYTES,
  type MulticaBridgeMetadata,
  type MulticaBridgeRequest,
  type MulticaBridgeResponse,
  sanitizeMulticaBridgeEnvironment,
  validateMulticaCommandArgv,
} from './multicaBridgeProtocol';
import type { MulticaCodexSession } from './multicaCodexSession';
import type { MulticaCommandService } from './multicaCommandService';

interface MulticaBridgeServerOptions {
  userDataPath: string;
  commandService: MulticaCommandService;
  handshakeTimeoutMs?: number;
  maxConnections?: number;
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const OUTPUT_CHUNK_BYTES = 64 * 1024;
// Native admission echoes the accepted input in two consecutive Codex items.
// Allow both encoded items while keeping slow-reader memory bounded.
const MAX_PENDING_OUTPUT_BYTES = 4 * MULTICA_MAX_REQUEST_BYTES;

const isRequest = (value: unknown): value is MulticaBridgeRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<MulticaBridgeRequest>;
  return (
    request.type === 'request' &&
    typeof request.version === 'number' &&
    typeof request.requestId === 'string' &&
    typeof request.token === 'string' &&
    Array.isArray(request.argv) &&
    request.argv.every(argument => typeof argument === 'string') &&
    typeof request.cwd === 'string' &&
    Boolean(request.env) &&
    typeof request.env === 'object' &&
    !Array.isArray(request.env) &&
    Object.entries(request.env).every(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string' && !value.includes('\0'),
    )
  );
};

export class MulticaBridgeServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly abortControllers = new Set<AbortController>();
  private readonly executions = new Set<Promise<void>>();
  private readonly sessions = new Map<net.Socket, MulticaCodexSession>();
  private readonly endpoint: string;
  private readonly token = crypto.randomBytes(32).toString('base64url');

  constructor(private readonly options: MulticaBridgeServerOptions) {
    this.endpoint = getMulticaBridgeEndpoint(options.userDataPath);
  }

  get running(): boolean {
    return this.server?.listening === true;
  }

  get activeTaskCount(): number {
    return this.options.commandService.activeTaskCount;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const directory = path.join(this.options.userDataPath, 'multica');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      const endpointDirectory = path.dirname(this.endpoint);
      fs.mkdirSync(endpointDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(endpointDirectory, 0o700);
      fs.rmSync(this.endpoint, { force: true });
    }
    const server = net.createServer(socket => this.handleConnection(socket));
    const metadataPath = path.join(directory, MULTICA_BRIDGE_METADATA_FILE);
    const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.endpoint, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (process.platform !== 'win32') fs.chmodSync(this.endpoint, 0o600);
      const metadata: MulticaBridgeMetadata = {
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        endpoint: this.endpoint,
        token: this.token,
        pid: process.pid,
      };
      fs.writeFileSync(temporaryPath, JSON.stringify(metadata), { mode: 0o600 });
      fs.rmSync(metadataPath, { force: true });
      fs.renameSync(temporaryPath, metadataPath);
    } catch (error) {
      this.server = null;
      try {
        server.close();
      } catch {
        // The listen failure may already have closed the server.
      }
      fs.rmSync(temporaryPath, { force: true });
      fs.rmSync(metadataPath, { force: true });
      if (process.platform !== 'win32') fs.rmSync(this.endpoint, { force: true });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    fs.rmSync(path.join(this.options.userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), {
      force: true,
    });
    if (!server) return;
    for (const controller of this.abortControllers) controller.abort();
    for (const socket of this.sockets) {
      this.drainSession(socket);
      socket.destroy();
    }
    const closeServer = new Promise<void>(resolve => server.close(() => resolve()));
    const drainExecutions = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
      void Promise.allSettled([...this.executions]).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await Promise.all([closeServer, drainExecutions]);
    if (process.platform !== 'win32') fs.rmSync(this.endpoint, { force: true });
  }

  private drainSession(socket: net.Socket): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);
    const drain = session.close().finally(() => this.executions.delete(drain));
    this.executions.add(drain);
  }

  private handleConnection(socket: net.Socket): void {
    if (this.sockets.size >= (this.options.maxConnections ?? MULTICA_BRIDGE_MAX_CONNECTIONS)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let buffer = '';
    let session: MulticaCodexSession | undefined;
    let stdinBuffer = '';
    let stdinBytes = 0;
    let inputQueue = Promise.resolve();
    let queuedRequests = 0;
    let queuedBytes = 0;
    let handled = false;
    const decoder = new StringDecoder('utf8');
    const abortController = new AbortController();
    this.abortControllers.add(abortController);
    socket.setTimeout(
      this.options.handshakeTimeoutMs ?? MULTICA_BRIDGE_HANDSHAKE_TIMEOUT_MS,
      () => {
        socket.destroy();
      },
    );
    const outputQueue: Buffer[] = [];
    let queuedOutputBytes = 0;
    let outputBlocked = false;
    let outputEnding = false;
    const flushOutput = (): void => {
      while (!socket.destroyed && !outputBlocked && outputQueue.length) {
        const frame = outputQueue.shift()!;
        queuedOutputBytes -= frame.length;
        outputBlocked = !socket.write(frame);
      }
      if (
        outputEnding &&
        !socket.destroyed &&
        !socket.writableEnded &&
        !outputBlocked &&
        outputQueue.length === 0
      )
        socket.end();
    };
    const send = (response: MulticaBridgeResponse): void => {
      if (socket.destroyed || outputEnding) return;
      const frame = Buffer.from(encodeMulticaBridgeMessage(response));
      if (
        frame.length > MULTICA_MAX_REQUEST_BYTES ||
        queuedOutputBytes + socket.writableLength + frame.length > MAX_PENDING_OUTPUT_BYTES
      ) {
        socket.destroy();
        return;
      }
      outputQueue.push(frame);
      queuedOutputBytes += frame.length;
      flushOutput();
    };
    const relayOutput = (type: 'stdout' | 'stderr', text: string): void => {
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length && !socket.destroyed; offset += OUTPUT_CHUNK_BYTES)
        send({
          type,
          data: bytes.subarray(offset, offset + OUTPUT_CHUNK_BYTES).toString('base64'),
        });
    };
    const endOutput = (): void => {
      outputEnding = true;
      // Input closure cancels execution even if the output consumer has stopped
      // reading. Its remaining output can drain independently.
      this.drainSession(socket);
      flushOutput();
    };
    socket.on('drain', () => {
      outputBlocked = false;
      flushOutput();
    });
    socket.on('data', chunk => {
      try {
        if (handled && !session) return;
        if (Buffer.byteLength(buffer) + chunk.length > MULTICA_MAX_REQUEST_BYTES) {
          handled = true;
          send({ type: 'error', message: 'Multica bridge request is too large.' });
          endOutput();
          return;
        }
        buffer += decoder.write(chunk);
        let decoded: ReturnType<typeof decodeMulticaBridgeLines>;
        try {
          decoded = decodeMulticaBridgeLines(buffer);
        } catch {
          handled = true;
          send({ type: 'error', message: 'Invalid Multica bridge request.' });
          endOutput();
          return;
        }
        buffer = decoded.remainder;
        for (const raw of decoded.messages) {
          if (session) {
            const frame = raw as { type?: string; data?: unknown };
            if (frame.type === 'eof') {
              endOutput();
              break;
            }
            if (frame.type !== 'stdin' || typeof frame.data !== 'string') {
              socket.destroy();
              break;
            }
            stdinBuffer += frame.data;
            stdinBytes += Buffer.byteLength(frame.data);
            if (stdinBytes > MULTICA_MAX_REQUEST_BYTES) {
              socket.destroy();
              break;
            }
            if (!frame.data.includes('\n')) continue;
            const input = decodeMulticaBridgeLines(stdinBuffer);
            stdinBuffer = input.remainder;
            stdinBytes = Buffer.byteLength(stdinBuffer);
            for (const message of input.messages) {
              const bytes = Buffer.byteLength(JSON.stringify(message));
              if (++queuedRequests > 256 || queuedBytes + bytes > MULTICA_MAX_REQUEST_BYTES) {
                socket.destroy();
                break;
              }
              queuedBytes += bytes;
              const owned = session;
              inputQueue = inputQueue
                .then(() => owned.receive(message))
                .catch(() => {
                  socket.destroy();
                })
                .finally(() => {
                  queuedRequests -= 1;
                  queuedBytes -= bytes;
                });
            }
            continue;
          }
          if (handled) {
            socket.destroy();
            break;
          }
          handled = true;
          socket.setTimeout(0);
          const suppliedToken = isRequest(raw) ? Buffer.from(raw.token) : null;
          const expectedToken = Buffer.from(this.token);
          if (
            !isRequest(raw) ||
            raw.version !== MULTICA_BRIDGE_PROTOCOL_VERSION ||
            !suppliedToken ||
            suppliedToken.length !== expectedToken.length ||
            !crypto.timingSafeEqual(suppliedToken, expectedToken)
          ) {
            send({ type: 'error', message: `Unauthorized ${PRODUCT_NAME} bridge request.` });
            endOutput();
            break;
          }
          const argv = validateMulticaCommandArgv(raw.argv);
          if (!argv) {
            send({ type: 'error', message: 'Use the Codex runtime in Multica.' });
            endOutput();
            break;
          }
          if (argv[0] === 'app-server') {
            session = this.options.commandService.connect(
              raw.cwd,
              sanitizeMulticaBridgeEnvironment(raw.env),
              message => relayOutput('stdout', `${JSON.stringify(message)}\n`),
            );
            this.sessions.set(socket, session);
            continue;
          }
          const execution = Promise.resolve()
            .then(() =>
              this.options.commandService.execute(
                argv,
                raw.cwd,
                sanitizeMulticaBridgeEnvironment(raw.env),
                abortController.signal,
              ),
            )
            .then(result => {
              if (result.stdout) {
                relayOutput('stdout', result.stdout);
              }
              if (result.stderr) {
                relayOutput('stderr', result.stderr);
              }
              send({ type: 'exit', code: result.exitCode });
              endOutput();
            })
            .catch(error => {
              send({
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
              });
              endOutput();
            })
            .finally(() => {
              this.executions.delete(execution);
            });
          this.executions.add(execution);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once('close', () => {
      outputQueue.length = 0;
      queuedOutputBytes = 0;
      this.sockets.delete(socket);
      this.abortControllers.delete(abortController);
      abortController.abort();
      this.drainSession(socket);
    });
    socket.once('error', () => abortController.abort());
  }
}

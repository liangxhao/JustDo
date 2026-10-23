import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import {
  AGENT_CLI_BRIDGE_DIRECTORY,
  AgentCliErrorCode,
  AgentCliExitCode,
  agentCliInvalidArgumentsMessage,
  usesAgentCliMachineOutput,
} from '../../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../../shared/productMetadata';
import type { AgentCommandResult } from '../agentCommandService';
import { ExternalAgentStreamError } from '../externalAgentTypes';
import {
  AGENT_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  AGENT_BRIDGE_MAX_CONNECTIONS,
  AGENT_BRIDGE_MAX_REQUEST_BYTES,
  AGENT_BRIDGE_METADATA_FILE,
  AGENT_BRIDGE_PROTOCOL_VERSION,
  type AgentBridgeMetadata,
  type AgentBridgeRequest,
  type AgentBridgeResponse,
  decodeAgentBridgeLines,
  encodeAgentBridgeMessage,
  getAgentBridgeEndpoint,
  selectAgentBridgeEnvironment,
  validateAgentBridgeCommandArgv,
} from './agentBridgeProtocol';

export interface AgentBridgeSession {
  receive: (raw: unknown) => Promise<void>;
  close: (reason?: Error) => Promise<void>;
  transportClosed?: Promise<void>;
}

export interface AgentBridgeCommandService {
  readonly activeTaskCount: number;
  connect: (
    cwd: string,
    env: Record<string, string>,
    send: (message: unknown) => void,
    argv?: string[],
  ) => AgentBridgeSession;
  execute: (
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    signal: AbortSignal,
    emit?: (type: 'stdout' | 'stderr', data: string) => void,
  ) => Promise<AgentCommandResult>;
}

interface AgentBridgeServerOptions {
  userDataPath: string;
  commandService: AgentBridgeCommandService;
  handshakeTimeoutMs?: number;
  maxConnections?: number;
  maxPendingOutputBytes?: number;
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const OUTPUT_CHUNK_BYTES = 64 * 1024;
// Native admission echoes the accepted input in two consecutive Codex items.
// Allow both encoded items while keeping slow-reader memory bounded.
const MAX_PENDING_OUTPUT_BYTES = 4 * AGENT_BRIDGE_MAX_REQUEST_BYTES;

const isRequest = (value: unknown): value is AgentBridgeRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<AgentBridgeRequest>;
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

export class AgentBridgeServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly abortControllers = new Set<AbortController>();
  private readonly executions = new Set<Promise<void>>();
  private readonly sessions = new Map<net.Socket, AgentBridgeSession>();
  private readonly endpoint: string;
  private readonly token = crypto.randomBytes(32).toString('base64url');

  constructor(private readonly options: AgentBridgeServerOptions) {
    this.endpoint = getAgentBridgeEndpoint(options.userDataPath);
  }

  get running(): boolean {
    return this.server?.listening === true;
  }

  get activeTaskCount(): number {
    return this.options.commandService.activeTaskCount;
  }

  private get metadataPaths(): string[] {
    return [AGENT_CLI_BRIDGE_DIRECTORY].map(directory =>
      path.join(this.options.userDataPath, directory, AGENT_BRIDGE_METADATA_FILE),
    );
  }

  async start(): Promise<void> {
    if (this.server) return;
    const metadataPaths = this.metadataPaths;
    for (const metadataPath of metadataPaths) {
      fs.mkdirSync(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') {
      const endpointDirectory = path.dirname(this.endpoint);
      fs.mkdirSync(endpointDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(endpointDirectory, 0o700);
      fs.rmSync(this.endpoint, { force: true });
    }
    const server = net.createServer(socket => this.handleConnection(socket));
    const temporaryPaths = metadataPaths.map(metadataPath => `${metadataPath}.${process.pid}.tmp`);
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
      const metadata: AgentBridgeMetadata = {
        version: AGENT_BRIDGE_PROTOCOL_VERSION,
        endpoint: this.endpoint,
        token: this.token,
        pid: process.pid,
      };
      for (let index = 0; index < metadataPaths.length; index += 1) {
        fs.writeFileSync(temporaryPaths[index], JSON.stringify(metadata), { mode: 0o600 });
        fs.rmSync(metadataPaths[index], { force: true });
        fs.renameSync(temporaryPaths[index], metadataPaths[index]);
      }
    } catch (error) {
      this.server = null;
      try {
        server.close();
      } catch {
        // The listen failure may already have closed the server.
      }
      for (const metadataPath of [...temporaryPaths, ...metadataPaths])
        fs.rmSync(metadataPath, { force: true });
      if (process.platform !== 'win32') fs.rmSync(this.endpoint, { force: true });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const metadataPath of this.metadataPaths) fs.rmSync(metadataPath, { force: true });
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

  private drainSession(socket: net.Socket, reason?: Error): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);
    const drain = session
      .close(reason)
      .catch(() => {})
      .finally(() => this.executions.delete(drain));
    this.executions.add(drain);
  }

  private handleConnection(socket: net.Socket): void {
    if (this.sockets.size >= (this.options.maxConnections ?? AGENT_BRIDGE_MAX_CONNECTIONS)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let buffer = '';
    let session: AgentBridgeSession | undefined;
    let concurrentInput = false;
    let genericOutput = false;
    let streamFailure: ExternalAgentStreamError | undefined;
    let stdinBuffer = '';
    let stdinBytes = 0;
    let inputQueue = Promise.resolve();
    let queuedRequests = 0;
    let queuedBytes = 0;
    let handled = false;
    const decoder = new StringDecoder('utf8');
    const abortController = new AbortController();
    this.abortControllers.add(abortController);
    const recordFailure = (message: string): ExternalAgentStreamError => {
      streamFailure ??= new ExternalAgentStreamError(message);
      abortController.abort(streamFailure);
      return streamFailure;
    };
    const destroyFailedTransport = (message: string): ExternalAgentStreamError => {
      const reason = recordFailure(message);
      this.drainSession(socket, reason);
      socket.destroy();
      return reason;
    };
    socket.setTimeout(this.options.handshakeTimeoutMs ?? AGENT_BRIDGE_HANDSHAKE_TIMEOUT_MS, () => {
      socket.destroy();
    });
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
    const send = (response: AgentBridgeResponse): void => {
      if (socket.destroyed || outputEnding) return;
      const frame = Buffer.from(encodeAgentBridgeMessage(response));
      if (
        frame.length > AGENT_BRIDGE_MAX_REQUEST_BYTES ||
        queuedOutputBytes + socket.writableLength + frame.length >
          (this.options.maxPendingOutputBytes ?? MAX_PENDING_OUTPUT_BYTES)
      ) {
        const reason = destroyFailedTransport(
          'External client output exceeded the transport buffer limit.',
        );
        if (genericOutput) throw reason;
        return;
      }
      outputQueue.push(frame);
      queuedOutputBytes += frame.length;
      flushOutput();
    };
    const relayOutput = (type: 'stdout' | 'stderr', text: string): void => {
      if (genericOutput && streamFailure) throw streamFailure;
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
      this.drainSession(socket, streamFailure);
      flushOutput();
    };
    socket.on('drain', () => {
      outputBlocked = false;
      flushOutput();
    });
    socket.on('data', chunk => {
      try {
        if (handled && !session) return;
        if (Buffer.byteLength(buffer) + chunk.length > AGENT_BRIDGE_MAX_REQUEST_BYTES) {
          handled = true;
          recordFailure('External client input exceeded the transport frame limit.');
          send({ type: 'error', message: 'Agent bridge request is too large.' });
          endOutput();
          return;
        }
        buffer += decoder.write(chunk);
        let decoded: ReturnType<typeof decodeAgentBridgeLines>;
        try {
          decoded = decodeAgentBridgeLines(buffer);
        } catch {
          handled = true;
          recordFailure('External client supplied an invalid transport frame.');
          send({ type: 'error', message: 'Invalid Agent bridge request.' });
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
              destroyFailedTransport('External client supplied an invalid input frame.');
              break;
            }
            stdinBuffer += frame.data;
            stdinBytes += Buffer.byteLength(frame.data);
            if (stdinBytes > AGENT_BRIDGE_MAX_REQUEST_BYTES) {
              destroyFailedTransport('External client input exceeded the transport frame limit.');
              break;
            }
            if (!frame.data.includes('\n')) continue;
            const input = decodeAgentBridgeLines(stdinBuffer);
            stdinBuffer = input.remainder;
            stdinBytes = Buffer.byteLength(stdinBuffer);
            for (const message of input.messages) {
              const bytes = Buffer.byteLength(JSON.stringify(message));
              if (++queuedRequests > 256 || queuedBytes + bytes > AGENT_BRIDGE_MAX_REQUEST_BYTES) {
                destroyFailedTransport('External client input exceeded the pending request limit.');
                break;
              }
              queuedBytes += bytes;
              const owned = session;
              const receive = () =>
                Promise.resolve()
                  .then(() => {
                    if (!socket.destroyed && !outputEnding) return owned.receive(message);
                  })
                  .catch(() => {
                    destroyFailedTransport('External client protocol processing failed.');
                  })
                  .finally(() => {
                    queuedRequests -= 1;
                    queuedBytes -= bytes;
                  });
              if (concurrentInput) {
                // ACP prompt responses wait for execution. Keep consuming cancel
                // notifications and permission replies while that request runs.
                void receive();
              } else inputQueue = inputQueue.then(receive);
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
            raw.version !== AGENT_BRIDGE_PROTOCOL_VERSION ||
            !suppliedToken ||
            suppliedToken.length !== expectedToken.length ||
            !crypto.timingSafeEqual(suppliedToken, expectedToken)
          ) {
            send({ type: 'error', message: `Unauthorized ${PRODUCT_NAME} bridge request.` });
            endOutput();
            break;
          }
          const argv = validateAgentBridgeCommandArgv(raw.argv);
          if (!argv) {
            genericOutput = true;
            const machine = usesAgentCliMachineOutput(raw.argv);
            const message = agentCliInvalidArgumentsMessage(
              Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en',
            );
            relayOutput(
              machine ? 'stdout' : 'stderr',
              `${machine ? JSON.stringify({ type: 'error', error: { code: AgentCliErrorCode.InvalidArguments, message } }) : message}\n`,
            );
            send({ type: 'exit', code: AgentCliExitCode.InvalidArguments });
            endOutput();
            break;
          }
          const env = selectAgentBridgeEnvironment(argv, raw.env);
          genericOutput = argv[0] !== 'app-server';
          if (argv[0] === 'app-server' || argv[0] === 'acp') {
            concurrentInput = argv[0] === 'acp';
            session = this.options.commandService.connect(
              raw.cwd,
              env,
              message => relayOutput('stdout', `${JSON.stringify(message)}\n`),
              argv,
            );
            this.sessions.set(socket, session);
            const owned = session;
            void owned.transportClosed
              ?.then(() => {
                if (this.sessions.get(socket) !== owned || outputEnding || socket.destroyed) return;
                // SDK closure must retire the actual console transport as well.
                // Keep a bounded drain even when its output consumer stopped reading.
                const timer = setTimeout(() => socket.destroy(), SHUTDOWN_DRAIN_TIMEOUT_MS);
                timer.unref();
                socket.once('close', () => clearTimeout(timer));
                send({ type: 'exit', code: AgentCliExitCode.BridgeError });
                endOutput();
              })
              .catch(() => {
                destroyFailedTransport('External client protocol transport closed unexpectedly.');
              });
            continue;
          }
          const execution = Promise.resolve()
            .then(() =>
              this.options.commandService.execute(
                argv,
                raw.cwd,
                env,
                abortController.signal,
                relayOutput,
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
        destroyFailedTransport('External client supplied invalid protocol data.');
      }
    });
    socket.once('close', () => {
      outputQueue.length = 0;
      queuedOutputBytes = 0;
      this.sockets.delete(socket);
      this.abortControllers.delete(abortController);
      if (!outputEnding && !streamFailure && this.server?.listening) {
        recordFailure('External client disconnected before transport completion.');
      }
      abortController.abort(streamFailure);
      this.drainSession(socket, streamFailure);
    });
    socket.once('error', () => {
      const reason = recordFailure('External client transport failed.');
      this.drainSession(socket, reason);
    });
  }
}

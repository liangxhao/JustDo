import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import type { ExternalSessionStatus } from '../../../shared/multica';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  decodeBridgeLines,
  encodeBridgeMessage,
  getMulticaBridgeEndpoint,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  type MulticaBridgeMetadata,
  type MulticaBridgeRequest,
  type MulticaBridgeResponse,
  parseMulticaBridgeArgv,
  sanitizeMulticaBridgeEnvironment,
} from './multicaBridgeProtocol';
import {
  extractOpenClawSessionId,
  extractOpenClawSessionKey,
  type MulticaExternalSessionBinding,
  MulticaExternalSessionStore,
  rewriteMulticaAgentSessionArgs,
} from './multicaExternalSessions';
import {
  getMulticaModelDiscoveryKind,
  MULTICA_MODEL_CATALOG_ARGV,
  projectMulticaModelCatalog,
} from './multicaModelProjection';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_CAPTURE_BYTES = 4 * 1024 * 1024;
const OPENCLAW_TIMEOUT_GRACE_MS = 250;
const BUNDLED_RUNTIME_VERSION_PATTERN = /\b(20\d{2}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const LOG_PREFIX = '[MulticaBridge]';

const describeBridgeArgv = (
  argv: readonly string[],
): { command: string; argumentCount: number; messageBytes: number } => {
  const messageIndex = argv.indexOf('--message');
  return {
    command: argv[0] ?? 'unknown',
    argumentCount: argv.length,
    messageBytes:
      messageIndex >= 0 && typeof argv[messageIndex + 1] === 'string'
        ? Buffer.byteLength(argv[messageIndex + 1], 'utf8')
        : 0,
  };
};

export function normalizeMulticaVersionProbeOutput(stdout: string): string | null {
  const version = stdout.match(BUNDLED_RUNTIME_VERSION_PATTERN)?.[1];
  return version ? `${PRODUCT_NAME} ${version}\n` : null;
}

export const classifyMulticaRunStatus = (input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
  resolved: boolean;
}): ExternalSessionStatus => {
  if (input.timedOut || /(?:timed?\s*out|timeout)/i.test(input.stderr)) return 'timeout';
  if (input.signal) return 'cancelled';
  return input.code === 0 && input.resolved ? 'completed' : 'error';
};

const readTimeoutMs = (argv: readonly string[]): number | null => {
  const index = argv.indexOf('--timeout');
  if (index < 0) return null;
  const seconds = Number(argv[index + 1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1_000 + OPENCLAW_TIMEOUT_GRACE_MS, 2_147_483_647);
};

export interface MulticaBridgeServerOptions {
  userDataPath: string;
  getEngineManager: () => OpenClawEngineManager;
  getCoworkStore: () => CoworkStore;
  getDatabase: () => import('better-sqlite3').Database;
  onSessionsChanged: () => void;
}

const writeResponse = (socket: net.Socket, response: MulticaBridgeResponse): void => {
  if (!socket.destroyed) socket.write(encodeBridgeMessage(response));
};

const terminateProcessTree = (child: ChildProcess): void => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => child.kill());
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
};

export class MulticaBridgeServer {
  private server: net.Server | null = null;
  private readonly children = new Set<ChildProcess>();
  private token = '';

  constructor(private readonly options: MulticaBridgeServerOptions) {}

  get running(): boolean {
    return Boolean(this.server?.listening);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const bridgeDir = path.join(this.options.userDataPath, 'multica');
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(bridgeDir, 0o700);
    } catch {
      // Windows ACLs are inherited from the per-user app-data directory.
    }

    const endpoint = getMulticaBridgeEndpoint(this.options.userDataPath);
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(endpoint, { force: true });
      } catch {
        // listen() below will report a useful error if the stale socket remains.
      }
    }
    this.token = crypto.randomBytes(32).toString('base64url');
    const server = net.createServer(socket => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(endpoint, 0o600);
      } catch {
        // Some file systems do not expose POSIX modes.
      }
    }
    const metadata: MulticaBridgeMetadata = {
      version: MULTICA_BRIDGE_PROTOCOL_VERSION,
      endpoint,
      token: this.token,
      pid: process.pid,
    };
    const metadataPath = path.join(bridgeDir, MULTICA_BRIDGE_METADATA_FILE);
    const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, metadataPath);
    try {
      fs.chmodSync(metadataPath, 0o600);
    } catch {
      // Windows ACLs are inherited from the per-user app-data directory.
    }
    console.log(`${LOG_PREFIX} Relay is ready.`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const child of this.children) terminateProcessTree(child);
    this.children.clear();
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const bridgeDir = path.join(this.options.userDataPath, 'multica');
    fs.rmSync(path.join(bridgeDir, MULTICA_BRIDGE_METADATA_FILE), { force: true });
    if (process.platform !== 'win32') {
      fs.rmSync(getMulticaBridgeEndpoint(this.options.userDataPath), { force: true });
    }
  }

  private accept(socket: net.Socket): void {
    let buffer = '';
    let started = false;
    let child: ChildProcess | null = null;
    socket.on('data', chunk => {
      if (started) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        writeResponse(socket, { type: 'error', message: 'Bridge request is too large.' });
        socket.end();
        return;
      }
      let decoded: ReturnType<typeof decodeBridgeLines>;
      try {
        decoded = decodeBridgeLines(buffer);
      } catch {
        writeResponse(socket, { type: 'error', message: 'Bridge request is invalid.' });
        socket.end();
        return;
      }
      buffer = decoded.remainder;
      if (decoded.messages.length === 0) return;
      started = true;
      void this.runRequest(decoded.messages[0] as MulticaBridgeRequest, socket).then(value => {
        child = value;
      });
    });
    socket.once('close', () => {
      if (child) terminateProcessTree(child);
    });
  }

  private async runRequest(
    request: MulticaBridgeRequest,
    socket: net.Socket,
  ): Promise<ChildProcess | null> {
    const argvAllowed =
      Array.isArray(request.argv) &&
      Boolean(parseMulticaBridgeArgv([PRODUCT_NAME, ...request.argv], true));
    if (
      request.type !== 'request' ||
      request.version !== MULTICA_BRIDGE_PROTOCOL_VERSION ||
      request.token !== this.token ||
      !argvAllowed
    ) {
      writeResponse(socket, { type: 'error', message: 'Bridge request was rejected.' });
      console.warn(`${LOG_PREFIX} Rejected a bridge request.`, {
        reason:
          request.type !== 'request'
            ? 'type'
            : request.version !== MULTICA_BRIDGE_PROTOCOL_VERSION
              ? 'version'
              : request.token !== this.token
                ? 'authentication'
                : 'command',
        command: Array.isArray(request.argv) ? (request.argv[0] ?? 'unknown') : 'invalid',
        argumentCount: Array.isArray(request.argv) ? request.argv.length : 0,
      });
      socket.end();
      return null;
    }

    try {
      const requestSummary = describeBridgeArgv(request.argv);
      console.info(`${LOG_PREFIX} Request accepted.`, requestSummary);
      const cwd = path.resolve(request.cwd || this.options.userDataPath);
      if (!fs.statSync(cwd).isDirectory())
        throw new Error('The requested working directory is invalid.');
      const engineManager = this.options.getEngineManager();
      let argv = [...request.argv];
      const versionProbe = argv.length === 1 && argv[0] === '--version';
      const runtimeVersion = versionProbe ? engineManager.getStatus().version : null;
      if (runtimeVersion) {
        writeResponse(socket, {
          type: 'stdout',
          data: Buffer.from(
            `${PRODUCT_NAME} ${runtimeVersion.replace(/^v/, '')}\n`,
            'utf8',
          ).toString('base64'),
        });
        writeResponse(socket, { type: 'exit', code: 0 });
        socket.end();
        console.info(`${LOG_PREFIX} Version probe answered without starting the runtime.`, {
          command: requestSummary.command,
        });
        return null;
      }
      const cli = await engineManager.buildCliEnvironment();
      const modelDiscoveryKind = getMulticaModelDiscoveryKind(argv);
      const bufferedProbe = versionProbe || Boolean(modelDiscoveryKind);
      let binding: MulticaExternalSessionBinding | null = null;
      if (argv[0] === 'agent') {
        const externalStore = new MulticaExternalSessionStore(
          this.options.getDatabase(),
          this.options.getCoworkStore(),
        );
        const rewritten = rewriteMulticaAgentSessionArgs(argv, externalStore, cwd);
        if (rewritten) {
          argv = rewritten.argv;
          binding = rewritten.binding;
          externalStore.updateRun(binding, 'running');
          this.options.onSessionsChanged();
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...cli.env,
        ...sanitizeMulticaBridgeEnvironment(request.env || {}),
        ELECTRON_RUN_AS_NODE: '1',
      };
      const executable = env.JUSTDO_ELECTRON_PATH || process.execPath;
      const runtimeArgv = modelDiscoveryKind ? [...MULTICA_MODEL_CATALOG_ARGV] : argv;
      const child = spawn(executable, [cli.openclawEntry, ...runtimeArgv], {
        cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.info(`${LOG_PREFIX} Runtime process started.`, {
        command: requestSummary.command,
        pid: child.pid ?? null,
      });
      this.children.add(child);
      if (socket.destroyed) terminateProcessTree(child);
      else socket.once('close', () => terminateProcessTree(child));
      let stdoutCapture = Buffer.alloc(0);
      let stderrCapture = Buffer.alloc(0);
      let timedOut = false;
      const timeoutMs = readTimeoutMs(argv);
      const timeoutTimer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child);
          }, timeoutMs)
        : null;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutCapture = Buffer.concat([stdoutCapture, chunk]);
        if (stdoutCapture.byteLength > MAX_STDOUT_CAPTURE_BYTES) {
          stdoutCapture = stdoutCapture.subarray(
            stdoutCapture.byteLength - MAX_STDOUT_CAPTURE_BYTES,
          );
        }
        if (!bufferedProbe) {
          writeResponse(socket, { type: 'stdout', data: chunk.toString('base64') });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrCapture = Buffer.concat([stderrCapture, chunk]);
        if (stderrCapture.byteLength > MAX_STDOUT_CAPTURE_BYTES) {
          stderrCapture = stderrCapture.subarray(
            stderrCapture.byteLength - MAX_STDOUT_CAPTURE_BYTES,
          );
        }
        if (!versionProbe) {
          writeResponse(socket, { type: 'stderr', data: chunk.toString('base64') });
        }
      });
      child.once('error', error => {
        console.warn(`${LOG_PREFIX} Runtime process failed to start.`, {
          command: requestSummary.command,
          category: error.name,
        });
        writeResponse(socket, { type: 'error', message: error.message });
      });
      child.once('exit', (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.children.delete(child);
        let responseCode = typeof code === 'number' ? code : signal ? 130 : 1;
        if (versionProbe) {
          const normalized = normalizeMulticaVersionProbeOutput(stdoutCapture.toString('utf8'));
          const output = normalized ?? stdoutCapture.toString('utf8');
          if (output) {
            writeResponse(socket, {
              type: 'stdout',
              data: Buffer.from(output, 'utf8').toString('base64'),
            });
          }
          if (code !== 0 && stderrCapture.length > 0) {
            writeResponse(socket, {
              type: 'stderr',
              data: stderrCapture.toString('base64'),
            });
          }
        } else if (modelDiscoveryKind && code === 0) {
          const projected = projectMulticaModelCatalog(
            stdoutCapture.toString('utf8'),
            modelDiscoveryKind,
          );
          if (projected === null) {
            responseCode = 1;
            writeResponse(socket, {
              type: 'stderr',
              data: Buffer.from(
                `${PRODUCT_NAME} could not read the configured model catalog.\n`,
                'utf8',
              ).toString('base64'),
            });
          } else {
            writeResponse(socket, {
              type: 'stdout',
              data: Buffer.from(projected, 'utf8').toString('base64'),
            });
          }
        }
        if (binding) {
          const externalStore = new MulticaExternalSessionStore(
            this.options.getDatabase(),
            this.options.getCoworkStore(),
          );
          const openclawSessionId = extractOpenClawSessionId(stdoutCapture.toString('utf8'));
          const openclawSessionKey = extractOpenClawSessionKey(stdoutCapture.toString('utf8'));
          const resolved = Boolean(binding.openclawSessionKey || openclawSessionKey);
          const status = classifyMulticaRunStatus({
            code,
            signal,
            timedOut,
            stderr: stderrCapture.toString('utf8'),
            resolved,
          });
          externalStore.updateRun(binding, status, openclawSessionId, openclawSessionKey);
          this.options.onSessionsChanged();
        }
        console.info(`${LOG_PREFIX} Runtime process finished.`, {
          command: requestSummary.command,
          code,
          signal,
          timedOut,
          stdoutBytes: stdoutCapture.byteLength,
          stderrBytes: stderrCapture.byteLength,
        });
        writeResponse(socket, {
          type: 'exit',
          code: responseCode,
          ...(signal ? { signal } : {}),
        });
        socket.end();
      });
      return child;
    } catch (error) {
      console.warn(`${LOG_PREFIX} Request failed before runtime completion.`, {
        category: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      });
      writeResponse(socket, {
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : `${PRODUCT_NAME} bridge failed to run the bundled Agent runtime.`,
      });
      socket.end();
      return null;
    }
  }
}

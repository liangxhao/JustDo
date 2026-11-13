import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import { app } from 'electron';

import { isStorageExecutionFrozen } from '../../storage/relocationAdmission';
import {
  BROWSER_AUTHENTICATION_EXECUTABLE,
  BROWSER_AUTHENTICATION_LOCAL_ENDPOINT,
  BROWSER_AUTHENTICATION_LOCAL_PORT,
} from './browserAuthenticationConfig';
import { BrowserTransportOwner } from './browserTransportOwner';
import { installBrowserTransportRequestGuard } from './browserTransportRequests';

const LOOPBACK = '127.0.0.1';
const HOST_RULES = 'host-resolver-rules';
const CONNECT = 'connect';
const MAX_PENDING_CONNECTIONS = 32;
const HANDOFF_TIMEOUT_MS = 12_000;
const CHILD_START_TIMEOUT_MS = 5_000;

type RelayProcess = { child: ChildProcess; exited: Promise<void>; stop?: Promise<void> };

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function matchesApplication(executable: string): Promise<boolean> {
  try {
    const original = lstatSync(process.execPath);
    const alias = lstatSync(executable);
    if (!alias.isFile() || alias.size !== original.size) return false;
    const [left, right] = await Promise.all([digest(process.execPath), digest(executable)]);
    return left === right;
  } catch {
    return false;
  }
}

class BrowserAuthenticationTransport {
  private readonly owner = new BrowserTransportOwner();
  private readonly server: Server;
  private readonly pending = new Set<Socket>();
  private child?: RelayProcess;
  private starting?: Promise<RelayProcess | undefined>;
  private stopped?: Promise<void>;
  private retired = false;
  private mapped = false;
  private reportedFailure = false;

  constructor(private readonly executable: string, private readonly relayPath: string) {
    this.server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, socket => {
      socket.on('error', () => {});
      if (this.retired || isStorageExecutionFrozen() || this.pending.size >= MAX_PENDING_CONNECTIONS) {
        socket.destroy();
        return;
      }
      this.pending.add(socket);
      socket.once('close', () => this.pending.delete(socket));
      const timer = setTimeout(() => socket.destroy(), HANDOFF_TIMEOUT_MS);
      socket.once('close', () => clearTimeout(timer));
      void this.forward(socket).catch(() => socket.destroy()).finally(() => clearTimeout(timer));
    });
  }

  /** The synchronous bootstrap reaches listen before Chromium starts the network service. */
  bind(): Promise<boolean> {
    return new Promise(resolve => {
      const failed = () => resolve(false);
      this.server.once('error', failed);
      this.server.listen(0, LOOPBACK, () => {
        this.server.removeListener('error', failed);
        this.server.on('error', () => this.reportFailure());
        const address = this.server.address();
        if (!address || typeof address === 'string' ||
            address.port === BROWSER_AUTHENTICATION_LOCAL_PORT || app.isReady()) {
          resolve(false);
          return;
        }
        let rollback: (() => void) | undefined;
        try {
          rollback = installBrowserTransportRequestGuard(address.port);
          const { hostname } = BROWSER_AUTHENTICATION_LOCAL_ENDPOINT;
          app.commandLine.appendSwitch(
            HOST_RULES,
            `MAP ${hostname}:${BROWSER_AUTHENTICATION_LOCAL_PORT} ${LOOPBACK}:${address.port}`,
          );
          this.mapped = true;
          this.server.unref();
          resolve(true);
        } catch {
          rollback?.();
          resolve(false);
        }
      });
    });
  }

  private reportFailure(): void {
    if (this.retired || this.reportedFailure) return;
    this.reportedFailure = true;
    console.warn('[BrowserAuthentication] The local authentication transport is unavailable.');
  }

  private async forward(socket: Socket): Promise<void> {
    if (!(await this.owner.authorize(socket)) || socket.destroyed || this.retired) {
      socket.destroy();
      return;
    }
    const relay = await this.getRelay();
    if (!relay || !relay.child.connected || this.retired || socket.destroyed || isStorageExecutionFrozen()) {
      socket.destroy();
      return;
    }
    await new Promise<void>(resolve => {
      relay.child.send(CONNECT, socket, error => {
        this.pending.delete(socket);
        if (error) socket.destroy();
        resolve();
      });
    });
  }

  private getRelay(): Promise<RelayProcess | undefined> {
    if (this.starting) return this.starting;
    if (this.child?.child.connected) return Promise.resolve(this.child);
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<RelayProcess | undefined> {
    if (this.child) await this.stopChild(this.child);
    if (this.retired || isStorageExecutionFrozen()) return;
    if (!(await matchesApplication(this.executable))) {
      this.reportFailure();
      return;
    }
    if (this.retired || isStorageExecutionFrozen()) return;

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key)),
    );
    const child = spawn(this.executable, [this.relayPath, String(BROWSER_AUTHENTICATION_LOCAL_PORT)], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: path.dirname(this.executable),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    const started = Promise.withResolvers<boolean>();
    const exited = new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });
    const relay: RelayProcess = { child, exited };
    this.child = relay;
    void exited.then(() => {
      started.resolve(false);
      if (this.child === relay) this.child = undefined;
    });
    child.once('message', value => started.resolve(value === 'ready'));
    child.once('disconnect', () => started.resolve(false));
    child.on('error', () => started.resolve(false));

    const timer = setTimeout(() => started.resolve(false), CHILD_START_TIMEOUT_MS);
    try {
      if (await started.promise && child.connected && !this.retired) {
        this.reportedFailure = false;
        console.info(`[BrowserAuthentication] Local transport ready (${path.basename(this.executable)}).`);
        return relay;
      }
      this.reportFailure();
      await this.stopChild(relay);
    } finally {
      clearTimeout(timer);
    }
  }

  private stopChild(relay: RelayProcess): Promise<void> {
    relay.stop ??= (async () => {
      const { child, exited } = relay;
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill(), 1_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    })();
    return relay.stop;
  }

  stop(): Promise<void> {
    if (!this.stopped) {
      this.retired = true;
      for (const socket of this.pending) socket.destroy();
      // Chromium keeps the mapping until it exits. Never free the mapped port
      // while a late request could reach a different listener.
      if (!this.mapped) this.server.close();
      this.stopped = Promise.all([
        this.owner.stop(),
        this.child && this.stopChild(this.child),
        this.starting,
      ]).then(() => {});
    }
    return this.stopped;
  }
}

let transport: BrowserAuthenticationTransport | undefined;

/** Call only from the packaged desktop startup, before importing the application. */
export async function prepareBrowserAuthenticationTransport(): Promise<void> {
  if (
    !BROWSER_AUTHENTICATION_EXECUTABLE || process.platform !== 'win32' ||
    !app.isPackaged || app.isReady() || transport ||
    app.commandLine.hasSwitch(HOST_RULES) || app.commandLine.hasSwitch('host-rules') ||
    path.basename(process.execPath).toLowerCase() === BROWSER_AUTHENTICATION_EXECUTABLE
  ) return;

  const executable = path.join(path.dirname(process.execPath), BROWSER_AUTHENTICATION_EXECUTABLE);
  const relayPath = path.join(process.resourcesPath, 'browser-transport', 'relay.cjs');
  try {
    const alias = lstatSync(executable);
    if (!alias.isFile() || alias.size !== lstatSync(process.execPath).size ||
        !lstatSync(relayPath).isFile()) return;
  } catch {
    return;
  }
  const candidate = new BrowserAuthenticationTransport(executable, relayPath);
  if (await candidate.bind().catch(() => false)) {
    transport = candidate;
    // Also covers early exits before the full application cleanup is registered.
    process.once('exit', () => { void candidate.stop(); });
  } else await candidate.stop();
}

export async function stopBrowserAuthenticationTransport(): Promise<void> {
  await transport?.stop();
}

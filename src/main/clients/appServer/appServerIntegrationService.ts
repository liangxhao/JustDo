import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  type AppServerConnectionConfig,
  AppServerIntegrationFailure,
  type AppServerIntegrationStatus,
} from '../../../shared/integrations/appServerIntegration';
import { ExternalAgentStreamError } from '../shared/externalAgentTypes';
import type { AppServerSettings, AppServerSettingsStore } from './appServerSettingsStore';
import type { AppServerSessionManager } from './client/appServerSessionManager';
import {
  AppServerWebSocketServer,
  type AppServerWebSocketServerOptions,
} from './protocol/appServerWebSocketServer';

type Server = Pick<AppServerWebSocketServer, 'running' | 'start' | 'stop' | 'getUrl'>;

interface Options {
  getDefaultCwd: () => string;
  sessionManager: Pick<AppServerSessionManager, 'connect'>;
  settings: Pick<AppServerSettingsStore, 'get' | 'setPort' | 'regenerateToken'>;
  createServer?: (options: AppServerWebSocketServerOptions) => Server;
}

interface Lease {
  generation: number;
  token: string;
  port: number;
  ready: boolean;
  server: Server;
  start: Promise<void>;
  drain?: Promise<void>;
}

const unavailable = (): Error => new Error('Application WebSocket service is not running.');

const isAuthorized = (request: IncomingMessage, token: string): boolean => {
  // This endpoint accepts native-client credentials without an Origin.
  if (request.headers.origin !== undefined) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const supplied = /^Bearer[ \t]+([^\s]+)$/iu.exec(authorization)?.[1];
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(token, 'utf8');
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
};

/** Owns a native-client credential and its fixed server-admitted capabilities. */
export class AppServerIntegrationService {
  private generation = 0;
  private lease: Lease | undefined;
  private stopping: Promise<void> | undefined;
  private failure: AppServerIntegrationStatus['failure'];

  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    if (this.lease?.generation === this.generation) return this.lease.start;
    let settings: AppServerSettings;
    try {
      settings = this.options.settings.get();
    } catch {
      this.failure = AppServerIntegrationFailure.Unavailable;
      return Promise.reject(new Error('Application connection settings are unavailable.'));
    }
    const previousStop = this.stopping;
    const lease = {
      generation: this.generation,
      token: settings.token,
      port: settings.port,
      ready: false,
      start: Promise.resolve(),
    } as Lease;
    const owns = () => this.lease === lease && lease.generation === this.generation;
    lease.server = (this.options.createServer ?? (options => new AppServerWebSocketServer(options)))({
      authorize: request => owns() && lease.ready && isAuthorized(request, lease.token),
      createConnection: send => {
        if (!owns() || !lease.ready) throw unavailable();
        return this.options.sessionManager.connect(this.options.getDefaultCwd(), {}, send);
      },
      createTransportError: message => new ExternalAgentStreamError(message),
      port: lease.port,
    });
    this.failure = undefined;
    this.lease = lease;
    lease.start = Promise.resolve().then(async () => {
      try {
        if (previousStop) await previousStop;
        if (!owns()) return;
        await lease.server.start();
        if (!owns()) {
          await this.drain(lease);
          return;
        }
        lease.ready = true;
      } catch (error) {
        if (owns()) {
          this.failure = (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
            ? AppServerIntegrationFailure.PortInUse
            : AppServerIntegrationFailure.Unavailable;
        }
        lease.ready = false;
        try {
          await this.drain(lease);
        } finally {
          if (owns()) this.lease = undefined;
        }
        throw error;
      }
    });
    return lease.start;
  }

  stop(): Promise<void> {
    this.generation += 1;
    const lease = this.lease;
    // Revoke discovery and handshake authority before waiting for native cleanup.
    this.lease = undefined;
    const previousStop = this.stopping;
    if (!lease) return previousStop ?? Promise.resolve();
    lease.ready = false;
    const completion = Promise.all([
      previousStop,
      this.drain(lease),
      lease.start.catch(() => {}),
    ]).then(() => {});
    const stopping = completion.finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    this.stopping = stopping;
    return stopping;
  }

  getStatus(): AppServerIntegrationStatus {
    const settings = this.options.settings.get();
    const lease = this.current();
    return {
      running: Boolean(lease),
      url: lease?.server.getUrl() ?? '',
      configuredPort: settings.port,
      restartRequired: Boolean(lease && (lease.port !== settings.port || lease.token !== settings.token)),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  setPort(port: number): AppServerIntegrationStatus {
    this.options.settings.setPort(port);
    return this.getStatus();
  }

  regenerateToken(): AppServerIntegrationStatus {
    this.options.settings.regenerateToken();
    return this.getStatus();
  }

  getConnectionConfig(): AppServerConnectionConfig {
    const lease = this.current();
    if (!lease) throw unavailable();
    return { url: lease.server.getUrl(), headers: { Authorization: `Bearer ${lease.token}` } };
  }

  private current(): Lease | undefined {
    const lease = this.lease;
    return lease?.ready && lease.generation === this.generation && lease.server.running
      ? lease
      : undefined;
  }

  private drain(lease: Lease): Promise<void> {
    lease.drain ??= lease.server.stop();
    return lease.drain;
  }
}

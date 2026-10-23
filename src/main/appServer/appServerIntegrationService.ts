import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type {
  AppServerConnectionConfig,
  AppServerIntegrationStatus,
} from '../../shared/integrations/appServerIntegration';
import type { AgentCommandService } from '../integrations/externalAgent/agentCommandService';
import { ExternalAgentStreamError } from '../integrations/externalAgent/externalAgentTypes';
import {
  AppServerWebSocketServer,
  type AppServerWebSocketServerOptions,
} from './appServerWebSocketServer';

type Server = Pick<AppServerWebSocketServer, 'running' | 'start' | 'stop' | 'getUrl'>;

interface Options {
  getDefaultCwd: () => string;
  commandService: Pick<AgentCommandService, 'connectAppServer'>;
  createServer?: (options: AppServerWebSocketServerOptions) => Server;
}

interface Lease {
  generation: number;
  token: string;
  ready: boolean;
  server: Server;
  start: Promise<void>;
  drain?: Promise<void>;
}

const unavailable = (): Error => new Error('Application WebSocket service is not running.');

const isAuthorized = (request: IncomingMessage, token: string): boolean => {
  // This endpoint is for native clients. Chrome uses its own authenticated binding.
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

/** Owns a native-client credential; it never grants Chrome-specific capabilities. */
export class AppServerIntegrationService {
  private generation = 0;
  private lease: Lease | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    if (this.lease?.generation === this.generation) return this.lease.start;
    const previousStop = this.stopping;
    const lease = {
      generation: this.generation,
      token: randomBytes(32).toString('hex'),
      ready: false,
      start: Promise.resolve(),
    } as Lease;
    const owns = () => this.lease === lease && lease.generation === this.generation;
    lease.server = (this.options.createServer ?? (options => new AppServerWebSocketServer(options)))({
      authorize: request => owns() && lease.ready && isAuthorized(request, lease.token),
      createConnection: send => {
        if (!owns() || !lease.ready) throw unavailable();
        return this.options.commandService.connectAppServer(this.options.getDefaultCwd(), send);
      },
      createTransportError: message => new ExternalAgentStreamError(message),
    });
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
    const lease = this.current();
    return { running: Boolean(lease), url: lease?.server.getUrl() ?? '' };
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

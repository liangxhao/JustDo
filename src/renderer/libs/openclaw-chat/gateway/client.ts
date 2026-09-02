/**
 * Gateway WebSocket client.
 * Simplified version of OpenClaw's GatewayBrowserClient.
 *
 * Protocol:
 *   Request:  { type: "req", id: string, method: string, params: unknown }
 *   Response: { type: "res", id: string, ok: boolean, payload?: unknown, error?: {...} }
 *   Event:    { type: "event", event: string, payload?: unknown, seq?: number }
 *
 * Connection handshake:
 *   1. WebSocket open → wait for "connect.challenge" event (750ms timeout)
 *   2. Send "connect" request with auth token
 *   3. Receive "hello-ok" response
 */

import { PRODUCT_NAME } from '@shared/productMetadata';

import {
  buildGatewayDeviceAuthPayload,
  loadOrCreateGatewayDeviceIdentity,
} from './device-identity';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GatewayClientOptions {
  url: string;
  token?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (event: GatewayEventFrame) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onClose?: (info: { code: number; reason: string }) => void;
}

export interface GatewayEventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

export interface GatewayResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface GatewayHelloOk {
  type: 'hello-ok';
  protocol: number;
  server?: unknown;
  features?: unknown;
  auth?: { role?: string; scopes?: string[] };
  policy?: { tickIntervalMs?: number };
}

export interface GatewayRequestError extends Error {
  gatewayCode: string;
  retryable: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CHALLENGE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 90_000;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_FACTOR = 1.7;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const TICK_TIMEOUT_GRACE_MS = 5_000;
const MIN_TICK_TIMEOUT_MS = 65_000;

export function resolveGatewayTickTimeoutMs(tickIntervalMs: number): number {
  return Math.max(MIN_TICK_TIMEOUT_MS, tickIntervalMs * 2 + TICK_TIMEOUT_GRACE_MS);
}

// ─── GatewayClient ──────────────────────────────────────────────────────────

export class GatewayClient {
  private opts: GatewayClientOptions;
  private ws: WebSocket | null = null;
  private closed = false;
  private connectGeneration = 0;
  private backoffMs = RECONNECT_BASE_MS;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private tickWatchTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt: number | null = null;
  private tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
  private pendingRequests = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private lastSeq: number | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.closed = false;
    globalThis.document?.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    globalThis.document?.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.flushPending(new Error('gateway client stopped'));
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected');
    }
    const id = generateId();
    const frame = JSON.stringify({ type: 'req', id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws!.send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Retire the current transport so the next connection can recover from history. */
  recoverFromGap(reason = 'event sequence gap'): void {
    const socket = this.ws;
    if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    // Retire the owner synchronously. WebSocket.close() is asynchronous and
    // queued frames can otherwise reach the message listener before `close`.
    // The close listener still owns cleanup/reconnect because `this.ws` stays
    // attached to this socket until that callback runs.
    this.connectGeneration += 1;
    socket.close(4000, reason);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return;
    // Gateway frame sequences are scoped to a single WebSocket generation.
    // Keeping the previous connection's value causes a fresh server stream to
    // be mistaken for stale or missing data after reconnect.
    this.lastSeq = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const generation = ++this.connectGeneration;
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (!this.isActive(ws, generation)) return;
      this.challengeTimer = setTimeout(() => {
        if (this.isActive(ws, generation)) ws.close(1008, 'connect challenge timeout');
      }, CHALLENGE_TIMEOUT_MS);
    });

    ws.addEventListener('message', ev => {
      if (!this.isActive(ws, generation)) return;
      this.handleMessage(ws, generation, String(ev.data ?? ''));
    });

    ws.addEventListener('close', ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopTickWatch();
      this.flushPending(new Error(`gateway closed (${ev.code})`));
      this.opts.onClose?.({ code: ev.code, reason: ev.reason ?? '' });
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close handler fires after
    });
  }

  private handleMessage(ws: WebSocket, generation: number, raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    this.lastFrameAt = Date.now();

    // Event frame
    if (frame.type === 'event') {
      const event = frame as unknown as GatewayEventFrame;
      // Handle challenge
      if (event.event === 'connect.challenge') {
        clearTimeout(this.challengeTimer!);
        const payload = event.payload as Record<string, unknown> | undefined;
        const nonce = typeof payload?.nonce === 'string' ? payload.nonce : '';
        const challengeTs = payload?.ts;
        if (
          !nonce ||
          typeof challengeTs !== 'number' ||
          !Number.isSafeInteger(challengeTs) ||
          challengeTs < 0
        ) {
          ws.close(1008, 'invalid connect challenge');
          return;
        }
        void this.sendConnect(ws, generation, nonce, challengeTs).catch(() => {
          if (this.isActive(ws, generation)) ws.close(1008, 'device identity unavailable');
        });
        return;
      }
      if (typeof event.seq === 'number') {
        if (this.lastSeq !== null) {
          // Gateway event sequences are a per-connection high-water mark.
          // Replayed or out-of-order frames must not be delivered and, more
          // importantly, must not rewind the mark used for the next gap check.
          if (event.seq <= this.lastSeq) return;
          if (event.seq > this.lastSeq + 1) {
            const expected = this.lastSeq + 1;
            this.opts.onGap?.({ expected, received: event.seq });
            // Do not apply a frame after a proven transport gap. Reconnect so
            // chat.history can replace persisted rows and replay inFlightRun.
            if (this.isActive(ws, generation)) {
              this.recoverFromGap('gateway event sequence gap');
            }
            return;
          }
        }
        this.lastSeq = event.seq;
      }
      this.opts.onEvent?.(event);
      return;
    }

    // Response frame
    if (frame.type === 'res') {
      const res = frame as unknown as GatewayResponseFrame;
      const pending = this.pendingRequests.get(res.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(res.id);
        if (res.ok) {
          pending.resolve(res.payload);
        } else {
          const err = new Error(res.error?.message ?? 'request failed') as GatewayRequestError;
          err.gatewayCode = res.error?.code ?? 'UNKNOWN';
          err.retryable = res.error?.retryable === true;
          pending.reject(err);
        }
      }
      return;
    }
  }

  private async sendConnect(
    ws: WebSocket,
    generation: number,
    nonce: string,
    challengeTs: number,
  ): Promise<void> {
    if (!this.isActive(ws, generation)) return;
    const client = {
      id: 'openclaw-control-ui',
      displayName: PRODUCT_NAME,
      version: 'control-ui',
      platform: navigator.platform,
      mode: 'webchat',
    };
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.read', 'operator.write'];
    const identity = await loadOrCreateGatewayDeviceIdentity();
    if (!this.isActive(ws, generation)) return;
    const signaturePayload = buildGatewayDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role,
      scopes,
      signedAtMs: challengeTs,
      token: this.opts.token,
      nonce,
      platform: client.platform,
    });
    const connectParams: Record<string, unknown> = {
      minProtocol: 4,
      maxProtocol: 4,
      client,
      role,
      scopes,
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signature: await identity.sign(signaturePayload),
        signedAt: challengeTs,
        nonce,
      },
      caps: ['tool-events'],
    };

    if (!this.isActive(ws, generation)) return;

    if (this.opts.token) {
      connectParams.auth = { token: this.opts.token };
    }

    const id = generateId();
    const frame = JSON.stringify({ type: 'req', id, method: 'connect', params: connectParams });

    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
    }, 15_000);

    this.pendingRequests.set(id, {
      resolve: payload => {
        this.backoffMs = RECONNECT_BASE_MS;
        const hello = payload as GatewayHelloOk;
        const advertisedTickInterval = hello.policy?.tickIntervalMs;
        this.tickIntervalMs =
          typeof advertisedTickInterval === 'number' &&
          Number.isFinite(advertisedTickInterval) &&
          advertisedTickInterval > 0
            ? advertisedTickInterval
            : DEFAULT_TICK_INTERVAL_MS;
        this.lastFrameAt = Date.now();
        this.startTickWatch();
        this.opts.onHello?.(hello);
      },
      reject: () => {
        // Connect failed, will reconnect via close handler
      },
      timer,
    });

    try {
      ws.send(frame);
    } catch {
      clearTimeout(timer);
      this.pendingRequests.delete(id);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * RECONNECT_FACTOR, RECONNECT_MAX_MS);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  private isActive(ws: WebSocket, generation: number): boolean {
    return this.ws === ws && this.connectGeneration === generation;
  }

  private clearTimers(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.challengeTimer) {
      clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
    }
    this.stopTickWatch();
  }

  private readonly handleVisibilityChange = (): void => {
    if (!globalThis.document?.hidden) this.lastFrameAt = Date.now();
  };

  private startTickWatch(): void {
    this.stopTickWatch();
    this.tickWatchTimer = setInterval(() => {
      if (
        this.closed ||
        globalThis.document?.hidden ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN ||
        this.lastFrameAt === null
      ) {
        return;
      }
      if (Date.now() - this.lastFrameAt > resolveGatewayTickTimeoutMs(this.tickIntervalMs)) {
        const stalledSocket = this.ws;
        this.stopTickWatch();
        stalledSocket.close(4000, 'tick timeout');
      }
    }, this.tickIntervalMs);
  }

  private stopTickWatch(): void {
    if (!this.tickWatchTimer) return;
    clearInterval(this.tickWatchTimer);
    this.tickWatchTimer = null;
  }

  private flushPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return `justdo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

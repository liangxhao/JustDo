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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GatewayClientOptions {
  url: string;
  token?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (event: GatewayEventFrame) => void;
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
}

export interface GatewayRequestError extends Error {
  gatewayCode: string;
  retryable: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CHALLENGE_TIMEOUT_MS = 750;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_FACTOR = 1.7;

// ─── GatewayClient ──────────────────────────────────────────────────────────

export class GatewayClient {
  private opts: GatewayClientOptions;
  private ws: WebSocket | null = null;
  private closed = false;
  private connectGeneration = 0;
  private backoffMs = RECONNECT_BASE_MS;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private lastSeq = 0;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
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
      }, 30_000);
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.ws!.send(frame);
    });
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return;
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
      // Wait for challenge, then send connect
      this.challengeTimer = setTimeout(() => {
        this.sendConnect(ws, generation, null);
      }, CHALLENGE_TIMEOUT_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (!this.isActive(ws, generation)) return;
      this.handleMessage(ws, generation, String(ev.data ?? ''));
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
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

    // Event frame
    if (frame.type === 'event') {
      const event = frame as unknown as GatewayEventFrame;
      if (typeof event.seq === 'number' && event.seq > this.lastSeq) {
        this.lastSeq = event.seq;
      }
      // Handle challenge
      if (event.event === 'connect.challenge') {
        clearTimeout(this.challengeTimer!);
        const nonce = (event.payload as Record<string, unknown>)?.nonce as string | null;
        this.sendConnect(ws, generation, nonce);
        return;
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

  private sendConnect(ws: WebSocket, _generation: number, _nonce: string | null): void {
    const connectParams: Record<string, unknown> = {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: 'openclaw-control-ui',
        displayName: 'JustDo',
        version: 'control-ui',
        platform: navigator.platform,
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      caps: ['tool-events'],
    };

    if (this.opts.token) {
      connectParams.auth = { token: this.opts.token };
    }

    const id = generateId();
    const frame = JSON.stringify({ type: 'req', id, method: 'connect', params: connectParams });

    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
    }, 15_000);

    this.pendingRequests.set(id, {
      resolve: (payload) => {
        this.backoffMs = RECONNECT_BASE_MS;
        this.opts.onHello?.(payload as GatewayHelloOk);
      },
      reject: () => {
        // Connect failed, will reconnect via close handler
      },
      timer,
    });

    ws.send(frame);
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
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.challengeTimer) { clearTimeout(this.challengeTimer); this.challengeTimer = null; }
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

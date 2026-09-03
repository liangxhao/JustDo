import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayClient, resolveGatewayTickTimeoutMs } from './client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('resolveGatewayTickTimeoutMs', () => {
  it('allows jitter around the standard gateway tick interval', () => {
    expect(resolveGatewayTickTimeoutMs(30_000)).toBe(65_000);
  });

  it('keeps a safe minimum for unusually frequent ticks', () => {
    expect(resolveGatewayTickTimeoutMs(1_000)).toBe(65_000);
  });

  it('scales for gateways that advertise a slower tick interval', () => {
    expect(resolveGatewayTickTimeoutMs(60_000)).toBe(125_000);
  });
});

describe('GatewayClient tick watchdog', () => {
  it('closes a silent socket once after two missed standard ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const close = vi.fn();
    const client = new GatewayClient({ url: 'ws://gateway.test' });
    const internals = client as unknown as {
      closed: boolean;
      ws: { readyState: number; close: typeof close };
      lastFrameAt: number;
      tickIntervalMs: number;
      startTickWatch(): void;
    };
    internals.closed = false;
    internals.ws = { readyState: 1, close };
    internals.lastFrameAt = 0;
    internals.tickIntervalMs = 30_000;

    internals.startTickWatch();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(4000, 'tick timeout');
  });

  it('pauses timeout detection while the document is hidden', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', { hidden: true });
    const close = vi.fn();
    const client = new GatewayClient({ url: 'ws://gateway.test' });
    const internals = client as unknown as {
      closed: boolean;
      ws: { readyState: number; close: typeof close };
      lastFrameAt: number;
      tickIntervalMs: number;
      startTickWatch(): void;
      stopTickWatch(): void;
    };
    internals.closed = false;
    internals.ws = { readyState: 1, close };
    internals.lastFrameAt = 0;
    internals.tickIntervalMs = 30_000;

    internals.startTickWatch();
    await vi.advanceTimersByTimeAsync(120_000);
    internals.stopTickWatch();

    expect(close).not.toHaveBeenCalled();
  });
});

describe('GatewayClient v2026.8.2 handshake', () => {
  it('signs the server challenge with a persistent browser device identity', async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      readonly sent: string[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent | CloseEvent) => void>>();
      readyState = FakeWebSocket.OPEN;
      close = vi.fn();

      addEventListener(type: string, listener: (event: MessageEvent | CloseEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(frame: string): void {
        this.sent.push(frame);
      }

      emit(type: string, event: MessageEvent | CloseEvent): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const client = new GatewayClient({ url: 'ws://gateway.test', token: 'token' });
    client.start();
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    socket.emit('open', {} as MessageEvent);
    socket.emit('message', {
      data: JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce', ts: 123 },
      }),
    } as MessageEvent);

    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const frame = JSON.parse(socket.sent[0]) as {
      method: string;
      params: {
        client: { id: string; mode: string };
        device: {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce: string;
        };
      };
    };

    expect(frame.method).toBe('connect');
    expect(frame.params.client).toMatchObject({ id: 'openclaw-control-ui', mode: 'webchat' });
    expect(frame.params.device).toMatchObject({ signedAt: 123, nonce: 'nonce' });
    expect(frame.params.device.id).toHaveLength(64);
    expect(frame.params.device.publicKey).not.toBe('');
    expect(frame.params.device.signature).not.toBe('');
    client.stop();
  });
});

describe('GatewayClient request errors', () => {
  it('preserves structured Gateway error details for policy-aware callers', async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      readonly sent: string[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent | CloseEvent) => void>>();
      readyState = FakeWebSocket.OPEN;
      close = vi.fn();

      addEventListener(type: string, listener: (event: MessageEvent | CloseEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(frame: string): void {
        this.sent.push(frame);
      }

      emit(type: string, event: MessageEvent | CloseEvent): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new GatewayClient({ url: 'ws://gateway.test' });
    client.start();
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    const request = client.request('progressCard.get', { sessionKey: 'agent:main:main' });
    const requestId = (JSON.parse(socket.sent[0]) as { id: string }).id;

    socket.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: requestId,
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'participation required',
          details: { code: 'SESSION_PARTICIPATION_REQUIRED' },
        },
      }),
    } as MessageEvent);

    await expect(request).rejects.toMatchObject({
      gatewayCode: 'INVALID_REQUEST',
      details: { code: 'SESSION_PARTICIPATION_REQUIRED' },
    });
    client.stop();
  });
});

describe('GatewayClient sequence recovery', () => {
  it('drops duplicate and regressive frames without rewinding the connection high-water mark', () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly sockets: FakeWebSocket[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent | CloseEvent) => void>>();
      readyState = FakeWebSocket.OPEN;
      close = vi.fn();

      constructor(_url: string) {
        FakeWebSocket.sockets.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent | CloseEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(): void {}

      emit(type: string, event: MessageEvent | CloseEvent): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onEvent = vi.fn();
    const onGap = vi.fn();
    const client = new GatewayClient({ url: 'ws://gateway.test', onEvent, onGap });
    client.start();
    const socket = FakeWebSocket.sockets[0];

    for (const seq of [7, 7, 6, 8]) {
      socket.emit('message', {
        data: JSON.stringify({ type: 'event', event: 'agent', seq, payload: { seq } }),
      } as MessageEvent);
    }

    expect(onEvent.mock.calls.map(([event]) => event.seq)).toEqual([7, 8]);
    expect(onGap).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    client.stop();
  });

  it('retires a gapped socket and resets the outer sequence for its replacement', async () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static readonly sockets: FakeWebSocket[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent | CloseEvent) => void>>();
      readyState = FakeWebSocket.OPEN;
      close = vi.fn(() => {
        this.readyState = FakeWebSocket.CLOSING;
      });

      constructor(_url: string) {
        FakeWebSocket.sockets.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent | CloseEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(): void {}

      emit(type: string, event: MessageEvent | CloseEvent): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onEvent = vi.fn();
    const onGap = vi.fn();
    const client = new GatewayClient({ url: 'ws://gateway.test', onEvent, onGap });
    client.start();
    const first = FakeWebSocket.sockets[0];

    first.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'agent', seq: 7, payload: {} }),
    } as MessageEvent);
    first.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'agent', seq: 9, payload: {} }),
    } as MessageEvent);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onGap).toHaveBeenCalledWith({ expected: 8, received: 9 });
    expect(first.close).toHaveBeenCalledWith(4000, 'gateway event sequence gap');

    first.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'agent', seq: 8, payload: {} }),
    } as MessageEvent);
    expect(onEvent).toHaveBeenCalledTimes(1);

    first.emit('close', { code: 4000, reason: 'gateway event sequence gap' } as CloseEvent);
    await vi.advanceTimersByTimeAsync(800);
    const replacement = FakeWebSocket.sockets[1];
    replacement.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'agent', seq: 40, payload: {} }),
    } as MessageEvent);

    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(2);
    client.stop();
  });
});

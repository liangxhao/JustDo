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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../core/i18n';
import { GATEWAY_STARTUP_WAIT_MS, waitForGatewayStartup } from './gatewayStartup';

function response(status: number, value: unknown) {
  return new Response(JSON.stringify(value), { status });
}

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, { ok: true, status: 'started' }));
  vi.stubGlobal('fetch', fetch);
  const assertCurrent = vi.fn<() => void>();
  const wait = () => waitForGatewayStartup({ port: 12345, assertCurrent });
  const hang = () => fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  return { fetch, assertCurrent, wait, hang };
}

describe('native Gateway startup observation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    const timers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(timers).toBe(0);
  });

  it('uses only the fixed loopback startup probe and rejects redirects', async () => {
    const f = fixture();
    await f.wait();
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:12345/startupz', {
      redirect: 'error', signal: expect.any(AbortSignal),
    });
  });

  it('keeps waiting while sidecars and other agents are still preparing', async () => {
    const f = fixture();
    f.fetch
      .mockResolvedValueOnce(response(503, { ok: false, status: 'starting', pendingReason: 'startup-sidecars' }))
      .mockResolvedValueOnce(response(503, { ok: false, status: 'starting', pendingReason: 'agent-database-inspection' }));
    let complete = false;
    const waiting = f.wait().then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(complete).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    expect(complete).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [200, { ok: true, status: 'live' }],
    [200, { ready: true }],
    [200, { ok: false, status: 'starting' }],
    [503, { ok: true, status: 'started' }],
    [503, { ok: false, status: 'draining' }],
    [404, { ok: true, status: 'started' }],
    [200, null],
  ])('rejects status %s with invalid startup evidence %j', async (status, value) => {
    const f = fixture();
    f.fetch.mockResolvedValue(response(status, value));
    await expect(f.wait()).rejects.toThrow(t('gatewayStartupUnconfirmed'));
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole wait instead of resetting its deadline on each pending response', async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => response(503, { ok: false, status: 'starting' }));
    const waiting = f.wait().catch(error => error);
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_WAIT_MS);
    expect(await waiting).toEqual(new Error(t('gatewayStartupUnconfirmed')));
    const count = f.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });

  it('retries a timed out startup read within the same total deadline', async () => {
    const f = fixture();
    f.hang();
    const waiting = f.wait();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    f.fetch.mockResolvedValue(response(200, { ok: true, status: 'started' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['request', 'backoff'] as const)('stops when ownership changes during %s', async stage => {
    const f = fixture();
    if (stage === 'request') f.hang();
    else f.fetch.mockResolvedValue(response(503, { ok: false, status: 'starting' }));
    const waiting = f.wait().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const changed = new Error('App workspace changed during preparation');
    f.assertCurrent.mockImplementation(() => { throw changed; });
    await vi.advanceTimersByTimeAsync(250);
    expect(await waiting).toBe(changed);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('checks ownership again after a successful response', async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => {
      f.assertCurrent.mockImplementation(() => { throw new Error('Changed'); });
      return response(200, { ok: true, status: 'started' });
    });
    await expect(f.wait()).rejects.toThrow('Changed');
  });
});

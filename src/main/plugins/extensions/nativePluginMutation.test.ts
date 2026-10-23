import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestNativePluginMutation } from './nativePluginMutation';

const busy = (metadata: Record<string, unknown> = {}) =>
  Object.assign(
    new Error('Another plugin or config operation is already running; retry when it completes.'),
    { code: 'UNAVAILABLE', gatewayCode: 'UNAVAILABLE', retryable: true, retryAfterMs: 1000 },
    metadata,
  );

describe('native plugin mutation admission', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('waits for explicit not-entered admission and preserves the remaining request budget', async () => {
    const request = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue({ ok: true });

    const pending = requestNativePluginMutation(request, { timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(request.mock.calls).toEqual([
      [{ timeoutMs: 600_000 }],
      [{ timeoutMs: 599_000, assertBeforeSend: expect.any(Function) }],
    ]);
  });

  it('counts time already spent in the refused request against the total deadline', async () => {
    const refusal = busy();
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        throw refusal;
      })
      .mockResolvedValue({ ok: true });

    const pending = requestNativePluginMutation(request, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(request.mock.calls[1][0]).toEqual({
      timeoutMs: 7000,
      assertBeforeSend: expect.any(Function),
    });
  });

  it('returns the native refusal when the next delay would exhaust the request budget', async () => {
    const refusal = busy();
    const request = vi.fn().mockRejectedValue(refusal);

    await expect(requestNativePluginMutation(request, { timeoutMs: 1000 })).rejects.toBe(refusal);
    expect(request).toHaveBeenCalledOnce();
  });

  it('caps admission waits at thirty seconds even for a long installation timeout', async () => {
    const refusal = busy({ retryAfterMs: 10_000 });
    const request = vi.fn().mockRejectedValue(refusal);
    const pending = requestNativePluginMutation(request, { timeoutMs: 600_000 });
    const settled = expect(pending).rejects.toBe(refusal);
    await vi.advanceTimersByTimeAsync(30_000);

    await settled;
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0]).toEqual({
      timeoutMs: 580_000,
      assertBeforeSend: expect.any(Function),
    });
  });

  it('does not send to a replacement owner after waiting', async () => {
    const refusal = busy();
    const request = vi.fn().mockRejectedValue(refusal);
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const pending = requestNativePluginMutation(request, undefined, isCurrent);
    const settled = expect(pending).rejects.toBe(refusal);
    await vi.advanceTimersByTimeAsync(1000);

    await settled;
    expect(request).toHaveBeenCalledOnce();
  });

  it('refuses dispatch if the owner changes while request readiness is pending', async () => {
    const refusal = busy();
    let current = true;
    let dispatches = 0;
    const request = vi.fn(async options => {
      if (dispatches === 0) {
        dispatches += 1;
        throw refusal;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      options.assertBeforeSend();
      dispatches += 1;
      return true;
    });
    const pending = requestNativePluginMutation(request, undefined, () => current);
    const settled = expect(pending).rejects.toBe(refusal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    current = false;
    await vi.advanceTimersByTimeAsync(1000);

    await settled;
    expect(dispatches).toBe(1);
  });

  it('preserves a chained guard failure and the original first-call options', async () => {
    const refusal = busy();
    const guardError = new Error('Original admission guard failed');
    const assertBeforeSend = vi.fn(() => {
      throw guardError;
    });
    const original = { timeoutMs: 10_000, assertBeforeSend };
    const request = vi
      .fn()
      .mockRejectedValueOnce(refusal)
      .mockImplementation(options => {
        options.assertBeforeSend();
        return true;
      });
    const pending = requestNativePluginMutation(request, original);
    const settled = expect(pending).rejects.toBe(guardError);
    await vi.advanceTimersByTimeAsync(1000);

    await settled;
    expect(request.mock.calls[0][0]).toBe(original);
    expect(original).toEqual({ timeoutMs: 10_000, assertBeforeSend });
    expect(assertBeforeSend).toHaveBeenCalledOnce();
  });

  it('refreshes the remaining timeout immediately before native dispatch', async () => {
    let dispatchedTimeout: number | undefined;
    const request = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockImplementation(async options => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        options.assertBeforeSend();
        dispatchedTimeout = options.timeoutMs;
        return true;
      });
    const pending = requestNativePluginMutation(request, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBe(true);
    expect(dispatchedTimeout).toBe(7000);
  });

  it('yields on an explicit zero delay without spinning', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(busy({ retryAfterMs: 0 }))
      .mockResolvedValue(true);
    const pending = requestNativePluginMutation(request);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports admission waiting without letting progress callback failures change the result', async () => {
    const onAdmissionWait = vi.fn(() => {
      throw new Error('Progress failed');
    });
    const onAdmissionResume = vi.fn(() => {
      throw new Error('Progress failed');
    });
    const request = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue(true);
    const pending = requestNativePluginMutation(request, undefined, undefined, {
      onAdmissionWait,
      onAdmissionResume,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(true);
    expect(onAdmissionWait.mock.calls).toEqual([[]]);
    expect(onAdmissionResume.mock.calls).toEqual([[]]);
  });

  it.each([
    {
      name: 'transport timeout',
      error: Object.assign(new Error('timed out'), { code: 'CLIENT_TIMEOUT', requestSent: true }),
    },
    {
      name: 'transport close',
      error: Object.assign(new Error('client closed'), { code: 'CLIENT_CLOSED' }),
    },
    {
      name: 'another native diagnostic',
      error: Object.assign(new Error('Plugin failed'), {
        gatewayCode: 'UNAVAILABLE',
        retryable: true,
        retryAfterMs: 1,
      }),
    },
    {
      name: 'another native code',
      error: busy({ code: 'INVALID_REQUEST', gatewayCode: 'INVALID_REQUEST' }),
    },
    { name: 'conflicting codes', error: busy({ code: 'CLIENT_TIMEOUT' }) },
    { name: 'nonretryable refusal', error: busy({ retryable: false }) },
    { name: 'invalid delay', error: busy({ retryAfterMs: Number.NaN }) },
    { name: 'negative delay', error: busy({ retryAfterMs: -1 }) },
    { name: 'missing delay', error: busy({ retryAfterMs: undefined }) },
    { name: 'committed mutation', error: busy({ committed: true }) },
    { name: 'saved installation', error: busy({ installationCommitted: true }) },
    { name: 'unknown operation', error: busy({ operationUnconfirmed: true }) },
    {
      name: 'native persistence',
      error: busy({ details: { persistence: { operation: 'install', pluginId: 'sample' } } }),
    },
    { name: 'runtime commit', error: busy({ details: { runtime: { committed: true } } }) },
    { name: 'runtime attempt', error: busy({ details: { runtimeAttempt: { committed: false } } }) },
  ])('never repeats $name', async ({ error }) => {
    const request = vi.fn().mockRejectedValue(error);
    await expect(requestNativePluginMutation(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRuntimeSessionSnapshot,
  invalidateRuntimeSessionSnapshot,
  type RuntimeSessionStatusContext,
} from './runtimeSessionStatus';

function harness(request: ReturnType<typeof vi.fn>) {
  const context = {
    gatewayClient: { request },
    gatewayClientGeneration: 1,
    captureGatewayResponseContext: () => null,
    runtimeSessionSnapshot: null,
    runtimeSessionSnapshotGeneration: 0,
    runtimeSessionSnapshotPromise: null,
    runtimeSessionSnapshotQueuedRefresh: null,
    lastRuntimeStatusWarningAt: 0,
  } as unknown as RuntimeSessionStatusContext;
  Object.assign(context, { getRuntimeSessionSnapshot: getRuntimeSessionSnapshot.bind(context) });
  return context;
}

describe('compact runtime session snapshots', () => {
  it('requests compact rows while retaining native activity and exact identities', async () => {
    const row = { key: 'agent:main:session', sessionId: 'native-id', hasActiveRun: true };
    const request = vi.fn().mockResolvedValue({ sessions: [row], hasMore: false });
    const context = harness(request);
    await expect(getRuntimeSessionSnapshot.call(context)).resolves.toEqual({
      known: true, sessions: [row], hasMore: false,
    });
    expect(request).toHaveBeenCalledWith('sessions.list', { rowMode: 'compact', limit: 500 });
  });

  it('preserves full pagination and invalidates replies from an earlier generation', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ sessions: [{ key: 'first' }], hasMore: true })
      .mockResolvedValueOnce({ sessions: [{ key: 'second' }], hasMore: false });
    const context = harness(request);
    await expect(getRuntimeSessionSnapshot.call(context, false, true)).resolves.toMatchObject({
      known: true, sessions: [{ key: 'first' }, { key: 'second' }], hasMore: false,
    });
    expect(request).toHaveBeenLastCalledWith('sessions.list', {
      rowMode: 'compact', limit: 500, offset: 1,
    });

    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const stale = getRuntimeSessionSnapshot.call(context, true);
    invalidateRuntimeSessionSnapshot.call(context);
    resolve({ sessions: [{ key: 'obsolete', hasActiveRun: false }], hasMore: false });
    await expect(stale).resolves.toEqual({ known: false, sessions: [], hasMore: false });
    expect(context.runtimeSessionSnapshot).toBeNull();
  });

  it('shares one fresh follow-up for forced requests received during an in-flight read', async () => {
    const completions: Array<(value: unknown) => void> = [];
    const request = vi.fn(() => new Promise(resolve => { completions.push(resolve); }));
    const context = harness(request);
    const first = context.getRuntimeSessionSnapshot(true);
    const burst = Array.from({ length: 8 }, () => context.getRuntimeSessionSnapshot(true));
    expect(request).toHaveBeenCalledTimes(1);
    completions[0]({ sessions: [{ key: 'before-event' }], hasMore: false });
    await first;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    completions[1]({ sessions: [{ key: 'after-event' }], hasMore: false });
    for (const snapshot of await Promise.all(burst)) {
      expect(snapshot).toMatchObject({ known: true, sessions: [{ key: 'after-event' }] });
    }
    expect(request).toHaveBeenCalledTimes(2);
    await context.getRuntimeSessionSnapshot();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('upgrades a queued refresh to complete pagination for all waiting callers', async () => {
    let finishFirst!: (value: unknown) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ sessions: [{ key: 'root' }], hasMore: true })
      .mockResolvedValueOnce({ sessions: [{ key: 'child' }], hasMore: false });
    const context = harness(request);
    const first = context.getRuntimeSessionSnapshot();
    const partial = context.getRuntimeSessionSnapshot(true);
    const complete = context.getRuntimeSessionSnapshot(false, true);
    finishFirst({ sessions: [], hasMore: false });
    await first;
    for (const snapshot of await Promise.all([partial, complete])) {
      expect(snapshot).toMatchObject({
        known: true, sessions: [{ key: 'root' }, { key: 'child' }], hasMore: false,
      });
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith('sessions.list', {
      rowMode: 'compact', limit: 500, offset: 1,
    });
  });

  it('keeps another follow-up when changes arrive during the queued refresh', async () => {
    const completions: Array<(value: unknown) => void> = [];
    const request = vi.fn(() => new Promise(resolve => { completions.push(resolve); }));
    const context = harness(request);
    const first = context.getRuntimeSessionSnapshot();
    const second = context.getRuntimeSessionSnapshot(true);
    completions[0]({ sessions: [], hasMore: false });
    await first;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const latest = context.getRuntimeSessionSnapshot(true);
    completions[1]({ sessions: [{ key: 'middle' }], hasMore: false });
    await second;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    completions[2]({ sessions: [{ key: 'latest' }], hasMore: false });
    await expect(latest).resolves.toMatchObject({ sessions: [{ key: 'latest' }] });
  });

  it('discards an invalidated read and publishes only the shared newer generation', async () => {
    let finishFirst!: (value: unknown) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ sessions: [{ key: 'current' }], hasMore: false });
    const context = harness(request);
    const first = context.getRuntimeSessionSnapshot();
    const fresh = context.getRuntimeSessionSnapshot(true);
    invalidateRuntimeSessionSnapshot.call(context);
    finishFirst({ sessions: [{ key: 'old' }], hasMore: false });
    await expect(first).resolves.toMatchObject({ known: false, sessions: [] });
    await expect(fresh).resolves.toMatchObject({ known: true, sessions: [{ key: 'current' }] });
    expect(context.runtimeSessionSnapshot?.sessions).toEqual([{ key: 'current' }]);
  });

  it('does not suppress a queued refresh after an unavailable read', async () => {
    let failFirst!: (error: Error) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce({ sessions: [{ key: 'recovered' }], hasMore: false });
    const context = harness(request);
    context.lastRuntimeStatusWarningAt = Date.now();
    const first = context.getRuntimeSessionSnapshot();
    const fresh = context.getRuntimeSessionSnapshot(true);
    failFirst(new Error('Gateway unavailable'));
    await expect(first).resolves.toMatchObject({ known: false });
    await expect(fresh).resolves.toMatchObject({ known: true, sessions: [{ key: 'recovered' }] });
    expect(context.runtimeSessionSnapshotQueuedRefresh).toBeNull();
  });
});

describe('runtime snapshot recovery during plugin reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fixture(request: ReturnType<typeof vi.fn>) {
    const context = harness(request);
    const client = context.gatewayClient;
    const responses = new WeakSet<Error>();
    const error = Object.assign(new Error(
      'PluginInstanceUnavailableError: Plugin openai was reloaded or disabled; use its current tools.',
    ), { code: 'UNAVAILABLE', gatewayCode: 'UNAVAILABLE' });
    responses.add(error);
    const response = {
      isCurrent: () => context.gatewayClient === client && context.gatewayClientGeneration === 1,
      isResponseError: (value: unknown) => value instanceof Error && responses.has(value),
    };
    Object.assign(context, { captureGatewayResponseContext: vi.fn(() => response) });
    return { context, error, response };
  }

  it('discards all partial pages and shares one fresh scan after a retired-plugin rejection', async () => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockResolvedValueOnce({ sessions: [{ key: 'old' }], hasMore: true })
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ sessions: [{ key: 'new-root' }], hasMore: true })
      .mockResolvedValueOnce({ sessions: [{ key: 'new-child' }], hasMore: false });
    const reading = context.getRuntimeSessionSnapshot(false, true);
    const joined = context.getRuntimeSessionSnapshot();
    await vi.advanceTimersByTimeAsync(250);
    for (const result of await Promise.all([reading, joined])) {
      expect(result).toEqual({ known: true, sessions: [{ key: 'new-root' }, { key: 'new-child' }], hasMore: false });
    }
    expect(request.mock.calls.map(call => call[1].offset ?? 0)).toEqual([0, 1, 0, 1]);
    expect(request.mock.calls.slice(2).every(call => call[2].signal instanceof AbortSignal)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['local', 'plain-object', 'wrong-code', 'unrelated', 'timeout', 'disconnected', 'missing-facade', 'retired-facade'])(
    'does not retry a %s error or unverified response', async kind => {
      const request = vi.fn();
      const { context, error, response } = fixture(request);
      const rejected = kind === 'local' ? Object.assign(new Error(error.message), { code: 'UNAVAILABLE' })
        : kind === 'plain-object' ? { message: error.message, code: 'UNAVAILABLE' } : error;
      if (kind === 'wrong-code') Object.assign(error, { code: 'FORBIDDEN', gatewayCode: 'FORBIDDEN' });
      if (kind === 'unrelated') error.message = 'Agent database inspection pending';
      if (kind === 'timeout') Object.assign(error, { code: 'CLIENT_TIMEOUT', gatewayCode: 'CLIENT_TIMEOUT' });
      if (kind === 'disconnected') error.message = 'gateway closed';
      if (kind === 'missing-facade') Object.assign(context, { captureGatewayResponseContext: () => null });
      if (kind === 'retired-facade') response.isCurrent = () => false;
      request.mockRejectedValue(rejected);
      await expect(context.getRuntimeSessionSnapshot()).resolves.toMatchObject({ known: false, sessions: [] });
      expect(request).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('caps repeated plugin rejection and retains unknown state', async () => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValue(error);
    const reading = context.getRuntimeSessionSnapshot();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(reading).resolves.toMatchObject({ known: false, sessions: [] });
    expect(request).toHaveBeenCalledTimes(5);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it.each(['client', 'connection-generation'])('stops recovery when the %s changes during backoff', async kind => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValue(error);
    const reading = context.getRuntimeSessionSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    if (kind === 'client') Object.assign(context, { gatewayClient: { request: vi.fn() } });
    else Object.assign(context, { gatewayClientGeneration: 2 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(reading).resolves.toMatchObject({ known: false, sessions: [] });
    expect(request).toHaveBeenCalledOnce();
    expect(context.runtimeSessionSnapshot).toBeNull();
  });

  it('starts recovery with the latest snapshot generation and keeps later invalidations authoritative', async () => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValueOnce(error).mockResolvedValue({ sessions: [{ key: 'current' }], hasMore: false });
    const reading = context.getRuntimeSessionSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    invalidateRuntimeSessionSnapshot.call(context);
    await vi.advanceTimersByTimeAsync(250);
    await expect(reading).resolves.toMatchObject({ known: true, sessions: [{ key: 'current' }] });

    request.mockRejectedValueOnce(error).mockImplementationOnce(async () => {
      invalidateRuntimeSessionSnapshot.call(context);
      return { sessions: [{ key: 'obsolete' }], hasMore: true };
    });
    const invalidated = context.getRuntimeSessionSnapshot(true, true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(invalidated).resolves.toMatchObject({ known: false, sessions: [] });
    expect(request).toHaveBeenCalledTimes(4);
    expect(context.runtimeSessionSnapshot).toBeNull();
  });

  it('uses one shrinking recovery deadline across delays and pages', async () => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValueOnce(error).mockImplementationOnce(async () => {
      vi.advanceTimersByTime(1_000);
      return { sessions: [{ key: 'root' }], hasMore: true };
    }).mockResolvedValueOnce({ sessions: [{ key: 'child' }], hasMore: false });
    const reading = context.getRuntimeSessionSnapshot(false, true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(reading).resolves.toMatchObject({ known: true });
    expect(request.mock.calls[1][2].timeoutMs).toBe(9_750);
    expect(request.mock.calls[2][2].timeoutMs).toBe(8_750);
  });

  it('does not accept a recovery result or schedule another request after the deadline', async () => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValueOnce(error).mockImplementationOnce(async () => {
      vi.advanceTimersByTime(10_000);
      return { sessions: [{ key: 'late' }], hasMore: false };
    });
    const reading = context.getRuntimeSessionSnapshot();
    await vi.advanceTimersByTimeAsync(250);
    await expect(reading).resolves.toMatchObject({ known: false, sessions: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending recovery request through its signal without retrying the timeout', async () => {
    vi.useRealTimers();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(1));
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValueOnce(error).mockImplementationOnce((_method, _params, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    );
    await expect(context.getRuntimeSessionSnapshot()).resolves.toMatchObject({ known: false, sessions: [] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][2].signal.aborted).toBe(true);
  });

  it('preserves a queued full scan requested while a partial snapshot is recovering', async () => {
    const request = vi.fn();
    const { context, error } = fixture(request);
    request.mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ sessions: [{ key: 'partial' }], hasMore: true })
      .mockResolvedValueOnce({ sessions: [{ key: 'root' }], hasMore: true })
      .mockResolvedValueOnce({ sessions: [{ key: 'child' }], hasMore: false });
    const partial = context.getRuntimeSessionSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    const complete = context.getRuntimeSessionSnapshot(true, true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(partial).resolves.toMatchObject({ sessions: [{ key: 'partial' }], hasMore: true });
    await expect(complete).resolves.toMatchObject({ sessions: [{ key: 'root' }, { key: 'child' }], hasMore: false });
    expect(request.mock.calls.map(call => call[1].offset ?? 0)).toEqual([0, 0, 0, 1]);
    expect(context.runtimeSessionSnapshot?.sessions).toEqual([{ key: 'root' }, { key: 'child' }]);
  });
});

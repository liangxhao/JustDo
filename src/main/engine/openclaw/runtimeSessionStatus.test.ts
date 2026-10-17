import { describe, expect, it, vi } from 'vitest';

import {
  getRuntimeSessionSnapshot,
  invalidateRuntimeSessionSnapshot,
  type RuntimeSessionStatusContext,
} from './runtimeSessionStatus';

function harness(request: ReturnType<typeof vi.fn>) {
  const context = {
    gatewayClient: { request },
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

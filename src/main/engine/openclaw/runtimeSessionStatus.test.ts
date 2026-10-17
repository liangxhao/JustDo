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
});

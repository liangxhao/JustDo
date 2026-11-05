// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { readGoalState } from './goalReadState';
import { useGoalReadiness } from './useGoalReadiness';

afterEach(cleanup);

it('requires execution state as well as Goal metadata before allowing submission', async () => {
  const { result } = renderHook(() => useGoalReadiness('A'));
  const execution = deferredRead();
  let reading!: Promise<unknown>;
  await act(async () => {
    reading = result.current.readGoal(() =>
      readGoalState(
        () => Promise.resolve({ success: true }),
        () => execution.promise,
      ),
    );
  });
  expect(result.current.goalSubmissionBlocked).toBe(true);
  await act(async () => {
    execution.resolve({ success: false });
    await reading;
  });
  expect(result.current.goalSubmissionBlocked).toBe(true);
  await act(async () => {
    await result.current.readGoal(() =>
      readGoalState(
        () => Promise.resolve({ success: true }),
        () => Promise.resolve({ success: true }),
      ),
    );
  });
  expect(result.current.goalSubmissionBlocked).toBe(false);
});

function deferredRead() {
  let resolve!: (value: { success: boolean }) => void;
  const promise = new Promise<{ success: boolean }>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it('keeps queue authorization closed until the Goal lookup succeeds', async () => {
  const { result } = renderHook(() => useGoalReadiness('A'));
  const pending = deferredRead();
  let reading!: Promise<{ success: boolean }>;
  await act(async () => {
    reading = result.current.readGoal(() => pending.promise);
  });
  expect(result.current.goalReadReady).toBe(false);
  expect(result.current.goalSubmissionBlocked).toBe(true);
  await act(async () => {
    pending.resolve({ success: true });
    await reading;
  });
  expect(result.current.goalReadReady).toBe(true);
  expect(result.current.goalSubmissionBlocked).toBe(false);
});

it.each(['rejected', 'unsuccessful'])(
  'keeps failed %s reads closed until a successful retry',
  async outcome => {
    const { result } = renderHook(() => useGoalReadiness('A'));
    await act(async () => {
      await result.current.readGoal(() => Promise.resolve({ success: true }));
    });
    expect(result.current.goalReadReady).toBe(true);
    await act(async () => {
      const read = result.current.readGoal(() =>
        outcome === 'rejected'
          ? Promise.reject(new Error('unavailable'))
          : Promise.resolve({ success: false }),
      );
      await read.catch(() => undefined);
    });
    expect(result.current.goalReadReady).toBe(false);
    expect(result.current.goalReadFailed).toBe(true);
    expect(result.current.goalSubmissionBlocked).toBe(true);
    await act(async () => {
      await result.current.readGoal(() => Promise.resolve({ success: true }));
    });
    expect(result.current.goalReadReady).toBe(true);
    expect(result.current.goalReadFailed).toBe(false);
  },
);

it('does not reuse a previous session result or accept a late result after navigating away and back', async () => {
  const { result, rerender } = renderHook(({ id }) => useGoalReadiness(id), {
    initialProps: { id: 'A' },
  });
  await act(async () => {
    await result.current.readGoal(() => Promise.resolve({ success: true }));
  });
  const pending = deferredRead();
  let reading!: Promise<{ success: boolean }>;
  await act(async () => {
    reading = result.current.readGoal(() => pending.promise);
  });
  rerender({ id: 'B' });
  expect(result.current.goalReadReady).toBe(false);
  expect(result.current.goalSubmissionBlocked).toBe(true);
  rerender({ id: 'A' });
  await act(async () => {
    pending.resolve({ success: true });
    await reading;
  });
  expect(result.current.goalReadReady).toBe(false);
  expect(result.current.goalSubmissionBlocked).toBe(true);
  await act(async () => {
    await result.current.readGoal(() => Promise.resolve({ success: true }));
  });
  expect(result.current.goalReadReady).toBe(true);
});

it('retains the failure explanation during a retry and clears it only after a current success', async () => {
  const { result } = renderHook(() => useGoalReadiness('A'));
  expect(result.current.goalReadFailed).toBe(false);
  await act(async () => {
    await result.current.readGoal(() => Promise.resolve({ success: false }));
  });
  const retry = deferredRead();
  let reading!: Promise<{ success: boolean }>;
  await act(async () => {
    reading = result.current.readGoal(() => retry.promise);
  });
  expect(result.current.goalReadFailed).toBe(true);
  expect(result.current.goalReadPending).toBe(true);
  expect(result.current.goalSubmissionBlocked).toBe(true);
  await act(async () => {
    retry.resolve({ success: true });
    await reading;
  });
  expect(result.current.goalReadFailed).toBe(false);
  expect(result.current.goalReadPending).toBe(false);
  expect(result.current.goalSubmissionBlocked).toBe(false);
});

it('rejects an older success after a newer read fails within the same session', async () => {
  const { result } = renderHook(() => useGoalReadiness('A'));
  const older = deferredRead();
  let olderRead!: Promise<{ success: boolean }>;
  await act(async () => {
    olderRead = result.current.readGoal(() => older.promise);
    await result.current.readGoal(() => Promise.resolve({ success: false }));
  });
  let olderOutcome!: { success: boolean };
  await act(async () => {
    older.resolve({ success: true });
    olderOutcome = await olderRead;
  });
  expect(olderOutcome.success).toBe(false);
  expect(result.current.goalReadFailed).toBe(true);
  expect(result.current.goalSubmissionBlocked).toBe(true);
});

it('does not let an older rejection replace a newer successful read', async () => {
  const { result } = renderHook(() => useGoalReadiness('A'));
  let rejectOlder!: (error: Error) => void;
  const older = new Promise<{ success: boolean }>((_resolve, reject) => { rejectOlder = reject; });
  let olderRead!: Promise<{ success: boolean }>;
  await act(async () => {
    olderRead = result.current.readGoal(() => older);
    await result.current.readGoal(() => Promise.resolve({ success: true }));
  });
  await act(async () => {
    rejectOlder(new Error('old request failed'));
    await olderRead.catch(() => undefined);
  });
  expect(result.current.goalReadReady).toBe(true);
  expect(result.current.goalReadFailed).toBe(false);
});

it('revokes an in-flight read when its effect owner is disposed', async () => {
  const { result } = renderHook(() => useGoalReadiness('A'));
  const pending = deferredRead();
  let reading!: Promise<{ success: boolean }>;
  await act(async () => {
    reading = result.current.readGoal(() => pending.promise);
    result.current.invalidateGoalRead();
  });
  let outcome!: { success: boolean };
  await act(async () => {
    pending.resolve({ success: true });
    outcome = await reading;
  });
  expect(outcome.success).toBe(false);
  expect(result.current.goalReadReady).toBe(false);
  expect(result.current.goalSubmissionBlocked).toBe(true);
});

it('does not execute disabled or retired readers and requires a fresh read after engine readiness returns', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useGoalReadiness('A', false, enabled), {
    initialProps: { enabled: false },
  });
  const read = vi.fn().mockResolvedValue({ success: true });
  await act(async () => {
    await expect(result.current.readGoal(read)).resolves.toEqual({ success: false });
  });
  expect(read).not.toHaveBeenCalled();
  expect(result.current.goalSubmissionBlocked).toBe(true);

  rerender({ enabled: true });
  const oldReadGoal = result.current.readGoal;
  await act(async () => { await result.current.readGoal(read); });
  expect(result.current.goalReadReady).toBe(true);
  rerender({ enabled: false });
  expect(result.current.goalReadReady).toBe(false);
  await act(async () => {
    await expect(oldReadGoal(read)).resolves.toEqual({ success: false });
  });
  expect(read).toHaveBeenCalledOnce();

  rerender({ enabled: true });
  expect(result.current.goalReadReady).toBe(false);
  await act(async () => { await result.current.readGoal(read); });
  expect(result.current.goalReadReady).toBe(true);
});

it('retires a prior failure across engine restart without replaying it during the fresh read', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useGoalReadiness('A', false, enabled), {
    initialProps: { enabled: true },
  });
  await act(async () => {
    await result.current.readGoal(() => Promise.resolve({ success: false }));
  });
  expect(result.current.goalReadFailed).toBe(true);
  rerender({ enabled: false });
  expect(result.current.goalReadFailed).toBe(false);
  rerender({ enabled: true });
  const pending = deferredRead();
  let reading!: Promise<{ success: boolean }>;
  await act(async () => { reading = result.current.readGoal(() => pending.promise); });
  expect(result.current.goalReadFailed).toBe(false);
  expect(result.current.goalReadPending).toBe(true);
  expect(result.current.goalSubmissionBlocked).toBe(true);
  await act(async () => { pending.resolve({ success: true }); await reading; });
  expect(result.current.goalReadReady).toBe(true);
});

it('does not authorize or expose late state from before an engine restart', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useGoalReadiness('A', false, enabled), {
    initialProps: { enabled: true },
  });
  const pending = deferredRead();
  let reading!: Promise<{ success: boolean }>;
  await act(async () => { reading = result.current.readGoal(() => pending.promise); });
  rerender({ enabled: false });
  rerender({ enabled: true });
  let outcome!: { success: boolean };
  await act(async () => { pending.resolve({ success: true }); outcome = await reading; });
  expect(outcome.success).toBe(false);
  expect(result.current.goalReadReady).toBe(false);
  expect(result.current.goalReadFailed).toBe(false);
  expect(result.current.goalSubmissionBlocked).toBe(true);
});

it.each([
  { sessionId: undefined, sideChat: false },
  { sessionId: 'temp-new', sideChat: false },
  { sessionId: 'A', sideChat: true },
])(
  'does not block new sessions or side chat ($sessionId, $sideChat)',
  ({ sessionId, sideChat }) => {
    const { result } = renderHook(() => useGoalReadiness(sessionId, sideChat));
    expect(result.current.goalReadReady).toBe(false);
    expect(result.current.goalSubmissionBlocked).toBe(false);
  },
);

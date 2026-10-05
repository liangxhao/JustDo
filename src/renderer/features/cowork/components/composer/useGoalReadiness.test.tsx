// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

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
    expect(result.current.goalSubmissionBlocked).toBe(true);
    await act(async () => {
      await result.current.readGoal(() => Promise.resolve({ success: true }));
    });
    expect(result.current.goalReadReady).toBe(true);
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

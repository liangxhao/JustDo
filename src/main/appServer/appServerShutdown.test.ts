import { afterEach, expect, it, vi } from 'vitest';

import { waitForAppServerShutdown } from './appServerShutdown';

afterEach(() => vi.useRealTimers());

it('does not delay exit when no service was created', async () => {
  vi.useFakeTimers();
  expect(await waitForAppServerShutdown(undefined)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['resolve', 'reject'])('cleans the shutdown deadline on a fast %s', async kind => {
  vi.useFakeTimers();
  const drain = kind === 'resolve' ? Promise.resolve() : Promise.reject(new Error('Stop failed'));
  expect(await waitForAppServerShutdown(drain)).toBe(kind === 'resolve');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['resolve', 'reject'])('allows Gateway teardown after the deadline while still observing late %s', async kind => {
  vi.useFakeTimers();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const drain = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  const observed = drain.then(() => { settled = true; }, () => { settled = true; });
  const waiting = waitForAppServerShutdown(drain);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await waiting).toBe(false);
  expect(settled).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  if (kind === 'resolve') resolve();
  else reject(new Error('Late cleanup failure'));
  await observed;
  expect(settled).toBe(true);
});

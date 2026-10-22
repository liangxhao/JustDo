import { afterEach, expect, it, vi } from 'vitest';

import { createGoalReadRetry } from './goalReadRetry';

afterEach(() => vi.useRealTimers());

it('recovers after multiple failed retry windows and stops scheduling after success', async () => {
  vi.useFakeTimers();
  let available = false;
  const read = vi.fn(() => {
    if (available) retry.succeeded();
    else retry.failed();
  });
  const retry = createGoalReadRetry(read);
  read();
  await vi.advanceTimersByTimeAsync(4_500);
  expect(read).toHaveBeenCalledTimes(3);
  available = true;
  await vi.advanceTimersByTimeAsync(6_000);
  expect(read).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(4);
});

it('caps backoff and cancels queued and late retries on cleanup', async () => {
  vi.useFakeTimers();
  const read = vi.fn(() => retry.failed());
  const retry = createGoalReadRetry(read);
  read();
  await vi.advanceTimersByTimeAsync(46_500);
  expect(read).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(7);
  retry.dispose();
  retry.failed();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(7);
  expect(vi.getTimerCount()).toBe(0);
});

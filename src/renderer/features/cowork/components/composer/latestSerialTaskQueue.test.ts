import { describe, expect, test, vi } from 'vitest';

import { LatestSerialTaskQueue } from './latestSerialTaskQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('LatestSerialTaskQueue', () => {
  test('skips superseded pending choices without cancelling a switch already sent', async () => {
    const queue = new LatestSerialTaskQueue();
    const first = deferred<string>();
    const firstTask = vi.fn(() => first.promise);
    const supersededTask = vi.fn(async () => 'intermediate');
    const latestTask = vi.fn(async () => 'latest');

    const firstRun = queue.enqueueLatest('session-1', firstTask);
    await Promise.resolve();
    expect(firstTask).toHaveBeenCalledOnce();
    const supersededRun = queue.enqueueLatest('session-1', supersededTask);
    const latestRun = queue.enqueueLatest('session-1', latestTask);
    expect(latestTask).not.toHaveBeenCalled();

    first.resolve('confirmed');

    await expect(firstRun.completion).resolves.toBe('confirmed');
    await expect(supersededRun.completion).resolves.toBeUndefined();
    await expect(latestRun.completion).resolves.toBe('latest');
    expect(supersededTask).not.toHaveBeenCalled();
    expect(latestTask).toHaveBeenCalledOnce();
    expect(queue.isLatest(latestRun.taskId)).toBe(true);
  });

  test('preserves choices in other contexts and their shared default-save order', async () => {
    const queue = new LatestSerialTaskQueue();
    const calls: string[] = [];
    const select = (key: string, value: string) =>
      queue.enqueueLatest(key, async () => {
        calls.push(value);
        return value;
      });

    const oldHome = select('home', 'old home');
    const session = select('session-1', 'session');
    const otherAgent = select('session-1\0review', 'review');
    const latestHome = select('home', 'latest home');

    await expect(oldHome.completion).resolves.toBeUndefined();
    await expect(session.completion).resolves.toBe('session');
    await expect(otherAgent.completion).resolves.toBe('review');
    await expect(latestHome.completion).resolves.toBe('latest home');
    expect(calls).toEqual(['session', 'review', 'latest home']);
  });

  test('continues with the latest choice after an in-flight switch fails', async () => {
    const queue = new LatestSerialTaskQueue();
    const first = deferred<string>();
    const firstRun = queue.enqueueLatest('session-1', () => first.promise);
    await Promise.resolve();
    const skippedTask = vi.fn(async () => 'skipped');
    const skipped = queue.enqueueLatest('session-1', skippedTask);
    const latest = queue.enqueueLatest('session-1', async () => 'latest');
    const failed = expect(firstRun.completion).rejects.toThrow('rejected');

    first.reject(new Error('rejected'));

    await failed;
    await expect(skipped.completion).resolves.toBeUndefined();
    await expect(latest.completion).resolves.toBe('latest');
    expect(skippedTask).not.toHaveBeenCalled();
    await expect(queue.enqueueLatest('session-1', async () => 'next').completion).resolves.toBe(
      'next',
    );
  });

  test('runs model updates in selection order and only marks the newest one as latest', async () => {
    const queue = new LatestSerialTaskQueue();
    const first = deferred<string>();
    const secondTask = vi.fn(async () => 'second');

    const firstRun = queue.enqueue(() => first.promise);
    const secondRun = queue.enqueue(secondTask);

    await Promise.resolve();
    expect(secondTask).not.toHaveBeenCalled();
    expect(queue.isLatest(firstRun.taskId)).toBe(false);
    expect(queue.isLatest(secondRun.taskId)).toBe(true);

    first.resolve('first');
    await expect(firstRun.completion).resolves.toBe('first');
    await expect(secondRun.completion).resolves.toBe('second');
    expect(secondTask).toHaveBeenCalledOnce();
  });

  test('continues after a failed update and invalidates callbacks from the previous context', async () => {
    const queue = new LatestSerialTaskQueue();
    const failedRun = queue.enqueue(async () => {
      throw new Error('failed');
    });
    const nextTask = vi.fn(async () => 'saved');
    const nextRun = queue.enqueue(nextTask);

    await expect(failedRun.completion).rejects.toThrow('failed');
    await expect(nextRun.completion).resolves.toBe('saved');

    queue.invalidate();
    expect(queue.isLatest(nextRun.taskId)).toBe(false);
  });
});

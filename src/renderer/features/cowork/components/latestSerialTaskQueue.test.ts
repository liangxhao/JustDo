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

import { expect, it } from 'vitest';
import { DiscussionPermits } from '../../discussion/discussion-permits';

it('admits in FIFO order and does not release until the holder explicitly settles', async () => {
  const pool = new DiscussionPermits(1, new AbortController().signal);
  const first = await pool.acquire();
  const order: number[] = [];
  const second = pool.acquire().then(release => {
    order.push(2);
    return release;
  });
  const third = pool.acquire().then(release => {
    order.push(3);
    return release;
  });
  await Promise.resolve();
  expect(order).toEqual([]);
  first();
  const releaseSecond = await second;
  expect(order).toEqual([2]);
  first();
  await Promise.resolve();
  expect(order).toEqual([2]);
  releaseSecond();
  (await third)();
  expect(order).toEqual([2, 3]);
  pool.dispose();
});
it('cancels queued work and rejects every later acquisition after an uncertain dispatch', async () => {
  const controller = new AbortController();
  const pool = new DiscussionPermits(1, controller.signal);
  const release = await pool.acquire();
  const waiting = pool.acquire();
  const rejection = expect(waiting).rejects.toThrow('teamDiscussionCancelled');
  controller.abort();
  await rejection;
  release();
  await expect(pool.acquire()).rejects.toThrow('teamDiscussionCancelled');
  pool.dispose();
  const unknown = new DiscussionPermits(1, new AbortController().signal);
  await unknown.acquire();
  const queued = unknown.acquire();
  const failed = expect(queued).rejects.toThrow('teamDiscussionExecutionUnknown');
  unknown.close(new Error('teamDiscussionExecutionUnknown'));
  await failed;
  await expect(unknown.acquire()).rejects.toThrow('teamDiscussionExecutionUnknown');
  unknown.dispose();
});

import { expect, it } from 'vitest';

import { FifoPermits } from '../../../../plugins/extensions/runtime-services/concurrency/fifo-permits';

it('shares bounded capacity with FIFO waiters and idempotent releases', async () => {
  const permits = new FifoPermits(2, new AbortController().signal, () => new Error('cancelled'));
  const first = await permits.acquire();
  const second = await permits.acquire();
  const order: number[] = [];
  const third = permits.acquire().then(release => { order.push(3); return release; });
  const fourth = permits.acquire().then(release => { order.push(4); return release; });
  await Promise.resolve();
  expect(order).toEqual([]);
  first();
  const releaseThird = await third;
  first();
  await Promise.resolve();
  expect(order).toEqual([3]);
  second();
  const releaseFourth = await fourth;
  expect(order).toEqual([3, 4]);
  releaseThird();
  releaseFourth();
  permits.dispose();
});

it('retains a failure for queued and future work after an uncertain holder', async () => {
  const permits = new FifoPermits(1, new AbortController().signal, () => new Error('cancelled'));
  const release = await permits.acquire();
  const waiting = expect(permits.acquire()).rejects.toThrow('unconfirmed');
  permits.close(new Error('unconfirmed'));
  await waiting;
  release();
  await expect(permits.acquire()).rejects.toThrow('unconfirmed');
  permits.dispose();
});

it('uses the caller cancellation error for active and already aborted signals', async () => {
  const controller = new AbortController();
  const permits = new FifoPermits(1, controller.signal, () => new Error('callerCancelled'));
  const release = await permits.acquire();
  const waiting = expect(permits.acquire()).rejects.toThrow('callerCancelled');
  controller.abort();
  await waiting;
  release();
  await expect(permits.acquire()).rejects.toThrow('callerCancelled');
  permits.dispose();
  const aborted = new FifoPermits(1, controller.signal, () => new Error('alreadyCancelled'));
  await expect(aborted.acquire()).rejects.toThrow('alreadyCancelled');
  aborted.dispose();
});

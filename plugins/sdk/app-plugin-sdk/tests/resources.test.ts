import { afterEach, expect, test, vi } from 'vitest';

import { createResourceScope } from '../resources';

afterEach(() => vi.restoreAllMocks());

test('releases in reverse order once, including failures and work acquired after retirement', () => {
  const errors = vi.fn();
  const scope = createResourceScope({ onError: errors });
  const calls: number[] = [];
  scope.defer(() => calls.push(1));
  const second = scope.defer(() => {
    calls.push(2);
    throw new Error('release failed');
  });
  scope.defer(() => calls.push(3));
  scope.dispose();
  second();
  scope.dispose();
  scope.defer(() => calls.push(4));
  expect(calls).toEqual([3, 2, 1, 4]);
  expect(errors).toHaveBeenCalledOnce();
  expect(scope.signal.aborted).toBe(true);
});

test('retiring one child preserves its sibling and removes manual child ownership', () => {
  const parent = createResourceScope();
  const a = parent.child();
  const b = parent.child();
  const offA = vi.fn();
  const offB = vi.fn();
  a.defer(offA);
  b.defer(offB);
  a.dispose();
  expect(a.signal.aborted).toBe(true);
  expect(b.signal.aborted).toBe(false);
  expect(parent.signal.aborted).toBe(false);
  parent.dispose();
  expect(offA).toHaveBeenCalledOnce();
  expect(offB).toHaveBeenCalledOnce();
});

test('an already-aborted parent admits no timers, listeners or background work', async () => {
  const controller = new AbortController();
  controller.abort();
  const scope = createResourceScope({ signal: controller.signal });
  const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const work = vi.fn();
  scope.setTimeout(work, 0);
  scope.listen(new EventTarget(), 'change', work);
  scope.run(work);
  await Promise.resolve();
  expect(work).not.toHaveBeenCalled();
  expect(timeout).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});

test('suppresses queued timer and listener callbacks after cancellation and parent retirement', () => {
  const queued: (() => void)[] = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(callback => {
    queued.push(callback as () => void);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const scope = createResourceScope();
  const callback = vi.fn();
  const cancel = scope.setTimeout(callback, 5);
  cancel();
  queued[0]();
  scope.setTimeout(callback, 5);
  const target = new EventTarget();
  const listener = vi.spyOn(target, 'addEventListener');
  const off = scope.listen(target, 'change', callback);
  const pending = listener.mock.calls[0][1] as EventListener;
  off();
  pending(new Event('change'));
  scope.dispose();
  queued[1]();
  expect(callback).not.toHaveBeenCalled();
});

test('fired timeouts and once listeners are not released or invoked twice', () => {
  vi.useFakeTimers();
  try {
    const scope = createResourceScope();
    const timer = vi.fn();
    const once = vi.fn();
    const target = new EventTarget();
    scope.setTimeout(timer, 2);
    scope.listen(target, 'change', once, { once: true });
    target.dispatchEvent(new Event('change'));
    target.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(2);
    scope.dispose();
    expect(timer).toHaveBeenCalledOnce();
    expect(once).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('an external listener signal releases the registration and queued callback', () => {
  const scope = createResourceScope();
  const target = new EventTarget();
  const signal = new AbortController();
  const add = vi.spyOn(target, 'addEventListener');
  const handler = vi.fn();
  scope.listen(target, 'change', handler, { signal: signal.signal, capture: true });
  const callback = add.mock.calls[0][1] as EventListener;
  signal.abort();
  callback(new Event('change'));
  target.dispatchEvent(new Event('change'));
  expect(handler).not.toHaveBeenCalled();
  scope.dispose();
});

test('cancels cooperative work and suppresses its late result without pretending it settled', async () => {
  const parent = new AbortController();
  const scope = createResourceScope({ signal: parent.signal });
  let finish!: (value: string) => void;
  let taskSignal!: AbortSignal;
  const work = new Promise<string>(resolve => {
    finish = resolve;
  });
  const result = vi.fn();
  scope.run(signal => {
    taskSignal = signal;
    return work;
  }, result);
  await Promise.resolve();
  expect(taskSignal.aborted).toBe(false);
  parent.abort();
  expect(taskSignal.aborted).toBe(true);
  expect(result).not.toHaveBeenCalled();
  finish('late');
  await work;
  await Promise.resolve();
  expect(result).not.toHaveBeenCalled();
});

test('one task can be cancelled without cancelling its sibling and errors are observed', async () => {
  const onError = vi.fn();
  const scope = createResourceScope({ onError });
  const cancelled = vi.fn();
  const result = vi.fn();
  const cancel = scope.run(() => 'first', cancelled);
  cancel();
  scope.run(() => 'second', result);
  scope.run(async () => {
    throw new Error('task failed');
  });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(cancelled).not.toHaveBeenCalled();
  expect(result).toHaveBeenCalledWith('second');
  expect(scope.signal.aborted).toBe(false);
  scope.dispose();
});

test('observes both synchronous and asynchronous result callback failures', async () => {
  const onError = vi.fn();
  const scope = createResourceScope({ onError });
  scope.run(
    () => 'sync',
    () => {
      throw new Error('sync result failed');
    },
  );
  scope.run(
    () => 'async',
    async () => {
      throw new Error('async result failed');
    },
  );
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  expect(onError.mock.calls.map(([error]) => (error as Error).message).sort()).toEqual([
    'async result failed',
    'sync result failed',
  ]);
  scope.dispose();
});

test('rejects timer values that would overflow or silently become an immediate loop', () => {
  const scope = createResourceScope();
  for (const value of [Number.NaN, Infinity, -1, 2_147_483_648]) {
    expect(() => scope.setTimeout(() => undefined, value)).toThrow('delay is invalid');
    expect(() => scope.setInterval(() => undefined, value)).toThrow('delay is invalid');
  }
  scope.dispose();
});

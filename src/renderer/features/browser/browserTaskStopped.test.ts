import { expect, test, vi } from 'vitest';

import { browserTaskStopped } from './browserTaskStopped';

test('pending admission cannot grant manual control even before it becomes a running task', async () => {
  const read = vi.fn(async () => ({ known: true, running: false }));
  expect(await browserTaskStopped(() => true, read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

test('admission starting during a runtime read invalidates the idle snapshot', async () => {
  let pending = false;
  const stopped = await browserTaskStopped(
    () => pending,
    async () => {
      pending = true;
      return { known: true, running: false };
    },
  );
  expect(stopped).toBe(false);
});

test('only confirmed idle runtime without pending admission grants manual control', async () => {
  for (const [known, running, expected] of [
    [true, false, true],
    [true, true, false],
    [false, false, false],
  ]) {
    expect(
      await browserTaskStopped(
        () => false,
        async () => ({ known, running }),
      ),
    ).toBe(expected);
  }
});

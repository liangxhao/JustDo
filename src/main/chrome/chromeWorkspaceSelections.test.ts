import { afterEach, expect, test, vi } from 'vitest';

import { ChromeWorkspaceSelections } from './chromeWorkspaceSelections';

afterEach(() => vi.useRealTimers());

test('binds a single-use choice to the draft and preserves it when a later picker is cancelled', async () => {
  const selections = new ChromeWorkspaceSelections();
  const scope = { key: 'draft-one' };
  const result = await selections.select(
    scope,
    async () => '/项目 空格',
    () => {},
  );
  expect(result).toHaveProperty('selectionToken');
  if (!('selectionToken' in result)) throw new Error('Expected a selection');
  await expect(
    selections.select(
      scope,
      async () => null,
      () => {},
    ),
  ).resolves.toEqual({ cancelled: true });
  expect(() => selections.consume(result.selectionToken!, { key: 'draft-two' })).toThrow(
    'another conversation',
  );
  expect(selections.consume(result.selectionToken!, scope)).toBe('/项目 空格');
  expect(() => selections.consume(result.selectionToken!, scope)).toThrow('expired');
});

test('rejects choices from another subscription, expired choices and picker results after disconnect', async () => {
  vi.useFakeTimers();
  const selections = new ChromeWorkspaceSelections();
  const scope = { key: 'thread-one', subscription: Symbol() };
  const result = await selections.select(
    scope,
    async () => '/folder',
    () => {},
  );
  if (!('selectionToken' in result)) throw new Error('Expected a selection');
  expect(() =>
    selections.consume(result.selectionToken!, { ...scope, subscription: Symbol() }),
  ).toThrow();
  vi.advanceTimersByTime(5 * 60_000);
  expect(() => selections.consume(result.selectionToken!, scope)).toThrow('expired');
  let finish!: (value: string) => void;
  const pending = selections.select(
    scope,
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
    () => {},
  );
  const rejected = expect(pending).rejects.toThrow('no longer current');
  await expect(
    selections.select(
      scope,
      async () => '/second',
      () => {},
    ),
  ).rejects.toThrow('already open');
  selections.clear();
  finish('/late');
  await rejected;
});

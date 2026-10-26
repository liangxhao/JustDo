import { afterEach, expect, it } from 'vitest';

import {
  acquireBackgroundBrowserStorage,
  reserveBackgroundBrowserStorageClear,
} from './backgroundBrowserStorage';

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

it('counts concurrent pages and runs using the same profile without an exclusive identity lease', () => {
  const first = acquireBackgroundBrowserStorage('persist:profile');
  const second = acquireBackgroundBrowserStorage('persist:profile');
  releases.push(first, second);
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  first();
  first();
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  second();
  const clear = reserveBackgroundBrowserStorageClear();
  expect(clear).not.toBeNull();
  releases.push(clear!);
});

it('excludes new profile creation until an explicit data-clear operation finishes', () => {
  const clear = reserveBackgroundBrowserStorageClear();
  expect(clear).not.toBeNull();
  releases.push(clear!);
  expect(() => acquireBackgroundBrowserStorage('persist:profile')).toThrow('being cleared');
  expect(() => acquireBackgroundBrowserStorage('persist:other')).toThrow('being cleared');
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  clear!();
  clear!();
  releases.push(acquireBackgroundBrowserStorage('persist:profile'));
});

it('retains the clear barrier until all independent profile resources release', () => {
  const first = acquireBackgroundBrowserStorage('persist:one');
  const second = acquireBackgroundBrowserStorage('persist:two');
  releases.push(first, second);
  first();
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  second();
  const clear = reserveBackgroundBrowserStorageClear();
  expect(clear).not.toBeNull();
  releases.push(clear!);
});

import { expect, test, vi } from 'vitest';

import { normalizeWindowAppearance, readWindowAppearance } from './windowAppearance';

test('exposes only approved display fields from the preload snapshot', () => {
  const input = { mode: 'dark', themeId: 'midnight', password: 'must-not-be-forwarded' };
  expect(readWindowAppearance(() => input, false)).toEqual({ mode: 'dark', themeId: 'midnight' });
});

test.each([
  null,
  undefined,
  'invalid',
  { mode: 'invalid', themeId: '</script>' },
  { themeId: 'a'.repeat(1024) },
])('falls back safely for a malformed display snapshot: %j', snapshot => {
  expect(readWindowAppearance(() => snapshot, false)).toEqual({ mode: 'light' });
});

test('never reads Main settings from a transient guide', () => {
  const read = vi.fn(() => {
    throw new Error('product Store must not be opened');
  });
  expect(readWindowAppearance(read, true)).toEqual({ mode: 'light' });
  expect(read).not.toHaveBeenCalled();
});

test('keeps a usable error presentation if the bootstrap bridge fails', () => {
  expect(
    readWindowAppearance(() => {
      throw new Error('IPC unavailable');
    }, false),
  ).toEqual({ mode: 'light' });
});

test('uses the product default without consulting the operating system unless requested', () => {
  expect(normalizeWindowAppearance(undefined)).toEqual({ mode: 'light' });
  expect(normalizeWindowAppearance('system')).toEqual({ mode: 'system' });
});

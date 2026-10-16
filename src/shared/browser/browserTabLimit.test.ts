import { expect, test } from 'vitest';

import { DEFAULT_BROWSER_TAB_LIMIT, normalizeBrowserTabLimit } from './browserTabLimit';

test.each([undefined, null, '40', '', NaN, Infinity, {}, true])(
  'uses the default tab limit for invalid persisted values: %j',
  value => {
    expect(normalizeBrowserTabLimit(value)).toBe(DEFAULT_BROWSER_TAB_LIMIT);
  },
);

test.each([
  [-10, 1],
  [0, 1],
  [1, 1],
  [25, 25],
  [25.7, 26],
  [50, 50],
  [1000, 50],
])('normalizes tab limit %s to %s', (value, expected) => {
  expect(normalizeBrowserTabLimit(value)).toBe(expected);
});

import { expect, test } from 'vitest';

import { getMissingRequirementCount } from './skillRequirements';

test('does not report missing requirements for an empty Gateway missing object', () => {
  expect(getMissingRequirementCount({ bins: [], env: [], config: [], os: [] })).toBe(0);
});

test('counts every Gateway requirement category', () => {
  expect(
    getMissingRequirementCount({
      bins: ['git'],
      env: ['API_KEY'],
      config: ['tools.enabled'],
      os: ['darwin'],
    }),
  ).toBe(4);
});

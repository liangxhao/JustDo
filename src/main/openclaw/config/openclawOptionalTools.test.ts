import { describe, expect, test } from 'vitest';

import { mergeManagedOptionalToolPolicy } from './openclawConfigBuilders';

describe('optional decision tool admission', () => {
  test.each([undefined, {}, { allow: [] }, { allow: [' ', '\t'] }])(
    'keeps unrestricted native policies additive: %j',
    policy => {
      expect(mergeManagedOptionalToolPolicy(policy)).toEqual({
        allow: undefined,
        alsoAllow: ['typesafe_evaluate'],
      });
    },
  );

  test('extends an explicit allowlist without creating an invalid second list', () => {
    expect(mergeManagedOptionalToolPolicy({ allow: ['read', 'typesafe_evaluate'] })).toEqual({
      allow: ['read', 'typesafe_evaluate'],
      alsoAllow: undefined,
    });
  });

  test('preserves other optional tools without duplicating Jev', () => {
    expect(mergeManagedOptionalToolPolicy({ alsoAllow: ['operator-tool', 'typesafe_evaluate'] }))
      .toEqual({ allow: undefined, alsoAllow: ['operator-tool', 'typesafe_evaluate'] });
  });
});

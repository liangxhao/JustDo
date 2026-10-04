import { describe, expect, test } from 'vitest';

import { mergeManagedOptionalToolPolicy } from './openclawConfigBuilders';

describe('optional decision tool admission', () => {
  test.each([undefined, {}, { allow: [] }, { allow: [' ', '\t'] }])(
    'keeps unrestricted native policies additive: %j',
    policy => {
      expect(mergeManagedOptionalToolPolicy(policy)).toEqual({
        allow: undefined,
        alsoAllow: ['decision_evaluate'],
      });
    },
  );

  test('extends an explicit allowlist without creating an invalid second list', () => {
    expect(mergeManagedOptionalToolPolicy({ allow: ['read', 'decision_evaluate'] })).toEqual({
      allow: ['read', 'decision_evaluate'],
      alsoAllow: undefined,
    });
  });

  test('preserves other optional tools without duplicating Jev', () => {
    expect(mergeManagedOptionalToolPolicy({ alsoAllow: ['operator-tool', 'decision_evaluate'] }))
      .toEqual({ allow: undefined, alsoAllow: ['operator-tool', 'decision_evaluate'] });
  });
});

 test('preserves explicit current evaluation denies without renaming other tools', () => {
  expect(mergeManagedOptionalToolPolicy({
    allow: ['read', 'operator-tool'], deny: ['decision_evaluate', 'operator-tool'],
  })).toEqual({ allow: ['read', 'operator-tool', 'decision_evaluate'], alsoAllow: undefined,
    deny: ['decision_evaluate', 'operator-tool'] });
});

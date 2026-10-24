import { describe, expect, test } from 'vitest';

import {
  assessStartupDelivery, DECLARED_DOWNGRADE_COMPATIBILITY, StartupCompatibilityErrorCode,
  type StartupDeliveryIdentity,
} from './versionPolicy';

const source: StartupDeliveryIdentity = {
  appVersion: '2026.10.20', runtimeVersion: 'v2026.10.6', runtimeBuildId: 'a'.repeat(64),
};
const blocked = (code: string) => ({ allowed: false, blockReason: code });

test('there are no active downgrade exceptions', () => {
  expect(DECLARED_DOWNGRADE_COMPATIBILITY).toEqual([]);
});

test('adoption validates the target without claiming a prior version or native compatibility', () => {
  expect(assessStartupDelivery({ target: source })).toEqual({ allowed: true, direction: 'adoption' });
  expect(assessStartupDelivery({ target: { ...source, runtimeBuildId: '' } }))
    .toEqual(blocked(StartupCompatibilityErrorCode.VersionUnconfirmed));
});

test.each(['', '2026.10', '2026.10.6.1', 'v2026.10.6-beta.1', '2026.10.6+build',
  ' 2026.10.6', '2026.10.6 ', '+2026.10.6', '-1.10.6', '2026.010.6',
  '2026.10.06', 'V2026.10.6', '9007199254740992.0.0'])
('rejects unknown version syntax on either delivery: %j', value => {
  for (const field of ['appVersion', 'runtimeVersion'] as const) {
    expect(assessStartupDelivery({ source: { ...source, [field]: value }, target: source }))
      .toEqual(blocked(StartupCompatibilityErrorCode.VersionUnconfirmed));
    expect(assessStartupDelivery({ source, target: { ...source, [field]: value } }))
      .toEqual(blocked(StartupCompatibilityErrorCode.VersionUnconfirmed));
  }
});

test('compares safe numeric components rather than strings, prefixes or hashes', () => {
  expect(assessStartupDelivery({ source: { ...source, appVersion: '1.9.0' },
    target: { ...source, appVersion: '1.10.0' } })).toEqual({ allowed: true, direction: 'upgrade' });
  expect(assessStartupDelivery({ source, target: { ...source, appVersion: 'v2026.10.20' } }))
    .toEqual({ allowed: true, direction: 'same' });
  expect(assessStartupDelivery({ source, target: { ...source, runtimeBuildId: '0'.repeat(64) } }))
    .toEqual({ allowed: true, direction: 'build-change' });
  expect(assessStartupDelivery({ target: { ...source, appVersion: '9007199254740991.0.0' } }))
    .toEqual({ allowed: true, direction: 'adoption' });
});

test.each([
  { appVersion: '2026.10.19' }, { runtimeVersion: '2026.10.4' },
  { appVersion: '2026.10.21', runtimeVersion: '2026.10.4' },
  { appVersion: '2026.10.19', runtimeVersion: '2026.10.7' },
])('blocks either dimension of downgrade, including mixed directions: %j', change => {
  expect(assessStartupDelivery({ source, target: { ...source, ...change }, nativeCompatibilityConfirmed: true }))
    .toEqual(blocked(StartupCompatibilityErrorCode.DowngradeBlocked));
});

describe('future independently reviewed compatibility declarations', () => {
  const target = { ...source, appVersion: '2026.10.19', runtimeVersion: '2026.10.4' };
  const declaration = { evidenceId: 'reviewed-all-persistent-domains', source, target };
  test('an exact declaration alone only asks for inspection and remains blocked', () => {
    expect(assessStartupDelivery({ source, target, declaredDowngrades: [declaration] }))
      .toEqual({ ...blocked(StartupCompatibilityErrorCode.VersionUnconfirmed), requiresNativeInspection: true });
    expect(assessStartupDelivery({ source, target, declaredDowngrades: [declaration], nativeCompatibilityConfirmed: false }))
      .toEqual(blocked(StartupCompatibilityErrorCode.NativeSchemaUnsupported));
    expect(assessStartupDelivery({ source, target, declaredDowngrades: [declaration], nativeCompatibilityConfirmed: true }))
      .toEqual({ allowed: true, direction: 'declared-downgrade' });
  });
  test.each(['source', 'target'] as const)('requires the complete exact %s identity', side => {
    for (const change of [{ appVersion: 'v2026.10.20' }, { runtimeVersion: 'v2026.10.4' },
      { runtimeBuildId: 'b'.repeat(64) }]) {
      const changed = { ...declaration, [side]: { ...declaration[side], ...change } };
      expect(assessStartupDelivery({ source, target, declaredDowngrades: [changed], nativeCompatibilityConfirmed: true }))
        .toEqual(blocked(StartupCompatibilityErrorCode.DowngradeBlocked));
    }
  });
  test('rejects empty evidence, version ranges and partial identities', () => {
    for (const invalid of [{ ...declaration, evidenceId: ' ' },
      { ...declaration, target: { ...target, appVersion: '*' } },
      { ...declaration, source: { ...source, runtimeBuildId: '' } }])
      expect(assessStartupDelivery({ source, target, declaredDowngrades: [invalid], nativeCompatibilityConfirmed: true }))
        .toEqual(blocked(StartupCompatibilityErrorCode.DowngradeBlocked));
  });
});

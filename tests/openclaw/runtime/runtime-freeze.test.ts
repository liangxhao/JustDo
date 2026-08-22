import { expect, test } from 'vitest';

const { decideRuntimeBundle, decideRuntimeInstall } =
  require('../../../scripts/openclaw-runtime-freeze.cjs') as {
    decideRuntimeInstall: (state: {
      forceInstall: boolean;
      targetExists: boolean;
    }) => 'install' | 'verify-frozen';
    decideRuntimeBundle: (state: {
      forceInstall: boolean;
      bundleExists: boolean;
      initialBundlePending: boolean;
    }) => 'build' | 'build-initial' | 'verify-frozen' | 'reject';
  };

test('installs only for a missing target or explicit force', () => {
  expect(decideRuntimeInstall({ forceInstall: false, targetExists: false })).toBe('install');
  expect(decideRuntimeInstall({ forceInstall: false, targetExists: true })).toBe('verify-frozen');
  expect(decideRuntimeInstall({ forceInstall: true, targetExists: true })).toBe('install');
});

test('builds a bundle only for first installation or explicit force', () => {
  expect(
    decideRuntimeBundle({
      forceInstall: false,
      bundleExists: false,
      initialBundlePending: true,
    }),
  ).toBe('build-initial');
  expect(
    decideRuntimeBundle({
      forceInstall: true,
      bundleExists: true,
      initialBundlePending: false,
    }),
  ).toBe('build');
});

test('verifies complete bundles and rejects incomplete existing runtimes', () => {
  expect(
    decideRuntimeBundle({
      forceInstall: false,
      bundleExists: true,
      initialBundlePending: false,
    }),
  ).toBe('verify-frozen');
  expect(
    decideRuntimeBundle({
      forceInstall: false,
      bundleExists: false,
      initialBundlePending: false,
    }),
  ).toBe('reject');
});

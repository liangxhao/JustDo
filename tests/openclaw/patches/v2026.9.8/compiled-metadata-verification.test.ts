import { expect, test } from 'vitest';

const agent =
  require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs').__testing;
const reviewer =
  require('../../../../scripts/patches/v2026.9.8/007-request-purpose-metadata.cjs').__testing;

test.each([
  { owner: agent, source: agent.WRAPPER, alias: 'loadJustDoSessionEntry' },
  {
    owner: reviewer,
    source: reviewer.REVIEWER_SESSION_BLOCK,
    alias: 'loadJustDoReviewerSessionEntry',
  },
])('verifies the scoped async read after esbuild resolves $alias', ({ owner, source, alias }) => {
  expect(() => owner.verifyAsyncSessionRead(source, 'source.mjs')).not.toThrow();
  const bundle = source
    .replaceAll(alias, 'withSessionEntryReadOnlyInWorker')
    .replaceAll('read)', 'read6)')
    .replaceAll('read.ok', 'read6.ok')
    .replaceAll('read.value', 'read6.value');
  expect(() => owner.verifyAsyncSessionRead(bundle, 'gateway-bundle.mjs')).not.toThrow();
  expect(() => owner.verifyAsyncSessionRead(bundle, 'source.mjs')).toThrow();
  expect(() =>
    owner.verifyAsyncSessionRead(
      bundle.replace(
        'await withSessionEntryReadOnlyInWorker(',
        'withSessionEntryReadOnlyInWorker(',
      ),
      'gateway-bundle.mjs',
    ),
  ).toThrow();
  const unrelatedRead =
    '\nasync function unrelated() { await withSessionEntryReadOnlyInWorker({ readConsistency: "latest" }); }';
  expect(() =>
    owner.verifyAsyncSessionRead(
      bundle.replace('await withSessionEntryReadOnlyInWorker(', 'await wrongAccessor(') +
        unrelatedRead,
      'gateway-bundle.mjs',
    ),
  ).toThrow();
});

test('bundle metadata verification requires caller authority through and after the read', () => {
  const source = agent.WRAPPER.replaceAll(
    'loadJustDoSessionEntry',
    'withSessionEntryReadOnlyInWorker',
  );
  for (const invalid of [
    source.replace('params.assertCurrent,', '() => {},'),
    source.replace('params.assertCurrent();', ''),
  ]) {
    expect(() => agent.verifyAsyncSessionRead(invalid, 'gateway-bundle.mjs')).toThrow(/authority/);
  }
});

import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';

const { patchFollowupInitiation } =
  require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs');
const agent =
  require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs').__testing;
const reviewer =
  require('../../../../scripts/patches/v2026.9.8/007-request-purpose-metadata.cjs').__testing;

test('accepts only the complete current queued initiation transfer after esbuild', async () => {
  const source = `async function executeFollowupTurn(turn2, sourceTurnId) {
    replyRunRegistry.bindSourceTurnId(turn2.operation, sourceTurnId);
    return 42;
  }`;
  const compiled = transformSync(patchFollowupInitiation(source, 'native.mjs'), {
    loader: 'js',
    target: 'es2023',
  }).code.replaceAll('justDoFollowupHumanRuns', 'justDoFollowupHumanRuns2');
  expect(compiled).not.toContain(agent.CONTRACT);
  expect(compiled).toContain('/* @__PURE__ */ Symbol.for');
  expect(patchFollowupInitiation(compiled, 'gateway-bundle.mjs')).toBe(compiled);
  expect(() => patchFollowupInitiation(compiled, 'native.mjs')).toThrow(/partial/);

  const context = vm.createContext({ replyRunRegistry: { bindSourceTurnId() {} } });
  vm.runInContext(
    'globalThis[Symbol.for("justdo.builtin-models.human-runs")] = new Set(["source"]);',
    context,
  );
  const execute = vm.runInContext(`${compiled}\nexecuteFollowupTurn`, context);
  expect(await execute({ operation: {}, runId: 'execution' }, 'source')).toBe(42);
  expect(vm.runInContext('[...globalThis[Symbol.for("justdo.builtin-models.human-runs")]]', context))
    .toEqual(['execution']);

  for (const invalid of [
    compiled.replace('.delete(sourceTurnId)', '.delete(wrongSource)'),
    compiled.replace('.add(turn2.runId)', '.add(wrongTurn.runId)'),
    compiled.replace('if (justDoFollowupHumanRuns2?.delete(sourceTurnId))', ''),
    compiled.replace('justdo.builtin-models.human-runs', 'wrong-registry'),
    compiled.replace('replyRunRegistry.bindSourceTurnId(turn2.operation, sourceTurnId),', '0,'),
    compiled.replace('const justDoFollowupHumanRuns2', 'sideEffect(); const justDoFollowupHumanRuns2'),
    `${source}\n${compiled.replace('executeFollowupTurn', 'unrelated')}`,
  ]) {
    expect(() => patchFollowupInitiation(invalid, 'gateway-bundle.mjs')).toThrow();
  }
});

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

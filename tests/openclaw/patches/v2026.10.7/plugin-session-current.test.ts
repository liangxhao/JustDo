import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/_plugin-session-current.js');
const root = path.resolve(process.env.JUSTDO_EXECUTION_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current');
const filename = path.join(root, 'dist/session-binding-runtime-EiGMQwyv.mjs');
const nativeOnDisk = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined;
const native = nativeOnDisk ?? fs.readFileSync(
  new URL('./plugin-session-current.fixture.txt', import.meta.url), 'utf8',
);
const original = { sessionId: 'session-one', lifecycleRevision: 'revision-one', pluginOwnerId: 'owner-one' };

function harness(patched = true) {
  const source = patched ? patch.transformPluginSessionCurrentCheck(native!, filename) : native!;
  const body = patch.__testing.extract(source, filename).body;
  const state = {
    current: { ...original }, physical: 'database-one', active: true, sourceActive: true,
    beforeRead: Promise.resolve(), projections: [] as string[],
    source: undefined as { fields: string[]; expected: typeof original } | undefined,
  };
  const capture = vm.runInNewContext(`async ${body}; captureSessionEntryCurrentCheck`, {
    resolveSessionStorePathForScope: () => 'database.sqlite',
    captureSessionEntryReadScope: (scope: object) => ({ scope, agentId: 'main' }),
    isNativeSessionEntryRead: () => false,
    captureSessionStoreReadCandidates: () => [{ path: 'database.sqlite', physicalPath: 'database.sqlite' }],
    isSessionStoreReadCandidateCurrent: () => true,
    assertSessionStoreReadCandidate: () => 'database.sqlite',
    readDatabasePathIdentitySync: () => ({ key: `file:${state.physical}`, birthtime: 1, canonicalPath: 'database.sqlite' }),
    resolveSqliteSessionKey: (key: string) => key,
    loadSessionEntryReadOnly: () => ({ ...state.current }),
    captureSessionEntrySourceAssertion: (params: typeof state.source & { assertCurrent: () => void }) => {
      state.source = params;
      return params.assertCurrent;
    },
    withSessionEntryReadOnlyInWorker: async (scope: { projection: string }, assertCurrent: () => void,
      consume: (read: unknown, owner: unknown) => Promise<unknown>) => {
      assertCurrent();
      await state.beforeRead;
      assertCurrent();
      state.projections.push(scope.projection);
      const value: Partial<typeof original> = { ...state.current };
      if (scope.projection === 'list') delete value.pluginOwnerId;
      const result = await consume({ ok: true, value }, {
        kind: 'file', scope,
        assertCurrent: () => { if (!state.sourceActive) throw new Error('Reader retired'); },
      });
      assertCurrent();
      return result;
    },
  });
  return {
    state, source,
    capture: (options: Record<string, unknown> = {}) => capture({
      agentId: 'main', sessionKey: 'agent:main:fixture',
      expectedSessionEntry: { ...original }, isActive: () => state.active, ...options,
    }) as Promise<{ isCurrent: () => boolean; assertCurrent: () => void }>,
  };
}

test('requires the locked native guard when runtime contracts are mandatory', () => {
  if (process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1') expect(nativeOnDisk).toBeDefined();
});

describe('native execution session currentness', () => {
  test('demonstrates the native owner-only race and refuses it with the exact execution predicate', async () => {
    const control = harness(false);
    const baseline = await control.capture({ expectedSessionEntry: undefined });
    control.state.current.pluginOwnerId = 'replacement-owner';
    expect(baseline.isCurrent()).toBe(true);

    const current = harness();
    const proof = await current.capture();
    expect(proof.isCurrent()).toBe(true);
    expect(current.state.projections).toEqual(['full']);
    expect(current.state.source?.fields).toEqual(['sessionId', 'lifecycleRevision', 'pluginOwnerId']);
    expect(current.state.source?.expected).toEqual(original);
    current.state.current.pluginOwnerId = 'replacement-owner';
    expect(proof.isCurrent()).toBe(false);
    expect(() => proof.assertCurrent()).toThrow();
  });

  test.each(['sessionId', 'lifecycleRevision', 'pluginOwnerId'] as const)(
    'rejects a changed %s even when matchGeneration is false', async field => {
      const current = harness();
      const proof = await current.capture({ matchGeneration: false });
      current.state.current[field] = 'replacement';
      expect(proof.isCurrent()).toBe(false);
      expect(() => proof.assertCurrent()).toThrow();
    },
  );

  test('captures immutable expected facts before the actual asynchronous native consumer', async () => {
    const current = harness();
    let release!: () => void;
    current.state.beforeRead = new Promise<void>(resolve => { release = resolve; });
    const expected = { ...original };
    const pending = current.capture({ expectedSessionEntry: expected });
    expected.pluginOwnerId = 'replacement-owner';
    release();
    const proof = await pending;
    expect(proof.isCurrent()).toBe(true);
    current.state.current.pluginOwnerId = expected.pluginOwnerId;
    expect(proof.isCurrent()).toBe(false);
    expect(current.state.current).not.toBe(expected);
  });

  test('refuses a stale initial worker result without publishing a proof', async () => {
    const current = harness();
    current.state.current.pluginOwnerId = 'replacement-owner';
    await expect(current.capture()).rejects.toThrow();
    expect(current.state.source).toBeUndefined();
  });

  test('retains native database and caller fences', async () => {
    const current = harness();
    const proof = await current.capture();
    current.state.physical = 'replacement-database';
    expect(proof.isCurrent()).toBe(false);
    current.state.physical = 'database-one';
    current.state.active = false;
    expect(proof.isCurrent()).toBe(false);
  });

  test('keeps legacy callers on the original list projection and generation option', async () => {
    const current = harness();
    const proof = await current.capture({ expectedSessionEntry: undefined, matchGeneration: false });
    current.state.current = { sessionId: 'other', lifecycleRevision: 'other', pluginOwnerId: 'other' };
    expect(proof.isCurrent()).toBe(true);
    expect(current.state.projections).toEqual(['list']);
    expect(current.state.source?.fields).toEqual([]);
  });

  test('verifies full native semantics after minification and rejects partial owner guards', () => {
    const patched = patch.transformPluginSessionCurrentCheck(native!, filename);
    expect(patch.transformPluginSessionCurrentCheck(patched, filename)).toBe(patched);
    const body = patch.__testing.extract(patched, filename).body;
    const compiled = transformSync(`async ${body}`, {
      minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: true,
    }).code;
    expect(() => patch.assertPluginSessionCurrentCheck(compiled, 'bundle')).not.toThrow();
    for (const damaged of [
      patched.replace('"sessionId", "lifecycleRevision", "pluginOwnerId"] : params.matchGeneration',
        '"sessionId", "lifecycleRevision"] : params.matchGeneration'),
      patched.replace('current?.pluginOwnerId !== expectedExecutionSession.pluginOwnerId', 'false'),
      patched.replace('projection: expectedExecutionSession ? "full" : "list"', 'projection: "list"'),
      patched.replace('async function captureSessionEntryCurrentCheck(', 'function captureSessionEntryCurrentCheck('),
      patched.replace('async function captureSessionEntryCurrentCheck(', '// async\nfunction captureSessionEntryCurrentCheck('),
    ]) {
      expect(damaged).not.toBe(patched);
      expect(() => patch.transformPluginSessionCurrentCheck(damaged, filename)).toThrow();
    }
  });
});

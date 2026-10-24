import path from 'node:path';
import vm from 'node:vm';

import { expect, test } from 'vitest';

const { __testing: { transform } } = require('../../../../scripts/patches/v2026.10.6/018-windows-session-creation-path.cjs');
const native = `function assertSessionEntryCreationTarget(creation, target) {
  assertSessionEntryCreationCurrent(creation);
  const sourcePath = creation.source.kind === "native" ? creation.source.database.path : creation.source.path;
  const matchesDatabaseIdentity = creation.source.kind !== "native" && target.databaseIdentity === (creation.source.kind === "actor" ? creation.source.databaseIdentity : \`file:\${creation.source.databaseIdentity}\`);
  const matchesTarget = target.databaseIdentity !== void 0 ? matchesDatabaseIdentity : target.paths.has(path.resolve(sourcePath));
  if (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !matchesTarget) throw new Error("Session creation publication owner is no longer current");
}`;

function harness() {
  const source = transform(native, 'creation.mjs');
  const check = vm.runInNewContext(`${source}; assertSessionEntryCreationTarget`, {
    path: path.win32,
    assertSessionEntryCreationCurrent: (creation: { active: boolean }) => {
      if (!creation?.active) throw new Error('inactive creation');
    },
  });
  return { source, check };
}

test('matches Windows namespace aliases while retaining exact agent, session and case', () => {
  const { check } = harness();
  const ordinary = 'C:\\state\\agent\\store.sqlite';
  const namespaced = path.win32.toNamespacedPath(ordinary);
  for (const [sourcePath, admitted] of [[ordinary, namespaced], [namespaced, ordinary]]) {
    const creation = { active: true, agentId: 'main', sessionKey: 'chat', source: { kind: 'file', path: sourcePath } };
    const target = { agentId: 'main', sessionKey: 'chat', paths: new Set([admitted]) };
    expect(() => check(creation, target)).not.toThrow();
    expect(() => check(creation, { ...target, agentId: 'other' })).toThrow();
    expect(() => check(creation, { ...target, sessionKey: 'other' })).toThrow();
    expect(() => check(creation, { ...target, paths: new Set([ordinary.replace('state', 'STATE')]) })).toThrow();
    expect(() => check({ ...creation, active: false }, target)).toThrow();
  }
});

test('keeps actor and physical identity authoritative over matching paths', () => {
  const { check } = harness();
  const filename = 'C:\\state\\store.sqlite';
  const target = { agentId: 'main', sessionKey: 'chat', paths: new Set([filename]), databaseIdentity: 'actor-owner' };
  const creation = { active: true, agentId: 'main', sessionKey: 'chat', source: { kind: 'actor', path: filename, databaseIdentity: 'actor-owner' } };
  expect(() => check(creation, target)).not.toThrow();
  expect(() => check(creation, { ...target, databaseIdentity: 'replacement' })).toThrow();
  expect(() => check({ ...creation, source: { ...creation.source, kind: 'native', database: { path: filename } } }, target)).toThrow();
});

test('rejects partial and historical forms and preserves current idempotence', () => {
  const { source } = harness();
  expect(transform(source, 'creation.mjs')).toBe(source);
  expect(() => transform(source.replace('toNamespacedPath', 'resolve'), 'creation.mjs')).toThrow();
  expect(() => transform(source.replaceAll('V2026_10_6', 'V2026_10_4'), 'creation.mjs')).toThrow();
  expect(() => transform(native.replace('assertSessionEntryCreationCurrent(creation)', 'unchecked(creation)'), 'creation.mjs')).toThrow();
});

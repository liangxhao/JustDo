import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';
const {
  __testing: { transform },
} = require('../../../../scripts/patches/v2026.9.8/032-windows-session-creation-path.cjs');
const source = `function assertSessionEntryCreationPublication(operation, target) {
  const creation = preparedSharingChanges.operations.get(operation);
  assertCreationCurrent(creation);
  const sourcePath = creation.source.kind === "native" ? creation.source.database.path : creation.source.path;
  if (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !target.paths.has(path.resolve(sourcePath))) {
    throw new Error("Session creation publication owner is no longer current");
  }
}`;
function guard(platform: typeof path.win32 | typeof path.posix = path.win32) {
  const operations = new Map();
  const patched = transform(source, 'source.mjs');
  const check = vm.runInNewContext(`${patched}; assertSessionEntryCreationPublication`, {
    path: platform,
    preparedSharingChanges: { operations },
    assertCreationCurrent: (creation: {
      active: boolean;
      source: { database?: { open: boolean } };
    }) => {
      if (!creation?.active || creation.source.database?.open === false)
        throw new Error('inactive creation');
    },
  });
  return { operations, check };
}
test('accepts exact Windows namespace equivalents in either direction without widening ownership', () => {
  const { operations, check } = guard();
  const ordinary = 'C:\\state\\agent\\openclaw-agent.sqlite';
  const namespaced = path.win32.toNamespacedPath(ordinary);
  const operation = {};
  for (const [sourcePath, admitted] of [
    [namespaced, ordinary],
    [ordinary, namespaced],
  ]) {
    operations.set(operation, {
      active: true,
      agentId: 'main',
      sessionKey: 'key',
      source: { kind: 'file', path: sourcePath },
    });
    expect(() =>
      check(operation, { agentId: 'main', sessionKey: 'key', paths: new Set([admitted]) }),
    ).not.toThrow();
    for (const target of [
      { agentId: 'other', sessionKey: 'key', paths: new Set([admitted]) },
      { agentId: 'main', sessionKey: 'other', paths: new Set([admitted]) },
      {
        agentId: 'main',
        sessionKey: 'key',
        paths: new Set(['C:\\different\\openclaw-agent.sqlite']),
      },
      { agentId: 'main', sessionKey: 'key', paths: new Set([ordinary.replace('state', 'STATE')]) },
    ])
      expect(() => check(operation, target)).toThrow();
  }
  operations.set(operation, {
    active: true,
    agentId: 'main',
    sessionKey: 'key',
    source: { kind: 'native', database: { path: ordinary, open: false } },
  });
  expect(() =>
    check(operation, { agentId: 'main', sessionKey: 'key', paths: new Set([ordinary]) }),
  ).toThrow('inactive creation');
  operations.set(operation, { active: false, source: {} });
  expect(() => check(operation, {})).toThrow('inactive creation');
});
test('keeps POSIX exact path and case semantics', () => {
  const { operations, check } = guard(path.posix);
  const operation = {};
  operations.set(operation, {
    active: true,
    agentId: 'main',
    sessionKey: 'key',
    source: { kind: 'file', path: '/state/database.sqlite' },
  });
  expect(() =>
    check(operation, {
      agentId: 'main',
      sessionKey: 'key',
      paths: new Set(['/state/database.sqlite']),
    }),
  ).not.toThrow();
  expect(() =>
    check(operation, {
      agentId: 'main',
      sessionKey: 'key',
      paths: new Set(['/State/database.sqlite']),
    }),
  ).toThrow();
});
test('verifies compiled shapes and rejects partial or historical changes', () => {
  const patched = transform(source, 'source.mjs');
  expect(transform(patched, 'source.mjs')).toBe(patched);
  const compiled = transformSync(patched, {
    target: 'node24',
    minifySyntax: true,
    legalComments: 'none',
  }).code;
  expect(transform(compiled, 'gateway-bundle.mjs')).toBe(compiled);
  expect(() =>
    transform(
      patched.replace(')) === path.toNamespacedPath', ')) !== path.toNamespacedPath'),
      'source.mjs',
    ),
  ).toThrow();
  expect(() => transform(patched.replaceAll('V2026_9_8', 'V2026_9_6'), 'source.mjs')).toThrow();
});

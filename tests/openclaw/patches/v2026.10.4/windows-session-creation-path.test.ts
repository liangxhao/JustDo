import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';
const patch = require('../../../../scripts/patches/v2026.10.4/018-windows-session-creation-path.cjs');
const {
  __testing: { transform },
} = patch;
const source = `function assertSessionEntryCreationPublication(operation, target) {
  const creation = preparedSharingChanges.operations.get(operation);
  assertCreationCurrent(creation);
  const sourcePath = creation.source.kind === "native" ? creation.source.database.path : creation.source.path;
  const matchesDatabaseIdentity = creation.source.kind === "file" && target.databaseIdentity === \`file:\${creation.source.databaseIdentity}\`;
  const matchesTarget = target.databaseIdentity !== void 0 ? matchesDatabaseIdentity : target.paths.has(path.resolve(sourcePath));
  if (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !matchesTarget) {
    throw new Error("Session creation publication owner is no longer current");
  }
}`;
test('rejects mixed copies and a bad final target before writing any creation guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-path-patch-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    const files = [path.join(root, 'dist', 'creation.mjs'), path.join(root, 'gateway-bundle.mjs')];
    const current = [transform(source, files[0]), transformSync(transform(source, files[1]), { minifySyntax: true, legalComments: 'none' }).code];
    for (const contents of [[current[0], source], [source, current[1]], [source, source.replace('assertCreationCurrent(creation)', 'changed(creation)')]]) {
      files.forEach((file, i) => fs.writeFileSync(file, contents[i]));
      expect(() => patch.applyPatch(root)).toThrow();
      expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(contents);
    }
    files.forEach(file => fs.writeFileSync(file, source));
    expect(patch.applyPatch(root)).toHaveLength(2);
    fs.writeFileSync(files[1], current[1]);
    expect(patch.verifyPatch(root)).toEqual([]);
    expect(patch.applyPatch(root)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
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
  const renamed = compiled.replaceAll('target', 'target4').replaceAll('matchesDatabaseIdentity', 'matchesDatabaseIdentity2');
  expect(transform(renamed, 'gateway-bundle.mjs')).toBe(renamed);
  expect(() => transform(renamed.replace('target4.databaseIdentity !==', 'other.databaseIdentity !=='), 'gateway-bundle.mjs')).toThrow('ownership guards changed');
  expect(() =>
    transform(
      patched.replace(')) === path.toNamespacedPath', ')) !== path.toNamespacedPath'),
      'source.mjs',
    ),
  ).toThrow();
  expect(() => transform(patched.replaceAll('V2026_10_4', 'V2026_9_6'), 'source.mjs')).toThrow();
});

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';

const {
  applyPatch,
  verifyPatch,
  __testing,
} = require('../../../../scripts/patches/v2026.9.8/042-windows-plugin-recovery-junctions.cjs');
const { MARKER, transformRecovery } = __testing;
const source = `function captureRecoverySource({ rootDir, sourceRoot, capturedRoot, boundaryRoot, capturedPaths, captureNativeRecovery }) {
  const recovery = createPluginSourceCapture();
  let native;
  try {
    native = captureNativeRecovery?.();
    const hardlinkedTargets = new Map();
    fs.cpSync(boundaryRoot, recovery.directory, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (from, to) => {
        const fact = native?.references.get(from);
        if (!fact) return true;
        const retained = { ...fact, sourceIdentity: fact.capturedIdentity };
        if (linkPluginNativeReference(fact.capturedPath, to, retained) === "hardlink") hardlinkedTargets.set(to, retained);
        native.references.set(from, retained);
        return false;
      }
    });
    for (const [target, fact] of hardlinkedTargets) assertPluginNativeReferenceNamespace(target, fact, native.namespaces.get(fact.namespace), recovery.directory);
    const relocate = (filename) => path.join(recovery.directory, path.relative(boundaryRoot, filename));
    for (const captured of new Set(capturedPaths.values())) fs.lstatSync(relocate(captured));
    const sources = new Map(Array.from(capturedPaths, ([source, captured]) => [source, relocate(captured)]));
    return {
      rootDir: relocate(capturedRoot),
      resolve: createRecoverySourceResolver(rootDir, sourceRoot, sources),
      native: native && {
        ...native,
        references: new Map(Array.from(native.references, ([source, fact]) => [relocate(source), fact])),
        directories: new Map(Array.from(native.directories, ([source, namespace]) => [relocate(source), namespace]))
      },
      ...createRecoverySourceDisposal(recovery, native)
    };
  } catch (error) {
    createRecoverySourceDisposal(recovery, native).dispose();
    if (hasErrnoCode(error, "ENOENT")) throw new PluginSourceRecoveryUnavailableError(error);
    throw error;
  }
}`;
const taskRoot = path.resolve('.agent-tasks');
const roots: string[] = [];
const makeRoot = () => {
  fs.mkdirSync(taskRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(taskRoot, 'recovery-junctions-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(taskRoot, path.resolve(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Refusing to remove a recovery fixture outside the task directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

type CopyFilter = (from: string, to: string) => boolean;
type NativeRecovery = {
  references: Map<string, object>;
  namespaces: Map<string, object>;
  directories: Map<string, object>;
  dispose: () => void;
};
const createCapture = (copyFs: object, platform = process.platform, native?: NativeRecovery) => {
  const dispose = vi.fn(() => native?.dispose());
  const directory = path.join(makeRoot(), 'recovery');
  const assertNamespace = vi.fn();
  const linkReference = vi.fn(() => 'hardlink');
  const context = vm.createContext({
    fs: copyFs,
    path,
    process: { platform },
    createPluginSourceCapture: () => ({ directory }),
    createRecoverySourceDisposal: () => ({ dispose }),
    createRecoverySourceResolver:
      (_root: string, _source: string, sources: Map<string, string>) => (filename: string) =>
        sources.get(filename),
    assertPluginNativeReferenceNamespace: assertNamespace,
    linkPluginNativeReference: linkReference,
    hasErrnoCode: (error: { code?: string }, code: string) => error?.code === code,
    PluginSourceRecoveryUnavailableError: Error,
  });
  vm.runInContext(transformRecovery(source), context);
  const capture = vm.runInContext('captureRecoverySource', context) as (options: object) => {
    rootDir: string;
    resolve: (filename: string) => string;
  };
  const captureEmpty = () =>
    capture({
      rootDir: 'source',
      sourceRoot: 'source',
      capturedRoot: 'source',
      boundaryRoot: 'source',
      capturedPaths: new Map(),
      captureNativeRecovery: native ? () => native : undefined,
    });
  return { capture, captureEmpty, directory, dispose, linkReference, assertNamespace };
};
const inspectFilter = (platform = 'win32', native?: NativeRecovery) => {
  let filter!: CopyFilter;
  const copyFs = {
    cpSync: vi.fn((_from: string, _to: string, options: { filter: CopyFilter }) => {
      filter = options.filter;
    }),
    lstatSync: vi.fn(() => ({ isSymbolicLink: () => true })),
    readlinkSync: vi.fn(() => path.resolve('captured-host')),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    mkdirSync: vi.fn(),
    symlinkSync: vi.fn(),
  };
  const capture = createCapture(copyFs, platform as NodeJS.Platform, native);
  capture.captureEmpty();
  return { filter, copyFs, ...capture };
};

test.runIf(process.platform === 'win32')(
  'copies captured host and internal directory junctions without converting them to privileged symlinks',
  () => {
    const root = makeRoot();
    const boundaryRoot = path.join(root, 'capture');
    const host = path.join(root, 'host');
    fs.mkdirSync(path.join(boundaryRoot, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(boundaryRoot, 'lib'));
    fs.mkdirSync(host);
    const entry = path.join(boundaryRoot, 'index.js');
    fs.writeFileSync(entry, 'captured module');
    fs.writeFileSync(path.join(host, 'package.json'), '{"name":"captured-host"}');
    fs.writeFileSync(path.join(boundaryRoot, 'lib', 'local.js'), 'internal dependency');
    fs.symlinkSync(host, path.join(boundaryRoot, 'node_modules', 'openclaw'), 'junction');
    fs.symlinkSync(path.join(boundaryRoot, 'lib'), path.join(boundaryRoot, 'internal'), 'junction');
    const symlinkSync = vi.fn(fs.symlinkSync);
    const copyFs = { ...fs, symlinkSync };
    const fixture = createCapture(copyFs);

    const recovery = fixture.capture({
      rootDir: boundaryRoot,
      sourceRoot: boundaryRoot,
      capturedRoot: boundaryRoot,
      boundaryRoot,
      capturedPaths: new Map([[entry, entry]]),
    });

    expect(recovery.rootDir).toBe(fixture.directory);
    expect(recovery.resolve(entry)).toBe(path.join(fixture.directory, 'index.js'));
    expect(fs.readFileSync(recovery.resolve(entry), 'utf8')).toBe('captured module');
    expect(
      fs.lstatSync(path.join(fixture.directory, 'node_modules', 'openclaw')).isSymbolicLink(),
    ).toBe(true);
    expect(fs.readlinkSync(path.join(fixture.directory, 'node_modules', 'openclaw'))).toBe(
      fs.readlinkSync(path.join(boundaryRoot, 'node_modules', 'openclaw')),
    );
    expect(fs.readlinkSync(path.join(fixture.directory, 'internal'))).toBe(
      fs.readlinkSync(path.join(boundaryRoot, 'internal')),
    );
    expect(fs.readFileSync(path.join(fixture.directory, 'internal', 'local.js'), 'utf8')).toBe(
      'internal dependency',
    );
    expect(symlinkSync).toHaveBeenCalledTimes(2);
    expect(symlinkSync.mock.calls.every(call => call[2] === 'junction')).toBe(true);
    fs.writeFileSync(recovery.resolve(entry), 'independent recovery');
    expect(fs.readFileSync(entry, 'utf8')).toBe('captured module');
    expect(fixture.dispose).not.toHaveBeenCalled();
  },
);

test('keeps native references ahead of junction copying', () => {
  const fact = {
    capturedPath: 'native-capture',
    capturedIdentity: 'captured-identity',
    namespace: 'native',
  };
  const namespace = { admitted: true };
  const native = {
    references: new Map([['captured-link', fact]]),
    namespaces: new Map([['native', namespace]]),
    directories: new Map(),
    dispose: vi.fn(),
  };
  const { filter, copyFs, linkReference } = inspectFilter('win32', native);

  expect(filter('captured-link', 'recovery-link')).toBe(false);

  expect(linkReference).toHaveBeenCalledExactlyOnceWith('native-capture', 'recovery-link', {
    ...fact,
    sourceIdentity: 'captured-identity',
  });
  expect(native.references.get('captured-link')).toMatchObject({
    sourceIdentity: 'captured-identity',
  });
  expect(copyFs.lstatSync).not.toHaveBeenCalled();
  expect(copyFs.symlinkSync).not.toHaveBeenCalled();
});

test('retains the native hardlink identity and namespace assertion before admitting recovery', () => {
  const fact = {
    capturedPath: 'native-capture',
    capturedIdentity: 'captured-identity',
    namespace: 'native',
  };
  const namespace = { admitted: true };
  const native = {
    references: new Map([['source/admitted.node', fact]]),
    namespaces: new Map([['native', namespace]]),
    directories: new Map(),
    dispose: vi.fn(),
  };
  const lstatSync = vi.fn();
  const fixture = createCapture(
    {
      cpSync: (_from: string, to: string, options: { filter: CopyFilter }) =>
        expect(options.filter('source/admitted.node', path.join(to, 'admitted.node'))).toBe(false),
      lstatSync,
    },
    'win32',
    native,
  );

  fixture.captureEmpty();

  expect(fixture.assertNamespace).toHaveBeenCalledExactlyOnceWith(
    path.join(fixture.directory, 'admitted.node'),
    { ...fact, sourceIdentity: 'captured-identity' },
    namespace,
    fixture.directory,
  );
  expect(lstatSync).not.toHaveBeenCalled();
  expect(fixture.dispose).not.toHaveBeenCalled();
});

test.each(['linux', 'darwin'])('keeps the native copy and filter unchanged on %s', platform => {
  const { filter, copyFs } = inspectFilter(platform);

  expect(filter('from', 'to')).toBe(true);

  expect(copyFs.cpSync.mock.calls[0][2]).toMatchObject({ recursive: true, verbatimSymlinks: true });
  expect(Object.keys(copyFs.cpSync.mock.calls[0][2])).toEqual([
    'recursive',
    'verbatimSymlinks',
    'filter',
  ]);
  expect(copyFs.lstatSync).not.toHaveBeenCalled();
  expect(copyFs.symlinkSync).not.toHaveBeenCalled();
});

test.each(['file', 'ordinary', 'relative', 'dangling'])(
  'leaves a %s entry to native verbatim copying',
  type => {
    const { filter, copyFs } = inspectFilter();
    if (type === 'file') copyFs.statSync.mockReturnValue({ isDirectory: () => false });
    if (type === 'ordinary') copyFs.lstatSync.mockReturnValue({ isSymbolicLink: () => false });
    if (type === 'relative') copyFs.readlinkSync.mockReturnValue('../relative-host');
    if (type === 'dangling')
      copyFs.statSync.mockImplementation(() => {
        throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      });

    expect(filter('from', 'to')).toBe(true);

    expect(copyFs.symlinkSync).not.toHaveBeenCalled();
    expect(copyFs.mkdirSync).not.toHaveBeenCalled();
    if (type === 'relative') expect(copyFs.statSync).not.toHaveBeenCalled();
  },
);

test('preserves capture cleanup and native disposal when creating an admitted junction fails', () => {
  const failure = Object.assign(new Error('Denied junction'), { code: 'EACCES' });
  const native = {
    references: new Map(),
    namespaces: new Map(),
    directories: new Map(),
    dispose: vi.fn(),
  };
  const copyFs = {
    cpSync: (_from: string, _to: string, options: { filter: CopyFilter }) =>
      options.filter('from', 'to'),
    lstatSync: () => ({ isSymbolicLink: () => true }),
    readlinkSync: () => path.resolve('captured-host'),
    statSync: () => ({ isDirectory: () => true }),
    mkdirSync: vi.fn(),
    symlinkSync: () => {
      throw failure;
    },
  };
  const { captureEmpty, dispose } = createCapture(copyFs, 'win32', native);

  expect(captureEmpty).toThrow(failure);
  expect(dispose).toHaveBeenCalledOnce();
  expect(native.dispose).toHaveBeenCalledOnce();
});

test('accepts only the exact current source and minified bundled junction patch', () => {
  const patched = transformRecovery(source, 'native.mjs');
  expect(transformRecovery(patched, 'native.mjs')).toBe(patched);
  const compiled = transformSync(patched, {
    minifySyntax: true,
    minifyIdentifiers: true,
    minifyWhitespace: true,
    legalComments: 'none',
  }).code;
  expect(transformRecovery(compiled, 'gateway-bundle.mjs')).toBe(compiled);
  expect(() =>
    transformRecovery(patched.replace(MARKER, MARKER.replace('9_8', '9_6')), 'native.mjs'),
  ).toThrow(/historical/);
  expect(() => transformRecovery(patched.replace(`// ${MARKER}\n`, ''), 'native.mjs')).toThrow(
    /missing/,
  );
  expect(() => transformRecovery(`// ${MARKER}\n${source}`, 'native.mjs')).toThrow(/partial/);
  expect(() => transformRecovery(patched.replace('"junction"', '"dir"'), 'native.mjs')).toThrow(
    /partial/,
  );
  expect(() =>
    transformRecovery(
      patched.replace('if (!path.isAbsolute(target)) return true;', ''),
      'native.mjs',
    ),
  ).toThrow(/partial/);
  expect(() =>
    transformRecovery(patched.replace('let directory;', 'const directory;'), 'native.mjs'),
  ).toThrow();
});

test.each([
  source.replace('verbatimSymlinks: true', 'verbatimSymlinks: false'),
  source.replace('sourceIdentity: fact.capturedIdentity', 'sourceIdentity: fact.sourceIdentity'),
  source.replace(
    'assertPluginNativeReferenceNamespace(target, fact, native.namespaces.get(fact.namespace), recovery.directory);',
    '',
  ),
])('rejects changed native copy or reference admission contracts', drifted => {
  expect(() => transformRecovery(drifted, 'native.mjs')).toThrow(/changed/);
});

const runtimeTargets = [
  'dist/plugin-generation-artifact-fixture.mjs',
  'dist/package-update-activation-recovery.mjs',
  'dist/worker/worker.mjs',
  'dist/worker/sqlite-store.worker.mjs',
];
const createRuntime = (bundle: boolean) => {
  const root = makeRoot();
  const targets = [...runtimeTargets, ...(bundle ? ['gateway-bundle.mjs'] : [])];
  for (const target of targets) {
    const file = path.join(root, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      target.includes('worker/') ? transformSync(source, { minify: true }).code : source,
    );
  }
  return { root, targets };
};

test.each([false, true])(
  'patches all four native copies and optional Gateway bundle (%s)',
  bundle => {
    const { root, targets } = createRuntime(bundle);
    expect(() => verifyPatch(root)).toThrow(/missing/);
    expect(applyPatch(root)).toHaveLength(targets.length);
    expect(verifyPatch(root)).toEqual([]);
    expect(applyPatch(root)).toEqual([]);
  },
);

test('validates all target plans before writing any runtime copy', () => {
  const { root, targets } = createRuntime(true);
  const drifted = path.join(root, 'dist/worker/worker.mjs');
  fs.writeFileSync(drifted, source.replace('verbatimSymlinks: true', 'verbatimSymlinks: false'));
  const originals = targets.map(target => fs.readFileSync(path.join(root, target), 'utf8'));

  expect(() => applyPatch(root)).toThrow(/copy options changed/);

  expect(targets.map(target => fs.readFileSync(path.join(root, target), 'utf8'))).toEqual(
    originals,
  );
});

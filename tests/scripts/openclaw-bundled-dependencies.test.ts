import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const {
  RUNTIME_BUNDLED_DEPENDENCIES_FILENAME,
  readBundledDependencyPaths,
  assertBundledDependencyArchiveEntry,
  inspectPristineBundledDependencies,
  restorePristineBundledDependencies,
  verifyBundledDependencies,
} = require('../../scripts/openclaw/openclaw-bundled-dependencies.cjs');

const sourceLock = {
  name: 'openclaw',
  version: '2026.10.7',
  tarballSha256: 'a'.repeat(64),
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
};
const registryIntegrity = `sha512-${Buffer.alloc(64, 2).toString('base64')}`;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function put(root: string, relative: string, contents: string | Buffer) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function json(root: string, relative: string, value: unknown) {
  put(root, relative, JSON.stringify(value, null, 2) + '\n');
}

function read(root: string, relative: string) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function snapshot(root: string): unknown[] {
  const entries: unknown[] = [];
  function visit(directory: string, prefix: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(file)]);
      else if (info.isDirectory()) {
        entries.push([relative, 'directory']);
        visit(file, relative);
      } else entries.push([relative, fs.readFileSync(file).toString('hex')]);
    }
  }
  visit(root, '');
  return entries;
}

function fixture(names = ['chrome-devtools-mcp']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-dependency-proof-'));
  roots.push(root);
  const pristine = path.join(root, 'pristine');
  const runtime = path.join(root, 'runtime');
  const pkg = {
    name: 'openclaw',
    version: '2026.10.7',
    bundleDependencies: names,
    dependencies: Object.fromEntries(names.map(name => [name, '1.10.1'])),
  };
  json(pristine, 'package.json', pkg);
  json(runtime, 'package.json', pkg);
  const lock: { name: string; version: string; packages: Record<string, unknown> } = {
    name: pkg.name,
    version: pkg.version,
    packages: { '': pkg },
  };
  for (const name of names) {
    const relative = `node_modules/${name}`;
    for (const owner of [pristine, runtime])
      json(owner, `${relative}/package.json`, { name, version: '1.10.1' });
    put(
      pristine,
      `${relative}/build/src/TextSnapshot.js`,
      'export const capturedSession = "guarded";\n',
    );
    put(pristine, `${relative}/build/src/McpPage.js`, 'export const guardedRenderer = true;\n');
    put(
      pristine,
      `${relative}/build/src/OPENCLAW_PATCH_NOTICE.md`,
      'Upstream reviewed identity backport.\n',
    );
    put(pristine, `${relative}/LICENSE`, 'Original license\n');
    put(pristine, `${relative}/nested/assets/data.bin`, Buffer.from([0, 255, 42, 128]));
    put(runtime, `${relative}/build/src/TextSnapshot.js`, 'export const backendOnly = true;\n');
    put(runtime, `${relative}/stock-only.js`, 'must disappear\n');
    lock.packages[relative] = {
      version: '1.10.1',
      resolved: `https://registry.example.invalid/${name}/-/${name.split('/').at(-1)}-1.10.1.tgz`,
      integrity: registryIntegrity,
      inBundle: true,
    };
  }
  json(runtime, 'package-lock.json', lock);
  put(runtime, 'node_modules/unrelated/keep.txt', 'unrelated installed dependency\n');
  const proof = inspectPristineBundledDependencies(pristine, { sourceLock });
  const restore = (options: Record<string, unknown> = {}) =>
    restorePristineBundledDependencies(runtime, pristine, {
      sourceLock,
      pristineProof: proof,
      ...options,
    });
  return { root, pristine, runtime, proof, restore };
}

test('restores the complete same-version upstream bundle, preserves base origin and unrelated packages', () => {
  const f = fixture(['chrome-devtools-mcp', '@owner/nested']);
  const rawBefore = snapshot(f.pristine);
  const lockBefore = fs.readFileSync(path.join(f.runtime, 'package-lock.json'));
  const result = f.restore();
  expect(result.dependencies.map((dependency: { name: string }) => dependency.name)).toEqual([
    '@owner/nested',
    'chrome-devtools-mcp',
  ]);
  for (const dependency of result.dependencies) {
    expect(snapshot(path.join(f.runtime, dependency.path))).toEqual(
      snapshot(path.join(f.pristine, dependency.path)),
    );
    expect(dependency.baseOrigin).toMatchObject({
      version: '1.10.1',
      integrity: registryIntegrity,
      inBundle: true,
    });
    expect(dependency.files.map((file: { path: string }) => file.path)).toContain(
      'build/src/OPENCLAW_PATCH_NOTICE.md',
    );
    expect(dependency.files.map((file: { path: string }) => file.path)).toContain('LICENSE');
    expect(dependency.files.map((file: { path: string }) => file.path)).toContain(
      'nested/assets/data.bin',
    );
    expect(dependency.treeSha256).toBe(
      crypto.createHash('sha256').update(JSON.stringify(dependency.files)).digest('hex'),
    );
  }
  expect(
    fs.readFileSync(path.join(f.runtime, 'node_modules/unrelated/keep.txt'), 'utf8'),
  ).toContain('unrelated');
  expect(fs.readFileSync(path.join(f.runtime, 'package-lock.json'))).toEqual(lockBefore);
  expect(snapshot(f.pristine)).toEqual(rawBefore);
  expect(verifyBundledDependencies(f.runtime, { sourceLock })).toEqual(result);
  // npm shrinkwrap changes the lockfile name, without changing registry origin.
  fs.renameSync(
    path.join(f.runtime, 'package-lock.json'),
    path.join(f.runtime, 'npm-shrinkwrap.json'),
  );
  expect(verifyBundledDependencies(f.runtime, { sourceLock })).toEqual(result);
});

test('uses codepoint order for all file proofs, independent of locale and creation order', () => {
  const f = fixture();
  for (const name of ['z.js', 'ä.js', 'A.js'])
    put(f.pristine, `node_modules/chrome-devtools-mcp/order/${name}`, name);
  const proof = inspectPristineBundledDependencies(f.pristine, { sourceLock });
  const result = f.restore({ pristineProof: proof });
  expect(
    result.dependencies[0].files
      .filter((file: { path: string }) => file.path.startsWith('order/'))
      .map((file: { path: string }) => file.path),
  ).toEqual(['order/A.js', 'order/z.js', 'order/ä.js']);
});

test('records an empty bundle only when both source and runtime have no declaration', () => {
  const f = fixture([]);
  for (const owner of [f.pristine, f.runtime])
    json(owner, 'package.json', { name: 'openclaw', version: '2026.10.7' });
  const proof = inspectPristineBundledDependencies(f.pristine, { sourceLock });
  expect(f.restore({ pristineProof: proof }).dependencies).toEqual([]);
  expect(verifyBundledDependencies(f.runtime, { sourceLock }).dependencies).toEqual([]);
});

test('reads safe archive prefixes from authenticated metadata before bundle files are extracted', () => {
  const f = fixture([]);
  json(f.runtime, 'package.json', {
    name: sourceLock.name,
    version: sourceLock.version,
    bundleDependencies: ['chrome-devtools-mcp', '@owner/nested'],
  });
  const before = snapshot(f.runtime);
  expect(readBundledDependencyPaths(f.runtime, { sourceLock })).toEqual([
    'node_modules/@owner/nested',
    'node_modules/chrome-devtools-mcp',
  ]);
  expect(fs.existsSync(path.join(f.runtime, 'node_modules/chrome-devtools-mcp'))).toBe(false);
  expect(snapshot(f.runtime)).toEqual(before);
  json(f.runtime, 'package.json', {
    name: sourceLock.name,
    version: sourceLock.version,
    bundleDependencies: ['../escape'],
  });
  const invalidBefore = snapshot(f.runtime);
  expect(() => readBundledDependencyPaths(f.runtime, { sourceLock })).toThrow(/Invalid/);
  expect(snapshot(f.runtime)).toEqual(invalidBefore);
});

test('admits contained regular archive entries before extraction and normalizes a directory terminator', () => {
  expect(
    assertBundledDependencyArchiveEntry('cfmind/node_modules/@owner/nested/build/page.js', 'File'),
  ).toBe('cfmind/node_modules/@owner/nested/build/page.js');
  expect(
    assertBundledDependencyArchiveEntry(
      'cfmind/node_modules/chrome-devtools-mcp/build/',
      'Directory',
    ),
  ).toBe('cfmind/node_modules/chrome-devtools-mcp/build');
});

test.each([
  '',
  '../outside',
  '/outside',
  'C:/outside',
  'cfmind/../outside',
  'cfmind//empty',
  'cfmind/file:alternate-stream',
  'cfmind/NUL',
  'cfmind/con.js',
  'cfmind/trailing.',
  'cfmind/trailing ',
  'cfmind/back\\slash',
  'cfmind/file/',
])('rejects unsafe archive path %j before any extraction', relative => {
  expect(() => assertBundledDependencyArchiveEntry(relative, 'File')).toThrow(/Unsafe/);
});

test.each(['SymbolicLink', 'Link', 'FIFO', 'CharacterDevice', 'BlockDevice'])(
  'rejects non-regular archive entry type %s before extraction',
  type => {
    expect(() => assertBundledDependencyArchiveEntry('cfmind/regular-name', type)).toThrow(
      /regular files/,
    );
  },
);

test.each([
  [
    'wrong source name',
    (f: ReturnType<typeof fixture>) =>
      json(f.pristine, 'package.json', { ...read(f.pristine, 'package.json'), name: 'other' }),
  ],
  [
    'wrong source version',
    (f: ReturnType<typeof fixture>) =>
      json(f.pristine, 'package.json', {
        ...read(f.pristine, 'package.json'),
        version: '2026.10.6',
      }),
  ],
  [
    'source byte tampering after capture',
    (f: ReturnType<typeof fixture>) =>
      put(f.pristine, 'node_modules/chrome-devtools-mcp/LICENSE', 'changed'),
  ],
  [
    'missing original notice',
    (f: ReturnType<typeof fixture>) =>
      fs.unlinkSync(
        path.join(
          f.pristine,
          'node_modules/chrome-devtools-mcp/build/src/OPENCLAW_PATCH_NOTICE.md',
        ),
      ),
  ],
  [
    'source package version drift',
    (f: ReturnType<typeof fixture>) =>
      json(f.pristine, 'node_modules/chrome-devtools-mcp/package.json', {
        name: 'chrome-devtools-mcp',
        version: '1.10.2',
      }),
  ],
  [
    'source package identity mismatch',
    (f: ReturnType<typeof fixture>) =>
      json(f.pristine, 'node_modules/chrome-devtools-mcp/package.json', {
        name: 'other',
        version: '1.10.1',
      }),
  ],
  [
    'range instead of exact source version',
    (f: ReturnType<typeof fixture>) =>
      json(f.pristine, 'package.json', {
        ...read(f.pristine, 'package.json'),
        dependencies: { 'chrome-devtools-mcp': '^1.10.1' },
      }),
  ],
] as const)('rejects %s before any runtime write', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow();
  expect(snapshot(f.runtime)).toEqual(before);
});

test.each(
  [
    true,
    ['../escape'],
    ['C:/escape'],
    ['chrome-devtools-mcp', 'chrome-devtools-mcp'],
    ['@owner/../escape'],
  ].map(declaration => ({ declaration })),
)(
  'rejects unsafe or implicit bundle declaration $declaration without writing',
  ({ declaration }) => {
    const f = fixture();
    json(f.pristine, 'package.json', {
      ...read(f.pristine, 'package.json'),
      bundleDependencies: declaration,
    });
    const before = snapshot(f.runtime);
    expect(() => f.restore()).toThrow();
    expect(snapshot(f.runtime)).toEqual(before);
  },
);

test('rejects conflicting declaration aliases without writing', () => {
  const f = fixture();
  json(f.pristine, 'package.json', {
    ...read(f.pristine, 'package.json'),
    bundledDependencies: [],
  });
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow(/Conflicting/);
  expect(snapshot(f.runtime)).toEqual(before);
});

test.each([
  [
    'different installed version',
    (f: ReturnType<typeof fixture>) =>
      json(f.runtime, 'node_modules/chrome-devtools-mcp/package.json', {
        name: 'chrome-devtools-mcp',
        version: '1.10.2',
      }),
  ],
  [
    'different installed package',
    (f: ReturnType<typeof fixture>) =>
      json(f.runtime, 'node_modules/chrome-devtools-mcp/package.json', {
        name: 'other',
        version: '1.10.1',
      }),
  ],
  [
    'changed root declaration',
    (f: ReturnType<typeof fixture>) =>
      json(f.runtime, 'package.json', {
        ...read(f.runtime, 'package.json'),
        bundleDependencies: [],
      }),
  ],
  [
    'changed runtime version',
    (f: ReturnType<typeof fixture>) =>
      json(f.runtime, 'package.json', { ...read(f.runtime, 'package.json'), version: '2026.10.6' }),
  ],
] as const)('rejects %s before replacing the installed tree', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow();
  expect(snapshot(f.runtime)).toEqual(before);
});

test.each([
  { inBundle: false },
  { version: '1.10.2' },
  { integrity: 'unverified' },
  { resolved: 'file:///outside/package.tgz' },
  { resolved: 'https://user:password@registry.invalid/pkg.tgz' },
])('rejects unauthenticated installed origin %j without writing', fields => {
  const f = fixture();
  const lock = read(f.runtime, 'package-lock.json');
  Object.assign(lock.packages['node_modules/chrome-devtools-mcp'], fields);
  json(f.runtime, 'package-lock.json', lock);
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow();
  expect(snapshot(f.runtime)).toEqual(before);
});

test.each(['pristine', 'runtime'] as const)(
  'rejects a directory junction in %s without touching its external owner',
  owner => {
    const f = fixture();
    const external = path.join(f.root, 'external');
    put(external, 'sentinel', 'must remain unchanged');
    fs.symlinkSync(
      external,
      path.join(f[owner], 'node_modules/chrome-devtools-mcp/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = snapshot(f.runtime);
    const externalBefore = snapshot(external);
    expect(() => f.restore()).toThrow(/Links|without links/);
    expect(snapshot(f.runtime)).toEqual(before);
    expect(snapshot(external)).toEqual(externalBefore);
  },
);

test('rejects a node_modules owner junction before traversing or replacing another tree', () => {
  const f = fixture();
  const external = path.join(f.root, 'external-modules');
  fs.renameSync(path.join(f.runtime, 'node_modules'), external);
  fs.symlinkSync(
    external,
    path.join(f.runtime, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const before = snapshot(f.runtime);
  const externalBefore = snapshot(external);
  expect(() => f.restore()).toThrow(/without links/);
  expect(snapshot(f.runtime)).toEqual(before);
  expect(snapshot(external)).toEqual(externalBefore);
});

test('rejects hard-linked original bytes before writing', () => {
  const f = fixture();
  const original = path.join(f.pristine, 'node_modules/chrome-devtools-mcp/LICENSE');
  fs.linkSync(original, path.join(f.root, 'borrowed-license'));
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow(/without links/);
  expect(snapshot(f.runtime)).toEqual(before);
});

test('refuses a dangling higher-priority lock without falling back to another lock or writing', () => {
  const f = fixture();
  const missingOwner = path.join(f.root, 'removed-lock-owner');
  fs.mkdirSync(missingOwner);
  fs.symlinkSync(
    missingOwner,
    path.join(f.runtime, 'npm-shrinkwrap.json'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.rmdirSync(missingOwner);
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow(/regular file/);
  expect(snapshot(f.runtime)).toEqual(before);
});

test.each(['node_modules', 'node_modules/chrome-devtools-mcp/build'])(
  'read-only verification rejects a junction below the trusted root at %s',
  relative => {
    const f = fixture();
    f.restore();
    const external = path.join(f.root, 'borrowed-tree');
    fs.renameSync(path.join(f.runtime, relative), external);
    fs.symlinkSync(
      external,
      path.join(f.runtime, relative),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = snapshot(f.runtime);
    const externalBefore = snapshot(external);
    expect(() => verifyBundledDependencies(f.runtime, { sourceLock })).toThrow(
      /Links|without links/,
    );
    expect(snapshot(f.runtime)).toEqual(before);
    expect(snapshot(external)).toEqual(externalBefore);
  },
);

test('rolls back every complete replacement if installing the final proof fails', () => {
  const f = fixture(['chrome-devtools-mcp', '@owner/nested']);
  const before = snapshot(f.runtime);
  const sourceBefore = snapshot(f.pristine);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (target === path.join(f.runtime, RUNTIME_BUNDLED_DEPENDENCIES_FILENAME))
      throw new Error('simulated proof rename failure');
    rename(source, target);
  });
  expect(() => f.restore()).toThrow(/simulated proof rename/);
  expect(snapshot(f.runtime)).toEqual(before);
  expect(snapshot(f.pristine)).toEqual(sourceBefore);
});

test.each(['runtime-build-info.json', 'runtime-patch-manifest.json', '.initial-bundle-pending'])(
  'refuses existing application build marker %s without updating a frozen artifact',
  marker => {
    const f = fixture();
    put(f.runtime, marker, 'existing application artifact');
    const before = snapshot(f.runtime);
    expect(() => f.restore()).toThrow(/fresh staging/);
    expect(snapshot(f.runtime)).toEqual(before);
  },
);

test('rejects source changes during copying before replacing any installed package', () => {
  const f = fixture();
  const before = snapshot(f.runtime);
  const copy = fs.cpSync;
  vi.spyOn(fs, 'cpSync').mockImplementation((source, target, options) => {
    copy(source, target, options);
    put(
      f.pristine,
      'node_modules/chrome-devtools-mcp/build/src/TextSnapshot.js',
      'stock bytes injected during copy',
    );
  });
  expect(() => f.restore()).toThrow(/changed during preparation/);
  expect(snapshot(f.runtime)).toEqual(before);
  expect(
    fs.readFileSync(
      path.join(f.pristine, 'node_modules/chrome-devtools-mcp/build/src/TextSnapshot.js'),
      'utf8',
    ),
  ).toBe('stock bytes injected during copy');
});

test('rejects changed copied bytes before replacing any installed package', () => {
  const f = fixture();
  const before = snapshot(f.runtime);
  const sourceBefore = snapshot(f.pristine);
  const copy = fs.cpSync;
  vi.spyOn(fs, 'cpSync').mockImplementation((source, target, options) => {
    copy(source, target, options);
    put(String(target), 'build/src/TextSnapshot.js', 'copy did not preserve upstream bytes');
  });
  expect(() => f.restore()).toThrow(/Copied bundled dependency bytes changed/);
  expect(snapshot(f.runtime)).toEqual(before);
  expect(snapshot(f.pristine)).toEqual(sourceBefore);
});

test('rejects an origin change during copying without replacing packages or undoing the external change', () => {
  const f = fixture();
  const targetBefore = snapshot(path.join(f.runtime, 'node_modules'));
  const sourceBefore = snapshot(f.pristine);
  const copy = fs.cpSync;
  const lock = read(f.runtime, 'package-lock.json');
  lock.packages['node_modules/chrome-devtools-mcp'].integrity =
    `sha512-${Buffer.alloc(64, 9).toString('base64')}`;
  vi.spyOn(fs, 'cpSync').mockImplementation((source, target, options) => {
    copy(source, target, options);
    json(f.runtime, 'package-lock.json', lock);
  });
  expect(() => f.restore()).toThrow(/changed during preparation/);
  expect(snapshot(path.join(f.runtime, 'node_modules'))).toEqual(targetBefore);
  expect(snapshot(f.pristine)).toEqual(sourceBefore);
  expect(read(f.runtime, 'package-lock.json')).toEqual(lock);
  expect(fs.readdirSync(f.runtime).sort()).toEqual([
    'node_modules',
    'package-lock.json',
    'package.json',
  ]);
});

test('restores prior trees when a later package rename fails after the first complete replacement', () => {
  const f = fixture(['chrome-devtools-mcp', '@owner/nested']);
  const before = snapshot(f.runtime);
  const sourceBefore = snapshot(f.pristine);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (
      String(source).includes('copy-') &&
      target === path.join(f.runtime, 'node_modules/chrome-devtools-mcp')
    ) {
      throw new Error('simulated second package rename failure');
    }
    rename(source, target);
  });
  expect(() => f.restore()).toThrow(/second package rename failure/);
  expect(snapshot(f.runtime)).toEqual(before);
  expect(snapshot(f.pristine)).toEqual(sourceBefore);
});

test.each(['changed', 'missing', 'unexpected', 'manifest', 'origin'] as const)(
  'rejects %s final evidence without repairing or changing it',
  kind => {
    const f = fixture();
    f.restore();
    const original = 'node_modules/chrome-devtools-mcp/build/src/TextSnapshot.js';
    if (kind === 'changed') put(f.runtime, original, 'changed');
    if (kind === 'missing') fs.unlinkSync(path.join(f.runtime, original));
    if (kind === 'unexpected')
      put(f.runtime, 'node_modules/chrome-devtools-mcp/unexpected.js', 'unexpected');
    if (kind === 'manifest') {
      const manifest = read(f.runtime, RUNTIME_BUNDLED_DEPENDENCIES_FILENAME);
      manifest.source.tarballSha256 = 'b'.repeat(64);
      json(f.runtime, RUNTIME_BUNDLED_DEPENDENCIES_FILENAME, manifest);
    }
    if (kind === 'origin') {
      const lock = read(f.runtime, 'package-lock.json');
      lock.packages['node_modules/chrome-devtools-mcp'].integrity =
        `sha512-${Buffer.alloc(64, 9).toString('base64')}`;
      json(f.runtime, 'package-lock.json', lock);
    }
    const before = snapshot(f.runtime);
    expect(() => verifyBundledDependencies(f.runtime, { sourceLock })).toThrow();
    expect(snapshot(f.runtime)).toEqual(before);
  },
);

test('refuses to use a restored runtime as an in-place update or source owner', () => {
  const f = fixture();
  f.restore();
  const before = snapshot(f.runtime);
  expect(() => f.restore()).toThrow(/fresh staging/);
  expect(() =>
    restorePristineBundledDependencies(f.runtime, f.runtime, {
      sourceLock,
      pristineProof: f.proof,
    }),
  ).toThrow(/disjoint/);
  expect(snapshot(f.runtime)).toEqual(before);
});

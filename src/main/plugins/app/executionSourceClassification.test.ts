import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { type AppCandidate, AppPluginManager, discoverAppCandidates } from './manager';
import type { AppHostResources } from './registry';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture(initial: AppCandidate[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'execution-source-classification-'));
  const database = new Database(':memory:');
  let candidates = initial;
  let fail = false;
  const manager = new AppPluginManager({
    retentionRoot: path.join(root, 'artifacts'),
    candidates: async () => {
      if (fail) throw new Error('Unavailable inventory');
      return candidates;
    },
    resources: { getDatabase: () => database } as AppHostResources,
    readDesiredEnabled: () => false,
    broadcast: () => {},
    isGatewayConnected: () => false,
    withStoppedGateway: operation => operation(),
  });
  disposers.push(async () => {
    manager.dispose();
    database.close();
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^execution-source-classification-/);
    await rm(root, { recursive: true, force: true });
  });
  return {
    manager,
    database,
    root,
    fail: () => {
      fail = true;
    },
    candidates: (value: AppCandidate[]) => {
      candidates = value;
    },
  };
}

test('admits Native-only provenance only after complete discovery, database and activation', async () => {
  const f = await fixture();
  const notify = vi.fn();
  const release = f.manager.onExecutionSessionsChanged(notify);
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
  await f.manager.prepare();
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
  f.manager.initializeDatabase(f.database);
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
  await f.manager.activate();
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(true);
  expect(notify).toHaveBeenCalled();
  release();
  f.manager.dispose();
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
});

test('announces Native-only inventory admission changes even when there are no App snapshots', async () => {
  const f = await fixture();
  await f.manager.prepare();
  f.manager.initializeDatabase(f.database);
  await f.manager.activate();
  expect(f.manager.snapshot()).toEqual([]);
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(true);
  const changed = vi.fn();
  const release = f.manager.onExecutionSessionsChanged(changed);
  try {
    f.manager.registry.setPackageAdmissionBlocked(true);
    expect(f.manager.snapshot()).toEqual([]);
    expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith(false);
    changed.mockClear();
    f.manager.registry.refresh();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

test.each(['failed-discovery', 'unresolved-candidate'] as const)(
  'keeps %s fail closed',
  async reason => {
    const f = await fixture();
    if (reason === 'failed-discovery') f.fail();
    else
      f.candidates([
        {
          root: path.join(f.root, 'missing'),
          nativeRoot: f.root,
          trusted: false,
          nativePluginId: 'known-app',
          inventoryUnresolved: true,
        },
      ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await f.manager.prepare();
      f.manager.initializeDatabase(f.database);
      await f.manager.activate();
      expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
      expect(f.manager.isNativeOnlyExecutionSource('known-app')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  },
);

test('retains a discovered App identity across its removal and fences classification during replacement', async () => {
  const f = await fixture();
  f.candidates([
    {
      root: path.join(f.root, 'not-admitted'),
      nativeRoot: f.root,
      trusted: false,
      nativePluginId: 'retired-app',
    },
  ]);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await f.manager.prepare();
    f.manager.initializeDatabase(f.database);
    await f.manager.activate();
    expect(f.manager.isNativeOnlyExecutionSource('retired-app')).toBe(false);
    expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(true);
    await f.manager.mutatePackage(async () => {
      expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
      f.candidates([]);
    });
    expect(f.manager.isNativeOnlyExecutionSource('retired-app')).toBe(false);
    expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test('rejects a malformed catalog instead of forgetting its declared App owner', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.root, 'catalog.json'),
    JSON.stringify([{ id: 'declared-app', hash: 'corrupt' }]),
  );
  await expect(discoverAppCandidates(f.root, null, [], {})).rejects.toThrow(
    'Invalid app plugin catalog',
  );
});

test.each(['missing-path', 'unreadable-package', 'invalid-package', 'source-manifest'] as const)(
  'retains unresolved App provenance for %s metadata',
  async kind => {
    const f = await fixture();
    const installed = path.join(f.root, 'installed');
    await mkdir(installed);
    await writeFile(path.join(f.root, 'catalog.json'), '[]');
    if (kind === 'source-manifest') {
      await writeFile(path.join(installed, 'app.plugin.json'), '{}');
      await writeFile(path.join(installed, 'package.json'), '{"type":"module"}');
    }
    if (kind === 'invalid-package')
      await writeFile(path.join(installed, 'package.json'), '[]');
    const candidates = await discoverAppCandidates(
      f.root,
      null,
      [
        {
          id: 'installed-producer',
          ...(kind !== 'missing-path' ? { installPath: installed } : {}),
        },
      ],
      {},
    );
    expect(candidates).toEqual([
      expect.objectContaining({ nativePluginId: 'installed-producer', inventoryUnresolved: true }),
    ]);
    f.candidates(candidates);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await f.manager.prepare();
      f.manager.initializeDatabase(f.database);
      await f.manager.activate();
      expect(f.manager.isNativeOnlyExecutionSource('installed-producer')).toBe(false);
      expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  },
);

test('retains a proven Native-only package in owner inventory without claiming App provenance', async () => {
  const f = await fixture();
  const installed = path.join(f.root, 'installed');
  await mkdir(installed);
  await writeFile(path.join(installed, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(f.root, 'catalog.json'), '[]');
  const candidates = await discoverAppCandidates(
    f.root,
    null,
    [{ id: 'native-worker', installPath: installed }],
    {},
  );
  expect(candidates).toEqual([
    expect.objectContaining({ nativePluginId: 'native-worker', nativeOnly: true }),
  ]);
  f.candidates(candidates);

  await f.manager.prepare();
  f.manager.initializeDatabase(f.database);
  await f.manager.activate();

  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(true);
  expect(f.manager.snapshot()).toEqual([]);
});

test('cannot downgrade an App tombstone when its replacement package declares Native-only', async () => {
  const f = await fixture();
  f.candidates([
    { root: f.root, nativeRoot: f.root, trusted: false, nativePluginId: 'retired-app' },
  ]);
  await f.manager.prepare();
  f.manager.initializeDatabase(f.database);
  await f.manager.activate();

  await f.manager.mutatePackage(async () => {
    f.candidates([
      {
        root: f.root,
        nativeRoot: f.root,
        trusted: false,
        nativePluginId: 'retired-app',
        nativeOnly: true,
      },
    ]);
  });

  expect(f.manager.isNativeOnlyExecutionSource('retired-app')).toBe(false);
  expect(f.manager.isNativeOnlyExecutionSource('native-worker')).toBe(true);
});

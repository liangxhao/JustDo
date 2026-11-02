import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { t } from '../../core/i18n';
import { AppApprovalStore } from './approvalStore';
import { artifactDigest, inspectAppArtifact } from './artifact';
import { AppPluginManager, discoverAppCandidates } from './manager';
import type { AppHostResources } from './registry';

const id = 'installed-fixture';
const native = 'export default {};';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const disposers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

async function fixture(options: {
  trustAvailable?: boolean;
  nativePluginId?: string;
  gatewayRunning?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'app-installed-test-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const bundled = path.join(root, 'bundled');
  const installPath = path.join(root, 'installed');
  const retentionRoot = path.join(root, 'retained');
  const store = new AppApprovalStore(path.join(root, 'approvals.json'));
  const installed: { id: string; installPath: string }[] = [];
  await mkdir(bundled);
  await writeFile(path.join(bundled, 'catalog.json'), '[]');
  await mkdir(installPath);
  await writeFile(path.join(installPath, 'index.js'), native);
  let beforeCandidates: (() => void | Promise<void>) | undefined;
  let connected = options.gatewayRunning !== false;
  let processId: number | null = connected ? 100 : null;
  let generation = 1;
  const stopped = vi.fn(async <T>(operation: () => Promise<T>) => {
    connected = false;
    processId = null;
    return operation();
  });
  const ensureReady = vi.fn(async () => {
    connected = true;
    processId = 101;
    generation++;
  });
  const approveArtifact = vi.fn((pluginId: string, hash: string) => store.approve(pluginId, hash));
  const manager = new AppPluginManager({
    retentionRoot,
    resources: { ensureReady } as unknown as AppHostResources,
    readDesiredEnabled: () => false,
    candidates: async () => {
      await beforeCandidates?.();
      return discoverAppCandidates(bundled, null, installed, await store.read());
    },
    ...(options.trustAvailable === false ? {} : { approveArtifact }),
    broadcast: () => {},
    isGatewayConnected: () => connected,
    getGatewayProcessId: () => processId,
    getGatewayProcessGeneration: () => generation,
    withStoppedGateway: stopped,
    loadModule: async () => ({ register: () => ({ commands: [] }) }),
  });
  disposers.push(() => manager.dispose());
  await manager.prepare();
  await manager.activate();
  const writeApp = async (nativeRoot = installPath, manifestId = id, version = '1.0.0'): Promise<string> => {
    const appRoot = path.join(nativeRoot, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(nativeRoot, 'index.js'), native);
    const manifest: AppPluginManifest = {
      manifestVersion: 1, apiVersion: 1, id: manifestId, nativePluginId: manifestId, version,
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      commands: [], slots: [], capabilities: [],
    };
    const contents = {
      'main.mjs': 'export const register = () => ({ commands: [] });',
      'browser.mjs': 'export const register = () => {};',
      'native.binding.json': JSON.stringify({
        entry: 'index.js', profile: 'single-file-v1', sha256: sha(native),
      }),
    };
    const files = Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, sha(value)]));
    const hash = artifactDigest(manifest, files);
    for (const [name, value] of Object.entries(contents)) await writeFile(path.join(appRoot, name), value);
    await writeFile(path.join(appRoot, 'app.artifact.json'), JSON.stringify({ manifest, files, hash }));
    return hash;
  };
  return {
    manager, installPath, retentionRoot, store, stopped, ensureReady, approveArtifact, writeApp,
    recordInstalled: () => { installed.push({ id: options.nativePluginId ?? id, installPath }); },
    removeInstalled: () => { installed.splice(0); },
    beforeCandidates: (callback: () => void | Promise<void>) => { beforeCandidates = callback; },
    startUnexpectedGateway: () => { processId = 200; generation++; },
  };
}

test('approves the confirmed installed companion in one cold cycle without a separate review', async () => {
  const f = await fixture();
  const hash = await f.writeApp();
  const review = vi.spyOn(f.manager, 'review');
  const approve = vi.spyOn(f.manager, 'approve');

  await f.manager.mutatePackage(async () => {
    f.recordInstalled();
    await f.manager.approveInstalledPackage({ nativePluginId: id, installPath: f.installPath });
  });

  expect(f.stopped).toHaveBeenCalledOnce();
  expect(f.ensureReady).toHaveBeenCalledOnce();
  expect(f.approveArtifact).toHaveBeenCalledExactlyOnceWith(id, hash);
  expect(await f.store.read()).toEqual({ [id]: hash });
  expect((await inspectAppArtifact(path.join(f.retentionRoot, id, hash))).artifact.hash).toBe(hash);
  expect(review).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(await f.manager.review(id)).toMatchObject({ hash, approved: true });
  expect(f.manager.snapshot()[0]).toMatchObject({ id, hash, installed: true });
  expect(f.manager.snapshot()[0].state).not.toBe('active');
});

test('rejects installation trust outside its stopped mutation owner', async () => {
  const f = await fixture();
  await f.writeApp();
  f.recordInstalled();

  await expect(f.manager.approveInstalledPackage({ nativePluginId: id, installPath: f.installPath }))
    .rejects.toThrow(t('extensionInstallMutationUnavailable'));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(f.stopped).not.toHaveBeenCalled();
});

test('rejects a different package root even when its companion has the same identity', async () => {
  const f = await fixture();
  await f.writeApp();
  const otherPath = path.join(path.dirname(f.installPath), 'unselected');
  await f.writeApp(otherPath);
  f.recordInstalled();

  await expect(f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: otherPath,
  }))).rejects.toThrow(t('extensionAppCodeIdentityMismatch'));

  expect(f.approveArtifact).not.toHaveBeenCalled();
});

test.each(['identity', 'native binding', 'artifact hash', 'malformed artifact'] as const)(
  'rejects an installed companion with an invalid %s',
  async failure => {
    const f = await fixture();
    await f.writeApp(f.installPath, failure === 'identity' ? 'other-fixture' : id);
    if (failure === 'native binding') await writeFile(path.join(f.installPath, 'index.js'), `${native}\n// changed`);
    if (failure === 'artifact hash') await writeFile(path.join(f.installPath, 'app', 'browser.mjs'), 'export {};');
    if (failure === 'malformed artifact') await writeFile(path.join(f.installPath, 'app', 'app.artifact.json'), '{');
    f.recordInstalled();

    await expect(f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
      nativePluginId: id, installPath: f.installPath,
    }))).rejects.toThrow();

    expect(f.approveArtifact).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual({});
  },
);

test('does not create App trust for a native-only installation with its original case-sensitive ID', async () => {
  const nativePluginId = 'ExampleGenerator';
  const f = await fixture({ trustAvailable: false, nativePluginId });
  f.recordInstalled();

  await f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId, installPath: f.installPath,
  }));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(await f.store.read()).toEqual({});
  expect(f.manager.snapshot()).toEqual([]);
});

test('preserves the native-only package owner when its confirmed receipt names a child entry', async () => {
  const f = await fixture({ nativePluginId: 'package-plugin' });
  f.recordInstalled();

  await f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: 'package-plugin/alpha', installPath: f.installPath,
  }));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(await f.store.read()).toEqual({});
});

test.each(['directory', 'file'] as const)('does not classify a native-only app resource %s as a companion', async kind => {
  const f = await fixture({ trustAvailable: false });
  const appPath = path.join(f.installPath, 'app');
  if (kind === 'directory') {
    await mkdir(appPath);
    await writeFile(path.join(appPath, 'index.html'), '<p>Native extension resource</p>');
  } else await writeFile(appPath, 'Native extension resource');
  f.recordInstalled();

  await f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: f.installPath,
  }));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(await f.store.read()).toEqual({});
  expect(f.manager.snapshot()).toEqual([]);
});

test.skipIf(process.platform !== 'win32')('preserves native-only Windows path comparison without applying App canonical restrictions', async () => {
  const f = await fixture();
  f.recordInstalled();

  await f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: f.installPath.toUpperCase(),
  }));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(f.manager.snapshot()).toEqual([]);
});

test('reports unavailable trust persistence for an actual companion', async () => {
  const f = await fixture({ trustAvailable: false });
  await f.writeApp();
  f.recordInstalled();

  await expect(f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: f.installPath,
  }))).rejects.toThrow(t('extensionAppCodeTrustUnavailable'));

  expect(await f.store.read()).toEqual({});
});

test('rechecks installed ownership after retaining the companion and before approving it', async () => {
  const f = await fixture();
  await f.writeApp();
  f.recordInstalled();
  let reads = 0;
  f.beforeCandidates(() => { if (++reads === 2) f.removeInstalled(); });

  await expect(f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: f.installPath,
  }))).rejects.toThrow(t('extensionAppCodeIdentityMismatch'));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(await f.store.read()).toEqual({});
});

test('does not approve a different valid revision that appears after immutable retention', async () => {
  const f = await fixture();
  await f.writeApp();
  f.recordInstalled();
  let reads = 0;
  f.beforeCandidates(async () => {
    if (++reads === 2) await f.writeApp(f.installPath, id, '2.0.0');
  });

  await expect(f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: f.installPath,
  }))).rejects.toThrow(t('extensionAppCodeIdentityMismatch'));

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(await f.store.read()).toEqual({});
});

test('rejects an unexpected Gateway incarnation during an awaited inventory read', async () => {
  const f = await fixture();
  await f.writeApp();
  f.recordInstalled();
  let reads = 0;
  f.beforeCandidates(() => { if (++reads === 1) f.startUnexpectedGateway(); });

  await expect(f.manager.mutatePackage(() => f.manager.approveInstalledPackage({
    nativePluginId: id, installPath: f.installPath,
  }))).rejects.toThrow(t('extensionInstallMutationUnavailable'));

  expect(f.approveArtifact).not.toHaveBeenCalled();
});

test('does not let an unfinished approval borrow a later stopped mutation owner', async () => {
  const f = await fixture({ gatewayRunning: false });
  await f.writeApp();
  f.recordInstalled();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  f.beforeCandidates(async () => {
    if (++reads === 1) { entered(); await waiting; }
  });
  let pending: Promise<void> | undefined;
  try {
    await f.manager.mutatePackage(async () => {
      pending = f.manager.approveInstalledPackage({ nativePluginId: id, installPath: f.installPath });
      await started;
    });
    await f.manager.mutatePackage(async () => {
      finish();
      await expect(pending).rejects.toThrow(t('extensionInstallMutationUnavailable'));
    });
  } finally {
    finish();
    await pending?.catch(() => undefined);
  }

  expect(f.approveArtifact).not.toHaveBeenCalled();
  expect(f.ensureReady).not.toHaveBeenCalled();
});

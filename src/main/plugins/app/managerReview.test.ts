import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import type { AppPluginManifest } from '../../../../packages/app-plugin-sdk/contracts';
import { AppApprovalStore } from './approvalStore';
import { artifactDigest, inspectAppArtifact, retainAppArtifact } from './artifact';
import { AppPluginManager, discoverAppCandidates } from './manager';
import type { AppHostResources } from './registry';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const id = 'review-fixture';
const native = 'export default {};';
async function artifact(root: string, version: string): Promise<string> {
  const manifest: AppPluginManifest = {
    manifestVersion: 1,
    apiVersion: 1,
    id,
    nativePluginId: id,
    version,
    entries: { main: 'main.mjs', browser: 'browser.mjs' },
    commands: [],
    slots: [],
    capabilities: [],
  };
  const contents = {
    'main.mjs': 'export const register = () => ({});',
    'browser.mjs': 'export const register = () => {};',
    'native.binding.json': JSON.stringify({
      entry: 'index.js',
      profile: 'single-file-v1',
      sha256: sha(native),
    }),
  };
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, value]) => [name, sha(value)]),
  );
  const hash = artifactDigest(manifest, files);
  await mkdir(root, { recursive: true });
  for (const [name, value] of Object.entries(contents))
    await writeFile(path.join(root, name), value);
  await writeFile(path.join(root, 'app.artifact.json'), JSON.stringify({ manifest, files, hash }));
  return hash;
}

test('reviews and approves the installed revision while historical receipts remain cleanup-only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-review-test-'));
  const retentionRoot = path.join(root, 'retained');
  const store = new AppApprovalStore(path.join(root, 'trust.json'));
  const installed: { id: string; installPath: string }[] = [];
  const bundled = path.join(root, 'bundled');
  const manager = new AppPluginManager({
    retentionRoot,
    resources: {} as AppHostResources,
    readDesiredEnabled: () => false,
    candidates: async () =>
      discoverAppCandidates(
        bundled,
        null,
        installed,
        await store.read(),
        retentionRoot,
        await store.history(),
      ),
    approveArtifact: (pluginId, hash) => store.approve(pluginId, hash),
    broadcast: () => {},
    isGatewayConnected: () => false,
    withStoppedGateway: operation => operation(),
    loadModule: async () => ({ register: () => ({ commands: [] }) }),
  });
  try {
    await mkdir(bundled);
    await writeFile(path.join(bundled, 'catalog.json'), '[]');
    const old = path.join(root, 'old');
    const oldHash = await artifact(old, '1.0.0');
    await retainAppArtifact(await inspectAppArtifact(old), retentionRoot);
    await store.approve(id, oldHash);

    const installPath = path.join(root, 'installed');
    const currentHash = await artifact(path.join(installPath, 'app'), '2.0.0');
    await writeFile(path.join(installPath, 'index.js'), native);
    installed.push({ id, installPath });
    const review = await manager.review(id);
    expect(review).toMatchObject({ hash: currentHash, version: '2.0.0', approved: false });
    expect(await manager.approve({ id, hash: review!.hash, token: review!.token })).toEqual({
      success: true,
    });
    expect((await store.history())[id]).toEqual([oldHash, currentHash]);
    expect(await manager.review(id)).toMatchObject({ hash: currentHash, approved: true });

    installed.splice(0);
    expect(await manager.review(id)).toBeNull();
  } finally {
    manager.dispose();
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^app-review-test-/u);
    await rm(root, { recursive: true, force: true });
  }
});

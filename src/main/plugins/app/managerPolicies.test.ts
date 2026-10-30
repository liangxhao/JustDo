import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { artifactDigest } from './artifact';
import { AppPluginManager } from './manager';
import type { AppHostResources } from './registry';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
test('reads trusted bundled defaults before failing Main admission and ignores external default requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-policy-test-'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const artifactRoot = path.join(root, 'app');
    await mkdir(artifactRoot);
    const manifest: AppPluginManifest = {
      manifestVersion: 1,
      apiVersion: 1,
      id: 'example-policy',
      nativePluginId: 'example-policy',
      version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      commands: [],
      slots: [],
      capabilities: [],
      native: { defaultEnabled: false, userToggleable: true },
    };
    const native = 'export default {};';
    await writeFile(path.join(root, 'index.js'), native);
    const content = {
      'main.mjs': 'export const register = () => { throw new Error("rejected"); };',
      'browser.mjs': 'export const register = () => {};',
      'native.binding.json': JSON.stringify({
        entry: 'index.js',
        sha256: sha(native),
        profile: 'single-file-v1',
      }),
    };
    const files = Object.fromEntries(
      Object.entries(content).map(([name, value]) => [name, sha(value)]),
    );
    for (const [name, value] of Object.entries(content))
      await writeFile(path.join(artifactRoot, name), value);
    await writeFile(
      path.join(artifactRoot, 'app.artifact.json'),
      JSON.stringify({ manifest, files, hash: artifactDigest(manifest, files) }),
    );
    for (const bundled of [false, true]) {
      const manager = new AppPluginManager({
        retentionRoot: path.join(root, 'retained'),
        resources: {} as AppHostResources,
        readDesiredEnabled: () => false,
        candidates: async () => [{ root: artifactRoot, nativeRoot: root, trusted: true, bundled }],
        broadcast: () => {},
        isGatewayConnected: () => false,
      });
      await manager.prepare();
      expect(manager.snapshot()).toEqual([]);
      expect(manager.getBundledNativePolicies()).toEqual(
        bundled ? { 'example-policy': manifest.native } : {},
      );
      manager.dispose();
      expect(manager.getBundledNativePolicies()).toEqual({});
    }
  } finally {
    warn.mockRestore();
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^app-policy-test-/);
    await rm(root, { recursive: true, force: true });
  }
});

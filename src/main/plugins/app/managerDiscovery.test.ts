import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { artifactDigest } from './artifact';
import { AppPluginManager, discoverAppCandidates } from './manager';
import type { AppHostResources } from './registry';

const id = 'discovery-fixture';
const native = 'export default {};';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test.each(['directory', 'runtime-link', 'plugin-link', 'different-bytes', 'missing-native', 'missing-app', 'unavailable-runtime', 'shadowed'] as const)(
  'admits the runtime alias while preserving native package checks: %s',
  async layout => {
    const root = await mkdtemp(path.join(tmpdir(), 'app-discovery-layout-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let manager: AppPluginManager | undefined;
    try {
      const runtime = path.join(root, '原生 runtime');
      const nativeRoot = path.join(runtime, 'dist/extensions', id);
      const bundled = path.join(root, 'bundled');
      await mkdir(nativeRoot, { recursive: true });
      await writeFile(path.join(nativeRoot, 'index.js'), native);
      const manifest: AppPluginManifest = {
        manifestVersion: 1,
        apiVersion: 1,
        id,
        nativePluginId: id,
        version: '1.0.0',
        entries: { main: 'main.mjs', browser: 'browser.mjs' },
        capabilities: [],
        slots: ['plugin.settings', 'plugin.history'],
        commands: [],
      };
      const contents = {
        'main.mjs': 'export const register = () => ({commands:[]});',
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
      const artifactRoot = path.join(bundled, id, hash);
      await mkdir(artifactRoot, { recursive: true });
      for (const [name, value] of Object.entries(contents))
        await writeFile(path.join(artifactRoot, name), value);
      await writeFile(
        path.join(artifactRoot, 'app.artifact.json'),
        JSON.stringify({ manifest, files, hash }),
      );
      await writeFile(path.join(bundled, 'catalog.json'), JSON.stringify([{ id, hash }]));
      const selectedRuntime = path.join(root, 'current');
      await symlink(runtime, selectedRuntime, process.platform === 'win32' ? 'junction' : 'dir');
      if (layout === 'plugin-link') {
        const linked = path.join(root, 'linked-plugin');
        await rename(nativeRoot, linked);
        await symlink(linked, nativeRoot, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (layout === 'different-bytes')
        await writeFile(path.join(nativeRoot, 'index.js'), native + '// changed');
      const receipt = {
        pluginId: id,
        registrationId: randomUUID(),
        processId: 100,
        gatewayMethods: [],
        nativeEntry: realpathSync(path.join(nativeRoot, 'index.js')),
        sourceSha256: sha(native),
      };
      if (layout === 'missing-native') await rm(path.join(nativeRoot, 'index.js'));
      if (layout === 'missing-app') await rm(artifactRoot, { recursive: true });
      const candidates = await discoverAppCandidates(
        bundled,
        layout === 'unavailable-runtime' ? null : layout === 'directory' ? runtime : selectedRuntime,
        layout === 'shadowed' ? [{ id, installPath: path.join(root, 'installed') }] : [],
        {},
      );
      const loadModule = vi.fn(async () => ({ register: () => ({ commands: [] }) }));
      manager = new AppPluginManager({
        retentionRoot: path.join(root, 'retained'),
        candidates: async () => candidates,
        resources: { requestConnectedGateway: async () => receipt } as unknown as AppHostResources,
        readDesiredEnabled: () => true,
        isGatewayConnected: () => true,
        getGatewayProcessId: () => 100,
        broadcast: () => {},
        loadModule,
      });
      await manager.prepare();
      await manager.activate();
      await manager.refresh();
      if (layout === 'missing-app') {
        expect(manager.snapshot()).toEqual([]);
        expect(loadModule).not.toHaveBeenCalled();
        expect(manager.registry.hasUnresolvedInventory()).toBe(true);
        expect(() => manager!.registry.assertResourceOwners(['unrelated'])).not.toThrow();
        await expect(manager.registry.preparePackageMutation()).resolves.toBeUndefined();
        expect(manager.isAppCompanion(id)).toBe(false);
      } else if (['plugin-link', 'different-bytes', 'missing-native', 'unavailable-runtime'].includes(layout)) {
        expect(manager.snapshot()).toEqual([expect.objectContaining({ id, state: 'cleanup' })]);
        expect(loadModule).toHaveBeenCalledOnce();
        expect(manager.registry.hasUnresolvedInventory()).toBe(false);
        expect(manager.snapshot()[0].browserEntry).toBeUndefined();
        expect(manager.isAppCompanion(id)).toBe(false);
      } else if (layout === 'shadowed') {
        expect(manager.snapshot()).toEqual([expect.objectContaining({ id, state: 'cleanup' })]);
        expect(manager.isAppCompanion(id)).toBe(false);
      } else {
        expect(manager.snapshot()).toEqual([
          expect.objectContaining({
            id,
            hash,
            state: 'active',
            slots: ['plugin.settings', 'plugin.history'],
            browserEntry: expect.stringContaining(`/assets/app-plugins/${hash}/`),
          }),
        ]);
        expect(candidates[0].nativeRoot).toBe(
          path.join(realpathSync(runtime), 'dist/extensions', id),
        );
        expect(loadModule).toHaveBeenCalledOnce();
        expect(manager.registry.hasUnresolvedInventory()).toBe(false);
        expect(manager.isAppCompanion(id)).toBe(true);
      }
    } finally {
      manager?.dispose();
      warn.mockRestore();
      expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
      expect(path.basename(root)).toMatch(/^app-discovery-layout-/u);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  {},
  [{ id: 'owner-fixture', hash: 'not-a-hash' }],
  [{ id: 'owner-fixture', hash: 'a'.repeat(64) }, { id: 'owner-fixture', hash: 'b'.repeat(64) }],
])('rejects an incomplete catalog instead of interpreting its skipped entries as removals: %j', async catalog => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-discovery-catalog-'));
  try {
    await writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog));
    await expect(discoverAppCandidates(root, null, [], {})).rejects.toThrow('Invalid app plugin catalog');
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^app-discovery-catalog-/u);
    await rm(root, { recursive: true, force: true });
  }
});

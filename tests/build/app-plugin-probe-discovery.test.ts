import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { discoverAppPluginSources } from '../../scripts/test/plugin-host/source-discovery.mjs';

test('discovers optional probe manifests without requiring known business plugins or hiding declared package errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-probe-discovery-'));
  vi.stubEnv('APP_PLUGIN_PROBE_IDS', '');
  try {
    await expect(discoverAppPluginSources(path.join(root, 'absent'))).rejects.toThrow();
    expect(await discoverAppPluginSources(root)).toEqual([]);
    const directory = path.join(root, 'custom-capability');
    await mkdir(directory);
    const manifest = {
      manifestVersion: 1, apiVersion: 1, id: 'custom-capability', nativePluginId: 'custom-capability',
      version: '1.0.0', entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [], slots: [], commands: [],
    };
    await writeFile(path.join(directory, 'app.plugin.json'), JSON.stringify(manifest));
    expect(await discoverAppPluginSources(root)).toEqual([{ id: manifest.id, directory, manifest }]);
    vi.stubEnv('APP_PLUGIN_PROBE_IDS', 'missing-capability');
    await expect(discoverAppPluginSources(root)).rejects.toThrow('explicitly selected');
    vi.stubEnv('APP_PLUGIN_PROBE_IDS', '');
    await writeFile(path.join(directory, 'app.plugin.json'), '{broken');
    await expect(discoverAppPluginSources(root)).rejects.toThrow();
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      app: { main: 'main.ts', browser: 'browser.tsx' },
    }));
    await rm(path.join(directory, 'app.plugin.json'));
    await expect(discoverAppPluginSources(root)).rejects.toThrow('Declared app plugin manifest is missing');
  } finally {
    vi.unstubAllEnvs();
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^app-probe-discovery-/u);
    await rm(root, { recursive: true, force: true });
  }
});

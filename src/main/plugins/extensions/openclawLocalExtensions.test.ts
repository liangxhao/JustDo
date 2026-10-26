import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({
  isPackaged: true,
  getAppPath: vi.fn(),
}));

vi.mock('electron', () => ({
  app: electronApp,
}));

import {
  hasBundledOpenClawExtension,
  inspectLocalOpenClawExtensions,
  inspectOpenClawExtensionDirectory,
  listBundledOpenClawExtensionIds,
  syncLocalOpenClawExtensionsIntoRuntime,
} from './openclawLocalExtensions';

describe('openclawLocalExtensions', () => {
  let resourcesDir: string;
  let originalResourcesPath: string;

  beforeEach(() => {
    electronApp.isPackaged = true;
    electronApp.getAppPath.mockReset();
    resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extensions-'));
    originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesDir,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath,
    });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  });

  it('discovers extensions in the packaged OpenClaw dist directory', () => {
    const extensionDir = path.join(
      resourcesDir,
      'cfmind',
      'dist',
      'extensions',
      'automation-permission',
    );
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'automation-permission' }),
    );

    expect(listBundledOpenClawExtensionIds()).toContain('automation-permission');
    expect(hasBundledOpenClawExtension('automation-permission')).toBe(true);
  });

  it('uses the manifest id instead of assuming it matches the directory name', () => {
    const extensionDir = path.join(
      resourcesDir,
      'cfmind',
      'dist',
      'extensions',
      'legacy-directory-name',
    );
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, 'openclaw.plugin.json'),
      "{ id: 'current-extension-id', // JSON5 is supported\n}",
    );

    expect(listBundledOpenClawExtensionIds()).toContain('current-extension-id');
    expect(hasBundledOpenClawExtension('current-extension-id')).toBe(true);
    expect(hasBundledOpenClawExtension('legacy-directory-name')).toBe(false);
  });

  it('keeps runtime source replacements and build metadata out of source inventory and runtime copying', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const source = path.join(resourcesDir, 'plugins/extensions');
    const overlay = path.join(source, 'openai');
    const plugin = path.join(source, 'runtime-services');
    fs.mkdirSync(overlay, { recursive: true });
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(
      path.join(overlay, 'package.json'),
      JSON.stringify({ openclaw: { runtimeBundled: true } }),
    );
    fs.writeFileSync(path.join(overlay, 'index.ts'), 'export default {};');
    fs.writeFileSync(
      path.join(plugin, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'runtime-services' }),
    );
    fs.writeFileSync(path.join(source, 'prune-policy.json'), '{}');
    expect(inspectLocalOpenClawExtensions()).toEqual({ complete: true, ids: ['runtime-services'] });
    expect(inspectOpenClawExtensionDirectory(source).complete).toBe(false);
    const runtime = path.join(resourcesDir, 'runtime');
    fs.mkdirSync(path.join(runtime, 'dist/extensions'), { recursive: true });
    expect((await syncLocalOpenClawExtensionsIntoRuntime(runtime)).copied).toEqual([
      'runtime-services',
    ]);
    expect(fs.existsSync(path.join(runtime, 'dist/extensions/openai'))).toBe(false);
    expect(fs.existsSync(path.join(runtime, 'dist/extensions/prune-policy.json'))).toBe(false);
  });

  it.each([
    { name: 'prune-policy.json', directory: false, complete: true },
    { name: 'unknown.json', directory: false, complete: false },
    { name: 'prune-policy.json', directory: true, complete: false },
  ])(
    'preserves source inventory checks for $name (directory=$directory)',
    ({ name, directory, complete }) => {
      electronApp.isPackaged = false;
      electronApp.getAppPath.mockReturnValue(resourcesDir);
      const source = path.join(resourcesDir, 'plugins/extensions');
      const entry = path.join(source, name);
      fs.mkdirSync(source, { recursive: true });
      if (directory) fs.mkdirSync(entry);
      else fs.writeFileSync(entry, '{}');

      expect(inspectLocalOpenClawExtensions()).toEqual({ complete, ids: [] });
      expect(inspectOpenClawExtensionDirectory(source)).toEqual({ complete: false, ids: [] });
    },
  );

  it('discovers compatible bundle manifests using OpenClaw id normalization', () => {
    const extensionsDir = path.join(resourcesDir, 'bundle-extensions');
    const extensionDir = path.join(extensionsDir, 'different-directory-name');
    fs.mkdirSync(path.join(extensionDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'Internal Research Tools' }),
    );

    expect(inspectOpenClawExtensionDirectory(extensionsDir)).toEqual({
      complete: true,
      ids: ['internal-research-tools'],
    });
  });

  it('discovers manifestless Claude-compatible bundles', () => {
    const extensionsDir = path.join(resourcesDir, 'bundle-extensions');
    const extensionDir = path.join(extensionsDir, 'Company Skills');
    fs.mkdirSync(path.join(extensionDir, 'skills'), { recursive: true });

    expect(inspectOpenClawExtensionDirectory(extensionsDir)).toEqual({
      complete: true,
      ids: ['company-skills'],
    });
  });

  it('marks an unrecognized extension candidate as an incomplete inventory', () => {
    const extensionsDir = path.join(resourcesDir, 'opaque-extensions');
    const opaqueExtensionDir = path.join(extensionsDir, 'opaque-extension');
    fs.mkdirSync(opaqueExtensionDir, { recursive: true });
    fs.writeFileSync(path.join(opaqueExtensionDir, 'package.json'), '{}');

    expect(inspectOpenClawExtensionDirectory(extensionsDir)).toEqual({
      complete: false,
      ids: [],
    });
  });

  it('syncs local extension sources into the runtime', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceDir = path.join(resourcesDir, 'plugins/extensions', 'automation-permission');
    const runtimeRoot = path.join(resourcesDir, 'runtime');
    const targetExtensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(targetExtensionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'automation-permission' }),
    );

    expect((await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot)).copied).toEqual([
      'automation-permission',
    ]);
    expect(fs.existsSync(path.join(targetExtensionsDir, 'automation-permission'))).toBe(true);
  });

  it('does not copy retired widget assets during development fallback synchronization', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceDir = path.join(resourcesDir, 'plugins/extensions/widget-kit');
    const runtimeRoot = path.join(resourcesDir, 'runtime');
    const target = path.join(runtimeRoot, 'dist/extensions/widget-kit');
    const oldAsset = path.join(sourceDir, 'assets/libraries/retired.js');
    fs.mkdirSync(path.dirname(oldAsset), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(oldAsset, 'keep original asset');
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'widget-kit' }),
    );
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export default {};');

    expect((await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot)).copied).toEqual([
      'widget-kit',
    ]);
    expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'assets'))).toBe(false);
    expect(fs.readFileSync(oldAsset, 'utf8')).toBe('keep original asset');
  });

  it('does not sync through an extensions directory link outside the runtime root', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceDir = path.join(resourcesDir, 'plugins/extensions', 'automation-permission');
    const runtimeRoot = path.join(resourcesDir, 'runtime-link-test');
    const runtimeDistDir = path.join(runtimeRoot, 'dist');
    const externalExtensionsDir = path.join(resourcesDir, 'external-extensions');
    const externalMarker = path.join(externalExtensionsDir, 'keep.txt');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(runtimeDistDir, { recursive: true });
    fs.mkdirSync(externalExtensionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'automation-permission' }),
    );
    fs.writeFileSync(externalMarker, 'do not overwrite');
    try {
      fs.symlinkSync(
        externalExtensionsDir,
        path.join(runtimeDistDir, 'extensions'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    expect((await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot)).copied).toEqual([]);
    expect(fs.readFileSync(externalMarker, 'utf8')).toBe('do not overwrite');
  });

  it('keeps the event loop responsive while copying dependency files', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceDir = path.join(resourcesDir, 'plugins/extensions', 'source-plugin');
    const runtimeRoot = path.join(resourcesDir, 'runtime');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'dist', 'extensions'), { recursive: true });
    for (let index = 0; index < 100; index += 1) {
      fs.writeFileSync(path.join(sourceDir, `${index}.js`), `export const value = ${index};`);
    }
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot);
      expect(ticks).toBeGreaterThan(1);
      expect(
        fs.readFileSync(path.join(runtimeRoot, 'dist/extensions/source-plugin/99.js'), 'utf8'),
      ).toBe('export const value = 99;');
    } finally {
      clearInterval(heartbeat);
    }
  });

  it('refreshes source changes on the next preparation and preserves compiled plugins', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceRoot = path.join(resourcesDir, 'plugins/extensions');
    const runtimeRoot = path.join(resourcesDir, 'runtime');
    const targetRoot = path.join(runtimeRoot, 'dist', 'extensions');
    for (const name of ['source-plugin', 'compiled-plugin']) {
      fs.mkdirSync(path.join(sourceRoot, name), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, name, 'index.ts'), 'first');
    }
    fs.mkdirSync(path.join(targetRoot, 'compiled-plugin'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'compiled-plugin', 'index.js'), 'compiled');

    await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot);
    fs.writeFileSync(path.join(sourceRoot, 'source-plugin', 'index.ts'), 'updated');
    await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot);

    expect(fs.readFileSync(path.join(targetRoot, 'source-plugin', 'index.ts'), 'utf8')).toBe(
      'updated',
    );
    expect(fs.readFileSync(path.join(targetRoot, 'compiled-plugin', 'index.js'), 'utf8')).toBe(
      'compiled',
    );
    expect(fs.existsSync(path.join(targetRoot, 'compiled-plugin', 'index.ts'))).toBe(false);
  });

  it('reports permission errors instead of treating an inaccessible runtime as prepared', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    fs.mkdirSync(path.join(resourcesDir, 'plugins/extensions'), { recursive: true });
    const permissionError = Object.assign(new Error('Access denied'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(permissionError);

    await expect(
      syncLocalOpenClawExtensionsIntoRuntime(path.join(resourcesDir, 'runtime')),
    ).rejects.toBe(permissionError);
  });
});

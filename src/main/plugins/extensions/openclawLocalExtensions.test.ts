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

  it('keeps runtime source replacements out of source inventory and runtime source copying', async () => {
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
    expect(inspectLocalOpenClawExtensions()).toEqual({ complete: true, ids: ['runtime-services'] });
    expect(inspectOpenClawExtensionDirectory(source).complete).toBe(false);
    const runtime = path.join(resourcesDir, 'runtime');
    fs.mkdirSync(path.join(runtime, 'dist/extensions'), { recursive: true });
    expect((await syncLocalOpenClawExtensionsIntoRuntime(runtime)).copied).toEqual([
      'runtime-services',
    ]);
    expect(fs.existsSync(path.join(runtime, 'dist/extensions/openai'))).toBe(false);
  });

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

  it.each([
    { packageName: 'openclaw-interactive-ui', pluginId: 'interactive-ui', retired: true },
    { packageName: 'third-party', pluginId: 'interactive-ui', retired: false },
    { packageName: 'openclaw-interactive-ui', pluginId: 'other-plugin', retired: false },
  ])(
    'retires only the previous app-owned widget bundle on development startup ($packageName, $pluginId)',
    async ({ packageName, pluginId, retired }) => {
      electronApp.isPackaged = false;
      electronApp.getAppPath.mockReturnValue(resourcesDir);
      const sourceDir = path.join(resourcesDir, 'plugins/extensions', 'widget-kit');
      const runtimeRoot = path.join(resourcesDir, 'runtime');
      const targetExtensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
      const previous = path.join(targetExtensionsDir, 'interactive-ui');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(previous, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'widget-kit' }),
      );
      fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export default {};');
      fs.writeFileSync(
        path.join(previous, 'openclaw.plugin.json'),
        JSON.stringify({ id: pluginId }),
      );
      fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: packageName }));
      fs.writeFileSync(path.join(previous, 'index.js'), 'export default {};');

      expect((await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot)).copied).toEqual([
        'widget-kit',
      ]);
      expect(fs.existsSync(previous)).toBe(!retired);
      expect(inspectOpenClawExtensionDirectory(targetExtensionsDir).ids.sort()).toEqual(
        retired ? ['widget-kit'] : [pluginId, 'widget-kit'].sort(),
      );
    },
  );

  it.each(['interactive-ui', 'widget-kit'])(
    'does not retire when %s is a directory link',
    async linkedId => {
      electronApp.isPackaged = false;
      electronApp.getAppPath.mockReturnValue(resourcesDir);
      const sourceDir = path.join(resourcesDir, 'plugins/extensions', 'widget-kit');
      const runtimeRoot = path.join(resourcesDir, 'runtime');
      const targetExtensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
      const externalDir = path.join(resourcesDir, 'external-widget-bundle');
      const previous = path.join(targetExtensionsDir, 'interactive-ui');
      const linkedDir = path.join(targetExtensionsDir, linkedId);
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(targetExtensionsDir, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'widget-kit' }),
      );
      fs.writeFileSync(
        path.join(externalDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: linkedId }),
      );
      fs.writeFileSync(
        path.join(externalDir, 'package.json'),
        JSON.stringify({ name: `openclaw-${linkedId}` }),
      );
      if (linkedId === 'widget-kit') {
        fs.mkdirSync(previous, { recursive: true });
        fs.writeFileSync(
          path.join(previous, 'openclaw.plugin.json'),
          JSON.stringify({ id: 'interactive-ui' }),
        );
        fs.writeFileSync(
          path.join(previous, 'package.json'),
          JSON.stringify({ name: 'openclaw-interactive-ui' }),
        );
      }
      const marker = path.join(externalDir, 'keep.txt');
      fs.writeFileSync(marker, 'preserve external content');
      try {
        fs.symlinkSync(externalDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return;
      }

      await syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot);
      expect(fs.existsSync(previous)).toBe(true);
      expect(fs.lstatSync(linkedDir).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toBe('preserve external content');
    },
  );

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

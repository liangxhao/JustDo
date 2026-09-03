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

  it('removes retired managed extension directories before syncing local sources', () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceDir = path.join(resourcesDir, 'openclaw-extensions', 'automation-permission');
    const runtimeRoot = path.join(resourcesDir, 'runtime');
    const targetExtensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
    const retiredPermissionDir = path.join(targetExtensionsDir, 'action-approval');
    const retiredFilePolicyDir = path.join(targetExtensionsDir, 'file-permission-policy');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(retiredPermissionDir, { recursive: true });
    fs.mkdirSync(retiredFilePolicyDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'automation-permission' }),
    );
    fs.writeFileSync(path.join(retiredPermissionDir, 'index.js'), 'export default {};');
    fs.writeFileSync(path.join(retiredFilePolicyDir, 'index.js'), 'export default {};');

    expect(syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot).copied).toEqual([
      'automation-permission',
    ]);
    expect(fs.existsSync(retiredPermissionDir)).toBe(false);
    expect(fs.existsSync(retiredFilePolicyDir)).toBe(false);
    expect(fs.existsSync(path.join(targetExtensionsDir, 'automation-permission'))).toBe(true);
  });

  it('does not clean through an extensions directory link outside the runtime root', () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(resourcesDir);
    const sourceDir = path.join(resourcesDir, 'openclaw-extensions', 'automation-permission');
    const runtimeRoot = path.join(resourcesDir, 'runtime-link-test');
    const runtimeDistDir = path.join(runtimeRoot, 'dist');
    const externalExtensionsDir = path.join(resourcesDir, 'external-extensions');
    const retiredDir = path.join(externalExtensionsDir, 'file-permission-policy');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(runtimeDistDir, { recursive: true });
    fs.mkdirSync(retiredDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'automation-permission' }),
    );
    fs.writeFileSync(path.join(retiredDir, 'keep.txt'), 'do not delete');
    try {
      fs.symlinkSync(
        externalExtensionsDir,
        path.join(runtimeDistDir, 'extensions'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    expect(syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot).copied).toEqual([]);
    expect(fs.existsSync(path.join(retiredDir, 'keep.txt'))).toBe(true);
  });
});

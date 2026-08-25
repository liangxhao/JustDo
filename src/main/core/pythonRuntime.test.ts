import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '',
    getPath: (name: string) => (name === 'userData' ? electronMocks.userData : ''),
  },
}));

import {
  appendPythonRuntimeToEnv,
  ensurePythonRuntimeReady,
  getBundledPythonRoot,
  JUSTDO_MANAGED_PYTHON_USER_BASE_ENV,
} from './pythonRuntime';

describe('packaged Python runtime', () => {
  let tempRoot: string;
  let resourcesRoot: string;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalResourcesPath: PropertyDescriptor | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-python-runtime-'));
    resourcesRoot = path.join(tempRoot, 'resources');
    electronMocks.userData = path.join(tempRoot, 'user-data');
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesRoot,
    });

    const runtimeRoot = path.join(resourcesRoot, 'python-win');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'python.exe'), 'python', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'python3.exe'), 'python', 'utf8');
    fs.mkdirSync(path.join(runtimeRoot, 'Lib', 'site-packages'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, 'Lib', 'site-packages', 'sitecustomize.py'),
      'sitecustomize',
      'utf8',
    );
    fs.writeFileSync(
      path.join(runtimeRoot, 'python312._pth'),
      'python312.zip\n.\nLib\\site-packages\nLib\\bundled-site-packages\nimport site\n',
      'utf8',
    );
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    } else {
      delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('uses only the runtime in the application resources directory', () => {
    const bundledRoot = path.join(resourcesRoot, 'python-win');
    const legacyRoot = path.join(electronMocks.userData, 'runtimes', 'python-win');
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'python.exe'), 'legacy', 'utf8');

    const env = appendPythonRuntimeToEnv({
      PATH: 'C:\\Windows\\System32',
      justdo_managed_python_user_base: 'C:\\untrusted\\python-user',
    });

    expect(getBundledPythonRoot()).toBe(bundledRoot);
    expect(env.JUSTDO_PYTHON_ROOT).toBe(bundledRoot);
    expect(env.PATH).toContain(bundledRoot);
    expect(env.PATH).not.toContain(legacyRoot);
    expect(env.PYTHONUSERBASE).toBe(path.join(electronMocks.userData, 'runtimes', 'python-user'));
    expect(env[JUSTDO_MANAGED_PYTHON_USER_BASE_ENV]).toBe(
      path.join(electronMocks.userData, 'runtimes', 'python-user'),
    );
    expect(env.justdo_managed_python_user_base).toBeUndefined();
    expect(env.JUSTDO_PYTHON_USER_SITE).toBe(
      path.join(electronMocks.userData, 'runtimes', 'python-user', 'Python312', 'site-packages'),
    );
    expect(env.JUSTDO_PYTHON_LEGACY_SITE).toBeUndefined();
    expect(env.PIP_USER).toBeUndefined();
  });

  test('removes inherited provenance when the bundled runtime is unavailable', () => {
    fs.rmSync(path.join(resourcesRoot, 'python-win'), { recursive: true, force: true });

    const env = appendPythonRuntimeToEnv({
      PYTHONUSERBASE: 'C:\\host\\python-user',
      JUSTDO_MANAGED_PYTHON_USER_BASE: 'C:\\host\\python-user',
      justdo_managed_python_user_base: 'C:\\host\\lowercase-python-user',
    });

    expect(env.PYTHONUSERBASE).toBe('C:\\host\\python-user');
    expect(env.JUSTDO_MANAGED_PYTHON_USER_BASE).toBeUndefined();
    expect(env.justdo_managed_python_user_base).toBeUndefined();
  });

  test('removes inherited provenance outside Windows', () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });

    const env = appendPythonRuntimeToEnv({
      PYTHONUSERBASE: '/host/python-user',
      JUSTDO_MANAGED_PYTHON_USER_BASE: '/host/python-user',
      justdo_managed_python_user_base: '/host/lowercase-python-user',
    });

    expect(env.PYTHONUSERBASE).toBe('/host/python-user');
    expect(env.JUSTDO_MANAGED_PYTHON_USER_BASE).toBeUndefined();
    expect(env.justdo_managed_python_user_base).toBeUndefined();
  });

  test('removes the legacy userData runtime during startup', async () => {
    const legacyRoot = path.join(electronMocks.userData, 'runtimes', 'python-win');
    fs.mkdirSync(path.join(legacyRoot, 'Lib', 'site-packages'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'python.exe'), 'legacy', 'utf8');
    fs.writeFileSync(
      path.join(legacyRoot, 'Lib', 'site-packages', 'user-package.py'),
      'user-package',
      'utf8',
    );

    await expect(ensurePythonRuntimeReady()).resolves.toEqual({ success: true });

    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(fs.existsSync(path.join(resourcesRoot, 'python-win', 'python.exe'))).toBe(true);
    expect(
      fs.existsSync(path.join(electronMocks.userData, 'runtimes', 'python-user', 'Python312')),
    ).toBe(false);
  });
});

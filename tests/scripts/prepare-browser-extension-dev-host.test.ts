import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  buildDevNativeHostConfig,
  buildDevNativeHostPlan,
  compileBrowserExtensionNativeHost,
  prepareBrowserExtensionDevHost,
} = require('../../scripts/browser/prepare-browser-extension-dev-host.cjs') as {
  buildDevNativeHostConfig: (
    plan: { manifestPath: string; repoRoot: string },
    electronPath: string,
    devServerUrl: string,
  ) => Record<string, unknown>;
  buildDevNativeHostPlan: (options: { appDataPath: string; repoRoot: string }) => {
    executablePath: string;
    manifest: Record<string, unknown>;
    manifestPath: string;
    registryKey: string;
  };
  compileBrowserExtensionNativeHost: (options: {
    executablePath: string;
    platform: string;
    repoRoot: string;
    windowsDirectory: string;
  }) => { executablePath: string; reused: boolean };
  prepareBrowserExtensionDevHost: (options: { platform: string }) => unknown;
};

const projectRoot = path.resolve(__dirname, '../..');

describe('browser extension development native host', () => {
  test('builds a Chrome manifest plan for the fixed extension identity', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-dev-native-host-'));
    const appDataPath = path.join(repoRoot, 'app-data');
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ productName: 'Acme' }),
      'utf8',
    );
    fs.mkdirSync(path.join(repoRoot, 'scripts', 'browser'), { recursive: true });
    fs.copyFileSync(
      path.join(projectRoot, 'scripts', 'browser', 'browser-extension-native-host.cs'),
      path.join(repoRoot, 'scripts', 'browser', 'browser-extension-native-host.cs'),
    );

    try {
      const plan = buildDevNativeHostPlan({ appDataPath, repoRoot });

      expect(plan.manifestPath).toBe(
        path.join(appDataPath, 'Acme', 'browser-extension', 'com.justdo.browserextension.json'),
      );
      expect(plan.manifest).toMatchObject({
        allowed_origins: ['chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/'],
        name: 'com.justdo.browserextension',
        path: plan.executablePath,
        type: 'stdio',
      });
      expect(plan.registryKey).toBe(
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.justdo.browserextension',
      );
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  test('does not register a Windows host on other platforms', () => {
    expect(prepareBrowserExtensionDevHost({ platform: 'linux' })).toBeNull();
  });

  test('requires the compiled Electron main process before launching the development app', () => {
    const repoRoot = path.join('E:', 'workspace', 'JustDo');
    const manifestPath = path.join(repoRoot, 'app-data', 'native-host.json');

    expect(
      buildDevNativeHostConfig(
        { manifestPath, repoRoot },
        path.join(repoRoot, 'electron.exe'),
        'http://localhost:43127',
      ),
    ).toMatchObject({
      requiredPath: path.join(repoRoot, 'dist-electron', 'main.js'),
      requiredUrl: 'http://localhost:43127',
    });
  });

  test('reuses a content-addressed executable without invoking the compiler', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-dev-native-host-'));
    const executablePath = path.join(repoRoot, 'build', 'native-host.exe');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, Buffer.from('MZ existing executable'));

    try {
      const result = compileBrowserExtensionNativeHost({
        executablePath,
        platform: 'win32',
        repoRoot,
        windowsDirectory: path.join(repoRoot, 'missing-windows'),
      });

      expect(result).toMatchObject({ executablePath, reused: true });
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });
});

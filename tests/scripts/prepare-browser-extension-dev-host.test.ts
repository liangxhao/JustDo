import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  buildDevNativeHostConfig,
  buildDevNativeHostPlan,
  compileBrowserExtensionNativeHost,
  prepareBrowserExtensionDevHost,
  resolveCompilerPath,
} = require('../../scripts/browser/prepare-browser-extension-dev-host.cjs') as {
  buildDevNativeHostConfig: (plan: { manifestPath: string }) => Record<string, unknown>;
  buildDevNativeHostPlan: (options: { appDataPath: string; repoRoot: string }) => {
    executablePath: string;
    manifest: Record<string, unknown>;
    manifestPath: string;
    registryKey: string;
  };
  compileBrowserExtensionNativeHost: (options: {
    executablePath?: string;
    platform: string;
    repoRoot: string;
    windowsDirectory?: string;
  }) => { executablePath: string; reused: boolean };
  prepareBrowserExtensionDevHost: (options: { platform: string }) => unknown;
  resolveCompilerPath: () => string | null;
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
      expect(path.basename(plan.executablePath)).toBe('Acme-browser-extension-native-host.exe');
      expect(path.basename(path.dirname(plan.executablePath))).toMatch(/^[0-9a-f]{16}$/);
      expect(path.dirname(path.dirname(plan.executablePath))).toBe(
        path.join(repoRoot, 'build', 'browser-extension', 'native-host'),
      );
      expect(buildDevNativeHostPlan({ appDataPath, repoRoot }).executablePath).toBe(
        plan.executablePath,
      );

      fs.appendFileSync(
        path.join(repoRoot, 'scripts', 'browser', 'browser-extension-native-host.cs'),
        '\n// Changed development source.\n',
      );
      const updatedPlan = buildDevNativeHostPlan({ appDataPath, repoRoot });
      expect(updatedPlan.executablePath).not.toBe(plan.executablePath);
      expect(path.basename(updatedPlan.executablePath)).toBe(
        'Acme-browser-extension-native-host.exe',
      );
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  test('does not register a Windows host on other platforms', () => {
    expect(prepareBrowserExtensionDevHost({ platform: 'linux' })).toBeNull();
  });

  test('only discovers the running development app and provides no launch target', () => {
    const repoRoot = path.join('E:', 'workspace', 'JustDo');
    const manifestPath = path.join(repoRoot, 'app-data', 'native-host.json');

    expect(buildDevNativeHostConfig({ manifestPath })).toEqual({
      allowAppLaunch: false,
      rendezvousPath: path.join(path.dirname(manifestPath), 'app-server.json'),
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

  test.skipIf(process.platform !== 'win32' || !resolveCompilerPath())(
    'rebuilds the fixed packaged executable with the configured product name',
    () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-native-host-build-'));
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({ productName: 'Acme' }),
      );
      fs.mkdirSync(path.join(repoRoot, 'scripts', 'browser'), { recursive: true });
      fs.copyFileSync(
        path.join(projectRoot, 'scripts', 'browser', 'browser-extension-native-host.cs'),
        path.join(repoRoot, 'scripts', 'browser', 'browser-extension-native-host.cs'),
      );

      try {
        const result = compileBrowserExtensionNativeHost({ platform: 'win32', repoRoot });
        expect(result).toMatchObject({
          executablePath: path.join(
            repoRoot,
            'build',
            'browser-extension',
            'native-host',
            'Acme-browser-extension-native-host.exe',
          ),
          reused: false,
        });
        expect(fs.readFileSync(result.executablePath).subarray(0, 2).toString()).toBe('MZ');
        expect(compileBrowserExtensionNativeHost({ platform: 'win32', repoRoot }).reused).toBe(
          false,
        );
      } finally {
        fs.rmSync(repoRoot, { force: true, recursive: true });
      }
    },
  );

  test('packages only the configured product helper and excludes development outputs', () => {
    const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
    const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
    const builderConfig = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'electron-builder.json'), 'utf8'),
    );
    const resource = builderConfig.win.extraResources.find(
      (candidate: { to: string }) => candidate.to === 'browser-extension/native-host',
    );
    expect(resource).toEqual({
      from: 'build/browser-extension/native-host',
      to: 'browser-extension/native-host',
      filter: ['${productName}-browser-extension-native-host.exe'],
    });
    const matcher = new FileMatcher(
      path.join(projectRoot, resource.from),
      resource.to,
      (value: string) =>
        expandMacro(value, null, { productName: 'Acme', sanitizedProductName: 'Acme' }),
      resource.filter,
    );
    const accepts = (relativePath: string) =>
      matcher.createFilter()(path.join(matcher.from, relativePath), { isDirectory: () => false });

    expect(accepts('Acme-browser-extension-native-host.exe')).toBe(true);
    expect(accepts('Other-browser-extension-native-host.exe')).toBe(false);
    expect(accepts(path.join('0123456789abcdef', 'Acme-browser-extension-native-host.exe'))).toBe(
      false,
    );
    expect(accepts('justdo-browser-extension-native-host-v2.exe')).toBe(false);
  });
});

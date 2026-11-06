import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  buildDevNativeHostConfig,
  buildDevNativeHostPlan,
  compileChromeExtensionNativeHost,
  prepareChromeExtensionDevHost,
  resolveCompilerPath,
} = require('../../../scripts/chrome/prepare-chrome-extension-dev-host.cjs') as {
  buildDevNativeHostConfig: (plan: { manifestPath: string }) => Record<string, unknown>;
  buildDevNativeHostPlan: (options: { appDataPath: string; repoRoot: string }) => {
    executablePath: string;
    manifest: Record<string, unknown>;
    manifestPath: string;
    registryKey: string;
  };
  compileChromeExtensionNativeHost: (options: {
    executablePath?: string;
    platform: string;
    repoRoot: string;
    windowsDirectory?: string;
  }) => { executablePath: string; reused: boolean };
  prepareChromeExtensionDevHost: (options: { platform: string }) => unknown;
  resolveCompilerPath: () => string | null;
};

const projectRoot = path.resolve(__dirname, '../../..');

describe('browser extension development native host', () => {
  test('builds a Chrome manifest plan for the fixed extension identity', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-dev-native-host-'));
    const appDataPath = path.join(repoRoot, 'app-data');
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ productName: 'Acme' }),
      'utf8',
    );
    fs.mkdirSync(path.join(repoRoot, 'scripts', 'chrome'), { recursive: true });
    fs.copyFileSync(
      path.join(projectRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs'),
      path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs'),
    );

    try {
      const plan = buildDevNativeHostPlan({ appDataPath, repoRoot });

      expect(plan.manifestPath).toBe(
        path.join(appDataPath, 'Acme', 'chrome-extension', 'app.chrome_extension.json'),
      );
      expect(plan.manifest).toMatchObject({
        allowed_origins: ['chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/'],
        name: 'app.chrome_extension',
        path: plan.executablePath,
        type: 'stdio',
      });
      expect(plan.registryKey).toBe(
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\app.chrome_extension',
      );
      expect(path.basename(plan.executablePath)).toBe('Acme-chrome-extension-native-host.exe');
      expect(path.basename(path.dirname(plan.executablePath))).toMatch(/^[0-9a-f]{16}$/);
      expect(path.dirname(path.dirname(plan.executablePath))).toBe(
        path.join(repoRoot, 'build', 'chrome-extension', 'native-host'),
      );
      expect(buildDevNativeHostPlan({ appDataPath, repoRoot }).executablePath).toBe(
        plan.executablePath,
      );

      fs.appendFileSync(
        path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs'),
        '\n// Changed development source.\n',
      );
      const updatedPlan = buildDevNativeHostPlan({ appDataPath, repoRoot });
      expect(updatedPlan.executablePath).not.toBe(plan.executablePath);
      expect(path.basename(updatedPlan.executablePath)).toBe(
        'Acme-chrome-extension-native-host.exe',
      );
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  test('does not register a Windows host on other platforms', () => {
    expect(prepareChromeExtensionDevHost({ platform: 'linux' })).toBeNull();
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
      const result = compileChromeExtensionNativeHost({
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
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-native-host-build-'));
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({ productName: 'Acme' }),
      );
      fs.mkdirSync(path.join(repoRoot, 'scripts', 'chrome'), { recursive: true });
      fs.copyFileSync(
        path.join(projectRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs'),
        path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs'),
      );
      const outputDirectory = path.join(repoRoot, 'build', 'chrome-extension', 'native-host');
      const staleName = 'acme-chrome-extension-native-host.exe';
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(outputDirectory, staleName), 'MZ old lowercase executable');

      try {
        const result = compileChromeExtensionNativeHost({ platform: 'win32', repoRoot });
        expect(result).toMatchObject({
          executablePath: path.join(
            repoRoot,
            'build',
            'chrome-extension',
            'native-host',
            'Acme-chrome-extension-native-host.exe',
          ),
          reused: false,
        });
        expect(fs.readFileSync(result.executablePath).subarray(0, 2).toString()).toBe('MZ');
        const outputNames = fs.readdirSync(outputDirectory);
        expect(outputNames).toContain('Acme-chrome-extension-native-host.exe');
        expect(outputNames).not.toContain(staleName);
        const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
        const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
        const builderConfig = JSON.parse(
          fs.readFileSync(path.join(projectRoot, 'electron-builder.json'), 'utf8'),
        );
        const resource = builderConfig.win.extraResources.find(
          (candidate: { to: string }) => candidate.to === 'chrome-extension/native-host',
        );
        const matcher = new FileMatcher(
          outputDirectory,
          path.join(repoRoot, 'packaged-host'),
          (value: string) => expandMacro(value, null, { productName: 'Acme', sanitizedProductName: 'Acme' }),
          resource.filter,
        );
        const actualExecutablePath = path.join(outputDirectory, outputNames.find(name => name.endsWith('.exe'))!);
        expect(matcher.createFilter()(actualExecutablePath, fs.statSync(actualExecutablePath))).toBe(true);
        expect(compileChromeExtensionNativeHost({ platform: 'win32', repoRoot }).reused).toBe(
          false,
        );
        fs.appendFileSync(
          path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs'),
          '\ninvalid C# source\n',
        );
        expect(() => compileChromeExtensionNativeHost({ platform: 'win32', repoRoot })).toThrow();
        expect(fs.existsSync(result.executablePath)).toBe(false);
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
      (candidate: { to: string }) => candidate.to === 'chrome-extension/native-host',
    );
    expect(resource).toEqual({
      from: 'build/chrome-extension/native-host',
      to: 'chrome-extension/native-host',
      filter: ['${productName}-chrome-extension-native-host.exe'],
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

    expect(accepts('Acme-chrome-extension-native-host.exe')).toBe(true);
    expect(accepts('Other-chrome-extension-native-host.exe')).toBe(false);
    expect(accepts(path.join('0123456789abcdef', 'Acme-chrome-extension-native-host.exe'))).toBe(
      false,
    );
    expect(accepts('chrome-extension-native-host-v2.exe')).toBe(false);
  });
});

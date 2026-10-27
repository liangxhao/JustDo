import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const electronBuilderConfig = require('../../electron-builder.config.cjs') as {
  asarUnpack?: string[];
  files?: Array<string | { from: string; filter: string[] }>;
  npmRebuild?: boolean;
  mac?: { extraResources?: Array<{ from: string; to: string; filter: string[] }> };
  linux?: { extraResources?: Array<{ from: string; to: string; filter: string[] }> };
};

test('relies on the npm predist:win lifecycle without invoking it twice', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['predist:win']).toBe(
    'npm run drawio:prepare -- --ensure --download && npm run clean:release && node scripts/packaging/prepare-windows-build.cjs',
  );
  expect(packageJson.scripts['dist:win']).not.toContain('npm run predist:win');
  expect(packageJson.scripts['dist:win']).not.toMatch(/setup:(?:mingit|python-runtime)/);
});

test('retires widget library preparation and excludes leftover assets on non-Windows targets', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const name of ['smart-canvas:prepare', 'smart-canvas:verify', 'smart-canvas:verify:browser'])
    expect(scripts).not.toHaveProperty(name);
  for (const command of Object.values(scripts)) expect(command).not.toContain('smart-canvas:prepare');
  for (const platform of [electronBuilderConfig.mac, electronBuilderConfig.linux]) {
    const runtime = platform?.extraResources?.find(entry => entry.to === 'cfmind');
    expect(runtime?.filter).toContain('!dist/extensions/smart-canvas/assets');
    expect(runtime?.filter).toContain('!dist/extensions/smart-canvas/assets/**');
  }
});

test('excludes the retired widget asset directory itself using the actual non-Windows copy filter', async () => {
  const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-directory-filter-'));
  const source = path.join(fixture, 'source');
  const assetDirectory = 'dist/extensions/smart-canvas/assets';
  try {
    fs.mkdirSync(path.join(source, assetDirectory), { recursive: true });
    fs.writeFileSync(path.join(source, assetDirectory, 'legacy.js'), 'retired asset');
    fs.writeFileSync(path.join(source, assetDirectory, 'README.md'), 'retired documentation');
    fs.writeFileSync(path.join(source, 'dist/extensions/smart-canvas/index.js'), 'retained entry');
    for (const [name, platform] of [
      ['mac', electronBuilderConfig.mac],
      ['linux', electronBuilderConfig.linux],
    ] as const) {
      const runtime = platform?.extraResources?.find(entry => entry.to === 'cfmind');
      const destination = path.join(fixture, name);
      const matcher = new FileMatcher(
        source,
        destination,
        (value: string) => value,
        runtime?.filter,
      );
      const filter = matcher.createFilter();
      const assetRoot = path.join(source, assetDirectory);
      expect(filter(assetRoot, fs.statSync(assetRoot))).toBe(false);
      for (const file of ['legacy.js', 'README.md']) {
        const filename = path.join(assetRoot, file);
        expect(filter(filename, fs.statSync(filename))).toBe(false);
      }
      await copyFiles([matcher], null, false);
      expect(fs.existsSync(path.join(destination, assetDirectory))).toBe(false);
      expect(
        fs.readFileSync(path.join(destination, 'dist/extensions/smart-canvas/index.js'), 'utf8'),
      ).toBe('retained entry');
    }
    expect(fs.readFileSync(path.join(source, assetDirectory, 'legacy.js'), 'utf8')).toBe(
      'retired asset',
    );
  } finally {
    expect(path.dirname(fixture)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(fixture)).toMatch(/^widget-directory-filter-/);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('preinstalls the official MXC sandbox only for Windows runtimes', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { openclaw: { plugins: Array<Record<string, unknown>> } };

  expect(packageJson.openclaw.plugins).toContainEqual({
    id: 'mxc',
    npm: '@openclaw/mxc-sandbox',
    version: '2026.10.7',
    platforms: ['win32'],
  });
});

test('starts Electron as soon as the quiet readiness probes succeed', () => {
  const devRunner = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/electron/run-electron-dev.cjs'),
    'utf8',
  );

  expect(devRunner).toContain("require('wait-on')");
  expect(devRunner).toContain('timeout: 300_000, simultaneous: 1');
  expect(devRunner).not.toMatch(/delay:|verbose: true/);
});

test('prepares the local speech runtime before starting Electron in development', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['preelectron:dev']).toBe(
    'npm run browser-extension:prepare && npm run setup:local-tts',
  );
});

test('uses Vite native Monaco workers without emitting the legacy duplicate bundle', () => {
  const viteConfig = fs.readFileSync(path.resolve(__dirname, '../../vite.config.ts'), 'utf8');
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  ) as { devDependencies: Record<string, string> };

  expect(viteConfig).not.toContain('vite-plugin-monaco-editor');
  expect(viteConfig).not.toContain('monacoEditorPlugin');
  expect(packageJson.devDependencies).not.toHaveProperty('vite-plugin-monaco-editor');
  expect(viteConfig).toContain("fs.realpathSync(path.join(projectRoot, 'node_modules'))");
  expect(viteConfig).toContain('allow: [projectRoot, dependencyRoot]');
});

test('uses supported npm target options for OpenClaw runtime dependencies', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/install-openclaw-runtime.cjs'),
    'utf8',
  );

  expect(runtimeInstaller).toContain("'--os'");
  expect(runtimeInstaller).toContain("'--cpu'");
  expect(runtimeInstaller).not.toMatch(/npm_config_(?:target_)?(?:platform|arch)/);
});

test('defines the JSON reader used to validate the downloaded OpenClaw package', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/install-openclaw-runtime.cjs'),
    'utf8',
  );

  expect(runtimeInstaller).toMatch(/function readJsonFile\(filePath\)/);
  expect(runtimeInstaller).toContain(
    "const extractedPackage = readJsonFile(path.join(pkgDir, 'package.json'))",
  );
});

test('packages the complete OpenClaw CLI bootstrap into the runtime archive', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/install-openclaw-runtime.cjs'),
    'utf8',
  );

  expect(runtimeInstaller).toContain(
    "[...OPENCLAW_CLI_ROOT_FILES, 'package.json', 'dist']",
  );
  expect(runtimeInstaller).toContain('verifyPublicCliRootFiles(runtimeRoot)');
  expect(runtimeInstaller).toContain('verifyPublicCliArchiveEntries(entries)');
  expect(runtimeInstaller).toContain("entries.has('/node-version.mjs')");
  expect(runtimeInstaller).toContain("entries.has('/package.json')");

  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/packaging/electron-builder-hooks.cjs'),
    'utf8',
  );
  expect(builderHooks).toContain("entries.has('/node-version.mjs')");
  expect(builderHooks).toContain("entries.has('/package.json')");
  expect(builderHooks).toContain('OPENCLAW_CLI_ROOT_FILES.map(name => `cfmind/${name}`)');
  expect(builderHooks).toContain("tarEntryPaths.has('cfmind/dist/entry.js')");
  expect(builderHooks).toContain('verifyBareOpenClawCliRuntime(');

  const runtimeSync = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/sync-openclaw-runtime-current.cjs'),
    'utf8',
  );
  expect(runtimeSync).toContain('verifyPublicCliArchiveEntries(');
  expect(runtimeSync).toContain("[...OPENCLAW_CLI_ROOT_FILES, 'package.json'].includes(normalized)");
  expect(runtimeSync).toContain("normalized.startsWith('dist/')");
});

test('keeps an installed OpenClaw runtime frozen unless force install is requested', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/install-openclaw-runtime.cjs'),
    'utf8',
  );
  const bundleScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/bundle-openclaw-gateway.cjs'),
    'utf8',
  );

  expect(runtimeInstaller).toContain('decideRuntimeInstall');
  expect(runtimeInstaller).toContain('Existing runtime is frozen');
  expect(bundleScript).toContain('decideRuntimeBundle');
  expect(bundleScript).toContain('Existing runtime bundle is frozen');
  expect(bundleScript).toContain(
    'verifyFrozenOpenClawRuntime(runtimeDir, { requireBundle: true })',
  );
  expect(bundleScript).toContain('fs.rmSync(initialBundlePendingPath, { force: true })');
});

test('rewrites and packages the OpenClaw audit writer companion', () => {
  const bundleScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/bundle-openclaw-gateway.cjs'),
    'utf8',
  );
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/packaging/electron-builder-hooks.cjs'),
    'utf8',
  );
  const runtimeCompanions = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/openclaw/openclaw-runtime-companions.cjs'),
    'utf8',
  );

  expect(bundleScript).toContain('resolveAuditEventWriterUrl');
  expect(runtimeCompanions).toContain('dist/audit/audit-event-writer.worker.js');
  expect(builderHooks).toContain('getRuntimeCompanionPathsFromContent');
});

test('uses a target-aware and runtime-verified Electron-native rebuild', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const rebuildScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/electron/rebuild-electron-native.cjs'),
    'utf8',
  );
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/packaging/electron-builder-hooks.cjs'),
    'utf8',
  );

  expect(electronBuilderConfig.npmRebuild).toBe(false);
  expect(packageJson.scripts.postinstall).toBe(
    'node scripts/runtime/patch-http-mitm-proxy.cjs && npm run rebuild:electron-native',
  );
  expect(packageJson.scripts.postinstall).not.toContain('electron-builder install-app-deps');
  expect(packageJson.scripts['precompile:electron']).toBe('npm run rebuild:electron-native');
  expect(packageJson.scripts['prestart:electron']).toBe(
    'npm run rebuild:electron-native && npm run browser-extension:prepare',
  );
  expect(rebuildScript).toContain("'--platform'");
  expect(rebuildScript).toContain("'--arch'");
  expect(rebuildScript).toContain("process.argv.includes('--force')");
  expect(rebuildScript).toContain("const verificationMarker = 'JUSTDO_ELECTRON_ABI:'");
  expect(rebuildScript).toContain('/^\\d+$/.test(electronAbi)');
  expect(rebuildScript).toContain('already compatible with Electron ABI');
  expect(rebuildScript).toContain("ELECTRON_RUN_AS_NODE: '1'");
  expect(rebuildScript).toContain("new Database(':memory:')");
  expect(rebuildScript).toContain('Failed to rebuild better-sqlite3 for Electron.');
  expect(builderHooks).toContain('function rebuildElectronNativeModules(context)');
  expect(builderHooks).toContain('rebuildElectronNativeModules(context)');
  expect(builderHooks).toContain('context.electronPlatformName');
  expect(builderHooks).toContain('resolveTargetArch(context)');
  expect(builderHooks).toContain('verifyPackagedWindowsNativeModules(context)');
  expect(builderHooks).toContain("'better_sqlite3.node'");
  expect(builderHooks).toContain('Packaged better-sqlite3 failed Electron ABI verification');
  expect(builderHooks).not.toContain('Packaged node-pty failed Electron ABI verification');
  expect(builderHooks).toContain('verifyMxcArtifactEntryPaths(');
});

test('restores Electron native modules after tests even when Vitest fails', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const testRunner = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/test/run-tests.cjs'),
    'utf8',
  );

  expect(packageJson.scripts.test).toBe('node scripts/test/run-tests.cjs');
  expect(packageJson.scripts).not.toHaveProperty('pretest');
  expect(testRunner).toContain("['rebuild', 'better-sqlite3', '--foreground-scripts']");
  expect(testRunner).toContain("path.join(__dirname, '../electron/rebuild-electron-native.cjs')");
  expect(testRunner).toContain('finally');
});

test('keeps build-only dependencies and diagnostics out of the packaged app', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const fileSets = electronBuilderConfig.files?.filter(
    (entry): entry is { from: string; filter: string[] } => typeof entry !== 'string',
  );
  const rendererFiles = fileSets?.find(entry => entry.from === 'dist');
  const electronFiles = fileSets?.find(entry => entry.from === 'dist-electron');

  expect(rendererFiles?.filter).toContain('!**/*.map');
  expect(electronFiles?.filter).toContain('!**/*.map');
  expect(electronFiles?.filter).toContain('!src/**');
  expect(electronBuilderConfig.files).toContain('!node_modules/better-sqlite3/deps/**');
  expect(electronBuilderConfig.files).toContain('!node_modules/npm/docs/**');
  expect(electronBuilderConfig.asarUnpack).toEqual([
    'node_modules/better-sqlite3/build/Release/*.node',
  ]);
  expect(packageJson.dependencies).toHaveProperty('better-sqlite3');
  expect(packageJson.dependencies).toHaveProperty('tar');
  for (const dependency of [
    '@agentclientprotocol/sdk', '@modelcontextprotocol/client', '@modelcontextprotocol/ext-apps',
    '@tanstack/react-virtual', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-web-links',
    '@xterm/addon-webgl', '@xterm/xterm', 'node-pty', 'npm', 'opencc-js',
  ]) {
    expect(packageJson.dependencies, dependency).not.toHaveProperty(dependency);
    expect(packageJson.devDependencies, dependency).toHaveProperty(dependency);
  }
  expect(packageJson.dependencies).not.toHaveProperty('mermaid');
  expect(packageJson.dependencies).not.toHaveProperty('react');
  expect(packageJson.devDependencies).toHaveProperty('mermaid');
  expect(packageJson.devDependencies).toHaveProperty('react');
});

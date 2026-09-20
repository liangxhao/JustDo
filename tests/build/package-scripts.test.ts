import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const electronBuilderConfig = require('../../electron-builder.config.cjs') as {
  asarUnpack?: string[];
  files?: Array<string | { from: string; filter: string[] }>;
  linux?: { extraResources?: Array<{ from: string; to: string }> };
  win?: { artifactName?: string };
  npmRebuild?: boolean;
};

test('embeds a traceable build identifier in Windows artifacts and packaged resources', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const baseBuilderConfig = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../electron-builder.json'), 'utf8'),
  ) as { extraResources: Array<{ from: string; to: string }> };

  expect(packageJson.scripts.prebuild).toContain('npm run build:info');
  expect(packageJson.scripts['build:info']).toBe('node scripts/generate-build-info.cjs');
  expect(electronBuilderConfig.win?.artifactName).toMatch(
    /^JustDo Setup 2026\.8\.27-[0-9a-f]{8}(?:-dirty)?\.\$\{ext\}$/,
  );
  expect(baseBuilderConfig.extraResources).toContainEqual({
    from: 'resources/build-info.json',
    to: 'build-info.json',
  });
});

test('relies on the npm predist:win lifecycle without invoking it twice', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['predist:win']).toBe(
    'npm run clean:release && npm run openclaw:runtime:win-x64',
  );
  expect(packageJson.scripts['dist:win']).not.toContain('npm run predist:win');
  expect(packageJson.scripts['predist:linux']).toBe(
    'npm run clean:release && npm run openclaw:runtime:linux-x64',
  );
  expect(packageJson.scripts['dist:linux']).toContain('npm run verify:linux-release');
});

test('keeps Electron readiness probes quiet and bounded', () => {
  const devRunner = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/run-electron-dev.cjs'),
    'utf8',
  );

  expect(devRunner).toContain('wait-on -t 120000 -d 20000 --simultaneous 1');
  expect(devRunner).not.toContain('wait-on -v');
});

test('packages Linux launchers that work after installation and without FUSE', () => {
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/electron-builder-hooks.cjs'),
    'utf8',
  );

  expect(builderHooks).toContain('LAUNCHER_PATH=$(readlink -f -- "$0"');
  expect(builderHooks).toContain('libfuse.so.2');
  expect(builderHooks).toContain('--appimage-extract >/dev/null');
  expect(builderHooks).toContain('exec "$CACHE_DIR/AppRun" --justdo-multica-bridge');
  expect(electronBuilderConfig.linux?.extraResources).toContainEqual(
    expect.objectContaining({
      from: 'vendor/openclaw-runtime/current/node_modules',
      to: 'cfmind/node_modules',
    }),
  );
});

test('cleans stale run-scoped providers before standalone Agent startup', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main/main.ts'), 'utf8');

  expect(mainSource).toContain("reason: 'multicaEvaluationModelCleanup'");
  expect(mainSource).toContain('removeAllMulticaEvaluationModels(storedAppConfig)');
  expect(mainSource).not.toContain("reason: 'multicaStandaloneEvaluationModelCleanup'");
});

test('builds the Multica development launcher without coupling it to the renderer build', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['multica:dev-agent']).toBe(
    'node scripts/create-multica-dev-agent.cjs',
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
});

test('uses supported npm target options for OpenClaw runtime dependencies', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/install-openclaw-runtime.cjs'),
    'utf8',
  );

  expect(runtimeInstaller).toContain("'--os'");
  expect(runtimeInstaller).toContain("'--cpu'");
  expect(runtimeInstaller).not.toMatch(/npm_config_(?:target_)?(?:platform|arch)/);
});

test('defines the JSON reader used to validate the downloaded OpenClaw package', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/install-openclaw-runtime.cjs'),
    'utf8',
  );

  expect(runtimeInstaller).toMatch(/function readJsonFile\(filePath\)/);
  expect(runtimeInstaller).toContain(
    "const extractedPackage = readJsonFile(path.join(pkgDir, 'package.json'))",
  );
});

test('keeps an installed OpenClaw runtime frozen unless force install is requested', () => {
  const runtimeInstaller = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/install-openclaw-runtime.cjs'),
    'utf8',
  );
  const bundleScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/bundle-openclaw-gateway.cjs'),
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
    path.resolve(__dirname, '../../scripts/bundle-openclaw-gateway.cjs'),
    'utf8',
  );
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/electron-builder-hooks.cjs'),
    'utf8',
  );

  expect(bundleScript).toContain('resolveAuditEventWriterUrl');
  expect(bundleScript).toContain('dist/audit/audit-event-writer.worker.js');
  expect(builderHooks).toContain('dist/audit/audit-event-writer.worker.js');
});

test('uses a target-aware and runtime-verified Electron-native rebuild', () => {
  const rebuildScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/rebuild-electron-native.cjs'),
    'utf8',
  );
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/electron-builder-hooks.cjs'),
    'utf8',
  );

  expect(electronBuilderConfig.npmRebuild).toBe(false);
  expect(rebuildScript).toContain("'--platform'");
  expect(rebuildScript).toContain("'--arch'");
  expect(rebuildScript).toContain("ELECTRON_RUN_AS_NODE: '1'");
  expect(rebuildScript).toContain("new Database(':memory:')");
  expect(rebuildScript).toContain('Failed to rebuild better-sqlite3 for Electron.');
  expect(builderHooks).toContain('function rebuildElectronNativeModules(context)');
  expect(builderHooks).toContain('rebuildElectronNativeModules(context)');
  expect(builderHooks).toContain('context.electronPlatformName');
  expect(builderHooks).toContain('resolveTargetArch(context)');
  expect(builderHooks).toContain('verifyPackagedNativeModules(context)');
  expect(builderHooks).toContain("'better_sqlite3.node'");
  expect(builderHooks).toContain('Packaged better-sqlite3 failed Electron ABI verification');
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
  expect(packageJson.dependencies).toHaveProperty('npm');
  expect(packageJson.dependencies).toHaveProperty('tar');
  expect(packageJson.dependencies).not.toHaveProperty('mermaid');
  expect(packageJson.dependencies).not.toHaveProperty('react');
  expect(packageJson.devDependencies).toHaveProperty('mermaid');
  expect(packageJson.devDependencies).toHaveProperty('react');
});

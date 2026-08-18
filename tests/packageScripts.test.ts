import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const electronBuilderConfig = require('../electron-builder.config.cjs') as {
  asarUnpack?: string[];
  files?: Array<string | { from: string; filter: string[] }>;
  npmRebuild?: boolean;
};

test('relies on the npm predist:win lifecycle without invoking it twice', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['predist:win']).toBe(
    'npm run clean:release && npm run openclaw:runtime:win-x64',
  );
  expect(packageJson.scripts['dist:win']).not.toContain('npm run predist:win');
});

test('keeps Electron readiness probes quiet and bounded', () => {
  const devRunner = fs.readFileSync(
    path.resolve(__dirname, '../scripts/run-electron-dev.cjs'),
    'utf8',
  );

  expect(devRunner).toContain('wait-on -t 120000 -d 20000 --simultaneous 1');
  expect(devRunner).not.toContain('wait-on -v');
});

test('rewrites and packages the OpenClaw audit writer companion', () => {
  const bundleScript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/bundle-openclaw-gateway.cjs'),
    'utf8',
  );
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../scripts/electron-builder-hooks.cjs'),
    'utf8',
  );

  expect(bundleScript).toContain('resolveAuditEventWriterUrl');
  expect(bundleScript).toContain('dist/audit/audit-event-writer.worker.js');
  expect(builderHooks).toContain('dist/audit/audit-event-writer.worker.js');
});

test('uses a target-aware and runtime-verified Electron-native rebuild', () => {
  const rebuildScript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/rebuild-electron-native.cjs'),
    'utf8',
  );
  const builderHooks = fs.readFileSync(
    path.resolve(__dirname, '../scripts/electron-builder-hooks.cjs'),
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
  expect(builderHooks).toContain('verifyPackagedWindowsNativeModules(context)');
  expect(builderHooks).toContain("'better_sqlite3.node'");
  expect(builderHooks).toContain('Packaged better-sqlite3 failed Electron ABI verification');
});

test('keeps build-only dependencies and diagnostics out of the packaged app', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
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

import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const electronBuilderConfig = require('../electron-builder.config.cjs') as {
  npmRebuild?: boolean;
};

test('relies on the npm predist:win lifecycle without invoking it twice', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['predist:win']).toBe('npm run openclaw:runtime:win-x64');
  expect(packageJson.scripts['dist:win']).not.toContain('npm run predist:win');
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

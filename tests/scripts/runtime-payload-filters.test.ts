import path from 'node:path';
import fs from 'node:fs';
import { expect, test } from 'vitest';

const {
  FileMatcher,
  getMainFileMatchers,
  getNodeModuleFileMatcher,
} = require('app-builder-lib/out/fileMatcher');
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
const config = JSON.parse(fs.readFileSync(path.resolve('electron-builder.json'), 'utf8'));
const root = path.resolve('payload-fixture');
const file = { isDirectory: () => false };

function normalizedBuild() {
  const normalized = doMergeConfigs([structuredClone(config)]);
  const info = {
    config: normalized,
    projectDir: root,
    buildResourcesDir: 'build',
    debugLogger: { isEnabled: false },
  };
  return { normalized, info };
}

test('normalized Windows configuration preserves the application file whitelist', () => {
  const { normalized, info } = normalizedBuild();
  const matchers = getMainFileMatchers(
    root,
    root,
    (value: string) => value.replaceAll('${arch}', 'x64'),
    normalized.win,
    { info },
    path.join(root, 'release'),
    false,
  );
  const filter = matchers[0].createFilter();
  expect(filter(path.join(root, 'package.json'), file)).toBe(true);
  for (const name of [
    '.agent-tasks/audit/package/docs/README.md',
    'vendor/openclaw-runtime/current/gateway-bundle.mjs',
    'src/main/main.ts',
    'cache/python/python-3.12.10-embed-amd64.zip',
    'build/tar/win-resources.tar.zst',
  ]) {
    expect(filter(path.join(root, name), file), name).toBe(false);
  }
});

test('Windows preserves host-native SQLite and production dependency notices', () => {
    const { normalized, info } = normalizedBuild();
    const matcher = getNodeModuleFileMatcher(
      root,
      root,
      (value: string) => value.replaceAll('${arch}', 'x64'),
      normalized.win,
      info,
    );
    const filter = matcher.createFilter();
    expect(
      filter(path.join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), file),
    ).toBe(true);
    for (const dependency of ['better-sqlite3', 'tar', 'ws', 'electron-log', 'electron-updater']) {
      expect(filter(path.join(root, `node_modules/${dependency}/LICENSE`), file)).toBe(true);
    }
});

test.each(['mac', 'linux'])(
  '%s preserves native knowledge through generic resource filters',
  platform => {
    const resource = config[platform].extraResources.find(
      (entry: { from: string }) => entry.from === 'vendor/openclaw-runtime/current',
    );
    const matcher = new FileMatcher(root, root, (value: string) => value, resource.filter);
    const filter = matcher.createFilter();
    for (const name of [
      'README.md',
      'docs/README.md',
      'docs/tests/CHANGELOG.md',
      'skills/example/SKILL.md',
    ]) {
      expect(filter(path.join(root, name), file), name).toBe(true);
    }
    expect(filter(path.join(root, 'docs/tests'), { isDirectory: () => true })).toBe(true);
    expect(filter(path.join(root, 'gateway.asar'), file)).toBe(false);
    for (const extension of ['js', 'css']) {
      for (const encoding of ['br', 'gz']) {
        const asset = `assets/nested/app.${extension}.${encoding}`;
        expect(filter(path.join(root, 'dist/control-ui', asset), file)).toBe(false);
        for (const prefix of ['dist/extensions/fixture', 'docs/control-ui', 'node-runtime']) {
          expect(filter(path.join(root, prefix, asset), file)).toBe(true);
        }
      }
      expect(filter(path.join(root, `dist/control-ui/assets/app.${extension}`), file)).toBe(true);
    }
    expect(filter(path.join(root, 'dist/control-ui/asset-manifest.json'), file)).toBe(true);
    expect(filter(path.join(root, 'dist/control-ui/assets/image.png.gz'), file)).toBe(true);
  },
);

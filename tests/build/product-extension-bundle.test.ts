import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { bundleProductExtension, syncLocalExtensions } = require('../../scripts/openclaw/sync-openclaw-runtime-resources.cjs');

test('stages a self-contained native extension before runtime source pruning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-bundle-fixture-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'fixture-extension', type: 'module', justdo: { bundle: true },
      openclaw: { extensions: ['./index.ts'] },
    }));
    fs.writeFileSync(path.join(source, 'index.ts'), 'export default { id: "fixture-extension" };');
    fs.writeFileSync(path.join(target, 'index.ts'), '// staged source');
    bundleProductExtension(source, target);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).openclaw.extensions)
      .toEqual(['./index.js']);
    expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(false);
    const code = fs.readFileSync(path.join(target, 'index.js'), 'utf8');
    expect(code).toContain('fixture-extension');
    expect(code).not.toMatch(/from ["']\.\.\//);
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^extension-bundle-fixture-/u);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assembles a declared app package without a host-specific source flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-extension-bundle-'));
  try {
    const source = path.join(root, 'plugins/extensions/example');
    const target = path.join(root, 'target');
    const hash = 'a'.repeat(64);
    const built = path.join(root, 'build/app-plugins/packages/example', hash);
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(built, 'app'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ app: { main: 'host.ts' } }));
    fs.writeFileSync(path.join(root, 'build/app-plugins/catalog.json'), JSON.stringify([{ id: 'example', hash }]));
    fs.writeFileSync(path.join(built, 'index.js'), 'export default {id:"example"};');
    fs.writeFileSync(path.join(built, 'app/native.binding.json'), '{"sha256":"native-bytes"}');
    fs.writeFileSync(path.join(target, 'index.ts'), 'stale source');
    fs.mkdirSync(path.join(target, 'node_modules/stale'), { recursive: true });
    fs.writeFileSync(path.join(target, 'node_modules/stale/index.js'), 'stale dependency');
    fs.writeFileSync(path.join(target, '.justdo-extension-assembly.json'), '{"version":2}');

    bundleProductExtension(source, target);

    expect(fs.readFileSync(path.join(target, 'index.js'), 'utf8')).toContain('example');
    expect(fs.readFileSync(path.join(target, 'app/native.binding.json'), 'utf8')).toBe('{"sha256":"native-bytes"}');
    expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.justdo-extension-assembly.json'))).toBe(false);
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^app-extension-bundle-/u);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('syncs app source dependencies from the complete built package without a source lock or npm install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-built-sync-'));
  try {
    const source = path.join(root, 'plugins/extensions/example');
    const runtime = path.join(root, 'runtime');
    const target = path.join(runtime, 'dist/extensions/example');
    const hash = 'b'.repeat(64);
    const built = path.join(root, 'build/app-plugins/packages/example', hash);
    fs.mkdirSync(path.join(source, 'node_modules/source-only'), { recursive: true });
    fs.mkdirSync(path.join(target, 'node_modules/stale'), { recursive: true });
    fs.mkdirSync(path.join(built, 'app'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'example', app: { main: 'host.ts', browser: 'browser.ts' },
      dependencies: { 'uninstalled-build-input': '1.0.0' },
      openclaw: { extensions: ['./index.ts'] },
    }));
    fs.writeFileSync(path.join(source, 'index.ts'), 'unbuilt source');
    fs.writeFileSync(path.join(source, 'node_modules/source-only/index.js'), 'source-only dependency');
    fs.writeFileSync(path.join(target, 'index.ts'), 'stale native source');
    fs.writeFileSync(path.join(target, 'node_modules/stale/index.js'), 'stale runtime dependency');
    fs.writeFileSync(path.join(root, 'build/app-plugins/catalog.json'), JSON.stringify([{ id: 'example', hash }]));
    fs.writeFileSync(path.join(built, 'package.json'), JSON.stringify({
      name: 'example', type: 'module', openclaw: { extensions: ['./index.js'] },
    }));
    fs.writeFileSync(path.join(built, 'openclaw.plugin.json'), '{"id":"example"}');
    fs.writeFileSync(path.join(built, 'index.js'), 'export default {id:"example"};');
    fs.writeFileSync(path.join(built, 'app/native.binding.json'), '{"sha256":"built-native"}');
    fs.writeFileSync(path.join(built, 'app/main.js'), 'export const activate = () => {};');
    fs.writeFileSync(path.join(built, 'app/browser.js'), 'export const activate = () => {};');
    const installProductionDependencies = vi.fn(() => { throw new Error('An app companion must not install source dependencies'); });

    const result = syncLocalExtensions(root, runtime, 'app-built-sync', { installProductionDependencies });

    expect(result.copied).toEqual(['example']);
    expect(installProductionDependencies).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(source, 'package-lock.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).dependencies).toBeUndefined();
    expect(fs.readFileSync(path.join(target, 'index.js'), 'utf8')).toContain('example');
    expect(fs.readFileSync(path.join(target, 'app/native.binding.json'), 'utf8')).toBe('{"sha256":"built-native"}');
    expect(fs.existsSync(path.join(target, 'app/main.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'app/browser.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^app-built-sync-/u);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

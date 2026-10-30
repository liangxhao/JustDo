import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { prepareDevelopmentAppPlugins } from '../../scripts/plugins/prepare-development-app-plugins.mjs';

const { retireAppPlugins } = require('../../scripts/plugins/retired-app-plugins.cjs');
const { syncLocalExtensions } = require('../../scripts/openclaw/sync-openclaw-runtime-resources.cjs');
const { pruneRuntimeExtensions } = require('../../scripts/openclaw/prune-openclaw-runtime.cjs');

const buildRoot = path.resolve('build');
const id = 'removed-capability';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string;
let runtime: string;
let hash: string;
const put = (relative: string, value: unknown) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const target = () => path.join(runtime, 'dist/extensions', id);

beforeEach(() => {
  fs.mkdirSync(buildRoot, { recursive: true });
  root = fs.mkdtempSync(path.join(buildRoot, 'app-plugin-retirement-'));
  runtime = path.join(root, 'runtime');
  const native = 'export default {};\n';
  const manifest = {
    manifestVersion: 1, apiVersion: 1, id, nativePluginId: id, version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' },
    capabilities: [], commands: [], slots: [],
  };
  const contents = {
    'browser.mjs': 'export const register = () => {};',
    'main.mjs': 'export const register = () => ({});',
    'native.binding.json': JSON.stringify({ entry: 'index.js', sha256: digest(native) }),
  };
  const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, digest(bytes)]));
  hash = digest(JSON.stringify({ manifest, files }));
  const artifact = { manifest, hash, files };
  for (const [name, bytes] of Object.entries(contents))
    put(`build/app-plugins/${id}/${hash}/${name}`, bytes);
  put(`build/app-plugins/${id}/${hash}/app.artifact.json`, artifact);
  const pkg = `build/app-plugins/packages/${id}/${hash}`;
  put(`${pkg}/index.js`, native);
  put(`${pkg}/package.json`, { name: id, type: 'module', openclaw: { extensions: ['./index.js'] } });
  put(`${pkg}/openclaw.plugin.json`, { id });
  fs.cpSync(path.join(root, `build/app-plugins/${id}/${hash}`), path.join(root, `${pkg}/app`), { recursive: true });
  fs.mkdirSync(path.dirname(target()), { recursive: true });
  fs.cpSync(path.join(root, pkg), target(), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins/extensions'), { recursive: true });
  put('build/app-plugins/catalog.json', []);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(path.dirname(root)).toBe(buildRoot);
  expect(path.basename(root)).toMatch(/^app-plugin-retirement-/u);
  fs.rmSync(root, { recursive: true, force: true });
});

it('withdraws only the removed source package before development startup and keeps its build receipt', () => {
  put('runtime/dist/extensions/other-capability/index.js', 'other native code');
  put('runtime/dist/extensions/external-capability/app/app.artifact.json', { hash, manifest: { id: 'external-capability' } });
  const findRunningGateways = vi.fn(() => []);
  expect(prepareDevelopmentAppPlugins({ repoRoot: root, runtimeRoot: runtime, findRunningGateways }))
    .toEqual({ prepared: [], removed: [id] });
  expect(fs.existsSync(target())).toBe(false);
  expect(fs.readFileSync(path.join(runtime, 'dist/extensions/other-capability/index.js'), 'utf8'))
    .toBe('other native code');
  expect(fs.existsSync(path.join(runtime, 'dist/extensions/external-capability/app/app.artifact.json'))).toBe(true);
  expect(fs.existsSync(path.join(root, `build/app-plugins/${id}/${hash}/app.artifact.json`))).toBe(true);
  expect(findRunningGateways).toHaveBeenCalled();
});

it('keeps a source or current catalog identity without inferring a retirement', () => {
  const findRunningGateways = vi.fn(() => []);
  put(`plugins/extensions/${id}/package.json`, { name: id });
  expect(retireAppPlugins(root, runtime, { findRunningGateways })).toEqual([]);
  fs.rmSync(path.join(root, `plugins/extensions/${id}`), { recursive: true });
  put('build/app-plugins/catalog.json', [{ id, hash }]);
  expect(retireAppPlugins(root, runtime, { findRunningGateways })).toEqual([]);
  expect(findRunningGateways).not.toHaveBeenCalled();
  expect(fs.existsSync(target())).toBe(true);
});

it.each(['active', 'unreadable', 'invalid'] as const)(
  'preserves every byte when Gateway process ownership is %s', state => {
    const before = fs.readFileSync(path.join(target(), 'index.js'));
    const findRunningGateways = () => {
      if (state === 'unreadable') throw new Error('process inventory unavailable');
      return state === 'active' ? [12345] : undefined;
    };
    expect(() => retireAppPlugins(root, runtime, { findRunningGateways })).toThrow();
    expect(fs.readFileSync(path.join(target(), 'index.js'))).toEqual(before);
  },
);

it('retains a same-ID custom replacement and never follows a companion directory link', () => {
  put(`runtime/dist/extensions/${id}/custom.txt`, 'third-party addition');
  const findRunningGateways = vi.fn(() => []);
  expect(retireAppPlugins(root, runtime, { findRunningGateways })).toEqual([]);
  fs.unlinkSync(path.join(target(), 'custom.txt'));
  fs.rmSync(path.join(target(), 'app'), { recursive: true });
  const companion = path.join(root, `build/app-plugins/${id}/${hash}`);
  fs.symlinkSync(companion, path.join(target(), 'app'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(retireAppPlugins(root, runtime, { findRunningGateways })).toEqual([]);
  expect(fs.existsSync(path.join(companion, 'browser.mjs'))).toBe(true);
  expect(fs.existsSync(target())).toBe(true);
  expect(findRunningGateways).not.toHaveBeenCalled();
});

it('rechecks exact bytes after process discovery before removing a package', () => {
  expect(() => retireAppPlugins(root, runtime, {
    findRunningGateways: () => {
      put(`runtime/dist/extensions/${id}/index.js`, '// replaced while discovering processes');
      return [];
    },
  })).toThrow('changed before removal');
  expect(fs.readFileSync(path.join(target(), 'index.js'), 'utf8'))
    .toBe('// replaced while discovering processes');
});

it('reconciles retired packages through the generic resource sync and pruning entry points', () => {
  const findRunningGateways = vi.fn(() => []);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const sync = syncLocalExtensions(root, runtime, 'test', { findRunningGateways });
  expect(sync.copied).toEqual([]);
  expect(sync.removed).toEqual([id]);
  const pkg = path.join(root, `build/app-plugins/packages/${id}/${hash}`);
  fs.cpSync(pkg, target(), { recursive: true });
  put('package.json', { openclaw: { version: 'fixture' } });
  put('plugins/extensions/prune-policy.json', { openclawVersion: 'fixture', keep: ['other-capability'], remove: [] });
  put('runtime/dist/extensions/other-capability/index.js', 'other native code');
  const stats = { extensionDirsRemoved: 0, bytesFreed: 0 };
  const pruned = pruneRuntimeExtensions(runtime, stats, { repoRoot: root, label: 'test', findRunningGateways });
  expect(pruned.removed).toEqual([id]);
  expect(stats.extensionDirsRemoved).toBe(1);
  expect(stats.bytesFreed).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(runtime, 'dist/extensions/other-capability/index.js'), 'utf8'))
    .toBe('other native code');
  log.mockRestore();
});

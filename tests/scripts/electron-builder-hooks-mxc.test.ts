import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const { verifyMxcArtifactEntryPaths } = require('../../scripts/packaging/electron-builder-hooks.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const sdk = 'node_modules/@microsoft/mxc-sdk';
const prefix = 'cfmind/dist/extensions/mxc/';
const target = { os: 'win32', cpu: 'x64' };

function fixture(layout: 'nested' | 'hoisted') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-archive-'));
  roots.push(root);
  const plugin = path.join(root, 'dist/extensions/mxc');
  const ptyRoot = layout === 'nested' ? `${sdk}/node_modules/node-pty` : 'node_modules/node-pty';
  const entries = new Set([
    'dist/index.js', 'dist/mxc-spawn-launcher.mjs', 'package.json', 'openclaw.plugin.json',
    `${sdk}/bin/x64/wxc-exec.exe`, `${sdk}/bin/x64/wxc-host-prep.exe`,
    `${sdk}/dist/index.js`, `${sdk}/LICENSE.md`, `${sdk}/package.json`,
  ].map(file => prefix + file));
  fs.mkdirSync(path.join(plugin, sdk), { recursive: true });
  fs.writeFileSync(path.join(plugin, sdk, 'package.json'), JSON.stringify({
    name: '@microsoft/mxc-sdk', version: '0.9.0', dependencies: { 'node-pty': '^1.2.0-beta.12' },
  }));
  const addPty = (relative: string) => {
    fs.mkdirSync(path.join(plugin, relative), { recursive: true });
    fs.writeFileSync(path.join(plugin, relative, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }));
    entries.add(`${prefix}${relative}/package.json`);
    entries.add(`${prefix}${relative}/prebuilds/win32-x64/conpty.node`);
  };
  addPty(ptyRoot);
  return { root, plugin, ptyRoot, entries, addPty,
    verify: () => verifyMxcArtifactEntryPaths(entries, 'cfmind/', target, 'fixture', root) };
}

test.each(['nested', 'hoisted'] as const)('accepts the complete locked SDK with %s node-pty', layout => {
  expect(fixture(layout).verify).not.toThrow();
});

test('rejects orphaned prebuilds without package identity', () => {
  const value = fixture('hoisted');
  value.entries.delete(`${prefix}${value.ptyRoot}/package.json`);
  expect(value.verify).toThrow(/Missing/);
});

test('does not bypass an incomplete nested dependency with a complete hoisted package', () => {
  const value = fixture('nested');
  value.entries.delete(`${prefix}${value.ptyRoot}/prebuilds/win32-x64/conpty.node`);
  value.addPty('node_modules/node-pty');
  expect(value.verify).toThrow(/Missing/);
});

test('does not bypass malformed nested metadata with a complete hoisted package', () => {
  const value = fixture('nested');
  fs.writeFileSync(path.join(value.plugin, value.ptyRoot, 'package.json'), JSON.stringify({ name: 'other', version: '1.2.0-beta.15' }));
  value.addPty('node_modules/node-pty');
  expect(value.verify).toThrow(/identity mismatch/);
});

test.each([
  ['0.8.0', '1.2.0-beta.15'], ['0.9.0', '0.1.0'],
])('rejects incompatible SDK %s or node-pty %s metadata', (sdkVersion, ptyVersion) => {
  const value = fixture('hoisted');
  fs.writeFileSync(path.join(value.plugin, sdk, 'package.json'), JSON.stringify({
    name: '@microsoft/mxc-sdk', version: sdkVersion, dependencies: { 'node-pty': '^1.2.0-beta.12' },
  }));
  fs.writeFileSync(path.join(value.plugin, value.ptyRoot, 'package.json'), JSON.stringify({ name: 'node-pty', version: ptyVersion }));
  expect(value.verify).toThrow(/identity mismatch/);
});

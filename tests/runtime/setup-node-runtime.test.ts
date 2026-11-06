import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import lock from '../../src/shared/openclaw/nodeRuntime.json';

const { verifyNodeRuntime, prepareNodeRuntime, copyNodeRuntime, __testing: { inventory } } =
  require('../../scripts/runtime/setup-node-runtime.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-proof-'));
  roots.push(root);
  const target = lock.targets['win-x64'];
  for (const relative of ['node.exe', 'LICENSE', `${target.npmBin}/npm-cli.js`, `${target.npmBin}/npx-cli.js`]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  fs.writeFileSync(path.join(root, 'node-runtime-manifest.json'), JSON.stringify({
    version: lock.version, target: 'win-x64', archive: target.archive,
    archiveSha256: target.sha256, executable: target.executable, files: inventory(root),
  }));
  return root;
}

test('rejects changed npm dependency bytes and unexpected files in the closed distribution', () => {
  const root = fixture();
  expect(() => verifyNodeRuntime(root, 'win-x64')).not.toThrow();
  fs.writeFileSync(path.join(root, 'unexpected.js'), 'changed');
  expect(() => verifyNodeRuntime(root, 'win-x64')).toThrow(/unexpected files/);
  fs.unlinkSync(path.join(root, 'unexpected.js'));
  fs.appendFileSync(path.join(root, lock.targets['win-x64'].npmBin, 'npm-cli.js'), 'changed');
  expect(() => verifyNodeRuntime(root, 'win-x64')).toThrow(/changed/);
});

test('admits identical file proofs in a different manifest key order', () => {
  const root = fixture();
  const file = path.join(root, 'node-runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.files = Object.fromEntries(Object.entries(manifest.files).reverse());
  fs.writeFileSync(file, JSON.stringify(manifest));
  expect(() => verifyNodeRuntime(root, 'win-x64')).not.toThrow();
  fs.unlinkSync(path.join(root, 'LICENSE'));
  expect(() => verifyNodeRuntime(root, 'win-x64')).toThrow(/incomplete/);
});

test('refuses missing offline archives without fetching at runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-offline-'));
  roots.push(root);
  await expect(prepareNodeRuntime('win-x64', { repoRoot: root })).rejects.toThrow(/Missing offline Node archive/);
});

test('refuses a cached archive whose bytes do not match the source lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-cache-'));
  roots.push(root);
  const cache = path.join(root, 'cache/node', lock.targets['win-x64'].archive);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, 'wrong archive');
  await expect(prepareNodeRuntime('win-x64', { repoRoot: root })).rejects.toThrow(/checksum mismatch/);
});

test.skipIf(process.platform === 'win32')('preserves official POSIX npm links when staging and archiving Node', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-posix-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const target = lock.targets['mac-x64'];
  for (const relative of [target.executable, 'LICENSE', `${target.npmBin}/npm-cli.js`, `${target.npmBin}/npx-cli.js`]) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(source, 'bin/npm'));
  fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(source, 'bin/npx'));
  fs.writeFileSync(path.join(source, 'node-runtime-manifest.json'), JSON.stringify({
    version: lock.version, target: 'mac-x64', archive: target.archive,
    archiveSha256: target.sha256, executable: target.executable, files: inventory(source),
  }));
  const staged = path.join(root, 'staged');
  copyNodeRuntime(source, staged, 'mac-x64');
  expect(fs.readlinkSync(path.join(staged, 'bin/npm'))).toBe('../lib/node_modules/npm/bin/npm-cli.js');
  const tar = require('tar');
  const archive = path.join(root, 'node.tar');
  tar.c({ cwd: staged, file: archive, sync: true, follow: false }, fs.readdirSync(staged));
  const extracted = path.join(root, 'extracted');
  fs.mkdirSync(extracted);
  await tar.x({ cwd: extracted, file: archive });
  expect(() => verifyNodeRuntime(extracted, 'mac-x64')).not.toThrow();
});

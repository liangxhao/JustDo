import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const { REQUIRED_APPLICATION_LICENSE_SCOPES, createApplicationLicensePlugin, verifyApplicationLicenseAssets } =
  require('../../scripts/packaging/application-license-assets.cjs');
const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', platformDescriptor);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(root: string, relative: string, bytes: string | Buffer) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'application-license 中文 空格-'));
  roots.push(repoRoot);
  const files = [
    write(repoRoot, 'node_modules/top/package.json', JSON.stringify({ name: 'top', version: '1.0.0', license: 'MIT' })),
    write(repoRoot, 'node_modules/top/esm/package.json', '{"type":"module"}'),
    write(repoRoot, 'node_modules/top/esm/index.js', 'export const value = 42;'),
    write(repoRoot, 'node_modules/top/LICENSE', Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0x41])),
    write(repoRoot, 'node_modules/top/NOTICE.txt', 'notice\r\n'),
    write(repoRoot, 'node_modules/top/licenses/vendor/COPYING', 'third party terms\n'),
    write(repoRoot, 'node_modules/top/node_modules/transitive/package.json', JSON.stringify({ name: 'transitive', version: '2.0.0', license: 'BSD-3-Clause' })),
    write(repoRoot, 'node_modules/top/node_modules/transitive/index.js', 'export const nested = true;'),
    write(repoRoot, 'node_modules/top/node_modules/transitive/THIRD_PARTY_NOTICES.md', 'nested terms\n'),
  ];
  const moduleIds = [files[2], files[7] + '?commonjs-proxy', '\0' + files[2] + '?commonjs-es-import', '\0commonjsHelpers.js'];
  for (const scope of REQUIRED_APPLICATION_LICENSE_SCOPES) emit(repoRoot, scope, moduleIds);
  return { repoRoot, files, moduleIds, assets: path.join(repoRoot, 'build/application-licenses') };
}

function emit(repoRoot: string, scope: string, moduleIds: string[]) {
  const directory = path.join(repoRoot, scope === 'renderer' ? 'dist' : 'dist-electron');
  const fileName = scope + '.js';
  write(directory, fileName, 'bundled ' + scope);
  const modules = Object.fromEntries(moduleIds.map(id => [id, { renderedLength: 0 }]));
  createApplicationLicensePlugin({ repoRoot, scope }).writeBundle({ dir: directory }, {
    [fileName]: { type: 'chunk', code: 'bundled ' + scope, modules },
    [fileName + '.map']: { type: 'asset', source: '{}' },
  });
}

function packagedCopy(repoRoot: string, assets: string) {
  const packagedRoot = path.join(repoRoot, 'build/packaged-legal');
  fs.cpSync(assets, packagedRoot, { recursive: true, filter: source => path.basename(source) !== 'source-proof.json' });
  return packagedRoot;
}

test('collects actual transitive owners, package metadata and original legal bytes, including zero-length module wrappers', () => {
  const { repoRoot, files, assets } = fixture();
  const result = verifyApplicationLicenseAssets({ repoRoot });
  expect(result.scopes).toBe(8);
  expect(result.packages).toBe(16);
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'renderer/manifest.json'), 'utf8'));
  expect(manifest.packages.map((entry: { name: string }) => entry.name).sort()).toEqual(['top', 'transitive']);
  const top = manifest.packages.find((entry: { name: string }) => entry.name === 'top');
  expect(top.files.map((entry: { path: string }) => entry.path)).toEqual(['LICENSE', 'NOTICE.txt', 'licenses/vendor/COPYING', 'package.json']);
  expect(fs.readFileSync(path.join(assets, 'renderer/packages', top.id, 'LICENSE'))).toEqual(fs.readFileSync(files[3]));
  expect(verifyApplicationLicenseAssets({ repoRoot, packagedRoot: packagedCopy(repoRoot, assets) })).toEqual(result);
});

test('requires every build scope and refuses unexpected scope sidecars', () => {
  const { repoRoot, assets } = fixture();
  fs.renameSync(path.join(assets, 'preload'), path.join(assets, 'stale-preload'));
  expect(() => verifyApplicationLicenseAssets({ repoRoot })).toThrow(/scopes/);
});

test('cannot silently omit a missing dependency module from its bundle receipt', () => {
  const { repoRoot } = fixture();
  expect(() => emit(repoRoot, 'renderer', [path.join(repoRoot, 'node_modules/missing/index.js')])).toThrow(/module source is missing/);
});

test('rejects stale output bytes and changed original transitive notices', () => {
  const { repoRoot, files, moduleIds } = fixture();
  write(repoRoot, 'dist/renderer.js', 'unrecorded output');
  expect(() => verifyApplicationLicenseAssets({ repoRoot })).toThrow(/output changed/);
  emit(repoRoot, 'renderer', moduleIds);
  fs.appendFileSync(files[8], 'changed original');
  expect(() => verifyApplicationLicenseAssets({ repoRoot })).toThrow(/source changed/);
});

test.each(['missing', 'extra', 'changed', 'private-proof'])('rejects a packaged legal tree with %s bytes or sidecars', kind => {
  const { repoRoot, assets } = fixture();
  const packagedRoot = packagedCopy(repoRoot, assets);
  const manifest = JSON.parse(fs.readFileSync(path.join(packagedRoot, 'main/manifest.json'), 'utf8'));
  const file = path.join(packagedRoot, 'main/packages', manifest.packages[0].id, manifest.packages[0].files[0].path);
  if (kind === 'missing') fs.unlinkSync(file);
  if (kind === 'changed') fs.appendFileSync(file, 'changed');
  if (kind === 'extra') write(packagedRoot, 'main/unexpected.txt', 'stale');
  if (kind === 'private-proof') write(packagedRoot, 'main/source-proof.json', '{}');
  expect(() => verifyApplicationLicenseAssets({ repoRoot, packagedRoot })).toThrow(/Packaged application legal metadata/);
});

test('rebuilding one scope replaces its old package graph while preserving sibling scopes', () => {
  const { repoRoot, assets } = fixture();
  const oldMain = fs.readFileSync(path.join(assets, 'main/manifest.json'));
  emit(repoRoot, 'renderer', []);
  const renderer = JSON.parse(fs.readFileSync(path.join(assets, 'renderer/manifest.json'), 'utf8'));
  expect(renderer.packages).toEqual([]);
  expect(fs.readdirSync(path.join(assets, 'renderer')).sort()).toEqual(['manifest.json', 'source-proof.json']);
  expect(fs.readFileSync(path.join(assets, 'main/manifest.json'))).toEqual(oldMain);
  expect(verifyApplicationLicenseAssets({ repoRoot }).packages).toBe(14);
});

test.each(['EPERM', 'EBUSY', 'EACCES'])('retries a transient Windows %s while publishing the complete license scope', code => {
  const { repoRoot, assets } = fixture();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const denial = Object.assign(new Error('transient rename denial'), { code });
  const rename = fs.renameSync;
  let attempts = 0;
  const publish = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (destination === path.join(assets, 'renderer') && attempts++ === 0) throw denial;
    return rename(source, destination);
  });
  const wait = vi.spyOn(Atomics, 'wait');

  emit(repoRoot, 'renderer', []);

  expect(attempts).toBe(2);
  expect(wait.mock.calls.map(call => call[3])).toEqual([50]);
  expect(fs.readdirSync(assets).sort()).toEqual([...REQUIRED_APPLICATION_LICENSE_SCOPES].sort());
  expect(verifyApplicationLicenseAssets({ repoRoot }).packages).toBe(14);
  expect(publish).toHaveBeenCalledTimes(2);
});

test.each([
  { platform: 'win32', code: 'EPERM', attempts: 6, delays: [50, 100, 150, 200, 250] },
  { platform: 'win32', code: 'ENOSPC', attempts: 1, delays: [] },
  { platform: 'linux', code: 'EPERM', attempts: 1, delays: [] },
])('blocks and cleans up a $platform publication failure with $code after $attempts attempts', ({ platform, code, attempts, delays }) => {
  const { repoRoot, assets } = fixture();
  const sibling = fs.readFileSync(path.join(assets, 'main/manifest.json'));
  Object.defineProperty(process, 'platform', { value: platform });
  const denial = Object.assign(new Error('publication failed'), { code });
  const publish = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw denial; });
  const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');

  let publicationError;
  try { emit(repoRoot, 'renderer', []); } catch (error) { publicationError = error; }

  expect(publicationError).toBe(denial);
  expect(publish).toHaveBeenCalledTimes(attempts);
  expect(wait.mock.calls.map(call => call[3])).toEqual(delays);
  expect(fs.readdirSync(assets).sort()).toEqual(REQUIRED_APPLICATION_LICENSE_SCOPES.filter((scope: string) => scope !== 'renderer').sort());
  expect(fs.readFileSync(path.join(assets, 'main/manifest.json'))).toEqual(sibling);
  expect(() => verifyApplicationLicenseAssets({ repoRoot })).toThrow(/scopes/);
});

test('revalidates owned build paths before a Windows publication retry', () => {
  const { repoRoot, assets } = fixture();
  const external = path.join(repoRoot, 'external-preserved');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'sentinel'), 'preserved');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const publish = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    fs.symlinkSync(external, path.join(assets, 'renderer'), platformDescriptor.value === 'win32' ? 'junction' : 'dir');
    throw Object.assign(new Error('transient rename denial'), { code: 'EPERM' });
  });
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');

  expect(() => emit(repoRoot, 'renderer', [])).toThrow(/must not be a link/);

  expect(publish).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('preserved');
  expect(fs.readdirSync(assets).some(file => file.endsWith('.tmp'))).toBe(false);
});

test('records packages that publish only license metadata explicitly instead of inventing notice text', () => {
  const { repoRoot, assets } = fixture();
  const module = write(repoRoot, 'node_modules/no-notice/index.js', 'export const value = 1;');
  write(repoRoot, 'node_modules/no-notice/package.json', JSON.stringify({ name: 'no-notice', version: '1.0.0', license: 'MIT' }));
  emit(repoRoot, 'renderer', [module]);
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'renderer/manifest.json'), 'utf8'));
  expect(manifest.packages[0]).toMatchObject({ name: 'no-notice', version: '1.0.0', license: 'MIT', noSeparateLegalFiles: true });
  expect(manifest.packages[0].files.map((file: { path: string }) => file.path)).toEqual(['package.json']);
  expect(() => verifyApplicationLicenseAssets({ repoRoot })).not.toThrow();
});

test('cannot replace a build scope through a directory link', () => {
  const { repoRoot, assets, moduleIds } = fixture();
  const external = path.join(repoRoot, 'external-preserved');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'sentinel'), 'preserved');
  fs.rmSync(path.join(assets, 'renderer'), { recursive: true });
  fs.symlinkSync(external, path.join(assets, 'renderer'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => emit(repoRoot, 'renderer', moduleIds)).toThrow(/must not be a link/);
  expect(fs.readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('preserved');
});

test('rejects a nested junction ancestor before creating or replacing scope assets', () => {
  const { repoRoot } = fixture();
  const external = path.join(repoRoot, 'preserved');
  fs.mkdirSync(external);
  const link = path.join(repoRoot, 'build/redirect');
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const plugin = createApplicationLicensePlugin({ repoRoot, scope: 'renderer', outputRoot: path.join(link, 'licenses') });
  expect(() => plugin.writeBundle({ dir: path.join(repoRoot, 'dist') }, { 'renderer.js': { type: 'chunk', modules: {} } })).toThrow(/must not be a link/);
  expect(fs.readdirSync(external)).toEqual([]);
});

test('refuses legal metadata links that point outside the physical dependency owner', () => {
  const { repoRoot, moduleIds } = fixture();
  const external = write(repoRoot, 'outside/secret.txt', 'unrelated source');
  const license = path.join(repoRoot, 'node_modules/top/NOTICE_EXTERNAL');
  fs.mkdirSync(path.dirname(license), { recursive: true });
  // Directory junctions work without developer mode on Windows.
  fs.symlinkSync(path.dirname(external), license, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => emit(repoRoot, 'renderer', moduleIds)).toThrow(/escapes its package/);
  expect(fs.readFileSync(external, 'utf8')).toBe('unrelated source');
});

test('keeps a legal directory file named source-proof.json while excluding only private scope proofs', () => {
  const { repoRoot, assets, moduleIds } = fixture();
  const source = write(repoRoot, 'node_modules/top/NOTICE/source-proof.json', 'original upstream notice');
  for (const scope of REQUIRED_APPLICATION_LICENSE_SCOPES) emit(repoRoot, scope, moduleIds);
  const packagedRoot = packagedCopy(repoRoot, assets);
  // The builder's exclusion is one level deep; nested legal filenames remain public.
  for (const scope of REQUIRED_APPLICATION_LICENSE_SCOPES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(assets, scope, 'manifest.json'), 'utf8'));
    const top = manifest.packages.find((entry: { name: string }) => entry.name === 'top');
    fs.copyFileSync(source, path.join(packagedRoot, scope, 'packages', top.id, 'NOTICE/source-proof.json'));
  }
  expect(() => verifyApplicationLicenseAssets({ repoRoot, packagedRoot })).not.toThrow();
});

test('recognizes real dependency paths when node_modules is a junction to a differently named store', () => {
  const { repoRoot } = fixture();
  const physical = path.join(repoRoot, 'dependency-store');
  fs.renameSync(path.join(repoRoot, 'node_modules'), physical);
  fs.symlinkSync(physical, path.join(repoRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const actualId = path.join(physical, 'top/esm/index.js');
  for (const scope of REQUIRED_APPLICATION_LICENSE_SCOPES) emit(repoRoot, scope, [actualId]);
  expect(verifyApplicationLicenseAssets({ repoRoot }).packages).toBe(8);
});

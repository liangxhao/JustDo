import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  restrictCredentialDirectory,
  restrictCredentialFile,
} from '../openclaw/config/models/providerSecretFile';
import {
  copyRelocationFiles,
  verifySourceManifest,
} from './relocationFiles';

vi.mock('../openclaw/config/models/providerSecretFile', () => ({
  restrictCredentialDirectory: vi.fn(),
  restrictCredentialFile: vi.fn(),
}));
const fixtures: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-relocation-files-'));
  fixtures.push(root);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  return { root, source, target };
}
function file(root: string, name: string, value: string) {
  const destination = path.join(root, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, value);
  return destination;
}

test('copies ordinary entries and skips protected top-level directories without modifying the source', async () => {
  const { source, target } = fixture();
  file(source, 'openclaw/state/role.md', 'role fixture');
  file(source, 'account/user.json', 'private fixed fixture');
  file(source, 'outbound-header-proxy/config.json', 'fixed policy');
  file(source, 'outbound-header-proxy/certs/ca.pem', 'certificate fixture');
  file(source, 'storage-location.json', 'control fixture');
  fs.mkdirSync(path.join(source, 'empty'));

  const manifest = await copyRelocationFiles({
    sourceRoot: source,
    targetRoot: target,
  });

  expect(fs.readFileSync(path.join(target, 'openclaw/state/role.md'), 'utf8')).toBe('role fixture');
  expect(fs.readFileSync(path.join(source, 'account/user.json'), 'utf8')).toBe(
    'private fixed fixture',
  );
  expect(fs.existsSync(path.join(target, 'account'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'storage-location.json'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'outbound-header-proxy'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'empty'))).toBe(true);
  expect(restrictCredentialDirectory).toHaveBeenCalledWith(target, { replaceWindowsAccess: true });
  // No per-file or per-child-directory ACL subprocesses are needed: all target
  // objects are new and inherit the restricted Windows root, never source ACLs.
  expect(restrictCredentialFile).not.toHaveBeenCalled();
  expect(
    vi.mocked(restrictCredentialDirectory).mock.calls.every(([directory]) => directory === target),
  ).toBe(true);
  if (process.platform !== 'win32') {
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(target, 'openclaw')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(target, 'openclaw/state/role.md')).mode & 0o777).toBe(0o600);
  }
  await expect(verifySourceManifest(manifest)).resolves.toBeUndefined();
});

test('publishes no file contents if the target root cannot be protected first', async () => {
  const { source, target } = fixture();
  file(source, 'private.json', 'private fixture');
  vi.mocked(restrictCredentialDirectory).mockImplementationOnce(() => {
    throw new Error('ACL unavailable');
  });

  await expect(copyRelocationFiles({ sourceRoot: source, targetRoot: target })).rejects.toThrow(
    'ACL unavailable',
  );
  expect(fs.readdirSync(target)).toEqual([]);
  expect(fs.readFileSync(path.join(source, 'private.json'), 'utf8')).toBe('private fixture');
});

test('substitutes only explicit native snapshots and tolerates native-owned heartbeat changes in excluded families', async () => {
  const { root, source, target } = fixture();
  const native = file(source, 'openclaw/state/state.sqlite', 'live native database');
  file(source, 'openclaw/state/state.sqlite-wal', 'live wal');
  file(source, 'openclaw/state/config.json', 'static config');
  const snapshot = file(root, 'native-snapshots/state.sqlite', 'verified native snapshot');

  const manifest = await copyRelocationFiles({
    sourceRoot: source,
    targetRoot: target,
    replaceFiles: new Map([['openclaw/state/state.sqlite', snapshot]]),
    excludeRelativePaths: ['openclaw/state/state.sqlite', 'openclaw/state/state.sqlite-wal'],
  });

  expect(fs.readFileSync(path.join(target, 'openclaw/state/state.sqlite'), 'utf8')).toBe(
    'verified native snapshot',
  );
  expect(fs.existsSync(path.join(target, 'openclaw/state/state.sqlite-wal'))).toBe(false);
  expect(
    manifest.entries.find(entry => entry.relativePath === 'openclaw/state/state.sqlite')
      ?.provenance,
  ).toEqual({ snapshotPath: snapshot });
  fs.appendFileSync(native, 'heartbeat');
  await expect(verifySourceManifest(manifest)).resolves.toBeUndefined();
});

test('refuses new source entries before activation', async () => {
  const { source, target } = fixture();
  file(source, 'role.md', 'original');

  const manifest = await copyRelocationFiles({ sourceRoot: source, targetRoot: target });
  file(source, 'new.md', 'late writer');
  await expect(verifySourceManifest(manifest)).rejects.toThrow();

  expect(fs.readFileSync(path.join(source, 'role.md'), 'utf8')).toBe('original');
  expect(fs.readFileSync(path.join(source, 'new.md'), 'utf8')).toBe('late writer');
});

test('detects a truncated destination before returning the completed copy', async () => {
  const { source, target } = fixture();
  file(source, 'role.md', 'original');
  const opendir = fsp.opendir;
  vi.spyOn(fsp, 'opendir').mockImplementation(async (directory, options) => {
    if (directory === target) file(target, 'role.md', 'short');
    return opendir(directory, options);
  });
  await expect(copyRelocationFiles({ sourceRoot: source, targetRoot: target })).rejects.toThrow();
});

test('preserves a destination file created before its exclusive copy starts', async () => {
  const { source, target } = fixture();
  file(source, 'a.txt', 'first');
  file(source, 'b.txt', 'second');

  const open = fsp.open;
  vi.spyOn(fsp, 'open').mockImplementation(async (filename, flags, mode) => {
    if (filename === path.join(target, 'b.txt') && flags === 'wx')
      file(target, 'b.txt', 'preserve existing file');
    return open(filename, flags, mode);
  });
  await expect(copyRelocationFiles({ sourceRoot: source, targetRoot: target }))
    .rejects.toMatchObject({ code: 'EEXIST' });

  expect(fs.readFileSync(path.join(target, 'b.txt'), 'utf8')).toBe('preserve existing file');
  expect(fs.readFileSync(path.join(source, 'b.txt'), 'utf8')).toBe('second');
});

test('rejects an unrelated junction without following it', async () => {
  const { root, source, target } = fixture();
  const outside = file(root, 'outside/data.txt', 'outside');
  fs.symlinkSync(path.dirname(outside), path.join(source, 'linked'), 'junction');
  await expect(copyRelocationFiles({ sourceRoot: source, targetRoot: target })).rejects.toThrow();
});

test('copies static hardlinks as independent files on the destination', async () => {
  const { source, target } = fixture();
  const first = 'openclaw/state/extensions/example/notes.txt';
  const second = 'hardlinked-notes.txt';
  fs.linkSync(file(source, first, 'installed bytes'), path.join(source, second));

  const manifest = await copyRelocationFiles({ sourceRoot: source, targetRoot: target });

  await expect(verifySourceManifest(manifest)).resolves.toBeUndefined();
  expect(fs.statSync(path.join(source, first)).nlink).toBe(2);
  for (const relative of [first, second]) {
    expect(fs.readFileSync(path.join(target, relative), 'utf8')).toBe('installed bytes');
    expect(fs.statSync(path.join(target, relative)).nlink).toBe(1);
  }
});

test('honors cancellation without publishing a complete manifest or deleting source files', async () => {
  const { source, target } = fixture();
  file(source, 'role.md', 'original');
  const controller = new AbortController();
  controller.abort();
  await expect(
    copyRelocationFiles({ sourceRoot: source, targetRoot: target, signal: controller.signal }),
  ).rejects.toThrow();
  expect(fs.readFileSync(path.join(source, 'role.md'), 'utf8')).toBe('original');
});

test('leaves the top-level upgrade backup on its original drive without inspecting its contents', async () => {
  const { root, source, target } = fixture();
  const outside = path.dirname(file(root, 'runtime/outside.txt', 'runtime'));
  const original = file(source, 'backups/archive.txt', 'archived files');
  file(source, 'account/private.sqlite', 'fixed data');
  fs.symlinkSync(outside, path.join(source, 'backups', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  file(source, 'documents/backups/report.txt', 'ordinary project file');

  const manifest = await copyRelocationFiles({
    sourceRoot: source,
    targetRoot: target,
    replaceFiles: new Map([
      ['backups/archive.txt', path.join(root, 'unused-snapshot')],
      ['account/private.sqlite', path.join(root, 'unused-fixed-snapshot')],
    ]),
  });

  fs.appendFileSync(original, ' that can change independently');
  await expect(verifySourceManifest(manifest)).resolves.toBeUndefined();
  expect(fs.existsSync(path.join(target, 'backups'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'account'))).toBe(false);
  expect(fs.readFileSync(path.join(target, 'documents/backups/report.txt'), 'utf8')).toBe('ordinary project file');
  expect(fs.readFileSync(original, 'utf8')).toBe('archived files that can change independently');
});

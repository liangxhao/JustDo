import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { cleanRelocationSource } from './relocationCleanup';
import { type RelocationCleanupKind, writeRelocationCleanupReceipt } from './relocationCleanupReceipt';
import { relocationPhysicalIdentity } from './relocationFiles';
import {
  type RelocationJournal,
  RelocationStage,
  StorageRelocationFile,
  writeRelocationJournal,
  writeStorageLocator,
  writeStorageRootIdentity,
} from './relocationState';

vi.mock('../openclaw/config/models/providerSecretFile', () => ({
  restrictCredentialDirectory: vi.fn(),
  restrictCredentialFile: vi.fn(),
}));

const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(targetIsActive = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relocation-cleanup-'));
  fixtures.push(root);
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(targetRoot);
  const profileId = randomUUID();
  const sourceRootId = randomUUID();
  const targetRootId = randomUUID();
  writeStorageRootIdentity(sourceRoot, { version: 1, profileId, rootId: sourceRootId });
  writeStorageRootIdentity(targetRoot, { version: 1, profileId, rootId: targetRootId });
  writeStorageLocator(sourceRoot, {
    version: 1, profileId,
    revision: targetIsActive ? 2 : 1,
    activeRoot: targetIsActive ? targetRoot : sourceRoot,
    activeRootId: targetIsActive ? targetRootId : sourceRootId,
  });
  const now = Date.now();
  const journal: RelocationJournal = {
    version: 1, transactionId: randomUUID(), profileId, sourceRoot, targetRoot,
    sourceRootId, targetRootId, sourceRevision: 1, stage: RelocationStage.SourceRetired, createdAt: now, updatedAt: now,
  };
  writeRelocationJournal(sourceRoot, journal);
  const physical = (file: string) => relocationPhysicalIdentity(fs.lstatSync(file, { bigint: true }));
  const write = (relative: string, content = 'original') => {
    const file = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const entry = (relativePath: string, kind: 'file' | 'directory' = 'file') =>
    ({ relativePath, kind, physical: physical(path.join(sourceRoot, relativePath)) });
  const save = (entries: ReturnType<typeof entry>[], kind: RelocationCleanupKind = 'copied') => {
    writeRelocationCleanupReceipt(journal, physical(sourceRoot), entries, kind);
    return path.join(targetRoot, StorageRelocationFile.ControlDirectory, `cleanup-${kind}.json`);
  };
  const options = {
    bootstrapRoot: sourceRoot,
    activeRoot: targetRoot,
    signal: new AbortController().signal,
    getProtectedPaths: vi.fn((): { directories: string[]; files: string[] } => ({ directories: [], files: [] })),
  };
  return { root, sourceRoot, targetRoot, journal, options, write, entry, save };
}

test('waits for the locator to switch before unlinking the source copy', async () => {
  const f = fixture(false);
  const source = f.write('justdo.sqlite');
  const target = path.join(f.targetRoot, 'justdo.sqlite');
  fs.writeFileSync(target, 'the live database may have changed');
  const receipt = f.save([f.entry('justdo.sqlite')]);

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 0 });
  expect(f.options.getProtectedPaths).not.toHaveBeenCalled();
  expect(fs.existsSync(source)).toBe(true);

  writeStorageLocator(f.sourceRoot, {
    version: 1, profileId: f.journal.profileId, revision: 2,
    activeRoot: f.targetRoot, activeRootId: f.journal.targetRootId,
  }, 1);
  await expect(cleanRelocationSource(f.options)).resolves.toEqual({ removed: 1, preserved: 0, pending: false });

  expect(fs.existsSync(source)).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe('the live database may have changed');
  expect(fs.existsSync(receipt)).toBe(false);
  expect(fs.existsSync(path.join(f.sourceRoot, StorageRelocationFile.Locator))).toBe(true);
  expect(fs.existsSync(path.join(f.sourceRoot, StorageRelocationFile.RootIdentity))).toBe(true);
});

test('keeps changed, referenced and added files while deleting unrelated owned copies', async () => {
  const f = fixture();
  const owned = f.write('justdo.sqlite');
  const changed = f.write('browser-import.sqlite');
  const protectedFile = f.write('local-speech-models/retained/model.onnx');
  const oldModel = f.write('local-speech-models/reserved/model.onnx');
  const directory = path.join(f.sourceRoot, 'local-speech-models');
  const entries = [
    f.entry('justdo.sqlite'), f.entry('browser-import.sqlite'), f.entry('local-speech-models', 'directory'),
    f.entry('local-speech-models/retained', 'directory'), f.entry('local-speech-models/retained/model.onnx'),
    f.entry('local-speech-models/reserved', 'directory'), f.entry('local-speech-models/reserved/model.onnx'),
  ];
  entries[0].physical.ctimeNs = '0';
  f.save(entries);
  fs.writeFileSync(changed, 'changed!');
  fs.utimesSync(changed, new Date(), new Date(Date.now() - 10_000));
  const added = f.write('local-speech-models/new-file');
  const alias = path.join(f.root, 'project-alias');
  fs.symlinkSync(path.dirname(protectedFile), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const futureProject = path.toNamespacedPath(path.join(path.dirname(oldModel), 'missing-project'));
  f.options.getProtectedPaths.mockReturnValue({ directories: [alias, f.root, futureProject], files: [] });

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 2, pending: false });

  expect(fs.existsSync(owned)).toBe(false);
  expect(fs.readFileSync(changed, 'utf8')).toBe('changed!');
  expect(fs.existsSync(protectedFile)).toBe(true);
  expect(fs.existsSync(oldModel)).toBe(false);
  expect(fs.existsSync(path.dirname(oldModel))).toBe(true);
  expect(fs.existsSync(added)).toBe(true);
  expect(fs.existsSync(directory)).toBe(true);
});

test('never follows a replaced parent junction even to the exact original file', async () => {
  const f = fixture();
  const relative = 'local-speech-models/example/model.onnx';
  f.write(relative);
  f.save([f.entry(relative)]);
  const originalParent = path.join(f.sourceRoot, 'local-speech-models');
  const elsewhere = path.join(f.root, 'elsewhere');
  fs.renameSync(originalParent, elsewhere);
  fs.symlinkSync(elsewhere, originalParent, process.platform === 'win32' ? 'junction' : 'dir');

  await expect(cleanRelocationSource(f.options)).resolves.toEqual({ removed: 0, preserved: 1, pending: false });

  expect(fs.readFileSync(path.join(elsewhere, 'example', 'model.onnx'), 'utf8')).toBe('original');
});

test('removes only empty recorded directories and retains an unlisted file inside a recorded directory', async () => {
  const f = fixture();
  const disposable = 'local-speech-models/disposable';
  const changed = 'local-speech-models/changed';
  f.write(`${disposable}/model.onnx`);
  f.write(`${changed}/model.onnx`);
  f.save([
    f.entry('local-speech-models', 'directory'),
    f.entry(disposable, 'directory'), f.entry(`${disposable}/model.onnx`),
    f.entry(changed, 'directory'), f.entry(`${changed}/model.onnx`),
  ]);
  const unlisted = f.write(`${changed}/unlisted.txt`, 'keep');

  await expect(cleanRelocationSource(f.options)).resolves.toEqual({ removed: 3, preserved: 2, pending: false });

  expect(fs.existsSync(path.join(f.sourceRoot, disposable))).toBe(false);
  expect(fs.readFileSync(unlisted, 'utf8')).toBe('keep');
});

test('replays locked source entries independently and tolerates an earlier successful unlink', async () => {
  const f = fixture();
  const locked = f.write('justdo.sqlite');
  const other = f.write('browser-import.sqlite');
  const receipt = f.save([f.entry('justdo.sqlite'), f.entry('browser-import.sqlite')]);
  const unlink = fsp.unlink;
  const blocked = vi.spyOn(fsp, 'unlink').mockImplementation(file => file === locked
    ? Promise.reject(Object.assign(new Error('Busy.'), { code: 'EBUSY' }))
    : unlink(file));

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 1, preserved: 0, pending: true });
  expect(fs.existsSync(locked)).toBe(true);
  expect(fs.existsSync(other)).toBe(false);
  expect(fs.existsSync(receipt)).toBe(true);
  blocked.mockRestore();

  await expect(cleanRelocationSource(f.options)).resolves.toEqual({ removed: 1, preserved: 0, pending: false });
  expect(fs.existsSync(locked)).toBe(false);
  expect(fs.existsSync(receipt)).toBe(false);
});

test.each(['new', 'modified'])('preserves the SQLite family when its WAL is %s', async change => {
  const f = fixture();
  const primary = f.write('justdo.sqlite');
  const unrelated = f.write('browser-import.sqlite');
  const entries = [f.entry('justdo.sqlite'), f.entry('browser-import.sqlite')];
  if (change === 'modified') {
    f.write('justdo.sqlite-wal');
    entries.push(f.entry('justdo.sqlite-wal'));
  }
  f.save(entries);
  const wal = f.write('justdo.sqlite-wal', 'committed after the copy');

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 1, pending: false });

  expect(fs.readFileSync(primary, 'utf8')).toBe('original');
  expect(fs.readFileSync(wal, 'utf8')).toBe('committed after the copy');
  expect(fs.existsSync(unrelated)).toBe(false);
});

test('retires SQLite sidecars before the primary and preserves it while a sidecar is locked', async () => {
  const f = fixture();
  const names = ['justdo.sqlite', 'justdo.sqlite-shm', 'justdo.sqlite-wal'];
  const [primary, sharedMemory, wal] = names.map(name => f.write(name));
  const receipt = f.save(names.map(name => f.entry(name)));
  const unlink = fsp.unlink;
  const blocked = vi.spyOn(fsp, 'unlink').mockImplementation(file => file === wal
    ? Promise.reject(Object.assign(new Error('Busy.'), { code: 'EBUSY' }))
    : unlink(file));

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 1, preserved: 0, pending: true });
  expect(blocked.mock.calls.map(([file]) => file)).toEqual([sharedMemory, wal]);
  expect(fs.existsSync(primary)).toBe(true);
  expect(fs.existsSync(receipt)).toBe(true);
  blocked.mockRestore();

  const retried = vi.spyOn(fsp, 'unlink');
  await expect(cleanRelocationSource(f.options)).resolves.toEqual({ removed: 2, preserved: 0, pending: false });
  expect(retried.mock.calls.map(([file]) => file)).toEqual([wal, primary]);
  expect(fs.existsSync(receipt)).toBe(false);
});

test('stops after an in-flight unlink on cancellation and resumes the remaining receipt', async () => {
  const f = fixture();
  const first = f.write('justdo.sqlite');
  const second = f.write('browser-import.sqlite');
  const receipt = f.save([f.entry('justdo.sqlite'), f.entry('browser-import.sqlite')]);
  const abort = new AbortController();
  const unlink = fsp.unlink;
  const remove = vi.spyOn(fsp, 'unlink').mockImplementation(async file => {
    await unlink(file);
    abort.abort();
  });

  await expect(cleanRelocationSource({ ...f.options, signal: abort.signal })).resolves.toMatchObject({ pending: true });
  expect(remove).toHaveBeenCalledExactlyOnceWith(first);
  expect(fs.existsSync(second)).toBe(true);
  expect(fs.existsSync(receipt)).toBe(true);
  remove.mockRestore();

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 1, pending: false });
  expect(fs.existsSync(second)).toBe(false);
});

test('rejects reserved paths and leaves mismatched receipts untouched without blocking another kind', async () => {
  const f = fixture();
  const account = f.write('account/current.json');
  const copied = f.write('justdo.sqlite');
  f.write('openclaw/state/state/openclaw.sqlite');
  expect(() => f.save([f.entry('account/current.json')])).toThrow();
  const invalid = f.save([f.entry('justdo.sqlite')]);
  const wrong = JSON.parse(fs.readFileSync(invalid, 'utf8'));
  fs.writeFileSync(invalid, JSON.stringify({ ...wrong, transactionId: randomUUID() }));
  f.save([f.entry('openclaw', 'directory')], 'openclaw');

  await expect(cleanRelocationSource(f.options)).resolves.toMatchObject({ removed: 1, preserved: 0, pending: true });

  expect(fs.existsSync(account)).toBe(true);
  expect(fs.existsSync(copied)).toBe(true);
  expect(fs.existsSync(path.join(f.sourceRoot, 'openclaw'))).toBe(false);
  expect(fs.existsSync(invalid)).toBe(true);
});

test('preserves upgrade backups from legacy receipts while finishing unrelated cleanup', async () => {
  const f = fixture();
  const copied = f.write('justdo.sqlite');
  const backupPath = 'backups/upgrade/old-copy.txt';
  const backup = f.write(backupPath);
  const receipt = f.save([f.entry('justdo.sqlite'), f.entry('backups', 'directory'), f.entry(backupPath)]);

  await expect(cleanRelocationSource(f.options)).resolves.toEqual({ removed: 1, preserved: 0, pending: false });

  expect(fs.existsSync(copied)).toBe(false);
  expect(fs.readFileSync(backup, 'utf8')).toBe('original');
  expect(fs.existsSync(receipt)).toBe(false);
});

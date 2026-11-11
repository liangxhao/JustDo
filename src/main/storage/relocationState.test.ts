import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { restrictCredentialFile } from '../openclaw/config/models/providerSecretFile';
import {
  assertCanonicalDirectory,
  assertCanonicalParentDirectory,
  bindInitialStorageRoot,
  isRelocationRootPath,
  readRelocationJournal,
  readStorageLocator,
  readStorageLocatorMetadata,
  readStorageRootIdentity,
  recoverInitialStorageBinding,
  type RelocationJournal,
  RelocationStage,
  removeRelocationJournal,
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
  for (const directory of fixtures.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(bind = true) {
  const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-relocation-state-'));
  fixtures.push(bootstrap);
  const profileId = randomUUID();
  const rootId = randomUUID();
  const locator = {
    version: 1 as const,
    profileId,
    revision: 1,
    activeRoot: bootstrap,
    activeRootId: rootId,
  };
  if (bind) bindInitialStorageRoot(bootstrap, locator);
  const journal: RelocationJournal = {
    version: 1,
    transactionId: randomUUID(),
    profileId,
    sourceRoot: bootstrap,
    targetRoot: path.join(path.dirname(bootstrap), `target-${randomUUID()}`),
    sourceRootId: rootId,
    targetRootId: randomUUID(),
    sourceRevision: 1,
    stage: 'requested',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { bootstrap, locator, journal };
}

test('recovers an interrupted first binding by rolling back only its proven marker', () => {
  const { bootstrap, locator } = fixture(false);
  const binding = path.join(bootstrap, StorageRelocationFile.InitialBinding);
  const marker = path.join(bootstrap, StorageRelocationFile.RootIdentity);
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  const failedWrite = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === path.join(bootstrap, StorageRelocationFile.Locator)) throw new Error('Disk full.');
    return rename(from, to);
  });
  const interruptedCleanup = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (file === marker) throw new Error('Cleanup interrupted.');
    return unlink(file);
  });

  expect(() => bindInitialStorageRoot(bootstrap, locator)).toThrow('Disk full.');
  expect(readStorageLocator(bootstrap)).toBeNull();
  expect(readStorageRootIdentity(bootstrap)?.rootId).toBe(locator.activeRootId);
  expect(fs.existsSync(binding)).toBe(true);
  failedWrite.mockRestore();
  interruptedCleanup.mockRestore();

  recoverInitialStorageBinding(bootstrap);

  expect(readStorageRootIdentity(bootstrap)).toBeNull();
  expect(fs.existsSync(binding)).toBe(false);
  bindInitialStorageRoot(bootstrap, locator);
  expect(readStorageLocator(bootstrap)).toEqual(locator);
});

test('finishes first-binding recovery after the locator committed', () => {
  const { bootstrap, locator } = fixture(false);
  const binding = path.join(bootstrap, StorageRelocationFile.InitialBinding);
  const unlink = fs.unlinkSync;
  const interrupted = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (file === binding) throw new Error('Cleanup interrupted.');
    return unlink(file);
  });
  expect(() => bindInitialStorageRoot(bootstrap, locator)).toThrow('Cleanup interrupted.');
  interrupted.mockRestore();

  recoverInitialStorageBinding(bootstrap);

  expect(readStorageLocator(bootstrap)).toEqual(locator);
  expect(fs.existsSync(binding)).toBe(false);
});

test('a bare root marker is never removed as an interrupted binding', () => {
  const { bootstrap, locator } = fixture(false);
  const marker = { version: 1 as const, profileId: locator.profileId, rootId: locator.activeRootId };
  writeStorageRootIdentity(bootstrap, marker);

  recoverInitialStorageBinding(bootstrap);

  expect(readStorageRootIdentity(bootstrap)).toEqual(marker);
  expect(() => bindInitialStorageRoot(bootstrap, locator)).toThrow();
});

test('saves restricted atomically flushed control files and reads exact root ownership', () => {
  const fsync = vi.spyOn(fs, 'fsyncSync');
  vi.mocked(restrictCredentialFile).mockImplementation(filename =>
    expect(fs.statSync(filename).size).toBe(0),
  );
  const { bootstrap, locator, journal } = fixture();
  writeRelocationJournal(bootstrap, journal);

  expect(readStorageLocator(bootstrap)).toEqual(locator);
  expect(readStorageRootIdentity(bootstrap)).toEqual({
    version: 1,
    profileId: locator.profileId,
    rootId: locator.activeRootId,
  });
  expect(readRelocationJournal(bootstrap)).toEqual(journal);
  expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(fs.readdirSync(bootstrap).some(name => name.startsWith('.storage-control-'))).toBe(false);
});

test('does not treat corrupt state, unknown fields or linked control files as an absent locator', () => {
  const { bootstrap, locator } = fixture();
  const filename = path.join(bootstrap, 'storage-location.json');
  fs.writeFileSync(filename, JSON.stringify({ ...locator, unexpected: 'data' }));
  expect(() => readStorageLocator(bootstrap)).toThrow(expect.objectContaining({
    location: 'locator',
    path: filename,
  }));
  expect(() => writeStorageLocator(bootstrap, { ...locator, revision: 2 })).toThrow();
  fs.unlinkSync(filename);
  const external = path.join(bootstrap, 'outside.json');
  fs.writeFileSync(external, JSON.stringify(locator));
  fs.linkSync(external, filename);
  expect(() => readStorageLocator(bootstrap)).toThrow();
});

test('locator metadata identifies a missing target but never admits it for normal storage access', () => {
  const { bootstrap, locator } = fixture();
  const selected = { ...locator, activeRoot: path.join(bootstrap, 'missing-target') };
  const filename = path.join(bootstrap, 'storage-location.json');
  fs.writeFileSync(filename, JSON.stringify(selected));

  expect(readStorageLocatorMetadata(bootstrap)).toEqual(selected);
  expect(() => readStorageLocator(bootstrap)).toThrow(expect.objectContaining({
    location: 'data',
    path: selected.activeRoot,
    cause: expect.objectContaining({ code: 'ENOENT' }),
  }));
  expect(fs.existsSync(selected.activeRoot)).toBe(false);

  fs.mkdirSync(selected.activeRoot);
  expect(() => readStorageLocator(bootstrap)).toThrow(expect.objectContaining({
    location: 'identity',
    path: selected.activeRoot,
  }));

  fs.writeFileSync(filename, JSON.stringify({ ...selected, extra: true }));
  expect(() => readStorageLocatorMetadata(bootstrap)).toThrow();
});

test('guards revisions, profile ownership and request identity', () => {
  const { bootstrap, locator, journal } = fixture();
  expect(() => writeStorageLocator(bootstrap, { ...locator, revision: 2 }, 99)).toThrow();
  expect(() =>
    writeStorageRootIdentity(bootstrap, {
      version: 1,
      profileId: locator.profileId,
      rootId: randomUUID(),
    }),
  ).toThrow();
  writeRelocationJournal(bootstrap, journal);
  expect(() =>
    writeRelocationJournal(bootstrap, { ...journal, transactionId: randomUUID() }),
  ).toThrow();
  expect(() => removeRelocationJournal(bootstrap, randomUUID())).toThrow();
  removeRelocationJournal(bootstrap, journal.transactionId);
  expect(readRelocationJournal(bootstrap)).toBeNull();
});

test('rejects directory aliases, traversal and incorrect clean receipts', () => {
  const { bootstrap, journal } = fixture();
  const alias = path.join(bootstrap, 'alias');
  fs.symlinkSync(bootstrap, alias, 'junction');
  expect(() => readStorageLocator(alias)).toThrow();
  expect(() =>
    writeRelocationJournal(bootstrap, { ...journal, targetRoot: path.join(bootstrap, 'nested') }),
  ).toThrow();
  expect(() =>
    writeRelocationJournal(bootstrap, {
      ...journal,
      cleanShutdown: {
        pid: 1,
        transactionId: randomUUID(),
        completedAt: Date.now(),
      },
    }),
  ).toThrow();
});

test('allows a Windows volume root only as a parent, never as a data or control root', () => {
  const volumeRoot = path.parse(path.resolve(os.tmpdir())).root;
  expect(isRelocationRootPath(volumeRoot)).toBe(false);
  expect(() => assertCanonicalDirectory(volumeRoot)).toThrow();
  expect(() => readStorageRootIdentity(volumeRoot)).toThrow();
  expect(() => readStorageLocator(volumeRoot)).toThrow();
  if (process.platform === 'win32') {
    expect(assertCanonicalParentDirectory(volumeRoot).toLowerCase()).toBe(volumeRoot.toLowerCase());
    expect(() => assertCanonicalParentDirectory('\\\\untrusted\\share\\')).toThrow();
  } else {
    expect(() => assertCanonicalParentDirectory(volumeRoot)).toThrow();
  }
});

test('accepts bounded precise process identities and rejects malformed retirement custody', () => {
  const { bootstrap, journal } = fixture();
  const cleanShutdown = {
    pid: 1,
    transactionId: journal.transactionId,
    completedAt: Date.now(),
    runtimeRoot: bootstrap,
    appVersion: 'v1',
    processes: [
      { pid: 1, creationTime: 1_700_000_000_000.25 },
      { pid: 2, creationTime: 1_700_000_000_001 },
    ],
  };
  writeRelocationJournal(bootstrap, { ...journal, cleanShutdown });
  expect(readRelocationJournal(bootstrap)?.cleanShutdown?.processes).toEqual(
    cleanShutdown.processes,
  );
  for (const processes of [
    Array.from({ length: 257 }, () => ({ pid: 1, creationTime: 1 })),
    [{ pid: 0, creationTime: 1 }],
    [{ pid: 1, creationTime: -1 }],
    [{ pid: 1, creationTime: Infinity }],
  ]) {
    expect(() =>
      writeRelocationJournal(bootstrap, {
        ...journal,
        cleanShutdown: { ...cleanShutdown, processes },
      }),
    ).toThrow();
  }
});

test('records maintenance process custody', () => {
  const { bootstrap, journal } = fixture();
  const maintenanceProcesses = [{ pid: 23, creationTime: 1_700_000_000_000.25 }];
  writeRelocationJournal(bootstrap, {
    ...journal,
    maintenanceProcesses,
    sourceProcesses: maintenanceProcesses,
  });
  expect(readRelocationJournal(bootstrap)?.maintenanceProcesses).toEqual(maintenanceProcesses);
  expect(readRelocationJournal(bootstrap)?.sourceProcesses).toEqual(maintenanceProcesses);
  expect(() =>
    writeRelocationJournal(bootstrap, {
      ...journal,
      maintenanceProcesses: [{ pid: 23, creationTime: 0 }],
    }),
  ).toThrow();
  expect(() =>
    writeRelocationJournal(bootstrap, {
      ...journal,
      sourceProcesses: [{ pid: 0, creationTime: 1 }],
    }),
  ).toThrow();
});

test.each([
  RelocationStage.Copying, RelocationStage.Copied, RelocationStage.TargetPreparing,
  RelocationStage.TargetReady, RelocationStage.Failed,
])('reads a previous request with obsolete retry fields (%s)', stage => {
  const { bootstrap, journal } = fixture();
  const filename = path.join(bootstrap, StorageRelocationFile.ControlDirectory, StorageRelocationFile.Journal);
  fs.mkdirSync(path.dirname(filename));
  const legacy = {
    ...journal,
    stage,
    errorCode: 'migration-failed',
    lastStage: 'copying',
    targetRetainedPath: journal.targetRoot + '.interrupted-' + randomUUID(),
  };
  fs.writeFileSync(filename, JSON.stringify(legacy));
  expect(readRelocationJournal(bootstrap)).toMatchObject({ stage });
});

function committedFixture() {
  const { bootstrap, locator, journal } = fixture();
  const target = journal.targetRoot;
  fs.mkdirSync(target);
  fixtures.push(target);
  writeStorageRootIdentity(target, { version: 1, profileId: locator.profileId, rootId: journal.targetRootId });
  writeStorageLocator(bootstrap, {
    ...locator, revision: 2, activeRoot: target, activeRootId: journal.targetRootId,
  }, 1);
  const committed = { ...journal, stage: RelocationStage.Committed };
  writeRelocationJournal(bootstrap, committed);
  return { bootstrap, target, journal: committed };
}

test('cannot discard a request after the locator switched', () => {
  const f = committedFixture();

  expect(() => removeRelocationJournal(f.bootstrap, f.journal.transactionId)).toThrow();

  expect(readRelocationJournal(f.bootstrap)?.stage).toBe(RelocationStage.Committed);
  expect(readStorageLocator(f.bootstrap)?.activeRoot).toBe(f.target);
});

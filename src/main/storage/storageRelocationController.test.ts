import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { restrictCredentialDirectory } from '../openclaw/config/models/providerSecretFile';
import {
  bindInitialStorageRoot,
  readRelocationJournal,
  readStorageLocator,
  readStorageRootIdentity,
  RelocationStage,
  writeRelocationJournal,
  writeStorageLocator,
  writeStorageRootIdentity,
} from './relocationState';
import { StorageRelocationController } from './storageRelocationController';

vi.mock('../openclaw/config/models/providerSecretFile', () => ({
  restrictCredentialDirectory: vi.fn(),
  restrictCredentialFile: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(established = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-relocation-controller-'));
  roots.push(root);
  const source = path.join(root, 'profile');
  const target = path.join(root, 'chosen folder');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'settings.json'), 'fixture settings');
  if (established) bindInitialStorageRoot(source, {
    version: 1,
    profileId: randomUUID(),
    revision: 1,
    activeRoot: source,
    activeRootId: randomUUID(),
  });
  const events: string[] = [];
  const processes = [{ pid: process.pid, creationTime: Date.now() - 1000 }];
  const gateway = { pid: process.pid + 1000, creationTime: Date.now() - 500 };
  let afterCleanup: (() => void) | undefined;
  let afterTimeout: (() => void) | undefined;
  const unfreeze = vi.fn(() => events.push('unfreeze'));
  const deps: ConstructorParameters<typeof StorageRelocationController>[0] = {
    bootstrapRoot: source,
    getSourceRoot: () => source,
    available: () => true,
    selectTargetDirectory: vi.fn(async () => target),
    isQuitting: vi.fn(() => false),
    freezeAdmission: vi.fn(() => {
      events.push('freeze');
      return unfreeze;
    }),
    beginShutdown: vi.fn((callback, timeout) => {
      events.push('shutdown');
      afterCleanup = callback;
      afterTimeout = timeout;
    }),
    shutdownRuntime: { runtimeRoot: path.join(root, 'runtime'), appVersion: 'v1' },
    relaunch: vi.fn(),
    getProcesses: vi.fn(() => [...processes, gateway]),
    captureForceProcesses: vi.fn(() => [...processes, gateway]),
    forceProcesses: vi.fn(() => {}),
  };
  const controller = new StorageRelocationController(deps);
  return {
    root,
    source,
    target,
    controller,
    deps,
    events,
    unfreeze,
    processes,
    gateway,
    cleanupSucceeded: () => afterCleanup!(),
    cleanupTimedOut: () => afterTimeout!(),
  };
}

test('prepares the exact chosen folder and leaves it untouched when cancelled', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  expect(prepared.success).toBe(true);
  if (!prepared.success) throw new Error('Expected plan.');
  expect(prepared.value.targetPath).toBe(f.target);
  expect(fs.readdirSync(f.target)).toEqual([]);
  expect(restrictCredentialDirectory).not.toHaveBeenCalled();
  expect(readStorageLocator(f.source)).toBeNull();
  expect(readStorageRootIdentity(f.source)).toBeNull();
  expect(readRelocationJournal(f.source)).toBeNull();
  expect(f.deps.beginShutdown).not.toHaveBeenCalled();

  expect(f.controller.discard(prepared.value.planId)).toEqual({ success: true, value: null });
  expect(fs.readdirSync(f.target)).toEqual([]);
  expect(fs.readFileSync(path.join(f.source, 'settings.json'), 'utf8')).toBe('fixture settings');
  expect((await f.controller.prepare()).success).toBe(true);
});

test('refuses a nonempty folder without selecting a different path', async () => {
  const f = fixture();
  const existing = path.join(f.target, 'user-file.txt');
  fs.writeFileSync(existing, 'keep');
  const folders = fs.readdirSync(f.root);

  expect(await f.controller.prepare()).toEqual({ success: false, code: 'target-not-empty' });

  expect(fs.readFileSync(existing, 'utf8')).toBe('keep');
  expect(fs.readdirSync(f.root)).toEqual(folders);
  expect(readStorageRootIdentity(f.target)).toBeNull();
});

test('discard releases the plan even if the chosen folder is unavailable', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  fs.renameSync(f.target, `${f.target}-unavailable`);

  expect(f.controller.discard(prepared.value.planId)).toEqual({ success: true, value: null });
  expect(await f.controller.commit(prepared.value.planId)).toEqual({ success: false, code: 'unavailable' });
});

test('refuses files added to the chosen folder before confirmation', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  fs.writeFileSync(path.join(f.target, 'user-file.txt'), 'keep');

  expect(await f.controller.commit(prepared.value.planId)).toEqual({ success: false, code: 'target-not-empty' });
  expect(f.deps.beginShutdown).not.toHaveBeenCalled();
  f.controller.discard(prepared.value.planId);

  expect(fs.readFileSync(path.join(f.target, 'user-file.txt'), 'utf8')).toBe('keep');
  expect(readStorageRootIdentity(f.target)).toBeNull();
});

test('uses the chosen path when the folder at that path is still empty', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  const previous = f.target + '-previous';
  fs.renameSync(f.target, previous);
  fs.mkdirSync(f.target);

  expect(await f.controller.commit(prepared.value.planId)).toEqual({ success: true, value: null });

  expect(readRelocationJournal(f.source)?.targetRoot).toBe(f.target);
  expect(fs.readdirSync(previous)).toEqual([]);
});

test('confirmation starts shutdown directly and records the old processes before relaunch', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  vi.mocked(f.deps.beginShutdown).mockImplementation(callback => {
    f.events.push('shutdown');
    expect(readRelocationJournal(f.source)?.stage).toBe('requested');
    expect(readRelocationJournal(f.source)?.cleanShutdown).toBeUndefined();
    f.cleanupSucceeded = callback;
  });

  expect(await f.controller.commit(prepared.value.planId)).toEqual({ success: true, value: null });
  expect(f.events).toEqual(['freeze', 'shutdown']);
  expect(f.deps.beginShutdown).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
  expect(f.unfreeze).not.toHaveBeenCalled();
  expect(f.deps.relaunch).not.toHaveBeenCalled();
  const requested = readRelocationJournal(f.source);
  expect(requested?.targetRoot).toBe(f.target);
  expect(readStorageRootIdentity(f.target)?.rootId).toBe(requested?.targetRootId);
  expect(requested?.sourceProcesses).toEqual([...f.processes, f.gateway]);
  expect(requested?.cleanShutdown).toBeUndefined();

  f.cleanupSucceeded();

  const retired = readRelocationJournal(f.source);
  expect(retired?.stage).toBe('source-retired');
  expect(retired?.cleanShutdown?.processes).toEqual([...f.processes, f.gateway]);
  expect(retired?.cleanShutdown?.transactionId).toBe(prepared.value.planId);
  expect(retired?.cleanShutdown).toMatchObject(f.deps.shutdownRuntime);
  expect(f.deps.relaunch).toHaveBeenCalledOnce();
});

test('records a forced handoff and keeps the source active until offline retirement is verified', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  await f.controller.commit(prepared.value.planId);

  vi.mocked(f.deps.forceProcesses).mockImplementation(owned => {
    expect(readRelocationJournal(f.source)?.forcedShutdown?.processes).toEqual(owned);
  });
  f.cleanupTimedOut();

  expect(f.deps.forceProcesses).toHaveBeenCalledExactlyOnceWith([...f.processes, f.gateway]);
  expect(readStorageLocator(f.source)?.activeRoot).toBe(f.source);
  const requested = readRelocationJournal(f.source);
  expect(requested?.stage).toBe(RelocationStage.Requested);
  expect(requested?.cleanShutdown).toBeUndefined();
  expect(requested?.forcedShutdown?.processes).toEqual([...f.processes, f.gateway]);
  expect(f.deps.relaunch).toHaveBeenCalledOnce();
});

test('does not start a second shutdown if the application is already exiting', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  vi.mocked(f.deps.isQuitting).mockReturnValueOnce(true);

  expect(await f.controller.commit(prepared.value.planId)).toEqual({ success: false, code: 'busy' });
  expect(f.deps.freezeAdmission).not.toHaveBeenCalled();
  expect(f.deps.beginShutdown).not.toHaveBeenCalled();
});

test('rejects the first binding if the selected source directory has been replaced', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  const previous = `${f.source}-previous`;
  fs.renameSync(f.source, previous);
  fs.mkdirSync(f.source);

  expect(await f.controller.commit(prepared.value.planId)).toEqual({ success: false, code: 'unavailable' });

  expect(readStorageLocator(f.source)).toBeNull();
  expect(f.deps.beginShutdown).not.toHaveBeenCalled();
  expect(f.unfreeze).toHaveBeenCalledOnce();
  expect(fs.readFileSync(path.join(previous, 'settings.json'), 'utf8')).toBe('fixture settings');
});

test('captures process identities created during cleanup in the final clean receipt', async () => {
  const f = fixture();
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  const lateProcess = { pid: process.pid + 1, creationTime: Date.now() };
  vi.mocked(f.deps.getProcesses)
    .mockReturnValueOnce([...f.processes, f.gateway])
    .mockReturnValueOnce([...f.processes, lateProcess]);

  await f.controller.commit(prepared.value.planId);
  expect(readRelocationJournal(f.source)?.sourceProcesses).toEqual([...f.processes, f.gateway]);
  f.cleanupSucceeded();

  expect(readRelocationJournal(f.source)?.cleanShutdown?.processes).toEqual([...f.processes, f.gateway, lateProcess]);
});

test('rejects a plan when the active locator revision changed after confirmation', async () => {
  const f = fixture(true);
  const prepared = await f.controller.prepare();
  if (!prepared.success) throw new Error('Expected plan.');
  const locator = readStorageLocator(f.source)!;
  writeStorageLocator(f.source, { ...locator, revision: locator.revision + 1 }, locator.revision);

  expect(await f.controller.commit(prepared.value.planId)).toEqual({
    success: false,
    code: 'unavailable',
  });
  expect(f.unfreeze).toHaveBeenCalledOnce();
  expect(readRelocationJournal(f.source)).toBeNull();
  expect(f.deps.beginShutdown).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== 'win32')('moves again from a saved Windows path with different casing', async () => {
  const f = fixture(true);
  const original = readStorageLocator(f.source)!;
  const activeRoot = path.join(f.root, 'MovedData');
  const savedPath = activeRoot.toLowerCase();
  const selectedFolder = path.join(f.root, 'DestinationFolder');
  fs.mkdirSync(activeRoot);
  fs.mkdirSync(selectedFolder);
  const activeRootId = randomUUID();
  writeStorageRootIdentity(activeRoot, { version: 1, profileId: original.profileId, rootId: activeRootId });
  writeStorageLocator(f.source, {
    ...original, revision: 2, activeRoot: savedPath, activeRootId,
  }, original.revision);
  writeRelocationJournal(f.source, {
    version: 1,
    transactionId: randomUUID(),
    profileId: original.profileId,
    sourceRoot: f.source,
    sourceRootId: original.activeRootId,
    sourceRevision: original.revision,
    targetRoot: savedPath,
    targetRootId: activeRootId,
    stage: RelocationStage.Activated,
    createdAt: 1,
    updatedAt: 1,
  });
  const controller = new StorageRelocationController({
    ...f.deps,
    getSourceRoot: () => savedPath,
    selectTargetDirectory: async () => selectedFolder.toLowerCase(),
  });

  const prepared = await controller.prepare();

  if (!prepared.success) throw new Error('Expected a second relocation plan.');
  const targetPath = fs.realpathSync.native(selectedFolder);
  expect(prepared.value).toMatchObject({ sourcePath: savedPath, targetPath: selectedFolder.toLowerCase() });
  vi.mocked(restrictCredentialDirectory).mockImplementationOnce(() => {
    throw new Error('Cannot write the selected folder.');
  });
  await expect(controller.commit(prepared.value.planId)).resolves.toEqual({ success: false, code: 'unavailable' });
  expect(readRelocationJournal(f.source)?.stage).toBe(RelocationStage.Activated);

  await expect(controller.commit(prepared.value.planId)).resolves.toEqual({ success: true, value: null });
  expect(readRelocationJournal(f.source)).toMatchObject({
    sourceRoot: savedPath, sourceRootId: activeRootId, sourceRevision: 2, targetRoot: targetPath,
  });
});

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { StartupRoute, StartupStage } from '../../shared/app/startup/routing';
import { writeStartupJson } from '../startup/routing/startupState';
import { isUpgradeBackupWorkingDirectory, UpgradeBackupService } from './upgradeBackupService';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}
function fixture(backups = true) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-backup-'));
  roots.push(parent);
  let root = path.join(parent, 'profile');
  fs.mkdirSync(root);
  const backup = path.join(root, 'backups');
  const journal = {
    version: 1,
    generation: 'native-sqlite',
    route: StartupRoute.Normal,
    stage: StartupStage.Complete,
    transactionId: randomUUID(),
    startedAt: Date.now(),
  };
  writeStartupJson(path.join(root, 'startup-state.json'), journal);
  if (backups) {
    fs.mkdirSync(path.join(backup, 'transaction', 'retired'), { recursive: true });
    fs.writeFileSync(
      path.join(backup, 'transaction', 'retired', 'history.sqlite'),
      'opaque old database fixture',
    );
  }
  fs.writeFileSync(path.join(root, 'active.sqlite'), 'current data fixture');
  const confirmDelete = vi.fn(async (_directory: string) => true);
  const isReady = vi.fn(() => true);
  const deps = { getDirectory: () => root, isReady, confirmDelete };
  return {
    parent,
    root,
    backup,
    journal,
    deps,
    confirmDelete,
    isReady,
    setRoot: (value: string) => {
      root = value;
    },
    service: new UpgradeBackupService(deps),
  };
}

test('recognizes the namespaced spelling of a project inside the backup', () => {
  const { root, backup } = fixture();
  expect(isUpgradeBackupWorkingDirectory(root, path.toNamespacedPath(path.join(backup, 'project')))).toBe(true);
  expect(isUpgradeBackupWorkingDirectory(root, path.join(root, 'backups-other', 'project'))).toBe(false);
});

test('protects a backup used as a working directory through a directory junction', async () => {
  const f = fixture();
  const workspace = path.join(f.backup, 'project');
  const alias = path.join(f.parent, 'project-alias');
  fs.mkdirSync(workspace);
  fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.isReady.mockImplementation(() => !isUpgradeBackupWorkingDirectory(f.root, alias));

  expect(await f.service.delete()).toEqual({ success: false, code: 'not-ready' });

  expect(f.confirmDelete).not.toHaveBeenCalled();
  expect(fs.realpathSync.native(alias)).toBe(workspace);
});

test('deletes only the fixed backup using the active profile startup state', async () => {
  const f = fixture();
  const fixedRoot = path.join(f.parent, 'configuration');
  const fixedBackup = path.join(fixedRoot, 'backups');
  fs.mkdirSync(fixedBackup, { recursive: true });
  fs.writeFileSync(path.join(fixedRoot, 'configuration.json'), 'keep configuration');
  fs.writeFileSync(path.join(fixedBackup, 'history.sqlite'), 'fixed backup fixture');
  const service = new UpgradeBackupService({ ...f.deps, backupRoot: fixedRoot });

  expect(await service.status()).toEqual({ success: true, value: { exists: true, canDelete: true } });
  expect(await service.delete()).toEqual({ success: true, value: null });

  expect(f.confirmDelete).toHaveBeenLastCalledWith(fixedBackup);
  expect(f.isReady).toHaveBeenLastCalledWith(fixedRoot);
  expect(fs.existsSync(fixedBackup)).toBe(false);
  expect(fs.readFileSync(path.join(fixedRoot, 'configuration.json'), 'utf8')).toBe('keep configuration');
  expect(fs.existsSync(f.backup)).toBe(true);
  expect(await service.status()).toEqual({ success: true, value: { exists: false, canDelete: false } });
});

test('a missing backups directory is an unchanged success without confirmation or directory creation', async () => {
  const f = fixture(false);
  f.isReady.mockReturnValue(false);
  const before = fs.readdirSync(f.root);

  expect(await f.service.delete()).toEqual({ success: true, value: null });

  expect(f.confirmDelete).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.root)).toEqual(before);
});

test('pending startup preparation and explicit cancellation never remove anything', async () => {
  const f = fixture();
  writeStartupJson(path.join(f.root, 'startup-state.json'), {
    ...f.journal,
    schemaPreparationPending: true,
    targetIdentity: { appVersion: 'v1', runtimeVersion: 'v1', runtimeBuildId: 'a'.repeat(64) },
  });
  expect(await f.service.status()).toEqual({
    success: true,
    value: { exists: true, canDelete: false },
  });
  expect(await f.service.delete()).toEqual({ success: false, code: 'not-ready' });
  expect(f.confirmDelete).not.toHaveBeenCalled();
  writeStartupJson(path.join(f.root, 'startup-state.json'), f.journal);
  f.confirmDelete.mockResolvedValue(false);

  expect(await f.service.delete()).toEqual({ success: false, code: 'cancelled' });
  expect(fs.existsSync(f.backup)).toBe(true);
});

test('holds busy throughout confirmation and never duplicates the removal', async () => {
  const f = fixture();
  const answer = deferred<boolean>();
  f.confirmDelete.mockReturnValue(answer.promise);
  const request = f.service.delete();
  await vi.waitFor(() => expect(f.confirmDelete).toHaveBeenCalledOnce());
  expect(f.service.isBusy()).toBe(true);
  expect(await f.service.delete()).toEqual({ success: false, code: 'busy' });
  answer.resolve(false);
  await request;
  expect(f.service.isBusy()).toBe(false);
});

test('rechecks active readiness and backup physical identity after a delayed confirmation', async () => {
  const f = fixture();
  const answer = deferred<boolean>();
  f.confirmDelete.mockReturnValue(answer.promise);
  const request = f.service.delete();
  await vi.waitFor(() => expect(f.confirmDelete).toHaveBeenCalledOnce());
  fs.renameSync(f.backup, `${f.backup}-preserved`);
  fs.mkdirSync(f.backup);
  fs.writeFileSync(path.join(f.backup, 'new.txt'), 'new directory fixture');
  answer.resolve(true);

  expect(await request).toEqual({ success: false, code: 'not-ready' });
  expect(fs.existsSync(`${f.backup}-preserved`)).toBe(true);
  expect(fs.readFileSync(path.join(f.backup, 'new.txt'), 'utf8')).toBe('new directory fixture');
});

test('a changed profile invalidates the old confirmation even while readiness remains true', async () => {
  const f = fixture();
  const answer = deferred<boolean>();
  f.confirmDelete.mockReturnValue(answer.promise);
  const request = f.service.delete();
  await vi.waitFor(() => expect(f.confirmDelete).toHaveBeenCalledOnce());
  f.setRoot(path.join(f.parent, 'different-profile'));
  answer.resolve(true);

  expect(await request).toEqual({ success: false, code: 'not-ready' });
  expect(fs.existsSync(f.backup)).toBe(true);
});

test('a caller revoked during directory preflight cannot open a destructive confirmation for its replacement', async () => {
  const f = fixture();
  const release = deferred<void>();
  const original = fsp.lstat;
  vi.spyOn(fsp, 'lstat').mockImplementationOnce((async (...args: Parameters<typeof fsp.lstat>) => {
    await release.promise;
    return original(...args);
  }) as typeof fsp.lstat);
  let current = true;
  const request = f.service.delete(() => current);
  current = false;
  release.resolve();

  expect(await request).toEqual({ success: false, code: 'forbidden' });
  expect(f.confirmDelete).not.toHaveBeenCalled();
  expect(fs.existsSync(f.backup)).toBe(true);
});

test('replacing the profile directory itself invalidates confirmation even with the same journal and backup identity', async () => {
  const f = fixture();
  const answer = deferred<boolean>();
  f.confirmDelete.mockReturnValue(answer.promise);
  const request = f.service.delete();
  await vi.waitFor(() => expect(f.confirmDelete).toHaveBeenCalledOnce());
  const retired = path.join(f.parent, 'retired-profile');
  fs.renameSync(f.root, retired);
  fs.mkdirSync(f.root);
  fs.renameSync(path.join(retired, 'backups'), f.backup);
  fs.copyFileSync(
    path.join(retired, 'startup-state.json'),
    path.join(f.root, 'startup-state.json'),
  );
  answer.resolve(true);

  expect(await request).toEqual({ success: false, code: 'not-ready' });
  expect(fs.existsSync(f.backup)).toBe(true);
});

test('deletes a directory link in backups and preserves the external target', async () => {
  const f = fixture();
  const outside = path.join(f.parent, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(f.backup, 'linked'), 'junction');

  expect(await f.service.delete()).toEqual({ success: true, value: null });
  expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  expect(fs.existsSync(f.backup)).toBe(false);
});

test('leaves an external directory untouched if it replaces an opened backup path', async () => {
  const f = fixture();
  const child = path.join(f.backup, 'transaction');
  const outside = path.join(f.parent, 'outside');
  fs.mkdirSync(outside);
  const keep = path.join(outside, 'keep.txt');
  fs.writeFileSync(keep, 'keep');
  const opendir = fsp.opendir;
  vi.spyOn(fsp, 'opendir').mockImplementation(async (directory, options) => {
    if (directory === child) {
      fs.renameSync(child, path.join(f.parent, 'moved'));
      fs.symlinkSync(outside, child, 'junction');
    }
    return opendir(directory, options);
  });

  expect(await f.service.delete()).toEqual({ success: false, code: 'not-ready' });
  expect(fs.readFileSync(keep, 'utf8')).toBe('keep');
});

test('rejects a linked profile before asking for destructive confirmation', async () => {
  const f = fixture();
  const alias = path.join(f.parent, 'profile-alias');
  fs.symlinkSync(f.root, alias, 'junction');
  f.setRoot(alias);

  expect(await f.service.delete()).toEqual({ success: false, code: 'unavailable' });
  expect(f.confirmDelete).not.toHaveBeenCalled();
  expect(fs.existsSync(f.backup)).toBe(true);
});

test('stop does not await an unanswered confirmation and rejects a later acceptance', async () => {
  const f = fixture();
  const answer = deferred<boolean>();
  f.confirmDelete.mockReturnValue(answer.promise);
  const service = f.service;
  const request = service.delete();
  await vi.waitFor(() => expect(f.confirmDelete).toHaveBeenCalledOnce());

  await service.stop();
  answer.resolve(true);

  expect(await request).toEqual({ success: false, code: 'not-ready' });
  expect(fs.existsSync(f.backup)).toBe(true);
});

test('stop joins the actual removal once it has started', async () => {
  const f = fixture();
  const release = deferred<void>();
  const unlink = fsp.unlink;
  const remove = vi.spyOn(fsp, 'unlink').mockImplementationOnce(async filename => {
    await release.promise;
    await unlink(filename);
  });
  const service = f.service;
  const request = service.delete();
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  let stopped = false;
  const stop = service.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release.resolve();

  expect(await request).toEqual({ success: true, value: null });
  await stop;
  expect(stopped).toBe(true);
  expect(fs.existsSync(f.backup)).toBe(false);
});

test.each([
  ['EBUSY', 'locked'], ['EACCES', 'access-denied'],
])('reports %s removal failures as %s without retrying the request', async (nativeCode, code) => {
  const f = fixture();
  const remove = vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(
    Object.assign(new Error('Synthetic removal error.'), { code: nativeCode }),
  );

  expect(await f.service.delete()).toEqual({ success: false, code });

  expect(remove).toHaveBeenCalledOnce();
  expect(fs.existsSync(f.backup)).toBe(true);
});

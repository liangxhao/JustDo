import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { BROWSER_PANEL_PARTITION } from '../../shared/browser/browser';
import { StorageDirectoryCategory } from '../../shared/storage/storageDirectory';
import { scanStorageDirectory, StorageDirectoryService } from './storageDirectoryService';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-directory-'));
  roots.push(root);
  return root;
}

async function file(root: string, name: string, bytes: number) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.alloc(bytes));
}

describe('data directory metadata scans', () => {
  test('counts only recognized direct partition cache roots and preserves site and unrelated data categories', async () => {
    const root = await fixture();
    const partition = BROWSER_PANEL_PARTITION.slice('persist:'.length);
    await file(root, `Partitions/${partition}/Cache/Cache_Data/data`, 11);
    await file(root, `Partitions/${partition}/Code Cache/js/data`, 7);
    await file(root, `Partitions/${partition}/GPUCache/data`, 3);
    await file(root, `Partitions/${partition}/Service Worker/CacheStorage/data`, 13);
    await file(root, `Partitions/${partition}/Network/Cookies`, 17);
    await file(root, `Partitions/${partition}/site/Cache/data`, 19);
    await file(root, 'Partitions/unmanaged/Cache/data', 23);
    await file(root, 'openclaw/state/plugin-data/sample/Cache/data', 29);

    const result = await scanStorageDirectory(root);

    expect(result.complete).toBe(true);
    expect(result.totalBytes).toBe(122);
    expect(result.categories).toContainEqual({ id: StorageDirectoryCategory.Cache, bytes: 21 });
    expect(result.categories).toContainEqual({ id: StorageDirectoryCategory.Plugins, bytes: 29 });
    expect(result.categories).toContainEqual({ id: StorageDirectoryCategory.Other, bytes: 72 });
  });

  test('counts each file once in mutually exclusive categories without reading file contents', async () => {
    const root = await fixture();
    await file(root, 'openclaw/state/agents/main/history.sqlite', 13);
    await file(root, 'openclaw/state/agents/main/history.sqlite-wal', 7);
    await file(root, 'backups/prior/openclaw/history.sqlite', 23);
    await file(root, 'openclaw/state/plugin-data/.host/artifacts/code.js', 5);
    await file(root, 'openclaw/state/plugin-data/sample/model.bin', 8);
    await file(root, 'openclaw/state/extensions/sample/index.js', 4);
    await file(root, 'openclaw/state/skills/sample/SKILL.md', 6);
    await file(root, 'Code Cache/cache-entry', 3);
    await file(root, 'Partitions/default/Network/Cookies', 11);
    await file(root, 'justdo.sqlite', 17);
    const readContents = vi.spyOn(fs, 'readFile');

    const result = await scanStorageDirectory(root);

    expect(result.complete).toBe(true);
    expect(result.totalBytes).toBe(97);
    expect(result.fileCount).toBe(10);
    expect(result.skippedEntries).toBe(0);
    expect(result.categories).toEqual([
      { id: StorageDirectoryCategory.Native, bytes: 20 },
      { id: StorageDirectoryCategory.Backups, bytes: 23 },
      { id: StorageDirectoryCategory.Cache, bytes: 3 },
      { id: StorageDirectoryCategory.Plugins, bytes: 23 },
      { id: StorageDirectoryCategory.SpeechModels, bytes: 0 },
      { id: StorageDirectoryCategory.Other, bytes: 28 },
    ]);
    expect(readContents).not.toHaveBeenCalled();
  });

  test('includes fixed upgrade backups without scanning the rest of the configuration folder', async () => {
    const active = await fixture();
    const bootstrap = await fixture();
    await file(active, 'justdo.sqlite', 5);
    await file(active, 'backups/legacy/archive', 7);
    await file(bootstrap, 'backups/upgrade/archive', 11);
    await file(bootstrap, 'justdo.sqlite', 17);

    const service = new StorageDirectoryService({
      getDirectory: () => active,
      backupRoot: bootstrap,
      openDirectory: vi.fn(),
    });
    const result = await service.scan();

    expect(result).toMatchObject({ success: true, value: {
      complete: true, totalBytes: 23, fileCount: 3,
      categories: expect.arrayContaining([
        { id: StorageDirectoryCategory.Backups, bytes: 11 },
        { id: StorageDirectoryCategory.Other, bytes: 12 },
      ]),
    } });
  });

  test('counts installed and partial speech models only below their top-level directory without overlapping other categories', async () => {
    const root = await fixture();
    await file(root, 'local-speech-models/model/model.onnx', 11);
    await file(root, 'local-speech-models/.downloads/model.tar.bz2.part', 13);
    await file(root, 'local-speech-models/.install-model/model/weights.bin', 17);
    await file(root, 'local-speech-models/Cache/partial-file', 19);
    await file(root, 'openclaw/state/plugin-data/sample/local-speech-models/model.bin', 23);
    await file(root, 'backups/prior/local-speech-models/model.bin', 29);
    await file(root, 'local-speech-models-old/model.bin', 31);
    await file(root, 'nested/local-speech-models/model.bin', 37);
    await file(root, 'openclaw/state/local-speech-models/model.bin', 41);
    const readContents = vi.spyOn(fs, 'readFile');

    const result = await scanStorageDirectory(root);

    expect(result.complete).toBe(true);
    expect(result.totalBytes).toBe(221);
    expect(result.fileCount).toBe(9);
    expect(result.categories).toEqual([
      { id: StorageDirectoryCategory.Native, bytes: 41 },
      { id: StorageDirectoryCategory.Backups, bytes: 29 },
      { id: StorageDirectoryCategory.Cache, bytes: 0 },
      { id: StorageDirectoryCategory.Plugins, bytes: 23 },
      { id: StorageDirectoryCategory.SpeechModels, bytes: 60 },
      { id: StorageDirectoryCategory.Other, bytes: 68 },
    ]);
    expect(result.categories.reduce((total, category) => total + category.bytes, 0)).toBe(result.totalBytes);
    expect(readContents).not.toHaveBeenCalled();
  });

  test('matches plugin directory boundaries only inside the current native state', async () => {
    const root = await fixture();
    await file(root, 'openclaw/state/plugin-data-backup/file', 5);
    await file(root, 'openclaw/extensions/sample/index.js', 7);
    await file(root, 'nested/openclaw/state/extensions/sample/index.js', 11);

    const result = await scanStorageDirectory(root);

    expect(result.complete).toBe(true);
    expect(result.totalBytes).toBe(23);
    expect(result.categories).toContainEqual({ id: StorageDirectoryCategory.Native, bytes: 12 });
    expect(result.categories).toContainEqual({ id: StorageDirectoryCategory.Plugins, bytes: 0 });
    expect(result.categories).toContainEqual({ id: StorageDirectoryCategory.Other, bytes: 11 });
  });

  test('does not traverse a directory link outside the profile and reports incomplete coverage', async () => {
    const root = await fixture();
    const outside = await fixture();
    await file(outside, 'outside.txt', 99);
    await fs.symlink(outside, path.join(root, 'linked'), 'junction');
    await file(root, 'settings.json', 5);

    const result = await scanStorageDirectory(root);

    expect(result.totalBytes).toBe(5);
    expect(result.complete).toBe(false);
    expect(result.skippedEntries).toBe(1);
  });

  test('reports partial coverage for a metadata error instead of treating it as an empty file', async () => {
    const root = await fixture();
    await file(root, 'locked', 23);
    const original = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((...args) => {
      if (args[0] === path.join(root, 'locked')) return Promise.reject(new Error('denied'));
      return original(...args);
    });

    const result = await scanStorageDirectory(root);

    expect(result.totalBytes).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.skippedEntries).toBe(1);
  });

  test('bounds traversal and never marks a truncated scan complete', async () => {
    const root = await fixture();
    await file(root, 'a', 3);
    await file(root, 'b', 5);

    const result = await scanStorageDirectory(root, { limits: { maxEntries: 1 } });

    expect(result.complete).toBe(false);
    expect(result.fileCount).toBe(1);
    expect(result.skippedEntries).toBeGreaterThan(0);
  });

  test('fails an unreadable root instead of returning a successful empty scan', async () => {
    const root = await fixture();

    await expect(scanStorageDirectory(path.join(root, 'missing'))).rejects.toThrow();
  });
});

describe('data directory service', () => {
  test('opens the current configuration folder and refuses a missing location without falling back to data', async () => {
    let bootstrapDirectory: string | undefined = 'fixed-profile';
    const getDirectory = vi.fn(() => 'active-data');
    const openDirectory = vi.fn().mockResolvedValue('');
    const service = new StorageDirectoryService({
      getDirectory,
      getBootstrapDirectory: () => bootstrapDirectory,
      openDirectory,
    });

    expect(await service.openConfig()).toEqual({ success: true, value: null });
    expect(openDirectory).toHaveBeenLastCalledWith('fixed-profile');
    bootstrapDirectory = 'other-fixed-profile';
    expect(await service.openConfig()).toEqual({ success: true, value: null });
    expect(openDirectory).toHaveBeenLastCalledWith('other-fixed-profile');
    bootstrapDirectory = undefined;
    expect(await service.openConfig()).toEqual({ success: false, code: 'unavailable' });
    expect(openDirectory).toHaveBeenCalledTimes(2);
    expect(getDirectory).not.toHaveBeenCalled();
  });

  test('rejects a second scan while the first is pending and releases the slot after failure', async () => {
    let rejectScan!: (reason: Error) => void;
    const scan = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectScan = reject;
          }),
      )
      .mockRejectedValueOnce(new Error('failed'));
    const service = new StorageDirectoryService({
      getDirectory: () => 'current-profile',
      openDirectory: vi.fn(),
      scan,
    });
    const pending = service.scan();

    expect(await service.scan()).toEqual({ success: false, code: 'busy' });
    rejectScan(new Error('failed'));
    expect(await pending).toEqual({ success: false, code: 'unavailable' });
    expect(await service.scan()).toEqual({ success: false, code: 'unavailable' });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  test('resolves the current Main directory per operation and handles shell errors without exposing them', async () => {
    let directory = 'profile-a';
    const openDirectory = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('private shell detail');
    const service = new StorageDirectoryService({
      getDirectory: () => directory,
      getBootstrapDirectory: () => 'fixed-profile',
      openDirectory,
    });

    expect(service.info()).toEqual({
      success: true, value: { path: 'profile-a', bootstrapPath: 'fixed-profile' },
    });
    directory = 'profile-b';
    expect(service.info()).toEqual({
      success: true, value: { path: 'profile-b', bootstrapPath: 'fixed-profile' },
    });
    expect(await service.open()).toEqual({ success: true, value: null });
    expect(openDirectory).toHaveBeenLastCalledWith('profile-b');
    expect(await service.open()).toEqual({ success: false, code: 'unavailable' });
  });
});

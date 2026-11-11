import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { StorageCleanupPhase, type StorageCleanupProgressUpdate } from '../../shared/storage/storageDirectory';
import { acquireBackgroundBrowserStorage } from '../browser/data/backgroundBrowserStorage';
import { BrowserCacheService, type BrowserCacheSession } from './browserCacheService';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function browserSession(directory: string) {
  return {
    getStoragePath: vi.fn(() => directory),
    clearCache: vi.fn(async () => {}),
    clearCodeCaches: vi.fn(async (_options: Electron.ClearCodeCachesOptions) => {}),
    clearStorageData: vi.fn(async (_options?: Electron.ClearStorageDataOptions) => {}),
    clearData: vi.fn(),
    clearAuthCache: vi.fn(),
  };
}
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cache-service-')));
  roots.push(root);
  let directory = root;
  const first = browserSession(root);
  const secondDirectory = path.join(root, 'Partitions', 'justdo-browser');
  fs.mkdirSync(secondDirectory, { recursive: true });
  const second = browserSession(secondDirectory);
  const release = vi.fn();
  const deps = {
    getDirectory: () => directory,
    isReady: vi.fn(() => true),
    collectSessions: vi.fn(async (_root: string): Promise<BrowserCacheSession[]> => [first, second, first]),
    stopSessions: vi.fn(),
    reserveStorage: vi.fn(() => release),
  };
  return { root, first, second, deps, release, service: new BrowserCacheService(deps), setDirectory: (value: string) => { directory = value; } };
}

test('clears each Session once with only HTTP, generated-code and shader APIs', async () => {
  const f = fixture();

  expect(await f.service.clear()).toEqual({ success: true, value: null });

  expect(f.deps.collectSessions).toHaveBeenCalledExactlyOnceWith(f.root);
  for (const target of [f.first, f.second]) {
    expect(target.clearCache).toHaveBeenCalledExactlyOnceWith();
    expect(target.clearCodeCaches).toHaveBeenCalledExactlyOnceWith({ urls: [] });
    expect(target.clearStorageData).toHaveBeenCalledExactlyOnceWith({ storages: ['shadercache'] });
    expect(target.clearData).not.toHaveBeenCalled();
    expect(target.clearAuthCache).not.toHaveBeenCalled();
  }
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.service.isBusy()).toBe(false);
});

test('reports completed profiles only after all of their real cache APIs settle', async () => {
  const f = fixture();
  const pending = deferred<void>();
  f.first.clearStorageData.mockReturnValueOnce(pending.promise);
  const updates: StorageCleanupProgressUpdate[] = [];
  const request = f.service.clear(undefined, update => { updates.push(update); });
  await vi.waitFor(() => expect(updates.some(update => update.sessionsCompleted === 1)).toBe(true));
  expect(updates[0]).toEqual({ phase: StorageCleanupPhase.Checking });
  expect(updates.at(-1)).toEqual({ phase: StorageCleanupPhase.Clearing, sessionsCompleted: 1, sessionsTotal: 2 });

  pending.resolve();

  expect(await request).toEqual({ success: true, value: null });
  expect(updates.at(-1)).toEqual({ phase: StorageCleanupPhase.Clearing, sessionsCompleted: 2, sessionsTotal: 2 });
});

test('reserves busy before collection awaits and does not duplicate a pending cleanup', async () => {
  const f = fixture();
  const collection = deferred<BrowserCacheSession[]>();
  f.deps.collectSessions.mockReturnValueOnce(collection.promise);
  const request = f.service.clear();

  expect(f.service.isBusy()).toBe(true);
  expect(await f.service.clear()).toEqual({ success: false, code: 'busy' });
  collection.resolve([f.first]);

  expect(await request).toEqual({ success: true, value: null });
  expect(f.first.clearCache).toHaveBeenCalledOnce();
});

test('refuses active background browser storage without starting collection', async () => {
  const f = fixture();
  const releasePage = acquireBackgroundBrowserStorage('persistent-profile');
  const service = new BrowserCacheService({ ...f.deps, reserveStorage: undefined });
  try {
    expect(await service.clear()).toEqual({ success: false, code: 'busy' });
    expect(f.deps.collectSessions).not.toHaveBeenCalled();
  } finally { releasePage(); }
});

test.each(['caller', 'readiness', 'profile'] as const)('rejects %s changes while collection is pending', async change => {
  const f = fixture();
  const collection = deferred<BrowserCacheSession[]>();
  f.deps.collectSessions.mockReturnValueOnce(collection.promise);
  let caller = true;
  const request = f.service.clear(() => caller);
  if (change === 'caller') caller = false;
  if (change === 'readiness') f.deps.isReady.mockReturnValue(false);
  if (change === 'profile') f.setDirectory(path.join(f.root, 'another-profile'));
  collection.resolve([f.first]);

  expect(await request).toEqual({ success: false, code: change === 'caller' ? 'forbidden' : 'not-ready' });
  expect(f.first.clearCache).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

test('waits for every already-issued Session operation after another Session fails', async () => {
  const f = fixture();
  const pending = deferred<void>();
  f.first.clearCache.mockRejectedValueOnce(new Error('Cache owner failure.'));
  f.second.clearCache.mockReturnValueOnce(pending.promise);
  let settled = false;
  const request = f.service.clear().then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(f.second.clearCache).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  expect(f.service.isBusy()).toBe(true);

  pending.resolve();

  expect(await request).toEqual({ success: false, code: 'unavailable' });
  expect(f.first.clearCodeCaches).not.toHaveBeenCalled();
  expect(f.second.clearCodeCaches).toHaveBeenCalledOnce();
  expect(f.second.clearStorageData).toHaveBeenCalledOnce();
  expect(f.first.clearCache).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});

test('stop fences late collection and joins it before returning', async () => {
  const f = fixture();
  const collection = deferred<BrowserCacheSession[]>();
  f.deps.collectSessions.mockReturnValueOnce(collection.promise);
  const request = f.service.clear();
  let stopped = false;
  const stop = f.service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(f.deps.stopSessions).toHaveBeenCalledOnce();
  expect(stopped).toBe(false);

  collection.resolve([f.first]);

  expect(await request).toEqual({ success: false, code: 'not-ready' });
  await stop;
  expect(stopped).toBe(true);
  expect(f.first.clearCache).not.toHaveBeenCalled();
  expect(await f.service.clear()).toEqual({ success: false, code: 'not-ready' });
});

test('stop joins issued API work and prevents the following code and shader operations', async () => {
  const f = fixture();
  const pending = deferred<void>();
  f.first.clearCache.mockReturnValueOnce(pending.promise);
  f.deps.collectSessions.mockResolvedValueOnce([f.first]);
  const request = f.service.clear();
  await vi.waitFor(() => expect(f.first.clearCache).toHaveBeenCalledOnce());
  let stopped = false;
  const stop = f.service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);

  pending.resolve();

  expect(await request).toEqual({ success: false, code: 'not-ready' });
  await stop;
  expect(f.first.clearCodeCaches).not.toHaveBeenCalled();
  expect(f.first.clearStorageData).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

test('a newly linked cache directory blocks the next API without touching its external target', async () => {
  const f = fixture();
  f.deps.collectSessions.mockResolvedValueOnce([f.first]);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'unchanged');
  f.first.clearCache.mockImplementationOnce(async () => {
    fs.symlinkSync(outside, path.join(f.root, 'Code Cache'), process.platform === 'win32' ? 'junction' : 'dir');
  });

  expect(await f.service.clear()).toEqual({ success: false, code: 'unavailable' });

  expect(f.first.clearCodeCaches).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('unchanged');
});

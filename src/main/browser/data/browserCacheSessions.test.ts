import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { BROWSER_PANEL_PARTITION } from '../../../shared/browser/browser';
import type { BrowserCacheSession } from '../../storage/browserCacheService';
import { createBrowserCacheSessions } from './browserCacheSessions';

vi.mock('electron', () => ({ app: {}, session: {}, webContents: {} }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function browserSession(directory: string | null): BrowserCacheSession {
  return {
    getStoragePath: vi.fn(() => directory),
    clearCache: vi.fn(async () => {}),
    clearCodeCaches: vi.fn(async () => {}),
    clearStorageData: vi.fn(async () => {}),
  };
}
function fixture() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cache-sessions-')));
  roots.push(parent);
  const root = path.join(parent, '资料 with spaces');
  fs.mkdirSync(root);
  const defaultSession = browserSession(root);
  let created!: (value: BrowserCacheSession) => void;
  const unsubscribe = vi.fn();
  const deps = {
    subscribeCreated: vi.fn((listener: typeof created) => { created = listener; return unsubscribe; }),
    getDefaultSession: vi.fn(() => defaultSession),
    getActiveSessions: vi.fn((): BrowserCacheSession[] => []),
    fromPartition: vi.fn((partition: string) => browserSession(path.join(root, 'Partitions', partition.slice('persist:'.length)))),
  };
  return { parent, root, defaultSession, deps, unsubscribe, created: (value: BrowserCacheSession) => created(value) };
}
function file(root: string, relative: string, bytes = 'preserve') {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

test('collects default, active, tracked and dormant known profiles once without reading site storage', async () => {
  const f = fixture();
  const embedded = path.join(f.root, 'Partitions', BROWSER_PANEL_PARTITION.slice('persist:'.length));
  fs.mkdirSync(embedded, { recursive: true });
  const active = browserSession(embedded);
  const named = path.join(f.root, 'Partitions', 'justdo-browser-profile-work');
  fs.mkdirSync(named);
  const cookie = file(f.root, 'Partitions/justdo-browser/Network/Cookies', 'cookie fixture');
  const site = file(f.root, 'Partitions/justdo-browser/Service Worker/CacheStorage/site', 'offline site fixture');
  file(f.root, 'Partitions/not-managed/Cache/entry');
  file(f.root, 'Cache/http');
  file(embedded, 'Code Cache/js/compiled');
  f.deps.getActiveSessions.mockReturnValue([active, f.defaultSession, browserSession(null), browserSession(f.parent)]);
  const collector = createBrowserCacheSessions(f.deps);
  f.created(active);
  const read = vi.spyOn(fsp, 'readFile');
  const open = vi.spyOn(fsp, 'opendir');

  const result = await collector.collect(f.root);

  expect(result).toHaveLength(3);
  expect(result).toContain(f.defaultSession);
  expect(result).toContain(active);
  expect(f.deps.fromPartition).toHaveBeenCalledExactlyOnceWith('persist:justdo-browser-profile-work');
  expect(read).not.toHaveBeenCalled();
  expect(open.mock.calls.some(([directory]) => String(directory).includes('Network') || String(directory).includes('Service Worker'))).toBe(false);
  expect(fs.readFileSync(cookie, 'utf8')).toBe('cookie fixture');
  expect(fs.readFileSync(site, 'utf8')).toBe('offline site fixture');
  collector.stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});

test('does not create missing partitions just to clean caches', async () => {
  const f = fixture();
  const collector = createBrowserCacheSessions(f.deps);

  expect(await collector.collect(f.root)).toEqual([f.defaultSession]);

  expect(f.deps.fromPartition).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.root, 'Partitions'))).toBe(false);
});

test.each(['partition', 'cache', 'nested cache'] as const)('rejects a linked %s boundary without touching external bytes', async boundary => {
  const f = fixture();
  const outside = path.join(f.parent, 'outside');
  const keep = file(outside, 'keep');
  const linked = boundary === 'partition'
    ? path.join(f.root, 'Partitions', 'justdo-browser')
    : path.join(f.root, boundary === 'cache' ? 'Cache' : 'Cache/nested/linked');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const collector = createBrowserCacheSessions(f.deps);

  await expect(collector.collect(f.root)).rejects.toMatchObject({ code: 'unavailable' });

  expect(f.deps.fromPartition).not.toHaveBeenCalled();
  expect(fs.readFileSync(keep, 'utf8')).toBe('preserve');
});

test('rejects hard-linked cache files without examining unrelated store trees', async () => {
  const f = fixture();
  const filename = file(f.root, 'Cache/linked');
  const outside = path.join(f.parent, 'outside-file');
  fs.linkSync(filename, outside);
  const collector = createBrowserCacheSessions(f.deps);

  await expect(collector.collect(f.root)).rejects.toMatchObject({ code: 'unavailable' });

  expect(fs.readFileSync(outside, 'utf8')).toBe('preserve');
  expect(f.deps.fromPartition).not.toHaveBeenCalled();
});

test('tolerates one cache file disappearing during normal browser activity', async () => {
  const f = fixture();
  const filename = file(f.root, 'Cache/expired');
  const original = fsp.lstat;
  vi.spyOn(fsp, 'lstat').mockImplementation((...args) => {
    if (args[0] === filename) return Promise.reject(Object.assign(new Error('evicted'), { code: 'ENOENT' }));
    return original(...args);
  });
  const collector = createBrowserCacheSessions(f.deps);

  expect(await collector.collect(f.root)).toEqual([f.defaultSession]);
});

test('stop during opendir closes the obtained handle and prevents late Session creation', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.root, 'Partitions', 'justdo-browser'), { recursive: true });
  const opened = deferred<fs.Dir>();
  const original = fsp.opendir;
  let handle!: fs.Dir;
  vi.spyOn(fsp, 'opendir').mockImplementationOnce((async (...args: Parameters<typeof fsp.opendir>) => {
    handle = await original(...args);
    vi.spyOn(handle, 'close');
    return opened.promise;
  }) as typeof fsp.opendir);
  const collector = createBrowserCacheSessions(f.deps);
  const request = collector.collect(f.root);
  const rejected = expect(request).rejects.toMatchObject({ code: 'not-ready' });
  await vi.waitFor(() => expect(handle).toBeDefined());

  collector.stop();
  opened.resolve(handle);

  await rejected;
  expect(handle.close).toHaveBeenCalledOnce();
  expect(f.deps.fromPartition).not.toHaveBeenCalled();
  await expect(collector.collect(f.root)).rejects.toMatchObject({ code: 'not-ready' });
});

test('rejects a replacement of the active root while metadata enumeration is pending', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.root, 'Partitions', 'justdo-browser'), { recursive: true });
  const pending = deferred<void>();
  const original = fsp.lstat;
  vi.spyOn(fsp, 'lstat').mockImplementationOnce((async (...args: Parameters<typeof fsp.lstat>) => {
    await pending.promise;
    return original(...args);
  }) as typeof fsp.lstat);
  const collector = createBrowserCacheSessions(f.deps);
  const request = collector.collect(f.root);
  const rejected = expect(request).rejects.toMatchObject({ code: 'unavailable' });
  fs.renameSync(f.root, `${f.root}-retained`);
  fs.mkdirSync(path.join(f.root, 'Partitions', 'justdo-browser'), { recursive: true });
  pending.resolve();

  await rejected;
  expect(f.deps.fromPartition).not.toHaveBeenCalled();
  expect(fs.existsSync(`${f.root}-retained`)).toBe(true);
});

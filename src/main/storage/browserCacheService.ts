import fs from 'node:fs';
import path from 'node:path';

import {
  StorageCleanupPhase,
  type StorageCleanupProgressUpdate,
  StorageDirectoryError,
  type StorageDirectoryResult,
} from '../../shared/storage/storageDirectory';
import { reserveBackgroundBrowserStorageClear } from '../browser/data/backgroundBrowserStorage';
import { BROWSER_CACHE_DIRECTORIES, isManagedBrowserPartitionDirectory } from './browserCachePaths';
import { assertCanonicalDirectory } from './relocationState';

export type BrowserCacheSession = Pick<Electron.Session,
  'getStoragePath' | 'clearCache' | 'clearCodeCaches' | 'clearStorageData'>;
type RootIdentity = { dev: bigint; ino: bigint; birthtimeNs: bigint };
const key = (directory: string) => process.platform === 'win32' ? directory.toLowerCase() : directory;
const failure = (code: typeof StorageDirectoryError[keyof typeof StorageDirectoryError]) =>
  Object.assign(new Error('Browser cache cleanup is unavailable.'), { code });
const identity = (directory: string): RootIdentity => {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(StorageDirectoryError.Unavailable);
  return stat;
};
const same = (left: RootIdentity, right: RootIdentity) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;

/** Session owners clear only rebuildable caches; site storage and authentication are untouched. */
export class BrowserCacheService {
  private busy = false;
  private stopped = false;
  private work?: Promise<StorageDirectoryResult<null>>;

  constructor(private readonly deps: {
    getDirectory: () => string;
    isReady: () => boolean;
    collectSessions: (root: string) => Promise<BrowserCacheSession[]>;
    stopSessions?: () => void;
    reserveStorage?: () => (() => void) | null;
  }) {}

  isBusy(): boolean { return this.busy; }

  clear(
    isCallerCurrent: () => boolean = () => true,
    onProgress?: (update: StorageCleanupProgressUpdate) => void,
  ): Promise<StorageDirectoryResult<null>> {
    if (this.stopped) return Promise.resolve({ success: false, code: StorageDirectoryError.NotReady });
    if (this.busy) return Promise.resolve({ success: false, code: StorageDirectoryError.Busy });
    this.busy = true;
    const report = (update: StorageCleanupProgressUpdate) => {
      try { onProgress?.(update); }
      catch { /* Presentation cannot change cleanup outcome or retirement. */ }
    };
    const work = this.perform(isCallerCurrent, report).catch((error: unknown): StorageDirectoryResult<null> => {
      const code = (error as { code?: string })?.code;
      return { success: false, code: code === StorageDirectoryError.NotReady ||
        code === StorageDirectoryError.Forbidden || code === StorageDirectoryError.Busy
        ? code : StorageDirectoryError.Unavailable };
    }).finally(() => {
      this.busy = false;
      if (this.work === work) this.work = undefined;
    });
    this.work = work;
    return work;
  }

  private async perform(
    isCallerCurrent: () => boolean,
    report: (update: StorageCleanupProgressUpdate) => void,
  ): Promise<StorageDirectoryResult<null>> {
    const root = assertCanonicalDirectory(this.deps.getDirectory());
    const expectedRoot = identity(root);
    const assertCurrent = () => {
      if (this.stopped || !this.deps.isReady() || key(this.deps.getDirectory()) !== key(root))
        throw failure(StorageDirectoryError.NotReady);
      try {
        if (!isCallerCurrent()) throw failure(StorageDirectoryError.Forbidden);
      } catch { throw failure(StorageDirectoryError.Forbidden); }
      if (key(assertCanonicalDirectory(root)) !== key(root) || !same(expectedRoot, identity(root)))
        throw failure(StorageDirectoryError.NotReady);
    };
    assertCurrent();
    const release = (this.deps.reserveStorage ?? reserveBackgroundBrowserStorageClear)();
    if (!release) throw failure(StorageDirectoryError.Busy);
    try {
      assertCurrent();
      report({ phase: StorageCleanupPhase.Checking });
      assertCurrent();
      const sessions = await this.deps.collectSessions(root);
      assertCurrent();
      const unique = new Map<string, { session: BrowserCacheSession; directory: string; physical: RootIdentity }>();
      for (const session of sessions) {
        const directory = session.getStoragePath();
        if (!directory) throw failure(StorageDirectoryError.Unavailable);
        const relative = path.relative(root, directory);
        if (relative && (path.dirname(relative) !== 'Partitions' ||
            !isManagedBrowserPartitionDirectory(path.basename(relative))))
          throw failure(StorageDirectoryError.Unavailable);
        assertCanonicalDirectory(directory);
        if (!unique.has(key(directory))) unique.set(key(directory), { session, directory, physical: identity(directory) });
      }
      let sessionsCompleted = 0;
      report({ phase: StorageCleanupPhase.Clearing, sessionsCompleted, sessionsTotal: unique.size });
      const results = await Promise.allSettled([...unique.values()].map(async target => {
        const check = () => {
          assertCurrent();
          if (target.session.getStoragePath() !== target.directory ||
              key(assertCanonicalDirectory(target.directory)) !== key(target.directory) ||
              !same(target.physical, identity(target.directory))) throw failure(StorageDirectoryError.NotReady);
          for (const name of BROWSER_CACHE_DIRECTORIES) {
            const cache = path.join(target.directory, name);
            try { assertCanonicalDirectory(cache); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        };
        check();
        await target.session.clearCache();
        check();
        await target.session.clearCodeCaches({ urls: [] });
        check();
        await target.session.clearStorageData({ storages: ['shadercache'] });
        sessionsCompleted++;
        report({ phase: StorageCleanupPhase.Clearing, sessionsCompleted, sessionsTotal: unique.size });
      }));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      return { success: true, value: null };
    } finally { release(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { this.deps.stopSessions?.(); }
    finally { await this.work; }
  }
}

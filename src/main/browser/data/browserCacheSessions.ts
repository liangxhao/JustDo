import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { app, session, webContents } from 'electron';

import {
  BROWSER_CACHE_DIRECTORIES,
  isManagedBrowserPartitionDirectory,
} from '../../storage/browserCachePaths';
import type { BrowserCacheSession } from '../../storage/browserCacheService';
import { assertCanonicalDirectory as requireCanonicalDirectory } from '../../storage/relocationState';

type PhysicalIdentity = { dev: bigint; ino: bigint; birthtimeNs: bigint };
type Dependencies = {
  subscribeCreated: (listener: (value: BrowserCacheSession) => void) => () => void;
  getDefaultSession: () => BrowserCacheSession;
  getActiveSessions: () => BrowserCacheSession[];
  fromPartition: (partition: string) => BrowserCacheSession;
};
const key = (directory: string) => process.platform === 'win32' ? directory.toLowerCase() : directory;
const unavailable = () => Object.assign(new Error('Browser cache sessions are unavailable.'), { code: 'unavailable' });
const stoppedError = () => Object.assign(new Error('Browser cache collection has stopped.'), { code: 'not-ready' });
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const assertCanonicalDirectory = (directory: string): string => {
  try { return requireCanonicalDirectory(directory); }
  catch (error) { if (missing(error)) throw error; throw unavailable(); }
};
const identity = (directory: string): PhysicalIdentity => {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return stat;
};
const same = (left: PhysicalIdentity, right: PhysicalIdentity) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;

/** Collect original Session identities; never reopen a partition through fromPath. */
export function createBrowserCacheSessions(deps: Dependencies = {
  subscribeCreated: listener => {
    app.on('session-created', listener);
    return () => { app.removeListener('session-created', listener); };
  },
  getDefaultSession: () => session.defaultSession,
  getActiveSessions: () => webContents.getAllWebContents().filter(value => !value.isDestroyed()).map(value => value.session),
  fromPartition: partition => session.fromPartition(partition),
}) {
  let stopped = false;
  const tracked = new Map<string, BrowserCacheSession>();
  const unsubscribe = deps.subscribeCreated(value => {
    if (stopped) return;
    try {
      const directory = value.getStoragePath();
      if (directory) tracked.set(key(directory), value);
    } catch { /* A retired Session cannot become a cleanup target. */ }
  });
  return {
    stop: () => { stopped = true; unsubscribe(); tracked.clear(); },
    collect: async (root: string): Promise<BrowserCacheSession[]> => {
      if (stopped) throw stoppedError();
      const canonical = assertCanonicalDirectory(root);
      const rootPhysical = identity(canonical);
      const check = () => {
        if (stopped) throw stoppedError();
      };
      const assertRoot = () => {
        check();
        assertCanonicalDirectory(root);
        if (!same(rootPhysical, identity(root)))
          throw unavailable();
      };
      const visitDirectory = async (directory: string, visit: (entry: fs.Dirent) => Promise<void> | void) => {
        const stream = await fsp.opendir(directory);
        if (stopped) {
          await stream.close();
          throw stoppedError();
        }
        for await (const entry of stream) {
          check();
          await visit(entry);
        }
        check();
      };
      const roots = new Map<string, { directory: string; physical: PhysicalIdentity; partition?: string }>([
        [key(canonical), { directory: canonical, physical: rootPhysical }],
      ]);
      const partitions = path.join(canonical, 'Partitions');
      let partitionsPresent = false;
      try {
        await fsp.lstat(partitions);
        partitionsPresent = true;
        assertRoot();
        assertCanonicalDirectory(partitions);
        const before = identity(partitions);
        await visitDirectory(partitions, entry => {
          if (!isManagedBrowserPartitionDirectory(entry.name)) return;
          const directory = path.join(partitions, entry.name);
          assertCanonicalDirectory(directory);
          roots.set(key(directory), { directory, physical: identity(directory), partition: `persist:${entry.name}` });
        });
        assertRoot();
        assertCanonicalDirectory(partitions);
        if (!same(before, identity(partitions))) throw unavailable();
      } catch (error) {
        check();
        if (partitionsPresent || !missing(error)) throw error;
      }

      // Only the five rebuildable cache trees are inspected. Cookie and site stores are never opened.
      for (const owner of roots.values()) for (const name of BROWSER_CACHE_DIRECTORIES) {
        const pending = [path.join(owner.directory, name)];
        while (pending.length) {
          check();
          const current = pending.pop()!;
          try {
            const stat = await fsp.lstat(current);
            check();
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
            assertCanonicalDirectory(current);
            await visitDirectory(current, async entry => {
              const filename = path.join(current, entry.name);
              try {
                const metadata = await fsp.lstat(filename);
                if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1)))
                  throw unavailable();
                if (metadata.isDirectory()) pending.push(filename);
              } catch (error) { check(); if (!missing(error)) throw error; }
            });
            try { assertCanonicalDirectory(current); }
            catch (error) { if (!missing(error)) throw error; }
          } catch (error) { check(); if (!missing(error)) throw error; }
        }
      }
      assertRoot();
      const result = new Map<string, BrowserCacheSession>();
      const add = (value: BrowserCacheSession) => {
        check();
        const directory = value.getStoragePath();
        if (!directory) return;
        const owner = roots.get(key(directory));
        if (!owner) return;
        assertCanonicalDirectory(directory);
        if (!same(owner.physical, identity(directory))) throw unavailable();
        if (!result.has(key(directory))) result.set(key(directory), value);
      };
      for (const value of [deps.getDefaultSession(), ...deps.getActiveSessions(), ...tracked.values()]) add(value);
      for (const owner of roots.values()) {
        check();
        if (owner.partition && !result.has(key(owner.directory))) {
          assertCanonicalDirectory(owner.directory);
          if (!same(owner.physical, identity(owner.directory))) throw unavailable();
          const value = deps.fromPartition(owner.partition);
          check();
          if (key(value.getStoragePath() ?? '') !== key(owner.directory)) throw unavailable();
          add(value);
        }
      }
      assertRoot();
      for (const owner of roots.values()) {
        assertCanonicalDirectory(owner.directory);
        if (!same(owner.physical, identity(owner.directory))) throw unavailable();
      }
      return [...result.values()];
    },
  };
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { UPGRADE_BACKUP_DIRECTORY } from '../../shared/storage/storageDirectory';
import {
  readRelocationCleanupReceipt,
  type RelocationCleanupEntry,
  type RelocationCleanupKind,
  relocationCleanupPathKey,
  retireRelocationCleanupReceipt,
  sameCleanupPhysical,
} from './relocationCleanupReceipt';
import { relocationPhysicalIdentity } from './relocationFiles';
import { sourceCleanupSqliteFamily } from './relocationSourceCleanupSelection';
import {
  assertCanonicalDirectory,
  isTerminalRelocationStage,
  readRelocationJournal,
  readStorageLocator,
  readStorageRootIdentity,
} from './relocationState';
import { StorageStartupFailure } from './storageStartupFailure';

export type RelocationCleanupProtectedPaths = {
  directories: readonly string[];
  files: readonly string[];
};

type CleanupOptions = {
  bootstrapRoot: string;
  activeRoot: string;
  signal: AbortSignal;
  getProtectedPaths: (activeRoot: string) => RelocationCleanupProtectedPaths;
};

type CleanupResult = { removed: number; preserved: number; pending: boolean; failure?: unknown };
const kinds: readonly RelocationCleanupKind[] = ['openclaw', 'copied'];
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

function protectionFor(root: string, references: RelocationCleanupProtectedPaths) {
  const absoluteKey = (value: string) => relocationCleanupPathKey(path.toNamespacedPath(value));
  const source = absoluteKey(root);
  const prefix = `${source}${path.sep}`;
  const directories = new Set<string>();
  const files = new Set<string>();
  const parents = new Set<string>();
  const inside = (key: string) => key === source || key.startsWith(prefix);
  const add = (reference: string, collection: Set<string>) => {
    if (!path.isAbsolute(reference)) return;
    const resolved = path.resolve(reference);
    const locations = [resolved];
    try { locations.push(fs.realpathSync.native(resolved)); }
    catch { /* The configured spelling remains protected if it is currently absent. */ }
    for (const location of locations) {
      const key = absoluteKey(location);
      if (!inside(key)) continue;
      collection.add(key);
      for (let parent = path.dirname(key); inside(parent) && !parents.has(parent); parent = path.dirname(parent))
        parents.add(parent);
    }
  };
  for (const directory of references.directories) add(directory, directories);
  for (const file of references.files) add(file, files);

  return (filename: string, directory: boolean) => {
    const key = absoluteKey(filename);
    if (files.has(key) || (directory && parents.has(key))) return true;
    for (let ancestor = key; inside(ancestor); ancestor = path.dirname(ancestor)) {
      if (directories.has(ancestor)) return true;
    }
    return false;
  };
}

function inspectSourceEntry(filename: string, entry?: RelocationCleanupEntry) {
  const parent = path.dirname(filename);
  try {
    if (relocationCleanupPathKey(fs.realpathSync.native(parent)) !== relocationCleanupPathKey(parent))
      return 'changed';
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  const stat = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
  if (!stat) return 'missing';
  if (!entry) return 'changed';
  const file = entry.kind === 'file';
  if (stat.isSymbolicLink() || (file ? !stat.isFile() : !stat.isDirectory()) ||
    !sameCleanupPhysical(entry.physical, relocationPhysicalIdentity(stat), file) ||
    relocationCleanupPathKey(fs.realpathSync.native(filename)) !== relocationCleanupPathKey(filename))
    return 'changed';
  return 'owned';
}

function cleanupUnits(entries: readonly RelocationCleanupEntry[]) {
  type Unit = { entries: RelocationCleanupEntry[]; sqliteBase?: string };
  const units: Unit[] = [];
  const families = new Map<string, Unit>();
  const directories: RelocationCleanupEntry[] = [];
  for (const entry of entries) {
    if (entry.relativePath.split('/', 1)[0].toLowerCase() === UPGRADE_BACKUP_DIRECTORY) continue;
    if (entry.kind === 'directory') {
      directories.push(entry);
      continue;
    }
    const base = sourceCleanupSqliteFamily(entry.relativePath);
    if (!base) {
      units.push({ entries: [entry] });
      continue;
    }
    const key = relocationCleanupPathKey(base);
    const family = families.get(key);
    if (family) family.entries.push(entry);
    else {
      const unit = { entries: [entry], sqliteBase: base };
      families.set(key, unit);
      units.push(unit);
    }
  }
  for (const [key, family] of families) {
    const primary = family.entries.findIndex(entry => relocationCleanupPathKey(entry.relativePath) === key);
    if (primary >= 0) family.entries.push(...family.entries.splice(primary, 1));
  }
  directories.sort((left, right) => right.relativePath.length - left.relativePath.length);
  return [...units, ...directories.map(entry => ({ entries: [entry] } as Unit))];
}

function hasChangedSqliteMember(
  sourceRoot: string,
  base: string,
  entries: readonly RelocationCleanupEntry[],
  isProtected: ReturnType<typeof protectionFor>,
): boolean {
  const expected = new Map(entries.map(entry => [relocationCleanupPathKey(entry.relativePath), entry]));
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const relative = `${base}${suffix}`;
    const filename = path.join(sourceRoot, ...relative.split('/'));
    if (isProtected(filename, false) ||
      inspectSourceEntry(filename, expected.get(relocationCleanupPathKey(relative))) === 'changed') return true;
  }
  return false;
}

/** Called offline after the locator switches and all source writers have exited. */
export async function cleanRelocationSource(options: CleanupOptions): Promise<CleanupResult> {
  const result: CleanupResult = { removed: 0, preserved: 0, pending: false };
  const { bootstrapRoot, activeRoot, signal } = options;
  const journal = readRelocationJournal(bootstrapRoot);
  if (!journal || isTerminalRelocationStage(journal.stage)) return result;
  const locator = readStorageLocator(bootstrapRoot);
  if (!locator || locator.activeRoot !== activeRoot || locator.activeRoot !== journal.targetRoot ||
    locator.activeRootId !== journal.targetRootId || locator.profileId !== journal.profileId ||
    locator.revision !== journal.sourceRevision + 1) return { ...result, pending: true };

  const receipts: NonNullable<ReturnType<typeof readRelocationCleanupReceipt>>[] = [];
  for (const kind of kinds) {
    try {
      const receipt = readRelocationCleanupReceipt(journal, kind);
      if (receipt) receipts.push(receipt);
    } catch (error) {
      result.pending = true;
      result.failure ??= error;
    }
  }
  if (!receipts.length) return result;
  if (signal.aborted) return { ...result, pending: true };

  let sourceRoot: string;
  let sourcePhysical: ReturnType<typeof relocationPhysicalIdentity>;
  let isProtected: ReturnType<typeof protectionFor> | undefined;
  try {
    sourceRoot = assertCanonicalDirectory(journal.sourceRoot);
    const identity = readStorageRootIdentity(sourceRoot);
    if (identity?.profileId !== journal.profileId || identity.rootId !== journal.sourceRootId)
      return result;
    sourcePhysical = relocationPhysicalIdentity(fs.lstatSync(sourceRoot, { bigint: true }));
  } catch (error) {
    if (hasCode(error, 'ENOENT') || (error instanceof StorageStartupFailure &&
      (error.location === 'folderAlias' || error.location === 'notFolder'))) return result;
    return { ...result, pending: true, failure: result.failure ?? error };
  }

  for (const receipt of receipts) {
    if (!sameCleanupPhysical(receipt.sourcePhysical, sourcePhysical, false)) {
      result.preserved += receipt.entries.length;
      continue;
    }
    if (signal.aborted) return { ...result, pending: true };
    if (receipt.kind === 'openclaw') {
      const [entry] = receipt.entries;
      const original = path.join(sourceRoot, entry.relativePath);
      const directory = path.join(sourceRoot, `.storage-retired-${journal.transactionId}`);
      try {
        let ownership = inspectSourceEntry(directory, entry);
        if (ownership === 'missing') {
          ownership = inspectSourceEntry(original, entry);
          if (ownership === 'owned') {
            await fsp.rename(original, directory);
            ownership = inspectSourceEntry(directory, entry);
          }
        }
        if (ownership === 'owned') {
          await fsp.rm(directory, { recursive: true, force: true });
          result.removed += 1;
        } else if (ownership === 'changed') {
          result.preserved += 1;
        }
        retireRelocationCleanupReceipt(receipt);
      } catch (error) {
        result.pending = true;
        result.failure ??= error;
      }
      continue;
    }
    try {
      isProtected ??= protectionFor(sourceRoot, options.getProtectedPaths(activeRoot));
    } catch (error) {
      result.pending = true;
      result.failure ??= error;
      continue;
    }
    let pending = false;
    for (const { entries, sqliteBase } of cleanupUnits(receipt.entries)) {
      for (const [index, entry] of entries.entries()) {
        if (signal.aborted) return { ...result, pending: true };
        const filename = path.join(sourceRoot, ...entry.relativePath.split('/'));
        const directory = entry.kind === 'directory';
        try {
          // An old writer may have created a sidecar without touching the main file.
          // Recheck exact family members before any unlink and leave the primary last.
          if (sqliteBase && hasChangedSqliteMember(sourceRoot, sqliteBase, entries, isProtected)) {
            result.preserved += entries.length - index;
            break;
          }
          if (isProtected(filename, directory)) {
            result.preserved += 1;
            break;
          }
          const ownership = inspectSourceEntry(filename, entry);
          if (ownership === 'missing') continue;
          if (ownership === 'changed') {
            result.preserved += entries.length - index;
            break;
          }
          if (signal.aborted) return { ...result, pending: true };
          if (directory) await fsp.rmdir(filename);
          else await fsp.unlink(filename);
          result.removed += 1;
        } catch (error) {
          if (hasCode(error, 'ENOENT')) continue;
          if (hasCode(error, 'ENOTDIR') || hasCode(error, 'ELOOP') ||
            (directory && (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')))) {
            result.preserved += entries.length - index;
          } else {
            pending = true;
            result.failure ??= error;
          }
          break;
        }
      }
    }
    if (signal.aborted) return { ...result, pending: true };
    if (!pending) {
      try { retireRelocationCleanupReceipt(receipt); }
      catch (error) {
        pending = true;
        result.failure ??= error;
      }
    }
    result.pending ||= pending;
  }
  return result;
}

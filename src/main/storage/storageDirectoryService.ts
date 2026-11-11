import fs from 'node:fs/promises';
import path from 'node:path';

import {
  StorageDirectoryCategory,
  type StorageDirectoryCategoryId,
  StorageDirectoryError,
  type StorageDirectoryInfo,
  type StorageDirectoryResult,
  type StorageDirectoryUsage,
  UPGRADE_BACKUP_DIRECTORY,
} from '../../shared/storage/storageDirectory';
import { isBrowserCacheRelativePath } from './browserCachePaths';

const SCAN_LIMITS = {
  maxEntries: 100_000,
  maxDepth: 48,
  maxPendingDirectories: 2_048,
  maxDurationMs: 15_000,
} as const;

const PLUGIN_DIRECTORIES = new Set(['extensions', 'skills', 'plugin-data']);

function classify(relativePath: string, inBackupRoot: boolean): StorageDirectoryCategoryId {
  const [name, state, directory] = relativePath.split(path.sep);
  if (name === 'openclaw') {
    if (state === 'state' && PLUGIN_DIRECTORIES.has(directory))
      return StorageDirectoryCategory.Plugins;
    return StorageDirectoryCategory.Native;
  }
  const rootName = process.platform === 'win32' ? name.toLowerCase() : name;
  if (inBackupRoot && rootName === UPGRADE_BACKUP_DIRECTORY) return StorageDirectoryCategory.Backups;
  if (name === 'local-speech-models') return StorageDirectoryCategory.SpeechModels;
  if (isBrowserCacheRelativePath(relativePath)) return StorageDirectoryCategory.Cache;
  return StorageDirectoryCategory.Other;
}

type DirectoryScanOptions = {
  limits?: Partial<{ [Key in keyof typeof SCAN_LIMITS]: number }>;
  now?: () => number;
  backupRoot?: string;
};

/** Only reads file metadata. No database, transcript, credential or Gateway access. */
export async function scanStorageDirectory(
  root: string,
  options: DirectoryScanOptions = {},
): Promise<StorageDirectoryUsage> {
  const limits = { ...SCAN_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const startedAt = now();
  const realRoot = await fs.realpath(root);
  if (!(await fs.lstat(realRoot)).isDirectory()) throw new Error('Data root is not a directory.');
  const categories = Object.values(StorageDirectoryCategory).map(id => ({ id, bytes: 0 }));
  const categoryFor = (id: StorageDirectoryCategoryId) => categories.find(item => item.id === id)!;
  const pending: Array<{
    directory: string;
    root: string;
    depth: number;
  }> = [{ directory: realRoot, root: realRoot, depth: 0 }];
  let entries = 0;
  let fileCount = 0;
  let skippedEntries = 0;
  let interrupted = false;
  let backupRoot = options.backupRoot ?? realRoot;
  if (path.relative(realRoot, backupRoot) !== '') {
    try {
      backupRoot = await fs.realpath(backupRoot);
      if (path.relative(realRoot, backupRoot) !== '') {
        const directory = path.join(backupRoot, UPGRADE_BACKUP_DIRECTORY);
        await fs.lstat(directory);
        pending.unshift({ directory, root: backupRoot, depth: 1 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skippedEntries += 1;
    }
  }
  const expired = () => entries >= limits.maxEntries || now() - startedAt >= limits.maxDurationMs;

  while (pending.length && !interrupted) {
    const current = pending.pop()!;
    let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      // Recheck queued directories so a removed/replaced directory is never blindly followed.
      const stat = await fs.lstat(current.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        skippedEntries += 1;
        continue;
      }
      const realDirectory = await fs.realpath(current.directory);
      const relative = path.relative(current.root, realDirectory);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        skippedEntries += 1;
        continue;
      }
      directory = await fs.opendir(current.directory);
      const inBackupRoot = path.relative(current.root, backupRoot) === '';
      while (true) {
        if (expired()) {
          interrupted = true;
          skippedEntries += 1;
          break;
        }
        const entry = await directory.read();
        if (!entry) break;
        entries += 1;
        const filename = path.join(current.directory, entry.name);
        try {
          const metadata = await fs.lstat(filename);
          if (metadata.isSymbolicLink()) {
            skippedEntries += 1;
          } else if (metadata.isDirectory()) {
            if (
              current.depth >= limits.maxDepth ||
              pending.length >= limits.maxPendingDirectories
            ) {
              skippedEntries += 1;
            } else {
              pending.push({ directory: filename, root: current.root, depth: current.depth + 1 });
            }
          } else if (
            metadata.isFile() &&
            Number.isSafeInteger(metadata.size) &&
            metadata.size >= 0
          ) {
            const category = classify(path.relative(current.root, filename), inBackupRoot);
            categoryFor(category).bytes += metadata.size;
            fileCount += 1;
          } else {
            skippedEntries += 1;
          }
        } catch {
          // Live files may disappear, be locked or become unreadable. Do not report them as zero.
          skippedEntries += 1;
        }
      }
    } catch (error) {
      if (current.depth === 0) throw error;
      skippedEntries += 1;
    } finally {
      await directory?.close().catch(() => {
        skippedEntries += 1;
      });
    }
  }
  return {
    scannedAt: now(),
    complete: !interrupted && skippedEntries === 0,
    totalBytes: categories.reduce((total, category) => total + category.bytes, 0),
    categories,
    skippedEntries,
    fileCount,
  };
}

/** The current profile is resolved by Main for every operation, never supplied by Renderer. */
export class StorageDirectoryService {
  private scanning = false;

  constructor(
    private readonly dependencies: {
      getDirectory: () => string;
      getBootstrapDirectory?: () => string | undefined;
      backupRoot?: string;
      openDirectory: (directory: string) => Promise<string>;
      scan?: typeof scanStorageDirectory;
    },
  ) {}

  info(): StorageDirectoryResult<StorageDirectoryInfo> {
    try {
      const bootstrapPath = this.dependencies.getBootstrapDirectory?.();
      return {
        success: true,
        value: { path: this.dependencies.getDirectory(), ...(bootstrapPath ? { bootstrapPath } : {}) },
      };
    } catch {
      return { success: false, code: StorageDirectoryError.Unavailable };
    }
  }

  async scan(): Promise<StorageDirectoryResult<StorageDirectoryUsage>> {
    if (this.scanning) return { success: false, code: StorageDirectoryError.Busy };
    this.scanning = true;
    try {
      const value = await (this.dependencies.scan ?? scanStorageDirectory)(
        this.dependencies.getDirectory(),
        { backupRoot: this.dependencies.backupRoot },
      );
      return { success: true, value };
    } catch {
      return { success: false, code: StorageDirectoryError.Unavailable };
    } finally {
      this.scanning = false;
    }
  }

  open(): Promise<StorageDirectoryResult<null>> {
    return this.openLocation(this.dependencies.getDirectory);
  }

  openConfig(): Promise<StorageDirectoryResult<null>> {
    return this.openLocation(() => this.dependencies.getBootstrapDirectory?.());
  }

  private async openLocation(getDirectory: () => string | undefined): Promise<StorageDirectoryResult<null>> {
    try {
      const directory = getDirectory();
      if (!directory) return { success: false, code: StorageDirectoryError.Unavailable };
      const error = await this.dependencies.openDirectory(directory);
      return error
        ? { success: false, code: StorageDirectoryError.Unavailable }
        : { success: true, value: null };
    } catch {
      return { success: false, code: StorageDirectoryError.Unavailable };
    }
  }
}

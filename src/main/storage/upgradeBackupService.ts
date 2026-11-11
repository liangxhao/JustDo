import { type BigIntStats, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { StartupStage } from '../../shared/app/startup/routing';
import {
  StorageCleanupPhase,
  type StorageCleanupProgressUpdate,
  StorageDirectoryError,
  type StorageDirectoryResult,
  UPGRADE_BACKUP_DIRECTORY,
  type UpgradeBackupStatus,
} from '../../shared/storage/storageDirectory';
import { readStartupJournal } from '../startup/routing/startupState';
import { assertCanonicalDirectory } from './relocationState';

export function isUpgradeBackupWorkingDirectory(root: string, directory: string): boolean {
  if (!directory) return false;
  const backup = path.toNamespacedPath(path.join(root, UPGRADE_BACKUP_DIRECTORY));
  const contains = (candidate: string) => {
    const relative = path.relative(backup, path.toNamespacedPath(candidate));
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  };
  if (contains(directory)) return true;
  try { return contains(realpathSync.native(directory)); }
  catch { return false; } // A missing or unavailable workspace adds no physical alias evidence.
}

type PhysicalIdentity = { dev: string; ino: string; birthtimeNs: string };
type DirectorySnapshot = {
  activeRoot: string;
  root: string;
  directory: string;
  rootIdentity: PhysicalIdentity;
  backupIdentity: PhysicalIdentity | null;
};
const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const sameIdentity = (left: PhysicalIdentity | null, right: PhysicalIdentity | null) =>
  !!left &&
  !!right &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.birthtimeNs === right.birthtimeNs;
const notReady = () =>
  Object.assign(new Error('Upgrade backup cleanup is not ready.'), {
    code: StorageDirectoryError.NotReady,
  });
const forbidden = () =>
  Object.assign(new Error('Upgrade backup caller is no longer current.'), {
    code: StorageDirectoryError.Forbidden,
  });
const physicalIdentity = (stat: BigIntStats): PhysicalIdentity => ({
  dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs),
});
async function assertBackupDirectory(directory: string): Promise<void> {
  if (!samePath(await fs.realpath(directory), directory)) throw notReady();
}

// Delete serially so a failure cannot leave sibling deletions running after this promise settles.
async function removeBackupTree(directory: string): Promise<void> {
  await assertBackupDirectory(directory);
  for await (const entry of await fs.opendir(directory)) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeBackupTree(filename);
    } else {
      // The open handle can outlive a replacement of its parent path.
      await assertBackupDirectory(directory);
      await fs.unlink(filename);
    }
  }
  await assertBackupDirectory(directory);
  await fs.rmdir(directory);
}

/** Only the fixed upgrade-backup child selected for the current profile can be removed. */
export class UpgradeBackupService {
  private busy = false;
  private stopped = false;
  private removal?: Promise<void>;

  constructor(
    private readonly deps: {
      getDirectory: () => string;
      backupRoot?: string;
      isReady: (backupRoot: string) => boolean;
      confirmDelete: (directory: string) => Promise<boolean>;
    },
  ) {}

  isBusy(): boolean {
    return this.busy;
  }

  private async capture(): Promise<DirectorySnapshot> {
    const activeRoot = this.deps.getDirectory();
    const root = assertCanonicalDirectory(this.deps.backupRoot ?? activeRoot);
    const directory = path.join(root, UPGRADE_BACKUP_DIRECTORY);
    const rootIdentity = await this.identity(root);
    let backupIdentity: PhysicalIdentity | null;
    try {
      backupIdentity = await this.identity(directory);
      assertCanonicalDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      backupIdentity = null;
    }
    return { activeRoot, root, directory, rootIdentity, backupIdentity };
  }

  private async identity(directory: string): Promise<PhysicalIdentity> {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Upgrade backup directory is unsafe.');
    return physicalIdentity(stat);
  }

  /** The startup owner remains authoritative; no data or native database is opened here. */
  private readiness({ activeRoot, root }: DirectorySnapshot): string | null {
    if (this.stopped || !samePath(this.deps.getDirectory(), activeRoot) || !this.deps.isReady(root))
      return null;
    const journal = readStartupJournal(activeRoot);
    if (
      !journal ||
      journal.stage !== StartupStage.Complete ||
      journal.targetIdentity ||
      journal.schemaPreparationPending
    )
      return null;
    return JSON.stringify([
      journal.transactionId,
      journal.generation,
      journal.completedIdentity ?? null,
    ]);
  }

  async status(): Promise<StorageDirectoryResult<UpgradeBackupStatus>> {
    if (this.stopped) return { success: false, code: StorageDirectoryError.NotReady };
    try {
      const snapshot = await this.capture();
      return {
        success: true,
        value: {
          exists: !!snapshot.backupIdentity,
          canDelete:
            !!snapshot.backupIdentity && !this.busy && this.readiness(snapshot) !== null,
        },
      };
    } catch {
      return { success: false, code: StorageDirectoryError.Unavailable };
    }
  }

  private async assertCurrent(expected: DirectorySnapshot): Promise<void> {
    if (!samePath(this.deps.getDirectory(), expected.activeRoot)) throw notReady();
    const current = await this.capture();
    if (
      !samePath(current.activeRoot, expected.activeRoot) ||
      !sameIdentity(current.rootIdentity, expected.rootIdentity) ||
      !sameIdentity(current.backupIdentity, expected.backupIdentity)
    )
      throw notReady();
  }

  async delete(
    isCallerCurrent: () => boolean = () => true,
    onProgress?: (update: StorageCleanupProgressUpdate) => void,
  ): Promise<StorageDirectoryResult<null>> {
    if (this.stopped) return { success: false, code: StorageDirectoryError.NotReady };
    if (this.busy) return { success: false, code: StorageDirectoryError.Busy };
    this.busy = true;
    const report = (update: StorageCleanupProgressUpdate) => {
      try { onProgress?.(update); }
      catch { /* Observers do not own the destructive operation. */ }
    };
    const assertCaller = () => {
      try {
        if (isCallerCurrent()) return;
      } catch {
        /* A retired frame may no longer be readable. */
      }
      throw forbidden();
    };
    try {
      const expected = await this.capture();
      assertCaller();
      if (!expected.backupIdentity) return { success: true, value: null };
      const proof = this.readiness(expected);
      if (proof === null) return { success: false, code: StorageDirectoryError.NotReady };
      report({ phase: StorageCleanupPhase.Confirming });
      if (this.stopped) throw notReady();
      assertCaller();
      const confirmed = await this.deps.confirmDelete(expected.directory);
      assertCaller();
      if (!confirmed) return { success: false, code: StorageDirectoryError.Cancelled };
      await this.assertCurrent(expected);
      report({ phase: StorageCleanupPhase.Removing });
      assertCaller();
      if (this.readiness(expected) !== proof) throw notReady();
      const operation = removeBackupTree(expected.directory);
      this.removal = operation;
      try {
        await operation;
      } finally {
        if (this.removal === operation) this.removal = undefined;
      }
      return { success: true, value: null };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      return {
        success: false,
        code: code === StorageDirectoryError.Forbidden || code === StorageDirectoryError.NotReady ? code
          : code === 'EACCES' || code === 'EPERM' ? StorageDirectoryError.AccessDenied
            : code === 'EBUSY' || code === 'ENOTEMPTY' ? StorageDirectoryError.Locked
              : StorageDirectoryError.Unavailable,
      };
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.removal) await Promise.allSettled([this.removal]);
  }
}

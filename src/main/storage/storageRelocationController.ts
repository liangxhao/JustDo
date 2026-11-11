import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type StorageRelocationPlan,
  type StorageRelocationResult,
  type StorageRelocationStatus,
} from '../../shared/storage/storageRelocation';
import {
  bindInitialStorageRoot,
  isTerminalRelocationStage,
  pathsOverlap,
  readRelocationJournal,
  readStorageDirectoryIdentity,
  readStorageLocator,
  readStorageLocatorMetadata,
  readStorageRootIdentity,
  recoverInitialStorageBinding,
  RelocationStage,
  type StorageLocator,
  StorageRelocationFile,
  writeRelocationJournal,
  writeStorageRootIdentity,
} from './relocationState';

type StorageProcessIdentity = { pid: number; creationTime: number };
type PreparedPlan = StorageRelocationPlan & {
  locator: StorageLocator;
  initialDirectoryIdentity?: string;
  targetRootId: string;
  markedTarget?: string;
};
const uniqueProcesses = (processes: StorageProcessIdentity[]) =>
  [...new Map(processes.map(identity => [`${identity.pid}:${identity.creationTime}`, identity])).values()];

/** Online control only records intent; all copying occurs after the application has exited. */
export class StorageRelocationController {
  private plan?: PreparedPlan;
  private busy = false;
  constructor(
    private readonly deps: {
      bootstrapRoot: string;
      getSourceRoot: () => string;
      available: () => boolean;
      selectTargetDirectory: () => Promise<string | undefined>;
      isQuitting: () => boolean;
      beginShutdown: (afterCleanup: () => void, afterTimeout: () => void) => void;
      shutdownRuntime: { runtimeRoot: string; appVersion: string };
      relaunch: () => void;
      getProcesses: () => StorageProcessIdentity[];
      captureForceProcesses: () => StorageProcessIdentity[];
      forceProcesses: (processes: StorageProcessIdentity[]) => void;
      freezeAdmission: () => () => void;
    },
  ) {}

  status(): StorageRelocationResult<StorageRelocationStatus> {
    try {
      const journal = readRelocationJournal(this.deps.bootstrapRoot);
      return {
        success: true,
        value: {
          available: this.deps.available(),
          pending: !!journal && !isTerminalRelocationStage(journal.stage),
        },
      };
    } catch {
      return { success: false, code: 'unavailable' };
    }
  }

  async prepare(): Promise<StorageRelocationResult<StorageRelocationPlan>> {
    if (!this.deps.available()) return { success: false, code: 'unsupported' };
    if (this.busy) return { success: false, code: 'busy' };
    this.busy = true;
    try {
      const targetPath = await this.deps.selectTargetDirectory();
      if (!targetPath) return { success: false, code: 'cancelled' };
      if (fs.readdirSync(targetPath).length) return { success: false, code: 'target-not-empty' };
      const currentRoot = fs.realpathSync.native(this.deps.getSourceRoot());
      const locator = readStorageLocatorMetadata(this.deps.bootstrapRoot);
      const sourcePath = locator?.activeRoot ?? currentRoot;
      if (sourcePath !== currentRoot && fs.realpathSync.native(sourcePath) !== currentRoot)
        throw new Error('The active profile changed.');
      const initialDirectoryIdentity = locator ? undefined : readStorageDirectoryIdentity(sourcePath);
      const plan: PreparedPlan = {
        planId: randomUUID(),
        sourcePath,
        targetPath,
        initialDirectoryIdentity,
        locator: locator ?? {
          version: 1,
          profileId: randomUUID(),
          revision: 1,
          activeRoot: sourcePath,
          activeRootId: randomUUID(),
        },
        targetRootId: randomUUID(),
      };
      this.plan = plan;
      return { success: true, value: { planId: plan.planId, sourcePath, targetPath } };
    } catch {
      return { success: false, code: 'unavailable' };
    } finally {
      this.busy = false;
    }
  }

  async commit(planId: string): Promise<StorageRelocationResult<null>> {
    const plan = this.plan;
    if (!this.deps.available()) return { success: false, code: 'unsupported' };
    if (this.busy || this.deps.isQuitting()) return { success: false, code: 'busy' };
    if (!plan || planId !== plan.planId) return { success: false, code: 'unavailable' };
    this.busy = true;
    let unfreeze = () => {};
    let requested = false;
    try {
      unfreeze = this.deps.freezeAdmission();
      recoverInitialStorageBinding(this.deps.bootstrapRoot);
      const locator = readStorageLocator(this.deps.bootstrapRoot);
      const targetPath = fs.realpathSync.native(plan.targetPath);
      if (fs.readdirSync(targetPath).length) return { success: false, code: 'target-not-empty' };
      if (pathsOverlap(plan.sourcePath, targetPath) || pathsOverlap(this.deps.bootstrapRoot, targetPath))
        throw new Error('The source and target folders overlap.');
      if (
        (locator
          ? locator.revision !== plan.locator.revision || locator.activeRoot !== plan.sourcePath ||
            locator.profileId !== plan.locator.profileId || locator.activeRootId !== plan.locator.activeRootId
          : !plan.initialDirectoryIdentity)
      )
        throw new Error('The profile changed.');
      const previous = readRelocationJournal(this.deps.bootstrapRoot);
      if (previous && !isTerminalRelocationStage(previous.stage))
        throw new Error('Another relocation is pending.');
      const processes = uniqueProcesses(this.deps.getProcesses());
      writeStorageRootIdentity(targetPath, {
        version: 1,
        profileId: plan.locator.profileId,
        rootId: plan.targetRootId,
      });
      plan.markedTarget = targetPath;
      if (!locator) bindInitialStorageRoot(this.deps.bootstrapRoot, plan.locator, plan.initialDirectoryIdentity);
      const now = Date.now();
      const journal = {
        version: 1 as const,
        transactionId: plan.planId,
        profileId: plan.locator.profileId,
        sourceRoot: plan.sourcePath,
        targetRoot: targetPath,
        sourceRootId: plan.locator.activeRootId,
        targetRootId: plan.targetRootId,
        sourceRevision: plan.locator.revision,
        stage: RelocationStage.Requested,
        createdAt: now,
        updatedAt: now,
        sourceProcesses: processes,
      };
      writeRelocationJournal(this.deps.bootstrapRoot, journal);
      requested = true;
      this.plan = undefined;
      const handoff = (forcedProcesses?: StorageProcessIdentity[]) => {
        const forced = forcedProcesses !== undefined;
        const completedAt = Date.now();
        const receipt = {
          pid: process.pid,
          transactionId: journal.transactionId,
          completedAt,
          // Previous builds still require these fields when reading an activated journal.
          ...this.deps.shutdownRuntime,
          processes: uniqueProcesses([...processes, ...(forcedProcesses ?? this.deps.getProcesses())]),
        };
        writeRelocationJournal(this.deps.bootstrapRoot, {
          ...journal,
          stage: forced ? RelocationStage.Requested : RelocationStage.SourceRetired,
          updatedAt: completedAt,
          ...(forced ? { forcedShutdown: receipt } : { cleanShutdown: receipt }),
        });
      };
      this.deps.beginShutdown(() => {
        handoff();
        this.deps.relaunch();
      }, () => {
        try {
          const owned = this.deps.captureForceProcesses();
          handoff(owned);
          this.deps.forceProcesses(owned);
        }
        finally { this.deps.relaunch(); }
      });
      return { success: true, value: null };
    } catch (error) {
      console.warn('[StorageRelocation] Could not start migration: ' +
        JSON.stringify(error instanceof Error ? error.message.slice(0, 400) : 'Unknown error'));
      return { success: false, code: 'unavailable' };
    } finally {
      // A persisted request may already own shutdown. The recovery path checks
      // real process retirement before opening the source if that handoff fails.
      if (!requested) {
        this.removeUnusedTargetMarker(plan);
        this.busy = false;
        unfreeze();
      }
    }
  }

  discard(planId: string): StorageRelocationResult<null> {
    const plan = this.plan;
    if (this.busy || !plan || plan.planId !== planId) return { success: false, code: 'busy' };
    this.plan = undefined;
    this.removeUnusedTargetMarker(plan);
    return { success: true, value: null };
  }

  private removeUnusedTargetMarker(plan: PreparedPlan): void {
    const targetPath = plan.markedTarget;
    if (!targetPath) return;
    try {
      const identity = readStorageRootIdentity(targetPath);
      if (
        identity?.rootId === plan.targetRootId &&
        identity.profileId === plan.locator.profileId &&
        fs.readdirSync(targetPath).every(name => name === StorageRelocationFile.RootIdentity)
      ) {
        fs.unlinkSync(path.join(targetPath, StorageRelocationFile.RootIdentity));
        plan.markedTarget = undefined;
      }
    } catch {
      // The target may no longer be available after a failed request.
    }
  }
}

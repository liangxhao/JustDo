import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { app, type BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, shell } from 'electron';

import { USER_DATA_DIRECTORY_NAME } from '../../../shared/productMetadata';
import {
  StorageCleanupKind,
  StorageCleanupPhase,
  type StorageCleanupProgress,
  type StorageCleanupProgressUpdate,
  StorageDirectoryError,
  StorageDirectoryIpc,
  type StorageDirectoryResult,
} from '../../../shared/storage/storageDirectory';
import { upgradeBackupTranslations } from '../../../shared/storage/upgradeBackupTranslations';
import { createBrowserCacheSessions } from '../../browser/data/browserCacheSessions';
import { getLanguage } from '../../core/i18n';
import { BrowserCacheService } from '../../storage/browserCacheService';
import { getStorageBootstrapContext } from '../../storage/relocationState';
import { StorageDirectoryService } from '../../storage/storageDirectoryService';
import { UpgradeBackupService } from '../../storage/upgradeBackupService';

const WORKING_PHASES = new Set<StorageCleanupProgressUpdate['phase']>([
  StorageCleanupPhase.Preparing, StorageCleanupPhase.Confirming, StorageCleanupPhase.Checking,
  StorageCleanupPhase.Removing, StorageCleanupPhase.Clearing,
]);

export function registerStorageDirectoryHandlers(dependencies: {
  getMainWindow: () => BrowserWindow | null;
  isReady: (backupRoot: string) => boolean;
  isCacheReady: () => boolean;
}) {
  let stopped = false;
  let cleanup: StorageCleanupKind | undefined;
  let progress: StorageCleanupProgress | null = null;
  let stopping: Promise<void> | undefined;
  const context = getStorageBootstrapContext();
  const backupRoot = context?.singletonOwned ? context.bootstrapRoot : undefined;
  const service = new StorageDirectoryService({
    getDirectory: () => app.getPath('userData'),
    getBootstrapDirectory: () => path.join(app.getPath('appData'), USER_DATA_DIRECTORY_NAME),
    backupRoot,
    openDirectory: directory => shell.openPath(directory),
  });
  const backup = new UpgradeBackupService({
    getDirectory: () => app.getPath('userData'),
    backupRoot,
    isReady: root => !stopped && cleanup !== StorageCleanupKind.Cache && dependencies.isReady(root),
    confirmDelete: async directory => {
      const window = dependencies.getMainWindow();
      if (!window || window.isDestroyed()) return false;
      const frame = window.webContents.mainFrame;
      const labels = upgradeBackupTranslations[getLanguage()];
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: labels.upgradeBackupConfirmTitle,
        message: labels.upgradeBackupConfirmMessage,
        detail: `${labels.upgradeBackupConfirmDetail}\n\n${directory}`,
        buttons: [labels.upgradeBackupCancel, labels.upgradeBackupDelete],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return !stopped && response === 1 && dependencies.getMainWindow() === window &&
        !window.isDestroyed() && window.webContents.mainFrame === frame;
    },
  });
  const cacheSessions = createBrowserCacheSessions();
  const cache = new BrowserCacheService({
    getDirectory: () => app.getPath('userData'),
    isReady: () => !stopped && cleanup !== StorageCleanupKind.Backup && dependencies.isCacheReady(),
    collectSessions: root => cacheSessions.collect(root),
    stopSessions: () => cacheSessions.stop(),
  });
  const allowed = (event: IpcMainInvokeEvent): boolean => {
    const window = dependencies.getMainWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      !event.sender.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  };
  const runCleanup = async (
    kind: StorageCleanupKind,
    event: IpcMainInvokeEvent,
  ) => {
    if (stopped) return { success: false as const, code: StorageDirectoryError.NotReady };
    if (cleanup || backup.isBusy() || cache.isBusy())
      return { success: false as const, code: StorageDirectoryError.Busy };
    // Reserve before any asynchronous preflight or native confirmation can yield.
    cleanup = kind;
    const operationId = randomUUID();
    const startedAt = performance.now();
    let active = true;
    progress = { operationId, kind, phase: StorageCleanupPhase.Preparing };
    const logPhase = () => {
      // Closed metadata only. Do not expose filesystem paths or raw failure objects.
      try {
        console.info(`[StorageCleanup] ${JSON.stringify({ ...progress,
          elapsedMs: Math.round(performance.now() - startedAt) })}`);
      } catch { /* Feedback cannot change an admitted cleanup outcome. */ }
    };
    logPhase();
    const report = (update: StorageCleanupProgressUpdate) => {
      if (!active || stopped || progress?.operationId !== operationId || !WORKING_PHASES.has(update.phase)) return;
      const previousPhase = progress.phase;
      progress = { ...progress, phase: update.phase };
      for (const field of ['sessionsCompleted', 'sessionsTotal'] as const) {
        const value = update[field];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) progress[field] = value;
      }
      if (progress.phase !== previousPhase) logPhase();
    };
    const finish = (result: StorageDirectoryResult<null>) => {
      const errorCode = 'code' in result ? result.code : undefined;
      progress = { ...progress!, phase: result.success ? StorageCleanupPhase.Completed
        : errorCode === StorageDirectoryError.Cancelled ? StorageCleanupPhase.Cancelled : StorageCleanupPhase.Failed,
      ...(errorCode ? { errorCode } : {}) };
      logPhase();
      return result;
    };
    try {
      const owner = dependencies.getMainWindow();
      const frame = event.senderFrame;
      const isCallerCurrent = () => !stopped && owner === dependencies.getMainWindow() &&
        !!owner && !owner.isDestroyed() && !event.sender.isDestroyed() &&
        frame === event.senderFrame && frame === owner.webContents.mainFrame;
      return finish(await (kind === StorageCleanupKind.Backup
        ? backup.delete(isCallerCurrent, report) : cache.clear(isCallerCurrent, report)));
    } catch {
      return finish({ success: false, code: StorageDirectoryError.Unavailable });
    } finally {
      active = false;
      cleanup = undefined;
    }
  };
  for (const [channel, operation] of [
    [StorageDirectoryIpc.Info, () => service.info()],
    [StorageDirectoryIpc.Scan, () => service.scan()],
    [StorageDirectoryIpc.Open, () => service.open()],
    [StorageDirectoryIpc.OpenConfig, () => service.openConfig()],
    [StorageDirectoryIpc.UpgradeBackupStatus, () => backup.status()],
    [StorageDirectoryIpc.CleanupStatus, () => stopped
      ? { success: false as const, code: StorageDirectoryError.NotReady }
      : { success: true as const, value: progress ? { ...progress } : null }],
    [StorageDirectoryIpc.DeleteUpgradeBackup, (event: IpcMainInvokeEvent) => runCleanup(StorageCleanupKind.Backup, event)],
    [StorageDirectoryIpc.ClearBrowserCache, (event: IpcMainInvokeEvent) => runCleanup(StorageCleanupKind.Cache, event)],
  ] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!allowed(event) || args.length) {
        return { success: false, code: StorageDirectoryError.Forbidden };
      }
      return operation(event);
    });
  }
  return {
    stop: () => {
      stopped = true;
      // Services join issued work; an unanswered backup modal does not delay shutdown.
      if (!stopping) {
        const retire = (operation: () => Promise<void>) => {
          try { return operation(); }
          catch (error) { return Promise.reject(error); }
        };
        // Collector admission must close in this turn, before queued I/O continuations run.
        stopping = Promise.allSettled([
          retire(() => backup.stop()),
          retire(() => cache.stop()),
        ]).then(results => {
          const failures = results.filter(result => result.status === 'rejected');
          if (failures.length)
            throw new AggregateError(failures.map(result => result.reason), 'Storage cleanup retirement failed.');
        });
      }
      return stopping;
    },
  };
}

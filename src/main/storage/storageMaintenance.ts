import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { PRODUCT_NAME } from '../../shared/productMetadata';
import {
  StorageMaintenancePhase,
  type StorageMaintenanceStatus,
  type StorageRelocationBlockers,
  StorageRelocationIpc,
} from '../../shared/storage/storageRelocation';
import { findFileSystemErrorDetails } from '../core/filesystem/managedDirectoryOperations';
import { findWindowsLockingProcesses } from '../core/filesystem/windowsFileLockDiagnostics';
import { startApplicationRendererHost } from '../core/window/renderer/applicationRendererHost';
import { isRelocationLockCode } from './relocationNativeFailure';
import { assertStorageProcessesRetired, StorageProcessesStillRunningError, waitForForcedStorageRetirement } from './relocationProcessRetirement';
import { projectRelocatedProfilePaths, readRelocatedProfilePaths } from './relocationProfilePaths';
import {
  assertCanonicalParentDirectory,
  readRelocationJournal,
  readStorageLocator,
  removeRelocationJournal,
  writeRelocationJournal,
} from './relocationState';
import { executeStorageRelocation } from './relocationTransaction';
import { describeStorageStartupFailure, describeStorageSystemReason, StorageStartupFailure } from './storageStartupFailure';

const MAX_SHOWN_PROCESSES = 12;
const displayProcessName = (name?: string) => name?.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 120) ?? '';

function retirementBlockers(error: unknown): StorageRelocationBlockers | undefined {
  if (!(error instanceof StorageProcessesStillRunningError)) return undefined;
  return {
    kind: 'retirement',
    processes: error.processes.slice(0, MAX_SHOWN_PROCESSES).map(({ name, pid }) => ({
      pid, name: displayProcessName(name), appOwned: true,
    })),
  };
}

function getLockPaths(error: ReturnType<typeof findFileSystemErrorDetails>, roots: string[]): string[] {
  if (!isRelocationLockCode(error.code) || error.syscall === 'symlink') return [];
  const candidates = new Set<string>();
  for (const candidate of [error.sourcePath, error.destinationPath]) {
    if (!candidate || !path.isAbsolute(candidate) || /[\u0000-\u001f]/u.test(candidate)) continue;
    const filename = path.resolve(candidate);
    if (!roots.some(root => {
      const relative = path.relative(root, filename);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    })) continue;
    try {
      assertCanonicalParentDirectory(path.dirname(filename));
    } catch {
      continue;
    }
    try {
      const entry = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (!entry || entry.isSymbolicLink()) continue;
    } catch (error) {
      // Windows can deny metadata access for the exact locked item too.
      if (!isRelocationLockCode((error as NodeJS.ErrnoException).code)) continue;
    }
    candidates.add(filename);
  }
  return [...candidates];
}

export async function runStorageMaintenance(options: {
  bootstrapRoot: string;
  initialError?: unknown;
  dataPath?: string;
}): Promise<void> {
  await app.whenReady();
  const host = await startApplicationRendererHost(path.join(app.getAppPath(), 'dist'), {
    entry: 'storage-maintenance.html',
  });
  const window = new BrowserWindow({
    width: 720,
    height: 540,
    minWidth: 520,
    minHeight: 450,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'storageMaintenancePreload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();
  // Vite's main bundle lives at dist-electron; tsc keeps this module in storage/.
  const trusted = (event: Electron.IpcMainInvokeEvent) =>
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === host.url;
  let status: StorageMaintenanceStatus = {
    dataPath: options.dataPath,
    phase: options.initialError ? undefined : StorageMaintenancePhase.RetiringProcesses,
    canRetry: false,
    canCancel: false,
    language: process.argv.includes('--storage-language=en')
      ? 'en'
      : process.argv.includes('--storage-language=zh') || app.getSystemLocale().startsWith('zh')
        ? 'zh'
        : 'en',
  };
  if (options.initialError) {
    const failure = describeStorageStartupFailure(options.initialError, status.language);
    status = {
      ...status,
      error: 'unavailable',
      errorDetail: failure.detail,
      errorPath: failure.path,
      dataPath: options.dataPath ?? failure.dataPath,
    };
  }
  let running: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let exiting = false;
  let processRetirementConfirmed = false;
  const publish = (patch: Partial<StorageMaintenanceStatus>) => {
    status = { ...status, ...patch };
    if (window.isDestroyed()) return;
    try {
      window.webContents.send(StorageRelocationIpc.MaintenanceChanged, status);
    } catch {
      // A reloading or closed renderer can read the latest status on reconnect.
    }
  };
  const reportFailure = async (
    error: unknown,
    recovery: Pick<StorageMaintenanceStatus, 'error' | 'dataPath' | 'canRetry' | 'canCancel'>,
    roots: string[],
  ) => {
    const failure = error instanceof StorageStartupFailure
      ? describeStorageStartupFailure(error, status.language)
      : undefined;
    const details = findFileSystemErrorDetails(error);
    const blocking = retirementBlockers(error);
    const reason = failure?.detail ?? describeStorageSystemReason(details.code, status.language);
    const cancelled = recovery.error === 'cancelled';
    const retirementUnknown = details.code === 'retirement-unconfirmed';
    const dataPath = recovery.dataPath ?? failure?.dataPath;
    const permissions = details.code === 'EACCES' || details.code === 'EPERM';
    const lockPaths = cancelled || blocking || retirementUnknown
      ? []
      : getLockPaths(details, dataPath ? [...roots, dataPath] : roots);
    const fileInUse = !cancelled && !blocking && !retirementUnknown &&
      (lockPaths.length > 0 || (isRelocationLockCode(details.code) && !permissions));
    publish({
      ...recovery,
      dataPath,
      errorDetail: fileInUse ? undefined : reason,
      errorPath: lockPaths[0] ?? failure?.path,
      blocking: blocking ?? (fileInUse
        ? { kind: 'file', checking: lockPaths.length > 0, processes: [] }
        : undefined),
      canRetry: !retirementUnknown && !lockPaths.length && recovery.canRetry,
      canCancel: !retirementUnknown && !lockPaths.length && recovery.canCancel,
    });
    if (!lockPaths.length) return;

    // Diagnostics run after the transaction has joined its workers. Only
    // inspect the reported items, never an entire profile for an unknown error.
    const results = await Promise.allSettled(lockPaths.map(filename =>
      findWindowsLockingProcesses(filename, { exact: true, signal: abort?.signal }),
    ));
    const matched = results.findIndex(result =>
      result.status === 'fulfilled' && result.value.processes.length > 0,
    );
    const result = results[matched];
    const appPids = new Set([process.pid]);
    try {
      for (const { pid } of app.getAppMetrics()) appPids.add(pid);
    } catch {
      /* Process names remain usable if Electron metrics are unavailable. */
    }
    publish({
      errorPath: lockPaths[matched] ?? lockPaths[0],
      errorDetail: matched < 0 && permissions ? reason : undefined,
      blocking: {
        kind: 'file',
        processes: result?.status === 'fulfilled'
          ? result.value.processes.slice(0, MAX_SHOWN_PROCESSES).map(({ name, pid }) => ({
            name: displayProcessName(name), pid, appOwned: appPids.has(pid),
          }))
          : [],
      },
      canRetry: recovery.canRetry,
      canCancel: recovery.canCancel,
    });
  };
  const relaunch = () => {
    exiting = true;
    app.relaunch({ execPath: app.getPath('exe'), args: [] });
    app.exit(0);
  };
  const execute = async () => {
    if (running) return;
    abort = new AbortController();
    const temporaryDirectories: string[] = [];
    let attempted = false;
    publish({
      phase: StorageMaintenancePhase.RetiringProcesses,
      canRetry: false, canCancel: false, error: undefined, errorPath: undefined, errorDetail: undefined, blocking: undefined,
    });
    running = (async () => {
      processRetirementConfirmed = false;
      const journal = readRelocationJournal(options.bootstrapRoot);
      if (!journal) throw new Error('No migration is available.');
      publish({ sourcePath: journal.sourceRoot, targetPath: journal.targetRoot });
      const locator = readStorageLocator(options.bootstrapRoot);
      if (locator) publish({
        dataPath: locator.activeRoot,
        canCancel: locator.activeRoot === journal.sourceRoot,
      });
      if (locator?.activeRoot === journal.sourceRoot) {
        const shutdown = journal.cleanShutdown ?? journal.forcedShutdown;
        if (!shutdown?.processes?.length)
          throw new Error('Source process retirement is unconfirmed.');
        await (journal.forcedShutdown ? waitForForcedStorageRetirement : assertStorageProcessesRetired)(shutdown.processes);
      }
      const priorMaintenance = journal.maintenanceProcesses;
      if (priorMaintenance?.length) await assertStorageProcessesRetired(priorMaintenance);
      processRetirementConfirmed = true;
      if (priorMaintenance?.length) {
        writeRelocationJournal(options.bootstrapRoot, {
          ...journal,
          maintenanceProcesses: [],
          updatedAt: Date.now(),
        });
      }
      const runtimeRoot = path.join(process.resourcesPath, 'cfmind');
      attempted = true;
      await executeStorageRelocation({
        bootstrapRoot: options.bootstrapRoot,
        runtimeRoot,
        signal: abort!.signal,
        getProtectedPaths: readRelocatedProfilePaths,
        projectProfilePaths: projectRelocatedProfilePaths,
        onPhase: phase => {
          publish(phase === StorageMaintenancePhase.SwitchingLocation ? { phase, canCancel: false } : { phase });
        },
        onTemporaryDirectory: directory => { temporaryDirectories.push(directory); },
      });
      relaunch();
    })()
      .catch(error => {
        let canRetry = false;
        let canCancel = false;
        let dataPath = status.dataPath;
        const roots = [options.bootstrapRoot, ...temporaryDirectories];
        try {
          const locator = readStorageLocator(options.bootstrapRoot);
          dataPath = locator?.activeRoot ?? dataPath;
          const journal = readRelocationJournal(options.bootstrapRoot);
          if (journal) {
            roots.push(journal.sourceRoot, journal.targetRoot);
          }
          canRetry = !!journal && !!(journal.cleanShutdown ?? journal.forcedShutdown) && (!attempted || locator?.activeRoot === journal.targetRoot);
          canCancel = processRetirementConfirmed && !!journal && locator?.activeRoot === journal.sourceRoot;
        } catch {
          canRetry = true;
        }
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return reportFailure(error, {
          error: abort?.signal.aborted ? 'cancelled'
            : code === 'target-not-empty' ? code : 'failed',
          dataPath,
          canRetry,
          canCancel,
        }, roots);
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  };
  ipcMain.handle(StorageRelocationIpc.MaintenanceStatus, event => {
    if (!trusted(event)) throw new Error('Unavailable.');
    return status;
  });
  ipcMain.handle(StorageRelocationIpc.MaintenanceRetry, async event => {
    if (!trusted(event) || !status.canRetry || running) return;
    if (options.initialError) {
      relaunch();
      return;
    }
    await execute();
  });
  ipcMain.handle(StorageRelocationIpc.MaintenanceCancel, async event => {
    if (!trusted(event) || !status.canCancel || exiting) return;
    try {
      const journal = readRelocationJournal(options.bootstrapRoot);
      if (!journal || readStorageLocator(options.bootstrapRoot)?.activeRoot !== journal.sourceRoot) return;
      abort?.abort();
      await running;
      if (!status.canCancel || exiting) return;
      removeRelocationJournal(options.bootstrapRoot, journal.transactionId);
    } catch (error) {
      await reportFailure(error, {
        error: 'failed', dataPath: status.dataPath, canRetry: false, canCancel: true,
      }, [options.bootstrapRoot]);
      return;
    }
    relaunch();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== host.url) event.preventDefault();
  });
  window.on('close', event => {
    if (exiting) return;
    if (running) {
      event.preventDefault();
      return;
    }
    exiting = true;
    void host.close().finally(() => app.exit(0));
  });
  await window.loadURL(host.url);
  if (options.initialError) {
    running = reportFailure(options.initialError, {
      error: 'unavailable',
      dataPath: status.dataPath,
      canRetry: true,
      canCancel: false,
    }, [options.bootstrapRoot]).finally(() => { running = undefined; });
    await running;
    return;
  }
  const journal = readRelocationJournal(options.bootstrapRoot);
  if (!journal?.cleanShutdown && !journal?.forcedShutdown) {
    let canCancel = false;
    let blocking: StorageRelocationBlockers | undefined;
    try {
      if (journal?.sourceProcesses?.length) {
        await assertStorageProcessesRetired(journal.sourceProcesses);
        if (journal.maintenanceProcesses?.length)
          await assertStorageProcessesRetired(journal.maintenanceProcesses);
        canCancel = true;
      }
    } catch (error) {
      blocking = retirementBlockers(error);
    }
    publish({
      sourcePath: journal?.sourceRoot, targetPath: journal?.targetRoot, error: 'failed', canCancel, blocking,
    });
    return;
  }
  void execute();
}

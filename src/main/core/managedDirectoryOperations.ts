import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

import { cpRecursiveSync } from './fsCompat';
import { t } from './i18n';
import {
  findWindowsLockingProcesses,
  type WindowsLockingProcess,
} from './windowsFileLockDiagnostics';

const FILE_SYSTEM_RETRY_COUNT = 5;
const FILE_SYSTEM_RETRY_DELAY_MS = 200;
const LOCK_RELATED_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

export type ManagedDirectoryFailureReason = 'locked' | 'permission' | 'filesystem';

export type ManagedDirectoryFailure = {
  reason: ManagedDirectoryFailureReason;
  message: string;
  targetPath: string;
  code?: string;
  syscall?: string;
  lockingProcesses?: WindowsLockingProcess[];
};

export type ManagedDirectoryAttempt<T> =
  { success: true; value: T } | { success: false; failure: ManagedDirectoryFailure };

export type ManagedDirectoryOperationResult<T> =
  | {
      success: true;
      value: T;
      recoveredFromLock: boolean;
      runtimeRestarted: boolean;
    }
  | {
      success: false;
      failure: ManagedDirectoryFailure;
      recoveredFromLock: boolean;
      runtimeRestarted: boolean;
    };

export type ManagedDirectoryRuntimeLifecycle = {
  isRunning(): boolean;
  ownsProcess?(pid: number): boolean;
  stop(): Promise<void>;
  start(): Promise<{ running: boolean; message?: string }>;
};

type ManagedDirectoryOperationCoordinatorDeps = {
  runtime?: ManagedDirectoryRuntimeLifecycle;
  findLockingProcesses?: typeof findWindowsLockingProcesses;
  ownsAppProcess?: (pid: number) => boolean;
};

export type ReplaceDirectoryOptions = {
  sourceDir: string;
  targetDir: string;
  transactionPrefix?: string;
  stagingParent?: string;
  validateStaged?: (stagedDir: string) => void;
  onCleanupError?: (message: string) => void;
};

export type RemoveDirectoryOptions = {
  targetDir: string;
  trashRoot?: string;
  transactionPrefix?: string;
  tolerateTrashCleanupFailure?: boolean;
  onCleanupError?: (message: string) => void;
};

type FileSystemErrorDetails = {
  code?: string;
  syscall?: string;
  sourcePath?: string;
  destinationPath?: string;
};

const getStringProperty = (value: Error, property: string): string | undefined =>
  property in value && typeof (value as unknown as Record<string, unknown>)[property] === 'string'
    ? ((value as unknown as Record<string, unknown>)[property] as string)
    : undefined;

export const findFileSystemErrorDetails = (error: unknown): FileSystemErrorDetails => {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const code = getStringProperty(current, 'code');
    if (code) {
      return {
        code,
        syscall: getStringProperty(current, 'syscall'),
        sourcePath: getStringProperty(current, 'path'),
        destinationPath: getStringProperty(current, 'dest'),
      };
    }
    current = current.cause;
  }
  return {};
};

const classifyFailure = (code?: string, message = ''): ManagedDirectoryFailureReason => {
  // Node's recursive Windows directory removal can omit `syscall` even when a
  // directory handle is the reason for EPERM/EACCES. Treat these codes as a
  // potential lock first; the coordinator runs Restart Manager diagnostics and
  // only downgrades the result to a permission failure when no owner is found
  // and the directory really fails a basic access check.
  const looksLikeWindowsLock =
    /resource busy|busy or locked|being used by another process|process cannot access|permission denied|access (?:is )?denied|operation not permitted/i.test(
      message,
    );
  if (
    process.platform === 'win32' &&
    ((code && LOCK_RELATED_CODES.has(code)) || looksLikeWindowsLock)
  ) {
    return 'locked';
  }
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  return 'filesystem';
};

export const managedDirectoryFailureFromError = (
  error: unknown,
  targetPath: string,
): ManagedDirectoryFailure => {
  const details = findFileSystemErrorDetails(error);
  return {
    reason: classifyFailure(details.code, error instanceof Error ? error.message : String(error)),
    message: error instanceof Error ? error.message : String(error),
    targetPath,
    ...(details.code ? { code: details.code } : {}),
    ...(details.syscall ? { syscall: details.syscall } : {}),
  };
};

export const managedDirectoryFailureFromMessage = (
  message: string,
  targetPath: string,
): ManagedDirectoryFailure => {
  const code = message
    .match(/\b(EACCES|EPERM|EBUSY|EEXIST|EXDEV|ENOSPC|EROFS)\b/i)?.[1]
    ?.toUpperCase();
  const syscall = message.match(/\b(rename|rmdir|unlink)\b/i)?.[1]?.toLowerCase();
  return {
    reason: classifyFailure(code, message),
    message,
    targetPath,
    ...(code ? { code } : {}),
    ...(syscall ? { syscall } : {}),
  };
};

export const formatManagedDirectoryFailure = (
  failure: ManagedDirectoryFailure,
  resourceName: string,
  options: { excludeLockingProcess?: (process: WindowsLockingProcess) => boolean } = {},
): string => {
  if (failure.reason === 'locked') {
    const diagnosedProcesses = failure.lockingProcesses ?? [];
    const processes = options.excludeLockingProcess
      ? diagnosedProcesses.filter(process => !options.excludeLockingProcess?.(process))
      : diagnosedProcesses;
    if (processes.length > 0) {
      return t('managedDirectoryLockedBy', {
        resource: resourceName,
        path: failure.targetPath,
        processes: processes.map(entry => `• ${entry.name} (PID ${entry.pid})`).join('\n'),
      });
    }
    if (diagnosedProcesses.length > 0) {
      return t('managedDirectoryLockedByApp', {
        resource: resourceName,
        path: failure.targetPath,
      });
    }
    return t('managedDirectoryLockedUnknown', {
      resource: resourceName,
      path: failure.targetPath,
    });
  }
  if (failure.reason === 'permission') {
    return t('managedDirectoryPermissionDenied', {
      resource: resourceName,
      path: failure.targetPath,
      detail: failure.message,
    });
  }
  return failure.message;
};

export const managedDirectorySuccess = <T>(value: T): ManagedDirectoryAttempt<T> => ({
  success: true,
  value,
});

export const managedDirectoryFailure = <T = never>(
  failure: ManagedDirectoryFailure,
): ManagedDirectoryAttempt<T> => ({ success: false, failure });

const waitForFileSystemRetry = (): void => {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    FILE_SYSTEM_RETRY_DELAY_MS,
  );
};

const waitForLockDiagnosticRetry = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, FILE_SYSTEM_RETRY_DELAY_MS));

const lacksBasicDirectoryMutationAccess = (targetPath: string): boolean => {
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(path.dirname(targetPath), fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
};

export const renameDirectoryWithRetry = (sourceDir: string, targetDir: string): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(sourceDir, targetDir);
      return;
    } catch (error) {
      const { code } = findFileSystemErrorDetails(error);
      const canRetry =
        attempt < FILE_SYSTEM_RETRY_COUNT &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY');
      if (!canRetry) throw error;
      waitForFileSystemRetry();
    }
  }
};

const resetWindowsDirectoryAcl = (directory: string): void => {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const executable = systemRoot ? path.join(systemRoot, 'System32', 'icacls.exe') : 'icacls.exe';
  childProcess.spawnSync(executable, [directory, '/reset', '/T', '/C', '/Q', '/L'], {
    windowsHide: true,
    stdio: 'ignore',
  });

  const username = process.env.USERNAME;
  if (!username) return;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
  childProcess.spawnSync(
    executable,
    [directory, '/grant:r', `${account}:(OI)(CI)F`, '/T', '/C', '/Q', '/L'],
    { windowsHide: true, stdio: 'ignore' },
  );
};

export const removeDirectoryWithRetry = (directory: string): void => {
  const options: fs.RmOptions = {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? FILE_SYSTEM_RETRY_COUNT : 0,
    retryDelay: process.platform === 'win32' ? FILE_SYSTEM_RETRY_DELAY_MS : 0,
  };
  try {
    fs.rmSync(directory, options);
  } catch (error) {
    const { code } = findFileSystemErrorDetails(error);
    if (process.platform !== 'win32' || (code !== 'EACCES' && code !== 'EPERM')) throw error;
    resetWindowsDirectoryAcl(directory);
    fs.rmSync(directory, options);
  }
};

const pathExists = (targetPath: string): boolean => {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    const { code } = findFileSystemErrorDetails(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
};

const TRANSACTION_MANIFEST = '.justdo-transaction.json';

const recoverInterruptedReplaceTransactions = (
  stagingParent: string,
  transactionPrefix: string,
  targetDir: string,
  onCleanupError?: (message: string) => void,
): void => {
  for (const entry of fs.readdirSync(stagingParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(transactionPrefix)) continue;
    const transactionDir = path.join(stagingParent, entry.name);
    const manifestPath = path.join(transactionDir, TRANSACTION_MANIFEST);
    if (!pathExists(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        !('targetDir' in manifest) ||
        typeof manifest.targetDir !== 'string' ||
        path.resolve(manifest.targetDir) !== path.resolve(targetDir)
      ) {
        continue;
      }
      const backupDir = path.join(transactionDir, 'backup');
      if (!pathExists(targetDir) && pathExists(backupDir)) {
        renameDirectoryWithRetry(backupDir, targetDir);
      }
      if (pathExists(targetDir) || !pathExists(backupDir)) {
        removeDirectoryWithRetry(transactionDir);
      }
    } catch (error) {
      onCleanupError?.(error instanceof Error ? error.message : String(error));
    }
  }
};

export const replaceDirectoryTransactional = ({
  sourceDir,
  targetDir,
  transactionPrefix = '.justdo-directory-stage-',
  stagingParent = path.dirname(targetDir),
  validateStaged,
  onCleanupError,
}: ReplaceDirectoryOptions): void => {
  // Keep staging on the destination volume so publish and rollback are atomic
  // and cannot fail with EXDEV when the system temp directory is on another drive.
  fs.mkdirSync(stagingParent, { recursive: true });
  recoverInterruptedReplaceTransactions(
    stagingParent,
    transactionPrefix,
    targetDir,
    onCleanupError,
  );
  const transactionDir = fs.mkdtempSync(path.join(stagingParent, transactionPrefix));
  const stagedDir = path.join(transactionDir, 'next');
  const backupDir = path.join(transactionDir, 'backup');
  let targetBackedUp = false;

  try {
    cpRecursiveSync(sourceDir, stagedDir, { force: true });
    validateStaged?.(stagedDir);
    fs.writeFileSync(
      path.join(transactionDir, TRANSACTION_MANIFEST),
      JSON.stringify({ targetDir: path.resolve(targetDir) }),
      'utf8',
    );
    if (pathExists(targetDir)) {
      renameDirectoryWithRetry(targetDir, backupDir);
      targetBackedUp = true;
    }

    try {
      renameDirectoryWithRetry(stagedDir, targetDir);
    } catch (error) {
      if (targetBackedUp) {
        try {
          renameDirectoryWithRetry(backupDir, targetDir);
          targetBackedUp = false;
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : String(restoreError);
          throw new Error(
            `Failed to publish the directory and restore its previous version. The backup was preserved at "${backupDir}". (${restoreMessage})`,
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (targetBackedUp) {
      targetBackedUp = false;
      try {
        removeDirectoryWithRetry(backupDir);
      } catch (error) {
        onCleanupError?.(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    if (!targetBackedUp) {
      try {
        removeDirectoryWithRetry(transactionDir);
      } catch (error) {
        onCleanupError?.(error instanceof Error ? error.message : String(error));
      }
    }
  }
};

export const removeDirectoryTransactional = ({
  targetDir,
  trashRoot = path.join(path.dirname(path.dirname(targetDir)), '.justdo-directory-trash'),
  transactionPrefix = 'delete-',
  tolerateTrashCleanupFailure = true,
  onCleanupError,
}: RemoveDirectoryOptions): void => {
  let transactionDir = '';
  try {
    fs.mkdirSync(trashRoot, { recursive: true });
    transactionDir = fs.mkdtempSync(path.join(trashRoot, transactionPrefix));
    const quarantinedDir = path.join(transactionDir, path.basename(targetDir));
    // The live directory may be externally owned or locked. Do not rewrite its
    // ACL while trying to quarantine it; the coordinator diagnoses the failure
    // and tells the user which process or permission must be fixed.
    renameDirectoryWithRetry(targetDir, quarantinedDir);
    try {
      removeDirectoryWithRetry(transactionDir);
      transactionDir = '';
    } catch (error) {
      if (!tolerateTrashCleanupFailure) throw error;
      onCleanupError?.(error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    if (transactionDir && pathExists(targetDir)) {
      try {
        removeDirectoryWithRetry(transactionDir);
      } catch {
        // Best effort cleanup. The original operation error remains authoritative.
      }
    }
    // Never recursively delete the live directory when the atomic quarantine
    // rename fails. A recursive removal can delete unlocked files first and
    // then fail on a locked entry, leaving a broken but still-present skill.
    throw error;
  }

  if (pathExists(targetDir)) throw new Error(`Directory still exists after deletion: ${targetDir}`);
};

export class ManagedDirectoryOperationCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ManagedDirectoryOperationCoordinatorDeps = {}) {}

  execute<T>(options: {
    operation: () => Promise<ManagedDirectoryAttempt<T>>;
    resourceName: string;
    targetPath: string | (() => string);
    manageRuntimeOnLock?: boolean;
    preflightLockCheck?: boolean;
  }): Promise<ManagedDirectoryOperationResult<T>> {
    return this.runExclusive(() => this.executeInternal(options));
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private async executeInternal<T>(options: {
    operation: () => Promise<ManagedDirectoryAttempt<T>>;
    resourceName: string;
    targetPath: string | (() => string);
    manageRuntimeOnLock?: boolean;
    preflightLockCheck?: boolean;
  }): Promise<ManagedDirectoryOperationResult<T>> {
    const resolveTargetPath = (): string =>
      typeof options.targetPath === 'function' ? options.targetPath() : options.targetPath;
    const findLockingProcesses = this.deps.findLockingProcesses ?? findWindowsLockingProcesses;
    const configuredRuntime = this.deps.runtime;
    const runtime = options.manageRuntimeOnLock ? configuredRuntime : undefined;
    const isAppManagedProcess = (pid: number): boolean =>
      pid === process.pid ||
      Boolean(this.deps.ownsAppProcess?.(pid)) ||
      Boolean(configuredRuntime?.ownsProcess?.(pid));
    const formatFailure = (failure: ManagedDirectoryFailure): string =>
      formatManagedDirectoryFailure(failure, options.resourceName, {
        excludeLockingProcess: lockingProcess => isAppManagedProcess(lockingProcess.pid),
      });
    let targetPath = options.preflightLockCheck ? resolveTargetPath() : '';
    let attempt: ManagedDirectoryAttempt<T>;
    if (options.preflightLockCheck) {
      const diagnostic = await findLockingProcesses(targetPath);
      if (diagnostic.available && diagnostic.processes.length > 0) {
        attempt = managedDirectoryFailure({
          reason: 'locked',
          code: 'EBUSY',
          message: 'Directory is in use.',
          targetPath,
          lockingProcesses: diagnostic.processes,
        });
      } else {
        attempt = await options.operation();
        targetPath = resolveTargetPath();
      }
    } else {
      attempt = await options.operation();
      targetPath = resolveTargetPath();
    }
    if (!('failure' in attempt)) {
      return { ...attempt, recoveredFromLock: false, runtimeRestarted: false };
    }
    if (attempt.failure.reason !== 'locked') {
      return {
        success: false,
        failure: {
          ...attempt.failure,
          message: formatFailure(attempt.failure),
        },
        recoveredFromLock: false,
        runtimeRestarted: false,
      };
    }

    const diagnoseLock = async (
      failure: ManagedDirectoryFailure,
    ): Promise<ManagedDirectoryFailure> => {
      let diagnostic = failure.lockingProcesses
        ? { available: true, processes: failure.lockingProcesses }
        : await findLockingProcesses(targetPath);
      if (diagnostic.available && diagnostic.processes.length === 0) {
        // Directory handles can disappear and reappear while Explorer, editors, or
        // antivirus scanners refresh. Recheck once before reporting an unknown owner.
        await waitForLockDiagnosticRetry();
        diagnostic = await findLockingProcesses(targetPath);
      }
      const reason =
        diagnostic.available &&
        diagnostic.processes.length === 0 &&
        failure.code !== 'EBUSY' &&
        lacksBasicDirectoryMutationAccess(targetPath)
          ? 'permission'
          : failure.reason;
      const diagnosed = {
        ...failure,
        reason,
        targetPath,
        lockingProcesses: diagnostic.processes,
      };
      return {
        ...diagnosed,
        message: formatFailure(diagnosed),
      };
    };

    attempt = { success: false, failure: await diagnoseLock(attempt.failure) };
    const managedRuntimeOwnsEveryLock = Boolean(
      runtime?.isRunning() &&
      runtime.ownsProcess &&
      attempt.failure.lockingProcesses?.length &&
      attempt.failure.lockingProcesses.every(process => runtime.ownsProcess?.(process.pid)),
    );
    if (!managedRuntimeOwnsEveryLock) {
      return { ...attempt, recoveredFromLock: false, runtimeRestarted: false };
    }

    let runtimeStopAttempted = false;
    if (runtime) {
      runtimeStopAttempted = true;
      let runtimeStopped = false;
      try {
        await runtime.stop();
        runtimeStopped = true;
      } catch (error) {
        console.error(
          '[ManagedDirectoryOperations] Failed to stop runtime for a locked directory:',
          error instanceof Error ? error.message : error,
        );
      }
      if (runtimeStopped) {
        try {
          attempt = await options.operation();
        } catch (error) {
          attempt = managedDirectoryFailure(managedDirectoryFailureFromError(error, targetPath));
        }
      }
    }

    if ('failure' in attempt && attempt.failure.reason === 'locked') {
      attempt = { success: false, failure: await diagnoseLock(attempt.failure) };
    } else if ('failure' in attempt) {
      attempt = {
        success: false,
        failure: {
          ...attempt.failure,
          message: formatFailure(attempt.failure),
        },
      };
    }

    let runtimeRestarted = false;
    let runtimeRecoveryError = '';
    if (runtimeStopAttempted && runtime) {
      try {
        if (runtime.isRunning()) {
          runtimeRestarted = true;
        } else {
          const restart = await runtime.start();
          runtimeRestarted = restart.running;
          if (!restart.running) {
            runtimeRecoveryError =
              restart.message || 'The Gateway did not return to running state.';
          }
        }
      } catch (error) {
        runtimeRecoveryError = error instanceof Error ? error.message : String(error);
      }
      if (runtimeRecoveryError) {
        console.error(
          '[ManagedDirectoryOperations] Runtime restart failed after a directory mutation:',
          runtimeRecoveryError,
        );
        if ('failure' in attempt) {
          attempt = {
            success: false,
            failure: {
              ...attempt.failure,
              message: `${attempt.failure.message}\n\n${t('managedDirectoryRuntimeRecoveryFailed', {
                detail: runtimeRecoveryError,
              })}`,
            },
          };
        }
      }
    }

    return { ...attempt, recoveredFromLock: !('failure' in attempt), runtimeRestarted };
  }
}

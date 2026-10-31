import fs from 'node:fs';
import path from 'node:path';

import { DB_FILENAME } from '../../core/appConstants';
import { findWindowsLockingProcesses, type WindowsLockDiagnosticResult } from '../../core/filesystem/windowsFileLockDiagnostics';
import { ownedPath } from '../history/historyBackup';
import { rememberHistoryLockDiagnostic } from '../history/historyFailure';
import { startupPathExists } from './startupState';

const PROFILE_RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600] as const;
const PROFILE_RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

export function profileEntryKey(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

export function requiresProfileIsolation(name: string): boolean {
  const key = profileEntryKey(name);
  return key === 'openclaw' || key === 'outbound-header-proxy' || key === 'developer' ||
    key.startsWith(profileEntryKey(DB_FILENAME));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function diagnoseArchiveLock(source: string, assertActive: () => void, signal?: AbortSignal): Promise<WindowsLockDiagnosticResult> {
  try {
    assertActive();
    return signal ? await findWindowsLockingProcesses(source, { signal }) : await findWindowsLockingProcesses(source);
  } catch {
    // Diagnostics, including a quit racing this lookup, never replace the rename error.
    return { available: false, processes: [] };
  }
}

function waitForProfileRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Release an inherited directory handle before windows or children can inherit it. */
export function releaseStartupProfileWorkingDirectory(userData: string): string | undefined {
  const current = process.cwd();
  if (!isWithin(userData, current)) return;
  const entry = path.relative(userData, current).split(path.sep)[0];
  if (!entry || !requiresProfileIsolation(entry)) return;
  process.chdir(userData);
  return entry;
}

/** Same-volume archival remains mandatory; a transient Windows sharing error is not final. */
export async function archiveRequiredProfileEntry(
  userData: string,
  name: string,
  destinationRelative: string,
  options: { assertActive: () => void; beforeRetry: () => void; signal?: AbortSignal },
): Promise<void> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    options.assertActive();
    if (attempt > 0) options.beforeRetry();
    options.assertActive();
    // Re-resolve owned parents and refuse a destination created during a wait.
    const source = ownedPath(userData, name, true);
    const destination = ownedPath(userData, destinationRelative, true);
    if (!startupPathExists(source)) throw new Error('An isolated source entry is missing.');
    if (startupPathExists(destination))
      throw new Error('Startup isolation found a conflicting destination. No data was overwritten.');
    try {
      await fs.promises.rename(source, destination);
      if (attempt > 0)
        console.info('[StartupCoordinator] Required profile archive succeeded after retry:', {
          entry: name, attempts: attempt + 1, elapsedMs: Date.now() - startedAt,
        });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const delay = PROFILE_RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== 'win32' || !code || !PROFILE_RENAME_RETRY_CODES.has(code) || delay === undefined) {
        const diagnostic = process.platform === 'win32' && code && PROFILE_RENAME_RETRY_CODES.has(code)
          ? await diagnoseArchiveLock(source, options.assertActive, options.signal) : undefined;
        if (diagnostic) rememberHistoryLockDiagnostic(error, {
          targetPath: source,
          available: diagnostic.available,
          processes: diagnostic.processes.map(owner => ({
            name: owner.name, pid: owner.pid, isMainProcess: owner.pid === process.pid,
          })),
        });
        // These flags distinguish inherited working directories from other locks
        // without reading history, logging command lines, or guessing an owner.
        let cwdWithinSource: boolean | null = null;
        try { cwdWithinSource = isWithin(source, process.cwd()); } catch { /* cwd may have disappeared. */ }
        console.warn('[StartupCoordinator] Required profile archive failed:', {
          entry: name, code, attempts: attempt + 1, elapsedMs: Date.now() - startedAt,
          cwdWithinSource, executableWithinSource: isWithin(source, process.execPath),
          ...(diagnostic ? {
            lockDiagnosticsAvailable: diagnostic.available,
            processesWithDirectoryHandles: diagnostic.processes.map(owner => ({
              ...owner, isMainProcess: owner.pid === process.pid,
            })),
          } : {}),
        });
        throw error;
      }
      console.warn('[StartupCoordinator] Retrying a blocked required profile archive:', {
        entry: name, code, attempt: attempt + 1, delayMs: delay,
      });
      await waitForProfileRetry(delay, options.signal);
    }
  }
}

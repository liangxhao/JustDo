import type { DownloadItem, Session, WebContents } from 'electron';
import fs from 'fs';
import path from 'path';

import { sanitizeBrowserUrl } from '../data/browserDataSanitizers';

export type BrowserAgentDownloadResult = {
  state: 'completed' | 'cancelled' | 'interrupted';
  path: string;
  fileName: string;
  sourceUrl: string;
  receivedBytes: number;
  totalBytes: number;
};

type PendingDownload = {
  targetSession: Session;
  webContentsId: number;
  resolveSavePath: string | ((item: DownloadItem) => string);
  savePath?: string;
  resolve: (result: BrowserAgentDownloadResult | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  claimedItem?: DownloadItem;
  outputReservation?: BrowserAgentOutputPathReservation;
  removeAbortListener?: () => void;
  settled: boolean;
};

export type BrowserAgentOutputPathReservation = {
  /** The canonical absolute path that may be passed to Chromium or an atomic file writer. */
  path: string;
  /** Releases the process-wide claim. Safe to call more than once. */
  release: () => void;
};

export type BrowserAgentDownloadCapture = {
  result: Promise<BrowserAgentDownloadResult | null>;
  fail: (error: Error) => void;
  finishIfUnclaimed: () => boolean;
  isClaimed: () => boolean;
};

export type BrowserAgentDownloadClaim = {
  savePath: string | null;
  cancelled?: true;
  settle: (item: DownloadItem, state: 'completed' | 'cancelled' | 'interrupted') => void;
};

const pendingBySession = new WeakMap<Session, PendingDownload[]>();
const allPending = new Set<PendingDownload>();
const reservedOutputPaths = new Set<string>();

const realpathNative = (filePath: string): string =>
  typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);

const normalizeWindowsPathKey = (filePath: string): string => {
  let normalized = filePath;
  if (normalized.startsWith('\\\\?\\UNC\\')) {
    normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice('\\\\?\\'.length);
  }
  return path.win32.normalize(normalized).toLocaleLowerCase('en-US');
};

/**
 * Resolves aliases in the deepest existing ancestor, including Windows junctions.
 * The leaf itself need not exist yet, which is the normal state for downloads/PDFs.
 */
const canonicalOutputPathKey = (outputPath: string): { key: string; path: string } => {
  if (!path.isAbsolute(outputPath)) {
    throw new Error('The browser output path must be absolute.');
  }
  const absolutePath = path.normalize(outputPath);
  const missingSegments: string[] = [];
  let existingAncestor = absolutePath;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error('The browser output path has no existing ancestor.');
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathNative(existingAncestor);
  const canonicalPath = path.normalize(path.join(canonicalAncestor, ...missingSegments));
  return {
    key:
      process.platform === 'win32'
        ? normalizeWindowsPathKey(canonicalPath)
        : canonicalPath,
    path: canonicalPath,
  };
};

/**
 * Atomically reserves an output path within this Electron main process. Canonical
 * identity is based on the existing parent, so junction aliases cannot claim the
 * same destination twice. The caller must release the reservation on every exit.
 */
export const reserveBrowserAgentOutputPath = (
  outputPath: string,
): BrowserAgentOutputPathReservation => {
  const canonical = canonicalOutputPathKey(outputPath);
  if (reservedOutputPaths.has(canonical.key)) {
    throw new Error('The browser output path is already reserved by another operation.');
  }
  reservedOutputPaths.add(canonical.key);
  let released = false;
  return {
    path: canonical.path,
    release: () => {
      if (released) return;
      released = true;
      reservedOutputPaths.delete(canonical.key);
    },
  };
};

const releaseOutputReservation = (pending: PendingDownload): void => {
  pending.outputReservation?.release();
  pending.outputReservation = undefined;
};

const removePending = (targetSession: Session, pending: PendingDownload): void => {
  const entries = pendingBySession.get(targetSession);
  if (!entries) return;
  const index = entries.indexOf(pending);
  if (index >= 0) entries.splice(index, 1);
  if (!entries.length) pendingBySession.delete(targetSession);
  allPending.delete(pending);
};

const removePartialFile = (savePath: string): void => {
  try {
    if (fs.existsSync(savePath)) fs.rmSync(savePath, { force: true });
  } catch {
    // Best effort: Chromium may still have the partial file open while cancellation settles.
  }
};

const cancelPending = (pending: PendingDownload, error: Error): void => {
  if (pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  pending.removeAbortListener?.();
  removePending(pending.targetSession, pending);
  try {
    if (pending.claimedItem?.getState() === 'progressing') pending.claimedItem.cancel();
  } finally {
    try {
      if (pending.claimedItem && pending.savePath) removePartialFile(pending.savePath);
    } finally {
      releaseOutputReservation(pending);
      pending.reject(error);
    }
  }
};

const finishPendingWithoutDownload = (pending: PendingDownload): boolean => {
  if (pending.settled || pending.claimedItem) return false;
  pending.settled = true;
  clearTimeout(pending.timer);
  pending.removeAbortListener?.();
  removePending(pending.targetSession, pending);
  releaseOutputReservation(pending);
  pending.resolve(null);
  return true;
};

export const beginBrowserAgentDownload = (
  targetSession: Session,
  webContentsId: number,
  savePath: string | ((item: DownloadItem) => string),
  timeoutMs: number,
  signal?: AbortSignal,
): BrowserAgentDownloadCapture => {
  const initialReservation =
    typeof savePath === 'string' ? reserveBrowserAgentOutputPath(savePath) : undefined;
  let resolveResult!: (result: BrowserAgentDownloadResult | null) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<BrowserAgentDownloadResult | null>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch((): void => undefined);
  const pending = {} as PendingDownload;
  pending.targetSession = targetSession;
  pending.webContentsId = webContentsId;
  pending.resolveSavePath = savePath;
  if (initialReservation) {
    pending.outputReservation = initialReservation;
    pending.savePath = initialReservation.path;
  }
  pending.resolve = resolveResult;
  pending.reject = rejectResult;
  pending.settled = false;
  pending.timer = setTimeout(
    () => cancelPending(pending, new Error('Timed out waiting for the browser download.')),
    timeoutMs,
  );
  pending.timer.unref?.();
  const entries = pendingBySession.get(targetSession) ?? [];
  entries.push(pending);
  pendingBySession.set(targetSession, entries);
  allPending.add(pending);
  const handleAbort = () => cancelPending(pending, new Error('Browser download was cancelled.'));
  signal?.addEventListener('abort', handleAbort, { once: true });
  pending.removeAbortListener = () => signal?.removeEventListener('abort', handleAbort);
  if (signal?.aborted) handleAbort();
  return {
    result,
    fail: error => cancelPending(pending, error),
    finishIfUnclaimed: () => finishPendingWithoutDownload(pending),
    isClaimed: () => Boolean(pending.claimedItem),
  };
};

export const armBrowserAgentDownload = async (
  targetSession: Session,
  webContentsId: number,
  savePath: string | ((item: DownloadItem) => string),
  timeoutMs: number,
  trigger: () => Promise<void>,
  signal?: AbortSignal,
): Promise<BrowserAgentDownloadResult> => {
  const capture = beginBrowserAgentDownload(
    targetSession,
    webContentsId,
    savePath,
    timeoutMs,
    signal,
  );
  try {
    await trigger();
  } catch (error) {
    capture.fail(error instanceof Error ? error : new Error(String(error)));
  }
  const result = await capture.result;
  if (!result) throw new Error('Timed out waiting for the browser download.');
  return result;
};

export const cancelBrowserAgentDownloadsForWebContents = (
  webContentsId: number,
  error = new Error('The browser tab closed before the download completed.'),
): void => {
  for (const pending of [...allPending]) {
    if (pending.webContentsId !== webContentsId) continue;
    if (!finishPendingWithoutDownload(pending)) cancelPending(pending, error);
  }
};

export const cancelAllBrowserAgentDownloads = (
  error = new Error('The browser window closed before the download completed.'),
): void => {
  for (const pending of [...allPending]) cancelPending(pending, error);
};

export const claimBrowserAgentDownload = (
  targetSession: Session,
  item: DownloadItem,
  originWebContents?: WebContents,
): BrowserAgentDownloadClaim | null => {
  const entries = pendingBySession.get(targetSession);
  if (!entries?.length || !originWebContents) return null;
  const pending = entries.find(
    entry => entry.webContentsId === originWebContents.id && !entry.claimedItem && !entry.settled,
  );
  if (!pending) return null;
  pending.claimedItem = item;
  try {
    if (typeof pending.resolveSavePath === 'function') {
      const resolvedSavePath = pending.resolveSavePath(item);
      pending.outputReservation = reserveBrowserAgentOutputPath(resolvedSavePath);
      pending.savePath = pending.outputReservation.path;
    }
  } catch (error) {
    cancelPending(pending, error instanceof Error ? error : new Error(String(error)));
    return { savePath: null, cancelled: true, settle: () => undefined };
  }
  let settled = false;
  return {
    savePath: pending.savePath,
    settle(download, state) {
      if (settled) return;
      settled = true;
      if (pending.settled) {
        if (pending.savePath) removePartialFile(pending.savePath);
        return;
      }
      pending.settled = true;
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      removePending(targetSession, pending);
      try {
        if (state !== 'completed') removePartialFile(pending.savePath!);
        pending.resolve({
          state,
          path: pending.savePath!,
          fileName: download.getFilename(),
          sourceUrl: sanitizeBrowserUrl(download.getURL()),
          receivedBytes: download.getReceivedBytes(),
          totalBytes: download.getTotalBytes(),
        });
      } finally {
        releaseOutputReservation(pending);
      }
    },
  };
};

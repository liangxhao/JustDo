import crypto from 'crypto';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, Menu, shell } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  type FilePreviewEditAuthorizationRequest,
  type FilePreviewEditAuthorizationResult,
  FilePreviewIpc,
  type FilePreviewReadResult,
  type FilePreviewWriteRequest,
  type FilePreviewWriteResult,
  getPreviewableFileExtension,
  MAX_PREVIEW_FILE_BYTES,
} from '../../../shared/filePreview';
import { t } from '../../core/i18n';

const AttachmentMenuAction = {
  OPEN: 'open',
  OPEN_WITH_SYSTEM: 'open-with-system',
  SHOW_IN_FOLDER: 'show-in-folder',
} as const;

const DOWNLOADABLE_IMAGE_PROTOCOLS = new Set([
  'blob:',
  'data:',
  'file:',
  'http:',
  'https:',
  'localfile:',
]);

export const isDownloadableImageUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') return /^data:image\/[a-z0-9.+-]+[;,]/i.test(value);
    return DOWNLOADABLE_IMAGE_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeWindowsShellPath = (inputPath: string): string => {
  if (process.platform !== 'win32') return inputPath;

  const trimmed = inputPath.trim();
  if (!trimmed) return inputPath;

  let normalized = trimmed;
  if (/^file:\/\//i.test(normalized)) {
    normalized = safeDecodeURIComponent(normalized.replace(/^file:\/\//i, ''));
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  const unixDriveMatch = normalized.match(/^[/\\]([A-Za-z])[/\\](.+)$/);
  if (unixDriveMatch) {
    const drive = unixDriveMatch[1].toUpperCase();
    const rest = unixDriveMatch[2].replace(/[/\\]+/g, '\\');
    return `${drive}:\\${rest}`;
  }

  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(1).replace(/\//g, '\\');
    return `${drive}${rest}`;
  }

  return normalized;
};

export const resolveShellOpenPath = (filePath: string, workingDirectory?: string): string => {
  const normalizedPath = normalizeWindowsShellPath(filePath);
  if (path.isAbsolute(normalizedPath) || !workingDirectory?.trim()) {
    return normalizedPath;
  }

  const resolvedPath = path.resolve(
    normalizeWindowsShellPath(workingDirectory.trim()),
    normalizedPath,
  );
  return fs.existsSync(resolvedPath) ? resolvedPath : normalizedPath;
};

export const createPreviewFileVersion = (content: Buffer | string): string =>
  crypto.createHash('sha256').update(content).digest('hex');

const PREVIEW_EDIT_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEW_EDIT_GRANTS = 128;

interface PreviewFileIdentity {
  dev: number;
  ino: number;
}

interface PreviewEditGrant {
  authorized: boolean;
  expiresAt: number;
  filePath: string;
  identity: PreviewFileIdentity;
  ownerId?: number;
  version: string;
  wasAuthorized: boolean;
}

interface InspectedPreviewFile {
  content: Buffer;
  identity: PreviewFileIdentity;
  mode: number;
  version: string;
}

type PreviewConflictDecision = 'cancel' | 'overwrite' | 'reload';

interface WritePreviewFileOptions {
  ownerId?: number;
  resolveConflict?: (filePath: string) => Promise<PreviewConflictDecision>;
}

interface AuthorizePreviewFileEditOptions {
  ownerId: number;
}

const previewEditGrants = new Map<string, PreviewEditGrant>();

const isFileIdentityEqual = (left: PreviewFileIdentity, right: PreviewFileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const toFileIdentity = (stats: fs.Stats): PreviewFileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
});

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const pruneExpiredPreviewEditGrants = (): void => {
  const now = Date.now();
  for (const [token, grant] of previewEditGrants) {
    if (grant.expiresAt > now) continue;
    if (grant.wasAuthorized) {
      grant.authorized = false;
      grant.expiresAt = now + PREVIEW_EDIT_GRANT_TTL_MS;
    } else {
      previewEditGrants.delete(token);
    }
  }
};

const inspectPreviewFile = async (filePath: string): Promise<InspectedPreviewFile> => {
  const pathStats = await fs.promises.lstat(filePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error('Preview file must be a regular file');
  }
  if (pathStats.size > MAX_PREVIEW_FILE_BYTES) {
    const error = new Error('Preview file is too large');
    Object.assign(error, { code: 'EFBIG' });
    throw error;
  }

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !isFileIdentityEqual(toFileIdentity(pathStats), toFileIdentity(before))
    ) {
      throw new Error('Preview file changed while opening');
    }
    if (before.size > MAX_PREVIEW_FILE_BYTES) {
      const error = new Error('Preview file is too large');
      Object.assign(error, { code: 'EFBIG' });
      throw error;
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      !isFileIdentityEqual(toFileIdentity(before), toFileIdentity(after)) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('Preview file changed while reading');
    }
    if (content.byteLength > MAX_PREVIEW_FILE_BYTES || after.size > MAX_PREVIEW_FILE_BYTES) {
      const error = new Error('Preview file is too large');
      Object.assign(error, { code: 'EFBIG' });
      throw error;
    }
    return {
      content,
      identity: toFileIdentity(after),
      mode: after.mode,
      version: createPreviewFileVersion(content),
    };
  } finally {
    await handle.close();
  }
};

const replacePreviewFileAtomically = async (
  filePath: string,
  content: string,
  expected: InspectedPreviewFile,
): Promise<{ conflict: boolean; identity?: PreviewFileIdentity; version?: string }> => {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    const temporaryHandle = await fs.promises.open(temporaryPath, 'wx', expected.mode & 0o777);
    temporaryCreated = true;
    try {
      await temporaryHandle.writeFile(content, 'utf8');
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }

    const latest = await inspectPreviewFile(filePath);
    if (
      !isFileIdentityEqual(latest.identity, expected.identity) ||
      latest.version !== expected.version
    ) {
      return { conflict: true };
    }

    await fs.promises.rename(temporaryPath, filePath);
    temporaryCreated = false;
    const replaced = await inspectPreviewFile(filePath);
    return { conflict: false, identity: replaced.identity, version: replaced.version };
  } finally {
    if (temporaryCreated) {
      await fs.promises.unlink(temporaryPath).catch((): undefined => undefined);
    }
  }
};

export const readPreviewFile = async (
  filePath: string,
  workingDirectory?: string,
  ownerId?: number,
): Promise<FilePreviewReadResult> => {
  try {
    const normalizedPath = resolveShellOpenPath(filePath, workingDirectory);
    if (!getPreviewableFileExtension(normalizedPath)) {
      return { success: false, error: 'Unsupported preview file type' };
    }
    const requestedStats = await fs.promises.lstat(normalizedPath);
    if (requestedStats.isSymbolicLink() || !requestedStats.isFile()) {
      return { success: false, error: 'Preview file must be a regular file' };
    }
    const canonicalPath = await fs.promises.realpath(normalizedPath);
    if (!getPreviewableFileExtension(canonicalPath)) {
      return { success: false, error: 'Unsupported preview file type' };
    }
    const inspected = await inspectPreviewFile(canonicalPath);
    if (!isFileIdentityEqual(toFileIdentity(requestedStats), inspected.identity)) {
      return { success: false, error: 'Preview file changed while opening' };
    }
    pruneExpiredPreviewEditGrants();
    if (previewEditGrants.size >= MAX_PREVIEW_EDIT_GRANTS) {
      const disposableGrant = [...previewEditGrants].find(([, grant]) => !grant.wasAuthorized);
      if (disposableGrant) previewEditGrants.delete(disposableGrant[0]);
    }
    if (previewEditGrants.size >= MAX_PREVIEW_EDIT_GRANTS) {
      return { success: false, error: 'Too many active preview edit grants' };
    }
    const editToken = crypto.randomUUID();
    previewEditGrants.set(editToken, {
      authorized: ownerId === undefined,
      expiresAt: Date.now() + PREVIEW_EDIT_GRANT_TTL_MS,
      filePath: canonicalPath,
      identity: inspected.identity,
      ownerId,
      version: inspected.version,
      wasAuthorized: ownerId === undefined,
    });
    return {
      success: true,
      content: inspected.content.toString('utf8'),
      editToken,
      filePath: canonicalPath,
      version: inspected.version,
    };
  } catch (error) {
    if (isMissingFileError(error)) return { success: false, notFound: true };
    if (error instanceof Error && 'code' in error && error.code === 'EFBIG') {
      return { success: false, tooLarge: true, error: error.message };
    }
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

export const authorizePreviewFileEdit = async (
  request: FilePreviewEditAuthorizationRequest,
  options: AuthorizePreviewFileEditOptions,
): Promise<FilePreviewEditAuthorizationResult> => {
  try {
    if (
      !request ||
      typeof request.editToken !== 'string' ||
      typeof request.expectedVersion !== 'string'
    ) {
      return { success: false, error: 'Invalid preview edit authorization request' };
    }

    pruneExpiredPreviewEditGrants();
    const grant = previewEditGrants.get(request.editToken);
    if (!grant || grant.expiresAt <= Date.now()) {
      previewEditGrants.delete(request.editToken);
      return {
        success: false,
        error: 'Preview edit grant is invalid or expired',
        reload: true,
      };
    }
    if (grant.ownerId !== options.ownerId) {
      return { success: false, error: 'Preview edit grant belongs to another renderer' };
    }
    if (request.expectedVersion !== grant.version) {
      return { success: false, conflict: true, reload: true };
    }

    const current = await inspectPreviewFile(grant.filePath);
    if (
      !isFileIdentityEqual(current.identity, grant.identity) ||
      current.version !== grant.version
    ) {
      return { success: false, conflict: true, reload: true };
    }
    grant.authorized = true;
    grant.expiresAt = Date.now() + PREVIEW_EDIT_GRANT_TTL_MS;
    grant.wasAuthorized = true;
    return { success: true };
  } catch (error) {
    if (isMissingFileError(error)) return { success: false, notFound: true };
    if (error instanceof Error && 'code' in error && error.code === 'EFBIG') {
      return { success: false, tooLarge: true, error: error.message };
    }
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

export const revokePreviewFileEdit = (editToken: string, ownerId: number): void => {
  if (typeof editToken !== 'string') return;
  const grant = previewEditGrants.get(editToken);
  if (grant?.ownerId === ownerId) previewEditGrants.delete(editToken);
};

export const writePreviewFile = async (
  request: FilePreviewWriteRequest,
  options: WritePreviewFileOptions = {},
): Promise<FilePreviewWriteResult> => {
  try {
    if (
      !request ||
      typeof request.content !== 'string' ||
      typeof request.editToken !== 'string' ||
      typeof request.expectedVersion !== 'string'
    ) {
      return { success: false, error: 'Invalid preview file write request' };
    }
    if (Buffer.byteLength(request.content, 'utf8') > MAX_PREVIEW_FILE_BYTES) {
      return { success: false, tooLarge: true, error: 'Preview file is too large' };
    }

    pruneExpiredPreviewEditGrants();
    const grant = previewEditGrants.get(request.editToken);
    if (!grant || grant.expiresAt <= Date.now()) {
      previewEditGrants.delete(request.editToken);
      return { success: false, error: 'Preview edit grant is invalid or expired' };
    }
    if (grant.ownerId !== undefined && grant.ownerId !== options.ownerId) {
      return { success: false, error: 'Preview edit grant belongs to another renderer' };
    }
    if (!grant.authorized) {
      return { success: false, unauthorized: true, error: 'Preview edit is not authorized' };
    }
    if (request.expectedVersion !== grant.version) {
      return { success: false, conflict: true };
    }

    let current = await inspectPreviewFile(grant.filePath);
    const changedExternally =
      !isFileIdentityEqual(current.identity, grant.identity) || current.version !== grant.version;
    if (changedExternally) {
      const decision = options.resolveConflict
        ? await options.resolveConflict(grant.filePath)
        : 'cancel';
      if (decision === 'reload') {
        return { success: false, conflict: true, reload: true };
      }
      if (decision !== 'overwrite') return { success: false, conflict: true };
      current = await inspectPreviewFile(grant.filePath);
    }

    const replaced = await replacePreviewFileAtomically(grant.filePath, request.content, current);
    if (
      replaced.conflict ||
      !replaced.identity ||
      !replaced.version ||
      replaced.version !== createPreviewFileVersion(request.content)
    ) {
      return { success: false, conflict: true };
    }

    grant.expiresAt = Date.now() + PREVIEW_EDIT_GRANT_TTL_MS;
    grant.identity = replaced.identity;
    grant.version = replaced.version;
    return { success: true, version: replaced.version };
  } catch (error) {
    if (isMissingFileError(error)) return { success: false, notFound: true };
    if (error instanceof Error && 'code' in error && error.code === 'EFBIG') {
      return { success: false, tooLarge: true, error: error.message };
    }
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

const resolvePreviewFileConflict = async (
  event: IpcMainInvokeEvent,
  filePath: string,
): Promise<PreviewConflictDecision> => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: 'warning' as const,
    buttons: [
      t('filePreviewConflictOverwrite'),
      t('filePreviewConflictReload'),
      t('filePreviewConflictCancel'),
    ],
    defaultId: 2,
    cancelId: 2,
    title: t('filePreviewConflictTitle'),
    message: t('filePreviewConflictMessage'),
    detail: filePath,
    noLink: true,
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) return 'overwrite';
  if (result.response === 1) return 'reload';
  return 'cancel';
};

export const registerShellHandlers = (): void => {
  ipcMain.handle('shell:showAttachmentContextMenu', event => {
    return new Promise<string | null>(resolve => {
      let selectedAction: string | null = null;
      const select = (action: string): void => {
        selectedAction = action;
      };
      const menu = Menu.buildFromTemplate([
        {
          label: t('attachmentMenuOpen'),
          click: () => select(AttachmentMenuAction.OPEN),
        },
        {
          label: t('attachmentMenuOpenWithSystem'),
          click: () => select(AttachmentMenuAction.OPEN_WITH_SYSTEM),
        },
        { type: 'separator' },
        {
          label: t('attachmentMenuShowInFolder'),
          click: () => select(AttachmentMenuAction.SHOW_IN_FOLDER),
        },
      ]);
      menu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        callback: () => resolve(selectedAction),
      });
    });
  });

  ipcMain.handle('shell:showImageContextMenu', (event, imageUrl: string) => {
    return new Promise<{ success: boolean; error?: string }>(resolve => {
      let result: { success: boolean; error?: string } = { success: true };
      const menu = Menu.buildFromTemplate([
        {
          label: t('imageMenuSaveAs'),
          enabled: typeof imageUrl === 'string' && isDownloadableImageUrl(imageUrl),
          click: () => {
            try {
              event.sender.downloadURL(imageUrl);
            } catch (error) {
              result = {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to save image',
              };
            }
          },
        },
      ]);
      menu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        callback: () => resolve(result),
      });
    });
  });

  ipcMain.handle('shell:openPath', async (_event, filePath: string, workingDirectory?: string) => {
    try {
      const normalizedPath = resolveShellOpenPath(filePath, workingDirectory);
      if (!fs.existsSync(normalizedPath)) {
        return { success: false, notFound: true };
      }
      const result = await shell.openPath(normalizedPath);
      return result ? { success: false, error: result } : { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(FilePreviewIpc.Read, (event, filePath: string, workingDirectory?: string) =>
    readPreviewFile(filePath, workingDirectory, event.sender.id),
  );

  ipcMain.handle(
    FilePreviewIpc.AuthorizeEdit,
    (event, request: FilePreviewEditAuthorizationRequest) =>
      authorizePreviewFileEdit(request, {
        ownerId: event.sender.id,
      }),
  );

  ipcMain.handle(FilePreviewIpc.RevokeEdit, (event, editToken: string) => {
    revokePreviewFileEdit(editToken, event.sender.id);
  });

  ipcMain.handle(FilePreviewIpc.Write, (event, request: FilePreviewWriteRequest) =>
    writePreviewFile(request, {
      ownerId: event.sender.id,
      resolveConflict: filePath => resolvePreviewFileConflict(event, filePath),
    }),
  );

  ipcMain.handle(
    'shell:showItemInFolder',
    async (_event, filePath: string, workingDirectory?: string) => {
      try {
        const normalizedPath = resolveShellOpenPath(filePath, workingDirectory);
        if (!fs.existsSync(normalizedPath)) {
          return { success: false, notFound: true };
        }
        shell.showItemInFolder(normalizedPath);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  );

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
};

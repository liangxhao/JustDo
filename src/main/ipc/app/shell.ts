import { BrowserWindow, ipcMain, Menu, shell } from 'electron';
import fs from 'fs';
import path from 'path';

import { getPreviewableFileExtension } from '../../../shared/filePreview';
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

  ipcMain.handle(
    'shell:readPreviewFile',
    async (_event, filePath: string, workingDirectory?: string) => {
      try {
        const normalizedPath = resolveShellOpenPath(filePath, workingDirectory);
        if (!getPreviewableFileExtension(normalizedPath)) {
          return { success: false, error: 'Unsupported preview file type' };
        }
        if (!fs.existsSync(normalizedPath)) {
          return { success: false, notFound: true };
        }
        const content = await fs.promises.readFile(normalizedPath, 'utf8');
        return { success: true, content, filePath: normalizedPath };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
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

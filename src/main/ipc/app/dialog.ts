import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  DialogIpc,
  SaveTextFileErrorCode,
  type SaveTextFileOptions,
  type SaveTextFileResult,
} from '../../../shared/dialogIpc';

type FileFilters = { name: string; extensions: string[] }[];

const MAX_TEXT_FILE_BYTES = 50 * 1024 * 1024;
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;

const sanitizeDefaultFileName = (value: string): string =>
  path.basename(value).replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim() ||
  'export.json';

export const registerDialogHandlers = (): void => {
  ipcMain.handle(
    DialogIpc.SaveTextFile,
    async (event, input?: SaveTextFileOptions): Promise<SaveTextFileResult> => {
      try {
        if (!input || typeof input.content !== 'string') {
          return { success: false, errorCode: SaveTextFileErrorCode.MissingContent };
        }
        if (Buffer.byteLength(input.content, 'utf8') > MAX_TEXT_FILE_BYTES) {
          return { success: false, errorCode: SaveTextFileErrorCode.FileTooLarge };
        }

        const ownerWindow = BrowserWindow.fromWebContents(event.sender);
        const saveOptions = {
          title: input.title,
          defaultPath: path.join(
            app.getPath('downloads'),
            sanitizeDefaultFileName(input.defaultFileName),
          ),
          filters: input.filters,
        };
        const result = ownerWindow
          ? await dialog.showSaveDialog(ownerWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (result.canceled || !result.filePath) {
          return { success: true, canceled: true };
        }

        await fs.promises.writeFile(result.filePath, input.content, 'utf8');
        return { success: true, canceled: false, path: result.filePath };
      } catch (error) {
        console.error('[Dialog] Failed to save text file:', error);
        return {
          success: false,
          errorCode: SaveTextFileErrorCode.SaveFailed,
        };
      }
    },
  );

  ipcMain.handle('dialog:selectDirectory', async event => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    return { success: true, path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  ipcMain.handle(
    'dialog:selectFile',
    async (event, input?: { title?: string; filters?: FileFilters }) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const options = {
        properties: ['openFile'] as 'openFile'[],
        title: input?.title,
        filters: input?.filters,
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, options)
        : await dialog.showOpenDialog(options);
      return { success: true, path: result.canceled ? null : (result.filePaths[0] ?? null) };
    },
  );

  ipcMain.handle(
    'dialog:selectFiles',
    async (event, input?: { title?: string; filters?: FileFilters }) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const options = {
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        title: input?.title,
        filters: input?.filters,
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, options)
        : await dialog.showOpenDialog(options);
      return { success: true, paths: result.canceled ? [] : result.filePaths };
    },
  );

  ipcMain.handle('dialog:selectFolders', async (event, input?: { title?: string }) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ['openDirectory', 'multiSelections', 'createDirectory'] as (
        'openDirectory' | 'multiSelections' | 'createDirectory'
      )[],
      title: input?.title,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    return { success: true, paths: result.canceled ? [] : result.filePaths };
  });
};

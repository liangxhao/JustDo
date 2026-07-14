import { BrowserWindow, dialog, ipcMain } from 'electron';

type FileFilters = { name: string; extensions: string[] }[];

export const registerDialogHandlers = (): void => {
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
        | 'openDirectory'
        | 'multiSelections'
        | 'createDirectory'
      )[],
      title: input?.title,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    return { success: true, paths: result.canceled ? [] : result.filePaths };
  });
};

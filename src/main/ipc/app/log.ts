import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';

import { LogIpc } from '../../../shared/logIpc';
import { getLogFilePath, getRecentMainLogEntries } from '../../core/logger';
import { getCoworkLogPath } from '../../cowork/coworkLogger';
import { exportLogsZip } from './logExport';

const padTwoDigits = (value: number): string => value.toString().padStart(2, '0');

const buildLogExportFileName = (): string => {
  const now = new Date();
  const datePart = `${now.getFullYear()}${padTwoDigits(now.getMonth() + 1)}${padTwoDigits(now.getDate())}`;
  const timePart = `${padTwoDigits(now.getHours())}${padTwoDigits(now.getMinutes())}${padTwoDigits(now.getSeconds())}`;
  return `justdo-logs-${datePart}-${timePart}.zip`;
};

const ensureZipFileName = (value: string): string =>
  value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;

export const registerLogHandlers = (): void => {
  ipcMain.removeAllListeners(LogIpc.WriteDebug);
  ipcMain.on(LogIpc.WriteDebug, (_event, message: string, details?: Record<string, unknown>) => {
    console.debug(`[Renderer] ${message}`, details ?? {});
  });

  ipcMain.handle('log:getPath', () => getLogFilePath());
  ipcMain.handle('log:openFolder', () => {
    const logPath = getLogFilePath();
    if (logPath) shell.showItemInFolder(logPath);
  });

  ipcMain.handle('log:exportZip', async event => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { success: false, error: 'Window is not available' };
      }
      const saveResult = await dialog.showSaveDialog(ownerWindow, {
        title: 'Export Logs',
        defaultPath: path.join(app.getPath('downloads'), buildLogExportFileName()),
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true };
      }
      const outputPath = ensureZipFileName(saveResult.filePath);
      const archiveResult = await exportLogsZip({
        outputPath,
        entries: [
          ...getRecentMainLogEntries(),
          { archiveName: 'cowork.log', filePath: getCoworkLogPath() },
        ],
      });
      return {
        success: true,
        canceled: false,
        path: outputPath,
        missingEntries: archiveResult.missingEntries,
      };
    } catch (error) {
      console.error('[LogExport] export failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export logs',
      };
    }
  });
};

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';

interface WindowHandlerDependencies {
  getMainWindow: () => BrowserWindow | null;
  showSystemMenu: (position?: { x?: number; y?: number }) => void;
}

export const registerWindowHandlers = ({
  getMainWindow,
  showSystemMenu,
}: WindowHandlerDependencies): void => {
  ipcMain.on('window-minimize', () => {
    getMainWindow()?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    getMainWindow()?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return getMainWindow()?.isMaximized() ?? false;
  });

  ipcMain.on(
    'window:showSystemMenu',
    (_event, position: { x?: number; y?: number } | undefined) => {
      showSystemMenu(position);
    },
  );
};

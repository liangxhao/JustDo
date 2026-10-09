import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { AuthIpc } from '../../../shared/app/auth';
import type { LoginService } from '../../core/app/auth/loginService';

/** No Renderer credential payload or unconditional authentication callback is exposed. */
export function registerAuthHandlers(dependencies: {
  getService: () => LoginService;
  getMainWindow: () => BrowserWindow | null;
}): void {
  const serviceFor = (event: IpcMainInvokeEvent) => {
    const window = dependencies.getMainWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('Account operations require the main application frame.');
    }
    return dependencies.getService();
  };
  ipcMain.handle(AuthIpc.GetState, event => serviceFor(event).getState());
  ipcMain.handle(AuthIpc.Login, event => serviceFor(event).login());
  ipcMain.handle(AuthIpc.Logout, event => serviceFor(event).logout());
  ipcMain.handle(AuthIpc.RetrySync, event => serviceFor(event).retrySync());
}

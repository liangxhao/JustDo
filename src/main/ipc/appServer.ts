import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { AppServerIntegrationIpc } from '../../shared/integrations/appServerIntegration';
import type { AppServerIntegrationService } from '../appServer/appServerIntegrationService';

export function registerAppServerIntegrationHandlers(options: {
  getService: () => AppServerIntegrationService;
  getMainWindow: () => BrowserWindow | null;
  isQuitting?: () => boolean;
}): void {
  const serviceFor = (event: IpcMainInvokeEvent): AppServerIntegrationService => {
    const window = options.getMainWindow();
    if (
      options.isQuitting?.() ||
      !window ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('Application connection settings require the main application frame.');
    }
    return options.getService();
  };
  ipcMain.handle(AppServerIntegrationIpc.GetStatus, event => serviceFor(event).getStatus());
  ipcMain.handle(AppServerIntegrationIpc.GetConnectionConfig, event =>
    serviceFor(event).getConnectionConfig(),
  );
}

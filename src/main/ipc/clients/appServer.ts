import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { AppServerIntegrationIpc, isAppServerPort } from '../../../shared/integrations/appServerIntegration';
import type { AppServerIntegrationService } from '../../clients/appServer/appServerIntegrationService';

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
  ipcMain.handle(AppServerIntegrationIpc.SetPort, (event, port: unknown) => {
    const service = serviceFor(event);
    if (!isAppServerPort(port)) throw new Error('Invalid application connection port.');
    return service.setPort(port);
  });
  ipcMain.handle(AppServerIntegrationIpc.RegenerateToken, event => serviceFor(event).regenerateToken());
}

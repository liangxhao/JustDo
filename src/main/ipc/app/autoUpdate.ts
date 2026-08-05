import { ipcMain } from 'electron';

import { AppUpdateIpc } from '../../../shared/appUpdate';
import type { AutoUpdateService } from '../../core/autoUpdateService';

export const registerAutoUpdateHandlers = (service: AutoUpdateService): void => {
  ipcMain.handle(AppUpdateIpc.GetState, () => service.getState());
  ipcMain.handle(AppUpdateIpc.Check, () => service.checkForUpdates());
  ipcMain.handle(AppUpdateIpc.QuitAndInstall, () => service.quitAndInstall());
};

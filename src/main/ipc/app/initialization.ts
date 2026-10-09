import { app, ipcMain } from 'electron';

import { AppInitializationIpc, AppInitializationPhase } from '../../../shared/app/initialization';
import type { AppInitialization } from '../../core/app/appInitialization';

export function registerAppInitializationHandlers(initialization: AppInitialization): void {
  ipcMain.handle(AppInitializationIpc.GetState, () => initialization.getState());
  ipcMain.handle(AppInitializationIpc.Relaunch, () => {
    if (initialization.getState().phase !== AppInitializationPhase.Failed) return;
    app.relaunch();
    app.quit();
  });
}

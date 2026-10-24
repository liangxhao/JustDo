import { app, type BrowserWindow, ipcMain } from 'electron';

import { AppInitializationIpc, AppInitializationPhase } from '../../../shared/app/initialization';
import type { AppInitialization } from './appInitialization';

export function registerAppInitializationHandlers(initialization: AppInitialization, downgrade?: {
  getWindow: () => BrowserWindow | null;
  canConfirm: () => boolean;
  confirm: (requestId: string) => boolean;
}): void {
  ipcMain.handle(AppInitializationIpc.GetState, () => initialization.getState());
  ipcMain.handle(AppInitializationIpc.Relaunch, () => {
    if (initialization.getState().phase !== AppInitializationPhase.Failed) return;
    app.relaunch();
    app.quit();
  });
  ipcMain.handle(AppInitializationIpc.ConfirmDowngrade, (event, input: unknown): { confirmed: boolean } => {
    const window = downgrade?.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() ||
        event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame ||
        !downgrade?.canConfirm() || initialization.getState().phase !== AppInitializationPhase.Preparing ||
        !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !('requestId' in input) ||
        typeof input.requestId !== 'string' || input.requestId.length !== 36 ||
        input.requestId !== initialization.getState().downgradeConfirmation?.requestId)
      return { confirmed: false };
    const confirmed = downgrade.confirm(input.requestId);
    if (confirmed) initialization.setDowngradeConfirmation(undefined);
    return { confirmed };
  });
}

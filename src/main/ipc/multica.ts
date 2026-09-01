import { ipcMain } from 'electron';

import { MulticaIntegrationIpc } from '../../shared/multica';
import type { MulticaIntegrationService } from '../integrations/multica/multicaIntegrationService';

export function registerMulticaIntegrationHandlers(
  getService: () => MulticaIntegrationService,
): void {
  ipcMain.handle(MulticaIntegrationIpc.GetStatus, () => getService().getStatus());
  ipcMain.handle(MulticaIntegrationIpc.Enable, () => getService().enable());
  ipcMain.handle(MulticaIntegrationIpc.Disable, () => getService().disable());
  ipcMain.handle(MulticaIntegrationIpc.Refresh, () => getService().refresh());
}

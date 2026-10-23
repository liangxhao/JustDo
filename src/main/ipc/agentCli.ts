import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { AgentCliIntegrationIpc } from '../../shared/integrations/agentCliIntegration';
import type { AgentCliIntegrationService } from '../integrations/externalAgent/agentCliIntegrationService';

export function registerAgentCliIntegrationHandlers(options: {
  getService: () => AgentCliIntegrationService;
  getMainWindow: () => BrowserWindow | null;
}): void {
  const serviceFor = (event: IpcMainInvokeEvent): AgentCliIntegrationService => {
    const window = options.getMainWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('CLI settings require the main application frame.');
    }
    return options.getService();
  };
  ipcMain.handle(AgentCliIntegrationIpc.GetStatus, event => serviceFor(event).getStatus());
}

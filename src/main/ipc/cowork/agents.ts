import { ipcMain } from 'electron';

import type { CoworkStore } from '../../coworkStore';

interface AgentHandlerDependencies {
  getStore: () => CoworkStore;
}

export const registerAgentHandlers = ({
  getStore,
}: AgentHandlerDependencies): void => {
  ipcMain.handle('agents:list', async () => {
    try {
      return { success: true, agents: getStore().listAgents() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agents',
      };
    }
  });
};

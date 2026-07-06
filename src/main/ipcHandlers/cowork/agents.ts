import { ipcMain } from 'electron';

import type { CoworkStore, CreateAgentRequest, UpdateAgentRequest } from '../../coworkStore';

interface AgentHandlerDependencies {
  getStore: () => CoworkStore;
  resolveDefaultModelRef: () => string;
  syncConfig: (reason: string) => Promise<unknown>;
}

export const registerAgentHandlers = ({
  getStore,
  resolveDefaultModelRef,
  syncConfig,
}: AgentHandlerDependencies): void => {
  const syncInBackground = (reason: string): void => {
    void syncConfig(reason).catch(() => {});
  };

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

  ipcMain.handle('agents:get', async (_event, id: string) => {
    try {
      return { success: true, agent: getStore().getAgent(id) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get agent',
      };
    }
  });

  ipcMain.handle('agents:create', async (_event, request: CreateAgentRequest) => {
    try {
      const agent = getStore().createAgent({
        ...request,
        model: request.model?.trim() || resolveDefaultModelRef().trim() || '',
      });
      syncInBackground('agent-created');
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create agent',
      };
    }
  });

  ipcMain.handle('agents:update', async (_event, id: string, updates: UpdateAgentRequest) => {
    try {
      const agent = getStore().updateAgent(id, updates);
      syncInBackground('agent-updated');
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update agent',
      };
    }
  });

  ipcMain.handle('agents:delete', async (_event, id: string) => {
    try {
      const deleted = getStore().deleteAgent(id);
      syncInBackground('agent-deleted');
      return { success: true, deleted };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete agent',
      };
    }
  });

};

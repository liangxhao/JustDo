import { ipcMain } from 'electron';

import type { CreateAgentRequest, UpdateAgentRequest } from '../../coworkStore';
import type { AgentManager } from '../../features/agentManager';

interface AgentHandlerDependencies {
  getManager: () => AgentManager;
  resolveDefaultModelRef: () => string;
  syncConfig: (reason: string) => Promise<unknown>;
}

export const registerAgentHandlers = ({
  getManager,
  resolveDefaultModelRef,
  syncConfig,
}: AgentHandlerDependencies): void => {
  const syncInBackground = (reason: string): void => {
    void syncConfig(reason).catch(() => {});
  };

  ipcMain.handle('agents:list', async () => {
    try {
      return { success: true, agents: getManager().listAgents() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agents',
      };
    }
  });

  ipcMain.handle('agents:get', async (_event, id: string) => {
    try {
      return { success: true, agent: getManager().getAgent(id) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get agent',
      };
    }
  });

  ipcMain.handle('agents:create', async (_event, request: CreateAgentRequest) => {
    try {
      const agent = getManager().createAgent(request, resolveDefaultModelRef());
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
      const agent = getManager().updateAgent(id, updates);
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
      const deleted = getManager().deleteAgent(id);
      syncInBackground('agent-deleted');
      return { success: true, deleted };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete agent',
      };
    }
  });

  ipcMain.handle('agents:presets', async () => {
    try {
      return { success: true, presets: getManager().getPresetAgents() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get presets',
      };
    }
  });

  ipcMain.handle('agents:addPreset', async (_event, presetId: string) => {
    try {
      const agent = getManager().addPresetAgent(presetId, resolveDefaultModelRef());
      syncInBackground('agent-preset-added');
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add preset agent',
      };
    }
  });
};

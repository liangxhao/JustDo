import { ipcMain } from 'electron';

import type { McpServerFormData, McpStore } from '../mcpStore';

interface McpHandlerDependencies {
  getStore: () => McpStore;
  refreshBridge: () => Promise<{ tools: number; error?: string }>;
}

const refreshBridgeInBackground = (
  refreshBridge: McpHandlerDependencies['refreshBridge'],
): void => {
  void refreshBridge().catch(error => {
    console.error('[McpBridge] background refresh error:', error);
  });
};

export const registerMcpHandlers = ({ getStore, refreshBridge }: McpHandlerDependencies): void => {
  ipcMain.handle('mcp:list', () => {
    try {
      return { success: true, servers: getStore().listServers() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list MCP servers',
      };
    }
  });

  ipcMain.handle('mcp:create', async (_event, data: McpServerFormData) => {
    try {
      getStore().createServer(data);
      const servers = getStore().listServers();
      refreshBridgeInBackground(refreshBridge);
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create MCP server',
      };
    }
  });

  ipcMain.handle('mcp:update', async (_event, id: string, data: Partial<McpServerFormData>) => {
    try {
      getStore().updateServer(id, data);
      const servers = getStore().listServers();
      refreshBridgeInBackground(refreshBridge);
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      };
    }
  });

  ipcMain.handle('mcp:delete', async (_event, id: string) => {
    try {
      getStore().deleteServer(id);
      const servers = getStore().listServers();
      refreshBridgeInBackground(refreshBridge);
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server',
      };
    }
  });

  ipcMain.handle('mcp:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      getStore().setEnabled(options.id, options.enabled);
      const servers = getStore().listServers();
      refreshBridgeInBackground(refreshBridge);
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      };
    }
  });

  ipcMain.handle('mcp:refreshBridge', async () => {
    try {
      const result = await refreshBridge();
      return { success: true, tools: result.tools, error: result.error };
    } catch (error) {
      return {
        success: false,
        tools: 0,
        error: error instanceof Error ? error.message : 'Failed to refresh MCP bridge',
      };
    }
  });
};

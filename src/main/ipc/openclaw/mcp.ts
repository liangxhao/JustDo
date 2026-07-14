import { ipcMain } from 'electron';

import type {
  McpProbeResult,
  McpReadResourceResult,
  McpServerFormData,
  McpStore,
} from '../../libs/plugins/mcp';

interface McpHandlerDependencies {
  getStore: () => McpStore;
  syncConfig: () => Promise<{ tools: number; error?: string }>;
  probeServer: (id: string) => Promise<McpProbeResult>;
  readResource: (id: string, uri: string) => Promise<McpReadResourceResult>;
}

const syncMcpConfigInBackground = (syncConfig: McpHandlerDependencies['syncConfig']): void => {
  void syncConfig().catch(error => {
    console.error('[OpenClawMcp] background configuration sync error:', error);
  });
};

export const registerMcpHandlers = ({
  getStore,
  syncConfig,
  probeServer,
  readResource,
}: McpHandlerDependencies): void => {
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
      syncMcpConfigInBackground(syncConfig);
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
      syncMcpConfigInBackground(syncConfig);
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
      syncMcpConfigInBackground(syncConfig);
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
      syncMcpConfigInBackground(syncConfig);
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      };
    }
  });

  ipcMain.handle('mcp:syncConfig', async () => {
    try {
      const result = await syncConfig();
      return { success: true, tools: result.tools, error: result.error };
    } catch (error) {
      return {
        success: false,
        tools: 0,
        error: error instanceof Error ? error.message : 'Failed to sync MCP configuration',
      };
    }
  });

  ipcMain.handle('mcp:probe', async (_event, id: string) => {
    try {
      const result = await probeServer(id);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to probe MCP server',
      };
    }
  });

  ipcMain.handle('mcp:readResource', async (_event, options: { id: string; uri: string }) => {
    try {
      const result = await readResource(options.id, options.uri);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read MCP resource',
      };
    }
  });
};

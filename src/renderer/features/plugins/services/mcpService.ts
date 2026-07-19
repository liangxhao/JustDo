import {
  ExtensionProvidedMcpServer,
  McpProbeResult,
  McpReadResourceResult,
  McpServerConfig,
  McpServerFormData,
} from '@/features/plugins/types/mcp';

class McpService {
  private servers: McpServerConfig[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadServers();
    this.initialized = true;
  }

  async loadServers(): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.list();
      if (result.success && result.servers) {
        this.servers = result.servers;
      } else {
        this.servers = [];
      }
      return this.servers;
    } catch (error) {
      console.error('Failed to load MCP servers:', error);
      this.servers = [];
      return this.servers;
    }
  }

  async loadExtensionServers(): Promise<ExtensionProvidedMcpServer[]> {
    try {
      const result = await window.electron.mcp.listExtensionServers();
      return result.success ? (result.extensionServers ?? []) : [];
    } catch (error) {
      console.error('Failed to load extension-provided MCP servers:', error);
      return [];
    }
  }

  async createServer(
    data: McpServerFormData,
  ): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.create(data);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create MCP server';
      console.error('Failed to create MCP server:', error);
      return { success: false, error: message };
    }
  }

  async updateServer(
    id: string,
    data: Partial<McpServerFormData>,
  ): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.update(id, data);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update MCP server';
      console.error('Failed to update MCP server:', error);
      return { success: false, error: message };
    }
  }

  async deleteServer(
    id: string,
  ): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.delete(id);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
      console.error('Failed to delete MCP server:', error);
      return { success: false, error: message };
    }
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.setEnabled({ id, enabled });
      if (result.success && result.servers) {
        this.servers = result.servers;
        return this.servers;
      }
      throw new Error(result.error || 'Failed to update MCP server');
    } catch (error) {
      console.error('Failed to update MCP server:', error);
      throw error;
    }
  }

  getServers(): McpServerConfig[] {
    return this.servers;
  }

  getEnabledServers(): McpServerConfig[] {
    return this.servers.filter(s => s.enabled);
  }

  getServerById(id: string): McpServerConfig | undefined {
    return this.servers.find(s => s.id === id);
  }

  /** Sync MCP server configuration to OpenClaw. */
  async syncConfig(): Promise<{ success: boolean; tools: number; error?: string }> {
    try {
      return await window.electron.mcp.syncConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync MCP configuration';
      console.error('Failed to sync MCP configuration:', error);
      return { success: false, tools: 0, error: message };
    }
  }

  async probeServer(
    id: string,
  ): Promise<{ success: boolean; result?: McpProbeResult; error?: string }> {
    try {
      return await window.electron.mcp.probe(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to probe MCP server';
      console.error('Failed to probe MCP server:', error);
      return { success: false, error: message };
    }
  }

  async readResource(
    id: string,
    uri: string,
  ): Promise<{ success: boolean; result?: McpReadResourceResult; error?: string }> {
    try {
      return await window.electron.mcp.readResource({ id, uri });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read MCP resource';
      console.error('Failed to read MCP resource:', error);
      return { success: false, error: message };
    }
  }

  onConfigSyncStart(callback: () => void): () => void {
    return window.electron.mcp.onConfigSyncStart(callback);
  }

  onConfigSyncDone(callback: (data: { tools: number; error?: string }) => void): () => void {
    return window.electron.mcp.onConfigSyncDone(callback);
  }
}

export const mcpService = new McpService();

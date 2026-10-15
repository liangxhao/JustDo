import {
  ExtensionProvidedMcpServer,
  McpProbeResult,
  McpReadResourceResult,
  McpServerConfig,
  McpServerFormData,
} from '@/features/plugins/mcp/mcp';

class McpService {
  private servers: McpServerConfig[] = [];
  private initialized = false;
  private serverGeneration = 0;
  private serverLoad: Promise<McpServerConfig[]> | null = null;
  private serverLoadFailed = false;
  private extensionServers: ExtensionProvidedMcpServer[] | null = null;
  private extensionLoad: Promise<ExtensionProvidedMcpServer[]> | null = null;
  private extensionGeneration = 0;
  private watchingExtensions = false;

  getExtensionServers(): ExtensionProvidedMcpServer[] | null {
    return this.extensionServers;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadServers();
    this.initialized = true;
  }

  async loadServers(): Promise<McpServerConfig[]> {
    const generation = ++this.serverGeneration;
    const pending = this.fetchServers(generation).finally(() => {
      if (this.serverLoad === pending) this.serverLoad = null;
    });
    this.serverLoad = pending;
    const servers = await pending;
    return generation === this.serverGeneration ? servers : (this.serverLoad ?? this.servers);
  }

  private async fetchServers(generation: number): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.list();
      if (generation !== this.serverGeneration) return this.serverLoad ?? this.servers;
      if (result.success && result.servers) {
        this.servers = result.servers;
        this.serverLoadFailed = false;
      } else {
        this.serverLoadFailed = true;
      }
      return this.servers;
    } catch (error) {
      if (generation !== this.serverGeneration) return this.serverLoad ?? this.servers;
      console.error('Failed to load MCP servers:', error);
      this.serverLoadFailed = true;
      return this.servers;
    }
  }

  private async applyMutationServers(
    servers: McpServerConfig[],
    generation: number,
  ): Promise<McpServerConfig[]> {
    if (generation !== this.serverGeneration) return this.loadServers();
    this.serverGeneration += 1;
    this.serverLoad = null;
    this.servers = servers;
    this.serverLoadFailed = false;
    return servers;
  }

  hasServerLoadFailed(): boolean {
    return this.serverLoadFailed;
  }

  async loadExtensionServers(): Promise<ExtensionProvidedMcpServer[]> {
    if (!this.watchingExtensions) {
      this.watchingExtensions = true;
      window.electron.extensions.onChanged(() => {
        this.extensionGeneration += 1;
        this.extensionServers = null;
        this.extensionLoad = null;
      });
    }
    const generation = this.extensionGeneration;
    if (this.extensionLoad) {
      return this.consumeExtensionServers(this.extensionLoad, generation);
    }
    const pending = this.fetchExtensionServers()
      .then(servers => {
        if (generation !== this.extensionGeneration) return this.loadExtensionServers();
        this.extensionServers = servers;
        return servers;
      })
      .catch(error => {
        if (generation !== this.extensionGeneration) return this.loadExtensionServers();
        throw error;
      })
      .finally(() => {
        if (this.extensionLoad === pending) this.extensionLoad = null;
      });
    this.extensionLoad = pending;
    return this.consumeExtensionServers(pending, generation);
  }

  private async consumeExtensionServers(
    pending: Promise<ExtensionProvidedMcpServer[]>,
    generation: number,
  ): Promise<ExtensionProvidedMcpServer[]> {
    try {
      const servers = await pending;
      if (generation === this.extensionGeneration) return servers;
    } catch (error) {
      if (generation === this.extensionGeneration) throw error;
    }
    return this.extensionLoad ?? this.extensionServers ?? this.loadExtensionServers();
  }

  private async fetchExtensionServers(): Promise<ExtensionProvidedMcpServer[]> {
    try {
      const result = await window.electron.mcp.listExtensionServers();
      if (!result.success) throw new Error('Failed to load extension-provided MCP servers');
      return result.extensionServers ?? [];
    } catch (error) {
      console.error('Failed to load extension-provided MCP servers:', error);
      throw error;
    }
  }

  async setExtensionServerEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ExtensionProvidedMcpServer[]> {
    const generation = ++this.extensionGeneration;
    this.extensionLoad = null;
    const result = await window.electron.mcp.setExtensionEnabled({ id, enabled });
    if (!result.success) {
      if (generation === this.extensionGeneration) this.extensionServers = null;
      throw new Error(`mcpExtensionMutation.${result.code}`);
    }
    if (generation !== this.extensionGeneration) return this.loadExtensionServers();
    this.extensionServers = result.extensionServers;
    return result.extensionServers;
  }

  async readExtensionSettings(id: string) {
    return window.electron.mcp.readExtensionSettings(id);
  }

  async createServer(
    data: McpServerFormData,
  ): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    const generation = this.serverGeneration;
    try {
      const result = await window.electron.mcp.create(data);
      if (result.success && result.servers) {
        return { ...result, servers: await this.applyMutationServers(result.servers, generation) };
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
    const generation = this.serverGeneration;
    try {
      const result = await window.electron.mcp.update(id, data);
      if (result.success && result.servers) {
        return { ...result, servers: await this.applyMutationServers(result.servers, generation) };
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
    const generation = this.serverGeneration;
    try {
      const result = await window.electron.mcp.delete(id);
      if (result.success && result.servers) {
        return { ...result, servers: await this.applyMutationServers(result.servers, generation) };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
      console.error('Failed to delete MCP server:', error);
      return { success: false, error: message };
    }
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    const generation = this.serverGeneration;
    try {
      const result = await window.electron.mcp.setEnabled({ id, enabled });
      if (result.success && result.servers) {
        return this.applyMutationServers(result.servers, generation);
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

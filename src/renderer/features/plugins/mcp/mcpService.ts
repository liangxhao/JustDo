import { PluginKind } from '@shared/plugins/marketplace';
import { mcpToolHasApp } from '@shared/plugins/mcpAppCapabilities';
import {
  PluginOperationAction,
  type PluginOperationFeedback,
  PluginOperationStage,
} from '@shared/plugins/pluginOperation';

import {
  ExtensionProvidedMcpServer,
  McpProbeResult,
  McpReadResourceResult,
  McpServerConfig,
  McpServerFormData,
} from '@/features/plugins/mcp/mcp';
import {
  pluginOperationErrorMessage,
  pluginOperationFailure,
  pluginOperationRefreshFailure,
} from '@/features/plugins/shared/pluginMutationFeedback';
import { startPluginOperation } from '@/features/plugins/shared/pluginOperationService';
import { i18nService } from '@/services/i18n';

type McpMutationResult = PluginOperationFeedback & {
  success: boolean;
  servers?: McpServerConfig[];
  error?: string;
};

type McpInventoryServer = McpServerConfig | ExtensionProvidedMcpServer;

// Memory-only discovery hint. Never persists credentials, catalogs or tool grants.
const appSupportFingerprint = (server: McpInventoryServer): string =>
  JSON.stringify(
    'providerId' in server
      ? [
          server.name,
          server.providerId,
          server.enabled,
          server.supported,
          server.connectionSummary,
          server.connectionTimeoutMs,
          server.requestTimeoutMs,
        ]
      : [
          server.name,
          server.enabled,
          server.transportType,
          server.command,
          server.args,
          server.env,
          server.url,
          server.headers,
          server.requestTimeoutSeconds,
          server.updatedAt,
        ],
  );

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
  private appSupportGeneration = 0;
  private probeSequence = 0;
  private appSupport = new Map<string, { fingerprint: string; supported: boolean }>();
  private probeGenerations = new Map<string, number>();

  getAppSupport(server: McpInventoryServer): boolean | undefined {
    const known = this.appSupport.get(server.id);
    return known?.fingerprint === appSupportFingerprint(server) ? known.supported : undefined;
  }

  private invalidateAppSupport(): void {
    this.appSupportGeneration += 1;
    this.appSupport.clear();
    this.probeGenerations.clear();
  }

  private pruneAppSupport(servers: McpInventoryServer[], extension: boolean): void {
    const current = new Map(servers.map(server => [server.id, appSupportFingerprint(server)]));
    for (const [id, known] of this.appSupport) {
      if (id.startsWith('extension:') === extension && current.get(id) !== known.fingerprint) {
        this.appSupport.delete(id);
        this.probeGenerations.delete(id);
      }
    }
    for (const id of this.probeGenerations.keys()) {
      if (id.startsWith('extension:') === extension && !current.has(id)) {
        this.probeGenerations.delete(id);
      }
    }
  }

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
        this.pruneAppSupport(result.servers, false);
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

  private async reconcileFailedMutation(operation: ReturnType<typeof startPluginOperation>) {
    operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
    await this.loadServers();
    if (this.serverLoadFailed) operation.fail(pluginOperationRefreshFailure());
  }

  async loadExtensionServers(): Promise<ExtensionProvidedMcpServer[]> {
    if (!this.watchingExtensions) {
      this.watchingExtensions = true;
      window.electron.extensions.onChanged(() => {
        this.invalidateAppSupport();
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
        this.pruneAppSupport(servers, true);
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
    this.invalidateAppSupport();
    const generation = ++this.extensionGeneration;
    this.extensionLoad = null;
    const operation = startPluginOperation({
      kind: PluginKind.MCP,
      action: enabled ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
      label: this.extensionServers?.find(server => server.id === id)?.name || id,
    });
    try {
      const result = await window.electron.mcp.setExtensionEnabled(
        { id, enabled },
        operation.context,
      );
      if (!result.success) {
        if (generation === this.extensionGeneration) this.extensionServers = null;
        operation.fail({
          ...pluginOperationFailure(result, i18nService.t(`mcpExtensionMutation.${result.code}`)),
          message: i18nService.t(`mcpExtensionMutation.${result.code}`),
          ...(result.code === 'unknown' ? { operationUnconfirmed: true as const } : {}),
        });
        throw new Error(`mcpExtensionMutation.${result.code}`);
      }
      if (generation !== this.extensionGeneration) {
        try {
          return await this.loadExtensionServers();
        } catch (error) {
          operation.fail(pluginOperationRefreshFailure());
          throw error;
        }
      }
      this.extensionServers = result.extensionServers;
      return result.extensionServers;
    } catch (error) {
      operation.fail({
        message:
          error instanceof Error
            ? pluginOperationErrorMessage(error.message)
            : i18nService.t('mcpExtensionMutation.unknown'),
      });
      operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
      try {
        await this.loadExtensionServers();
      } catch {
        operation.fail(pluginOperationRefreshFailure());
      }
      throw error;
    } finally {
      this.invalidateAppSupport();
      operation.finish();
    }
  }

  async readExtensionSettings(id: string) {
    return window.electron.mcp.readExtensionSettings(id);
  }

  async createServer(data: McpServerFormData): Promise<McpMutationResult> {
    this.invalidateAppSupport();
    const generation = this.serverGeneration;
    const operation = startPluginOperation({
      kind: PluginKind.MCP,
      action: PluginOperationAction.INSTALL,
      label: data.name,
    });
    try {
      const result = await window.electron.mcp.create(data, operation.context);
      if (result.success && result.servers) {
        const servers = await this.applyMutationServers(result.servers, generation);
        if (result.refreshWarning || this.serverLoadFailed)
          operation.fail(pluginOperationRefreshFailure(result));
        return { ...result, servers };
      }
      if (result.success && result.refreshWarning) {
        operation.fail(pluginOperationRefreshFailure(result));
        return result;
      }
      operation.fail(pluginOperationFailure(result, i18nService.t('mcpCreateFailed')));
      await this.reconcileFailedMutation(operation);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create MCP server';
      console.error('Failed to create MCP server:', error);
      operation.fail({ message });
      await this.reconcileFailedMutation(operation);
      return { success: false, error: message };
    } finally {
      this.invalidateAppSupport();
      operation.finish();
    }
  }

  async updateServer(id: string, data: Partial<McpServerFormData>): Promise<McpMutationResult> {
    this.invalidateAppSupport();
    const generation = this.serverGeneration;
    const operation = startPluginOperation({
      kind: PluginKind.MCP,
      action: PluginOperationAction.SAVE,
      label: data.name || this.servers.find(server => server.id === id)?.name || id,
    });
    try {
      const result = await window.electron.mcp.update(id, data, operation.context);
      if (result.success && result.servers) {
        const servers = await this.applyMutationServers(result.servers, generation);
        if (result.refreshWarning || this.serverLoadFailed)
          operation.fail(pluginOperationRefreshFailure(result));
        return { ...result, servers };
      }
      if (result.success && result.refreshWarning) {
        operation.fail(pluginOperationRefreshFailure(result));
        return result;
      }
      operation.fail(pluginOperationFailure(result, i18nService.t('mcpUpdateFailed')));
      await this.reconcileFailedMutation(operation);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update MCP server';
      console.error('Failed to update MCP server:', error);
      operation.fail({ message });
      await this.reconcileFailedMutation(operation);
      return { success: false, error: message };
    } finally {
      this.invalidateAppSupport();
      operation.finish();
    }
  }

  async deleteServer(id: string): Promise<McpMutationResult> {
    this.invalidateAppSupport();
    const generation = this.serverGeneration;
    const operation = startPluginOperation({
      kind: PluginKind.MCP,
      action: PluginOperationAction.REMOVE,
      label: this.servers.find(server => server.id === id)?.name || id,
    });
    try {
      const result = await window.electron.mcp.delete(id, operation.context);
      if (result.success && result.servers) {
        const servers = await this.applyMutationServers(result.servers, generation);
        if (result.refreshWarning || this.serverLoadFailed)
          operation.fail(pluginOperationRefreshFailure(result));
        return { ...result, servers };
      }
      if (result.success && result.refreshWarning) {
        operation.fail(pluginOperationRefreshFailure(result));
        return result;
      }
      operation.fail(pluginOperationFailure(result, i18nService.t('mcpDeleteFailed')));
      await this.reconcileFailedMutation(operation);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
      console.error('Failed to delete MCP server:', error);
      operation.fail({ message });
      await this.reconcileFailedMutation(operation);
      return { success: false, error: message };
    } finally {
      this.invalidateAppSupport();
      operation.finish();
    }
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    this.invalidateAppSupport();
    const generation = this.serverGeneration;
    const operation = startPluginOperation({
      kind: PluginKind.MCP,
      action: enabled ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
      label: this.servers.find(server => server.id === id)?.name || id,
    });
    try {
      const result = await window.electron.mcp.setEnabled({ id, enabled }, operation.context);
      if (result.success && result.servers) {
        const servers = await this.applyMutationServers(result.servers, generation);
        if (result.refreshWarning || this.serverLoadFailed)
          operation.fail(pluginOperationRefreshFailure(result));
        return servers;
      }
      if (result.success && result.refreshWarning) {
        operation.fail(pluginOperationRefreshFailure(result));
        return this.servers;
      }
      operation.fail(pluginOperationFailure(result, i18nService.t('mcpUpdateFailed')));
      throw new Error(result.error || 'Failed to update MCP server');
    } catch (error) {
      console.error('Failed to update MCP server:', error);
      operation.fail({
        message: error instanceof Error ? error.message : i18nService.t('mcpUpdateFailed'),
      });
      await this.reconcileFailedMutation(operation);
      throw error;
    } finally {
      this.invalidateAppSupport();
      operation.finish();
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
    this.invalidateAppSupport();
    const operation = startPluginOperation({
      kind: PluginKind.MCP,
      action: PluginOperationAction.SYNC,
      label: 'MCP',
    });
    try {
      const result = await window.electron.mcp.syncConfig(operation.context);
      if (!result.success)
        operation.fail(pluginOperationFailure(result, i18nService.t('mcpBridgeSyncError')));
      else if (result.refreshWarning) operation.fail(pluginOperationRefreshFailure(result));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync MCP configuration';
      console.error('Failed to sync MCP configuration:', error);
      operation.fail({ message });
      return { success: false, tools: 0, error: message };
    } finally {
      this.invalidateAppSupport();
      operation.finish();
    }
  }

  async probeServer(
    id: string,
  ): Promise<{ success: boolean; result?: McpProbeResult; error?: string }> {
    const server = [...this.servers, ...(this.extensionServers ?? [])].find(item => item.id === id);
    const fingerprint = server && appSupportFingerprint(server);
    const generation = this.appSupportGeneration;
    const probeGeneration = ++this.probeSequence;
    this.probeGenerations.set(id, probeGeneration);
    try {
      const result = await window.electron.mcp.probe(id);
      const current = [...this.servers, ...(this.extensionServers ?? [])].find(
        item => item.id === id,
      );
      if (
        result.success &&
        result.result?.available &&
        fingerprint &&
        current &&
        generation === this.appSupportGeneration &&
        probeGeneration === this.probeGenerations.get(id) &&
        fingerprint === appSupportFingerprint(current)
      ) {
        this.appSupport.set(id, {
          fingerprint,
          supported: result.result.tools.some(mcpToolHasApp),
        });
      }
      return result;
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

  onConfigSyncStart(callback: (data?: { requestId?: string }) => void): () => void {
    return window.electron.mcp.onConfigSyncStart(data => {
      this.invalidateAppSupport();
      callback(data);
    });
  }

  onConfigSyncDone(
    callback: (data: { tools: number; error?: string; requestId?: string }) => void,
  ): () => void {
    return window.electron.mcp.onConfigSyncDone(data => {
      this.invalidateAppSupport();
      callback(data);
    });
  }
}

export const mcpService = new McpService();

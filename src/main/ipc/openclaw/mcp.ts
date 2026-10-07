import { ipcMain } from 'electron';

import {
  type ExtensionProvidedMcpServer,
  isValidMcpRequestTimeoutSeconds,
} from '../../../shared/openclaw/mcp';
import {
  getExtensionProvidedManagement,
  getUserMcpManagement,
} from '../../../shared/plugins/management';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';
import type {
  McpProbeResult,
  McpReadResourceResult,
  McpServerFormData,
  McpStore,
} from '../../plugins/mcp';

interface McpHandlerDependencies {
  getStore: () => McpStore;
  syncConfig: () => Promise<{ tools: number; error?: string }>;
  probeServer: (id: string) => Promise<McpProbeResult>;
  readResource: (id: string, uri: string) => Promise<McpReadResourceResult>;
  installationService: PluginInstallationService;
  listExtensionServers: () => Promise<ExtensionProvidedMcpServer[]>;
  discoverExternalServers: () => void;
  onMarketplacePluginDeleted?: (kind: typeof PluginKind.MCP, runtimeId: string) => void;
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
  installationService,
  listExtensionServers,
  discoverExternalServers,
  onMarketplacePluginDeleted,
}: McpHandlerDependencies): void => {
  const listServers = () =>
    getStore()
      .listServers()
      .map(server => ({ ...server, ...getUserMcpManagement() }));
  installationService.registerInstaller({
    kind: PluginKind.MCP,
    install: async request => {
      if (request.payload.kind !== PluginKind.MCP) {
        return { success: false, error: 'Invalid MCP installation payload' };
      }
      const requestTimeoutSeconds = request.payload.config.requestTimeoutSeconds;
      if (
        requestTimeoutSeconds !== undefined &&
        requestTimeoutSeconds !== null &&
        !isValidMcpRequestTimeoutSeconds(requestTimeoutSeconds)
      ) {
        return {
          success: false,
          error: 'MCP request timeout must be an integer between 1 and 86400 seconds.',
        };
      }
      const store = getStore();
      if (request.operation === MarketplaceInstallOperation.UPDATE) {
        const targetId =
          request.origin === PluginInstallOrigin.CUSTOM
            ? request.payload.targetId
            : store
                .listServers()
                .find(server => server.registryId === request.marketplacePluginId)?.id;
        if (!targetId) return { success: false, error: 'Installed MCP server was not found' };
        const updated = store.updateServer(targetId, {
          ...request.payload.config,
          registryId:
            request.origin === PluginInstallOrigin.MARKETPLACE
              ? request.marketplacePluginId
              : request.payload.config.registryId,
        });
        if (!updated) return { success: false, error: 'Installed MCP server was not found' };
        syncMcpConfigInBackground(syncConfig);
        return { success: true, pluginId: updated.id };
      }

      const config = request.payload.config;
      if (typeof config.name !== 'string' || !config.name.trim()) {
        return { success: false, error: 'MCP server name is required' };
      }
      if (!config.transportType) {
        return { success: false, error: 'MCP transport type is required' };
      }
      if (
        request.origin === PluginInstallOrigin.MARKETPLACE &&
        store.listServers().some(server => server.registryId === request.marketplacePluginId)
      ) {
        return { success: false, error: 'MCP server is already installed' };
      }
      const created = store.createServer({
        ...config,
        name: config.name,
        transportType: config.transportType,
        registryId:
          request.origin === PluginInstallOrigin.MARKETPLACE
            ? request.marketplacePluginId
            : config.registryId,
      });
      syncMcpConfigInBackground(syncConfig);
      return { success: true, pluginId: created.id };
    },
  });

  ipcMain.handle('mcp:list', () => {
    try {
      try {
        discoverExternalServers();
      } catch (error) {
        console.warn(
          '[OpenClawMcp] Failed to discover externally installed MCP servers:',
          error instanceof Error ? error.message : String(error),
        );
      }
      return { success: true, servers: listServers() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list MCP servers',
      };
    }
  });

  ipcMain.handle('mcp:listExtensionServers', async () => {
    try {
      const extensionServers = await listExtensionServers();
      return {
        success: true,
        extensionServers: extensionServers.map(server => ({
          ...server,
          ...getExtensionProvidedManagement({
            id: server.providerId,
            name: server.providerName,
            scope: server.scope,
          }),
        })),
      };
    } catch (error) {
      console.warn(
        '[OpenClawMcp] Failed to discover extension-provided MCP servers:',
        error instanceof Error ? error.message : String(error),
      );
      return { success: false, extensionServers: [] };
    }
  });

  ipcMain.handle('mcp:create', async (_event, data: McpServerFormData) => {
    try {
      const installResult = await installationService.install({
        operation: MarketplaceInstallOperation.INSTALL,
        origin: PluginInstallOrigin.CUSTOM,
        payload: { kind: PluginKind.MCP, config: data },
      });
      if (!installResult.success) return installResult;
      const servers = listServers();
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
      const installResult = await installationService.install({
        operation: MarketplaceInstallOperation.UPDATE,
        origin: PluginInstallOrigin.CUSTOM,
        payload: { kind: PluginKind.MCP, config: data, targetId: id },
      });
      if (!installResult.success) return installResult;
      const servers = listServers();
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
      if (typeof id !== 'string' || !id.trim()) {
        return { success: false, error: 'MCP server id is required' };
      }
      if (!getStore().deleteServer(id.trim())) {
        return { success: false, error: 'MCP server was not found' };
      }
      onMarketplacePluginDeleted?.(PluginKind.MCP, id.trim());
      const servers = listServers();
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
      if (
        typeof options?.id !== 'string' ||
        !options.id.trim() ||
        typeof options.enabled !== 'boolean'
      ) {
        return { success: false, error: 'MCP server id and enabled state are required' };
      }
      if (!getStore().setEnabled(options.id.trim(), options.enabled)) {
        return { success: false, error: 'MCP server was not found' };
      }
      const servers = listServers();
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

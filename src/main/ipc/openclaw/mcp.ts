import { ipcMain } from 'electron';

import {
  getExtensionProvidedManagement,
  getUserMcpManagement,
} from '../../../shared/plugins/management';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import {
  type ExtensionProvidedMcpServer,
  isValidMcpRequestTimeoutSeconds,
} from '../../../shared/plugins/mcp';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';
import type {
  McpProbeResult,
  McpReadResourceResult,
  McpServerFormData,
  McpStore,
} from '../../plugins/mcp';

type SyncMcpConfig = () => Promise<{ tools: number; error?: string }>;

interface McpHandlerDependencies {
  getStore: () => McpStore;
  runConfigMutationExclusive: <T>(
    operation: (syncConfig: SyncMcpConfig) => Promise<T>,
  ) => Promise<T>;
  probeServer: (id: string) => Promise<McpProbeResult>;
  readResource: (id: string, uri: string) => Promise<McpReadResourceResult>;
  installationService: PluginInstallationService;
  listExtensionServers: () => Promise<ExtensionProvidedMcpServer[]>;
  discoverExternalServers: () => void;
  onMarketplacePluginDeleted?: (kind: typeof PluginKind.MCP, runtimeId: string) => void;
}

export const registerMcpHandlers = ({
  getStore,
  runConfigMutationExclusive,
  probeServer,
  readResource,
  installationService,
  listExtensionServers,
  discoverExternalServers,
  onMarketplacePluginDeleted,
}: McpHandlerDependencies): void => {
  let mutationTail: Promise<void> = Promise.resolve();
  const runMcpOperationExclusive = <T>(
    operation: (syncConfig: SyncMcpConfig) => Promise<T>,
  ): Promise<T> => {
    const result = mutationTail.then(() => runConfigMutationExclusive(operation));
    mutationTail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  };
  const syncMcpMutation = async (
    syncConfig: SyncMcpConfig,
    rollback: () => void,
  ): Promise<void> => {
    try {
      const result = await syncConfig();
      if (result.error) throw new Error(result.error);
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        rollback();
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      try {
        const result = await syncConfig();
        if (result.error) throw new Error(result.error);
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      if (rollbackErrors.length > 0) {
        console.error('[OpenClawMcp] MCP mutation rollback incomplete:', rollbackErrors);
      }
      throw new Error(
        [
          error instanceof Error ? error.message : 'Failed to synchronize MCP configuration',
          ...(rollbackErrors.length > 0
            ? [`Rollback incomplete: ${rollbackErrors.join('; ')}`]
            : []),
        ].join(' '),
      );
    }
  };
  const listServers = () =>
    getStore()
      .listServers()
      .map(server => ({ ...server, ...getUserMcpManagement() }));
  installationService.registerInstaller({
    kind: PluginKind.MCP,
    install: request =>
      runMcpOperationExclusive(async syncConfig => {
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
          const previousState = store.getServer(targetId);
          if (!previousState)
            return { success: false, error: 'Installed MCP server was not found' };
          const updated = store.updateServer(targetId, {
            ...request.payload.config,
            registryId:
              request.origin === PluginInstallOrigin.MARKETPLACE
                ? request.marketplacePluginId
                : request.payload.config.registryId,
          });
          if (!updated) return { success: false, error: 'Installed MCP server was not found' };
          await syncMcpMutation(syncConfig, () => store.restoreServer(previousState));
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
        await syncMcpMutation(syncConfig, () => {
          store.deleteServer(created.id);
        });
        return { success: true, pluginId: created.id };
      }),
  });

  ipcMain.handle('mcp:list', () =>
    runMcpOperationExclusive(async () => {
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
    }),
  );

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

  ipcMain.handle('mcp:delete', (_event, id: string) =>
    runMcpOperationExclusive(async syncConfig => {
      try {
        if (typeof id !== 'string' || !id.trim()) {
          return { success: false, error: 'MCP server id is required' };
        }
        const store = getStore();
        const previousState = store.getServer(id.trim());
        if (!previousState || !store.deleteServer(id.trim())) {
          return { success: false, error: 'MCP server was not found' };
        }
        await syncMcpMutation(syncConfig, () => store.restoreServer(previousState));
        onMarketplacePluginDeleted?.(PluginKind.MCP, id.trim());
        const servers = listServers();
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete MCP server',
        };
      }
    }),
  );

  ipcMain.handle('mcp:setEnabled', (_event, options: { id: string; enabled: boolean }) =>
    runMcpOperationExclusive(async syncConfig => {
      try {
        if (
          typeof options?.id !== 'string' ||
          !options.id.trim() ||
          typeof options.enabled !== 'boolean'
        ) {
          return { success: false, error: 'MCP server id and enabled state are required' };
        }
        const store = getStore();
        const previousState = store.getServer(options.id.trim());
        if (!previousState || !store.setEnabled(options.id.trim(), options.enabled)) {
          return { success: false, error: 'MCP server was not found' };
        }
        await syncMcpMutation(syncConfig, () => store.restoreServer(previousState));
        const servers = listServers();
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP server',
        };
      }
    }),
  );

  ipcMain.handle('mcp:syncConfig', () =>
    runMcpOperationExclusive(async syncConfig => {
      try {
        const result = await syncConfig();
        return { success: !result.error, tools: result.tools, error: result.error };
      } catch (error) {
        return {
          success: false,
          tools: 0,
          error: error instanceof Error ? error.message : 'Failed to sync MCP configuration',
        };
      }
    }),
  );

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

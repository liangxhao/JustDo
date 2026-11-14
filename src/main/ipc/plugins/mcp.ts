import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { getUserMcpManagement } from '../../../shared/plugins/management';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import {
  ExtensionMcpIpc,
  type ExtensionProvidedMcpServer,
  isValidMcpRequestTimeoutSeconds,
  MCP_NAME_CONFLICT_ERROR,
  type McpServerFormData,
} from '../../../shared/plugins/mcp';
import type { McpImportCommitReceipt, McpTransferResult } from '../../../shared/plugins/mcpTransfer';
import {
  PluginOperationAction,
  type PluginOperationContext,
  PluginOperationStage,
  toPluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import { listManagedOpenClawPluginIds } from '../../openclaw/config/openclawConfigBuilders';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';
import type {
  McpProbeResult,
  McpReadResourceResult,
  McpStore,
} from '../../plugins/mcp';
import {
  ExtensionMcpSettingsService,
  withExtensionMcpManagement,
} from '../../plugins/mcp/extensionMcpSettingsService';
import { McpTransferService } from '../../plugins/mcp/mcpTransferService';
import { registerMcpTransferHandlers } from './mcpTransfer';
import { createPluginOperationReporter } from './pluginOperationProgress';

type SyncMcpConfig = (
  retiredMcpServerNames?: readonly string[],
  context?: PluginOperationContext,
  preservedMcpServerNames?: readonly string[],
) => Promise<{ tools: number; error?: string }>;

interface McpHandlerDependencies {
  getStore: () => McpStore;
  getMainWindow?: () => BrowserWindow | null;
  runConfigMutationExclusive: <T>(
    operation: (syncConfig: SyncMcpConfig) => Promise<T>,
  ) => Promise<T>;
  probeServer: (id: string) => Promise<McpProbeResult>;
  readResource: (id: string, uri: string) => Promise<McpReadResourceResult>;
  installationService: PluginInstallationService;
  listExtensionServers: () => Promise<ExtensionProvidedMcpServer[]>;
  readExtensionDefinition: (id: string) => Promise<Record<string, unknown> | null>;
  getNativeMcpServerNames?: (strict?: boolean) => ReadonlySet<string>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  getManagedPluginIds?: () => string[];
  discoverExternalServers: () => void | Promise<void>;
  onMarketplacePluginDeleted?: (kind: typeof PluginKind.MCP, runtimeId: string) => void;
}

class McpMutationApplyError extends Error {
  constructor(message: string, readonly rollbackIncomplete: boolean) {
    super(message);
  }
}

export const registerMcpHandlers = ({
  getStore,
  getMainWindow,
  runConfigMutationExclusive,
  probeServer,
  readResource,
  installationService,
  listExtensionServers,
  readExtensionDefinition,
  getNativeMcpServerNames = () => new Set(),
  requestGateway,
  getManagedPluginIds = listManagedOpenClawPluginIds,
  discoverExternalServers,
  onMarketplacePluginDeleted,
}: McpHandlerDependencies): void => {
  let mutationTail: Promise<void> = Promise.resolve();
  const runMcpOperationExclusive = <T>(
    operation: (syncConfig: SyncMcpConfig) => Promise<T>,
  ): Promise<T> => {
    const result = mutationTail.then(() =>
      runConfigMutationExclusive(syncConfig => {
        const projectionNames = new Set(
          getStore()
            .listServers()
            .map(server => server.name),
        );
        return operation((_retiredNames, context, preservedNames) => {
          const currentNames = new Set(
            getStore()
              .listServers()
              .map(server => server.name),
          );
          // A rollback must also retire names projected by the failed attempt.
          for (const name of currentNames) projectionNames.add(name);
          const retiredNames = [...projectionNames].filter(name => !currentNames.has(name));
          if (preservedNames?.length) return syncConfig(retiredNames, context, preservedNames);
          return context ? syncConfig(retiredNames, context) : syncConfig(retiredNames);
        });
      }),
    );
    mutationTail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  };
  const syncMcpMutation = async (
    syncConfig: SyncMcpConfig,
    rollback: () => void,
    report?: (stage: PluginOperationStage) => void,
    context?: PluginOperationContext,
  ): Promise<void> => {
    const synchronize = () => (context ? syncConfig(undefined, context) : syncConfig());
    try {
      const result = await synchronize();
      if (result.error) throw new Error(result.error);
    } catch (error) {
      report?.(PluginOperationStage.ROLLING_BACK);
      const rollbackErrors: string[] = [];
      try {
        rollback();
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      try {
        const result = await synchronize();
        if (result.error) throw new Error(result.error);
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      if (rollbackErrors.length > 0) {
        console.error('[OpenClawMcp] MCP mutation rollback incomplete');
      }
      throw new McpMutationApplyError(
        [
          error instanceof Error ? error.message : 'Failed to synchronize MCP configuration',
          ...(rollbackErrors.length > 0
            ? [`Rollback incomplete: ${rollbackErrors.join('; ')}`]
            : []),
        ].join(' '),
        rollbackErrors.length > 0,
      );
    }
  };
  const runMcpMutationWithProgress = <T extends { success: boolean }>(
    event: IpcMainInvokeEvent,
    context: PluginOperationContext | undefined,
    action: PluginOperationAction,
    operation: (
      syncConfig: SyncMcpConfig,
      report: (stage: PluginOperationStage) => void,
    ) => Promise<T>,
  ): Promise<T> => {
    const progress = createPluginOperationReporter(event, context, PluginKind.MCP, action);
    let rollingBack = false;
    const report = (stage: PluginOperationStage) => {
      if (stage === PluginOperationStage.ROLLING_BACK) rollingBack = true;
      progress.report(stage);
    };
    progress.report(PluginOperationStage.QUEUED);
    return runMcpOperationExclusive(syncConfig => {
      progress.report(PluginOperationStage.VALIDATING);
      return operation(async (retiredNames, _context, preservedNames) => {
        if (!rollingBack) progress.report(PluginOperationStage.APPLYING_CONFIGURATION);
        if (preservedNames?.length) return syncConfig(retiredNames, context, preservedNames);
        return context ? syncConfig(retiredNames, context) : syncConfig(retiredNames);
      }, report);
    })
      .then(progress.result)
      .finally(progress.finish);
  };
  const listServers = () =>
    getStore()
      .listServers()
      .map(server => ({ ...server, ...getUserMcpManagement() }));
  const refreshServersAfterMutation = () => {
    try {
      return { servers: listServers() };
    } catch {
      console.warn('[OpenClawMcp] Mutation completed, but its inventory could not be refreshed');
      return { refreshWarning: true as const };
    }
  };
  const listManagedExtensionServers = async () => {
    const protectedIds = new Set(getManagedPluginIds());
    const userNames = new Set(
      getStore()
        .listServers()
        .map(server => server.name),
    );
    return (await listExtensionServers()).map(server =>
      withExtensionMcpManagement(server, userNames, protectedIds),
    );
  };
  const extensionSettings = new ExtensionMcpSettingsService({
    request: requestGateway,
    listServers: listManagedExtensionServers,
    readDefinition: readExtensionDefinition,
  });
  const conflictsWithNativeName = async (name: string) => {
    if (
      getStore()
        .listServers()
        .some(server => server.name === name)
    )
      return false;
    if (getNativeMcpServerNames().has(name)) return true;
    return (await listExtensionServers()).some(server => server.name === name);
  };

  if (getMainWindow) {
    const service = new McpTransferService();
    const readNames = async () => {
      const extensionServers = await listExtensionServers();
      const storeNames = new Set(getStore().listServers().map(server => server.name));
      const nativeNames = getNativeMcpServerNames(true);
      return {
        occupied: new Set([...storeNames, ...nativeNames, ...extensionServers.map(server => server.name)]),
        preserved: [...nativeNames].filter(name => !storeNames.has(name)),
      };
    };
    registerMcpTransferHandlers({
      getMainWindow,
      service,
      readNames: () => runMcpOperationExclusive(async () => (await readNames()).occupied),
      readServers: () => runMcpOperationExclusive(async () => getStore().listServers()),
      commit: (event, owner, input, context) => runMcpMutationWithProgress<McpTransferResult<McpImportCommitReceipt>>(
        event,
        context,
        PluginOperationAction.INSTALL,
        async (syncConfig, report) => {
          let preservedNames: readonly string[] = [];
          const plan = await service.planImport(owner, input, async () => {
            const names = await readNames();
            preservedNames = names.preserved;
            return names.occupied;
          });
          if (plan.success === false) return plan;
          const store = getStore();
          try {
            report(PluginOperationStage.SAVING_CONFIGURATION);
            const ids = store.createDisabledServers(plan.value.servers.map(server => server.config));
            await syncMcpMutation(
              (retired, syncContext) => syncConfig(retired, syncContext, preservedNames),
              () => store.deleteServers(ids),
              report,
            );
            report(PluginOperationStage.REFRESHING_INVENTORY);
            return {
              success: true,
              value: {
                imported: plan.value.servers.map((server, index) => ({
                  id: ids[index],
                  name: server.config.name,
                  missingCredentials: server.missingCredentials,
                })),
                skipped: plan.value.skipped,
                ...refreshServersAfterMutation(),
              },
            };
          } catch (error) {
            return {
              success: false,
              code: 'apply-failed',
              ...(error instanceof McpMutationApplyError && error.rollbackIncomplete
                ? { operationUnconfirmed: true }
                : {}),
            };
          }
        },
      ),
    });
  }

  installationService.registerInstaller({
    kind: PluginKind.MCP,
    install: request => {
      const progress = createPluginOperationReporter(
        undefined,
        undefined,
        PluginKind.MCP,
        request.operation === MarketplaceInstallOperation.UPDATE
          ? PluginOperationAction.SAVE
          : PluginOperationAction.INSTALL,
      );
      const report = (stage: PluginOperationStage) => {
        progress.report(stage);
        request.onProgress?.({ stage, percent: 0 });
      };
      report(PluginOperationStage.QUEUED);
      return runMcpOperationExclusive(async syncConfig => {
        report(PluginOperationStage.VALIDATING);
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
          const nextName = request.payload.config.name?.trim();
          if (
            nextName &&
            nextName !== previousState.name &&
            (await conflictsWithNativeName(nextName))
          ) {
            return { success: false, error: MCP_NAME_CONFLICT_ERROR };
          }
          report(PluginOperationStage.SAVING_CONFIGURATION);
          const updated = store.updateServer(targetId, {
            ...request.payload.config,
            registryId:
              request.origin === PluginInstallOrigin.MARKETPLACE
                ? request.marketplacePluginId
                : request.payload.config.registryId,
          });
          if (!updated) return { success: false, error: 'Installed MCP server was not found' };
          report(PluginOperationStage.APPLYING_CONFIGURATION);
          await syncMcpMutation(
            syncConfig,
            () => store.restoreServer(previousState),
            report,
            request.operationContext,
          );
          return { success: true, pluginId: updated.id };
        }

        const config = request.payload.config;
        if (typeof config.name !== 'string' || !config.name.trim()) {
          return { success: false, error: 'MCP server name is required' };
        }
        if (!config.transportType) {
          return { success: false, error: 'MCP transport type is required' };
        }
        if (await conflictsWithNativeName(config.name.trim())) {
          return { success: false, error: MCP_NAME_CONFLICT_ERROR };
        }
        if (
          request.origin === PluginInstallOrigin.MARKETPLACE &&
          store.listServers().some(server => server.registryId === request.marketplacePluginId)
        ) {
          return { success: false, error: 'MCP server is already installed' };
        }
        report(PluginOperationStage.SAVING_CONFIGURATION);
        const created = store.createServer({
          ...config,
          name: config.name,
          transportType: config.transportType,
          registryId:
            request.origin === PluginInstallOrigin.MARKETPLACE
              ? request.marketplacePluginId
              : config.registryId,
        });
        report(PluginOperationStage.APPLYING_CONFIGURATION);
        await syncMcpMutation(
          syncConfig,
          () => {
            store.deleteServer(created.id);
          },
          report,
          request.operationContext,
        );
        return { success: true, pluginId: created.id };
      })
        .then(progress.result)
        .catch(error =>
          progress.result({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save MCP configuration',
          }),
        )
        .finally(progress.finish);
    },
  });

  ipcMain.handle('mcp:list', () =>
    runMcpOperationExclusive(async () => {
      try {
        try {
          await discoverExternalServers();
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
      const extensionServers = await listManagedExtensionServers();
      return {
        success: true,
        extensionServers,
      };
    } catch (error) {
      console.warn(
        '[OpenClawMcp] Failed to discover extension-provided MCP servers:',
        error instanceof Error ? error.message : String(error),
      );
      return { success: false, extensionServers: [] };
    }
  });

  ipcMain.handle(
    ExtensionMcpIpc.SetEnabled,
    (event, input: unknown, context?: PluginOperationContext) =>
      runMcpMutationWithProgress(
        event,
        context,
        (input as { enabled?: unknown } | null)?.enabled === true
          ? PluginOperationAction.ENABLE
          : PluginOperationAction.DISABLE,
        (syncConfig, report) => {
          return extensionSettings.setEnabled(input, syncConfig, report);
        },
      ),
  );
  ipcMain.handle(ExtensionMcpIpc.ReadSettings, (_event, id: unknown) =>
    runMcpOperationExclusive(() => extensionSettings.readSettings(id)),
  );

  ipcMain.handle(
    'mcp:create',
    async (event, data: McpServerFormData, context?: PluginOperationContext) => {
      const progress = createPluginOperationReporter(
        event,
        context,
        PluginKind.MCP,
        PluginOperationAction.INSTALL,
      );
      try {
        const installResult = await installationService.install({
          operation: MarketplaceInstallOperation.INSTALL,
          origin: PluginInstallOrigin.CUSTOM,
          ...(context ? { operationContext: context } : {}),
          payload: { kind: PluginKind.MCP, config: data },
          onProgress: update => {
            const stage = toPluginOperationStage(update.stage);
            if (stage) progress.report(stage);
          },
        });
        if (!installResult.success) return progress.result(installResult);
        progress.report(PluginOperationStage.REFRESHING_INVENTORY);
        return { success: true, ...refreshServersAfterMutation() };
      } catch (error) {
        return progress.result({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create MCP server',
        });
      } finally {
        progress.finish();
      }
    },
  );

  ipcMain.handle(
    'mcp:update',
    async (
      event,
      id: string,
      data: Partial<McpServerFormData>,
      context?: PluginOperationContext,
    ) => {
      const progress = createPluginOperationReporter(
        event,
        context,
        PluginKind.MCP,
        PluginOperationAction.SAVE,
      );
      try {
        const installResult = await installationService.install({
          operation: MarketplaceInstallOperation.UPDATE,
          origin: PluginInstallOrigin.CUSTOM,
          ...(context ? { operationContext: context } : {}),
          payload: { kind: PluginKind.MCP, config: data, targetId: id },
          onProgress: update => {
            const stage = toPluginOperationStage(update.stage);
            if (stage) progress.report(stage);
          },
        });
        if (!installResult.success) return progress.result(installResult);
        progress.report(PluginOperationStage.REFRESHING_INVENTORY);
        return { success: true, ...refreshServersAfterMutation() };
      } catch (error) {
        return progress.result({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP server',
        });
      } finally {
        progress.finish();
      }
    },
  );

  ipcMain.handle('mcp:delete', (event, id: string, context?: PluginOperationContext) =>
    runMcpMutationWithProgress(
      event,
      context,
      PluginOperationAction.REMOVE,
      async (syncConfig, report) => {
        try {
          if (typeof id !== 'string' || !id.trim()) {
            return { success: false, error: 'MCP server id is required' };
          }
          const store = getStore();
          report(PluginOperationStage.UNINSTALLING);
          const previousState = store.getServer(id.trim());
          if (!previousState || !store.deleteServer(id.trim())) {
            return { success: false, error: 'MCP server was not found' };
          }
          await syncMcpMutation(syncConfig, () => store.restoreServer(previousState), report);
          onMarketplacePluginDeleted?.(PluginKind.MCP, id.trim());
          report(PluginOperationStage.REFRESHING_INVENTORY);
          return { success: true, ...refreshServersAfterMutation() };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete MCP server',
          };
        }
      },
    ),
  );

  ipcMain.handle(
    'mcp:setEnabled',
    (event, options: { id: string; enabled: boolean }, context?: PluginOperationContext) =>
      runMcpMutationWithProgress(
        event,
        context,
        options?.enabled === true ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
        async (syncConfig, report) => {
          try {
            if (
              typeof options?.id !== 'string' ||
              !options.id.trim() ||
              typeof options.enabled !== 'boolean'
            ) {
              return { success: false, error: 'MCP server id and enabled state are required' };
            }
            const store = getStore();
            report(PluginOperationStage.SAVING_CONFIGURATION);
            const previousState = store.getServer(options.id.trim());
            if (!previousState || !store.setEnabled(options.id.trim(), options.enabled)) {
              return { success: false, error: 'MCP server was not found' };
            }
            await syncMcpMutation(syncConfig, () => store.restoreServer(previousState), report);
            report(PluginOperationStage.REFRESHING_INVENTORY);
            return { success: true, ...refreshServersAfterMutation() };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to update MCP server',
            };
          }
        },
      ),
  );

  ipcMain.handle('mcp:syncConfig', (event, context?: PluginOperationContext) =>
    runMcpMutationWithProgress(event, context, PluginOperationAction.SYNC, async syncConfig => {
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

import { ipcMain } from 'electron';
import path from 'path';

import { HookIpc } from '../../../shared/openclaw/hooks';
import {
  getExtensionManagement,
  getHookManagement,
  type PluginHubScope,
} from '../../../shared/plugins/management';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { DEFAULT_MANAGED_AGENT_ID } from '../../openclaw/sessions/openclawSessionKeys';
import { OpenClawHookFiles, type OpenClawHookStore } from '../../plugins/hooks';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';

interface HookHandlerDependencies {
  getStore: () => OpenClawHookStore;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  syncConfig: () => Promise<{ hooks: number; error?: string }>;
  runConfigMutationExclusive?: <T>(
    operation: (syncConfig: HookHandlerDependencies['syncConfig']) => Promise<T>,
  ) => Promise<T>;
  installationService: PluginInstallationService;
}

type HookReport = {
  workspaceDir: string;
  managedHooksDir: string;
  hooks: Array<Record<string, unknown>>;
};

const findHookByAuthoritativeId = (
  hooks: HookReport['hooks'],
  id: string,
): Record<string, unknown> | undefined =>
  hooks.find(entry => entry.hookKey === id) ||
  hooks.find(
    entry => (typeof entry.hookKey !== 'string' || !entry.hookKey.trim()) && entry.name === id,
  );

const syncHookConfigForRollback = async (
  syncConfig: HookHandlerDependencies['syncConfig'],
): Promise<string[]> => {
  try {
    const result = await syncConfig();
    if (result.error) throw new Error(result.error);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[OpenClawHooks] rollback configuration sync error:', message);
    return [message];
  }
};

const restoreHookState = (
  hookStore: OpenClawHookStore,
  hookId: string,
  previousState: ReturnType<OpenClawHookStore['getHook']>,
): void => {
  if (previousState) hookStore.restoreHook(previousState);
  else hookStore.deleteHook(hookId);
};

const refreshHookReportAfterMutation = async (
  buildReport: () => Promise<HookReport>,
): Promise<Partial<HookReport>> => {
  try {
    return await buildReport();
  } catch (error) {
    console.warn(
      '[OpenClawHooks] Mutation succeeded but live status refresh failed:',
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
};

export const registerHookHandlers = ({
  getStore,
  requestGateway,
  syncConfig,
  runConfigMutationExclusive,
  installationService,
}: HookHandlerDependencies): void => {
  let hookMutationTail: Promise<void> = Promise.resolve();
  const runHookMutationExclusive = async <T>(
    operation: (syncConfig: HookHandlerDependencies['syncConfig']) => Promise<T>,
  ): Promise<T> => {
    const previous = hookMutationTail;
    let release!: () => void;
    hookMutationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await (runConfigMutationExclusive
        ? runConfigMutationExclusive(operation)
        : operation(syncConfig));
    } finally {
      release();
    }
  };
  const refreshHookRuntime = async (): Promise<void> => {
    const refreshed = await requestGateway<{ ok?: boolean; restartRequired?: boolean }>(
      'plugins.refresh',
      {},
    );
    if (refreshed.ok !== true || refreshed.restartRequired !== false) {
      throw new Error('Imported Hook runtime refresh did not complete');
    }
  };
  const buildAuthoritativeHookReport = async (): Promise<HookReport> => {
    const report = await requestGateway<HookReport>('hooks.status', {
      agentId: DEFAULT_MANAGED_AGENT_ID,
    });
    const pluginScopes = new Map<string, PluginHubScope>();
    if (
      report.hooks.some(hook => hook.managedByPlugin === true && typeof hook.pluginId === 'string')
    ) {
      try {
        const inventory = await requestGateway<{
          plugins: Array<{ id: string; origin?: string }>;
        }>('plugins.list', {});
        for (const plugin of inventory.plugins) {
          if (typeof plugin.origin === 'string') {
            pluginScopes.set(plugin.id, getExtensionManagement({ origin: plugin.origin }).scope);
          }
        }
      } catch {
        // An unavailable parent inventory must not hide the authoritative Hook list.
        console.warn('[OpenClawHooks] Parent extension origins are unavailable');
      }
    }
    return {
      ...report,
      hooks: report.hooks.map(hook => ({
        ...hook,
        ...getHookManagement({
          source: typeof hook.source === 'string' ? hook.source : undefined,
          managedByPlugin: hook.managedByPlugin === true,
          pluginId: typeof hook.pluginId === 'string' ? hook.pluginId : undefined,
          pluginScope:
            typeof hook.pluginId === 'string' ? pluginScopes.get(hook.pluginId) : undefined,
          requirementsSatisfied: hook.requirementsSatisfied !== false,
          filePath: typeof hook.filePath === 'string' ? hook.filePath : undefined,
        }),
      })),
    };
  };
  installationService.registerInstaller({
    kind: PluginKind.HOOK,
    install: request =>
      runHookMutationExclusive(async syncConfig => {
        if (request.payload.kind !== PluginKind.HOOK) {
          return { success: false, error: 'Invalid Hook installation payload' };
        }
        const currentReport = await buildAuthoritativeHookReport();
        const bundledHookIds = new Set(
          currentReport.hooks
            .filter(hook => hook.source === 'openclaw-bundled')
            .map(hook => String(hook.hookKey || hook.name || '').toLowerCase())
            .filter(Boolean),
        );
        const hookStore = getStore();
        const files = new OpenClawHookFiles(currentReport.managedHooksDir, bundledHookIds);
        const result = await files.importPath(request.payload.sourcePath);
        if (!result.success || !result.hookId) {
          return { success: false, error: result.error || 'Failed to import Hook' };
        }

        const installedPath = path.resolve(currentReport.managedHooksDir, result.hookId);
        let hookId = result.hookId;
        let previousState: ReturnType<OpenClawHookStore['getHook']> = null;
        let stateChanged = false;
        try {
          const importedReport = await buildAuthoritativeHookReport();
          const hook = importedReport.hooks.find(
            entry =>
              entry.source === 'openclaw-managed' &&
              entry.managedByPlugin !== true &&
              typeof entry.baseDir === 'string' &&
              path.resolve(entry.baseDir) === installedPath,
          );
          if (!hook) throw new Error('Imported Hook is unavailable in the Gateway inventory');
          hookId =
            typeof hook.hookKey === 'string' && hook.hookKey.trim() ? hook.hookKey : result.hookId;
          previousState = hookStore.getHook(hookId);
          stateChanged = true;
          // Native discovery reports managed Hooks enabled by default, but the
          // execution loader selects only explicitly configured Hooks.
          hookStore.setEnabled(hookId, true);
          const syncResult = await syncConfig();
          if (syncResult.error) throw new Error(syncResult.error);
          // Reimported files can leave the parsed config unchanged. The native
          // metadata lifecycle refresh also republishes internal Hook handlers.
          await refreshHookRuntime();
          return { success: true, pluginId: hookId, restartRequired: false };
        } catch (error) {
          const rollbackErrors: string[] = [];
          if (stateChanged) {
            try {
              restoreHookState(hookStore, hookId, previousState);
            } catch (rollbackError) {
              rollbackErrors.push(
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              );
            }
          }
          try {
            files.deleteDirectory(installedPath);
          } catch (rollbackError) {
            rollbackErrors.push(
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            );
          }
          if (stateChanged) {
            try {
              const rollbackSync = await syncConfig();
              if (rollbackSync.error) throw new Error(rollbackSync.error);
              // A timed-out refresh may already have published handlers even
              // when restoring an enabled orphan leaves the config unchanged.
              await refreshHookRuntime();
            } catch (rollbackError) {
              rollbackErrors.push(
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              );
            }
          }
          if (rollbackErrors.length > 0) {
            console.error('[OpenClawHooks] Hook import rollback incomplete:', rollbackErrors);
          }
          return {
            success: false,
            error: [
              error instanceof Error ? error.message : 'Failed to activate imported Hook',
              ...(rollbackErrors.length > 0
                ? [`Rollback incomplete: ${rollbackErrors.join('; ')}`]
                : []),
            ].join(' '),
          };
        }
      }),
  });

  ipcMain.handle(HookIpc.List, async () => {
    try {
      const report = await buildAuthoritativeHookReport();
      return {
        success: true,
        ...report,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to load hooks';
      console.error('[Hooks] hooks:list error:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: /not connected|unavailable|timed out|ECONNREFUSED/i.test(errorMsg),
      };
    }
  });

  ipcMain.handle(HookIpc.Import, async (_event, sourcePath: string) => {
    try {
      if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
        return { success: false, error: 'Hook source path is required' };
      }

      const result = await installationService.install({
        operation: MarketplaceInstallOperation.INSTALL,
        origin: PluginInstallOrigin.CUSTOM,
        payload: { kind: PluginKind.HOOK, sourcePath: sourcePath.trim() },
      });
      if (!result.success) return result;

      return {
        success: true,
        hookId: result.pluginId,
        restartRequired: false,
        ...(await refreshHookReportAfterMutation(buildAuthoritativeHookReport)),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import Hook';
      console.error('[OpenClawHooks] hooks:import error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(HookIpc.Delete, (_event, hookId: string) =>
    runHookMutationExclusive(async syncConfig => {
      try {
        if (typeof hookId !== 'string' || !hookId.trim()) {
          return { success: false, error: 'Hook id is required' };
        }

        const id = hookId.trim();
        const hookStore = getStore();
        const currentReport = await buildAuthoritativeHookReport();
        const hook = findHookByAuthoritativeId(currentReport.hooks, id);
        if (!hook) {
          return { success: false, error: 'Only custom Hooks can be deleted' };
        }
        if (hook.source !== 'openclaw-managed' || hook.managedByPlugin === true) {
          return { success: false, error: 'Only custom Hooks can be deleted' };
        }
        if (typeof hook.baseDir !== 'string' || !hook.baseDir) {
          return { success: false, error: 'Hook directory is unavailable' };
        }

        const previousState = hookStore.getHook(id);
        const stagedDeletion = new OpenClawHookFiles(
          currentReport.managedHooksDir,
        ).stageDeleteDirectory(hook.baseDir);
        try {
          hookStore.deleteHook(id);
          const syncResult = await syncConfig();
          if (syncResult.error) {
            throw new Error(syncResult.error);
          }
        } catch (error) {
          const rollbackErrors: string[] = [];
          try {
            restoreHookState(hookStore, id, previousState);
          } catch (rollbackError) {
            rollbackErrors.push(
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            );
          }
          try {
            stagedDeletion.rollback();
          } catch (rollbackError) {
            rollbackErrors.push(
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            );
          }
          rollbackErrors.push(...(await syncHookConfigForRollback(syncConfig)));
          if (rollbackErrors.length > 0) {
            console.error('[OpenClawHooks] Hook deletion rollback incomplete:', rollbackErrors);
          }
          return {
            success: false,
            error: [
              error instanceof Error ? error.message : 'Failed to synchronize Hook deletion',
              ...(rollbackErrors.length > 0
                ? [`Rollback incomplete: ${rollbackErrors.join('; ')}`]
                : []),
            ].join(' '),
          };
        }
        try {
          stagedDeletion.commit();
        } catch (error) {
          console.warn(
            '[OpenClawHooks] Hook removed but quarantine cleanup failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
        return {
          success: true,
          restartRequired: false,
          ...(await refreshHookReportAfterMutation(buildAuthoritativeHookReport)),
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to delete Hook';
        console.error('[OpenClawHooks] hooks:delete error:', errorMsg);
        return { success: false, error: errorMsg };
      }
    }),
  );

  ipcMain.handle(HookIpc.SetEnabled, (_event, options: unknown) =>
    runHookMutationExclusive(async syncConfig => {
      try {
        if (
          !options ||
          typeof options !== 'object' ||
          Array.isArray(options) ||
          typeof (options as { id?: unknown }).id !== 'string' ||
          !(options as { id: string }).id.trim() ||
          typeof (options as { enabled?: unknown }).enabled !== 'boolean'
        ) {
          return { success: false, error: 'Hook id and enabled state are required' };
        }
        const { enabled } = options as { id: string; enabled: boolean };
        const hookId = (options as { id: string }).id.trim();

        const hookStore = getStore();
        const currentReport = await buildAuthoritativeHookReport();
        const hook = findHookByAuthoritativeId(currentReport.hooks, hookId);
        if (!hook) {
          return { success: false, error: `Hook "${hookId}" not found` };
        }
        if (hook.managedByPlugin === true) {
          return { success: false, error: 'Plugin-managed Hooks cannot be changed here' };
        }
        if (enabled && hook.requirementsSatisfied === false) {
          return { success: false, error: 'Hook requirements are not satisfied' };
        }

        const previousState = hookStore.getHook(hookId);
        try {
          hookStore.setEnabled(hookId, enabled);
          const syncResult = await syncConfig();
          if (syncResult.error) {
            throw new Error(syncResult.error);
          }
        } catch (error) {
          let rollbackErrorMessage = '';
          try {
            restoreHookState(hookStore, hookId, previousState);
          } catch (rollbackError) {
            rollbackErrorMessage =
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            console.error('[OpenClawHooks] Hook status rollback failed:', rollbackErrorMessage);
          }
          const recoveryErrors = await syncHookConfigForRollback(syncConfig);
          return {
            success: false,
            error: [
              error instanceof Error ? error.message : 'Failed to synchronize Hook status',
              ...(rollbackErrorMessage ? [`Rollback failed: ${rollbackErrorMessage}`] : []),
              ...(recoveryErrors.length > 0
                ? [`Rollback incomplete: ${recoveryErrors.join('; ')}`]
                : []),
            ].join(' '),
          };
        }
        return {
          success: true,
          restartRequired: false,
          ...(await refreshHookReportAfterMutation(buildAuthoritativeHookReport)),
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to update hook';
        console.error('[Hooks] hooks:setEnabled error:', errorMsg);
        return {
          success: false,
          error: errorMsg,
          gatewayOffline: /not connected|unavailable|timed out|ECONNREFUSED/i.test(errorMsg),
        };
      }
    }),
  );
};

import { ipcMain } from 'electron';

import { HookIpc } from '../../../shared/openclaw/hooks';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { DEFAULT_MANAGED_AGENT_ID } from '../../openclaw/sessions/openclawSessionKeys';
import { OpenClawHookFiles, type OpenClawHookStore } from '../../plugins/hooks';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';

interface HookHandlerDependencies {
  getStore: () => OpenClawHookStore;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  syncConfig: () => Promise<{ hooks: number; error?: string }>;
  installationService: PluginInstallationService;
}

type HookReport = {
  workspaceDir: string;
  managedHooksDir: string;
  hooks: Array<Record<string, unknown>>;
};

const syncHookConfigInBackground = (
  syncConfig: HookHandlerDependencies['syncConfig'],
): void => {
  void syncConfig().catch(error => {
    console.error('[OpenClawHooks] background configuration sync error:', error);
  });
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
  installationService,
}: HookHandlerDependencies): void => {
  let hookMutationTail: Promise<void> = Promise.resolve();
  const runHookMutationExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = hookMutationTail;
    let release!: () => void;
    hookMutationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const buildAuthoritativeHookReport = (): Promise<HookReport> =>
    requestGateway<HookReport>('hooks.status', { agentId: DEFAULT_MANAGED_AGENT_ID });
  installationService.registerInstaller({
    kind: PluginKind.HOOK,
    install: async request => {
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
      const result = await new OpenClawHookFiles(
        currentReport.managedHooksDir,
        bundledHookIds,
      ).importPath(request.payload.sourcePath);
      return { success: result.success, pluginId: result.hookId, error: result.error };
    },
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
        ...(await buildAuthoritativeHookReport()),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import Hook';
      console.error('[OpenClawHooks] hooks:import error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(HookIpc.Delete, (_event, hookId: string) =>
    runHookMutationExclusive(async () => {
    try {
      if (typeof hookId !== 'string' || !hookId.trim()) {
        return { success: false, error: 'Hook id is required' };
      }

      const id = hookId.trim();
      const hookStore = getStore();
      const currentReport = await buildAuthoritativeHookReport();
      const hook = currentReport.hooks.find(
        entry =>
          (entry.hookKey === id || entry.name === id) &&
          entry.source === 'openclaw-managed' &&
          entry.managedByPlugin !== true,
      );
      if (!hook) {
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
        syncHookConfigInBackground(syncConfig);
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
    runHookMutationExclusive(async () => {
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
      const hook = currentReport.hooks.find(
        entry => entry.hookKey === hookId || entry.name === hookId,
      );
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
        syncHookConfigInBackground(syncConfig);
        return {
          success: false,
          error: [
            error instanceof Error ? error.message : 'Failed to synchronize Hook status',
            ...(rollbackErrorMessage ? [`Rollback failed: ${rollbackErrorMessage}`] : []),
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

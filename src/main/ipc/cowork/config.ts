import { ipcMain } from 'electron';

import {
  AgentRuntimeSettingsIpc,
  validateAgentRuntimeSettings,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { isPermissionMode, type PermissionMode } from '../../../shared/openclaw/approvals';
import { normalizeMaxGoalContinuationTurns } from '../../../shared/sessionGoal';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkAgentEngine, CoworkEngineRouter } from '../../engine';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';

interface SyncResult {
  success: boolean;
  changed: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
}

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getEngineManager: () => OpenClawEngineManager;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<SyncResult>;
  ensureEngineRunning: () => Promise<OpenClawEngineStatus>;
  engineNotReadyCode: string;
}

let configUpdateQueue: Promise<void> = Promise.resolve();

export const enqueueCoworkConfigUpdate = <T>(task: () => Promise<T>): Promise<T> => {
  const result = configUpdateQueue.then(task, task);
  configUpdateQueue = result.then(
    (): void => undefined,
    (): void => undefined,
  );
  return result;
};

export const waitForCoworkConfigUpdates = (): Promise<void> =>
  enqueueCoworkConfigUpdate(async (): Promise<void> => undefined);

export const registerCoworkConfigHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  getEngineManager,
  syncOpenClawConfig,
  ensureEngineRunning,
  engineNotReadyCode,
}: Dependencies): void => {
  ipcMain.handle('cowork:config:get', async () => {
    try {
      return { success: true, config: getCoworkStore().getConfig() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get config',
      };
    }
  });

  ipcMain.handle(AgentRuntimeSettingsIpc.Get, async () => {
    try {
      return { success: true, settings: getCoworkStore().getAgentRuntimeSettings() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get runtime configuration',
      };
    }
  });

  ipcMain.handle(AgentRuntimeSettingsIpc.Set, (_event, input: unknown) =>
    enqueueCoworkConfigUpdate(async () => {
      const validation = validateAgentRuntimeSettings(input);
      if (validation.ok === false) {
        return { success: false, error: validation.error };
      }

      const store = getCoworkStore();
      const previous = store.getAgentRuntimeSettings();
      const next = validation.settings;
      if (JSON.stringify(previous) === JSON.stringify(next)) {
        return { success: true, changed: false, settings: next };
      }

      const rollback = async (syncError: string) => {
        try {
          store.setAgentRuntimeSettings(previous);
          const rollbackResult = await syncOpenClawConfig({
            reason: 'agent-runtime-settings-change-rollback',
          });
          return {
            success: false,
            error: rollbackResult.success
              ? `The runtime configuration was rolled back. ${syncError}`
              : `The runtime configuration rollback could not be confirmed. ${
                  rollbackResult.error || syncError
                }`,
            engineStatus: getEngineManager().getStatus(),
          };
        } catch (error) {
          return {
            success: false,
            error: `The runtime configuration rollback could not be confirmed. ${
              error instanceof Error ? error.message : syncError
            }`,
            engineStatus: getEngineManager().getStatus(),
          };
        }
      };

      try {
        store.setAgentRuntimeSettings(next);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set runtime configuration',
        };
      }

      let syncResult: SyncResult;
      try {
        syncResult = await syncOpenClawConfig({
          reason: 'agent-runtime-settings-change',
        });
      } catch (error) {
        return rollback(
          error instanceof Error ? error.message : 'Runtime configuration synchronization failed.',
        );
      }

      if (syncResult.success) {
        return {
          success: true,
          changed: true,
          settings: next,
          engineStatus: syncResult.status,
        };
      }

      return rollback(syncResult.error || 'Runtime configuration synchronization failed.');
    }),
  );

  ipcMain.handle(
    'cowork:config:set',
    (
      _event,
      config: {
        workingDirectory?: string;
        executionMode?: 'auto' | 'local' | 'sandbox';
        agentEngine?: CoworkAgentEngine;
        permissionMode?: PermissionMode;
        maxGoalContinuationTurns?: number;
      },
    ) =>
      enqueueCoworkConfigUpdate(async () => {
        try {
          if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return { success: false, error: 'Invalid cowork configuration.' };
          }
          const hasPermissionMode = Object.prototype.hasOwnProperty.call(config, 'permissionMode');
          if (
            hasPermissionMode &&
            config.permissionMode !== undefined &&
            !isPermissionMode(config.permissionMode)
          ) {
            return { success: false, error: 'Invalid permission mode.' };
          }
          const executionMode =
            config.executionMode && String(config.executionMode) === 'container'
              ? 'local'
              : config.executionMode;
          const agentEngine = config.agentEngine === 'openclaw' ? 'openclaw' : undefined;
          const permissionMode = isPermissionMode(config.permissionMode)
            ? config.permissionMode
            : undefined;
          const maxGoalContinuationTurns =
            config.maxGoalContinuationTurns === undefined
              ? undefined
              : normalizeMaxGoalContinuationTurns(config.maxGoalContinuationTurns);
          const normalized: Parameters<CoworkStore['setConfig']>[0] = {
            workingDirectory: config.workingDirectory,
            executionMode,
            agentEngine,
            permissionMode,
            ...(maxGoalContinuationTurns === undefined ? {} : { maxGoalContinuationTurns }),
          };
          const store = getCoworkStore();
          const previous = store.getConfig();
          store.setConfig(normalized);
          const next = store.getConfig();

          if (agentEngine !== undefined && agentEngine !== previous.agentEngine) {
            getCoworkEngineRouter().handleEngineConfigChanged(agentEngine);
          }
          const switchedToOpenClaw =
            agentEngine === 'openclaw' && previous.agentEngine !== 'openclaw';
          const shouldSync =
            (executionMode !== undefined && executionMode !== previous.executionMode) ||
            (agentEngine !== undefined && agentEngine !== previous.agentEngine) ||
            (normalized.workingDirectory !== undefined &&
              normalized.workingDirectory !== previous.workingDirectory);
          if (shouldSync) {
            const syncResult = await syncOpenClawConfig({
              reason: 'cowork-config-change',
            });
            if (!syncResult.success && next.agentEngine === 'openclaw') {
              store.setConfig(previous);
              if (agentEngine !== undefined && agentEngine !== previous.agentEngine) {
                getCoworkEngineRouter().handleEngineConfigChanged(previous.agentEngine);
              }
              const rollbackResult = await syncOpenClawConfig({
                reason: 'cowork-config-change-rollback',
              });
              return {
                success: false,
                code: engineNotReadyCode,
                error: rollbackResult.success
                  ? `The preference was rolled back. ${syncResult.error || 'OpenClaw configuration synchronization failed.'}`
                  : `The preference rollback could not be confirmed. The Gateway remains stopped. ${
                      rollbackResult.error || syncResult.error || 'OpenClaw config sync failed.'
                    }`,
                engineStatus: getEngineManager().getStatus(),
              };
            }
          }
          if (switchedToOpenClaw) {
            void ensureEngineRunning().catch(error => {
              console.error('[OpenClaw] Failed to auto-start gateway after engine switch:', error);
            });
          }
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to set config',
          };
        }
      }),
  );
};

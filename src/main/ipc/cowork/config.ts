import { ipcMain } from 'electron';

import { isPermissionMode, type PermissionMode } from '../../../shared/openclaw/approvals';
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

  ipcMain.handle(
    'cowork:config:set',
    (
      _event,
      config: {
        workingDirectory?: string;
        executionMode?: 'auto' | 'local' | 'sandbox';
        agentEngine?: CoworkAgentEngine;
        permissionMode?: PermissionMode;
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
          const normalized: Parameters<CoworkStore['setConfig']>[0] = {
            workingDirectory: config.workingDirectory,
            executionMode,
            agentEngine,
            permissionMode,
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
          const hasNonPermissionConfigChange =
            (executionMode !== undefined && executionMode !== previous.executionMode) ||
            (agentEngine !== undefined && agentEngine !== previous.agentEngine) ||
            (normalized.workingDirectory !== undefined &&
              normalized.workingDirectory !== previous.workingDirectory);
          const isPermissionOnlyChange =
            permissionMode !== undefined &&
            permissionMode !== previous.permissionMode &&
            !hasNonPermissionConfigChange;
          const shouldSync =
            executionMode !== undefined ||
            agentEngine !== undefined ||
            permissionMode !== undefined ||
            (normalized.workingDirectory !== undefined &&
              normalized.workingDirectory !== previous.workingDirectory);
          if (shouldSync) {
            const syncResult = await syncOpenClawConfig({
              reason: 'cowork-config-change',
              // OpenClaw refreshes permission snapshots in place. Keep a pure
              // composer permission change hot, while preserving the normal
              // restart fallback for every other cowork config change.
              ...(isPermissionOnlyChange ? { restartGatewayIfRunning: false } : {}),
            });
            if (!syncResult.success && next.agentEngine === 'openclaw') {
              store.setConfig(previous);
              if (agentEngine !== undefined && agentEngine !== previous.agentEngine) {
                getCoworkEngineRouter().handleEngineConfigChanged(previous.agentEngine);
              }
              const rollbackResult = await syncOpenClawConfig({
                reason: 'cowork-config-change-rollback',
                ...(isPermissionOnlyChange ? { restartGatewayIfRunning: false } : {}),
              });
              return {
                success: false,
                code: engineNotReadyCode,
                error: rollbackResult.success
                  ? `The preference was rolled back. ${syncResult.error || 'OpenClaw runtime permission synchronization failed.'}`
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

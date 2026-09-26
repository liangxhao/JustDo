import { ipcMain } from 'electron';

import { normalizeMaxRetainedDisplayTabs } from '../../../shared/cowork/displayTabRetention';
import { normalizeMaxGoalContinuationTurns } from '../../../shared/cowork/sessionGoal';
import {
  AgentRuntimeSettingsIpc,
  validateAgentRuntimeSettings,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { isPermissionMode, type PermissionMode } from '../../../shared/openclaw/approvals';
import { getExternalAgentDefinition } from '../../../shared/openclaw/externalAgentCatalog';
import {
  ExternalAgentIpc,
  type ExternalAgentTestResult,
  validateExternalAgentSettings,
} from '../../../shared/openclaw/externalAgents';
import { SessionStorageIpc } from '../../../shared/openclaw/sessionStorage';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkAgentEngine, CoworkEngineRouter } from '../../engine';
import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../openclaw/runtime/openclawEngineManager';
import { SessionStorageService } from '../../openclaw/sessions/sessionStorageService';
import type { WindowsSandboxService } from '../../security/windowsSandboxService';

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
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  getWindowsSandboxService: () => WindowsSandboxService;
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
  requestGateway,
  getWindowsSandboxService,
  engineNotReadyCode,
}: Dependencies): void => {
  const storage = new SessionStorageService(requestGateway);
  ipcMain.handle(SessionStorageIpc.Status, () => storage.getStatus());
  ipcMain.handle(SessionStorageIpc.Policy, () => storage.getPolicy());
  ipcMain.handle(SessionStorageIpc.Save, (_event, input: unknown) => storage.savePolicy(input));
  ipcMain.handle(SessionStorageIpc.Run, () => storage.run());

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

  ipcMain.handle(ExternalAgentIpc.GET_SETTINGS, async () => {
    try {
      return { success: true, settings: getCoworkStore().getExternalAgentSettings() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get external agent settings',
      };
    }
  });

  ipcMain.handle(ExternalAgentIpc.TEST, async (_event, agentId: unknown) => {
    const definition =
      typeof agentId === 'string' ? getExternalAgentDefinition(agentId) : undefined;
    if (!definition) {
      return {
        success: false,
        error: 'Unsupported external agent.',
      } satisfies ExternalAgentTestResult;
    }
    try {
      const currentEngineStatus = getEngineManager().getStatus();
      const engineStatus =
        currentEngineStatus.phase === 'running'
          ? currentEngineStatus
          : await ensureEngineRunning();
      if (engineStatus.phase !== 'running') {
        throw new Error(engineStatus.message || 'The AI engine is not ready.');
      }
      const report = await requestGateway<unknown>('acpx.agent.doctor', {
        agentId: definition.id,
      });
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('The ACP runtime returned an invalid test result.');
      }
      const value = report as Record<string, unknown>;
      if (typeof value.ok !== 'boolean' || typeof value.message !== 'string') {
        throw new Error('The ACP runtime returned an invalid test result.');
      }
      const details = Array.isArray(value.details)
        ? value.details
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 8)
            .map(item => item.slice(0, 2_000))
        : undefined;
      return {
        success: true,
        ready: value.ok,
        message: value.message.slice(0, 2_000),
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
        ...(details?.length ? { details } : {}),
      } satisfies ExternalAgentTestResult;
    } catch (error) {
      return {
        success: false,
        error: (error instanceof Error
          ? error.message
          : 'Failed to test the external agent.'
        ).slice(0, 2_000),
      } satisfies ExternalAgentTestResult;
    }
  });

  ipcMain.handle(ExternalAgentIpc.SET_SETTINGS, (_event, input: unknown) =>
    enqueueCoworkConfigUpdate(async () => {
      const validation = validateExternalAgentSettings(input);
      if (validation.ok === false) return { success: false, error: validation.error };

      const store = getCoworkStore();
      const previous = store.getExternalAgentSettings();
      const next = validation.settings;
      if (JSON.stringify(previous) === JSON.stringify(next)) {
        return { success: true, changed: false, settings: next };
      }

      const rollback = async (syncError: string) => {
        try {
          store.setExternalAgentSettings(previous);
          const rollbackResult = await syncOpenClawConfig({
            reason: 'external-agent-settings-change-rollback',
          });
          return {
            success: false,
            error: rollbackResult.success
              ? `The external agent configuration was rolled back. ${syncError}`
              : `The external agent configuration rollback could not be confirmed. ${
                  rollbackResult.error || syncError
                }`,
            engineStatus: getEngineManager().getStatus(),
          };
        } catch (error) {
          return {
            success: false,
            error: `The external agent configuration rollback could not be confirmed. ${
              error instanceof Error ? error.message : syncError
            }`,
            engineStatus: getEngineManager().getStatus(),
          };
        }
      };

      try {
        store.setExternalAgentSettings(next);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set external agent settings',
        };
      }
      let syncResult: SyncResult;
      try {
        syncResult = await syncOpenClawConfig({ reason: 'external-agent-settings-change' });
      } catch (error) {
        return rollback(
          error instanceof Error ? error.message : 'External agent configuration failed.',
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

      return rollback(syncResult.error || 'External agent configuration failed.');
    }),
  );

  ipcMain.handle(
    'cowork:config:set',
    (
      _event,
      config: {
        workingDirectory?: string;
        executionMode?: 'auto' | 'local' | 'sandbox';
        sandboxNetworkEnabled?: boolean;
        agentEngine?: CoworkAgentEngine;
        permissionMode?: PermissionMode;
        maxGoalContinuationTurns?: number;
        maxRetainedDisplayTabs?: number;
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
            config.executionMode &&
            (String(config.executionMode) === 'container' || config.executionMode === 'auto')
              ? 'local'
              : config.executionMode;
          if (
            executionMode !== undefined &&
            executionMode !== 'local' &&
            executionMode !== 'sandbox'
          ) {
            return { success: false, error: 'Invalid execution mode.' };
          }
          if (
            config.sandboxNetworkEnabled !== undefined &&
            typeof config.sandboxNetworkEnabled !== 'boolean'
          ) {
            return { success: false, error: 'Invalid sandbox network setting.' };
          }
          if (executionMode === 'sandbox') {
            const sandboxStatus = await getWindowsSandboxService().getStatus();
            if (!sandboxStatus.ready) {
              return {
                success: false,
                error:
                  sandboxStatus.error ||
                  'The Windows sandbox must be installed and initialized before it can be enabled.',
                sandboxStatus,
              };
            }
          }
          const agentEngine = config.agentEngine === 'openclaw' ? 'openclaw' : undefined;
          const permissionMode = isPermissionMode(config.permissionMode)
            ? config.permissionMode
            : undefined;
          const maxGoalContinuationTurns =
            config.maxGoalContinuationTurns === undefined
              ? undefined
              : normalizeMaxGoalContinuationTurns(config.maxGoalContinuationTurns);
          const maxRetainedDisplayTabs =
            config.maxRetainedDisplayTabs === undefined
              ? undefined
              : normalizeMaxRetainedDisplayTabs(config.maxRetainedDisplayTabs);
          const normalized: Parameters<CoworkStore['setConfig']>[0] = {
            workingDirectory: config.workingDirectory,
            executionMode,
            sandboxNetworkEnabled: config.sandboxNetworkEnabled,
            agentEngine,
            permissionMode,
            ...(maxGoalContinuationTurns === undefined ? {} : { maxGoalContinuationTurns }),
            ...(maxRetainedDisplayTabs === undefined ? {} : { maxRetainedDisplayTabs }),
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
            (normalized.sandboxNetworkEnabled !== undefined &&
              normalized.sandboxNetworkEnabled !== previous.sandboxNetworkEnabled) ||
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

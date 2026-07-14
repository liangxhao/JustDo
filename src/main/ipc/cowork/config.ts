import { ipcMain } from 'electron';

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
  syncOpenClawConfig: (options: { reason: string }) => Promise<SyncResult>;
  ensureEngineRunning: () => Promise<OpenClawEngineStatus>;
  engineNotReadyCode: string;
}

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
    async (
      _event,
      config: {
        workingDirectory?: string;
        executionMode?: 'auto' | 'local' | 'sandbox';
        agentEngine?: CoworkAgentEngine;
      },
    ) => {
      try {
        const executionMode =
          config.executionMode && String(config.executionMode) === 'container'
            ? 'local'
            : config.executionMode;
        const agentEngine = config.agentEngine === 'openclaw' ? 'openclaw' : undefined;
        const normalized: Parameters<CoworkStore['setConfig']>[0] = {
          workingDirectory: config.workingDirectory,
          executionMode,
          agentEngine,
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
          executionMode !== undefined ||
          agentEngine !== undefined ||
          (normalized.workingDirectory !== undefined &&
            normalized.workingDirectory !== previous.workingDirectory);
        if (shouldSync) {
          const syncResult = await syncOpenClawConfig({ reason: 'cowork-config-change' });
          if (!syncResult.success && next.agentEngine === 'openclaw') {
            return {
              success: false,
              code: engineNotReadyCode,
              error: syncResult.error || 'OpenClaw config sync failed.',
              engineStatus: syncResult.status || getEngineManager().getStatus(),
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
    },
  );
};

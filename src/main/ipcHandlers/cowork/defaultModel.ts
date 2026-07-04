import { ipcMain } from 'electron';

import type { CoworkStore } from '../../coworkStore';
import type { SqliteStore } from '../../data/sqliteStore';

type AppConfigWithModel = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, unknown>;
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

interface DefaultModelHandlerOptions {
  getStore: () => SqliteStore;
  getCoworkStore: () => CoworkStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
}

export const registerDefaultModelHandlers = ({
  getStore,
  getCoworkStore,
  syncOpenClawConfig,
}: DefaultModelHandlerOptions): void => {
  // Set default model in app_config (used when no agent/session exists)
  ipcMain.handle(
    'config:setDefaultModel',
    async (_event, options: { modelId: string; providerKey?: string }) => {
      try {
        const currentConfig = getStore().get<AppConfigWithModel>('app_config') || {};
        const updatedConfig = {
          ...currentConfig,
          model: {
            ...currentConfig.model,
            defaultModel: options.modelId,
            defaultModelProvider: options.providerKey || currentConfig.model?.defaultModelProvider,
          },
        };
        getStore().set('app_config', updatedConfig);

        // Also update main agent's model in the database so agents.list reflects the new model
        const modelRef = options.providerKey
          ? `${options.providerKey}/${options.modelId}`
          : options.modelId;
        try {
          const mainAgent = getCoworkStore().getAgent('main');
          if (mainAgent && mainAgent.model !== modelRef) {
            getCoworkStore().updateAgent('main', { model: modelRef });
          }
        } catch {
          // Non-fatal: agent update failed, config sync will still proceed
        }

        // syncOpenClawConfig will pick up the updated agent model
        const syncResult = await syncOpenClawConfig({
          reason: 'default-model-change',
          restartGatewayIfRunning: false,
        });
        if (!syncResult.success) {
          console.error(
            '[Main] Failed to sync OpenClaw config after default model update:',
            syncResult.error,
          );
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set default model',
        };
      }
    },
  );
};

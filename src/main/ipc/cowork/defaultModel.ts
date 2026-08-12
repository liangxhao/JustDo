import { ipcMain } from 'electron';

import type { CoworkStore } from '../../data/coworkStore';
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
    async (_event, options: { modelId: string; providerKey?: string; agentId?: string }) => {
      try {
        const currentConfig = getStore().get<AppConfigWithModel>('app_config') || {};
        const agentId = options.agentId || 'main';
        const selectedAgent = getCoworkStore().getAgent(agentId);
        const updatedConfig = {
          ...currentConfig,
          model: {
            ...currentConfig.model,
            defaultModel: options.modelId,
            defaultModelProvider: options.providerKey || currentConfig.model?.defaultModelProvider,
          },
        };
        getStore().set('app_config', updatedConfig);

        // Keep the selected agent in sync so the newly-created session resolves
        // to the same model after the prompt input remounts.
        const modelRef = options.providerKey
          ? `${options.providerKey}/${options.modelId}`
          : options.modelId;
        const shouldUpdateAgent = !!selectedAgent && selectedAgent.model !== modelRef;
        let applyError: string | null = null;
        try {
          if (shouldUpdateAgent) getCoworkStore().updateAgent(agentId, { model: modelRef });

          // syncOpenClawConfig will pick up the updated agent model.
          const syncResult = await syncOpenClawConfig({
            reason: 'default-model-change',
          });
          if (!syncResult.success) {
            applyError = syncResult.error || 'Failed to apply default model';
          }
        } catch (error) {
          applyError = error instanceof Error ? error.message : String(error);
        }

        if (applyError) {
          console.error('[Main] Failed to apply default model:', applyError);
          const latestConfig = getStore().get<AppConfigWithModel>('app_config') || {};
          const rollbackConfig = { ...latestConfig };
          if (currentConfig.model) {
            rollbackConfig.model = currentConfig.model;
          } else {
            delete rollbackConfig.model;
          }
          const rollbackErrors: string[] = [];
          try {
            getStore().set('app_config', rollbackConfig);
          } catch (error) {
            rollbackErrors.push(error instanceof Error ? error.message : String(error));
          }
          if (shouldUpdateAgent && selectedAgent) {
            try {
              getCoworkStore().updateAgent(agentId, { model: selectedAgent.model });
            } catch (error) {
              rollbackErrors.push(error instanceof Error ? error.message : String(error));
            }
          }
          try {
            const rollbackResult = await syncOpenClawConfig({
              reason: 'default-model-change-rollback',
            });
            if (!rollbackResult.success) {
              rollbackErrors.push(rollbackResult.error || 'OpenClaw config rollback failed');
            }
          } catch (error) {
            rollbackErrors.push(error instanceof Error ? error.message : String(error));
          }
          return {
            success: false,
            error:
              rollbackErrors.length === 0
                ? applyError
                : `Failed to apply default model (${applyError}); rollback failed: ${rollbackErrors.join('; ')}`,
          };
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

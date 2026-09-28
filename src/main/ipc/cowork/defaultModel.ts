import { ipcMain } from 'electron';

import { matchesModelSelectionIdentity } from '../../../shared/openclaw/modelSelectionIdentity';
import {
  getEffectiveCustomProviderDisplayName,
  isJustDoCustomProviderKey,
  normalizeOpenClawProviderId,
  ProviderName,
} from '../../../shared/providers';
import { t } from '../../core/i18n';
import { enqueueAppConfigUpdate } from '../../data/appConfigUpdateQueue';
import type { CoworkStore } from '../../data/coworkStore';
import type { SqliteStore } from '../../data/sqliteStore';
import { getActiveBuiltinModelCredential } from '../../providers/builtinModelCredential';

type AppConfigWithModel = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<
    string,
    {
      enabled?: boolean;
      apiKey?: string;
      baseUrl?: string;
      displayName?: unknown;
      models?: { id: string; enabled?: boolean }[];
    }
  >;
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
    async (
      _event,
      options: { modelId: string; providerKey?: string; modelRef?: string; agentId?: string },
    ) =>
      enqueueAppConfigUpdate(async () => {
        try {
          const currentConfig = getStore().get<AppConfigWithModel>('app_config') || {};
          const modelId = options.modelId?.trim();
          const providerKey =
            options.providerKey?.trim() || currentConfig.model?.defaultModelProvider;
          const provider = providerKey ? currentConfig.providers?.[providerKey] : undefined;
          if (
            !modelId ||
            !providerKey ||
            !provider?.enabled ||
            !provider.models?.some(model => model.id === modelId && model.enabled !== false)
          ) {
            return {
              success: false,
              error: t('selectedModelUnavailable'),
            };
          }
          if (
            !provider.baseUrl?.trim() ||
            !(providerKey === ProviderName.BuiltinModels
              ? getActiveBuiltinModelCredential()
              : provider.apiKey?.trim())
          ) {
            return {
              success: false,
              error: t('selectedModelProviderNotReady'),
            };
          }
          const providerId = isJustDoCustomProviderKey(providerKey)
            ? normalizeOpenClawProviderId(
                getEffectiveCustomProviderDisplayName(providerKey, provider.displayName),
              )
            : normalizeOpenClawProviderId(providerKey);
          const selectedModelRef = `${providerId}/${modelId}`;
          if (
            options.modelRef?.trim() &&
            !matchesModelSelectionIdentity(selectedModelRef, options.modelRef.trim())
          ) {
            return {
              success: false,
              error: t('selectedModelRouteChanged'),
            };
          }
          const agentId = options.agentId || 'main';
          const selectedAgent = getCoworkStore().getAgent(agentId);
          const updatedConfig = {
            ...currentConfig,
            model: {
              ...currentConfig.model,
              defaultModel: modelId,
              defaultModelProvider: providerKey,
            },
          };
          if (agentId === 'main') getStore().set('app_config', updatedConfig);

          // Main follows the application default; only specialists have profile overrides.
          const modelRef = agentId === 'main' ? '' : selectedModelRef;
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
              if (agentId === 'main') getStore().set('app_config', rollbackConfig);
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
      }),
  );
};

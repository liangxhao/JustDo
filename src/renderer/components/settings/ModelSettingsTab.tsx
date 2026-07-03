import { ArrowPathIcon, SignalIcon } from '@heroicons/react/24/outline';
import React from 'react';

import {
  type AppConfig,
  defaultConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  isBuiltinModelsProvider,
  isCustomProvider,
  validateDisplayName,
} from '../../config';
import { i18nService } from '../../services/i18n';
import PencilIcon from '../icons/PencilIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import { CustomProviderIcon, OllamaIcon } from '../icons/providers';
import TrashIcon from '../icons/TrashIcon';

type ProviderType = string;
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type BuiltinProviderType = 'ollama';

const providerMeta: Record<BuiltinProviderType, { label: string; icon: React.ReactNode }> = {
  ollama: { label: 'Ollama', icon: <OllamaIcon /> },
};

const formatContextLength = (tokens: number): string => {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
};

interface Props {
  activeProvider: ProviderType;
  providers: ProvidersConfig;
  isTesting: boolean;
  displayNameError: string | null;
  providerRequiresApiKey: (provider: ProviderType) => boolean;
  isProviderReadOnly: (provider: ProviderType, config?: ProviderConfig) => boolean;
  getProviderDefaultBaseUrl: (provider: ProviderType) => string | null;
  handleProviderChange: (provider: ProviderType) => void;
  handleProviderConfigChange: (provider: ProviderType, field: string, value: string) => void;
  toggleProviderEnabled: (provider: ProviderType) => void;
  handleAddCustomProvider: () => void;
  handleAddModel: () => void;
  handleEditModel: (
    modelId: string,
    modelName: string,
    supportsImage?: boolean,
    contextLength?: number,
    maxTokens?: number,
  ) => void;
  handleDeleteModel: (modelId: string) => void;
  handleTestConnection: () => void;
  handleRefreshBuiltinModels: () => void;
  isRefreshingBuiltinModels: boolean;
  setDisplayNameError: (value: string | null) => void;
}

const ModelSettingsTab: React.FC<Props> = ({
  activeProvider,
  providers,
  isTesting,
  providerRequiresApiKey,
  isProviderReadOnly,
  getProviderDefaultBaseUrl,
  handleProviderChange,
  handleProviderConfigChange,
  toggleProviderEnabled,
  handleAddCustomProvider,
  handleAddModel,
  handleEditModel,
  handleDeleteModel,
  handleTestConnection,
  handleRefreshBuiltinModels,
  isRefreshingBuiltinModels,
  displayNameError,
  setDisplayNameError,
}) => {
  const activeConfig = providers[activeProvider];
  const isReadOnly = isProviderReadOnly(activeProvider, activeConfig);
  const isBaseUrlLocked = false;
  const sortedProviders = Object.entries(providers).sort(([leftKey], [rightKey]) => {
    if (leftKey === 'builtin_models') return -1;
    if (rightKey === 'builtin_models') return 1;
    if (leftKey === 'ollama') return -1;
    if (rightKey === 'ollama') return 1;
    return leftKey.localeCompare(rightKey);
  });

  return (
    <div className="flex h-full">
      <div className="shrink-0 pr-3 space-y-1.5 overflow-y-auto" style={{ width: 260 }}>
          <div className="flex items-center justify-between mb-2 px-1">
            <h3 className="text-sm font-medium text-foreground">{i18nService.t('modelProviders')}</h3>
            <div className="flex items-center space-x-1">
              <button
                type="button"
                onClick={handleAddCustomProvider}
              className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('addCustomProvider')}
            </button>
          </div>
        </div>

        {sortedProviders.map(([provider, config]) => {
          const providerKey = provider as ProviderType;
          const isCustom = isCustomProvider(provider);
          const providerInfo =
            providerMeta[providerKey as BuiltinProviderType] ??
            (isCustom
              ? { label: getCustomProviderDefaultName(provider), icon: <CustomProviderIcon /> }
              : undefined);
          const readOnlyProviderRow = isProviderReadOnly(providerKey, config);
          const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
          const canToggleProvider = !readOnlyProviderRow && (config.enabled || !missingApiKey);
          const displayLabel =
            providerKey === 'builtin_models'
              ? i18nService.t('builtinModelsProvider')
              : getProviderDisplayName(providerKey, config);

          return (
            <div
              key={provider}
              onClick={() => handleProviderChange(providerKey)}
              className={`group flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                activeProvider === provider
                  ? 'bg-primary-muted border border-primary shadow-subtle'
                  : 'bg-surface hover:bg-surface-raised border border-transparent'
              }`}
            >
              <div className="flex flex-1 items-center min-w-0">
                <div className="mr-2 flex h-7 w-7 items-center justify-center shrink-0">
                  <span className="text-foreground">{isCustom ? <CustomProviderIcon /> : providerInfo?.icon}</span>
                </div>
                <div className="flex flex-col min-w-0">
                  <span
                    className={`text-sm font-medium truncate ${
                      activeProvider === provider ? 'text-primary' : 'text-foreground'
                    }`}
                  >
                    {displayLabel}
                  </span>
                  {isCustom && <span className="text-[9px] leading-tight mt-0.5 text-primary">{i18nService.t('customBadge')}</span>}
                  {readOnlyProviderRow && (
                    <span className="text-[9px] leading-tight mt-0.5 text-primary">
                      {i18nService.t('builtinModelsProvider')}
                    </span>
                  )}
                  {!canToggleProvider && !readOnlyProviderRow && (
                    <span className="text-[9px] leading-tight mt-0.5 text-amber-500">
                      {i18nService.t('apiKeyRequired')}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center space-x-1 shrink-0">
                {!readOnlyProviderRow && (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      toggleProviderEnabled(providerKey);
                    }}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
                      config.enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        config.enabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-w-0 pl-3 border-l border-border">
        <div className="space-y-4">
          {!isBuiltinModelsProvider(activeProvider) && (
            <div>
              <label htmlFor={`${activeProvider}-displayName`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                {i18nService.t('customDisplayName')}
              </label>
              <input
                type="text"
                id={`${activeProvider}-displayName`}
                value={(activeConfig as ProviderConfig)?.displayName ?? ''}
                onChange={e => {
                  const value = e.target.value;
                  const validation = validateDisplayName(value);
                  setDisplayNameError(validation.valid ? null : (validation.error ?? null));
                  if (validation.valid) {
                    handleProviderConfigChange(activeProvider, 'displayName', value);
                  }
                }}
                className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs ${displayNameError ? 'border-red-500 focus:border-red-500' : ''}`}
                placeholder={i18nService.t('customDisplayNamePlaceholder')}
              />
              {displayNameError && <p className="mt-1 text-xs text-red-500">{displayNameError}</p>}
            </div>
          )}

          {!isReadOnly && (
            <div>
              <label htmlFor={`${activeProvider}-baseUrl`} className="block text-xs font-medium text-foreground mb-1">
                {i18nService.t('baseUrl')}
              </label>
              <input
                type="text"
                id={`${activeProvider}-baseUrl`}
                value={activeConfig.baseUrl}
                onChange={e => handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)}
                disabled={isBaseUrlLocked}
                className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-xs ${isBaseUrlLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                placeholder={getProviderDefaultBaseUrl(activeProvider) || defaultConfig.providers?.[activeProvider]?.baseUrl || i18nService.t('baseUrlPlaceholder')}
              />
            </div>
          )}

          {(isBuiltinModelsProvider(activeProvider) || !isReadOnly) && (
            <div className="flex w-full items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || (providerRequiresApiKey(activeProvider) && !activeConfig.apiKey)}
                className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
              >
                <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
              </button>
              {activeProvider === 'builtin_models' && (
                <button
                  type="button"
                  onClick={handleRefreshBuiltinModels}
                  disabled={isRefreshingBuiltinModels}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ArrowPathIcon
                    className={`h-3.5 w-3.5 mr-1.5 ${isRefreshingBuiltinModels ? 'animate-spin' : ''}`}
                  />
                  {i18nService.t('refresh')}
                </button>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-xs font-medium text-foreground">{i18nService.t('availableModels')}</h3>
              {!isReadOnly && (
                <button type="button" onClick={handleAddModel} className="inline-flex items-center text-xs text-primary hover:text-primary-hover">
                  <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                  {i18nService.t('addModel')}
                </button>
              )}
            </div>

            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {(activeConfig.models ?? []).map(model => (
                <div key={model.id} className="bg-surface p-2 rounded-xl border-border border transition-colors hover:border-primary group">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <div className="w-1.5 h-1.5 shrink-0 rounded-full bg-green-400" />
                      <div className="min-w-0">
                        <div className="text-foreground font-medium text-[11px] truncate">{model.name}</div>
                        <div className="text-[10px] text-secondary truncate">{model.id}</div>
                      </div>
                    </div>
                    <div className="flex items-center shrink-0 space-x-1">
                      {model.supportsImage && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">{i18nService.t('imageInput')}</span>}
                      {model.contextLength && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-raised text-secondary">{formatContextLength(model.contextLength)}</span>}
                      {model.maxTokens && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-raised text-secondary">{formatContextLength(model.maxTokens)}</span>}
                      {!isReadOnly && (
                        <>
                          <button type="button" onClick={() => handleEditModel(model.id, model.name, model.supportsImage, model.contextLength, model.maxTokens)} className="p-0.5 text-secondary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                            <PencilIcon className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={() => handleDeleteModel(model.id)} className="p-0.5 text-secondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {(!activeConfig.models || activeConfig.models.length === 0) && (
                <div className="bg-surface p-2.5 rounded-xl border border-border-subtle text-center">
                  <p className="text-[11px] text-secondary">{i18nService.t('noModelsAvailable')}</p>
                  {!isReadOnly && (
                    <button type="button" onClick={handleAddModel} className="mt-1.5 inline-flex items-center text-[11px] font-medium text-primary hover:text-primary-hover">
                      <PlusCircleIcon className="h-3 w-3 mr-1" />
                      {i18nService.t('addFirstModel')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelSettingsTab;

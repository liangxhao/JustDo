import { ArrowPathIcon, SignalIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useRef, useState } from 'react';

import {
  type AppConfig,
  defaultConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  isBuiltinModelsProvider,
  isCustomProvider,
  validateDisplayName,
} from '../../config';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../../constants/app';
import {
  decryptWithPassword,
  encryptWithPassword,
  type PasswordEncryptedPayload,
} from '../../services/encryption';
import { i18nService } from '../../services/i18n';
import PencilIcon from '../icons/PencilIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import { CustomProviderIcon } from '../icons/providers';
import TrashIcon from '../icons/TrashIcon';

type ProviderType = string;
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
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
  setProviders: React.Dispatch<React.SetStateAction<ProvidersConfig>>;
  setError: (value: string | null) => void;
  onRequestDeleteProvider: (provider: ProviderType) => void;
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
  setProviders,
  setError,
  onRequestDeleteProvider,
}) => {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const activeConfig = providers[activeProvider];
  const isReadOnly = isProviderReadOnly(activeProvider, activeConfig);
  const isBaseUrlLocked = false;
  const sortedProviders = Object.entries(providers).sort(([leftKey], [rightKey]) => {
    if (leftKey === 'builtin_models') return -1;
    if (rightKey === 'builtin_models') return 1;
    return leftKey.localeCompare(rightKey);
  });

  const handleExport = async () => {
    setError(null);
    setIsExporting(true);
    try {
      const entries = await Promise.all(
        Object.entries(providers)
          .filter(([key, config]) => !isProviderReadOnly(key, config))
          .map(async ([key, config]) => [
            key,
            {
              ...config,
              apiKey: await encryptWithPassword(config.apiKey, EXPORT_PASSWORD),
            },
          ]),
      );
      const blob = new Blob(
        [JSON.stringify({ type: EXPORT_FORMAT_TYPE, version: 2, providers: Object.fromEntries(entries) }, null, 2)],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setIsImporting(true);
    try {
      const payload = JSON.parse(await file.text()) as {
        type?: string;
        providers?: Record<string, ProviderConfig & { apiKey: PasswordEncryptedPayload | string }>;
      };
      if (payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }
      const entries = await Promise.all(
        Object.entries(payload.providers).map(async ([key, config]) => {
          const apiKey =
            typeof config.apiKey === 'string'
              ? config.apiKey
              : await decryptWithPassword(config.apiKey, EXPORT_PASSWORD);
          return [key, { ...config, apiKey }] as const;
        }),
      );
      setProviders(previous => ({ ...previous, ...Object.fromEntries(entries) }));
    } catch {
      setError(i18nService.t('importProvidersFailed'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex h-full">
      <div className="shrink-0 pr-3 space-y-1.5 overflow-y-auto" style={{ width: 260 }}>
          {/* Heading with import/export */}
          <div className="flex items-center justify-between mb-2 px-1">
            <h3 className="text-sm font-medium text-foreground">{i18nService.t('modelProviders')}</h3>
            <div className="flex items-center space-x-1">
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImport}
              />
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                disabled={isImporting || isExporting}
                className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
              >
                {i18nService.t('import')}
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={isImporting || isExporting}
                className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
              >
                {i18nService.t('export')}
              </button>
            </div>
          </div>

        {sortedProviders.map(([provider, config]) => {
          const providerKey = provider as ProviderType;
          const isCustom = isCustomProvider(provider);
          const providerInfo =
            isCustom
              ? { label: getCustomProviderDefaultName(provider), icon: <CustomProviderIcon /> }
              : undefined;
          const readOnlyProviderRow = isProviderReadOnly(providerKey, config);
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
                </div>
              </div>
              <div className="flex items-center space-x-1 shrink-0">
                {isCustom && (
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-secondary hover:text-red-500 p-0.5"
                    onClick={e => {
                      e.stopPropagation();
                      onRequestDeleteProvider(providerKey);
                    }}
                    title={i18nService.t('deleteCustomProvider')}
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </button>
                )}
                {!readOnlyProviderRow && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config.enabled}
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
                        config.enabled ? 'translate-x-[18px]' : 'translate-x-1'
                      }`}
                    />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleAddCustomProvider}
          className="w-full mt-2 px-3 py-2 text-xs font-medium rounded-xl border border-dashed border-border text-secondary hover:text-foreground hover:border-primary hover:bg-primary/5 transition-colors"
        >
          {i18nService.t('addCustomProvider')}
        </button>
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
            <div className="space-y-4">
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

              {!isBuiltinModelsProvider(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiKey`} className="block text-xs font-medium text-foreground mb-1">
                    {i18nService.t('apiKey')}
                  </label>
                  <input
                    type="password"
                    id={`${activeProvider}-apiKey`}
                    value={activeConfig.apiKey}
                    onChange={e => handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('apiKeyPlaceholder')}
                  />
                </div>
              )}
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

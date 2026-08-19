import {
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  SignalIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useRef, useState } from 'react';

import {
  type AppConfig,
  defaultConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  isBuiltinModelsProvider,
  isBuiltinProviderDisplayName,
  isCustomProvider,
  validateDisplayName,
} from '@/app/config';
import { APP_NAME, EXPORT_PASSWORD } from '@/app/constants/app';
import { hasConfirmedModelCapabilities } from '@/features/settings/modelCapabilityState';
import { getModelActionAvailability } from '@/features/settings/modelSettingsAvailability';
import {
  createProvidersExportPayload,
  mergeImportedProviders,
  parseProvidersImportPayload,
} from '@/features/settings/providerTransfer';
import { decryptWithPassword, encryptWithPassword } from '@/services/encryption';
import { i18nService } from '@/services/i18n';
import PencilIcon from '@/shared/components/icons/PencilIcon';
import PlusCircleIcon from '@/shared/components/icons/PlusCircleIcon';
import { CustomProviderIcon } from '@/shared/components/icons/providers';
import TrashIcon from '@/shared/components/icons/TrashIcon';

type ProviderType = string;
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
const formatContextLength = (tokens: number): string => {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
};

const modelToolbarButtonClassName =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary-muted/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent disabled:hover:text-foreground';

const modelBulkActionButtonClassName =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-secondary';

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
  handleDetectModels: () => void;
  handleEditModel: (
    modelId: string,
    modelName: string,
    supportsImage?: boolean,
    contextLength?: number,
    maxTokens?: number,
    capabilitiesConfirmed?: boolean,
  ) => void;
  handleDeleteModel: (modelId: string) => void;
  handleModelEnabledChange: (modelId: string, enabled: boolean) => void;
  handleSetAllModelsEnabled: (enabled: boolean) => void;
  handleTestConnection: () => void;
  handleTestModelConnection: (modelId: string) => void;
  handleRefreshBuiltinModels: () => void;
  isRefreshingBuiltinModels: boolean;
  isDetectingModels: boolean;
  modelDiscoveryMessage: string | null;
  modelConnectionTestStatuses: Record<string, 'success' | 'failed'>;
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
  handleDetectModels,
  handleEditModel,
  handleDeleteModel,
  handleModelEnabledChange,
  handleSetAllModelsEnabled,
  handleTestConnection,
  handleTestModelConnection,
  handleRefreshBuiltinModels,
  isRefreshingBuiltinModels,
  isDetectingModels,
  modelDiscoveryMessage,
  modelConnectionTestStatuses,
  displayNameError,
  setDisplayNameError,
  setProviders,
  setError,
  onRequestDeleteProvider,
}) => {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const activeConfig: ProviderConfig = providers[activeProvider] ??
    Object.values(providers)[0] ?? {
      enabled: false,
      apiKey: '',
      baseUrl: '',
      apiFormat: 'openai',
      models: [],
    };
  const isReadOnly = isProviderReadOnly(activeProvider, activeConfig);
  const isBaseUrlLocked = false;
  const hasModels = (activeConfig.models?.length ?? 0) > 0;
  const allModelsEnabled =
    hasModels && (activeConfig.models ?? []).every(model => model.enabled !== false);
  const noModelsEnabled =
    hasModels && (activeConfig.models ?? []).every(model => model.enabled === false);
  const isModelActionBusy = isTesting || isDetectingModels || isRefreshingBuiltinModels;
  const actionAvailability = getModelActionAvailability({
    requiresCredentials: providerRequiresApiKey(activeProvider),
    baseUrl: activeConfig.baseUrl,
    apiKey: activeConfig.apiKey,
    modelCount: activeConfig.models?.length ?? 0,
    busy: isModelActionBusy,
  });
  const modelActionDisabledReason = !actionAvailability.credentialsReady
    ? i18nService.t('modelActionsRequireCredentials')
    : undefined;
  const sortedProviders = Object.entries(providers).sort(([leftKey], [rightKey]) => {
    if (leftKey === 'builtin_models') return -1;
    if (rightKey === 'builtin_models') return 1;
    return leftKey.localeCompare(rightKey);
  });

  const handleExport = async () => {
    setError(null);
    setIsExporting(true);
    try {
      const exportedProviders = await Promise.all(
        Object.entries(providers)
          .filter(([key, config]) => !isProviderReadOnly(key, config))
          .map(async ([key, config]) => ({
            key,
            config,
            apiKey: await encryptWithPassword(config.apiKey, EXPORT_PASSWORD),
          })),
      );
      const blob = new Blob(
        [JSON.stringify(createProvidersExportPayload(exportedProviders), null, 2)],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_NAME}-providers-${new Date().toISOString().slice(0, 10)}.json`;
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
      const payload: unknown = JSON.parse(await file.text());
      const serializedProviders = parseProvidersImportPayload(payload);
      const entries = await Promise.all(
        serializedProviders.map(async config => {
          const apiKey =
            typeof config.apiKey === 'string'
              ? config.apiKey
              : await decryptWithPassword(config.apiKey, EXPORT_PASSWORD);
          return { ...config, apiKey };
        }),
      );
      setProviders(previous => mergeImportedProviders(previous, entries));
    } catch {
      setError(i18nService.t('importProvidersFailed'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex min-h-full">
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
              disabled={isImporting || isExporting || isModelActionBusy}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
            >
              {i18nService.t('import')}
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={isImporting || isExporting || isModelActionBusy}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
            >
              {i18nService.t('export')}
            </button>
          </div>
        </div>

        {sortedProviders.map(([provider, config]) => {
          const providerKey = provider as ProviderType;
          const isCustom = isCustomProvider(provider);
          const providerInfo = isCustom
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
                  <span className="text-foreground">
                    {isCustom ? <CustomProviderIcon /> : providerInfo?.icon}
                  </span>
                </div>
                <div className="flex flex-col min-w-0">
                  <span
                    className={`text-sm font-medium truncate ${
                      activeProvider === provider ? 'text-primary' : 'text-foreground'
                    }`}
                  >
                    {displayLabel}
                  </span>
                  {isCustom && (
                    <span className="text-[9px] leading-tight mt-0.5 text-primary">
                      {i18nService.t('customBadge')}
                    </span>
                  )}
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
          disabled={isModelActionBusy}
          className="w-full mt-2 px-3 py-2 text-xs font-medium rounded-xl border border-dashed border-border text-secondary hover:text-foreground hover:border-primary hover:bg-primary/5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18nService.t('addCustomProvider')}
        </button>
      </div>

      <div className="flex flex-1 min-w-0 flex-col pl-3 border-l border-border">
        <div className="flex flex-col gap-3">
          {!isBuiltinModelsProvider(activeProvider) && (
            <div className="flex items-start gap-3">
              <label
                htmlFor={`${activeProvider}-displayName`}
                className="shrink-0 py-1.5 text-xs font-medium text-foreground"
              >
                {i18nService.t('customDisplayName')}
              </label>
              <div className="min-w-0 flex-1">
                <input
                  type="text"
                  id={`${activeProvider}-displayName`}
                  value={(activeConfig as ProviderConfig)?.displayName ?? ''}
                  onChange={e => {
                    const value = e.target.value;
                    const validation = validateDisplayName(value);
                    const duplicateName = Object.entries(providers).some(
                      ([providerKey, providerConfig]) =>
                        providerKey !== activeProvider &&
                        isCustomProvider(providerKey) &&
                        getProviderDisplayName(providerKey, providerConfig)
                          .trim()
                          .toLocaleLowerCase() === value.trim().toLocaleLowerCase(),
                    );
                    const nameError = isBuiltinProviderDisplayName(value)
                      ? i18nService.t('providerNameConflictsBuiltin')
                      : duplicateName
                        ? i18nService.t('providerNameExists')
                        : validation.valid
                          ? undefined
                          : i18nService.t('providerNameInvalid');
                    setDisplayNameError(nameError ?? null);
                    if (validation.valid && !duplicateName) {
                      handleProviderConfigChange(activeProvider, 'displayName', value);
                    }
                  }}
                  className={`block w-full rounded-xl bg-surface-raised border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-1.5 text-xs ${displayNameError ? 'border-red-500 focus:border-red-500' : ''}`}
                  placeholder={getCustomProviderDefaultName(activeProvider)}
                />
                {displayNameError && (
                  <p className="mt-1 text-xs text-red-500">{displayNameError}</p>
                )}
              </div>
            </div>
          )}

          {!isReadOnly && (
            <div className="rounded-2xl border border-border bg-surface p-2.5">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="shrink-0 text-xs font-semibold text-foreground">
                  {i18nService.t('providerCredentials')}
                </h3>
                <span className="truncate text-[10px] text-muted">
                  {i18nService.t('providerCredentialsHint')}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label
                    htmlFor={`${activeProvider}-baseUrl`}
                    className="block text-xs font-medium text-foreground mb-1"
                  >
                    {i18nService.t('baseUrl')}
                    {isCustomProvider(activeProvider) && <span className="text-red-500"> *</span>}
                  </label>
                  <input
                    type="text"
                    id={`${activeProvider}-baseUrl`}
                    value={activeConfig.baseUrl}
                    onChange={e =>
                      handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)
                    }
                    disabled={isBaseUrlLocked || isModelActionBusy}
                    className={`block w-full rounded-xl bg-surface-raised border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-1.5 pr-8 text-xs ${isBaseUrlLocked || isModelActionBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                    placeholder={
                      getProviderDefaultBaseUrl(activeProvider) ||
                      defaultConfig.providers?.[activeProvider]?.baseUrl ||
                      i18nService.t('baseUrlPlaceholder')
                    }
                    required={isCustomProvider(activeProvider)}
                  />
                </div>

                {!isBuiltinModelsProvider(activeProvider) && (
                  <div>
                    <label
                      htmlFor={`${activeProvider}-apiKey`}
                      className="block text-xs font-medium text-foreground mb-1"
                    >
                      {i18nService.t('apiKey')}
                      {isCustomProvider(activeProvider) && <span className="text-red-500"> *</span>}
                    </label>
                    <input
                      type="password"
                      id={`${activeProvider}-apiKey`}
                      value={activeConfig.apiKey}
                      onChange={e =>
                        handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)
                      }
                      disabled={isModelActionBusy}
                      className="block w-full rounded-xl bg-surface-raised border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      placeholder={i18nService.t('apiKeyPlaceholder')}
                      required={isCustomProvider(activeProvider)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex min-h-[240px] flex-col rounded-2xl border border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex shrink-0 items-center gap-2">
                <h3 className="text-xs font-semibold text-foreground">
                  {i18nService.t('availableModels')}
                </h3>
                {hasModels && (
                  <div className="flex items-center gap-0.5 rounded-lg bg-surface-raised/70 p-0.5">
                    <button
                      type="button"
                      onClick={() => handleSetAllModelsEnabled(true)}
                      disabled={isModelActionBusy || allModelsEnabled}
                      className={modelBulkActionButtonClassName}
                    >
                      <CheckIcon className="h-3 w-3" />
                      {i18nService.t('selectAllModels')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetAllModelsEnabled(false)}
                      disabled={isModelActionBusy || noModelsEnabled}
                      className={modelBulkActionButtonClassName}
                    >
                      <XMarkIcon className="h-3 w-3" />
                      {i18nService.t('deselectAllModels')}
                    </button>
                  </div>
                )}
              </div>
              {(isBuiltinModelsProvider(activeProvider) || !isReadOnly) && (
                <div className="flex shrink-0 items-center justify-end gap-2">
                  {!isReadOnly && (
                    <>
                      <button
                        type="button"
                        onClick={handleDetectModels}
                        disabled={!actionAvailability.canManageModels}
                        title={modelActionDisabledReason}
                        className={modelToolbarButtonClassName}
                      >
                        {isDetectingModels ? (
                          <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <MagnifyingGlassIcon className="h-3.5 w-3.5" />
                        )}
                        {isDetectingModels
                          ? i18nService.t('detectingModels')
                          : i18nService.t('detectModels')}
                      </button>
                      <button
                        type="button"
                        onClick={handleAddModel}
                        disabled={!actionAvailability.canManageModels}
                        title={modelActionDisabledReason}
                        className={modelToolbarButtonClassName}
                      >
                        <PlusCircleIcon className="h-3.5 w-3.5" />
                        {i18nService.t('manualAddModel')}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={!actionAvailability.canTestConnection}
                    title={
                      !hasModels
                        ? i18nService.t('connectionTestRequiresModels')
                        : modelActionDisabledReason
                    }
                    className={`${modelToolbarButtonClassName} shrink-0`}
                  >
                    <SignalIcon className="h-3.5 w-3.5" />
                    {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
                  </button>
                  {activeProvider === 'builtin_models' && (
                    <button
                      type="button"
                      onClick={handleRefreshBuiltinModels}
                      disabled={isModelActionBusy}
                      className={modelToolbarButtonClassName}
                    >
                      <ArrowPathIcon
                        className={`h-3.5 w-3.5 ${isRefreshingBuiltinModels ? 'animate-spin' : ''}`}
                      />
                      {i18nService.t('refresh')}
                    </button>
                  )}
                </div>
              )}
            </div>

            {modelDiscoveryMessage && !isReadOnly && (
              <div className="mb-2 rounded-xl bg-primary-muted px-3 py-2 text-[11px] text-primary">
                {modelDiscoveryMessage}
              </div>
            )}

            <div className="min-h-[120px] flex-1 space-y-1.5 overflow-y-auto">
              {(activeConfig.models ?? []).map(model => {
                const capabilitiesConfirmed = isReadOnly || hasConfirmedModelCapabilities(model);
                const connectionTestStatus = modelConnectionTestStatuses[model.id];
                return (
                  <div
                    key={model.id}
                    className="bg-surface p-2 rounded-xl border-border border transition-colors hover:border-primary"
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <div className="flex w-3 shrink-0 items-center justify-center">
                          {connectionTestStatus && (
                            <div
                              className={`h-2 w-2 rounded-full ${
                                connectionTestStatus === 'success' ? 'bg-green-400' : 'bg-red-500'
                              }`}
                              title={i18nService.t(
                                connectionTestStatus === 'success'
                                  ? 'connectionSuccess'
                                  : 'connectionFailed',
                              )}
                            />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-foreground font-medium text-[11px] truncate">
                            {model.name}
                          </div>
                          <div className="text-[10px] text-secondary truncate">{model.id}</div>
                        </div>
                      </div>
                      <div className="flex items-center shrink-0 space-x-1">
                        {!isReadOnly && !capabilitiesConfirmed && (
                          <button
                            type="button"
                            onClick={() =>
                              handleEditModel(
                                model.id,
                                model.name,
                                model.supportsImage,
                                model.contextLength,
                                model.maxTokens,
                                model.capabilitiesConfirmed,
                              )
                            }
                            className="rounded-md p-0.5 text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600"
                            title={i18nService.t('modelCapabilitiesNeedConfirmation')}
                            aria-label={i18nService.t('modelCapabilitiesNeedConfirmation')}
                          >
                            <ExclamationTriangleIcon className="h-4 w-4" />
                          </button>
                        )}
                        {capabilitiesConfirmed && model.supportsImage && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                            {i18nService.t('imageInput')}
                          </span>
                        )}
                        {capabilitiesConfirmed && model.contextLength && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-raised text-secondary">
                            {i18nService.t('contextShort')}{' '}
                            {formatContextLength(model.contextLength)}
                          </span>
                        )}
                        {capabilitiesConfirmed && model.maxTokens && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-raised text-secondary">
                            {i18nService.t('outputShort')} {formatContextLength(model.maxTokens)}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleTestModelConnection(model.id)}
                          disabled={!actionAvailability.canTestConnection}
                          className="rounded-md p-0.5 text-secondary transition-colors hover:bg-primary-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          title={i18nService.t('testThisModel')}
                          aria-label={`${i18nService.t('testThisModel')}: ${model.name}`}
                        >
                          <SignalIcon className="h-3.5 w-3.5" />
                        </button>
                        {!isReadOnly && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                handleEditModel(
                                  model.id,
                                  model.name,
                                  model.supportsImage,
                                  model.contextLength,
                                  model.maxTokens,
                                  model.capabilitiesConfirmed,
                                )
                              }
                              disabled={isModelActionBusy}
                              className="rounded-md p-0.5 text-secondary transition-colors hover:bg-primary-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                              title={i18nService.t('editModel')}
                              aria-label={`${i18nService.t('editModel')}: ${model.name}`}
                            >
                              <PencilIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteModel(model.id)}
                              disabled={isModelActionBusy}
                              className="rounded-md p-0.5 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                              title={i18nService.t('deleteModel')}
                              aria-label={`${i18nService.t('deleteModel')}: ${model.name}`}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={model.enabled !== false}
                          aria-label={`${i18nService.t('includeModelInAvailableModels')}: ${model.name}`}
                          title={i18nService.t('includeModelInAvailableModels')}
                          disabled={isModelActionBusy}
                          onClick={() =>
                            handleModelEnabledChange(model.id, model.enabled === false)
                          }
                          className={`ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 ${
                            model.enabled !== false
                              ? 'border-primary text-primary hover:border-primary-hover hover:text-primary-hover'
                              : 'border-border text-transparent hover:border-secondary'
                          }`}
                        >
                          <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {(!activeConfig.models || activeConfig.models.length === 0) && (
                <div className="bg-surface p-2.5 rounded-xl border border-border-subtle text-center">
                  <p className="text-[11px] text-secondary">{i18nService.t('noModelsAvailable')}</p>
                  {!isReadOnly && (
                    <p className="mt-1 text-[10px] text-muted">
                      {actionAvailability.credentialsReady
                        ? i18nService.t('emptyModelListHint')
                        : i18nService.t('modelActionsRequireCredentials')}
                    </p>
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

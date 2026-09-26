import { normalizeModelProviderHeaders } from '@shared/providers/modelProviderHeaders';
import React, { useRef, useState } from 'react';

import { APP_NAME, EXPORT_PASSWORD } from '@/app/constants';
import {
  createProvidersExportPayload,
  type ExportedOnlineModelCategoryInput,
  mergeImportedOnlineModelProviders,
  mergeImportedProviders,
  parseModelProvidersImportPayload,
  TRANSFERRED_NON_LANGUAGE_MODEL_KINDS,
} from '@/features/settings/models/providerTransfer';
import { decryptWithPassword, encryptWithPassword } from '@/services/encryption';
import { i18nService } from '@/services/i18n';

import LanguageModelSettings, { type LanguageModelSettingsProps } from './LanguageModelSettings';
import {
  createEmptyNonLanguageModelCategory,
  type NonLanguageModelCategory,
  type NonLanguageModelProviders,
} from './nonLanguageModelConfig';
import NonLanguageModelSettings, { type NonLanguageModelKind } from './NonLanguageModelSettings';

export type ModelKind = 'language' | NonLanguageModelKind;

interface ModelSettingsTabProps {
  languageSettings: LanguageModelSettingsProps;
  nonLanguageSettings: {
    categories: NonLanguageModelProviders;
    setCategory: (
      kind: NonLanguageModelKind,
      update: React.SetStateAction<NonLanguageModelCategory>,
    ) => void;
    setCategories: React.Dispatch<React.SetStateAction<NonLanguageModelProviders>>;
  };
  activeKind: ModelKind;
  onKindChange: (kind: ModelKind) => void;
}

const ModelSettingsTab: React.FC<ModelSettingsTabProps> = ({
  languageSettings,
  nonLanguageSettings,
  activeKind,
  onKindChange,
}) => {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const isModelActionBusy =
    languageSettings.isTesting ||
    languageSettings.isDetectingModels ||
    languageSettings.isRefreshingBuiltinModels;
  const kinds: Array<{ id: ModelKind; label: string }> = [
    {
      id: 'language',
      label: i18nService.t('modelTypeLanguage'),
    },
    {
      id: 'speech-recognition',
      label: i18nService.t('modelTypeSpeechRecognition'),
    },
    {
      id: 'speech-synthesis',
      label: i18nService.t('modelTypeSpeechSynthesis'),
    },
    {
      id: 'image',
      label: i18nService.t('modelTypeImage'),
    },
    {
      id: 'video',
      label: i18nService.t('modelTypeVideo'),
    },
  ];

  const handleExport = async (): Promise<void> => {
    languageSettings.setError(null);
    setIsExporting(true);
    try {
      const exportedProviders = await Promise.all(
        Object.entries(languageSettings.providers)
          .filter(([key, config]) => !languageSettings.isProviderReadOnly(key, config))
          .map(async ([key, config]) => {
            const encryptedHeaders = Object.fromEntries(
              await Promise.all(
                Object.entries(config.headers ?? {}).map(async ([name, value]) => [
                  name,
                  await encryptWithPassword(value, EXPORT_PASSWORD),
                ]),
              ),
            );
            return {
              key,
              config: {
                ...config,
                ...(Object.keys(encryptedHeaders).length > 0
                  ? { headers: encryptedHeaders }
                  : { headers: undefined }),
              },
              apiKey: await encryptWithPassword(config.apiKey, EXPORT_PASSWORD),
            };
          }),
      );
      const onlineEntries = await Promise.all(
        TRANSFERRED_NON_LANGUAGE_MODEL_KINDS.map(async kind => {
          const category = nonLanguageSettings.categories[kind];
          if (!category) return null;
          const providers = await Promise.all(
            Object.entries(category.providers).map(async ([key, config]) => ({
              key,
              config,
              apiKey: await encryptWithPassword(config.apiKey, EXPORT_PASSWORD),
            })),
          );
          return [kind, { defaultProviderId: category.defaultProviderId, providers }] as const;
        }),
      );
      const onlineModelProviders = Object.fromEntries(
        onlineEntries.filter(entry => entry !== null),
      ) as Partial<Record<NonLanguageModelKind, ExportedOnlineModelCategoryInput>>;
      const blob = new Blob(
        [
          JSON.stringify(
            createProvidersExportPayload(exportedProviders, onlineModelProviders),
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_NAME}-models-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      languageSettings.setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    languageSettings.setError(null);
    setIsImporting(true);
    try {
      const parsed = parseModelProvidersImportPayload(JSON.parse(await file.text()));
      const providers = await Promise.all(
        parsed.providers.map(async config => {
          const headers = normalizeModelProviderHeaders(
            Object.fromEntries(
              await Promise.all(
                Object.entries(config.headers ?? {}).map(async ([name, value]) => [
                  name,
                  typeof value === 'string'
                    ? value
                    : await decryptWithPassword(value, EXPORT_PASSWORD),
                ]),
              ),
            ),
          );
          return {
            ...config,
            apiKey:
              typeof config.apiKey === 'string'
                ? config.apiKey
                : await decryptWithPassword(config.apiKey, EXPORT_PASSWORD),
            ...(Object.keys(headers).length > 0 ? { headers } : { headers: undefined }),
          };
        }),
      );
      const onlineModelProviders = Object.fromEntries(
        await Promise.all(
          TRANSFERRED_NON_LANGUAGE_MODEL_KINDS.flatMap(kind => {
            const category = parsed.onlineModelProviders[kind];
            if (!category) return [];
            return [
              Promise.all(
                category.providers.map(async config => ({
                  ...config,
                  apiKey:
                    typeof config.apiKey === 'string'
                      ? config.apiKey
                      : await decryptWithPassword(config.apiKey, EXPORT_PASSWORD),
                })),
              ).then(decryptedProviders => [kind, { ...category, providers: decryptedProviders }]),
            ];
          }),
        ),
      );
      languageSettings.setProviders(previous => mergeImportedProviders(previous, providers));
      nonLanguageSettings.setCategories(previous =>
        mergeImportedOnlineModelProviders(previous, onlineModelProviders),
      );
    } catch {
      languageSettings.setError(i18nService.t('importProvidersFailed'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 border-b border-border">
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={handleImport}
        />
        <div className="min-w-0 flex-1 overflow-x-auto" role="tablist">
          <div className="flex w-max min-w-full justify-center gap-1">
            {kinds.map(kind => (
              <button
                key={kind.id}
                type="button"
                role="tab"
                aria-selected={activeKind === kind.id}
                onClick={() => onKindChange(kind.id)}
                className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  activeKind === kind.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-secondary hover:text-foreground'
                }`}
              >
                {kind.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          disabled={isImporting || isExporting || isModelActionBusy}
          className="inline-flex h-7 shrink-0 items-center rounded-lg border border-border-input !bg-white px-2.5 text-xs font-medium text-foreground shadow-sm transition-all hover:border-foreground/25 hover:!bg-surface-raised/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:cursor-not-allowed disabled:text-muted disabled:opacity-40 dark:!bg-surface dark:hover:!bg-surface-raised/60"
        >
          {i18nService.t('import')}
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={isImporting || isExporting || isModelActionBusy}
          className="inline-flex h-7 shrink-0 items-center rounded-lg border border-border-input !bg-white px-2.5 text-xs font-medium text-foreground shadow-sm transition-all hover:border-foreground/25 hover:!bg-surface-raised/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:cursor-not-allowed disabled:text-muted disabled:opacity-40 dark:!bg-surface dark:hover:!bg-surface-raised/60"
        >
          {i18nService.t('export')}
        </button>
      </div>

      <div role="tabpanel">
        {activeKind === 'language' ? <LanguageModelSettings {...languageSettings} /> : null}
        {activeKind !== 'language' ? (
          <NonLanguageModelSettings
            key={activeKind}
            kind={activeKind}
            category={
              nonLanguageSettings.categories[activeKind] ?? createEmptyNonLanguageModelCategory()
            }
            setCategory={update => nonLanguageSettings.setCategory(activeKind, update)}
          />
        ) : null}
      </div>
    </div>
  );
};

export default ModelSettingsTab;

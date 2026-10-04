import {
  findNativeVideoProvider,
  NATIVE_VIDEO_PROVIDERS,
} from '@shared/providers/nativeVideoProviders';
import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  getNonLanguageModelCategoryValidationError,
  type NonLanguageModelCategory,
} from './nonLanguageModelConfig';

interface Props {
  category: NonLanguageModelCategory;
  setCategory: React.Dispatch<React.SetStateAction<NonLanguageModelCategory>>;
}

export const NativeVideoModelSettings: React.FC<Props> = ({ category, setCategory }) => {
  const [showKey, setShowKey] = useState(false);
  const selectedId = category.defaultProviderId;
  const selected = selectedId ? category.providers[selectedId] : undefined;
  const provider = findNativeVideoProvider(selected?.nativeVideoProvider);
  const update = (values: Partial<NonLanguageModelCategory['providers'][string]>) => {
    if (!selectedId || !selected || !provider) return;
    setCategory(current => ({
      ...current,
      providers: {
        ...current.providers,
        [selectedId]: { ...current.providers[selectedId], ...values },
      },
    }));
  };
  const select = (providerId: string) => {
    setShowKey(false);
    setCategory(current => {
      const next = findNativeVideoProvider(providerId);
      if (!next) return { ...current, defaultProviderId: undefined };
      const existingId = Object.keys(current.providers).find(
        id => current.providers[id].nativeVideoProvider === next.id,
      );
      if (existingId) return { ...current, defaultProviderId: existingId };
      let id = `native-video-${next.id}`;
      while (current.providers[id]) id += '-new';
      return {
        ...current,
        defaultProviderId: id,
        providers: {
          ...current.providers,
          [id]: {
            nativeVideoProvider: next.id,
            displayName: next.name,
            baseUrl: next.baseUrl,
            apiKey: '',
            defaultModel: next.models[0],
            models: next.models.map(model => ({ id: model, name: model })),
          },
        },
      };
    });
  };
  const inputClass =
    'mt-1 block h-9 w-full rounded-xl border border-border-input bg-white px-3 text-xs text-foreground outline-none focus:border-primary dark:bg-surface';
  const error = getNonLanguageModelCategoryValidationError('video', category);
  return (
    <div className="mx-auto max-w-[720px] space-y-4">
      <p className="text-sm text-secondary">{i18nService.t('nativeVideoProtocolHint')}</p>
      <label className="block text-sm text-foreground">
        {i18nService.t('modelProviders')}
        <select
          className={inputClass}
          value={provider?.id ?? ''}
          onChange={event => select(event.target.value)}
        >
          <option value="">{i18nService.t('nativeVideoDisabled')}</option>
          {NATIVE_VIDEO_PROVIDERS.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      {provider && selected ? (
        <>
          <label className="block text-sm text-foreground">
            {i18nService.t('nativeVideoModel')}
            <select
              className={inputClass}
              value={selected.defaultModel ?? ''}
              onChange={event => update({ defaultModel: event.target.value })}
            >
              {provider.models.map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-foreground">
            {i18nService.t('baseUrl')}
            <input
              className={inputClass}
              value={selected.baseUrl}
              spellCheck={false}
              onChange={event => update({ baseUrl: event.target.value })}
            />
          </label>
          <label className="block text-sm text-foreground">
            {i18nService.t('apiKey')}
            <input
              className={inputClass}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={selected.apiKey}
              onChange={event => update({ apiKey: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={showKey}
              onChange={event => setShowKey(event.target.checked)}
            />
            {i18nService.t('nativeVideoShowKey')}
          </label>
          <p className="text-xs text-secondary">{i18nService.t('nativeVideoCredentialsHint')}</p>
          {error ? (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

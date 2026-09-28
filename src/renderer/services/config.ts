import {
  normalizeBrowserDownloadSettings,
  normalizeBrowserSearchEngine,
} from '@shared/browser/browser';
import { ProxyMode, ProxyProtocol } from '@shared/network/proxy';
import { isLegacyCustomProviderKey } from '@shared/providers';
import { normalizeLocalSpeechSettings } from '@shared/speech/localSpeechSettings';

import { normalizeAppearanceConfig } from '@/app/appearance';
import {
  AppConfig,
  CONFIG_KEYS,
  defaultConfig,
  isBuiltinModelsProvider,
  isCustomProvider,
} from '@/app/config';
import { localStore } from '@/services/store';

const SUPPORTED_BUILTIN_PROVIDERS = new Set(['builtin_models']);
type ProviderConfig = NonNullable<AppConfig['providers']>[string];

const isSupportedProvider = (providerKey: string, providerConfig?: ProviderConfig): boolean =>
  SUPPORTED_BUILTIN_PROVIDERS.has(providerKey) ||
  isBuiltinModelsProvider(providerKey) ||
  (isCustomProvider(providerKey) &&
    !isLegacyCustomProviderKey(providerKey) &&
    typeof providerConfig?.identity === 'string');

const normalizeModelSelection = (
  model: AppConfig['model'],
  providers: AppConfig['providers'],
): { model: AppConfig['model']; reset: boolean } => {
  const providerKey = model.defaultModelProvider;
  if (!providerKey || isSupportedProvider(providerKey, providers?.[providerKey])) {
    return { model, reset: false };
  }
  return {
    model: {
      ...model,
      defaultModel: defaultConfig.model.defaultModel,
      defaultModelProvider: defaultConfig.model.defaultModelProvider,
    },
    reset: true,
  };
};

const normalizeProviderBaseUrl = (baseUrl: unknown): string => {
  if (typeof baseUrl !== 'string') {
    return '';
  }

  return baseUrl.trim().replace(/\/+$/, '');
};

const normalizeProvidersConfig = (providers: AppConfig['providers']): AppConfig['providers'] => {
  if (!providers) {
    return providers;
  }

  return Object.fromEntries(
    Object.entries(providers)
      .filter(([providerKey, providerConfig]) => isSupportedProvider(providerKey, providerConfig))
      .map(([providerKey, providerConfig]) => [
        providerKey,
        {
          ...providerConfig,
          baseUrl: normalizeProviderBaseUrl(providerConfig.baseUrl),
          apiFormat: 'openai' as const,
        },
      ]),
  ) as AppConfig['providers'];
};

const normalizeProxyConfig = (
  proxy: Partial<AppConfig['proxy']> | undefined,
): AppConfig['proxy'] => {
  const mode = Object.values(ProxyMode).includes(proxy?.mode as ProxyMode)
    ? (proxy?.mode as ProxyMode)
    : defaultConfig.proxy.mode;
  const protocol = Object.values(ProxyProtocol).includes(proxy?.custom?.protocol as ProxyProtocol)
    ? (proxy?.custom?.protocol as ProxyProtocol)
    : defaultConfig.proxy.custom.protocol;

  return {
    mode,
    custom: {
      protocol,
      host: typeof proxy?.custom?.host === 'string' ? proxy.custom.host.trim() : '',
      port: typeof proxy?.custom?.port === 'string' ? proxy.custom.port.trim() : '',
      username: typeof proxy?.custom?.username === 'string' ? proxy.custom.username.trim() : '',
      password: typeof proxy?.custom?.password === 'string' ? proxy.custom.password : '',
    },
  };
};

export class ConfigService {
  private config: AppConfig = defaultConfig;
  private updateConfigQueue: Promise<void> = Promise.resolve();
  private modelSelectionRevision = 0;
  private latestReloadRequestId = 0;

  private enqueueConfigPersistence(config: Partial<AppConfig>): void {
    const modelRevision = this.modelSelectionRevision;
    const update = this.updateConfigQueue.then(() => {
      const patch = { ...config };
      if (modelRevision !== this.modelSelectionRevision) {
        delete patch.model;
        delete patch.api;
      }
      return window.electron.store.patchAppConfig<AppConfig>(patch);
    });
    this.updateConfigQueue = update.then(
      () => undefined,
      error => {
        console.error('Failed to persist normalized config:', error);
      },
    );
  }

  async init() {
    try {
      const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (storedConfig) {
        const mergedProviders = storedConfig.providers
          ? Object.fromEntries(
              Object.entries({
                ...(defaultConfig.providers ?? {}),
                ...storedConfig.providers,
              })
                .filter(([providerKey, providerConfig]) =>
                  isSupportedProvider(providerKey, providerConfig),
                )
                .map(([providerKey, providerConfig]) => {
                  const mergedProvider = {
                    ...(defaultConfig.providers as Record<string, ProviderConfig> | undefined)?.[
                      providerKey
                    ],
                    ...providerConfig,
                  };
                  return [
                    providerKey,
                    {
                      ...mergedProvider,
                      baseUrl: normalizeProviderBaseUrl(mergedProvider.baseUrl),
                      apiFormat: 'openai' as const,
                    },
                  ];
                }),
            )
          : defaultConfig.providers;

        const normalizedModel = normalizeModelSelection(
          { ...defaultConfig.model, ...storedConfig.model },
          mergedProviders as AppConfig['providers'],
        );
        const browserDownloadSettings = normalizeBrowserDownloadSettings({
          directory: storedConfig.browserDownloadDirectory,
          askWhereToSave: storedConfig.browserAskDownloadLocation,
        });

        const mergedConfig = {
          ...defaultConfig,
          ...storedConfig,
          browserSearchEngine: normalizeBrowserSearchEngine(storedConfig.browserSearchEngine),
          browserDownloadDirectory: browserDownloadSettings.directory,
          browserAskDownloadLocation: browserDownloadSettings.askWhereToSave,
          api: {
            ...(normalizedModel.reset
              ? defaultConfig.api
              : { ...defaultConfig.api, ...storedConfig.api }),
          },
          model: normalizedModel.model,
          app: {
            ...defaultConfig.app,
            ...storedConfig.app,
          },
          proxy: normalizeProxyConfig(storedConfig.proxy),
          appearance: normalizeAppearanceConfig(storedConfig.appearance),
          voice: normalizeLocalSpeechSettings(storedConfig.voice),
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: mergedProviders as AppConfig['providers'],
        };
        this.config = mergedConfig;
        if (
          normalizedModel.reset ||
          JSON.stringify(storedConfig.providers) !== JSON.stringify(mergedProviders)
        ) {
          this.enqueueConfigPersistence({
            providers: this.config.providers,
            ...(normalizedModel.reset ? { model: this.config.model, api: this.config.api } : {}),
          });
        }
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  acceptDefaultModelSelection(modelId: string, providerKey?: string): void {
    this.modelSelectionRevision += 1;
    this.config = {
      ...this.config,
      model: {
        ...this.config.model,
        defaultModel: modelId,
        defaultModelProvider: providerKey ?? this.config.model.defaultModelProvider,
      },
    };
    window.dispatchEvent(new CustomEvent('config-updated'));
  }

  async reloadFromStore(): Promise<AppConfig> {
    const requestId = ++this.latestReloadRequestId;
    const modelRevision = this.modelSelectionRevision;
    const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
    if (!storedConfig || requestId !== this.latestReloadRequestId) {
      return this.config;
    }
    const modelChangedDuringRead = modelRevision !== this.modelSelectionRevision;

    const normalizedProviders = normalizeProvidersConfig(storedConfig.providers);
    const effectiveProviders = normalizedProviders ?? this.config.providers;
    const normalizedModel = normalizeModelSelection(
      { ...this.config.model, ...storedConfig.model },
      effectiveProviders,
    );
    const browserDownloadSettings = normalizeBrowserDownloadSettings({
      directory: storedConfig.browserDownloadDirectory,
      askWhereToSave: storedConfig.browserAskDownloadLocation,
    });
    const mergedConfig = {
      ...this.config,
      ...storedConfig,
      browserSearchEngine: normalizeBrowserSearchEngine(storedConfig.browserSearchEngine),
      browserDownloadDirectory: browserDownloadSettings.directory,
      browserAskDownloadLocation: browserDownloadSettings.askWhereToSave,
      api: {
        ...(normalizedModel.reset && !modelChangedDuringRead
          ? defaultConfig.api
          : { ...this.config.api, ...storedConfig.api }),
      },
      model: modelChangedDuringRead ? this.config.model : normalizedModel.model,
      app: {
        ...this.config.app,
        ...storedConfig.app,
      },
      proxy: normalizeProxyConfig(storedConfig.proxy),
      appearance: normalizeAppearanceConfig(storedConfig.appearance),
      voice: normalizeLocalSpeechSettings(storedConfig.voice),
      shortcuts: {
        ...this.config.shortcuts,
        ...(storedConfig.shortcuts ?? {}),
      } as AppConfig['shortcuts'],
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    };
    this.config = mergedConfig;
    this.modelSelectionRevision += 1;
    if (
      (normalizedModel.reset && !modelChangedDuringRead) ||
      JSON.stringify(storedConfig.providers) !== JSON.stringify(normalizedProviders)
    ) {
      this.enqueueConfigPersistence({
        providers: this.config.providers,
        ...(normalizedModel.reset && !modelChangedDuringRead
          ? { model: this.config.model, api: this.config.api }
          : {}),
      });
    }
    window.dispatchEvent(new CustomEvent('config-updated'));
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const update = this.updateConfigQueue.then(async () => {
      const modelRevision = this.modelSelectionRevision;
      const normalizedProviders = normalizeProvidersConfig(
        newConfig.providers as AppConfig['providers'] | undefined,
      );
      const patch = {
        ...newConfig,
        ...(newConfig.browserSearchEngine !== undefined
          ? { browserSearchEngine: normalizeBrowserSearchEngine(newConfig.browserSearchEngine) }
          : {}),
        ...(newConfig.browserDownloadDirectory !== undefined ||
        newConfig.browserAskDownloadLocation !== undefined
          ? (() => {
              const settings = normalizeBrowserDownloadSettings({
                directory:
                  newConfig.browserDownloadDirectory ?? this.config.browserDownloadDirectory,
                askWhereToSave:
                  newConfig.browserAskDownloadLocation ?? this.config.browserAskDownloadLocation,
              });
              return {
                browserDownloadDirectory: settings.directory,
                browserAskDownloadLocation: settings.askWhereToSave,
              };
            })()
          : {}),
        ...(newConfig.proxy ? { proxy: normalizeProxyConfig(newConfig.proxy) } : {}),
        ...(newConfig.appearance
          ? { appearance: normalizeAppearanceConfig(newConfig.appearance) }
          : {}),
        ...(newConfig.voice ? { voice: normalizeLocalSpeechSettings(newConfig.voice) } : {}),
        ...(normalizedProviders ? { providers: normalizedProviders } : {}),
      };
      const saved = await window.electron.store.patchAppConfig<AppConfig>(patch);
      this.config = {
        ...this.config,
        ...saved,
        // A later confirmed selection supersedes this response's snapshot.
        ...(!newConfig.model && modelRevision !== this.modelSelectionRevision
          ? { model: this.config.model }
          : {}),
      };
      this.modelSelectionRevision += 1;
      window.dispatchEvent(new CustomEvent('config-updated'));
    });
    this.updateConfigQueue = update.catch((): void => undefined);
    return update;
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService();

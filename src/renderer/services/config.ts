import { AppConfig, CONFIG_KEYS, defaultConfig, isCustomProvider } from '../config';
import { localStore } from './store';

const SUPPORTED_BUILTIN_PROVIDERS = new Set(['ollama']);

const isSupportedProvider = (providerKey: string): boolean =>
  SUPPORTED_BUILTIN_PROVIDERS.has(providerKey) || isCustomProvider(providerKey);

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
      .filter(([providerKey]) => isSupportedProvider(providerKey))
      .map(([providerKey, providerConfig]) => [
        providerKey,
        {
          ...providerConfig,
          baseUrl: normalizeProviderBaseUrl(providerConfig.baseUrl),
          apiFormat: 'openai' as const,
        },
      ])
  ) as AppConfig['providers'];
};

/**
 * Migrate legacy single `custom` provider to `custom_0`.
 */
const migrateCustomProviders = (config: AppConfig): AppConfig => {
  const providers = config.providers;
  if (!providers) return config;

  // Migrate legacy `custom` key (without underscore) to `custom_0`
  if ('custom' in providers && !isCustomProvider('custom')) {
    const legacyCustom = providers['custom'];
    if (legacyCustom) {
      const updatedProviders = { ...providers } as Record<string, any>;
      updatedProviders['custom_0'] = { ...legacyCustom };
      delete updatedProviders['custom'];
      return {
        ...config,
        providers: updatedProviders as AppConfig['providers'],
      };
    }
  }

  return config;
};

class ConfigService {
  private config: AppConfig = defaultConfig;

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
                .filter(([providerKey]) => isSupportedProvider(providerKey))
                .map(([providerKey, providerConfig]) => {
                  const mergedProvider = {
                    ...(defaultConfig.providers as Record<string, any>)?.[providerKey],
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
                })
            )
          : defaultConfig.providers;

        const migratedModel = { ...defaultConfig.model, ...storedConfig.model };
        if (
          migratedModel.defaultModelProvider &&
          !isSupportedProvider(migratedModel.defaultModelProvider)
        ) {
          migratedModel.defaultModel = defaultConfig.model.defaultModel;
          migratedModel.defaultModelProvider = defaultConfig.model.defaultModelProvider;
        }

        this.config = migrateCustomProviders({
          ...defaultConfig,
          ...storedConfig,
          api: {
            ...defaultConfig.api,
            ...storedConfig.api,
          },
          model: migratedModel,
          app: {
            ...defaultConfig.app,
            ...storedConfig.app,
          },
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: mergedProviders as AppConfig['providers'],
        });
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = normalizeProvidersConfig(newConfig.providers as AppConfig['providers'] | undefined);
    this.config = {
      ...this.config,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    };
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
    window.dispatchEvent(new CustomEvent('config-updated'));
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 

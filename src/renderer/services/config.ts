import { ProxyMode, ProxyProtocol } from '@shared/proxy';

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

const isSupportedProvider = (providerKey: string): boolean =>
  SUPPORTED_BUILTIN_PROVIDERS.has(providerKey) ||
  isBuiltinModelsProvider(providerKey) ||
  isCustomProvider(providerKey);

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
      const updatedProviders = { ...providers } as Record<string, ProviderConfig>;
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

export class ConfigService {
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
          proxy: normalizeProxyConfig(storedConfig.proxy),
          appearance: normalizeAppearanceConfig(storedConfig.appearance),
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

  async reloadFromStore(): Promise<AppConfig> {
    const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
    if (!storedConfig) {
      return this.config;
    }

    const normalizedProviders = normalizeProvidersConfig(storedConfig.providers);
    this.config = migrateCustomProviders({
      ...this.config,
      ...storedConfig,
      api: {
        ...this.config.api,
        ...storedConfig.api,
      },
      model: {
        ...this.config.model,
        ...storedConfig.model,
      },
      app: {
        ...this.config.app,
        ...storedConfig.app,
      },
      proxy: normalizeProxyConfig(storedConfig.proxy),
      appearance: normalizeAppearanceConfig(storedConfig.appearance),
      shortcuts: {
        ...this.config.shortcuts,
        ...(storedConfig.shortcuts ?? {}),
      } as AppConfig['shortcuts'],
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    });
    window.dispatchEvent(new CustomEvent('config-updated'));
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = normalizeProvidersConfig(
      newConfig.providers as AppConfig['providers'] | undefined,
    );
    this.config = {
      ...this.config,
      ...newConfig,
      ...(newConfig.proxy ? { proxy: normalizeProxyConfig(newConfig.proxy) } : {}),
      ...(newConfig.appearance
        ? { appearance: normalizeAppearanceConfig(newConfig.appearance) }
        : {}),
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

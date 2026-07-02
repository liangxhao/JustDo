import { ProviderRegistry } from '@shared/providers';

const BUILTIN_MODELS_PROVIDER_KEY = 'builtin_models';

// 配置类型定义
export interface AppConfig {
  // API 配置
  api: {
    key: string;
    baseUrl: string;
  };
  // 模型配置
  model: {
    availableModels: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
      contextLength?: number;
      maxTokens?: number;
    }>;
    defaultModel: string;
    defaultModelProvider?: string;
  };
  // 多模型提供商配置
  providers?: {
    ollama: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        contextLength?: number;
        maxTokens?: number;
      }>;
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'openai';
      displayName?: string;
      readonly?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        contextLength?: number;
        maxTokens?: number;
      }>;
    };
  };
  // 主题配置
  theme: 'light' | 'dark' | 'system';
  // 语言配置
  language: 'zh' | 'en';
  // 是否使用系统代理
  useSystemProxy: boolean;
  // 是否启用开发者模式
  developerMode: boolean;
  // 语言初始化标记 (用于判断是否是首次启动)
  language_initialized?: boolean;
  // 应用配置
  app: {
    port: number;
    isDevelopment: boolean;
    testMode?: boolean;
  };
  // 快捷键配置
  shortcuts?: {
    newChat: string;
    search: string;
    settings: string;
    sendMessage: string;
    [key: string]: string | undefined;
  };
}

const buildDefaultProviders = (): AppConfig['providers'] => {
  const providers: Record<
    string,
    {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        contextLength?: number;
        maxTokens?: number;
      }>;
    }
  > = {};

  for (const id of ProviderRegistry.providerIds) {
    const def = ProviderRegistry.get(id)!;
    providers[id] = {
      enabled: false,
      apiKey: '',
      baseUrl: def.defaultBaseUrl,
      apiFormat: def.defaultApiFormat,
      models: def.defaultModels.map(m => ({ ...m })),
    };
  }

  return providers as AppConfig['providers'];
};

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: '',
  },
  model: {
    availableModels: [],
    defaultModel: '',
    defaultModelProvider: 'ollama',
  },
  providers: buildDefaultProviders(),
  theme: 'system',
  language: 'zh',
  useSystemProxy: false,
  developerMode: false,
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
    testMode: process.env.NODE_ENV === 'development',
  },
  shortcuts: {
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
    sendMessage: 'Enter',
  },
};

// 配置存储键
export const CONFIG_KEYS = {
  APP_CONFIG: 'app_config',
  AUTH: 'auth_state',
  CONVERSATIONS: 'conversations',
  PROVIDERS_EXPORT_KEY: 'providers_export_key',
  SKILLS: 'skills',
};

export const getVisibleProviders = (_language: 'zh' | 'en'): readonly string[] => {
  // Ollama is user-configurable; builtin_models is read-only and refreshed at startup.
  // Custom providers (custom_0...custom_9) are handled separately
  return [BUILTIN_MODELS_PROVIDER_KEY, 'ollama'];
};

export const isBuiltinModelsProvider = (key: string): boolean =>
  key === BUILTIN_MODELS_PROVIDER_KEY;

/**
 * 判断 provider key 是否为自定义提供商（custom_0, custom_1, ...）
 */
export const isCustomProvider = (key: string): boolean => key.startsWith('custom_');

/**
 * 从 custom_N key 中提取默认显示名称（如 custom_0 → "Custom0"）
 */
export const getCustomProviderDefaultName = (key: string): string => {
  const suffix = key.replace('custom_', '');
  return `Custom${suffix}`;
};

/**
 * 获取 provider 的显示名称，自定义 provider 优先使用 displayName，
 * 内置 provider 使用首字母大写的 key。
 */
export const getProviderDisplayName = (
  providerKey: string,
  providerConfig?: Record<string, unknown>,
): string => {
  if (isCustomProvider(providerKey)) {
    const name =
      providerConfig && typeof providerConfig.displayName === 'string'
        ? providerConfig.displayName
        : '';
    return name || getCustomProviderDefaultName(providerKey);
  }
  if (isBuiltinModelsProvider(providerKey)) {
    const name =
      providerConfig && typeof providerConfig.displayName === 'string'
        ? providerConfig.displayName
        : '';
    return name || '内置模型';
  }
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
};

/**
 * 内置 provider 名称列表（禁止作为 displayName 使用）
 */
const BUILTIN_PROVIDER_NAMES = ['ollama', BUILTIN_MODELS_PROVIDER_KEY, '内置模型'];

/**
 * displayName 校验正则（允许字母、数字、下划线、中划线、空格）
 */
const VALID_DISPLAY_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_ -]{0,31}$/;

/**
 * 校验 displayName 是否合法
 * - 首字符必须是字母
 * - 允许字母、数字、下划线、中划线、空格
 * - 长度限制：1-32 字符
 * - 不能与内置 provider 名称冲突
 * - displayName 为空时允许，会回退到 custom_0
 */
export const validateDisplayName = (name: string): { valid: boolean; error?: string } => {
  const trimmed = name.trim();
  if (!trimmed) return { valid: true }; // 空 name 允许，回退到 custom_0
  if (!VALID_DISPLAY_NAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Must start with letter, only letters/numbers/_/-/space allowed',
    };
  }
  if (BUILTIN_PROVIDER_NAMES.includes(trimmed.toLowerCase())) {
    return { valid: false, error: 'Cannot use built-in provider name' };
  }
  return { valid: true };
};

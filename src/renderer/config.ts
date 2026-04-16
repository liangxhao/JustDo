import { ProviderRegistry } from '@shared/providers';

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
    }>;
    defaultModel: string;
    defaultModelProvider?: string;
  };
  // 多模型提供商配置
  providers?: {
    openai: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API 协议格式：anthropic 为 Anthropic 兼容，openai 为 OpenAI 兼容
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    deepseek: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    moonshot: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 Moonshot Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    zhipu: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 GLM Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    minimax: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** OAuth auth type: 'apikey' (default) or 'oauth' (MiniMax Portal OAuth) */
      authType?: 'apikey' | 'oauth';
      /** OAuth refresh token for automatic token renewal */
      oauthRefreshToken?: string;
      /** OAuth token expiry as Unix timestamp in milliseconds */
      oauthTokenExpiresAt?: number;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    youdaozhiyun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    qwen: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 Qwen Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      /** OAuth 凭据 */
      oauthCredentials?: {
        access: string;
        refresh: string;
        expires: number;
        resourceUrl?: string;
      };
      /** OAuth 专用 Base URL（与 API Key 的 baseUrl 独立） */
      oauthBaseUrl?: string;
      /** 是否使用OAuth方式而非API Key */
      useOAuth?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    openrouter: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    gemini: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    anthropic: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    volcengine: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 Volcengine Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    xiaomi: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    stepfun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    'github-copilot': {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    ollama: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    custom: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      codingPlanEnabled?: boolean;
      oauthCredentials?: {
        access: string;
        refresh: string;
        expires: number;
        resourceUrl?: string;
      };
      oauthBaseUrl?: string;
      useOAuth?: boolean;
      authType?: 'apikey' | 'oauth';
      oauthRefreshToken?: string;
      oauthTokenExpiresAt?: number;
      displayName?: string;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
  };
  // 主题配置
  theme: 'light' | 'dark' | 'system';
  // 语言配置
  language: 'zh' | 'en';
  // 是否使用系统代理
  useSystemProxy: boolean;
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
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      codingPlanEnabled?: boolean;
      models?: Array<{ id: string; name: string; supportsImage?: boolean }>;
    }
  > = {};

  for (const id of ProviderRegistry.providerIds) {
    const def = ProviderRegistry.get(id)!;
    providers[id] = {
      enabled: false,
      apiKey: '',
      baseUrl: def.defaultBaseUrl,
      apiFormat: def.defaultApiFormat,
      ...(def.codingPlanSupported ? { codingPlanEnabled: false } : {}),
      models: def.defaultModels.map(m => ({ ...m })),
    };
  }

  return providers as AppConfig['providers'];
};

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  model: {
    availableModels: [{ id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', supportsImage: true }],
    defaultModel: 'qwen3.6-plus',
    defaultModelProvider: 'qwen',
  },
  providers: buildDefaultProviders(),
  theme: 'system',
  language: 'zh',
  useSystemProxy: false,
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
    testMode: process.env.NODE_ENV === 'development',
  },
  shortcuts: {
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
    sendMessage: 'Ctrl+Enter',
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

// Provider lists derived from ProviderRegistry — single source of truth
export const CHINA_PROVIDERS = [...ProviderRegistry.idsByRegion('china')] as const;
export const GLOBAL_PROVIDERS = ProviderRegistry.idsByRegion('global');

export const getVisibleProviders = (_language: 'zh' | 'en'): readonly string[] => {
  // Only Ollama is visible as built-in provider
  // Custom providers (custom_0...custom_9) are handled separately
  return ['ollama'];
};

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
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
};

/**
 * 内置 provider 名称列表（禁止作为 displayName 使用）
 */
const BUILTIN_PROVIDER_NAMES = ['ollama', 'openai', 'anthropic', 'qwen', 'deepseek', 'gemini', 'minimax'];

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
    return { valid: false, error: 'Must start with letter, only letters/numbers/_/-/space allowed' };
  }
  if (BUILTIN_PROVIDER_NAMES.includes(trimmed.toLowerCase())) {
    return { valid: false, error: 'Cannot use built-in provider name' };
  }
  return { valid: true };
};

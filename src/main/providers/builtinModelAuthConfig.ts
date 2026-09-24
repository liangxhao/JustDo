import { BUILTIN_MODEL_AUTH_CONFIG, type BuiltinModelAuthConfig } from '../../config/builtinModelAuth';

export const validateBuiltinModelAuthConfig = (value: unknown): BuiltinModelAuthConfig => {
  try {
    const config = value as BuiltinModelAuthConfig | null;
    if (typeof config?.tokenExchangeUrl !== 'string' ||
      !['jwt', 'api-key'].includes(config.developmentAuthMode) ||
      typeof config.developmentApiKey !== 'string' ||
      config.developmentApiKey.length > 8_192 ||
      /[\u0000-\u001f\u007f]/.test(config.developmentApiKey) ||
      !Number.isInteger(config.maxJwtLifetimeSeconds) ||
      config.maxJwtLifetimeSeconds < 30 || config.maxJwtLifetimeSeconds > 10_800) throw new Error();
    const tokenExchangeUrl = config.tokenExchangeUrl.trim();
    if (tokenExchangeUrl) {
      const url = new URL(tokenExchangeUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    }
    return {
      tokenExchangeUrl,
      maxJwtLifetimeSeconds: config.maxJwtLifetimeSeconds,
      developmentAuthMode: config.developmentAuthMode,
      developmentApiKey: config.developmentApiKey.trim(),
    };
  } catch {
    throw new Error('Invalid model authentication configuration.');
  }
};

export const getBuiltinModelAuthConfig = (): BuiltinModelAuthConfig =>
  validateBuiltinModelAuthConfig(BUILTIN_MODEL_AUTH_CONFIG);

export const resolveBuiltinModelDevelopmentApiKey = (
  config: BuiltinModelAuthConfig,
  isPackaged: boolean,
): string => {
  if (isPackaged || config.developmentAuthMode !== 'api-key') return '';
  if (!config.developmentApiKey) {
    throw new Error('Development API Key mode requires a non-empty key.');
  }
  return config.developmentApiKey;
};

import fs from 'node:fs';

import { BUILTIN_MODEL_AUTH_CONFIG, type BuiltinModelAuthConfig } from '../../config/builtinModelAuth';

export const validateBuiltinModelAuthConfig = (value: unknown): BuiltinModelAuthConfig => {
  try {
    const config = value as BuiltinModelAuthConfig | null;
    if (typeof config?.tokenExchangeUrl !== 'string' ||
      !['jwt', 'api-key'].includes(config.developmentAuthMode) ||
      typeof config.developmentApiKey !== 'string' ||
      (config.developmentApiKeyFile !== undefined && typeof config.developmentApiKeyFile !== 'string') ||
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
      ...(config.developmentApiKeyFile !== undefined ? { developmentApiKeyFile: config.developmentApiKeyFile.trim() } : {}),
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
  if (!config.developmentApiKey && config.developmentApiKeyFile) {
    try {
      if (fs.statSync(config.developmentApiKeyFile).size > 8_192) throw new Error();
      const key = fs.readFileSync(config.developmentApiKeyFile, 'utf8').trim();
      if (!key || /[\u0000-\u001f\u007f]/.test(key)) throw new Error();
      return key;
    } catch {
      throw new Error('Unable to read development API Key file.');
    }
  }
  if (!config.developmentApiKey) {
    throw new Error('Development API Key mode requires a non-empty key.');
  }
  return config.developmentApiKey;
};

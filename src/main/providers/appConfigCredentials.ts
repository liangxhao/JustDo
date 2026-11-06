const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Keep builtin credentials out of product settings without changing user-owned credentials. */
export function transformAppConfigCredentials(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const config = structuredClone(value);
  const builtin = isRecord(config.providers) ? config.providers.builtin_models : undefined;
  if (isRecord(builtin)) {
    const previousKey = builtin.apiKey;
    if (isRecord(config.api) && typeof previousKey === 'string' && previousKey && config.api.key === previousKey) {
      config.api.key = '';
    }
    builtin.apiKey = '';
  }
  if (
    isRecord(config.api) &&
    isRecord(config.model) &&
    config.model.defaultModelProvider === 'builtin_models'
  ) {
    config.api.key = '';
  }
  return config;
}

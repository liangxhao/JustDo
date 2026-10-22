import { isRecord, sortJsonValue } from './openclawConfigBuilders';

const withoutModelDefaults = (config: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(config.agents)) return config;
  const withoutModel = (value: unknown): unknown =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'model'))
      : value;
  return {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([key, value]) => [
        key,
        key === 'defaults'
          ? withoutModel(value)
          : key === 'entries' && isRecord(value)
            ? Object.fromEntries(Object.entries(value).map(([id, entry]) => [id, withoutModel(entry)]))
            : value,
      ]),
    ),
  };
};

/** Route, permission, plugin and agent membership changes still require reconciliation. */
export const hasOnlyModelDefaultChanges = (
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): boolean =>
  previous !== null &&
  JSON.stringify(sortJsonValue(withoutModelDefaults(previous))) ===
    JSON.stringify(sortJsonValue(withoutModelDefaults(next)));

import { isRecord, sortJsonValue } from '../openclawConfigBuilders';

export const ModelDefaultsSyncReason = {
  Selection: 'default-model-change',
  Rollback: 'default-model-change-rollback',
} as const;

export const isModelDefaultsSyncReason = (reason: string): boolean =>
  Object.values(ModelDefaultsSyncReason).some(value => value === reason);

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

const primaryModel = (value: unknown): unknown => isRecord(value) ? value.primary : value;
const withPrimaryModel = (value: unknown, primary: string): unknown =>
  isRecord(value) ? { ...value, primary } : typeof value === 'string' ? primary : { primary };

/** A default selection never publishes catalog, permission, credential or roster changes. */
export function projectModelDefaults(
  current: Record<string, unknown>,
  primary: string,
  agentModels: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const agents = current.agents;
  if (!isRecord(agents) || !isRecord(agents.defaults) || !isRecord(agents.entries))
    throw new Error('The existing native agent configuration is unavailable.');
  const providers = isRecord(current.models) && isRecord(current.models.providers)
    ? current.models.providers : {};
  for (const model of new Set([primary, ...Object.values(agentModels)])) {
    const slash = model.indexOf('/');
    const provider = providers[model.slice(0, slash)];
    if (slash <= 0 || !isRecord(provider) || !Array.isArray(provider.models) ||
        !provider.models.some(entry => isRecord(entry) && entry.id === model.slice(slash + 1)))
      throw new Error('The selected model is not present in the active native catalog.');
  }
  for (const id of Object.keys(agentModels)) {
    if (!isRecord(agents.entries[id])) throw new Error('The native agent roster has changed.');
  }
  const next = {
    ...current,
    agents: {
      ...agents,
      defaults: { ...agents.defaults, model: withPrimaryModel(agents.defaults.model, primary) },
      entries: Object.fromEntries(Object.entries(agents.entries).map(([id, entry]) => [
        id,
        isRecord(entry) && Object.hasOwn(agentModels, id)
          ? { ...entry, model: withPrimaryModel(entry.model, agentModels[id]) } : entry,
      ])),
    },
  };
  if (!hasOnlyModelDefaultChanges(current, next)) throw new Error('Model selection changed unrelated configuration.');
  return next;
}

export function matchesProjectedModelDefaults(expected: Record<string, unknown>, actual: unknown): boolean {
  if (!isRecord(expected.agents) || !isRecord(actual) || !isRecord(actual.agents)) return false;
  const previous = expected.agents;
  const current = actual.agents;
  if (!isRecord(previous.defaults) || !isRecord(current.defaults) ||
      primaryModel(previous.defaults.model) !== primaryModel(current.defaults.model) ||
      !isRecord(previous.entries) || !isRecord(current.entries)) return false;
  const entries = current.entries;
  return Object.entries(previous.entries).every(([id, entry]) => {
    const next = entries[id];
    return isRecord(entry) && isRecord(next) && primaryModel(entry.model) === primaryModel(next.model);
  });
}

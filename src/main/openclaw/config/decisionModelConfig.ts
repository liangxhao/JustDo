import { saveExtensionSecrets } from '../../plugins/extensions/extensionSecretFile';

type DecisionSelection = { baseUrl: string; apiKey: string; model: string } | null | undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Validate persisted/IPC input too; renderer validation is only a usability aid. */
export function resolveDecisionModelSelection(value: unknown): DecisionSelection {
  if (value === undefined) return undefined;
  const category = record(value);
  const providers = record(category.providers);
  if (!('providers' in category)) throw new Error('Invalid decision model providers.');
  if (Object.keys(providers).length === 0) return null;
  const selected = category.defaultProviderId;
  if (typeof selected !== 'string' || !Object.hasOwn(providers, selected)) {
    throw new Error('Select a default decision model provider.');
  }
  let result: DecisionSelection;
  for (const [id, entry] of Object.entries(providers)) {
    const provider = record(entry);
    const { baseUrl, apiKey, defaultModel, models } = provider;
    if (
      typeof baseUrl !== 'string' ||
      !baseUrl.trim() ||
      baseUrl.length > 2048 ||
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      apiKey.length > 16384 ||
      /[\r\n]/.test(apiKey) ||
      typeof defaultModel !== 'string' ||
      !/^[a-zA-Z0-9._/-]{1,128}$/.test(defaultModel) ||
      !Array.isArray(models) ||
      !models.some(model => record(model).id === defaultModel)
    ) {
      throw new Error('Decision providers require a URL, API Key and valid default model.');
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new Error('Invalid decision provider URL.');
    }
    if (id === selected)
      result = {
        baseUrl: url.toString().replace(/\/+$/, ''),
        apiKey: apiKey.trim(),
        model: defaultModel,
      };
  }
  return result;
}

/** Keep OpenClaw as the decision runtime; settings own endpoint and default selection. */
export function applyDecisionModelConfiguration(
  config: Record<string, unknown>,
  selection: DecisionSelection,
  stateDir: string,
): boolean {
  if (selection === undefined) return false;
  const plugins = record(config.plugins);
  const entries = record(plugins.entries);
  const entry = record(entries.typesafe);
  const agents = record(config.agents);
  const defaults = { ...record(agents.defaults) };
  let secretsChanged = false;
  let pluginConfig = { ...record(entry.config) };
  delete pluginConfig.baseUrl;
  delete pluginConfig.serviceUrl;
  delete pluginConfig.apiKey;
  delete pluginConfig.model;
  if (selection) {
    const secrets = saveExtensionSecrets(config, stateDir, 'typesafe', {
      'decisionModel.apiKey': selection.apiKey,
    });
    secretsChanged = secrets.changed;
    pluginConfig = {
      ...pluginConfig,
      serviceUrl: selection.baseUrl,
      apiKey: secrets.references['decisionModel.apiKey'],
    };
    defaults.decisionModel = `typesafe/${selection.model}`;
  } else if (
    typeof defaults.decisionModel === 'string' &&
    defaults.decisionModel.startsWith('typesafe/')
  ) {
    delete defaults.decisionModel;
  }
  config.plugins = {
    ...plugins,
    entries: {
      ...entries,
      typesafe: { ...entry, enabled: Boolean(selection), config: pluginConfig },
    },
  };
  config.agents = { ...agents, defaults };
  return secretsChanged;
}

/** Preserve a pre-existing optional-extension setup if its first settings save rolls back. */
export function captureDecisionModelConfiguration(
  config: Record<string, unknown>,
): (target: Record<string, unknown>) => void {
  const entry = structuredClone(record(record(config.plugins).entries).typesafe);
  const decisionModel = record(record(config.agents).defaults).decisionModel;
  return target => {
    const plugins = record(target.plugins);
    const entries = { ...record(plugins.entries) };
    if (entry === undefined) delete entries.typesafe;
    else entries.typesafe = structuredClone(entry);
    target.plugins = { ...plugins, entries };
    const agents = record(target.agents);
    const defaults = { ...record(agents.defaults) };
    if (decisionModel === undefined) delete defaults.decisionModel;
    else defaults.decisionModel = decisionModel;
    target.agents = { ...agents, defaults };
  };
}

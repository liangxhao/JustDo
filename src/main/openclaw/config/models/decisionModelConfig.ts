import { createHash } from 'node:crypto';

import { saveExtensionSecrets } from '../../../plugins/extensions/extensionSecretFile';

type DecisionSelection = { baseUrl: string; apiKey: string; model: string } | null | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** Validate persisted/IPC input too; renderer validation is only a usability aid. */
export function resolveDecisionModelSelection(value: unknown): DecisionSelection {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.providers)) {
    throw new Error('Invalid decision model providers.');
  }
  const category = value;
  const providers = value.providers;
  const selected = category.defaultProviderId;
  if (
    (selected !== undefined && typeof selected !== 'string') ||
    (typeof selected === 'string' && selected.length > 0 && !Object.hasOwn(providers, selected))
  ) {
    throw new Error('Select a default decision model provider.');
  }
  // Saved provider details remain validated when their category is explicitly off.
  let result: DecisionSelection = null;
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
    if (selected && id === selected)
      result = {
        baseUrl: url.toString().replace(/\/+$/, ''),
        apiKey: apiKey.trim(),
        model: defaultModel,
      };
  }
  return result;
}

/** A saved catalog does not own the extension until it has a valid default selection. */
export function isDecisionModelManaged(value: unknown): boolean {
  try {
    return Boolean(resolveDecisionModelSelection(value));
  } catch {
    return false;
  }
}

/** Release only the exact default previously projected by this synchronizer. */
export function releaseDecisionModelDefault(
  config: Record<string, unknown>,
  previousSelection: DecisionSelection,
): void {
  if (!previousSelection) return;
  const defaults = record(record(config.agents).defaults);
  if (defaults.decisionModel === `typesafe/${previousSelection.model}`) {
    delete defaults.decisionModel;
  }
}

/** Keep OpenClaw as the decision runtime; settings own endpoint and default selection. */
export function applyDecisionModelConfiguration(
  config: Record<string, unknown>,
  selection: DecisionSelection,
  stateDir: string,
): boolean {
  if (!selection) return false;
  const plugins = record(config.plugins);
  const entries = record(plugins.entries);
  const entry = record(entries.typesafe);
  const agents = record(config.agents);
  const defaults = { ...record(agents.defaults) };
  let pluginConfig = { ...record(entry.config) };
  delete pluginConfig.baseUrl;
  delete pluginConfig.serviceUrl;
  delete pluginConfig.apiKey;
  delete pluginConfig.model;
  // A released extension may still reference a previous selection's credential.
  // A later failed takeover must not overwrite what that manual reference resolves to.
  const credentialScope = createHash('sha256')
    .update(JSON.stringify([selection.baseUrl, selection.apiKey]))
    .digest('hex');
  const credentialSlot = `decisionModel.${credentialScope}.apiKey`;
  const secrets = saveExtensionSecrets(config, stateDir, 'typesafe', {
    [credentialSlot]: selection.apiKey,
  });
  pluginConfig = {
    ...pluginConfig,
    serviceUrl: selection.baseUrl,
    apiKey: secrets.references[credentialSlot],
  };
  defaults.decisionModel = `typesafe/${selection.model}`;
  config.plugins = {
    ...plugins,
    entries: {
      ...entries,
      typesafe: { ...entry, enabled: true, config: pluginConfig },
    },
  };
  config.agents = { ...agents, defaults };
  return secrets.changed;
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

import { OpenAiCompatibleMediaConfigProviderIds } from '../../../shared/providers/mediaGenerationModels';
import {
  findNativeVideoProvider,
  isNativeVideoModelSupported,
  NATIVE_VIDEO_PROVIDERS,
  type NativeVideoProviderId,
} from '../../../shared/providers/nativeVideoProviders';
import { t } from '../../core/i18n';
import { saveExtensionSecrets } from '../../plugins/extensions/extensionSecretFile';

type Selection =
  | { providerId: NativeVideoProviderId; baseUrl: string; apiKey: string; model: string }
  | null
  | undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

/** Only supported native providers participate in managed video configuration. */
export function resolveNativeVideoSelection(value: unknown): Selection {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isRecord(value.providers) ||
    (value.defaultProviderId !== undefined && typeof value.defaultProviderId !== 'string')
  )
    throw new Error(t('nativeVideoConfigurationInvalid'));
  const category = record(value);
  const providers = record(category.providers);
  const nativeEntries = Object.values(providers);
  // An explicit empty category clears the selection after deleting the last provider.
  if (!nativeEntries.length) {
    if (category.defaultProviderId) throw new Error(t('nativeVideoConfigurationInvalid'));
    return null;
  }
  for (const entry of nativeEntries) {
    if (!findNativeVideoProvider(record(entry).nativeVideoProvider))
      throw new Error(t('nativeVideoConfigurationInvalid'));
  }
  const selected =
    typeof category.defaultProviderId === 'string'
      ? record(providers[category.defaultProviderId])
      : {};
  if (category.defaultProviderId && selected.nativeVideoProvider === undefined)
    throw new Error(t('nativeVideoConfigurationInvalid'));
  if (selected.nativeVideoProvider === undefined) return null;
  const provider = findNativeVideoProvider(selected.nativeVideoProvider);
  if (
    !provider ||
    !isNativeVideoModelSupported(provider, selected.defaultModel) ||
    typeof selected.apiKey !== 'string' ||
    (provider.apiKeyRequired && !selected.apiKey.trim()) ||
    selected.apiKey.length > 16384 ||
    /[\r\n]/.test(selected.apiKey)
  ) {
    throw new Error(t('nativeVideoConfigurationInvalid'));
  }
  if (typeof selected.baseUrl !== 'string' || selected.baseUrl.length > 2048)
    throw new Error(t('nativeVideoUrlInvalid'));
  let url: URL;
  try {
    url = new URL(selected.baseUrl);
  } catch {
    throw new Error(t('nativeVideoUrlInvalid'));
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(t('nativeVideoUrlInvalid'));
  if (provider.customModel) {
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/videos$/i, '') || '/';
  }
  return {
    providerId: provider.id,
    model: selected.defaultModel,
    apiKey: selected.apiKey.trim(),
    baseUrl: url.toString().replace(/\/+$/, ''),
  };
}

export function applyNativeVideoConfiguration(
  config: Record<string, unknown>,
  selection: Selection,
  stateDir: string,
  availableExtensionIds: readonly string[] | null,
): boolean {
  // An incomplete inventory cannot establish absence or admit a new provider,
  // but explicit Settings clears must still disable the existing managed adapter.
  const inventoryComplete = availableExtensionIds !== null;
  const unavailable = new Set<string>(
    NATIVE_VIDEO_PROVIDERS.filter(
      provider => availableExtensionIds !== null && !availableExtensionIds.includes(provider.id),
    ).map(provider => provider.id),
  );
  const isUnavailableModel = (model: unknown) =>
    typeof model === 'string' && [...unavailable].some(id => model.startsWith(`${id}/`));
  const agents = record(config.agents);
  const defaults = record(agents.defaults);
  const mediaModels = { ...record(defaults.mediaModels) };
  const video = record(mediaModels.video);
  const fallbacks = Array.isArray(video.fallbacks)
    ? video.fallbacks.filter(id => !isUnavailableModel(id))
    : [];
  if (isUnavailableModel(typeof mediaModels.video === 'string' ? mediaModels.video : video.primary)) {
    if (fallbacks.length) {
      mediaModels.video = { ...video, primary: fallbacks[0], fallbacks: fallbacks.slice(1) };
    } else {
      delete mediaModels.video;
    }
    config.agents = { ...agents, defaults: { ...defaults, mediaModels } };
  } else if (Array.isArray(video.fallbacks) && video.fallbacks.some(isUnavailableModel)) {
    mediaModels.video = { ...video, fallbacks };
    config.agents = { ...agents, defaults: { ...defaults, mediaModels } };
  }
  const currentPlugins = record(config.plugins);
  const currentEntries = record(currentPlugins.entries);
  if (Object.keys(currentEntries).some(id => unavailable.has(id))) {
    currentPlugins.entries = Object.fromEntries(
      Object.entries(currentEntries).filter(([id]) => !unavailable.has(id)),
    );
  }
  for (const field of ['allow', 'deny'] as const) {
    const ids = currentPlugins[field];
    if (Array.isArray(ids)) currentPlugins[field] = ids.filter(id => !unavailable.has(id));
  }
  // The application-owned adapter has no preset model; Settings owns its enablement.
  const adapterId = OpenAiCompatibleMediaConfigProviderIds.video;
  if (
    !unavailable.has(adapterId) &&
    (inventoryComplete ||
      (selection?.providerId !== adapterId && isRecord(currentEntries[adapterId])))
  ) {
    const plugins = record(config.plugins);
    const entries = record(plugins.entries);
    config.plugins = {
      ...plugins,
      entries: {
        ...entries,
        [adapterId]: {
          ...record(entries[adapterId]),
          enabled: selection?.providerId === adapterId,
        },
      },
    };
  }
  if (selection && (!inventoryComplete || unavailable.has(selection.providerId))) return false;
  if (!selection) {
    const primary =
      typeof mediaModels.video === 'string' ? mediaModels.video : record(mediaModels.video).primary;
    const clearsVideo =
      typeof primary === 'string' &&
      (selection === null
        ? NATIVE_VIDEO_PROVIDERS.some(provider => primary.startsWith(`${provider.id}/`))
        : primary.startsWith(`${adapterId}/`));
    if (clearsVideo) delete mediaModels.video;
    if (clearsVideo || selection === null) {
      config.agents = { ...agents, defaults: { ...defaults, mediaModels } };
    }
    return false;
  }
  const secrets = selection.apiKey
    ? saveExtensionSecrets(config, stateDir, selection.providerId, {
        'nativeVideo.apiKey': selection.apiKey,
      })
    : { references: {} as Record<string, Record<string, string>>, changed: false };
  const models = record(config.models);
  const providers = record(models.providers);
  const existing = record(providers[selection.providerId]);
  config.models = {
    ...models,
    providers: {
      ...providers,
      [selection.providerId]: {
        ...existing,
        api: existing.api ?? 'openai-completions',
        models: existing.models ?? [],
        baseUrl: selection.baseUrl,
        apiKey: secrets.references['nativeVideo.apiKey'],
        ...(findNativeVideoProvider(selection.providerId)?.customModel
          ? { request: { ...record(existing.request), allowPrivateNetwork: true } }
          : {}),
      },
    },
  };
  config.agents = {
    ...agents,
    defaults: {
      ...defaults,
      mediaModels: {
        ...mediaModels,
        video: { primary: `${selection.providerId}/${selection.model}`, fallbacks: [] },
      },
    },
  };
  const plugins = record(config.plugins);
  const entries = record(plugins.entries);
  config.plugins = {
    ...plugins,
    ...(Array.isArray(plugins.allow)
      ? { allow: [...new Set([...plugins.allow, selection.providerId])] }
      : {}),
    ...(Array.isArray(plugins.deny)
      ? { deny: plugins.deny.filter(id => id !== selection.providerId) }
      : {}),
    entries: {
      ...entries,
      [selection.providerId]: { ...record(entries[selection.providerId]), enabled: true },
    },
  };
  return secrets.changed;
}

/** Restore the unmanaged native selection when an initial Settings save is rolled back. */
export function captureNativeVideoConfiguration(
  config: Record<string, unknown>,
): (target: Record<string, unknown>) => void {
  const saved = structuredClone(config);
  return target => {
    const agents = record(target.agents);
    const defaults = record(agents.defaults);
    const mediaModels = { ...record(defaults.mediaModels) };
    const previous = record(record(record(saved.agents).defaults).mediaModels).video;
    if (previous === undefined) delete mediaModels.video;
    else mediaModels.video = structuredClone(previous);
    target.agents = { ...agents, defaults: { ...defaults, mediaModels } };
    for (const section of ['models', 'plugins'] as const) {
      const field = section === 'models' ? 'providers' : 'entries';
      const current = record(target[section]);
      const children = { ...record(current[field]) };
      const old = record(record(saved[section])[field]);
      for (const provider of NATIVE_VIDEO_PROVIDERS) {
        if (old[provider.id] === undefined) delete children[provider.id];
        else children[provider.id] = structuredClone(old[provider.id]);
      }
      target[section] = { ...current, [field]: children };
    }
    const plugins = record(target.plugins);
    const originalPlugins = record(saved.plugins);
    const isNative = (id: unknown) => Boolean(findNativeVideoProvider(id));
    for (const field of ['allow', 'deny'] as const) {
      const current = plugins[field];
      const original = originalPlugins[field];
      if (!Array.isArray(current) && !Array.isArray(original)) continue;
      const retained = Array.isArray(current) ? current.filter(id => !isNative(id)) : [];
      if (Array.isArray(original)) plugins[field] = [...retained, ...original.filter(isNative)];
      else if (retained.length) plugins[field] = retained;
      else delete plugins[field];
    }
  };
}

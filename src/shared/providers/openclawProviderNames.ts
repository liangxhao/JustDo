/**
 * Provider IDs owned by JustDo's OpenClaw configuration. OpenClaw's built-in
 * and plugin provider IDs are intentionally not reserved: an explicit
 * `models.providers.<id>` entry is a supported route override, and blocking
 * those IDs prevents users from giving a custom endpoint its natural name.
 */
export const JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS = ['builtin_models', 'justdo'] as const;

const RESERVED_PROVIDER_IDS = new Set<string>(JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS);
const RESERVED_NUMBERED_PROVIDER_NAME_PATTERN = /^custom_\d+$/i;
const VALID_CUSTOM_PROVIDER_DISPLAY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_. -]{0,31}$/;

export type CustomProviderDisplayNameValidation =
  { valid: true } | { valid: false; reason: 'reserved' | 'format' };

export const normalizeOpenClawProviderId = (name: string): string => name.trim().toLowerCase();

export const isReservedOpenClawProviderId = (name: string): boolean => {
  const normalized = normalizeOpenClawProviderId(name);
  return RESERVED_PROVIDER_IDS.has(normalized) || RESERVED_NUMBERED_PROVIDER_NAME_PATTERN.test(normalized);
};

export const isJustDoCustomProviderKey = (providerKey: string): boolean =>
  !!providerKey && providerKey !== 'builtin_models';

export const getDefaultCustomProviderDisplayName = (providerKey: string): string => providerKey;

export const getEffectiveCustomProviderDisplayName = (
  providerKey: string,
  displayName?: unknown,
): string =>
  (typeof displayName === 'string' ? displayName.trim() : '') ||
  getDefaultCustomProviderDisplayName(providerKey);

type CustomProviderConfigLike = {
  displayName?: unknown;
  identity?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasConfiguredProviderModel = (value: unknown, respectEnabled: boolean): boolean =>
  Array.isArray(value) &&
  value.some(
    model =>
      isRecord(model) &&
      (!respectEnabled || model.enabled !== false) &&
      typeof model.id === 'string' &&
      model.id.trim().length > 0,
  );

/**
 * Resolve the provider ids that JustDo will publish to OpenClaw from an app
 * config provider map. This intentionally mirrors the eligibility floor used
 * by providerApiConfig without returning or logging credential values.
 */
export const listConfiguredOpenClawProviderIds = (providers: unknown): string[] => {
  if (!isRecord(providers)) return [];

  const ids = new Set<string>();
  for (const [providerKey, value] of Object.entries(providers)) {
    if (!isRecord(value) || value.enabled !== true) continue;
    if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) continue;
    if (
      providerKey !== 'builtin_models' &&
      (typeof value.apiKey !== 'string' || !value.apiKey.trim())
    ) {
      continue;
    }
    if (
      !hasConfiguredProviderModel(value.models, true) &&
      !hasConfiguredProviderModel(value.embeddingModels, false)
    ) {
      continue;
    }

    const providerId = isJustDoCustomProviderKey(providerKey)
      ? normalizeOpenClawProviderId(
          getEffectiveCustomProviderDisplayName(providerKey, value.displayName),
        )
      : normalizeOpenClawProviderId(providerKey);
    if (providerId) ids.add(providerId);
  }
  return [...ids].sort();
};

export const listRetiredOpenClawProviderIds = (
  previousProviders: unknown,
  nextProviders: unknown,
): string[] => {
  const nextIds = new Set(listConfiguredOpenClawProviderIds(nextProviders));
  return listConfiguredOpenClawProviderIds(previousProviders).filter(id => !nextIds.has(id));
};

/**
 * Build wire-provider rename aliases by matching the stable internal provider
 * key in the previous and next app config. This only covers renames made by
 * the current settings flow; it is not a legacy-format migration.
 */
export const buildCustomProviderRenameAliases = (
  previousProviders: unknown,
  nextProviders: unknown,
): Readonly<Record<string, string>> => {
  if (!isRecord(previousProviders) || !isRecord(nextProviders)) return {};

  const aliases: Record<string, string> = {};
  const nextEntries = Object.entries(nextProviders);
  for (const [providerKey, previousValue] of Object.entries(previousProviders)) {
    if (!isJustDoCustomProviderKey(providerKey)) continue;
    const previousConfig: CustomProviderConfigLike = isRecord(previousValue) ? previousValue : {};
    const matchingEntry = nextEntries.find(([nextKey, nextValue]) => {
      if (!isJustDoCustomProviderKey(nextKey) || !isRecord(nextValue)) return false;
      if (typeof previousConfig.identity === 'string' && typeof nextValue.identity === 'string') {
        return previousConfig.identity === nextValue.identity;
      }
      return nextKey === providerKey;
    });
    if (!matchingEntry) continue;
    const [nextProviderKey, nextValue] = matchingEntry;
    const nextConfig: CustomProviderConfigLike = isRecord(nextValue) ? nextValue : {};
    const previousName = getEffectiveCustomProviderDisplayName(
      providerKey,
      previousConfig.displayName,
    );
    const nextName = getEffectiveCustomProviderDisplayName(providerKey, nextConfig.displayName);
    if (
      validateCustomProviderDisplayName(previousName).valid === false ||
      validateCustomProviderDisplayName(nextName).valid === false
    ) {
      continue;
    }

    const previousId = normalizeOpenClawProviderId(previousName);
    const nextId = normalizeOpenClawProviderId(nextName);
    if (previousId !== nextId) aliases[previousId] = nextId;
    if (normalizeOpenClawProviderId(nextProviderKey) !== nextId) {
      aliases[normalizeOpenClawProviderId(nextProviderKey)] = nextId;
    }
  }
  return aliases;
};

export const rewriteOpenClawModelProviderId = (
  modelRef: string,
  aliases: Readonly<Record<string, string>>,
): string => {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return trimmed;

  const providerId = normalizeOpenClawProviderId(trimmed.slice(0, slashIndex));
  if (!Object.prototype.hasOwnProperty.call(aliases, providerId)) return trimmed;
  const nextProviderId = aliases[providerId];
  if (!nextProviderId) return trimmed;
  return `${nextProviderId}/${trimmed.slice(slashIndex + 1)}`;
};

export const validateCustomProviderDisplayName = (
  name: string,
): CustomProviderDisplayNameValidation => {
  const trimmed = name.trim();
  if (!trimmed) return { valid: true };
  if (isReservedOpenClawProviderId(trimmed)) {
    return { valid: false, reason: 'reserved' };
  }
  if (!VALID_CUSTOM_PROVIDER_DISPLAY_NAME_PATTERN.test(trimmed)) {
    return { valid: false, reason: 'format' };
  }
  return { valid: true };
};

/**
 * Provider IDs owned by JustDo's OpenClaw configuration. OpenClaw's built-in
 * and plugin provider IDs are intentionally not reserved: an explicit
 * `models.providers.<id>` entry is a supported route override, and blocking
 * those IDs prevents users from giving a custom endpoint its natural name.
 */
export const JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS = [
  'builtin_models',
  'justdo',
] as const;

const RESERVED_PROVIDER_IDS = new Set<string>(JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS);
const INTERNAL_CUSTOM_PROVIDER_ID_PATTERN = /^custom_\d+$/;
const VALID_CUSTOM_PROVIDER_DISPLAY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_. -]{0,31}$/;

export type CustomProviderDisplayNameValidation =
  { valid: true } | { valid: false; reason: 'reserved' | 'format' };

export const normalizeOpenClawProviderId = (name: string): string => name.trim().toLowerCase();

export const isReservedOpenClawProviderId = (name: string): boolean => {
  const normalized = normalizeOpenClawProviderId(name);
  return (
    RESERVED_PROVIDER_IDS.has(normalized) || INTERNAL_CUSTOM_PROVIDER_ID_PATTERN.test(normalized)
  );
};

export const isJustDoCustomProviderKey = (providerKey: string): boolean =>
  providerKey.startsWith('custom_');

export const getDefaultCustomProviderDisplayName = (providerKey: string): string =>
  `Custom${providerKey.replace('custom_', '')}`;

export const getEffectiveCustomProviderDisplayName = (
  providerKey: string,
  displayName?: unknown,
): string =>
  (typeof displayName === 'string' ? displayName.trim() : '') ||
  getDefaultCustomProviderDisplayName(providerKey);

type CustomProviderConfigLike = {
  displayName?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  for (const [providerKey, previousValue] of Object.entries(previousProviders)) {
    if (!isJustDoCustomProviderKey(providerKey) || !(providerKey in nextProviders)) continue;

    const previousConfig: CustomProviderConfigLike = isRecord(previousValue) ? previousValue : {};
    const nextValue = nextProviders[providerKey];
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

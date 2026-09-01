/**
 * Provider IDs that OpenClaw v2026.8.1 assigns built-in behaviour to, or
 * resolves to an official external provider plugin. Custom provider display
 * names become wire-level model provider IDs, so they must not use these IDs.
 *
 * Keep this inventory in sync with OpenClaw's
 * `BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS` and official external provider catalog
 * whenever the locked runtime version changes.
 */
export const OPENCLAW_V2026_8_1_RESERVED_PROVIDER_IDS = [
  'amazon-bedrock',
  'amazon-bedrock-mantle',
  'anthropic',
  'anthropic-vertex',
  'arcee',
  'azure-openai-responses',
  'bailian-token-plan',
  'baseten',
  'builtin_models',
  'byteplus',
  'byteplus-plan',
  'cerebras',
  'chutes',
  'claude-cli',
  'clawrouter',
  'cloudflare-ai-gateway',
  'codex',
  'cohere',
  'comfy',
  'copilot-proxy',
  'dashscope',
  'deepinfra',
  'deepseek',
  'fal',
  'featherless',
  'fireworks',
  'fireworks-ai',
  'github-copilot',
  'gmi',
  'gmi-cloud',
  'gmicloud',
  'google',
  'google-antigravity',
  'google-gemini-cli',
  'google-vertex',
  'groq',
  'huggingface',
  'justdo',
  'kilocode',
  'kimi',
  'kimi-coding',
  'litellm',
  'lmstudio',
  'longcat',
  'meituan-longcat',
  'meta',
  'microsoft-foundry',
  'minimax',
  'minimax-portal',
  'mistral',
  'modelstudio',
  'moonshot',
  'moonshot-ai',
  'moonshotai',
  'novita',
  'novita-ai',
  'novitaai',
  'nvidia',
  'ollama',
  'ollama-cloud',
  'openai',
  'opencode',
  'opencode-go',
  'openrouter',
  'pixverse',
  'qianfan',
  'qwen',
  'qwen-token-plan',
  'qwencloud',
  'sglang',
  'stepfun',
  'stepfun-plan',
  'synthetic',
  'tencent-tokenhub',
  'tencent-tokenplan',
  'together',
  'venice',
  'vercel-ai-gateway',
  'vllm',
  'volcengine',
  'volcengine-plan',
  'voyage',
  'vydra',
  'x-ai',
  'xai',
  'xiaomi',
  'xiaomi-token-plan',
  'z-ai',
  'z.ai',
  'zai',
] as const;

const RESERVED_PROVIDER_IDS = new Set<string>(OPENCLAW_V2026_8_1_RESERVED_PROVIDER_IDS);
const INTERNAL_CUSTOM_PROVIDER_ID_PATTERN = /^custom_\d+$/;
const VALID_CUSTOM_PROVIDER_DISPLAY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_ -]{0,31}$/;

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

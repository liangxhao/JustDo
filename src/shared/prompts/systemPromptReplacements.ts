export const SystemPromptReplacementIpc = {
  GetRules: 'openclaw:engine:getSystemPromptReplacementRules',
  SetRules: 'openclaw:engine:setSystemPromptReplacementRules',
} as const;

export const SYSTEM_PROMPT_REPLACEMENT_DEFAULT_FLAGS = 'g';
export const SYSTEM_PROMPT_REPLACEMENT_MAX_RULES = 100;
export const SYSTEM_PROMPT_REPLACEMENT_MAX_ID_LENGTH = 128;
export const SYSTEM_PROMPT_REPLACEMENT_MAX_PATTERN_LENGTH = 8_192;
export const SYSTEM_PROMPT_REPLACEMENT_MAX_REPLACEMENT_LENGTH = 32_768;

export interface SystemPromptReplacementRule {
  id: string;
  pattern: string;
  flags?: string;
  replacement: string;
  enabled?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const normalizeSystemPromptReplacementRules = (
  value: unknown,
  maxRules = SYSTEM_PROMPT_REPLACEMENT_MAX_RULES,
): SystemPromptReplacementRule[] => {
  if (!Array.isArray(value)) {
    throw new TypeError('System prompt replacement rules must be an array');
  }
  if (value.length > maxRules) {
    throw new RangeError(
      `System prompt replacement rules cannot exceed ${maxRules}`,
    );
  }

  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`System prompt replacement rule ${index + 1} must be an object`);
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) {
      throw new TypeError(`System prompt replacement rule ${index + 1} requires an id`);
    }
    if (id.length > SYSTEM_PROMPT_REPLACEMENT_MAX_ID_LENGTH) {
      throw new RangeError(`System prompt replacement rule ${index + 1} id is too long`);
    }
    if (ids.has(id)) {
      throw new TypeError(`Duplicate system prompt replacement rule id: ${id}`);
    }
    ids.add(id);

    const pattern = typeof entry.pattern === 'string' ? entry.pattern : '';
    if (!pattern) {
      throw new TypeError(`System prompt replacement rule ${id} requires a pattern`);
    }
    if (pattern.length > SYSTEM_PROMPT_REPLACEMENT_MAX_PATTERN_LENGTH) {
      throw new RangeError(`System prompt replacement rule ${id} pattern is too long`);
    }

    if (entry.flags !== undefined && typeof entry.flags !== 'string') {
      throw new TypeError(`System prompt replacement rule ${id} flags must be a string`);
    }
    const flags =
      typeof entry.flags === 'string'
        ? entry.flags
        : SYSTEM_PROMPT_REPLACEMENT_DEFAULT_FLAGS;
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(`System prompt replacement rule ${id} is invalid: ${message}`);
    }

    if (typeof entry.replacement !== 'string') {
      throw new TypeError(`System prompt replacement rule ${id} requires a replacement`);
    }
    if (entry.replacement.length > SYSTEM_PROMPT_REPLACEMENT_MAX_REPLACEMENT_LENGTH) {
      throw new RangeError(`System prompt replacement rule ${id} replacement is too long`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new TypeError(`System prompt replacement rule ${id} enabled must be a boolean`);
    }

    return {
      id,
      pattern,
      flags,
      replacement: entry.replacement,
      enabled: entry.enabled !== false,
    };
  });
};

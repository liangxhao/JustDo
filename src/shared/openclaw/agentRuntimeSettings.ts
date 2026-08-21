export const AGENT_RUNTIME_SETTINGS_VERSION = 1 as const;

export const AgentRuntimeDelegationMode = {
  Suggest: 'suggest',
  Prefer: 'prefer',
} as const;

export type AgentRuntimeDelegationModeValue =
  (typeof AgentRuntimeDelegationMode)[keyof typeof AgentRuntimeDelegationMode];

export const AgentRuntimeThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Adaptive: 'adaptive',
  Max: 'max',
  Ultra: 'ultra',
} as const;

export type AgentRuntimeThinkingLevelValue =
  (typeof AgentRuntimeThinkingLevel)[keyof typeof AgentRuntimeThinkingLevel];

export const AGENT_RUNTIME_THINKING_LEVELS = Object.values(AgentRuntimeThinkingLevel);

export const AGENT_RUNTIME_LIMITS = {
  maxConcurrent: { min: 1, max: 16 },
  maxChildrenPerAgent: { min: 1, max: 20 },
  maxSpawnDepth: { min: 1, max: 2 },
  runTimeoutSeconds: { min: 60, max: 24 * 60 * 60 },
  modelRefMaxLength: 256,
} as const;

export interface AgentRuntimeSettings {
  version: typeof AGENT_RUNTIME_SETTINGS_VERSION;
  subagents: {
    delegationMode: AgentRuntimeDelegationModeValue;
    model: string | null;
    thinking: AgentRuntimeThinkingLevelValue | null;
    maxConcurrent: number;
    maxChildrenPerAgent: number;
    runTimeoutSeconds: number;
    maxSpawnDepth: number;
  };
}

export const DEFAULT_AGENT_RUNTIME_SETTINGS: Readonly<AgentRuntimeSettings> = Object.freeze({
  version: AGENT_RUNTIME_SETTINGS_VERSION,
  subagents: Object.freeze({
    delegationMode: AgentRuntimeDelegationMode.Suggest,
    model: null,
    thinking: null,
    maxConcurrent: 3,
    maxChildrenPerAgent: 5,
    runTimeoutSeconds: 2 * 60 * 60,
    maxSpawnDepth: 1,
  }),
});

export const createDefaultAgentRuntimeSettings = (): AgentRuntimeSettings => ({
  version: DEFAULT_AGENT_RUNTIME_SETTINGS.version,
  subagents: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.subagents },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isIntegerInRange = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

const isThinkingLevel = (value: unknown): value is AgentRuntimeThinkingLevelValue =>
  typeof value === 'string' &&
  AGENT_RUNTIME_THINKING_LEVELS.includes(value as AgentRuntimeThinkingLevelValue);

export type AgentRuntimeSettingsValidationResult =
  | { ok: true; settings: AgentRuntimeSettings }
  | { ok: false; error: string };

export const validateAgentRuntimeSettings = (
  value: unknown,
): AgentRuntimeSettingsValidationResult => {
  if (!isRecord(value) || value.version !== AGENT_RUNTIME_SETTINGS_VERSION) {
    return { ok: false, error: 'Unsupported Agent runtime settings version.' };
  }
  if (!isRecord(value.subagents)) {
    return { ok: false, error: 'Invalid Subagent settings.' };
  }

  const subagents = value.subagents;
  const delegationMode = subagents.delegationMode;
  if (
    delegationMode !== AgentRuntimeDelegationMode.Suggest &&
    delegationMode !== AgentRuntimeDelegationMode.Prefer
  ) {
    return { ok: false, error: 'Invalid Subagent delegation mode.' };
  }

  const model = subagents.model;
  if (
    model !== null &&
    (typeof model !== 'string' ||
      !model.trim() ||
      model.trim().length > AGENT_RUNTIME_LIMITS.modelRefMaxLength)
  ) {
    return { ok: false, error: 'Invalid Subagent model.' };
  }

  const thinking = subagents.thinking;
  let validatedThinking: AgentRuntimeThinkingLevelValue | null = null;
  if (thinking !== null) {
    if (!isThinkingLevel(thinking)) {
      return { ok: false, error: 'Invalid Subagent thinking level.' };
    }
    validatedThinking = thinking;
  }

  const maxConcurrent = subagents.maxConcurrent;
  if (
    !isIntegerInRange(
      maxConcurrent,
      AGENT_RUNTIME_LIMITS.maxConcurrent.min,
      AGENT_RUNTIME_LIMITS.maxConcurrent.max,
    )
  ) {
    return { ok: false, error: 'Subagent concurrency is outside the supported range.' };
  }

  const maxChildrenPerAgent = subagents.maxChildrenPerAgent;
  if (
    !isIntegerInRange(
      maxChildrenPerAgent,
      AGENT_RUNTIME_LIMITS.maxChildrenPerAgent.min,
      AGENT_RUNTIME_LIMITS.maxChildrenPerAgent.max,
    )
  ) {
    return { ok: false, error: 'Subagent child limit is outside the supported range.' };
  }

  const maxSpawnDepth = subagents.maxSpawnDepth;
  if (
    !isIntegerInRange(
      maxSpawnDepth,
      AGENT_RUNTIME_LIMITS.maxSpawnDepth.min,
      AGENT_RUNTIME_LIMITS.maxSpawnDepth.max,
    )
  ) {
    return { ok: false, error: 'Subagent nesting depth is outside the supported range.' };
  }

  const runTimeoutSeconds = subagents.runTimeoutSeconds;
  if (
    runTimeoutSeconds !== 0 &&
    !isIntegerInRange(
      runTimeoutSeconds,
      AGENT_RUNTIME_LIMITS.runTimeoutSeconds.min,
      AGENT_RUNTIME_LIMITS.runTimeoutSeconds.max,
    )
  ) {
    return { ok: false, error: 'Subagent run timeout is outside the supported range.' };
  }

  return {
    ok: true,
    settings: {
      version: AGENT_RUNTIME_SETTINGS_VERSION,
      subagents: {
        delegationMode,
        model: typeof model === 'string' ? model.trim() : null,
        thinking: validatedThinking,
        maxConcurrent,
        maxChildrenPerAgent,
        runTimeoutSeconds,
        maxSpawnDepth,
      },
    },
  };
};

export const parseAgentRuntimeSettings = (value: unknown): AgentRuntimeSettings => {
  const result = validateAgentRuntimeSettings(value);
  return result.ok ? result.settings : createDefaultAgentRuntimeSettings();
};

export const AgentRuntimeSettingsIpc = {
  Get: 'cowork:agentRuntimeSettings:get',
  Set: 'cowork:agentRuntimeSettings:set',
} as const;

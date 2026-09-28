import { DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS, MCP_REQUEST_TIMEOUT_LIMITS } from './mcp';

export const AGENT_RUNTIME_SETTINGS_VERSION = 1 as const;

export const AgentRuntimeCodeMode = {
  Off: 'off',
  Auto: 'auto',
  On: 'on',
} as const;

export type AgentRuntimeCodeModeValue =
  (typeof AgentRuntimeCodeMode)[keyof typeof AgentRuntimeCodeMode];

export const AgentRuntimeDelegationMode = {
  Suggest: 'suggest',
  Prefer: 'prefer',
} as const;

export type AgentRuntimeDelegationModeValue =
  (typeof AgentRuntimeDelegationMode)[keyof typeof AgentRuntimeDelegationMode];

export const AgentRuntimeSessionVisibility = {
  Self: 'self',
  Tree: 'tree',
  Agent: 'agent',
  All: 'all',
} as const;

export type AgentRuntimeSessionVisibilityValue =
  (typeof AgentRuntimeSessionVisibility)[keyof typeof AgentRuntimeSessionVisibility];

export const AGENT_RUNTIME_SESSION_VISIBILITIES = Object.values(AgentRuntimeSessionVisibility);

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

export const AUTOMATION_APPROVAL_TIMEOUT_MINUTES = [2, 5, 10] as const;

export const AGENT_RUNTIME_LIMITS = {
  askUserQuestionTimeoutMinutes: { min: 1, max: 24 * 60 },
  mcpRequestTimeoutSeconds: MCP_REQUEST_TIMEOUT_LIMITS,
  maxConcurrent: { min: 1, max: 16 },
  agentMaxConcurrent: { min: 1, max: 16 },
  maxChildrenPerAgent: { min: 1, max: 20 },
  maxSpawnDepth: { min: 1, max: 5 },
  archiveAfterMinutes: { min: 0, max: 365 * 24 * 60 },
  agentRunTimeoutSeconds: { min: 60, max: 24 * 60 * 60 },
  runTimeoutSeconds: { min: 60, max: 24 * 60 * 60 },
  swarmMaxConcurrent: { min: 1, max: 64 },
  swarmMaxChildrenPerGroup: { min: 1, max: 200 },
  swarmMaxTotalPerGroup: { min: 1, max: 1000 },
  modelRefMaxLength: 256,
} as const;

export interface AgentRuntimeSettings {
  version: typeof AGENT_RUNTIME_SETTINGS_VERSION;
  codeMode: {
    mode: AgentRuntimeCodeModeValue;
  };
  agent: {
    thinking: AgentRuntimeThinkingLevelValue | null;
    runTimeoutSeconds: number;
    maxConcurrent: number | null;
  };
  askUserQuestion: {
    timeoutMinutes: number;
  };
  automation: {
    approvalTimeoutMinutes: (typeof AUTOMATION_APPROVAL_TIMEOUT_MINUTES)[number];
  };
  mcp: {
    requestTimeoutSeconds: number;
  };
  sessions: {
    visibility: AgentRuntimeSessionVisibilityValue;
  };
  swarm: {
    enabled: boolean;
    maxConcurrent: number;
    maxChildrenPerGroup: number;
    maxTotalPerGroup: number;
  };
  subagents: {
    delegationMode: AgentRuntimeDelegationModeValue | null;
    model: string | null;
    thinking: AgentRuntimeThinkingLevelValue | null;
    maxConcurrent: number;
    maxChildrenPerAgent: number;
    runTimeoutSeconds: number;
    maxSpawnDepth: number;
    archiveAfterMinutes: number;
  };
}

export const DEFAULT_AGENT_RUNTIME_SETTINGS: Readonly<AgentRuntimeSettings> = Object.freeze({
  version: AGENT_RUNTIME_SETTINGS_VERSION,
  codeMode: Object.freeze({ mode: AgentRuntimeCodeMode.Off }),
  agent: Object.freeze({
    thinking: null,
    runTimeoutSeconds: 0,
    maxConcurrent: null,
  }),
  askUserQuestion: Object.freeze({
    timeoutMinutes: 10,
  }),
  automation: Object.freeze({
    approvalTimeoutMinutes: 2,
  }),
  mcp: Object.freeze({
    requestTimeoutSeconds: DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS,
  }),
  sessions: Object.freeze({
    visibility: AgentRuntimeSessionVisibility.Tree,
  }),
  swarm: Object.freeze({
    enabled: true,
    maxConcurrent: 8,
    maxChildrenPerGroup: 50,
    maxTotalPerGroup: 200,
  }),
  subagents: Object.freeze({
    delegationMode: null,
    model: null,
    thinking: null,
    maxConcurrent: 3,
    maxChildrenPerAgent: 5,
    runTimeoutSeconds: 2 * 60 * 60,
    maxSpawnDepth: 1,
    archiveAfterMinutes: 0,
  }),
});

export const createDefaultAgentRuntimeSettings = (): AgentRuntimeSettings => ({
  version: DEFAULT_AGENT_RUNTIME_SETTINGS.version,
  codeMode: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.codeMode },
  agent: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.agent },
  askUserQuestion: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.askUserQuestion },
  automation: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.automation },
  mcp: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.mcp },
  sessions: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.sessions },
  swarm: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.swarm },
  subagents: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.subagents },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isIntegerInRange = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

const isThinkingLevel = (value: unknown): value is AgentRuntimeThinkingLevelValue =>
  typeof value === 'string' &&
  AGENT_RUNTIME_THINKING_LEVELS.includes(value as AgentRuntimeThinkingLevelValue);

const isSessionVisibility = (value: unknown): value is AgentRuntimeSessionVisibilityValue =>
  typeof value === 'string' &&
  AGENT_RUNTIME_SESSION_VISIBILITIES.includes(value as AgentRuntimeSessionVisibilityValue);

export type AgentRuntimeSettingsValidationResult =
  { ok: true; settings: AgentRuntimeSettings } | { ok: false; error: string };

export const validateAgentRuntimeSettings = (
  value: unknown,
): AgentRuntimeSettingsValidationResult => {
  if (!isRecord(value) || value.version !== AGENT_RUNTIME_SETTINGS_VERSION) {
    return { ok: false, error: 'Unsupported Agent runtime settings version.' };
  }
  if (!isRecord(value.subagents)) {
    return { ok: false, error: 'Invalid Subagent settings.' };
  }

  const codeMode =
    value.codeMode === undefined ? DEFAULT_AGENT_RUNTIME_SETTINGS.codeMode : value.codeMode;
  if (
    !isRecord(codeMode) ||
    !Object.values(AgentRuntimeCodeMode).includes(codeMode.mode as AgentRuntimeCodeModeValue)
  ) {
    return { ok: false, error: 'Invalid Code Mode settings.' };
  }

  // Version 1 predates main Agent thinking preferences. Preserve stored
  // settings while filling the new preference with its managed default.
  const agent = isRecord(value.agent) ? value.agent : DEFAULT_AGENT_RUNTIME_SETTINGS.agent;
  const agentThinking = agent.thinking;
  let validatedAgentThinking: AgentRuntimeThinkingLevelValue | null = null;
  if (agentThinking !== null) {
    if (!isThinkingLevel(agentThinking)) {
      return { ok: false, error: 'Invalid Agent thinking level.' };
    }
    validatedAgentThinking = agentThinking;
  }
  const agentRunTimeoutSeconds =
    agent.runTimeoutSeconds ?? DEFAULT_AGENT_RUNTIME_SETTINGS.agent.runTimeoutSeconds;
  if (
    agentRunTimeoutSeconds !== 0 &&
    !isIntegerInRange(
      agentRunTimeoutSeconds,
      AGENT_RUNTIME_LIMITS.agentRunTimeoutSeconds.min,
      AGENT_RUNTIME_LIMITS.agentRunTimeoutSeconds.max,
    )
  ) {
    return { ok: false, error: 'Agent run timeout is outside the supported range.' };
  }
  const agentMaxConcurrent =
    agent.maxConcurrent ?? DEFAULT_AGENT_RUNTIME_SETTINGS.agent.maxConcurrent;
  let validatedAgentMaxConcurrent: number | null = null;
  if (agentMaxConcurrent !== null) {
    if (
      !isIntegerInRange(
        agentMaxConcurrent,
        AGENT_RUNTIME_LIMITS.agentMaxConcurrent.min,
        AGENT_RUNTIME_LIMITS.agentMaxConcurrent.max,
      )
    ) {
      return { ok: false, error: 'Agent concurrency is outside the supported range.' };
    }
    validatedAgentMaxConcurrent = agentMaxConcurrent;
  }

  const askUserQuestion = isRecord(value.askUserQuestion)
    ? value.askUserQuestion
    : DEFAULT_AGENT_RUNTIME_SETTINGS.askUserQuestion;
  const askUserQuestionTimeoutMinutes = askUserQuestion.timeoutMinutes;
  if (
    !isIntegerInRange(
      askUserQuestionTimeoutMinutes,
      AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.min,
      AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.max,
    )
  ) {
    return { ok: false, error: 'AskUserQuestion timeout is outside the supported range.' };
  }

  const automation = isRecord(value.automation)
    ? value.automation
    : DEFAULT_AGENT_RUNTIME_SETTINGS.automation;
  const automationApprovalTimeoutMinutes = automation.approvalTimeoutMinutes;
  if (
    !AUTOMATION_APPROVAL_TIMEOUT_MINUTES.includes(
      automationApprovalTimeoutMinutes as (typeof AUTOMATION_APPROVAL_TIMEOUT_MINUTES)[number],
    )
  ) {
    return { ok: false, error: 'Scheduled task approval timeout is unsupported.' };
  }

  // Version 1 predates MCP runtime preferences. Keep older persisted settings
  // valid while making OpenClaw's 60-second request default explicit.
  const mcp = isRecord(value.mcp) ? value.mcp : DEFAULT_AGENT_RUNTIME_SETTINGS.mcp;
  const mcpRequestTimeoutSeconds = mcp.requestTimeoutSeconds;
  if (
    !isIntegerInRange(
      mcpRequestTimeoutSeconds,
      AGENT_RUNTIME_LIMITS.mcpRequestTimeoutSeconds.min,
      AGENT_RUNTIME_LIMITS.mcpRequestTimeoutSeconds.max,
    )
  ) {
    return { ok: false, error: 'MCP request timeout is outside the supported range.' };
  }

  // Version 1 predates session-tool visibility preferences. Preserve the
  // pre-v2026.8.2 parent/child boundary for existing profiles.
  const sessions = isRecord(value.sessions)
    ? value.sessions
    : DEFAULT_AGENT_RUNTIME_SETTINGS.sessions;
  const sessionVisibility = sessions.visibility;
  if (!isSessionVisibility(sessionVisibility)) {
    return { ok: false, error: 'Invalid session visibility.' };
  }

  const swarm = value.swarm === undefined ? DEFAULT_AGENT_RUNTIME_SETTINGS.swarm : value.swarm;
  if (!isRecord(swarm) || typeof swarm.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid Swarm settings.' };
  }
  const { maxConcurrent: swarmConcurrency, maxChildrenPerGroup, maxTotalPerGroup } = swarm;
  if (
    !isIntegerInRange(
      swarmConcurrency,
      AGENT_RUNTIME_LIMITS.swarmMaxConcurrent.min,
      AGENT_RUNTIME_LIMITS.swarmMaxConcurrent.max,
    ) ||
    !isIntegerInRange(
      maxChildrenPerGroup,
      AGENT_RUNTIME_LIMITS.swarmMaxChildrenPerGroup.min,
      AGENT_RUNTIME_LIMITS.swarmMaxChildrenPerGroup.max,
    ) ||
    !isIntegerInRange(
      maxTotalPerGroup,
      AGENT_RUNTIME_LIMITS.swarmMaxTotalPerGroup.min,
      AGENT_RUNTIME_LIMITS.swarmMaxTotalPerGroup.max,
    )
  ) {
    return { ok: false, error: 'Swarm capacity is outside the supported range.' };
  }

  const subagents = value.subagents;
  const delegationMode =
    subagents.delegationMode ?? DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.delegationMode;
  let validatedDelegationMode: AgentRuntimeDelegationModeValue | null = null;
  if (delegationMode !== null) {
    if (
      delegationMode !== AgentRuntimeDelegationMode.Suggest &&
      delegationMode !== AgentRuntimeDelegationMode.Prefer
    ) {
      return { ok: false, error: 'Invalid Subagent delegation mode.' };
    }
    validatedDelegationMode = delegationMode;
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

  const archiveAfterMinutes =
    subagents.archiveAfterMinutes ?? DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.archiveAfterMinutes;
  if (
    !isIntegerInRange(
      archiveAfterMinutes,
      AGENT_RUNTIME_LIMITS.archiveAfterMinutes.min,
      AGENT_RUNTIME_LIMITS.archiveAfterMinutes.max,
    )
  ) {
    return { ok: false, error: 'Subagent archive delay is outside the supported range.' };
  }

  return {
    ok: true,
    settings: {
      version: AGENT_RUNTIME_SETTINGS_VERSION,
      codeMode: { mode: codeMode.mode as AgentRuntimeCodeModeValue },
      agent: {
        thinking: validatedAgentThinking,
        runTimeoutSeconds: agentRunTimeoutSeconds,
        maxConcurrent: validatedAgentMaxConcurrent,
      },
      askUserQuestion: {
        timeoutMinutes: askUserQuestionTimeoutMinutes,
      },
      automation: {
        approvalTimeoutMinutes:
          automationApprovalTimeoutMinutes as (typeof AUTOMATION_APPROVAL_TIMEOUT_MINUTES)[number],
      },
      mcp: {
        requestTimeoutSeconds: mcpRequestTimeoutSeconds,
      },
      sessions: {
        visibility: sessionVisibility,
      },
      swarm: {
        enabled: swarm.enabled,
        maxConcurrent: swarmConcurrency,
        maxChildrenPerGroup,
        maxTotalPerGroup,
      },
      subagents: {
        delegationMode: validatedDelegationMode,
        model: typeof model === 'string' ? model.trim() : null,
        thinking: validatedThinking,
        maxConcurrent,
        maxChildrenPerAgent,
        runTimeoutSeconds,
        maxSpawnDepth,
        archiveAfterMinutes,
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

import {
  DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS,
  MCP_REQUEST_TIMEOUT_LIMITS,
} from './mcp';

export const AGENT_RUNTIME_SETTINGS_VERSION = 1 as const;

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

export const APPROVAL_WAIT_TIMEOUT_MINUTES = [0, 10, 20, 30, 60] as const;
export const OPENCLAW_INDEFINITE_APPROVAL_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

export const AGENT_RUNTIME_LIMITS = {
  askUserQuestionTimeoutMinutes: { min: 1, max: 24 * 60 },
  mcpRequestTimeoutSeconds: MCP_REQUEST_TIMEOUT_LIMITS,
  maxConcurrent: { min: 1, max: 16 },
  maxChildrenPerAgent: { min: 1, max: 20 },
  maxSpawnDepth: { min: 1, max: 2 },
  runTimeoutSeconds: { min: 60, max: 24 * 60 * 60 },
  modelRefMaxLength: 256,
} as const;

export interface AgentRuntimeSettings {
  version: typeof AGENT_RUNTIME_SETTINGS_VERSION;
  agent: {
    thinking: AgentRuntimeThinkingLevelValue | null;
  };
  askUserQuestion: {
    timeoutMinutes: number;
  };
  approvals: {
    /** Zero disables automatic expiry for native exec and plugin approvals. */
    timeoutMinutes: number;
  };
  mcp: {
    requestTimeoutSeconds: number;
  };
  sessions: {
    visibility: AgentRuntimeSessionVisibilityValue;
  };
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
  agent: Object.freeze({
    thinking: null,
  }),
  askUserQuestion: Object.freeze({
    timeoutMinutes: 10,
  }),
  approvals: Object.freeze({
    timeoutMinutes: 30,
  }),
  mcp: Object.freeze({
    requestTimeoutSeconds: DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS,
  }),
  sessions: Object.freeze({
    visibility: AgentRuntimeSessionVisibility.Tree,
  }),
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
  agent: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.agent },
  askUserQuestion: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.askUserQuestion },
  approvals: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.approvals },
  mcp: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.mcp },
  sessions: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.sessions },
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

  // Version 1 predates AskUserQuestion preferences. Preserve stored Subagent
  // choices while filling the new setting with its managed default.
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

  // Version 1 predates approval wait preferences. Keep the native 30-minute
  // behavior for existing profiles while accepting zero as the unlimited sentinel.
  const approvals = isRecord(value.approvals)
    ? value.approvals
    : DEFAULT_AGENT_RUNTIME_SETTINGS.approvals;
  const approvalTimeoutMinutes = approvals.timeoutMinutes;
  if (
    typeof approvalTimeoutMinutes !== 'number' ||
    !APPROVAL_WAIT_TIMEOUT_MINUTES.includes(
      approvalTimeoutMinutes as (typeof APPROVAL_WAIT_TIMEOUT_MINUTES)[number],
    )
  ) {
    return { ok: false, error: 'Approval wait timeout is unsupported.' };
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
      agent: {
        thinking: validatedAgentThinking,
      },
      askUserQuestion: {
        timeoutMinutes: askUserQuestionTimeoutMinutes,
      },
      approvals: {
        timeoutMinutes: approvalTimeoutMinutes,
      },
      mcp: {
        requestTimeoutSeconds: mcpRequestTimeoutSeconds,
      },
      sessions: {
        visibility: sessionVisibility,
      },
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

export const resolveApprovalWaitTimeoutMs = (timeoutMinutes: number): number =>
  timeoutMinutes === 0 ? 0 : timeoutMinutes * 60_000;

export const parseAgentRuntimeSettings = (value: unknown): AgentRuntimeSettings => {
  const result = validateAgentRuntimeSettings(value);
  return result.ok ? result.settings : createDefaultAgentRuntimeSettings();
};

export const AgentRuntimeSettingsIpc = {
  Get: 'cowork:agentRuntimeSettings:get',
  Set: 'cowork:agentRuntimeSettings:set',
} as const;

/** Direct user conversations always belong to main; peers are task-internal sessions. */
export const MAIN_USER_AGENT_ID = 'main';

export const AgentIpc = {
  List: 'agents:list',
  Save: 'agents:save',
  Delete: 'agents:delete',
  ReadFile: 'agents:readFile',
  WriteFile: 'agents:writeFile',
} as const;

export const AgentFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'] as const;
export type AgentFileName = (typeof AgentFiles)[number];

export interface AgentProfileInput {
  id?: string;
  name: string;
  description: string;
  icon: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
}

export type AgentResult<T> = { success: true; value: T } | { success: false; error: string };
export interface AgentFileSnapshot {
  content: string;
  missing: boolean;
  workspace: string;
}

export function parseAgentProfile(value: unknown): AgentProfileInput {
  if (!value || typeof value !== 'object') throw new Error('agentInvalidProfile');
  const input = value as Record<string, unknown>;
  const limits = { name: 80, description: 2000, icon: 32, model: 256 };
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof input[key] !== 'string' || (input[key] as string).length > limit) {
      throw new Error('agentInvalidProfile');
    }
  }
  if (
    !(input.name as string).trim() ||
    typeof input.enabled !== 'boolean' ||
    typeof input.isDefault !== 'boolean' ||
    (input.isDefault && !input.enabled) ||
    (input.id !== undefined &&
      (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id)))
  ) {
    throw new Error('agentInvalidProfile');
  }
  if (input.model && !/^[^\s/]+\/\S+$/.test(input.model as string))
    throw new Error('agentInvalidModel');
  return {
    ...(input.id ? { id: input.id as string } : {}),
    name: (input.name as string).trim(),
    description: (input.description as string).trim(),
    icon: (input.icon as string).trim(),
    model: (input.model as string).trim(),
    enabled: input.enabled,
    isDefault: input.isDefault,
  };
}

export interface AgentHandoffSource {
  sessionId?: string;
  title: string;
}
export interface AssistantCreateInput {
  name: string;
  description: string;
  instructions: string;
  model?: string;
}

export function parseAssistantCreate(value: unknown): AssistantCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('agentInvalidProfile');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      key => !['name', 'description', 'instructions', 'model'].includes(key),
    ) ||
    typeof input.instructions !== 'string' ||
    !input.instructions.trim() ||
    input.instructions.length > 100_000
  )
    throw new Error('agentInvalidProfile');
  const profile = parseAgentProfile({
    name: input.name,
    description: input.description,
    icon: '',
    model: input.model ?? '',
    enabled: true,
    isDefault: false,
  });
  return {
    name: profile.name,
    description: profile.description,
    instructions: input.instructions,
    ...(profile.model ? { model: profile.model } : {}),
  };
}

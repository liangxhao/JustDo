export interface AgentTeamSettings {
  collaboration: { maxMembers: number; messageBudget: number };
  discussion: {
    maxMembers: number;
    defaultRounds: number;
    maxRounds: number;
    maxTurns: number | null;
    maxConcurrent: number | null;
    organizerParticipates: boolean;
  };
}

export interface AgentTeamSettingsSnapshot {
  version: 1;
  revision: number;
  value: AgentTeamSettings;
}

export type AgentTeamKind = 'collaboration' | 'discussion';

export interface AgentTeamOverrides {
  messageBudget?: number;
  defaultRounds?: number;
  maxTurns?: number;
  maxConcurrent?: number;
}

export interface AgentTeamPreferences {
  revision: number;
  value: AgentTeamOverrides;
}

export interface AgentTeamSettingsView {
  global: AgentTeamSettingsSnapshot;
  team: AgentTeamPreferences;
  memberCount: number;
}

export interface DiscussionResources {
  settingsRevision: number;
  maxRounds: number;
  maxTurns: number;
  maxConcurrent: number;
}

export const defaultAgentTeamSettings = (): AgentTeamSettings => ({
  collaboration: { maxMembers: 12, messageBudget: 16 },
  discussion: {
    maxMembers: 6,
    defaultRounds: 2,
    maxRounds: 4,
    maxTurns: null,
    maxConcurrent: null,
    organizerParticipates: false,
  },
});

export function settingsRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('agentTeamSettingsInvalid');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !keys.includes(key)))
    throw new Error('agentTeamSettingsInvalid');
  return input;
}

export function settingsInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error('agentTeamSettingsInvalid');
  return value as number;
}

export function parseAgentTeamSettings(value: unknown): AgentTeamSettings {
  const input = settingsRecord(value, ['collaboration', 'discussion']);
  const c = settingsRecord(input.collaboration, ['maxMembers', 'messageBudget']);
  const d = settingsRecord(input.discussion, [
    'maxMembers',
    'defaultRounds',
    'maxRounds',
    'maxTurns',
    'maxConcurrent',
    'organizerParticipates',
  ]);
  if (typeof d.organizerParticipates !== 'boolean') throw new Error('agentTeamSettingsInvalid');
  const result: AgentTeamSettings = {
    collaboration: {
      maxMembers: settingsInteger(c.maxMembers, 2, 12),
      messageBudget: settingsInteger(c.messageBudget, 4, 16),
    },
    discussion: {
      maxMembers: settingsInteger(d.maxMembers, 2, 6),
      defaultRounds: settingsInteger(d.defaultRounds, 1, 4),
      maxRounds: settingsInteger(d.maxRounds, 1, 4),
      maxTurns: d.maxTurns === null ? null : settingsInteger(d.maxTurns, 1, 24),
      maxConcurrent: d.maxConcurrent === null ? null : settingsInteger(d.maxConcurrent, 1, 6),
      organizerParticipates: d.organizerParticipates,
    },
  };
  if (result.discussion.defaultRounds > result.discussion.maxRounds)
    throw new Error('agentTeamSettingsRoundsConflict');
  return result;
}

export function parseAgentTeamOverrides(value: unknown, kind: AgentTeamKind): AgentTeamOverrides {
  const input = settingsRecord(
    value,
    kind === 'collaboration' ? ['messageBudget'] : ['defaultRounds', 'maxTurns', 'maxConcurrent'],
  );
  const result: AgentTeamOverrides = {};
  for (const key of Object.keys(input) as (keyof AgentTeamOverrides)[]) {
    const [min, max] =
      key === 'messageBudget'
        ? [4, 16]
        : key === 'defaultRounds'
          ? [1, 4]
          : key === 'maxConcurrent'
            ? [1, 6]
            : [1, 24];
    result[key] = settingsInteger(input[key], min, max);
  }
  return result;
}

export function effectiveDiscussionDefaults(
  global: AgentTeamSettings,
  team: AgentTeamOverrides = {},
) {
  const d = global.discussion;
  return {
    ...d,
    defaultRounds: Math.min(team.defaultRounds ?? d.defaultRounds, d.maxRounds),
    maxTurns: Math.min(team.maxTurns ?? 24, d.maxTurns ?? 24),
    maxConcurrent: Math.min(team.maxConcurrent ?? 6, d.maxConcurrent ?? 6),
  };
}

export function resolveDiscussionResources(
  global: AgentTeamSettingsSnapshot,
  team: AgentTeamOverrides,
  memberCount: number,
  rounds: number,
): DiscussionResources {
  const d = effectiveDiscussionDefaults(global.value, team);
  if (settingsInteger(rounds, 1, 4) > d.maxRounds)
    throw new Error('agentTeamSettingsRoundsExceeded');
  settingsInteger(memberCount, 2, 6);
  return {
    settingsRevision: global.revision,
    maxRounds: d.maxRounds,
    maxTurns: Math.min(d.maxTurns, memberCount * rounds),
    maxConcurrent: Math.min(d.maxConcurrent, memberCount),
  };
}

export function parseDiscussionResources(value: unknown): DiscussionResources {
  const input = settingsRecord(value, [
    'settingsRevision',
    'maxRounds',
    'maxTurns',
    'maxConcurrent',
  ]);
  return {
    settingsRevision: settingsInteger(input.settingsRevision, 0, Number.MAX_SAFE_INTEGER),
    maxRounds: settingsInteger(input.maxRounds, 1, 4),
    maxTurns: settingsInteger(input.maxTurns, 1, 24),
    maxConcurrent: settingsInteger(input.maxConcurrent, 1, 6),
  };
}

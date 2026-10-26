import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { getSessionEntry, type SessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import type { TeamDiscussionRoom } from '../contracts/teamDiscussion';

/** Creation-owned isolation cannot be added to an existing independent member. */
export function hasUnsupportedDiscussionSourcePolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return entry.sandbox === 'required';
}

const executionPolicyKeys = [
  'permissionMode',
  'toolOverrides',
  'inheritedToolPolicyVersion',
  'inheritedToolPolicySource',
  'inheritedToolAllow',
  'inheritedToolDeny',
  'execHost',
  'execNode',
  'execCwd',
  'elevatedLevel',
  'sandboxMode',
  'nativeRuntimeConsent',
] as const satisfies readonly (keyof SessionEntry)[];

const sessionPolicyKeys = [
  ...executionPolicyKeys,
  'providerOverride',
  'modelOverride',
  'modelOverrideSource',
  'modelOverrideRouteResolution',
  'modelOverrideFallbackOriginProvider',
  'modelOverrideFallbackOriginModel',
  'agentRuntimeOverride',
  'contextWindow',
  'thinkingLevel',
  'fastMode',
  'verboseLevel',
  'traceLevel',
  'reasoningLevel',
  'authProfileOverride',
  'authProfileOverrideSource',
  'authProfileOverrideCompactionCount',
] as const satisfies readonly (keyof SessionEntry)[];

const agentPolicyKeys = [
  'model',
  'utilityModel',
  'decisionModel',
  'models',
  'modelPolicy',
  'thinkingDefault',
  'verboseDefault',
  'toolProgressDetail',
  'reasoningDefault',
  'fastModeDefault',
  'skills',
  'subagents',
  'embeddedAgent',
  'params',
  'runtime',
  'sandbox',
  'tools',
  'skillsLimits',
  'contextLimits',
] as const;

/** Explicit undefined values clear a member's stale settings when the source clears them. */
export function discussionSessionPolicy(entry: SessionEntry): Partial<SessionEntry> {
  return Object.fromEntries(
    sessionPolicyKeys.map(key => [key, structuredClone(entry[key])]),
  ) as Partial<SessionEntry>;
}

export function discussionSessionPolicyFingerprint(entry: SessionEntry): string {
  return JSON.stringify(discussionSessionPolicy(entry));
}

/** Native auth rotation and model fallback may update selection while a run executes. */
export function discussionExecutionPolicyFingerprint(entry: SessionEntry): string {
  return JSON.stringify(Object.fromEntries(executionPolicyKeys.map(key => [key, entry[key]])));
}

function sourceConfigPolicy(cfg: OpenClawConfig, agentId: string) {
  const agent = cfg.agents?.entries?.[agentId] as Record<string, unknown> | undefined;
  return Object.fromEntries(agentPolicyKeys.map(key => [key, agent?.[key]]));
}

/** Per-dispatch projection keeps each member's own role files and canonical workspace. */
export function inheritDiscussionConfig(
  cfg: OpenClawConfig,
  room: TeamDiscussionRoom,
): OpenClawConfig {
  if (!room.summarySource) return cfg;
  const policy = sourceConfigPolicy(cfg, room.summarySource.agentId);
  const entries = { ...cfg.agents?.entries };
  for (const member of room.members) {
    if (member.ownership === 'source') continue;
    entries[member.agentId] = { ...entries[member.agentId], ...structuredClone(policy) };
  }
  return { ...cfg, agents: { ...cfg.agents, entries } };
}

/** Source settings can change without rotating the native lifecycle revision. */
export function captureDiscussionSourcePolicy(
  cfg: OpenClawConfig,
  room: Pick<TeamDiscussionRoom, 'cwd' | 'sourceSessionId' | 'summarySource'>,
  currentConfig: () => OpenClawConfig = () => cfg,
):
  | { entry: SessionEntry; assertCurrent: () => void; assertExecutionCurrent: () => void }
  | undefined {
  const source = room.summarySource;
  if (!source) return undefined;
  if (
    !room.sourceSessionId ||
    source.sessionKey !== `agent:${source.agentId}:justdo:${room.sourceSessionId}` ||
    !cfg.agents?.entries?.[source.agentId]
  )
    throw new Error('teamDiscussionSessionChanged');
  const read = () => {
    const entry = getSessionEntry({
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      readConsistency: 'latest',
    });
    if (
      !entry ||
      entry.sessionId !== source.sessionId ||
      entry.lifecycleRevision !== source.lifecycleRevision ||
      entry.sessionRoot !== room.cwd ||
      entry.archivedAt !== undefined
    )
      throw new Error('teamDiscussionSessionChanged');
    assertDiscussionRuntime(currentConfig(), source.agentId, entry);
    if (hasUnsupportedDiscussionSourcePolicy(entry))
      throw new Error('teamDiscussionSourcePolicyUnsupported');
    return entry;
  };
  const fingerprint = (entry: SessionEntry, executing = false) =>
    JSON.stringify([
      executing ? discussionExecutionPolicyFingerprint(entry) : discussionSessionPolicy(entry),
      sourceConfigPolicy(currentConfig(), source.agentId),
      currentConfig().agents?.defaults,
      currentConfig().tools,
    ]);
  const entry = structuredClone(read());
  const policy = fingerprint(entry);
  const executionPolicy = fingerprint(entry, true);
  return {
    entry,
    assertCurrent: () => {
      if (fingerprint(read()) !== policy) throw new Error('teamDiscussionSessionChanged');
    },
    assertExecutionCurrent: () => {
      if (fingerprint(read(), true) !== executionPolicy)
        throw new Error('teamDiscussionSessionChanged');
    },
  };
}

/** Only the embedded OpenClaw runtime has a verified per-turn tool boundary. */
export function assertDiscussionRuntime(config: unknown, agentId: string, value?: unknown): void {
  const cfg = config as {
    agents?: {
      defaults?: { models?: Record<string, { agentRuntime?: { id?: string } }> };
      entries?: Record<
        string,
        { runtime?: { type?: string }; models?: Record<string, { agentRuntime?: { id?: string } }> }
      >;
    };
  };
  const agent = cfg.agents?.entries?.[agentId];
  const entry = (value ?? {}) as {
    acp?: unknown;
    agentRuntimeOverride?: string;
    agentHarnessId?: string;
  };
  const alternative = (id?: string) => !!id && !['openclaw', 'auto', 'default'].includes(id);
  if (
    agent?.runtime?.type === 'acp' ||
    entry.acp ||
    alternative(entry.agentRuntimeOverride) ||
    alternative(entry.agentHarnessId) ||
    Object.values({ ...cfg.agents?.defaults?.models, ...agent?.models }).some(model =>
      alternative(model.agentRuntime?.id),
    )
  )
    throw new Error('teamDiscussionSourcePolicyUnsupported');
}

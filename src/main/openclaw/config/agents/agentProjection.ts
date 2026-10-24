import path from 'path';

import { normalizeOpenClawAgentId } from '../../../../shared/agents/agentId';
import {
  type AgentRuntimeSettings,
  createDefaultAgentRuntimeSettings,
} from '../../../../shared/agents/agentRuntimeSettings';
import { EXTERNAL_AGENT_CATALOG } from '../../../../shared/integrations/externalAgentCatalog';
import { OPENCLAW_COMPACTION_TIMEOUT_SECONDS } from '../../../../shared/openclaw/compaction';
import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import type { Agent } from '../../../data/coworkStore';
import { isRecord } from '../configShape';
import { resolveConfiguredPluginPath } from '../plugins/extensionInventory';
import { resolveManagedAgentWorkspace } from './agentWorkspace';

export const listKnownOpenClawWorkspaceDirs = ({
  stateDir,
  mainWorkspaceDir,
  agents,
  existingConfig,
}: {
  stateDir: string;
  mainWorkspaceDir: string;
  agents: readonly Agent[];
  existingConfig?: Record<string, unknown> | null;
}): string[] => {
  const workspaceDirs = new Set([mainWorkspaceDir, resolveManagedAgentWorkspace(stateDir, 'main')]);
  const existingAgents = isRecord(existingConfig?.agents) ? existingConfig.agents : {};
  const existingDefaults = isRecord(existingAgents.defaults) ? existingAgents.defaults : {};
  const configuredDefaultWorkspace =
    typeof existingDefaults.workspace === 'string' && existingDefaults.workspace.trim()
      ? resolveConfiguredPluginPath(existingDefaults.workspace)
      : null;
  if (configuredDefaultWorkspace) workspaceDirs.add(configuredDefaultWorkspace);

  const addDefaultAgentWorkspace = (agentId: string): void => {
    const normalizedAgentId = normalizeOpenClawAgentId(agentId);
    workspaceDirs.add(resolveManagedAgentWorkspace(stateDir, normalizedAgentId));
    if (normalizedAgentId === 'main') return;
    // Current OpenClaw nests non-default agents under agents.defaults.workspace.
    workspaceDirs.add(path.join(mainWorkspaceDir, normalizedAgentId));
    if (configuredDefaultWorkspace) {
      workspaceDirs.add(path.join(configuredDefaultWorkspace, normalizedAgentId));
    }
    // Also inventory the pre-defaults.workspace fallback used by older/minimal configs.
    workspaceDirs.add(path.join(stateDir, `workspace-${normalizedAgentId}`));
  };
  agents.forEach(agent => addDefaultAgentWorkspace(agent.id));

  const existingAgentEntries = isRecord(existingAgents.entries)
    ? Object.entries(existingAgents.entries)
    : [];
  for (const [agentId, entry] of existingAgentEntries) {
    if (!isRecord(entry)) continue;
    const configuredWorkspace = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
    if (configuredWorkspace) {
      workspaceDirs.add(resolveConfiguredPluginPath(configuredWorkspace));
      continue;
    }
    addDefaultAgentWorkspace(agentId);
  }

  // Inventory a legacy roster only for locating user-installed extensions
  // before the next config sync rewrites it to v2026.9.8's keyed entries.
  const legacyAgentList = Array.isArray(existingAgents.list) ? existingAgents.list : [];
  for (const entry of legacyAgentList) {
    if (!isRecord(entry)) continue;
    const configuredWorkspace = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
    if (configuredWorkspace) {
      workspaceDirs.add(resolveConfiguredPluginPath(configuredWorkspace));
    } else if (typeof entry.id === 'string') {
      addDefaultAgentWorkspace(entry.id.trim());
    }
  }
  return [...workspaceDirs];
};

export const withoutRetiredHeartbeatFields = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const heartbeat = { ...value };
  delete heartbeat.includeSystemPromptSection;
  return heartbeat;
};

export const canonicalizeAgentEntry = (value: Record<string, unknown>): Record<string, unknown> => {
  const entry = { ...value };
  delete entry.id;
  delete entry.default;

  if (Object.prototype.hasOwnProperty.call(entry, 'heartbeat')) {
    entry.heartbeat = withoutRetiredHeartbeatFields(entry.heartbeat);
  }

  const legacyMemorySearch = isRecord(entry.memorySearch) ? entry.memorySearch : undefined;
  delete entry.memorySearch;
  if (legacyMemorySearch) {
    const memory = isRecord(entry.memory) ? entry.memory : {};
    entry.memory = {
      ...memory,
      ...(isRecord(memory.search) ? {} : { search: legacyMemorySearch }),
    };
  }
  return entry;
};

export const collectCanonicalAgentEntries = (
  agents: Record<string, unknown>,
): Record<string, Record<string, unknown>> => {
  const entries: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  if (Array.isArray(agents.list)) {
    for (const value of agents.list) {
      if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) continue;
      entries[normalizeOpenClawAgentId(value.id)] = canonicalizeAgentEntry(value);
    }
  }
  if (isRecord(agents.entries)) {
    for (const [agentId, value] of Object.entries(agents.entries)) {
      if (!isRecord(value)) continue;
      entries[normalizeOpenClawAgentId(agentId)] = canonicalizeAgentEntry(value);
    }
  }
  return entries;
};

export const constrainAgentEntryToAvailableModels = (
  entry: Record<string, unknown>,
  fallbackPrimaryModel: string,
  availableModelRefs: ReadonlySet<string>,
): Record<string, unknown> => {
  const runtime = isRecord(entry.runtime) ? entry.runtime : undefined;
  if (runtime?.type === 'acp') {
    // ACP model selection comes from explicit spawn/subagent settings or the
    // harness default. Injecting the embedded Agent's primary model here turns
    // an omitted sessions_spawn.model into an invalid ACP model override.
    return entry;
  }
  const model = isRecord(entry.model) ? entry.model : {};
  const primary = typeof model.primary === 'string' ? model.primary : '';
  if (primary && availableModelRefs.has(primary)) {
    return entry;
  }
  return {
    ...entry,
    model: {
      ...model,
      primary: fallbackPrimaryModel,
    },
  };
};

export const mergeAgentEntriesWithManagedMainSettings = (
  managedEntries: Record<string, unknown>,
  existingEntries: Record<string, unknown>,
): Record<string, unknown> => {
  const externalAgentIds = new Set<string>(EXTERNAL_AGENT_CATALOG.map(definition => definition.id));
  const unmanagedExistingEntries = Object.fromEntries(
    Object.entries(existingEntries).filter(([agentId, entry]) => {
      if (!externalAgentIds.has(agentId)) {
        return true;
      }
      if (!isRecord(entry) || !isRecord(entry.runtime) || entry.runtime.type !== 'acp') {
        return true;
      }
      const acp = isRecord(entry.runtime.acp) ? entry.runtime.acp : {};
      return acp.agent !== agentId || acp.backend !== OpenClawExtensionId.ACPX;
    }),
  );
  const entries: Record<string, unknown> = {
    ...managedEntries,
    ...unmanagedExistingEntries,
  };
  for (const [agentId, entry] of Object.entries(managedEntries)) {
    if (!externalAgentIds.has(agentId)) continue;
    if (!isRecord(entry) || !isRecord(entry.runtime) || entry.runtime.type !== 'acp') continue;
    entries[agentId] = entry;
  }
  // Authentication sync preserves native settings, but managed role homes and
  // task directories must remain consistent with normal settings sync.
  for (const [agentId, entry] of Object.entries(managedEntries)) {
    if (!isRecord(entry) || 'runtime' in entry) continue;
    entries[agentId] = {
      ...(isRecord(entries[agentId]) ? entries[agentId] : {}),
      ...(typeof entry.workspace === 'string' ? { workspace: entry.workspace } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    };
  }
  const managedMain = isRecord(managedEntries.main) ? managedEntries.main : undefined;
  const managedMainHeartbeat = isRecord(managedMain?.heartbeat) ? managedMain.heartbeat : undefined;
  if (managedMainHeartbeat) {
    entries.main = {
      ...(isRecord(entries.main) ? entries.main : {}),
      ...(managedMainHeartbeat ? { heartbeat: managedMainHeartbeat } : {}),
    };
  }
  return entries;
};

// Keep the product's historical 365-day stale-session policy. In current
// OpenClaw, maxEntries archives overflow entries; it does not shorten the
// transcript retention window or authorize JustDo to delete message rows.
export const OPENCLAW_SESSION_PRUNE_AFTER = '365d';

export const OPENCLAW_SESSION_MAX_ENTRIES = 500;

export const buildManagedOpenClawSessionConfig = (existing?: unknown) => ({
  ...(isRecord(existing) ? existing : {}),
  dmScope: 'per-account-channel-peer',
  reset: {
    mode: 'none',
  },
  maintenance: {
    ...(isRecord(existing) && isRecord(existing.maintenance) ? existing.maintenance : {}),
    mode: 'enforce',
    pruneAfter: OPENCLAW_SESSION_PRUNE_AFTER,
    maxEntries: OPENCLAW_SESSION_MAX_ENTRIES,
  },
});

export const buildManagedOpenClawSubagentConfig = (
  settings: AgentRuntimeSettings = createDefaultAgentRuntimeSettings(),
) => ({
  ...(settings.subagents.delegationMode
    ? { delegationMode: settings.subagents.delegationMode }
    : {}),
  maxSpawnDepth: settings.subagents.maxSpawnDepth,
  maxChildrenPerAgent: settings.subagents.maxChildrenPerAgent,
  maxConcurrent: settings.subagents.maxConcurrent,
  runTimeoutSeconds: settings.subagents.runTimeoutSeconds,
  archiveAfterMinutes: settings.subagents.archiveAfterMinutes,
  ...(settings.subagents.model ? { model: settings.subagents.model } : {}),
  ...(settings.subagents.thinking ? { thinking: settings.subagents.thinking } : {}),
});

export const mergeManagedOpenClawSubagentConfig = (
  existingValue: unknown,
  managedValue: unknown,
): Record<string, unknown> => {
  const existing = isRecord(existingValue) ? existingValue : {};
  const managed = isRecord(managedValue) ? managedValue : {};
  const merged: Record<string, unknown> = { ...existing, ...managed };
  for (const key of ['delegationMode', 'model', 'thinking'] as const) {
    if (!Object.prototype.hasOwnProperty.call(managed, key)) delete merged[key];
  }
  return merged;
};

export const buildManagedOpenClawAgentThinkingConfig = (
  settings: AgentRuntimeSettings = createDefaultAgentRuntimeSettings(),
) => (settings.agent.thinking ? { thinkingDefault: settings.agent.thinking } : {});

/** Public-model fallback is unavailable in the intranet distribution. */
export const buildManagedOpenClawEmbeddedAgentConfig = (value: unknown) => {
  const existing = isRecord(value) ? value : {};
  return {
    ...existing,
    cyberFailover: {
      ...(isRecord(existing.cyberFailover) ? existing.cyberFailover : {}),
      mode: 'off',
    },
  };
};

export const buildManagedOpenClawHeartbeatConfig = () => ({
  // JustDo has no external notification channel and v2026.9.8 automations
  // create/run through the native cron tool without a recurring heartbeat.
  // Keep the explicit zero cadence so OpenClaw does not fall back to its
  // native default while retaining event-driven targeted wake-ups.
  every: '0m',
});

export const applyManagedOpenClawHeartbeatConfig = (
  agent: Record<string, unknown>,
): Record<string, unknown> =>
  agent.id === 'main'
    ? {
        ...agent,
        heartbeat: buildManagedOpenClawHeartbeatConfig(),
      }
    : agent;

/** Keep JustDo's bounded safeguards while inheriting OpenClaw's native defaults. */
export const buildManagedOpenClawCompactionConfig = () => ({
  mode: 'safeguard',
  timeoutSeconds: OPENCLAW_COMPACTION_TIMEOUT_SECONDS,
  memoryFlush: {
    enabled: false,
  },
  midTurnPrecheck: {
    enabled: true,
  },
});

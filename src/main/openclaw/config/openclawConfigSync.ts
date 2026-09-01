import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BrowserMode, type BrowserMode as BrowserModeValue } from '../../../shared/browser';
import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import { OPENAI_REQUEST_USER_AGENT } from '../../../shared/cowork/modelRequestHeaders';
import {
  type AgentRuntimeSettings,
  createDefaultAgentRuntimeSettings,
  DEFAULT_AGENT_RUNTIME_SETTINGS,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { PermissionMode, type PermissionMode as PermissionModeValue } from '../../../shared/openclaw/approvals';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import {
  getEffectiveCustomProviderDisplayName,
  isJustDoCustomProviderKey,
  normalizeOpenClawProviderId,
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../../shared/providers';
import { ScheduledTaskAgentId } from '../../../shared/scheduledTask/constants';
import type { ProviderRawConfig } from '../../cowork/providerApiConfig';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveRawApiConfig,
  validateConfiguredOpenClawProviderNames,
} from '../../cowork/providerApiConfig';
import type { Agent, CoworkConfig, CoworkExecutionMode } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  buildBundledExtensionEntries,
  buildBundledExtensionToolContracts,
  bundledOpenClawExtensions,
  hasBundledOpenClawExtension,
  inspectBundledOpenClawExtensions,
  inspectLocalOpenClawExtensions,
  inspectOpenClawExtensionCandidate,
  inspectOpenClawExtensionDirectory,
  listRetiredBundledOpenClawExtensionIds,
} from '../../plugins/extensions';
import type { OpenClawHookRecord } from '../../plugins/hooks';
import type { McpServerRecord } from '../../plugins/mcp';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
} from '../models/openclawAgentModels';
import { repairOpenClawWorkspaceState } from './workspaceStateRepair';

export type AskUserExtensionConfig = {
  askUserCallbackUrl: string;
  secret: string;
  timeoutMinutes?: number;
};

export const buildOpenClawMcpServers = (
  servers: McpServerRecord[],
  requestTimeoutSeconds = DEFAULT_AGENT_RUNTIME_SETTINGS.mcp.requestTimeoutSeconds,
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    servers.map(server => {
      const config: Record<string, unknown> = {
        enabled: server.enabled,
        timeout: server.requestTimeoutSeconds ?? requestTimeoutSeconds,
      };
      if (server.transportType === 'stdio') {
        config.command = server.command;
        config.args = server.args ?? [];
        if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
      } else {
        config.url = server.url;
        config.transport = server.transportType === 'sse' ? 'sse' : 'streamable-http';
        if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers;
      }
      return [server.name, config];
    }),
  );
};

type ConfiguredPluginInventory = {
  complete: boolean;
  ids: string[];
};

export const listInstalledOpenClawExtensionIds = (stateDir: string): string[] =>
  inspectOpenClawExtensionDirectory(path.join(stateDir, 'extensions')).ids;

const resolveConfiguredPluginPath = (value: string): string => {
  const trimmed = value.trim();
  const homeDir = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, homeDir);
  return path.resolve(expanded);
};

// Version-locked to OpenClaw v2026.8.1 routing/session-key normalizeAgentId.
const normalizeOpenClawAgentId = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return 'main';
  const normalized = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return normalized;
  return (
    normalized
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 64) || 'main'
  );
};

const listKnownOpenClawWorkspaceDirs = ({
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
  const workspaceDirs = new Set([mainWorkspaceDir]);
  const existingAgents = isRecord(existingConfig?.agents) ? existingConfig.agents : {};
  const existingDefaults = isRecord(existingAgents.defaults) ? existingAgents.defaults : {};
  const configuredDefaultWorkspace =
    typeof existingDefaults.workspace === 'string' && existingDefaults.workspace.trim()
      ? resolveConfiguredPluginPath(existingDefaults.workspace)
      : null;
  if (configuredDefaultWorkspace) workspaceDirs.add(configuredDefaultWorkspace);

  const addDefaultAgentWorkspace = (agentId: string): void => {
    const normalizedAgentId = normalizeOpenClawAgentId(agentId);
    if (normalizedAgentId === 'main' || normalizedAgentId === ScheduledTaskAgentId) return;
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
    const configuredWorkspace =
      typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
    if (configuredWorkspace) {
      workspaceDirs.add(resolveConfiguredPluginPath(configuredWorkspace));
      continue;
    }
    addDefaultAgentWorkspace(agentId);
  }

  // Inventory a legacy roster only for locating user-installed extensions
  // before the next config sync rewrites it to v2026.8.1's keyed entries.
  const legacyAgentList = Array.isArray(existingAgents.list) ? existingAgents.list : [];
  for (const entry of legacyAgentList) {
    if (!isRecord(entry)) continue;
    const configuredWorkspace =
      typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
    if (configuredWorkspace) {
      workspaceDirs.add(resolveConfiguredPluginPath(configuredWorkspace));
    } else if (typeof entry.id === 'string') {
      addDefaultAgentWorkspace(entry.id.trim());
    }
  }
  return [...workspaceDirs];
};

const isMissingConfiguredPluginPath = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  );

const hasCompatiblePluginBundleManifest = (pluginDir: string): boolean => {
  for (const relativeManifestPath of [
    path.join('.codex-plugin', 'plugin.json'),
    path.join('.claude-plugin', 'plugin.json'),
    path.join('.cursor-plugin', 'plugin.json'),
  ]) {
    try {
      if (fs.statSync(path.join(pluginDir, relativeManifestPath)).isFile()) return true;
    } catch (error) {
      // A non-missing error means the candidate cannot be inventoried safely.
      if (!isMissingConfiguredPluginPath(error)) return true;
    }
  }
  return false;
};

const inspectConfiguredPluginPaths = (
  plugins: Record<string, unknown>,
): ConfiguredPluginInventory => {
  const load = isRecord(plugins.load) ? plugins.load : {};
  const loadPaths = Array.isArray(load.paths)
    ? load.paths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const ids = new Set<string>();
  let complete = true;

  for (const configuredPath of loadPaths) {
    const existingPath = resolveConfiguredPluginPath(configuredPath);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(existingPath);
    } catch (error) {
      if (isMissingConfiguredPluginPath(error)) continue;
      complete = false;
      continue;
    }
    if (!stats.isDirectory()) {
      // Standalone plugin files may export an id that cannot be inferred without executing code.
      complete = false;
      continue;
    }

    const directInventory = inspectOpenClawExtensionCandidate(existingPath);
    if (directInventory.complete) {
      directInventory.ids.forEach(id => ids.add(id));
      continue;
    }
    if (hasCompatiblePluginBundleManifest(existingPath)) {
      complete = false;
      continue;
    }
    const rootInventory = inspectOpenClawExtensionDirectory(existingPath);
    rootInventory.ids.forEach(id => ids.add(id));
    if (!rootInventory.complete) complete = false;
  }

  return { complete, ids: [...ids].sort() };
};

export const listAvailableOpenClawExtensionIds = (
  stateDir: string,
  plugins: Record<string, unknown>,
  workspaceDirs: readonly string[] = [],
): string[] | null => {
  const bundledInventory = inspectBundledOpenClawExtensions();
  const localInventory = inspectLocalOpenClawExtensions();
  const installedInventory = inspectOpenClawExtensionDirectory(
    path.join(stateDir, 'extensions'),
  );
  const workspaceInventories = workspaceDirs.map(workspaceDir =>
    inspectOpenClawExtensionDirectory(path.join(workspaceDir, '.openclaw', 'extensions')),
  );
  const configuredInventory = inspectConfiguredPluginPaths(plugins);
  if (
    !bundledInventory.complete ||
    bundledInventory.ids.length === 0 ||
    !localInventory.complete ||
    !installedInventory.complete ||
    workspaceInventories.some(inventory => !inventory.complete) ||
    !configuredInventory.complete
  ) {
    return null;
  }
  const retiredIds = new Set(listRetiredBundledOpenClawExtensionIds());
  return [
    ...new Set([
      ...bundledInventory.ids,
      ...localInventory.ids,
      ...installedInventory.ids,
      ...workspaceInventories.flatMap(inventory => inventory.ids),
      ...configuredInventory.ids,
    ].filter(id => !retiredIds.has(id))),
  ].sort();
};

export const buildOpenClawHookConfig = (
  hooks: OpenClawHookRecord[],
): { hooks?: Record<string, unknown> } => {
  const entries = Object.fromEntries(
    hooks.map(hook => [
      hook.id,
      {
        ...hook.config,
        enabled: hook.enabled,
      },
    ]),
  );

  return Object.keys(entries).length > 0
    ? {
        hooks: {
          internal: {
            enabled: hooks.some(hook => hook.enabled),
            entries,
          },
        },
      }
    : {};
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

type OpenClawConfigVerification = {
  ok: boolean;
  error?: string;
};

const removeRetiredManagedToolDenyEntries = (
  tools: Record<string, unknown>,
): Record<string, unknown> => {
  if (!Array.isArray(tools.deny)) return tools;
  const deny = tools.deny.filter(value => value !== 'skill_workshop');
  return deny.length === tools.deny.length ? tools : { ...tools, deny };
};

const containsBuiltinModelRef = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return (
      value === OpenClawProviderId.BuiltinModels ||
      value.startsWith(`${OpenClawProviderId.BuiltinModels}/`)
    );
  }
  if (Array.isArray(value)) {
    return value.some(containsBuiltinModelRef);
  }
  return isRecord(value) && Object.values(value).some(containsBuiltinModelRef);
};

const BUILTIN_MODELS_API_KEY_PLACEHOLDER = '${JUSTDO_APIKEY_BUILTIN_MODELS}';

const containsBuiltinMemorySearchRef = (value: unknown): boolean =>
  containsBuiltinModelRef(value) ||
  (typeof value === 'string'
    ? value.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER)
    : Array.isArray(value)
      ? value.some(containsBuiltinMemorySearchRef)
      : isRecord(value) && Object.values(value).some(containsBuiltinMemorySearchRef));

const withoutRetiredHeartbeatFields = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const heartbeat = { ...value };
  delete heartbeat.includeSystemPromptSection;
  return heartbeat;
};

const canonicalizeAgentEntry = (value: Record<string, unknown>): Record<string, unknown> => {
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

const collectCanonicalAgentEntries = (
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

/**
 * Remove JustDo-owned fields retired by OpenClaw v2026.8.1 and translate the
 * two renamed config surfaces. This is deliberately narrow: unrelated
 * operator-owned config remains untouched and is still validated by Gateway.
 */
export const sanitizeOpenClawV2026_8_1Config = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...config };

  if (isRecord(config.meta)) {
    const meta = { ...config.meta };
    delete meta.lastTouchedAt;
    next.meta = meta;
  }

  if (isRecord(config.diagnostics)) {
    const diagnostics = { ...config.diagnostics };
    delete diagnostics.stuckSessionWarnMs;
    delete diagnostics.stuckSessionAbortMs;
    next.diagnostics = diagnostics;
  }

  if (isRecord(config.models)) {
    const models = { ...config.models };
    delete models.pricing;
    next.models = models;
  }

  if (isRecord(config.tools)) {
    const tools = { ...config.tools };
    const experimental = isRecord(tools.experimental) ? tools.experimental : undefined;
    if (
      typeof experimental?.planTool === 'boolean' &&
      !Object.prototype.hasOwnProperty.call(tools, 'updatePlan')
    ) {
      tools.updatePlan = experimental.planTool;
    }
    delete tools.experimental;
    next.tools = tools;
  }

  if (isRecord(config.agents)) {
    const agents = { ...config.agents };
    const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
    const legacyMemorySearch = isRecord(defaults.memorySearch)
      ? defaults.memorySearch
      : undefined;
    delete defaults.memorySearch;
    if (Object.prototype.hasOwnProperty.call(defaults, 'heartbeat')) {
      defaults.heartbeat = withoutRetiredHeartbeatFields(defaults.heartbeat);
    }

    const entries = collectCanonicalAgentEntries(agents);
    delete agents.list;
    agents.defaults = defaults;
    if (Object.keys(entries).length > 0) {
      agents.ownership = 'explicit';
      agents.entries = entries;
    }
    next.agents = agents;

    if (legacyMemorySearch) {
      const memory = isRecord(next.memory) ? next.memory : {};
      next.memory = {
        ...memory,
        ...(isRecord(memory.search) ? {} : { search: legacyMemorySearch }),
      };
    }
  }

  return next;
};

export const verifyLoggedOutOpenClawConfig = (
  configPath: string,
): OpenClawConfigVerification => {
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read synced OpenClaw config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (content.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER)) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: built-in API key placeholder remains.`,
    };
  }

  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isRecord(config)) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: root must be an object.`,
    };
  }

  const models = isRecord(config.models) ? config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  if (Object.prototype.hasOwnProperty.call(providers, OpenClawProviderId.BuiltinModels)) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: built-in provider remains.`,
    };
  }

  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const memory = isRecord(config.memory) ? config.memory : {};
  const defaultMemorySearch = isRecord(memory.search) ? memory.search : {};
  if (
    containsBuiltinModelRef(defaults.model) ||
    containsBuiltinMemorySearchRef(defaultMemorySearch)
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: default built-in model reference remains.`,
    };
  }

  if (
    isRecord(agents.entries) &&
    Object.values(agents.entries).some(
      agent => isRecord(agent) && containsBuiltinModelRef(agent.model),
    )
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: agent built-in model reference remains.`,
    };
  }

  return { ok: true };
};

const constrainAgentEntryToAvailableModels = (
  entry: Record<string, unknown>,
  fallbackPrimaryModel: string,
  availableModelRefs: ReadonlySet<string>,
): Record<string, unknown> => {
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

const rewriteProviderAliasInModel = (
  model: unknown,
  providerAliases: ReadonlyMap<string, string>,
): unknown => {
  if (!isRecord(model) || typeof model.primary !== 'string') return model;
  const primary = model.primary.trim();
  const separator = primary.indexOf('/');
  if (separator <= 0 || separator === primary.length - 1) return model;
  const providerId = primary.slice(0, separator);
  const canonicalProviderId = providerAliases.get(providerId.toLowerCase());
  if (!canonicalProviderId) return model;
  return {
    ...model,
    primary: `${canonicalProviderId}/${primary.slice(separator + 1)}`,
  };
};

const buildAuthScopedOpenClawConfig = (
  existingConfig: Record<string, unknown>,
  managedConfig: Record<string, unknown>,
  reason: string,
): Record<string, unknown> => {
  const canonicalExistingConfig = sanitizeOpenClawV2026_8_1Config(existingConfig);
  const isLogin = reason === BuiltinModelSyncReason.AuthLogin;
  const existingModels = isRecord(canonicalExistingConfig.models)
    ? canonicalExistingConfig.models
    : {};
  const managedModels = isRecord(managedConfig.models) ? managedConfig.models : {};
  const existingProviders = isRecord(existingModels.providers)
    ? existingModels.providers
    : {};
  const managedProviders = isRecord(managedModels.providers)
    ? managedModels.providers
    : {};
  const hasManagedBuiltinProvider = Object.prototype.hasOwnProperty.call(
    managedProviders,
    OpenClawProviderId.BuiltinModels,
  );
  const providers = { ...existingProviders };
  delete providers[OpenClawProviderId.BuiltinModels];
  const providerAliases = new Map<string, string>();
  const managedCustomProviders = Object.entries(managedProviders).filter(
    ([providerId]) => providerId !== OpenClawProviderId.BuiltinModels,
  );
  for (const [existingProviderId, existingProvider] of Object.entries(existingProviders)) {
    if (existingProviderId === OpenClawProviderId.BuiltinModels || !isRecord(existingProvider)) {
      continue;
    }
    const existingApiKey =
      typeof existingProvider.apiKey === 'string' ? existingProvider.apiKey : '';
    const managedMatch = managedCustomProviders.find(([, managedProvider]) => {
      if (!isRecord(managedProvider) || typeof managedProvider.apiKey !== 'string') return false;
      return managedProvider.apiKey === existingApiKey;
    });
    if (!managedMatch) continue;
    const [canonicalProviderId] = managedMatch;
    if (canonicalProviderId === existingProviderId) continue;
    delete providers[existingProviderId];
    providerAliases.set(existingProviderId.toLowerCase(), canonicalProviderId);
  }
  for (const [providerId, provider] of managedCustomProviders) {
    providers[providerId] = provider;
  }
  if (isLogin && hasManagedBuiltinProvider) {
    providers[OpenClawProviderId.BuiltinModels] =
      managedProviders[OpenClawProviderId.BuiltinModels];
  }

  const existingAgents = isRecord(canonicalExistingConfig.agents)
    ? canonicalExistingConfig.agents
    : {};
  const managedAgents = isRecord(managedConfig.agents) ? managedConfig.agents : {};
  const existingSession = isRecord(canonicalExistingConfig.session)
    ? canonicalExistingConfig.session
    : {};
  const managedSession = isRecord(managedConfig.session) ? managedConfig.session : {};
  const existingTools = isRecord(canonicalExistingConfig.tools)
    ? canonicalExistingConfig.tools
    : null;
  const existingDefaults = isRecord(existingAgents.defaults)
    ? existingAgents.defaults
    : {};
  const managedDefaults = isRecord(managedAgents.defaults) ? managedAgents.defaults : {};
  const defaults: Record<string, unknown> = {
    ...existingDefaults,
    ...(Object.prototype.hasOwnProperty.call(existingDefaults, 'model')
      ? { model: rewriteProviderAliasInModel(existingDefaults.model, providerAliases) }
      : {}),
  };
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'thinkingDefault')) {
    defaults.thinkingDefault = managedDefaults.thinkingDefault;
  } else {
    // Main Agent thinking is JustDo-managed. Absence means the user selected
    // "Not specified", so an older explicit value must not survive the merge.
    delete defaults.thinkingDefault;
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'compaction')) {
    // Compaction is JustDo-managed policy. Replace the whole object so removed
    // keys (notably the legacy explicit keepRecentTokens) do not survive an
    // auth-only config sync.
    defaults.compaction = managedDefaults.compaction;
  }
  const managedDefaultModel = isRecord(managedDefaults.model)
    ? managedDefaults.model
    : undefined;
  const managedDefaultPrimary =
    typeof managedDefaultModel?.primary === 'string' ? managedDefaultModel.primary : '';
  const existingFallbackModel =
    isRecord(defaults.model) && !containsBuiltinModelRef(defaults.model)
      ? defaults.model
      : undefined;

  const shouldRemoveBuiltinRefs = !isLogin || !hasManagedBuiltinProvider;
  if (!shouldRemoveBuiltinRefs) {
    if (
      managedDefaultPrimary.startsWith(`${OpenClawProviderId.BuiltinModels}/`) &&
      (!defaults.model || containsBuiltinModelRef(defaults.model))
    ) {
      defaults.model = managedDefaultModel;
    }
  } else {
    if (containsBuiltinModelRef(defaults.model)) {
      if (managedDefaultPrimary && !containsBuiltinModelRef(managedDefaultModel)) {
        defaults.model = managedDefaultModel;
      } else {
        delete defaults.model;
      }
    }
  }

  const existingEntries = isRecord(existingAgents.entries) ? existingAgents.entries : {};
  const managedEntries = isRecord(managedAgents.entries) ? managedAgents.entries : {};
  const agentEntries: Record<string, unknown> = {
    ...managedEntries,
    ...existingEntries,
  };
  if (shouldRemoveBuiltinRefs) {
    for (const [id, entry] of Object.entries(agentEntries)) {
      if (!isRecord(entry) || !containsBuiltinModelRef(entry.model)) continue;
      const managedEntry = isRecord(managedEntries[id]) ? managedEntries[id] : undefined;
      const fallbackModel =
        managedEntry &&
        isRecord(managedEntry.model) &&
        !containsBuiltinModelRef(managedEntry.model)
          ? managedEntry.model
          : managedDefaultPrimary && !containsBuiltinModelRef(managedDefaultModel)
            ? managedDefaultModel
            : existingFallbackModel;
      const nextEntry = { ...entry };
      if (fallbackModel) {
        nextEntry.model = fallbackModel;
      } else {
        delete nextEntry.model;
      }
      agentEntries[id] = nextEntry;
    }
  }
  for (const [id, entry] of Object.entries(agentEntries)) {
    if (!isRecord(entry) || !Object.prototype.hasOwnProperty.call(entry, 'model')) continue;
    agentEntries[id] = {
      ...entry,
      model: rewriteProviderAliasInModel(entry.model, providerAliases),
    };
  }

  const existingMemory = isRecord(canonicalExistingConfig.memory)
    ? canonicalExistingConfig.memory
    : {};
  const managedMemory = isRecord(managedConfig.memory) ? managedConfig.memory : {};
  const existingMemorySearch = isRecord(existingMemory.search)
    ? existingMemory.search
    : undefined;
  const managedMemorySearch = isRecord(managedMemory.search)
    ? managedMemory.search
    : undefined;
  const memory = { ...existingMemory };
  if (!shouldRemoveBuiltinRefs && managedMemorySearch) {
    memory.search = managedMemorySearch;
  } else if (
    containsBuiltinMemorySearchRef(existingMemorySearch) ||
    Object.keys(providers).length === 0
  ) {
    memory.search = { enabled: false };
  }

  const models: Record<string, unknown> = {
    ...existingModels,
    ...(Object.prototype.hasOwnProperty.call(existingModels, 'mode')
      ? {}
      : { mode: managedModels.mode }),
    providers,
  };
  if (Object.keys(providers).length === 0) {
    delete models.providers;
  }

  return sanitizeOpenClawV2026_8_1Config({
    ...canonicalExistingConfig,
    models,
    agents: {
      ...existingAgents,
      ownership: 'explicit',
      defaults,
      entries: agentEntries,
    },
    memory,
    session: {
      ...existingSession,
      ...managedSession,
    },
    ...(existingTools ? { tools: removeRetiredManagedToolDenyEntries(existingTools) } : {}),
    ...(isRecord(managedConfig.meta) ? { meta: managedConfig.meta } : {}),
  });
};

const RESERVED_PLUGIN_SLOT_VALUES = new Set(['legacy', 'none']);

export const removeUnavailableOpenClawPluginRegistrations = (
  plugins: Record<string, unknown>,
  availableExtensionIds: readonly string[],
): Record<string, unknown> => {
  const availableIds = new Set(availableExtensionIds);
  const filterRegistrationRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(value)) return undefined;
    const filtered = Object.fromEntries(
      Object.entries(value).filter(([extensionId]) => availableIds.has(extensionId)),
    );
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  };
  const filterRegistrationList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const filtered = [
      ...new Set(
        value.filter(
          (extensionId): extensionId is string =>
            typeof extensionId === 'string' && availableIds.has(extensionId),
        ),
      ),
    ];
    return filtered.length > 0 ? filtered : undefined;
  };

  const entries = filterRegistrationRecord(plugins.entries);
  const installs = filterRegistrationRecord(plugins.installs);
  const allow = filterRegistrationList(plugins.allow);
  const deny = filterRegistrationList(plugins.deny);
  const slots = isRecord(plugins.slots)
    ? Object.fromEntries(
        Object.entries(plugins.slots).filter(([, extensionId]) =>
          typeof extensionId !== 'string'
            ? true
            : RESERVED_PLUGIN_SLOT_VALUES.has(extensionId) || availableIds.has(extensionId),
        ),
      )
    : undefined;
  const cleaned = { ...plugins };
  for (const key of ['entries', 'installs', 'allow', 'deny', 'slots']) delete cleaned[key];
  if (entries) cleaned.entries = entries;
  if (installs) cleaned.installs = installs;
  if (allow) cleaned.allow = allow;
  if (deny) cleaned.deny = deny;
  if (slots && Object.keys(slots).length > 0) cleaned.slots = slots;
  return cleaned;
};

export const mergeOpenClawPluginConfig = (
  existingPlugins: Record<string, unknown>,
  managedEntries: Record<string, unknown>,
  trustedInstalledExtensionIds: string[] = [],
  availableExtensionIds: readonly string[] | null = null,
): Record<string, unknown> => {
  const managedIds = Object.keys(managedEntries);
  const sourcePlugins = availableExtensionIds
    ? removeUnavailableOpenClawPluginRegistrations(existingPlugins, [
        ...availableExtensionIds,
        ...trustedInstalledExtensionIds,
        ...managedIds,
      ])
    : existingPlugins;
  const mergedEntries = {
    ...(isRecord(sourcePlugins.entries) ? sourcePlugins.entries : {}),
    ...managedEntries,
  };
  const trustedIds = [
    ...new Set(trustedInstalledExtensionIds.map(id => id.trim()).filter(Boolean)),
  ];
  if (Object.keys(mergedEntries).length === 0 && trustedIds.length === 0) return sourcePlugins;

  const protectsActionApproval = Object.hasOwn(
    managedEntries,
    OpenClawExtensionId.ACTION_APPROVAL,
  );
  const existingAllow = Array.isArray(sourcePlugins.allow)
    ? sourcePlugins.allow.filter((value): value is string => typeof value === 'string')
    : Array.isArray(existingPlugins.allow)
      ? []
      : null;
  const existingDeny = Array.isArray(sourcePlugins.deny)
    ? sourcePlugins.deny.filter((value): value is string => typeof value === 'string')
    : null;
  const shouldPinInstalledExtensions = trustedIds.length > 0;
  const remainingDeny = existingDeny?.filter(
    id => id !== OpenClawExtensionId.ACTION_APPROVAL,
  );
  const allow = existingAllow
    ? [
        ...new Set([
          ...existingAllow,
          ...trustedIds,
          ...managedIds,
          ...(protectsActionApproval ? [OpenClawExtensionId.ACTION_APPROVAL] : []),
        ]),
      ]
    : shouldPinInstalledExtensions
      ? [
          ...new Set([
            ...trustedIds,
            ...managedIds,
            ...(protectsActionApproval ? [OpenClawExtensionId.ACTION_APPROVAL] : []),
          ]),
        ]
      : null;
  return {
    ...sourcePlugins,
    ...(protectsActionApproval ? { enabled: true } : {}),
    ...(allow ? { allow } : {}),
    ...(allow && sourcePlugins.bundledDiscovery === undefined
      ? { bundledDiscovery: 'compat' }
      : {}),
    ...(protectsActionApproval && existingDeny
      ? { deny: remainingDeny && remainingDeny.length > 0 ? remainingDeny : undefined }
      : {}),
    entries: mergedEntries,
  };
};

export const mergeOpenClawSkillConfig = (
  existingSkills: Record<string, unknown>,
  managedSkills: Record<string, unknown>,
): Record<string, unknown> => {
  const mergedSkills = { ...existingSkills, ...managedSkills };
  for (const key of ['load', 'entries', 'limits']) {
    if (isRecord(existingSkills[key]) && isRecord(managedSkills[key])) {
      mergedSkills[key] = {
        ...existingSkills[key],
        ...managedSkills[key],
      };
    }
  }
  return mergedSkills;
};

const mapExecutionModeToSandboxMode = (mode: CoworkExecutionMode): 'off' | 'non-main' | 'all' => {
  switch (mode) {
    case 'sandbox':
      return 'all';
    case 'auto':
      return 'non-main';
    case 'local':
    default:
      return 'off';
  }
};

export const resolveFileToolsWorkspaceOnly = (mode: PermissionModeValue): boolean =>
  mode !== PermissionMode.Full;

/**
 * Default agent timeout in seconds written to openclaw config.
 * Also used by the runtime adapter's client-side timeout watchdog.
 */
export const OPENCLAW_AGENT_TIMEOUT_SECONDS = 3600;
// Provider idle timeout for slow long-context model calls. This must be lower
// than the agent ceiling but higher than OpenClaw's default 120s.
export const OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS = 30 * 60;
// Context compaction has its own OpenClaw safety timeout. Keep it aligned with
// the provider ceiling so a healthy long-context SSE response is not aborted
// by the much shorter upstream default (180s).
export const OPENCLAW_COMPACTION_TIMEOUT_SECONDS = OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS;
// OpenClaw treats zero as "never archive" for completed run-mode subagents.
export const OPENCLAW_SUBAGENT_ARCHIVE_AFTER_MINUTES = 0;
// Keep model execution bounded while allowing a small per-parent backlog.
// These values are written to OpenClaw config so a future settings surface can
// replace the defaults without changing runtime admission behavior.
export const OPENCLAW_SUBAGENT_MAX_CONCURRENT =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.maxConcurrent;
export const OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.maxChildrenPerAgent;
// Allow substantial work while still terminating runaway subagent runs.
export const OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.runTimeoutSeconds;
export const OPENCLAW_MCP_TOOL_OWNER = 'bundle-mcp';
export const OPENCLAW_MAX_SKILLS_IN_PROMPT = 200;
export const OPENCLAW_MAX_SKILLS_PROMPT_CHARS = 50_000;
export const OPENCLAW_SESSION_PRUNE_AFTER = '365d';
export const OPENCLAW_SESSION_MAX_ENTRIES = 500;

export const buildManagedOpenClawSessionConfig = () => ({
  dmScope: 'per-account-channel-peer',
  reset: {
    mode: 'none',
  },
  maintenance: {
    mode: 'enforce',
    pruneAfter: OPENCLAW_SESSION_PRUNE_AFTER,
    maxEntries: OPENCLAW_SESSION_MAX_ENTRIES,
  },
});

export const buildManagedOpenClawSubagentConfig = (
  settings: AgentRuntimeSettings = createDefaultAgentRuntimeSettings(),
) => ({
  delegationMode: settings.subagents.delegationMode,
  maxSpawnDepth: settings.subagents.maxSpawnDepth,
  maxChildrenPerAgent: settings.subagents.maxChildrenPerAgent,
  maxConcurrent: settings.subagents.maxConcurrent,
  runTimeoutSeconds: settings.subagents.runTimeoutSeconds,
  archiveAfterMinutes: OPENCLAW_SUBAGENT_ARCHIVE_AFTER_MINUTES,
  ...(settings.subagents.model ? { model: settings.subagents.model } : {}),
  ...(settings.subagents.thinking ? { thinking: settings.subagents.thinking } : {}),
});

export const buildManagedOpenClawAgentThinkingConfig = (
  settings: AgentRuntimeSettings = createDefaultAgentRuntimeSettings(),
) => (settings.agent.thinking ? { thinkingDefault: settings.agent.thinking } : {});

export const buildManagedOpenClawHeartbeatConfig = () => ({
  every: '2h',
});

const buildDisabledOpenClawHeartbeatConfig = () => ({
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

export const buildManagedOpenClawConnectivityConfig = (
  browserMode: BrowserModeValue = BrowserMode.Isolated,
) => ({
  update: {
    checkOnStart: false,
    auto: {
      enabled: false,
    },
  },
  tools: {
    updatePlan: true,
    // OpenClaw v2026.8.1 owns native tool-directory discovery and hydration.
    toolSearch: {
      enabled: true,
      mode: 'directory',
    },
    deny: [
      'web_search',
      'tts',
      'message',
      'nodes',
      'gateway',
      'file_fetch',
      'dir_list',
      'dir_fetch',
      'file_write',
    ],
    web: {
      search: {
        enabled: false,
      },
      fetch: {
        enabled: true,
        // JustDo already passes its operator-controlled outbound proxy to the
        // Gateway. Let that proxy resolve hostnames so Fake-IP DNS does not
        // fail OpenClaw's pre-connect address checks.
        useTrustedEnvProxy: true,
        ssrfPolicy: {
          // Clash/Surge-style fake-IP DNS maps public hostnames into the
          // RFC 2544 benchmark range. OpenClaw blocks that range by default,
          // so opt into its narrow compatibility exception without allowing
          // private, loopback, link-local, or arbitrary reserved addresses.
          allowRfc2544BenchmarkRange: true,
        },
      },
    },
  },
  browser: {
    enabled: true,
    defaultProfile:
      browserMode === BrowserMode.User
        ? 'user'
        : browserMode === BrowserMode.Extension
          ? 'chrome'
          : 'openclaw',
    ...(browserMode === BrowserMode.User
      ? {
          profiles: {
            user: {
              driver: 'existing-session',
              attachOnly: true,
              color: '#00AA00',
            },
          },
        }
      : browserMode === BrowserMode.Extension
        ? {
            profiles: {
              chrome: {
                driver: 'extension',
                color: '#FF4500',
              },
            },
          }
        : {}),
    // Local execution can already reach the user's network through command
    // tools. Keep browser behavior consistent and allow proxy Fake-IP ranges
    // plus user-authorized LAN destinations without requiring hidden setup.
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true,
    },
  },
});

export const buildOpenClawConfigMeta = (
  version: string | null | undefined,
): Record<string, string> => ({
  lastTouchedVersion: version || 'unknown',
});

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortJsonValue(value[key])]),
  );
};

export const hasOpenClawConfigChanged = (
  currentContent: string,
  nextConfig: Record<string, unknown>,
): boolean => {
  try {
    const currentConfig = JSON.parse(currentContent) as unknown;
    if (!isRecord(currentConfig)) {
      return true;
    }
    return (
      JSON.stringify(sortJsonValue(currentConfig)) !== JSON.stringify(sortJsonValue(nextConfig))
    );
  } catch {
    return true;
  }
};

const verifyOpenClawConfigMatches = (
  configPath: string,
  expectedConfig: Record<string, unknown>,
): OpenClawConfigVerification => {
  let actualContent: string;
  try {
    actualContent = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read back OpenClaw config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (hasOpenClawConfigChanged(actualContent, expectedConfig)) {
    return {
      ok: false,
      error: `OpenClaw config read-back verification failed at ${configPath}: persisted content does not match the requested config.`,
    };
  }

  return { ok: true };
};

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const normalizeModelName = (modelId: string): string => {
  const trimmed = modelId.trim();
  if (!trimmed) return 'default-model';
  const slashIndex = trimmed.lastIndexOf('/');
  const name = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  // Ensure the result is never empty after stripping prefix
  return name.trim() || 'default-model';
};

/**
 * Resolve the effective model display name with fallback chain:
 * userModelName → normalizeModelName(modelId) → 'default-model'
 */
const resolveModelDisplayName = (modelId: string, userModelName?: string): string => {
  const userName = userModelName?.trim();
  if (userName) return userName;
  return normalizeModelName(modelId);
};

/**
 * Build the env var name for a provider's apiKey.
 * Must match the key format produced by resolveAllProviderApiKeys() in providerApiConfig.ts.
 */
const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `JUSTDO_APIKEY_${envName}`;
};

type OpenClawProviderApi = 'openai-completions';

type OpenClawProviderSelection = {
  providerId: string;
  legacyModelId: string;
  sessionModelId: string;
  primaryModel: string;
  providerConfig: {
    baseUrl: string;
    api: OpenClawProviderApi;
    apiKey: string;
    auth: 'api-key';
    timeoutSeconds: number;
    models: Array<{
      id: string;
      name: string;
      api: OpenClawProviderApi;
      input: string[];
      reasoning?: boolean;
      compat: {
        supportsUsageInStreaming: true;
      };
      cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
};

/**
 * Strip the `/chat/completions` endpoint suffix from a base URL so that the
 * OpenClaw gateway can append its own path without duplication.
 *
 * e.g. "https://gw.example.com/v1/chat/completions" → "https://gw.example.com/v1"
 *      "https://gw.example.com/v1"                   → "https://gw.example.com/v1"  (unchanged)
 */
const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) {
    return normalized.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return normalized;
};

// ═══════════════════════════════════════════════════════
// Provider Descriptor Registry
// ═══════════════════════════════════════════════════════

type ProviderDescriptor = {
  providerId: string;
  normalizeBaseUrl: (rawBaseUrl: string) => string;
  resolveApiKey?: (ctx: { apiKey: string; providerName: string }) => string;
  resolveSessionModelId?: (modelId: string) => string;
  /**
   * 动态计算 baseUrl，完全覆盖 normalizeBaseUrl 的结果。
   * 用于 baseUrl 由运行时环境决定（如代理端口）而非用户配置的场景。
   * 返回 null 表示降级使用 normalizeBaseUrl。
   */
  resolveRuntimeBaseUrl?: () => string | null;
  /**
   * 基于 modelId 动态计算 reasoning 标志。
   * 优先级高于 modelDefaults.reasoning。
   */
  resolveModelReasoning?: (modelId: string) => boolean | undefined;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {};

const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.JustDo,
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

const resolveDescriptor = (providerName: string): ProviderDescriptor => {
  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || OpenClawProviderId.JustDo,
  };
};

export const buildProviderSelection = (options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  apiType: 'openai' | undefined;
  providerName?: string;
  supportsImage?: boolean;
  modelName?: string;
  displayName?: string;
  contextLength?: number; // 用户配置的上下文窗口长度
  maxTokens?: number; // 用户配置的最大输出 token 数量
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const descriptor = resolveDescriptor(providerName);
  const effectiveProviderId = isJustDoCustomProviderKey(providerName)
    ? normalizeOpenClawProviderId(
        getEffectiveCustomProviderDisplayName(providerName, options.displayName),
      )
    : normalizeOpenClawProviderId(descriptor.providerId);

  let baseUrl =
    descriptor.resolveRuntimeBaseUrl?.() ?? descriptor.normalizeBaseUrl(options.baseURL);
  const api = OpenClawApiConst.OpenAICompletions as OpenClawProviderApi;
  // apiKey placeholder still uses original providerName for env var consistency
  const apiKey = descriptor.resolveApiKey
    ? descriptor.resolveApiKey({ apiKey: options.apiKey, providerName })
    : `\${${providerApiKeyEnvVar(providerName)}}`;
  const sessionModelId = descriptor.resolveSessionModelId
    ? descriptor.resolveSessionModelId(options.modelId)
    : options.modelId;

  const providerModelName = resolveModelDisplayName(sessionModelId, options.modelName);
  const modelInput: string[] = options.supportsImage ? ['text', 'image'] : ['text'];

  // reasoning：descriptor 动态计算 > modelDefaults 静态值
  const reasoning = descriptor.resolveModelReasoning
    ? descriptor.resolveModelReasoning(options.modelId)
    : descriptor.modelDefaults?.reasoning;

  // Fallback defaults when the user hasn't explicitly set these values in Settings.
  // Without defaults, OpenClaw and providers fall back to their own internal
  // defaults (e.g. 8192 for max_completion_tokens) which can conflict with
  // thinking model budgets.
  const effectiveContextWindow =
    options.contextLength ?? descriptor.modelDefaults?.contextWindow ?? 200_000;
  const effectiveMaxTokens = options.maxTokens ?? descriptor.modelDefaults?.maxTokens ?? 32_000;

  return {
    providerId: effectiveProviderId,
    legacyModelId: options.modelId,
    sessionModelId,
    primaryModel: `${effectiveProviderId}/${sessionModelId}`,
    providerConfig: {
      baseUrl,
      api,
      apiKey,
      auth: 'api-key' as const,
      timeoutSeconds: OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
      models: [
        {
          id: sessionModelId,
          name: providerModelName,
          api,
          input: modelInput,
          compat: {
            supportsUsageInStreaming: true,
          },
          ...(reasoning !== undefined ? { reasoning } : { reasoning: true }),
          ...(descriptor.modelDefaults?.cost ? { cost: descriptor.modelDefaults.cost } : {}),
          ...(effectiveContextWindow ? { contextWindow: effectiveContextWindow } : {}),
          ...(effectiveMaxTokens ? { maxTokens: effectiveMaxTokens } : {}),
        },
      ],
    },
  };
};

export const resolvePermissionPolicy = (mode: PermissionModeValue) => {
  switch (mode) {
    case PermissionMode.Full:
      return {
        security: 'full' as const,
        ask: 'off' as const,
        askFallback: 'full' as const,
      };
    case PermissionMode.Auto:
    case PermissionMode.Ask:
      return {
        security: 'allowlist' as const,
        ask: 'on-miss' as const,
        askFallback: 'deny' as const,
      };
  }
};

type ManagedMemorySearchConfig =
  | {
      enabled: true;
      provider: string;
      model: string;
      remote: {
        baseUrl: string;
        apiKey: string;
        headers: Record<string, string>;
      };
    }
  | { enabled: false };

export const buildBuiltinMemorySearchConfig = (
  providers: ProviderRawConfig[],
): ManagedMemorySearchConfig => {
  const provider = providers.find(candidate => candidate.providerName === ProviderName.BuiltinModels);
  const model = provider?.embeddingModels
    .filter(candidate => candidate.id.trim())
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
  if (!provider || !model) {
    return { enabled: false };
  }

  const selection = buildProviderSelection({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    modelId: model.id,
    apiType: provider.apiType,
    providerName: provider.providerName,
    modelName: model.name,
    displayName: provider.displayName,
  });
  return {
    enabled: true,
    provider: OpenClawExtensionId.JUSTDO_RUNTIME_BRIDGE,
    model: selection.sessionModelId,
    remote: {
      baseUrl: selection.providerConfig.baseUrl,
      apiKey: selection.providerConfig.apiKey,
      headers: {
        'User-Agent': OPENAI_REQUEST_USER_AGENT,
      },
    },
  };
};

const withMemorySearch = (
  config: Record<string, unknown>,
  search: ManagedMemorySearchConfig,
): Record<string, unknown> => {
  const memory = isRecord(config.memory) ? config.memory : {};
  return {
    ...config,
    memory: {
      ...memory,
      search,
    },
  };
};

const readPreinstalledPluginIds = (): string[] => {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const plugins = pkg.openclaw?.plugins;
    if (!Array.isArray(plugins)) return [];
    return plugins
      .map((p: { id?: string }) => p.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
};

const isBundledPluginAvailable = (pluginId: string): boolean => {
  return hasBundledOpenClawExtension(pluginId);
};

export const listManagedOpenClawPluginIds = (): string[] => [
  ...new Set([
    ...readPreinstalledPluginIds().filter(id => isBundledPluginAvailable(id)),
    ...bundledOpenClawExtensions
      .filter(extension => isBundledPluginAvailable(extension.id))
      .map(extension => extension.id),
    'workboard',
  ]),
];
export type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configChanged: boolean;
  requiresGatewayRestart: boolean;
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
};

const buildVerifiedConfigSyncResult = (
  configPath: string,
  expectedConfig: Record<string, unknown>,
  changed: boolean,
): OpenClawConfigSyncResult => {
  const verification = verifyOpenClawConfigMatches(configPath, expectedConfig);
  if (!verification.ok) {
    return {
      ok: false,
      changed: false,
      configChanged: false,
      requiresGatewayRestart: false,
      configPath,
      error: verification.error,
    };
  }
  return {
    ok: true,
    changed,
    configChanged: changed,
    requiresGatewayRestart: false,
    configPath,
  };
};

type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getCoworkConfig: () => CoworkConfig;
  getAgentRuntimeSettings?: () => AgentRuntimeSettings;
  getAskUserExtensionConfig?: () => AskUserExtensionConfig | null;
  getMcpServers?: () => McpServerRecord[];
  getHooks?: () => OpenClawHookRecord[];
  getAgents?: () => Agent[];
  getBrowserMode?: () => BrowserModeValue;
};

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly getAgentRuntimeSettings: () => AgentRuntimeSettings;
  private readonly getAskUserExtensionConfig?: () => AskUserExtensionConfig | null;
  private readonly getMcpServers?: () => McpServerRecord[];
  private readonly getHooks?: () => OpenClawHookRecord[];
  private readonly getAgents?: () => Agent[];
  private readonly getBrowserMode?: () => BrowserModeValue;

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getCoworkConfig = deps.getCoworkConfig;
    this.getAgentRuntimeSettings =
      deps.getAgentRuntimeSettings ?? createDefaultAgentRuntimeSettings;
    this.getAskUserExtensionConfig = deps.getAskUserExtensionConfig;
    this.getMcpServers = deps.getMcpServers;
    this.getHooks = deps.getHooks;
    this.getAgents = deps.getAgents;
    this.getBrowserMode = deps.getBrowserMode;
  }

  sync(reason: string): OpenClawConfigSyncResult {
    const configPath = this.engineManager.getConfigPath();
    const isAuthLifecycleSync =
      reason === BuiltinModelSyncReason.AuthLogin ||
      reason === BuiltinModelSyncReason.AuthLogout;
    let currentContent = '';
    let existingConfig: Record<string, unknown> | null = null;
    let existingPlugins: Record<string, unknown> = {};
    let existingSkills: Record<string, unknown> = {};
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
      const parsedConfig = JSON.parse(currentContent) as unknown;
      if (isRecord(parsedConfig)) {
        existingConfig = parsedConfig;
        if (isRecord(parsedConfig.plugins)) {
          existingPlugins = parsedConfig.plugins;
        }
        if (isRecord(parsedConfig.skills)) {
          existingSkills = parsedConfig.skills;
        }
      }
    } catch {
      currentContent = '';
    }
    const coworkConfig = this.getCoworkConfig();
    const providerNameValidation = validateConfiguredOpenClawProviderNames();
    if (providerNameValidation.ok === false) {
      const reason =
        providerNameValidation.reason === 'reserved'
          ? 'is reserved by OpenClaw'
          : providerNameValidation.reason === 'duplicate'
            ? 'duplicates another enabled provider name'
            : 'has an invalid format';
      return {
        ok: false,
        changed: false,
        configChanged: false,
        requiresGatewayRestart: false,
        configPath,
        error: `OpenClaw config sync failed: custom provider name "${providerNameValidation.displayName}" ${reason}. Rename it in Settings before starting the engine.`,
      };
    }
    const apiResolution = resolveRawApiConfig();

    if (!apiResolution.config) {
      // No API/model configured yet (fresh install). Write a minimal config so
      // the gateway can start; it just won't have a model provider until the
      // user configures one.
      const result = this.writeMinimalConfig(configPath, reason);
      const workspaceDir = (coworkConfig.workingDirectory || '').trim();
      const defaultWorkspaceDir = path.join(this.engineManager.getStateDir(), 'workspace');
      const resolvedWorkspaceDir = workspaceDir || defaultWorkspaceDir;
      if (!isAuthLifecycleSync) {
        this.repairWorkspaceState(resolvedWorkspaceDir);
        this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
      }
      return result;
    }

    let allProvidersMap: Record<string, OpenClawProviderSelection['providerConfig']> = {};
    let primaryModel = '';
    let providerSelection: OpenClawProviderSelection | null = null;
    let memorySearchConfig: ManagedMemorySearchConfig = { enabled: false };
    if (apiResolution.config) {
      const { baseURL, apiKey, model, apiType } = apiResolution.config;
      const modelId = model.trim();
      if (!modelId) {
        return {
          ok: false,
          changed: false,
          configChanged: false,
          requiresGatewayRestart: false,
          configPath,
          error: 'OpenClaw config sync failed: resolved model is empty.',
        };
      }

      const providerName = apiResolution.providerMetadata?.providerName ?? '';
      providerSelection = buildProviderSelection({
        apiKey,
        baseURL,
        modelId,
        apiType,
        providerName,
        supportsImage: apiResolution.providerMetadata?.supportsImage,
        modelName: apiResolution.providerMetadata?.modelName,
        displayName: apiResolution.providerMetadata?.displayName,
        contextLength: apiResolution.providerMetadata?.contextLength,
        maxTokens: apiResolution.providerMetadata?.maxTokens,
      });
      primaryModel = providerSelection.primaryModel;

      const enabledProviders = resolveAllEnabledProviderConfigs();
      memorySearchConfig = buildBuiltinMemorySearchConfig(enabledProviders);
      for (const p of enabledProviders) {
        for (const m of [...p.models, ...p.embeddingModels]) {
          const sel = buildProviderSelection({
            apiKey: p.apiKey,
            baseURL: p.baseURL,
            modelId: m.id,
            apiType: p.apiType,
            providerName: p.providerName,
            supportsImage: m.supportsImage,
            modelName: m.name,
            displayName: p.displayName,
            contextLength: m.contextLength,
            maxTokens: m.maxTokens,
          });
          if (!allProvidersMap[sel.providerId]) {
            allProvidersMap[sel.providerId] = { ...sel.providerConfig, models: [] };
          }
          const existing = allProvidersMap[sel.providerId];
          const alreadyHas = existing.models.some(em => em.id === sel.providerConfig.models[0]?.id);
          if (!alreadyHas && sel.providerConfig.models.length > 0) {
            existing.models.push(...sel.providerConfig.models);
          }
        }
      }

      if (!allProvidersMap[providerSelection.providerId]) {
        allProvidersMap[providerSelection.providerId] = providerSelection.providerConfig;
      } else {
        const existing = allProvidersMap[providerSelection.providerId];
        const alreadyHas = existing.models.some(
          em => em.id === providerSelection.providerConfig.models[0]?.id,
        );
        if (!alreadyHas && providerSelection.providerConfig.models.length > 0) {
          existing.models.push(...providerSelection.providerConfig.models);
        }
      }
    }

    const sandboxMode = mapExecutionModeToSandboxMode(coworkConfig.executionMode || 'local');

    const workspaceDir = (coworkConfig.workingDirectory || '').trim();
    // Default workspace to stateDir/workspace so skills are found in stateDir/skills
    const defaultWorkspaceDir = path.join(this.engineManager.getStateDir(), 'workspace');
    const resolvedWorkspaceDir = workspaceDir ? path.resolve(workspaceDir) : defaultWorkspaceDir;
    if (!isAuthLifecycleSync) {
      this.repairWorkspaceState(resolvedWorkspaceDir);
    }

    const preinstalledPluginIds = readPreinstalledPluginIds().filter(id =>
      isBundledPluginAvailable(id),
    );
    const askUserHostConfig = this.getAskUserExtensionConfig?.() ?? null;
    const agentRuntimeSettings = this.getAgentRuntimeSettings();
    const askUserConfig = askUserHostConfig
      ? {
          ...askUserHostConfig,
          timeoutMinutes: agentRuntimeSettings.askUserQuestion.timeoutMinutes,
        }
      : null;
    const bundledExtensionEntries = {
      [OpenClawExtensionId.BROWSER]: { enabled: true },
      ...buildBundledExtensionEntries(
        {
          askUser: askUserConfig,
          permissionMode: coworkConfig.permissionMode,
        },
        isBundledPluginAvailable,
      ),
    };
    const mcpServers = buildOpenClawMcpServers(
      this.getMcpServers?.() ?? [],
      agentRuntimeSettings.mcp.requestTimeoutSeconds,
    );
    const trustedInstalledExtensionIds = listInstalledOpenClawExtensionIds(
      this.engineManager.getStateDir(),
    );
    const availableExtensionIds = listAvailableOpenClawExtensionIds(
      this.engineManager.getStateDir(),
      existingPlugins,
      listKnownOpenClawWorkspaceDirs({
        stateDir: this.engineManager.getStateDir(),
        mainWorkspaceDir: resolvedWorkspaceDir,
        agents: this.getAgents?.() ?? [],
        existingConfig,
      }),
    );
    const hookConfig = buildOpenClawHookConfig(this.getHooks?.() ?? []);
    const connectivityConfig = buildManagedOpenClawConnectivityConfig(this.getBrowserMode?.());
    const connectivityTools: Record<string, unknown> = connectivityConfig.tools;

    const managedModels: Record<string, unknown> = {
      mode: 'replace',
      providers: allProvidersMap,
    };
    const availableModelRefs = new Set(
      Object.entries(allProvidersMap).flatMap(([providerId, provider]) =>
        provider.models.map(model => `${providerId}/${model.id}`),
      ),
    );

    const managedConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        bind: 'loopback',
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowedOrigins: ['*'],
        },
      },
      models: managedModels,
      diagnostics: {
        otel: {
          enabled: false,
        },
      },
      memory: {
        search: memorySearchConfig,
      },
      agents: {
        defaults: {
          timeoutSeconds: OPENCLAW_AGENT_TIMEOUT_SECONDS,
          ...buildManagedOpenClawAgentThinkingConfig(agentRuntimeSettings),
          model: {
            primary: primaryModel,
          },
          sandbox: {
            mode: sandboxMode,
          },
          heartbeat: buildDisabledOpenClawHeartbeatConfig(),
          compaction: buildManagedOpenClawCompactionConfig(),
          workspace: resolvedWorkspaceDir,
          subagents: buildManagedOpenClawSubagentConfig(agentRuntimeSettings),
        },
        ...this.buildAgentsEntries(primaryModel, availableModelRefs, resolvedWorkspaceDir),
      },
      session: buildManagedOpenClawSessionConfig(),
      commands: {
        // Internal `chat.send` turns identify the sender as bare `gateway-client`.
        // Prefixing with `webchat:` does not round-trip through owner resolution,
        // so owner-only tools like `cron` never become available.
        // Native IM channel senders use their platform user ID (e.g. telegram:xxx),
        // which would not match `gateway-client`. Use wildcard so all senders that
        // pass the per-channel allowFrom gate are also recognised as owners.
        ownerAllowFrom: ['gateway-client', '*'],
        mcp: true,
        plugins: true,
      },
      mcp: {
        servers: mcpServers,
      },
      ...hookConfig,
      update: connectivityConfig.update,
      tools: {
        ...connectivityTools,
        fs: {
          ...(isRecord(connectivityTools.fs) ? connectivityTools.fs : {}),
          workspaceOnly: resolveFileToolsWorkspaceOnly(coworkConfig.permissionMode),
        },
        exec: {
          ...(isRecord(connectivityTools.exec) ? connectivityTools.exec : {}),
          host: 'gateway',
          mode: coworkConfig.permissionMode,
        },
        // OpenClaw applies an additional tool gate to sandboxed turns. Native
        // MCP tools belong to bundle-mcp, so explicitly allow that owner when
        // executionMode maps to `all` or `non-main`. This is harmless when the
        // sandbox is off and keeps one stable generated config across modes.
        sandbox: {
          tools: {
            alsoAllow: [OPENCLAW_MCP_TOOL_OWNER],
          },
        },
        loopDetection: {
          enabled: true,
        },
      },
      browser: connectivityConfig.browser,
      // skills.update writes user choices such as entries.<id>.enabled here.
      // Preserve those Gateway-owned settings across JustDo startup syncs.
      skills: mergeOpenClawSkillConfig(existingSkills, {
        limits: {
          maxSkillsInPrompt: OPENCLAW_MAX_SKILLS_IN_PROMPT,
          maxSkillsPromptChars: OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
        },
      }),
      cron: {
        enabled: true,
        sessionRetention: '7d',
      },
      ...(() => {
        const pluginEntries: Record<string, unknown> = {
          ...Object.fromEntries(
            preinstalledPluginIds.map(id => {
              // IM channel plugins removed — all plugins stay enabled by default.
              return [id, { enabled: true }];
            }),
          ),
          ...bundledExtensionEntries,
          workboard: { enabled: true },
        };

        const mergedPlugins = mergeOpenClawPluginConfig(
          existingPlugins,
          pluginEntries,
          trustedInstalledExtensionIds,
          availableExtensionIds,
        );
        return Object.keys(mergedPlugins).length > 0
          ? {
              // Plugin installs and setup commands write user-owned entries and
              // exclusive slots here. Keep them while managed bundled entries win.
              plugins: mergedPlugins,
            }
          : {};
      })(),
      meta: buildOpenClawConfigMeta(this.engineManager.getDesiredVersion()),
    };

    // IM channel config syncing removed — channels disabled pending future adaptation

    const configToPersist =
      isAuthLifecycleSync && existingConfig
        ? buildAuthScopedOpenClawConfig(existingConfig, managedConfig, reason)
        : managedConfig;
    const nextContent = `${JSON.stringify(configToPersist, null, 2)}\n`;
    const configChanged = hasOpenClawConfigChanged(currentContent, configToPersist);
    const extensionContractsChanged = isAuthLifecycleSync
      ? false
      : buildBundledExtensionToolContracts(
          {
            askUser: askUserConfig,
            permissionMode: coworkConfig.permissionMode,
          },
          isBundledPluginAvailable,
        ).reduce(
          (changed, contract) =>
            this.syncExtensionToolContracts(contract.id, contract.tools) || changed,
          false,
        );

    if (configChanged) {
      try {
        ensureDir(path.dirname(configPath));
        const tmpPath = `${configPath}.tmp-${Date.now()}`;
        fs.writeFileSync(tmpPath, nextContent, 'utf8');
        fs.renameSync(tmpPath, configPath);
      } catch (error) {
        return {
          ok: false,
          changed: false,
          configChanged: false,
          requiresGatewayRestart: false,
          configPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const verification = verifyOpenClawConfigMatches(configPath, configToPersist);
    if (!verification.ok) {
      return {
        ok: false,
        changed: false,
        configChanged: false,
        requiresGatewayRestart: false,
        configPath,
        error: verification.error,
      };
    }

    if (!isAuthLifecycleSync) {
      // Sync per-agent workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for non-main agents
      this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
    }

    return {
      ok: true,
      changed: configChanged || extensionContractsChanged,
      configChanged,
      requiresGatewayRestart: extensionContractsChanged,
      configPath,
    };
  }

  private syncExtensionToolContracts(extensionId: string, nextToolNames: string[]): boolean {
    const extensionsDir = this.findBundledExtensionsDir();
    if (!extensionsDir) {
      return false;
    }

    const manifestPath = path.join(extensionsDir, extensionId, 'openclaw.plugin.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      console.warn(
        `[OpenClawConfigSync] failed to read ${extensionId} manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    const contracts = isRecord(manifest.contracts) ? manifest.contracts : {};
    const currentTools = Array.isArray(contracts.tools)
      ? contracts.tools.filter((value): value is string => typeof value === 'string')
      : [];

    if (JSON.stringify(currentTools) === JSON.stringify(nextToolNames)) {
      return false;
    }

    manifest.contracts = {
      ...contracts,
      tools: nextToolNames,
    };

    try {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      console.log(
        `[OpenClawConfigSync] synced ${extensionId} contracts.tools (${nextToolNames.length})`,
      );
      return true;
    } catch (error) {
      console.warn(
        `[OpenClawConfigSync] failed to write ${extensionId} manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private findBundledExtensionsDir(): string | null {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'cfmind', 'dist', 'extensions')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current', 'dist', 'extensions'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current', 'dist', 'extensions'),
        ];

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // Ignore missing candidates.
      }
    }
    return null;
  }

  /**
   * Collect all secret values that should be injected as environment variables
   * into the OpenClaw gateway process. The openclaw.json file uses `${VAR}`
   * placeholders for these values so that no plaintext secrets are stored on disk.
   */
  collectSecretEnvVars(): Record<string, string> {
    const env: Record<string, string> = {};

    // Provider API Keys — one per configured provider so switching models
    // never changes env vars and avoids gateway process restarts.
    const allApiKeys = resolveAllProviderApiKeys();
    for (const [envSuffix, apiKey] of Object.entries(allApiKeys)) {
      env[`JUSTDO_APIKEY_${envSuffix}`] = apiKey;
    }
    // Legacy fallback: keep JUSTDO_PROVIDER_API_KEY set to a stable value so stale
    // openclaw.json files with the old placeholder don't crash the gateway.
    // Use the active provider's key if available, but ONLY for the first sync —
    // after that, openclaw.json uses provider-specific placeholders and this var
    // is never resolved. Use a fixed value to avoid secretEnvVarsChanged on switch.
    env.JUSTDO_PROVIDER_API_KEY = 'legacy-unused';

    const askUserConfig = this.getAskUserExtensionConfig?.();
    env.JUSTDO_ASK_USER_SECRET = askUserConfig?.secret || 'unconfigured';

    // IM channel secrets removed — channels disabled pending future adaptation

    return env;
  }

  /**
   * Build the canonical `agents.entries` roster for openclaw.json.
   *
   * The main agent uses the user's configured workspace directory through
   * `agents.defaults.workspace`. Non-main agents omit `workspace`, so current
   * OpenClaw resolves them under `<defaults.workspace>/<normalizedAgentId>`.
   *
   * Per-agent `identity` (name, emoji) is set from the agent database so
   * OpenClaw picks it up natively.
   */
  private buildAgentsEntries(
    defaultPrimaryModel: string,
    availableModelRefs: ReadonlySet<string>,
    mainWorkspaceDir: string,
  ): { ownership: 'explicit'; entries: Record<string, Record<string, unknown>> } {
    const agents = (this.getAgents?.() ?? []).filter(agent => agent.id !== ScheduledTaskAgentId);
    const mainAgent = agents.find(agent => agent.id === 'main');
    const displayNameMap = getProviderDisplayNameMap();

    const list = [
      mainAgent
        ? buildAgentEntry(mainAgent, defaultPrimaryModel, displayNameMap)
        : {
            id: 'main',
            default: true,
            model: {
              primary: defaultPrimaryModel,
            },
            // Enable reasoning stream so thinking events are emitted via WebSocket
            reasoningDefault: 'stream',
          },
      ...buildManagedAgentEntries({
        agents,
        fallbackPrimaryModel: defaultPrimaryModel,
        displayNameMap,
      }),
      {
        id: ScheduledTaskAgentId,
        model: {
          primary: defaultPrimaryModel,
        },
        workspace: mainWorkspaceDir,
        tools: {
          fs: { workspaceOnly: false },
          exec: { host: 'gateway', mode: PermissionMode.Full },
        },
      },
    ].map(entry => {
      const constrainedEntry = constrainAgentEntryToAvailableModels(
        entry,
        defaultPrimaryModel,
        availableModelRefs,
      );
      return applyManagedOpenClawHeartbeatConfig(constrainedEntry);
    });

    const entries = Object.fromEntries(
      list.map(entry => {
        const agentId = normalizeOpenClawAgentId(String(entry.id || 'main'));
        return [agentId, canonicalizeAgentEntry(entry)];
      }),
    );

    return { ownership: 'explicit', entries };
  }

  /**
   * 不再向 agent workspace 写入任何 JustDo 内容。
   * OpenClaw 自己管理 agent workspace。
   */
  private syncPerAgentWorkspaces(_mainWorkspaceDir: string, _coworkConfig: CoworkConfig): void {
    // 空实现：让 OpenClaw 自己管理 agent workspace
  }

  private repairWorkspaceState(workspaceDir: string): void {
    const result = repairOpenClawWorkspaceState(workspaceDir, this.engineManager.getStateDir());
    if (result === 'state-repaired') {
      console.warn(
        `[OpenClawConfigSync] Repaired missing workspace state for intact workspace: ${workspaceDir}`,
      );
    } else if (result === 'reset-attestation-removed') {
      console.warn(
        `[OpenClawConfigSync] Removed workspace attestation after user reset: ${workspaceDir}`,
      );
    }
  }

  /** Write a file only if its content has changed. */
  private syncFileIfChanged(filePath: string, content: string): void {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return;
    } catch {
      // File doesn't exist yet
    }
    if (content) {
      this.atomicWriteFile(filePath, content);
    } else {
      // Empty content — create empty file if it doesn't exist
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
    }
  }

  /** Atomic file write via tmp + rename, consistent with openclaw.json writes. */
  private atomicWriteFile(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Write a minimal openclaw.json that lets the gateway start without any
   * model/provider configured.  The full config will be synced once the
   * user sets up a model in the UI.
   */
  private writeMinimalConfig(configPath: string, reason: string): OpenClawConfigSyncResult {
    const coworkConfig = this.getCoworkConfig();
    const configuredWorkspaceDir = (coworkConfig.workingDirectory || '').trim();
    const resolvedWorkspaceDir = configuredWorkspaceDir
      ? path.resolve(configuredWorkspaceDir)
      : path.join(this.engineManager.getStateDir(), 'workspace');
    const hookConfig = buildOpenClawHookConfig(this.getHooks?.() ?? []);
    const connectivityConfig = buildManagedOpenClawConnectivityConfig(this.getBrowserMode?.());
    const connectivityTools: Record<string, unknown> = connectivityConfig.tools;
    const askUserHostConfig = this.getAskUserExtensionConfig?.() ?? null;
    const agentRuntimeSettings = this.getAgentRuntimeSettings();
    const mcpServers = buildOpenClawMcpServers(
      this.getMcpServers?.() ?? [],
      agentRuntimeSettings.mcp.requestTimeoutSeconds,
    );
    const askUserConfig = askUserHostConfig
      ? {
          ...askUserHostConfig,
          timeoutMinutes: agentRuntimeSettings.askUserQuestion.timeoutMinutes,
        }
      : null;
    const bundledExtensionEntries = {
      [OpenClawExtensionId.BROWSER]: { enabled: true },
      ...buildBundledExtensionEntries(
        {
          askUser: askUserConfig,
          permissionMode: coworkConfig.permissionMode,
        },
        isBundledPluginAvailable,
      ),
    };
    const trustedInstalledExtensionIds = listInstalledOpenClawExtensionIds(
      this.engineManager.getStateDir(),
    );
    const minimalConfig: Record<string, unknown> = withMemorySearch({
      gateway: {
        mode: 'local',
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowedOrigins: ['*'],
        },
      },
      models: {},
      diagnostics: {
        otel: {
          enabled: false,
        },
      },
      agents: {
        ownership: 'explicit',
        defaults: {
          ...buildManagedOpenClawAgentThinkingConfig(agentRuntimeSettings),
          heartbeat: buildDisabledOpenClawHeartbeatConfig(),
          compaction: buildManagedOpenClawCompactionConfig(),
          subagents: buildManagedOpenClawSubagentConfig(agentRuntimeSettings),
          workspace: resolvedWorkspaceDir,
        },
        entries: {
          main: {
            reasoningDefault: 'stream',
            heartbeat: buildManagedOpenClawHeartbeatConfig(),
          },
          [ScheduledTaskAgentId]: {
            workspace: resolvedWorkspaceDir,
            tools: {
              fs: { workspaceOnly: false },
              exec: { host: 'gateway', mode: PermissionMode.Full },
            },
          },
        },
      },
      session: buildManagedOpenClawSessionConfig(),
      mcp: {
        servers: mcpServers,
      },
      ...connectivityConfig,
      ...hookConfig,
      tools: {
        ...connectivityTools,
        fs: {
          ...(isRecord(connectivityTools.fs) ? connectivityTools.fs : {}),
          workspaceOnly: resolveFileToolsWorkspaceOnly(coworkConfig.permissionMode),
        },
        exec: {
          ...(isRecord(connectivityTools.exec) ? connectivityTools.exec : {}),
          host: 'gateway',
          mode: coworkConfig.permissionMode,
        },
      },
      plugins: mergeOpenClawPluginConfig(
        {},
        bundledExtensionEntries,
        trustedInstalledExtensionIds,
      ),
      meta: buildOpenClawConfigMeta(this.engineManager.getDesiredVersion()),
      // The managed permission extension is part of Gateway readiness even
      // before a model is configured. Runtime extensions are precompiled.
    }, { enabled: false });

    const nextContent = `${JSON.stringify(minimalConfig, null, 2)}\n`;
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    const isAuthLifecycleSync =
      reason === BuiltinModelSyncReason.AuthLogin ||
      reason === BuiltinModelSyncReason.AuthLogout;
    if (isAuthLifecycleSync && currentContent && currentContent !== nextContent) {
      try {
        const existing = JSON.parse(currentContent);
        if (isRecord(existing)) {
          const sanitizedConfig = buildAuthScopedOpenClawConfig(
            existing,
            minimalConfig,
            reason,
          );
          const sanitizedContent = `${JSON.stringify(sanitizedConfig, null, 2)}\n`;
          if (hasOpenClawConfigChanged(currentContent, sanitizedConfig)) {
            ensureDir(path.dirname(configPath));
            const tmpPath = `${configPath}.tmp-${Date.now()}`;
            fs.writeFileSync(tmpPath, sanitizedContent, 'utf8');
            fs.renameSync(tmpPath, configPath);
            return buildVerifiedConfigSyncResult(configPath, sanitizedConfig, true);
          }
          return buildVerifiedConfigSyncResult(configPath, sanitizedConfig, false);
        }
      } catch {
        // Malformed JSON falls through to a complete minimal-config rewrite.
      }
    }

    // If the file already has a meaningful config (from a previous sync or
    // user configuration), don't downgrade it to the minimal version.
    // Check for models (API configured), plugin entries, or gateway.mode already set.
    // Authentication sync was sanitized above so unrelated user-owned config survives.
    if (
      reason !== BuiltinModelSyncReason.AuthLogout &&
      currentContent &&
      currentContent !== nextContent
    ) {
      try {
        const existing = JSON.parse(currentContent);
        if (isRecord(existing)) {
          const canonicalExisting = sanitizeOpenClawV2026_8_1Config(existing);
          const hasHookConfig = Object.keys(hookConfig).length > 0;
          const hasSubstantiveConfig =
            Boolean(isRecord(canonicalExisting.models) && canonicalExisting.models.providers) ||
            Boolean(isRecord(canonicalExisting.plugins) && canonicalExisting.plugins.entries) ||
            Boolean(isRecord(canonicalExisting.gateway) && canonicalExisting.gateway.mode);
          if (hasHookConfig || hasSubstantiveConfig) {
            const existingDiagnostics = isRecord(canonicalExisting.diagnostics)
              ? canonicalExisting.diagnostics
              : {};
            const existingAgents = isRecord(canonicalExisting.agents)
              ? canonicalExisting.agents
              : {};
            const existingDefaults = isRecord(existingAgents.defaults)
              ? existingAgents.defaults
              : {};
            const minimalAgents = isRecord(minimalConfig.agents) ? minimalConfig.agents : {};
            const minimalEntries = isRecord(minimalAgents.entries) ? minimalAgents.entries : {};
            const existingEntries = isRecord(existingAgents.entries)
              ? existingAgents.entries
              : {};
            const mergedDefaults: Record<string, unknown> = {
              ...existingDefaults,
              // Replace rather than deep-merge so stale managed keys are removed.
              compaction: buildManagedOpenClawCompactionConfig(),
            };
            if (agentRuntimeSettings.agent.thinking) {
              mergedDefaults.thinkingDefault = agentRuntimeSettings.agent.thinking;
            } else {
              delete mergedDefaults.thinkingDefault;
            }
            const existingTools = removeRetiredManagedToolDenyEntries(
              isRecord(canonicalExisting.tools) ? canonicalExisting.tools : {},
            );
            const existingFileTools = isRecord(existingTools.fs) ? existingTools.fs : {};
            const existingExecTools = isRecord(existingTools.exec) ? existingTools.exec : {};
            const existingPlugins = isRecord(canonicalExisting.plugins)
              ? canonicalExisting.plugins
              : {};
            const availableExtensionIds = listAvailableOpenClawExtensionIds(
              this.engineManager.getStateDir(),
              existingPlugins,
              listKnownOpenClawWorkspaceDirs({
                stateDir: this.engineManager.getStateDir(),
                mainWorkspaceDir: resolvedWorkspaceDir,
                agents: this.getAgents?.() ?? [],
                existingConfig: canonicalExisting,
              }),
            );
            const mergedConfig = sanitizeOpenClawV2026_8_1Config(withMemorySearch({
              ...canonicalExisting,
              diagnostics: {
                ...existingDiagnostics,
                otel: {
                  enabled: false,
                },
              },
              agents: {
                ...existingAgents,
                ownership: 'explicit',
                defaults: mergedDefaults,
                entries: {
                  ...minimalEntries,
                  ...existingEntries,
                },
              },
              session: buildManagedOpenClawSessionConfig(),
              mcp: {
                servers: mcpServers,
              },
              update: connectivityConfig.update,
              browser: connectivityConfig.browser,
              ...hookConfig,
              tools: {
                ...existingTools,
                fs: {
                  ...existingFileTools,
                  workspaceOnly: resolveFileToolsWorkspaceOnly(coworkConfig.permissionMode),
                },
                exec: {
                  ...existingExecTools,
                  host: 'gateway',
                  mode: coworkConfig.permissionMode,
                },
              },
              plugins: mergeOpenClawPluginConfig(
                existingPlugins,
                bundledExtensionEntries,
                trustedInstalledExtensionIds,
                availableExtensionIds,
              ),
              meta: minimalConfig.meta,
            }, { enabled: false }));
            const mergedContent = `${JSON.stringify(mergedConfig, null, 2)}\n`;
            if (hasOpenClawConfigChanged(currentContent, mergedConfig)) {
              ensureDir(path.dirname(configPath));
              const tmpPath = `${configPath}.tmp-${Date.now()}`;
              fs.writeFileSync(tmpPath, mergedContent, 'utf8');
              fs.renameSync(tmpPath, configPath);
              return buildVerifiedConfigSyncResult(configPath, mergedConfig, true);
            }
            return buildVerifiedConfigSyncResult(configPath, mergedConfig, false);
          }
        }
      } catch {
        // Malformed JSON — overwrite with minimal config.
      }
    }

    if (!hasOpenClawConfigChanged(currentContent, minimalConfig)) {
      return buildVerifiedConfigSyncResult(configPath, minimalConfig, false);
    }

    try {
      ensureDir(path.dirname(configPath));
      const tmpPath = `${configPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, nextContent, 'utf8');
      fs.renameSync(tmpPath, configPath);
      return buildVerifiedConfigSyncResult(configPath, minimalConfig, true);
    } catch (error) {
      return {
        ok: false,
        changed: false,
        configChanged: false,
        requiresGatewayRestart: false,
        configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

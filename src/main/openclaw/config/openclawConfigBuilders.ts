import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BrowserMode, type BrowserMode as BrowserModeValue } from '../../../shared/browser/browser';
import { OPENAI_REQUEST_USER_AGENT } from '../../../shared/cowork/modelRequestHeaders';
import { normalizeOpenClawAgentId } from '../../../shared/openclaw/agentId';
import {
  type AgentRuntimeSettings,
  createDefaultAgentRuntimeSettings,
  DEFAULT_AGENT_RUNTIME_SETTINGS,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { PermissionMode } from '../../../shared/openclaw/approvals';
import { OPENCLAW_COMPACTION_TIMEOUT_SECONDS } from '../../../shared/openclaw/compaction';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import {
  EXTERNAL_AGENT_CATALOG,
  type ExternalAgentDefinition,
} from '../../../shared/openclaw/externalAgentCatalog';
import {
  createDefaultExternalAgentSettings,
  type ExternalAgentSettings,
} from '../../../shared/openclaw/externalAgents';
import {
  getEffectiveCustomProviderDisplayName,
  isJustDoCustomProviderKey,
  normalizeOpenClawProviderId,
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../../shared/providers';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import { WINDOWS_SANDBOX_BACKEND_ID } from '../../../shared/security/windowsSandbox';
import { LOCAL_TTS_PROVIDER_ID } from '../../../shared/speech/localTts';
import type { Agent, CoworkConfig, CoworkExecutionMode } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  buildBundledExtensionEntries,
  bundledOpenClawExtensions,
  hasBundledOpenClawExtension,
  inspectBundledOpenClawExtensions,
  inspectLocalOpenClawExtensions,
  inspectOpenClawExtensionCandidate,
  inspectOpenClawExtensionDirectory,
} from '../../plugins/extensions';
import type { OpenClawHookRecord } from '../../plugins/hooks';
import type { McpServerRecord } from '../../plugins/mcp';
import {
  BUILTIN_MODEL_JWT_FIELD,
  BUILTIN_MODEL_USER_ACCOUNT_FIELD,
  isActiveBuiltinModelDevelopmentApiKey,
} from '../../providers/builtinModelCredential';
import type { ProviderRawConfig } from '../../providers/providerApiConfig';
import {
  MANAGED_PROVIDER_SECRET_SOURCE,
  managedProviderHeaderSecretRef,
  managedProviderSecretRef,
  providerSecretIdentity,
} from './providerSecretFile';

export const buildOpenClawMcpServers = (
  servers: McpServerRecord[],
  requestTimeoutSeconds = DEFAULT_AGENT_RUNTIME_SETTINGS.mcp.requestTimeoutSeconds,
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    servers.map(server => {
      const config: Record<string, unknown> = {
        ...(server.openClawConfig ?? {}),
        enabled: server.enabled,
      };
      if (server.requestTimeoutSeconds !== undefined) {
        config.requestTimeoutMs = server.requestTimeoutSeconds * 1_000;
      } else if (config.requestTimeoutMs === undefined) {
        config.requestTimeoutMs = requestTimeoutSeconds * 1_000;
      }
      if (server.transportType === 'stdio') {
        delete config.url;
        delete config.headers;
        if (config.command === undefined) config.command = server.command;
        if (config.args === undefined) config.args = server.args ?? [];
        if (config.env === undefined && server.env && Object.keys(server.env).length > 0) {
          config.env = server.env;
        }
      } else {
        delete config.command;
        delete config.args;
        delete config.env;
        if (config.url === undefined) config.url = server.url;
        config.transport = server.transportType === 'sse' ? 'sse' : 'streamable-http';
        if (
          config.headers === undefined &&
          server.headers &&
          Object.keys(server.headers).length > 0
        ) {
          config.headers = server.headers;
        }
      }
      return [server.name, config];
    }),
  );
};

export type ConfiguredPluginInventory = {
  complete: boolean;
  ids: string[];
};

export const buildManagedOpenClawCronConfig = (existing: unknown): Record<string, unknown> => ({
  enabled: true,
  skipMissedJobs: true,
  sessionRetention: '7d',
  ...(isRecord(existing) ? existing : {}),
});

export const listInstalledOpenClawExtensionIds = (stateDir: string): string[] =>
  inspectOpenClawExtensionDirectory(path.join(stateDir, 'extensions')).ids;

export const resolveConfiguredPluginPath = (value: string): string => {
  const trimmed = value.trim();
  const homeDir = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, homeDir);
  return path.resolve(expanded);
};

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
  // before the next config sync rewrites it to v2026.9.2's keyed entries.
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

export const isMissingConfiguredPluginPath = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  );

export const hasCompatiblePluginBundleManifest = (pluginDir: string): boolean => {
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

export const inspectConfiguredPluginPaths = (
  plugins: Record<string, unknown>,
): ConfiguredPluginInventory => {
  const load = isRecord(plugins.load) ? plugins.load : {};
  const loadPaths = Array.isArray(load.paths)
    ? load.paths.filter(
        (value): value is string => typeof value === 'string' && Boolean(value.trim()),
      )
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
  const installedInventory = inspectOpenClawExtensionDirectory(path.join(stateDir, 'extensions'));
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
  return [
    ...new Set([
      ...bundledInventory.ids,
      ...localInventory.ids,
      ...installedInventory.ids,
      ...workspaceInventories.flatMap(inventory => inventory.ids),
      ...configuredInventory.ids,
    ]),
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

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

export const resolveManagedOpenClawTtsConfig = (
  existingConfig: Record<string, unknown> | null,
  localTtsConfig: Record<string, unknown> | null,
  outputState: { enabled: boolean; mode: 'local' | 'online' } = {
    enabled: true,
    mode: 'online',
  },
): Record<string, unknown> | null => {
  const existingTts = isRecord(existingConfig?.tts) ? existingConfig.tts : null;
  if (!outputState.enabled) return existingTts ? { ...existingTts, enabled: false } : null;
  if (outputState.mode === 'local') {
    if (!localTtsConfig) return existingTts ? { ...existingTts, enabled: false } : null;
    const existingProviders = isRecord(existingTts?.providers) ? existingTts.providers : {};
    const localProviders = isRecord(localTtsConfig.providers) ? localTtsConfig.providers : {};
    return {
      ...(existingTts ?? {}),
      ...localTtsConfig,
      providers: { ...existingProviders, ...localProviders },
    };
  }
  if (!existingTts) return null;
  const currentProvider =
    typeof existingTts.provider === 'string' ? existingTts.provider.trim() : '';
  if (currentProvider === 'openai' || currentProvider === 'elevenlabs') {
    return existingTts.enabled === false ? { ...existingTts, enabled: true } : existingTts;
  }
  const providers = isRecord(existingTts.providers) ? existingTts.providers : {};
  const onlineProvider = ['openai', 'elevenlabs'].find(provider => isRecord(providers[provider]));
  return onlineProvider
    ? { ...existingTts, enabled: true, provider: onlineProvider }
    : { ...existingTts, enabled: false };
};

export const MANAGED_TTS_PLUGIN_IDS = new Set([LOCAL_TTS_PROVIDER_ID, 'openai', 'elevenlabs']);

export const buildManagedOpenClawTtsPluginEntries = (
  ttsConfig: Record<string, unknown> | null,
): Record<string, { enabled: true }> => {
  const provider = typeof ttsConfig?.provider === 'string' ? ttsConfig.provider.trim() : '';
  return provider && MANAGED_TTS_PLUGIN_IDS.has(provider) ? { [provider]: { enabled: true } } : {};
};

export const buildManagedOnlineAsrPluginEntries = (
  existingPlugins: Record<string, unknown>,
): Record<string, Record<string, unknown>> => {
  const entries = isRecord(existingPlugins.entries) ? existingPlugins.entries : {};
  const voiceCall = isRecord(entries['voice-call']) ? entries['voice-call'] : null;
  const config = voiceCall && isRecord(voiceCall.config) ? voiceCall.config : null;
  const streaming = config && isRecord(config.streaming) ? config.streaming : null;
  const provider = typeof streaming?.provider === 'string' ? streaming.provider.trim() : '';
  const providers = isRecord(streaming?.providers) ? streaming.providers : null;
  return provider && providers && isRecord(providers[provider]) ? { 'voice-call': voiceCall! } : {};
};

export type OpenClawConfigVerification = {
  ok: boolean;
  error?: string;
};

export const removeRetiredManagedToolDenyEntries = (
  tools: Record<string, unknown>,
): Record<string, unknown> => {
  if (!Array.isArray(tools.deny)) return tools;
  const deny = tools.deny.filter(value => value !== 'skill_workshop');
  return deny.length === tools.deny.length ? tools : { ...tools, deny };
};

export const containsBuiltinModelRef = (value: unknown): boolean => {
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

export const BUILTIN_MODELS_API_KEY_PLACEHOLDER = '${JUSTDO_APIKEY_BUILTIN_MODELS}';

export const BUILTIN_MODEL_SECRET_PROVIDER_ID = 'justdo_login';

export type OpenClawBuiltinSecretRef = Readonly<{
  source: 'exec';
  provider: typeof BUILTIN_MODEL_SECRET_PROVIDER_ID;
  id: string;
}>;

export const buildBuiltinModelSecretRef = (fieldName: string): OpenClawBuiltinSecretRef => ({
  source: 'exec',
  provider: BUILTIN_MODEL_SECRET_PROVIDER_ID,
  id: fieldName,
});

export const buildBuiltinModelOpenClawHeaders = (): Record<string, OpenClawBuiltinSecretRef> => ({
  [BUILTIN_MODEL_JWT_FIELD]: buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD),
  [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: buildBuiltinModelSecretRef(BUILTIN_MODEL_USER_ACCOUNT_FIELD),
});

export const buildManagedOpenClawSecrets = (
  existingConfig: Record<string, unknown> | null,
): Record<string, unknown> => {
  const existingSecrets = isRecord(existingConfig?.secrets) ? existingConfig.secrets : {};
  const existingProviders = isRecord(existingSecrets.providers) ? existingSecrets.providers : {};
  const providers = { ...existingProviders };
  delete providers[BUILTIN_MODEL_SECRET_PROVIDER_ID];
  delete providers['justdo-builtin'];
  const secrets = { ...existingSecrets, providers };
  if (Object.keys(providers).length === 0) {
    delete secrets.providers;
  }
  return secrets;
};

export const containsBuiltinMemorySearchRef = (value: unknown): boolean =>
  (isRecord(value) && value.provider === OpenClawExtensionId.RUNTIME_SERVICES) ||
  containsBuiltinModelRef(value) ||
  (typeof value === 'string'
    ? value.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER) ||
      value === BUILTIN_MODEL_SECRET_PROVIDER_ID
    : Array.isArray(value)
      ? value.some(containsBuiltinMemorySearchRef)
      : isRecord(value) && Object.values(value).some(containsBuiltinMemorySearchRef));

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

/**
 * Remove JustDo-owned fields not accepted by OpenClaw v2026.9.2 and translate the
 * two renamed config surfaces. This is deliberately narrow: unrelated
 * operator-owned config remains untouched and is still validated by Gateway.
 */
export const sanitizeOpenClawV2026_9_2Config = (
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

  if (isRecord(config.browser)) {
    const browser = { ...config.browser };
    delete browser.color;
    if (isRecord(browser.profiles)) {
      browser.profiles = Object.fromEntries(
        Object.entries(browser.profiles).map(([profileId, rawProfile]) => {
          if (!isRecord(rawProfile)) return [profileId, rawProfile];
          const profile = { ...rawProfile };
          delete profile.color;
          return [profileId, profile];
        }),
      );
    }
    next.browser = browser;
  }

  if (isRecord(config.mcp)) {
    const mcp = { ...config.mcp };
    if (isRecord(mcp.servers)) {
      mcp.servers = Object.fromEntries(
        Object.entries(mcp.servers).map(([name, rawServer]) => {
          if (!isRecord(rawServer)) return [name, rawServer];
          const server = { ...rawServer };
          if (
            typeof server.timeout === 'number' &&
            Number.isFinite(server.timeout) &&
            server.timeout > 0 &&
            server.requestTimeoutMs === undefined
          ) {
            server.requestTimeoutMs = server.timeout * 1_000;
          }
          delete server.timeout;
          return [name, server];
        }),
      );
    }
    next.mcp = mcp;
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
    const legacyMemorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : undefined;
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

export const verifyLoggedOutOpenClawConfig = (configPath: string): OpenClawConfigVerification => {
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

  if (
    content.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER) ||
    content.includes(BUILTIN_MODEL_SECRET_PROVIDER_ID)
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: built-in authentication placeholder remains.`,
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

export const rewriteProviderAliasInModel = (
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

export const getModelProviderId = (model: unknown): string => {
  if (!isRecord(model) || typeof model.primary !== 'string') return '';
  const separator = model.primary.indexOf('/');
  return separator > 0 ? model.primary.slice(0, separator).toLowerCase() : '';
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
  const managedMain = isRecord(managedEntries.main) ? managedEntries.main : undefined;
  const managedMainWorkspace =
    typeof managedMain?.workspace === 'string' ? managedMain.workspace.trim() : '';
  const managedMainHeartbeat = isRecord(managedMain?.heartbeat) ? managedMain.heartbeat : undefined;
  if (managedMainWorkspace || managedMainHeartbeat) {
    entries.main = {
      ...(isRecord(entries.main) ? entries.main : {}),
      ...(managedMainWorkspace ? { workspace: managedMainWorkspace } : {}),
      ...(managedMainHeartbeat ? { heartbeat: managedMainHeartbeat } : {}),
    };
  }
  return entries;
};

export const providerRouteIdentity = (provider: unknown): string => {
  if (!isRecord(provider)) return '';
  const { apiKey: _apiKey, ...route } = provider;
  return JSON.stringify(route);
};

export const buildAuthScopedOpenClawConfig = (
  existingConfig: Record<string, unknown>,
  managedConfig: Record<string, unknown>,
  reason: string,
): Record<string, unknown> => {
  const canonicalExistingConfig = sanitizeOpenClawV2026_9_2Config(existingConfig);
  const isLogin = reason === BuiltinModelSyncReason.AuthLogin;
  const existingModels = isRecord(canonicalExistingConfig.models)
    ? canonicalExistingConfig.models
    : {};
  const managedModels = isRecord(managedConfig.models) ? managedConfig.models : {};
  const managedSecrets = isRecord(managedConfig.secrets)
    ? managedConfig.secrets
    : buildManagedOpenClawSecrets(canonicalExistingConfig);
  const existingProviders = isRecord(existingModels.providers) ? existingModels.providers : {};
  const managedProviders = isRecord(managedModels.providers) ? managedModels.providers : {};
  const hasManagedBuiltinProvider = Object.prototype.hasOwnProperty.call(
    managedProviders,
    OpenClawProviderId.BuiltinModels,
  );
  const providers = { ...existingProviders };
  delete providers[OpenClawProviderId.BuiltinModels];
  const providerAliases = new Map<string, string>();
  const matchedManagedProviderIds = new Set<string>();
  const removedManagedProviderIds = new Set<string>();
  const managedCustomProviders = Object.entries(managedProviders).filter(
    ([providerId]) => providerId !== OpenClawProviderId.BuiltinModels,
  );
  for (const [existingProviderId, existingProvider] of Object.entries(existingProviders)) {
    if (existingProviderId === OpenClawProviderId.BuiltinModels || !isRecord(existingProvider)) {
      continue;
    }
    const existingApiKey = providerSecretIdentity(existingProvider.apiKey);
    let managedMatch = managedCustomProviders.find(([managedProviderId, managedProvider]) => {
      if (matchedManagedProviderIds.has(managedProviderId)) return false;
      if (!isRecord(managedProvider)) return false;
      return providerSecretIdentity(managedProvider.apiKey) === existingApiKey;
    });
    if (!managedMatch && existingApiKey.startsWith(`${MANAGED_PROVIDER_SECRET_SOURCE}:/`)) {
      const routeIdentity = providerRouteIdentity(existingProvider);
      const routeMatches = managedCustomProviders.filter(
        ([managedProviderId, managedProvider]) =>
          !matchedManagedProviderIds.has(managedProviderId) &&
          providerRouteIdentity(managedProvider) === routeIdentity,
      );
      if (routeIdentity && routeMatches.length === 1) managedMatch = routeMatches[0];
    }
    if (!managedMatch) {
      if (
        existingApiKey.startsWith(`${MANAGED_PROVIDER_SECRET_SOURCE}:/`) ||
        /^\$\{JUSTDO_APIKEY_CUSTOM(?:_\d+)?\}$/.test(existingApiKey)
      ) {
        delete providers[existingProviderId];
        removedManagedProviderIds.add(existingProviderId.toLowerCase());
      }
      continue;
    }
    const [canonicalProviderId] = managedMatch;
    matchedManagedProviderIds.add(canonicalProviderId);
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
  const existingDefaults = isRecord(existingAgents.defaults) ? existingAgents.defaults : {};
  const managedDefaults = isRecord(managedAgents.defaults) ? managedAgents.defaults : {};
  const defaults: Record<string, unknown> = {
    ...existingDefaults,
    modelSelectionScope: managedDefaults.modelSelectionScope ?? 'session',
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
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'timeoutSeconds')) {
    defaults.timeoutSeconds = managedDefaults.timeoutSeconds;
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'maxConcurrent')) {
    defaults.maxConcurrent = managedDefaults.maxConcurrent;
  } else {
    delete defaults.maxConcurrent;
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'subagents')) {
    defaults.subagents = mergeManagedOpenClawSubagentConfig(
      existingDefaults.subagents,
      managedDefaults.subagents,
    );
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'compaction')) {
    // Compaction is JustDo-managed policy. Replace the whole object so removed
    // keys (notably the legacy explicit keepRecentTokens) do not survive an
    // auth-only config sync.
    defaults.compaction = managedDefaults.compaction;
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'systemAgent')) {
    // OpenClaw v2026.9.2 requires an explicit ambient owner when more than one
    // Agent exists. Keep native maintenance work (for example memory dreaming)
    // bound to the main Agent; JustDo user-created scheduled tasks set their
    // selected Agent explicitly.
    defaults.systemAgent = managedDefaults.systemAgent;
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'heartbeat')) {
    // Heartbeat cadence is JustDo-managed. Authentication-only syncs must not
    // resurrect a stale periodic cadence from an older generated config.
    defaults.heartbeat = managedDefaults.heartbeat;
  }
  const managedDefaultModel = isRecord(managedDefaults.model) ? managedDefaults.model : undefined;
  const managedDefaultPrimary =
    typeof managedDefaultModel?.primary === 'string' ? managedDefaultModel.primary : '';
  const managedDefaultProviderId = managedDefaultPrimary.split('/', 1)[0];
  if (
    managedDefaultModel &&
    managedCustomProviders.some(([providerId]) => providerId === managedDefaultProviderId)
  ) {
    defaults.model = managedDefaultModel;
  }
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
  if (removedManagedProviderIds.has(getModelProviderId(defaults.model))) {
    if (
      managedDefaultModel &&
      Object.prototype.hasOwnProperty.call(providers, getModelProviderId(managedDefaultModel))
    ) {
      defaults.model = managedDefaultModel;
    } else {
      delete defaults.model;
    }
  }

  const existingEntries = isRecord(existingAgents.entries) ? existingAgents.entries : {};
  const managedEntries = isRecord(managedAgents.entries) ? managedAgents.entries : {};
  const agentEntries = mergeAgentEntriesWithManagedMainSettings(managedEntries, existingEntries);
  if (shouldRemoveBuiltinRefs) {
    for (const [id, entry] of Object.entries(agentEntries)) {
      if (!isRecord(entry) || !containsBuiltinModelRef(entry.model)) continue;
      const managedEntry = isRecord(managedEntries[id]) ? managedEntries[id] : undefined;
      const fallbackModel =
        managedEntry && isRecord(managedEntry.model) && !containsBuiltinModelRef(managedEntry.model)
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
    const rewrittenEntry = {
      ...entry,
      model: rewriteProviderAliasInModel(entry.model, providerAliases),
    };
    if (!removedManagedProviderIds.has(getModelProviderId(rewrittenEntry.model))) {
      agentEntries[id] = rewrittenEntry;
      continue;
    }
    const managedEntry = isRecord(managedEntries[id]) ? managedEntries[id] : undefined;
    const managedEntryModel = managedEntry?.model;
    const fallbackModel = Object.prototype.hasOwnProperty.call(
      providers,
      getModelProviderId(managedEntryModel),
    )
      ? managedEntryModel
      : Object.prototype.hasOwnProperty.call(providers, getModelProviderId(managedDefaultModel))
        ? managedDefaultModel
        : undefined;
    if (fallbackModel) {
      rewrittenEntry.model = fallbackModel;
    } else {
      delete rewrittenEntry.model;
    }
    agentEntries[id] = rewrittenEntry;
  }

  const existingMemory = isRecord(canonicalExistingConfig.memory)
    ? canonicalExistingConfig.memory
    : {};
  const managedMemory = isRecord(managedConfig.memory) ? managedConfig.memory : {};
  const existingMemorySearch = isRecord(existingMemory.search) ? existingMemory.search : undefined;
  const managedMemorySearch = isRecord(managedMemory.search) ? managedMemory.search : undefined;
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
    catalogRefresh: managedModels.catalogRefresh,
    ...(Object.prototype.hasOwnProperty.call(existingModels, 'mode')
      ? {}
      : { mode: managedModels.mode }),
    providers,
  };
  if (Object.keys(providers).length === 0) {
    delete models.providers;
  }

  const result = sanitizeOpenClawV2026_9_2Config({
    ...canonicalExistingConfig,
    skills: mergeOpenClawSkillConfig(
      isRecord(canonicalExistingConfig.skills) ? canonicalExistingConfig.skills : {},
      {},
    ),
    secrets: managedSecrets,
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
  if (Object.keys(managedSecrets).length === 0) {
    delete result.secrets;
  }
  return result;
};

export const RESERVED_PLUGIN_SLOT_VALUES = new Set(['legacy', 'none']);

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
  const retainedRegistrationIds = new Set<string>();
  for (const field of ['entries', 'installs'] as const) {
    const registrations = isRecord(existingPlugins[field]) ? existingPlugins[field] : {};
    for (const extensionId of Object.keys(registrations)) {
      retainedRegistrationIds.add(extensionId);
    }
  }
  for (const field of ['allow', 'deny'] as const) {
    const registrations = Array.isArray(existingPlugins[field]) ? existingPlugins[field] : [];
    for (const extensionId of registrations) {
      if (typeof extensionId === 'string') {
        retainedRegistrationIds.add(extensionId);
      }
    }
  }
  const slots = isRecord(existingPlugins.slots) ? existingPlugins.slots : {};
  for (const extensionId of Object.values(slots)) {
    if (typeof extensionId === 'string' && !RESERVED_PLUGIN_SLOT_VALUES.has(extensionId)) {
      retainedRegistrationIds.add(extensionId);
    }
  }
  const existingRegistrations = removeUnavailableOpenClawPluginRegistrations(existingPlugins, [
    ...retainedRegistrationIds,
  ]);
  const managedIds = Object.keys(managedEntries);
  const sourcePlugins = availableExtensionIds
    ? removeUnavailableOpenClawPluginRegistrations(existingRegistrations, [
        ...availableExtensionIds,
        ...trustedInstalledExtensionIds,
        ...managedIds,
      ])
    : existingRegistrations;
  const mergedEntries = Object.fromEntries(
    Object.entries({
      ...(isRecord(sourcePlugins.entries) ? sourcePlugins.entries : {}),
      ...managedEntries,
    }).map(([pluginId, value]) => {
      // Refresh application-owned model paths without undoing the user's plugin toggle.
      if (
        (pluginId === OpenClawExtensionId.STT_LOCAL_CLI || pluginId === LOCAL_TTS_PROVIDER_ID) &&
        isRecord(value)
      ) {
        const previous = isRecord(sourcePlugins.entries) ? sourcePlugins.entries[pluginId] : null;
        if (isRecord(previous) && previous.enabled === false) value = { ...value, enabled: false };
      }
      if (!isRecord(value) || value.enabled !== false || !isRecord(value.config)) {
        return [pluginId, value];
      }
      if (Object.keys(value.config).length > 0) return [pluginId, value];

      // OpenClaw warns when a disabled plugin has a config property, even when
      // schema normalization left only an empty object behind. Drop that inert
      // residue while retaining user-owned non-empty config and sibling fields.
      const cleanedEntry = { ...value };
      delete cleanedEntry.config;
      return [pluginId, cleanedEntry];
    }),
  );
  const trustedIds = [
    ...new Set(trustedInstalledExtensionIds.map(id => id.trim()).filter(Boolean)),
  ];
  if (Object.keys(mergedEntries).length === 0 && trustedIds.length === 0) return sourcePlugins;

  const existingAllow = Array.isArray(sourcePlugins.allow)
    ? sourcePlugins.allow.filter((value): value is string => typeof value === 'string')
    : Array.isArray(existingPlugins.allow)
      ? []
      : null;
  const shouldPinInstalledExtensions = trustedIds.length > 0;
  const allow = existingAllow
    ? [...new Set([...existingAllow, ...trustedIds, ...managedIds])]
    : shouldPinInstalledExtensions
      ? [...new Set([...trustedIds, ...managedIds])]
      : null;
  return {
    ...sourcePlugins,
    ...(managedIds.length > 0 ? { enabled: true } : {}),
    ...(allow ? { allow } : {}),
    entries: mergedEntries,
  };
};

export const applyDefaultOpenClawPluginEntries = (
  existingPlugins: Record<string, unknown>,
  defaultEntries: Record<string, unknown>,
): Record<string, unknown> => {
  if (Object.keys(defaultEntries).length === 0) return existingPlugins;
  const existingEntries = isRecord(existingPlugins.entries) ? existingPlugins.entries : {};
  return {
    ...existingPlugins,
    entries: {
      ...defaultEntries,
      ...existingEntries,
    },
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
  const workshop = isRecord(mergedSkills.workshop) ? mergedSkills.workshop : {};
  const autonomous = isRecord(workshop.autonomous) ? workshop.autonomous : {};
  mergedSkills.workshop = {
    ...workshop,
    autonomous: { ...autonomous, mode: autonomous.mode ?? 'off' },
  };
  return mergedSkills;
};

export const mapExecutionModeToSandboxMode = (mode: CoworkExecutionMode): 'off' | 'all' => {
  switch (mode) {
    case 'sandbox':
      return 'all';
    case 'auto':
    case 'local':
    default:
      return 'off';
  }
};

export const OPENCLAW_FALLBACK_EXEC_MODE = PermissionMode.Ask;

export const OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY = true;

export const buildManagedOpenClawSandboxConfig = (mode: CoworkExecutionMode) => {
  const sandboxMode = mapExecutionModeToSandboxMode(mode);
  return {
    mode: sandboxMode,
    ...(sandboxMode === 'all'
      ? {
          backend: WINDOWS_SANDBOX_BACKEND_ID,
          scope: 'session' as const,
          workspaceAccess: 'rw' as const,
        }
      : {}),
  };
};

export const resolveOpenClawExecHost = (mode: CoworkExecutionMode): 'gateway' | 'sandbox' =>
  mapExecutionModeToSandboxMode(mode) === 'all' ? 'sandbox' : 'gateway';

/** Default agent timeout used when no persisted runtime preference exists. */
export const OPENCLAW_AGENT_TIMEOUT_SECONDS =
  DEFAULT_AGENT_RUNTIME_SETTINGS.agent.runTimeoutSeconds;

// Provider idle timeout for slow long-context model calls. This remains finite
// even though the main Agent has no overall turn limit by default.
export const OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS = 30 * 60;

// Context compaction has its own OpenClaw safety timeout. Keep it aligned with
// the provider ceiling so a healthy long-context SSE response is not aborted
// by the much shorter upstream default (180s).
export { OPENCLAW_COMPACTION_TIMEOUT_SECONDS } from '../../../shared/openclaw/compaction';

// Stable product defaults retained for callers and focused config tests.
export const OPENCLAW_SUBAGENT_MAX_CONCURRENT =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.maxConcurrent;

export const OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.maxChildrenPerAgent;

// Allow substantial work while still terminating runaway subagent runs.
export const OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.runTimeoutSeconds;

export const OPENCLAW_ACP_BACKEND = OpenClawExtensionId.ACPX;

export const OPENCLAW_MCP_TOOL_OWNER = 'bundle-mcp';

export const OPENCLAW_COLLABORATION_TOOLS = ['task_assistants', 'assistants_create'] as const;

export const buildManagedOpenClawSandboxToolConfig = (mode: CoworkExecutionMode) => ({
  tools: {
    alsoAllow: [
      ...OPENCLAW_COLLABORATION_TOOLS,
      ...(mapExecutionModeToSandboxMode(mode) === 'all' ? [] : [OPENCLAW_MCP_TOOL_OWNER]),
    ],
  },
});

export const OPENCLAW_MAX_SKILLS_IN_PROMPT = 200;

export const OPENCLAW_MAX_SKILLS_PROMPT_CHARS = 50_000;

// Keep the product's historical 365-day stale-session policy. In current
// OpenClaw, maxEntries archives overflow entries; it does not shorten the
// transcript retention window or authorize JustDo to delete message rows.
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

export const buildManagedOpenClawAcpConfig = (
  settings: ExternalAgentSettings = createDefaultExternalAgentSettings(),
) => {
  const allowedAgents = EXTERNAL_AGENT_CATALOG.filter(
    definition => settings.agents[definition.id].enabled,
  ).map(definition => definition.id);
  const enabled = allowedAgents.length > 0;
  return {
    enabled,
    dispatch: { enabled },
    backend: OPENCLAW_ACP_BACKEND,
    allowedAgents,
    ...(allowedAgents[0] ? { defaultAgent: allowedAgents[0] } : {}),
  };
};

export const buildManagedExternalAgentEntries = (
  workspaceDir: string,
  settings: ExternalAgentSettings = createDefaultExternalAgentSettings(),
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    EXTERNAL_AGENT_CATALOG.filter(definition => settings.agents[definition.id].enabled).map(
      definition => [
        definition.id,
        {
          workspace: workspaceDir,
          runtime: {
            type: 'acp',
            acp: {
              agent: definition.id,
              backend: OPENCLAW_ACP_BACKEND,
              cwd: workspaceDir,
            },
          },
        },
      ],
    ),
  );

export const ACPX_RESERVED_MCP_SERVER_NAMES = new Set(['openclaw-plugin-tools', 'openclaw-tools']);

export const getStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
};

/**
 * ACPX 0.13.x accepts stdio MCP bootstrap entries only. Project the effective
 * command fields without forwarding OpenClaw-only configuration such as cwd,
 * request timeouts, remote transports, or headers.
 */
export const buildManagedAcpxMcpServers = (
  servers: readonly McpServerRecord[],
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    servers.flatMap(server => {
      if (
        !server.enabled ||
        server.transportType !== 'stdio' ||
        ACPX_RESERVED_MCP_SERVER_NAMES.has(server.name)
      ) {
        return [];
      }
      const overrides = isRecord(server.openClawConfig) ? server.openClawConfig : {};
      const command =
        typeof overrides.command === 'string' ? overrides.command.trim() : server.command?.trim();
      if (!command) return [];
      const args = Array.isArray(overrides.args)
        ? overrides.args.filter((value): value is string => typeof value === 'string')
        : server.args;
      const env = getStringRecord(overrides.env) ?? server.env;
      return [
        [
          server.name,
          {
            command,
            ...(args && args.length > 0 ? { args: [...args] } : {}),
            ...(env && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
          },
        ],
      ];
    }),
  );

export const buildManagedAcpxPluginEntry = (
  settings: ExternalAgentSettings = createDefaultExternalAgentSettings(),
  catalog: readonly ExternalAgentDefinition[] = EXTERNAL_AGENT_CATALOG,
  mcpServers: readonly McpServerRecord[] = [],
): Record<string, unknown> => {
  const agentCommands = Object.fromEntries(
    catalog.flatMap(definition =>
      definition.adapter
        ? [
            [
              definition.id,
              {
                command: definition.adapter.command,
                args: [...(definition.adapter.args ?? [])],
              },
            ],
          ]
        : [],
    ),
  );
  const configuredMcpServers = settings.shareConfiguredMcpServers
    ? buildManagedAcpxMcpServers(mcpServers)
    : {};
  return {
    // Keep the bundled runtime available for per-agent connection tests even
    // when ACP delegation itself is disabled.
    enabled: true,
    config: {
      permissionMode:
        settings.permissionMode === 'full-access'
          ? 'approve-all'
          : settings.permissionMode === 'deny-all'
            ? 'deny-all'
            : 'approve-reads',
      nonInteractivePermissions:
        settings.permissionMode === 'read-only'
          ? settings.readOnlyViolationBehavior === 'fail-task'
            ? 'fail'
            : 'deny'
          : settings.permissionMode === 'full-access'
            ? 'fail'
            : 'deny',
      timeoutSeconds: settings.operationTimeoutSeconds,
      pluginToolsMcpBridge: settings.pluginToolsMcpBridge,
      openClawToolsMcpBridge: settings.openClawToolsMcpBridge,
      ...(Object.keys(configuredMcpServers).length > 0 ? { mcpServers: configuredMcpServers } : {}),
      startupProbe: false,
      diagnosticAgents: catalog.map(definition => definition.id),
      ...(Object.keys(agentCommands).length > 0 ? { agents: agentCommands } : {}),
    },
  };
};

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

export const buildManagedOpenClawHeartbeatConfig = () => ({
  // JustDo has no external notification channel and v2026.9.2 automations
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

export const buildManagedOpenClawConnectivityConfig = (
  browserMode: BrowserModeValue = BrowserMode.Isolated,
  sessionVisibility: AgentRuntimeSettings['sessions']['visibility'] = DEFAULT_AGENT_RUNTIME_SETTINGS
    .sessions.visibility,
) => ({
  update: {
    checkOnStart: false,
    auto: {
      enabled: false,
    },
  },
  tools: {
    updatePlan: true,
    // OpenClaw v2026.9.2 owns native tool-directory discovery and hydration.
    toolSearch: {
      enabled: true,
      mode: 'directory',
    },
    sessions: {
      visibility: sessionVisibility,
    },
    deny: [
      'ask_user',
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
    // Provider ownership lives in plugins.entries. Toggling this root switch
    // would require a Gateway restart under the native browser reload policy.
    enabled: true,
    // The bundled v2.2.0 extension uses Browser Relay Authentication v2.
    // Fail closed instead of retaining OpenClaw's one-release legacy window.
    extensionRelay: {
      allowLegacyAuth: false,
    },
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
            },
          },
        }
      : browserMode === BrowserMode.Extension
        ? {
            profiles: {
              chrome: {
                driver: 'extension',
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

export const buildManagedOpenClawModelCatalogConfig = (): Record<string, unknown> => ({
  catalogRefresh: {
    enabled: false,
  },
});

export const sortJsonValue = (value: unknown): unknown => {
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

export const verifyOpenClawConfigMatches = (
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

export const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

export const normalizeModelName = (modelId: string): string => {
  const trimmed = modelId.trim();
  if (!trimmed) return 'default-model';
  const slashIndex = trimmed.lastIndexOf('/');
  const name = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  // Ensure the result is never empty after stripping prefix
  return name.trim() || 'default-model';
};

export const resolveModelDisplayName = (modelId: string, userModelName?: string): string => {
  const userName = userModelName?.trim();
  if (userName) return userName;
  return normalizeModelName(modelId);
};

export type OpenClawProviderApi = 'openai-completions';

export type OpenClawProviderSelection = {
  providerId: string;
  legacyModelId: string;
  sessionModelId: string;
  primaryModel: string;
  providerConfig: {
    baseUrl: string;
    api: OpenClawProviderApi;
    apiKey: unknown;
    auth: 'api-key';
    timeoutSeconds: number;
    headers?: Record<string, unknown>;
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

export const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) {
    return normalized.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return normalized;
};

export type ProviderDescriptor = {
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

export const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {};

export const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.JustDo,
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

export const resolveDescriptor = (providerName: string): ProviderDescriptor => {
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
  headers?: Record<string, string>;
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
  const apiKey =
    providerName === ProviderName.BuiltinModels
      ? buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD)
      : descriptor.resolveApiKey
        ? descriptor.resolveApiKey({ apiKey: options.apiKey, providerName })
        : managedProviderSecretRef(effectiveProviderId);
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
  const customHeaderNames =
    providerName === ProviderName.BuiltinModels ? [] : Object.keys(options.headers ?? {});

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
      ...(providerName === ProviderName.BuiltinModels && !isActiveBuiltinModelDevelopmentApiKey()
        ? { headers: buildBuiltinModelOpenClawHeaders() }
        : {}),
      timeoutSeconds: OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
      ...(customHeaderNames.length > 0
        ? {
            headers: Object.fromEntries(
              customHeaderNames.map(headerName => [
                headerName,
                managedProviderHeaderSecretRef(effectiveProviderId, headerName),
              ]),
            ),
          }
        : {}),
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

export type ManagedMemorySearchConfig =
  | {
      enabled: true;
      provider: string;
      model: string;
      remote: {
        baseUrl: string;
        apiKey: string | OpenClawBuiltinSecretRef;
        headers: Record<string, string | OpenClawBuiltinSecretRef>;
      };
    }
  | { enabled: false };

export const buildBuiltinMemorySearchConfig = (
  providers: ProviderRawConfig[],
): ManagedMemorySearchConfig => {
  const provider = providers.find(
    candidate => candidate.providerName === ProviderName.BuiltinModels,
  );
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
    provider: OpenClawExtensionId.RUNTIME_SERVICES,
    model: selection.sessionModelId,
    remote: {
      baseUrl: selection.providerConfig.baseUrl,
      apiKey: buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD),
      headers: {
        'User-Agent': OPENAI_REQUEST_USER_AGENT,
      },
    },
  };
};

export const withMemorySearch = (
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

export const readPreinstalledPluginIds = (): string[] => {
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

export const isBundledPluginAvailable = (pluginId: string): boolean => {
  return hasBundledOpenClawExtension(pluginId);
};

export const buildDefaultOpenClawPluginEntries = (
  isAvailable: (id: string) => boolean = isBundledPluginAvailable,
): Record<string, unknown> =>
  Object.fromEntries(
    (
      [
        [OpenClawExtensionId.WORKBOARD, true],
        [OpenClawExtensionId.AGENT_TEAM, false],
        // The prepared agent runtime rejects a selected memory plugin omitted from
        // an explicit allowlist, even if Gateway startup already loaded its service.
        [OpenClawExtensionId.MEMORY_CORE, true],
      ] as const
    )
      .filter(([id]) => isAvailable(id))
      .map(([id, enabled]) => [id, { enabled }]),
  );

export const isUserToggleableBundledPlugin = (pluginId: string): boolean =>
  pluginId === OpenClawExtensionId.MEMORY_CORE ||
  pluginId === OpenClawExtensionId.WORKBOARD ||
  pluginId === OpenClawExtensionId.AGENT_TEAM ||
  pluginId === OpenClawExtensionId.STT_LOCAL_CLI ||
  pluginId === LOCAL_TTS_PROVIDER_ID;

export const listManagedOpenClawPluginIds = (): string[] => [
  ...new Set([
    ...(isBundledPluginAvailable(OpenClawExtensionId.BROWSER) ? [OpenClawExtensionId.BROWSER] : []),
    ...readPreinstalledPluginIds().filter(
      id => !isUserToggleableBundledPlugin(id) && isBundledPluginAvailable(id),
    ),
    ...bundledOpenClawExtensions
      .filter(
        extension =>
          !isUserToggleableBundledPlugin(extension.id) && isBundledPluginAvailable(extension.id),
      )
      .map(extension => extension.id),
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
  secretsChanged?: boolean;
};

export const buildVerifiedConfigSyncResult = (
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

export const buildMissingEmbeddedBrowserResult = (
  configPath: string,
): OpenClawConfigSyncResult => ({
  ok: false,
  changed: false,
  configChanged: false,
  requiresGatewayRestart: false,
  configPath,
  error: 'The bundled embedded browser provider is unavailable.',
});

export const buildManagedBundledExtensionEntries = (
  agentRuntimeSettings: AgentRuntimeSettings,
  browserMode: BrowserModeValue,
  externalAgentSettings: ExternalAgentSettings,
  mcpServers: readonly McpServerRecord[],
  windowsSandboxEnabled: boolean,
  sandboxNetworkEnabled: boolean,
): Record<string, Record<string, unknown>> => {
  const embeddedBrowserEnabled = browserMode === BrowserMode.Embedded;
  return {
    [OpenClawExtensionId.BROWSER]: { enabled: !embeddedBrowserEnabled },
    ...buildBundledExtensionEntries(
      isBundledPluginAvailable,
      agentRuntimeSettings.automation.approvalTimeoutMinutes,
      windowsSandboxEnabled,
      sandboxNetworkEnabled,
    ),
    ...(isBundledPluginAvailable(OpenClawExtensionId.EMBEDDED_BROWSER)
      ? {
          [OpenClawExtensionId.EMBEDDED_BROWSER]: { enabled: embeddedBrowserEnabled },
        }
      : {}),
    ...(isBundledPluginAvailable(OpenClawExtensionId.ACPX)
      ? {
          [OpenClawExtensionId.ACPX]: buildManagedAcpxPluginEntry(
            externalAgentSettings,
            EXTERNAL_AGENT_CATALOG,
            mcpServers,
          ),
        }
      : {}),
    ...(isBundledPluginAvailable(OpenClawExtensionId.ASK_USER_QUESTION)
      ? {
          [OpenClawExtensionId.ASK_USER_QUESTION]: {
            enabled: true,
            config: {
              timeoutMinutes: agentRuntimeSettings.askUserQuestion.timeoutMinutes,
            },
          },
        }
      : {}),
  };
};

export type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getCoworkConfig: () => CoworkConfig;
  getAgentRuntimeSettings?: () => AgentRuntimeSettings;
  getExternalAgentSettings?: () => ExternalAgentSettings;
  getMcpServers?: () => McpServerRecord[];
  getHooks?: () => OpenClawHookRecord[];
  getAgents?: () => Agent[];
  getBrowserMode?: () => BrowserModeValue;
  getLocalSttConfig?: () => Record<string, unknown> | null;
  getLocalTtsConfig?: () => Record<string, unknown> | null;
  getSpeechOutputState?: () => { enabled: boolean; mode: 'local' | 'online' };
  getWindowsSandboxEnvironment?: () => Record<string, string>;
};

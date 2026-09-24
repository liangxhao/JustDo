import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  normalizeBrowserMode,
} from '../../../shared/browser/browser';
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
  getActiveBuiltinModelCredential,
  isActiveBuiltinModelDevelopmentApiKey,
} from '../../providers/builtinModelCredential';
import type { ProviderRawConfig } from '../../providers/providerApiConfig';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderSecrets,
  resolveRawApiConfig,
  validateConfiguredOpenClawProviderNames,
} from '../../providers/providerApiConfig';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
} from '../models/openclawAgentModels';
import { getElectronNodeRuntimePath } from '../runtime/electronNodeRuntime';
import { resolveManagedAgentWorkspace } from './agentWorkspace';
import { syncBuiltinCredentialFile } from './builtinCredentialFile';
import {
  MANAGED_PROVIDER_SECRET_SOURCE,
  managedProviderHeaderSecretRef,
  managedProviderSecretRef,
  providerSecretIdentity,
  syncProviderSecretFile,
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
        if (
          config.env === undefined &&
          server.env &&
          Object.keys(server.env).length > 0
        ) {
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

type ConfiguredPluginInventory = {
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

const resolveConfiguredPluginPath = (value: string): string => {
  const trimmed = value.trim();
  const homeDir = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, homeDir);
  return path.resolve(expanded);
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
    const configuredWorkspace =
      typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
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

const MANAGED_TTS_PLUGIN_IDS = new Set([LOCAL_TTS_PROVIDER_ID, 'openai', 'elevenlabs']);

export const buildManagedOpenClawTtsPluginEntries = (
  ttsConfig: Record<string, unknown> | null,
): Record<string, { enabled: true }> => {
  const provider = typeof ttsConfig?.provider === 'string' ? ttsConfig.provider.trim() : '';
  return provider && MANAGED_TTS_PLUGIN_IDS.has(provider)
    ? { [provider]: { enabled: true } }
    : {};
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
  return provider && providers && isRecord(providers[provider])
    ? { 'voice-call': voiceCall! }
    : {};
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
const BUILTIN_MODEL_SECRET_PROVIDER_ID = 'justdo_login';

type OpenClawBuiltinSecretRef = Readonly<{
  source: 'exec';
  provider: typeof BUILTIN_MODEL_SECRET_PROVIDER_ID;
  id: string;
}>;

const buildBuiltinModelSecretRef = (fieldName: string): OpenClawBuiltinSecretRef => ({
  source: 'exec',
  provider: BUILTIN_MODEL_SECRET_PROVIDER_ID,
  id: fieldName,
});

const buildBuiltinModelOpenClawHeaders = (): Record<string, OpenClawBuiltinSecretRef> => ({
  [BUILTIN_MODEL_JWT_FIELD]: buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD),
  [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: buildBuiltinModelSecretRef(
    BUILTIN_MODEL_USER_ACCOUNT_FIELD,
  ),
});

const buildManagedOpenClawSecrets = (
  existingConfig: Record<string, unknown> | null,
): Record<string, unknown> => {
  const existingSecrets = isRecord(existingConfig?.secrets) ? existingConfig.secrets : {};
  const existingProviders = isRecord(existingSecrets.providers)
    ? existingSecrets.providers
    : {};
  const providers = { ...existingProviders };
  delete providers[BUILTIN_MODEL_SECRET_PROVIDER_ID];
  delete providers['justdo-builtin'];
  const secrets = { ...existingSecrets, providers };
  if (Object.keys(providers).length === 0) {
    delete secrets.providers;
  }
  return secrets;
};

const containsBuiltinMemorySearchRef = (value: unknown): boolean =>
  (isRecord(value) && value.provider === OpenClawExtensionId.RUNTIME_SERVICES) ||
  containsBuiltinModelRef(value) ||
  (typeof value === 'string'
    ? value.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER) ||
      value === BUILTIN_MODEL_SECRET_PROVIDER_ID
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

const constrainAgentEntryToAvailableModels = (
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

const getModelProviderId = (model: unknown): string => {
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
  const managedMainHeartbeat = isRecord(managedMain?.heartbeat)
    ? managedMain.heartbeat
    : undefined;
  if (managedMainWorkspace || managedMainHeartbeat) {
    entries.main = {
      ...(isRecord(entries.main) ? entries.main : {}),
      ...(managedMainWorkspace ? { workspace: managedMainWorkspace } : {}),
      ...(managedMainHeartbeat ? { heartbeat: managedMainHeartbeat } : {}),
    };
  }
  return entries;
};

const providerRouteIdentity = (provider: unknown): string => {
  if (!isRecord(provider)) return '';
  const { apiKey: _apiKey, ...route } = provider;
  return JSON.stringify(route);
};

const buildAuthScopedOpenClawConfig = (
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
    if (
      !managedMatch &&
      existingApiKey.startsWith(`${MANAGED_PROVIDER_SECRET_SOURCE}:/`)
    ) {
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
        (existingApiKey.startsWith(`${MANAGED_PROVIDER_SECRET_SOURCE}:/`) ||
          /^\$\{JUSTDO_APIKEY_CUSTOM(?:_\d+)?\}$/.test(existingApiKey))
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
  const existingDefaults = isRecord(existingAgents.defaults)
    ? existingAgents.defaults
    : {};
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
  const managedDefaultModel = isRecord(managedDefaults.model)
    ? managedDefaults.model
    : undefined;
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
  const agentEntries = mergeAgentEntriesWithManagedMainSettings(
    managedEntries,
    existingEntries,
  );
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
    if (
      typeof extensionId === 'string' &&
      !RESERVED_PLUGIN_SLOT_VALUES.has(extensionId)
    ) {
      retainedRegistrationIds.add(extensionId);
    }
  }
  const existingRegistrations = removeUnavailableOpenClawPluginRegistrations(
    existingPlugins,
    [...retainedRegistrationIds],
  );
  const managedIds = Object.keys(managedEntries);
  const sourcePlugins = availableExtensionIds
    ? removeUnavailableOpenClawPluginRegistrations(existingRegistrations, [
        ...availableExtensionIds,
        ...trustedInstalledExtensionIds,
        ...managedIds,
      ])
    : existingRegistrations;
  const mergedEntries = Object.fromEntries(Object.entries({
    ...(isRecord(sourcePlugins.entries) ? sourcePlugins.entries : {}),
    ...managedEntries,
  }).map(([pluginId, value]) => {
    // Refresh application-owned model paths without undoing the user's plugin toggle.
    if ((pluginId === OpenClawExtensionId.STT_LOCAL_CLI || pluginId === LOCAL_TTS_PROVIDER_ID) && isRecord(value)) {
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
  }));
  const trustedIds = [
    ...new Set(
      trustedInstalledExtensionIds
        .map(id => id.trim())
        .filter(Boolean),
    ),
  ];
  if (Object.keys(mergedEntries).length === 0 && trustedIds.length === 0) return sourcePlugins;

  const existingAllow = Array.isArray(sourcePlugins.allow)
    ? sourcePlugins.allow.filter((value): value is string => typeof value === 'string')
    : Array.isArray(existingPlugins.allow)
      ? []
      : null;
  const shouldPinInstalledExtensions = trustedIds.length > 0;
  const allow = existingAllow
    ? [
        ...new Set([
          ...existingAllow,
          ...trustedIds,
          ...managedIds,
        ]),
      ]
    : shouldPinInstalledExtensions
      ? [
          ...new Set([
            ...trustedIds,
            ...managedIds,
          ]),
        ]
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

const mapExecutionModeToSandboxMode = (mode: CoworkExecutionMode): 'off' | 'all' => {
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

const ACPX_RESERVED_MCP_SERVER_NAMES = new Set([
  'openclaw-plugin-tools',
  'openclaw-tools',
]);

const getStringRecord = (value: unknown): Record<string, string> | undefined => {
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
      ...(Object.keys(configuredMcpServers).length > 0
        ? { mcpServers: configuredMcpServers }
        : {}),
      startupProbe: false,
      diagnosticAgents: catalog.map(definition => definition.id),
      ...(Object.keys(agentCommands).length > 0 ? { agents: agentCommands } : {}),
    },
  };
};

const mergeManagedOpenClawSubagentConfig = (
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
  sessionVisibility: AgentRuntimeSettings['sessions']['visibility'] =
    DEFAULT_AGENT_RUNTIME_SETTINGS.sessions.visibility,
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

type OpenClawProviderApi = 'openai-completions';

type OpenClawProviderSelection = {
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
  const apiKey = providerName === ProviderName.BuiltinModels
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

type ManagedMemorySearchConfig =
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

export const buildDefaultOpenClawPluginEntries = (
  isAvailable: (id: string) => boolean = isBundledPluginAvailable,
): Record<string, unknown> =>
  Object.fromEntries(
    ([
      [OpenClawExtensionId.WORKBOARD, true],
      [OpenClawExtensionId.AGENT_TEAM, false],
      // The prepared agent runtime rejects a selected memory plugin omitted from
      // an explicit allowlist, even if Gateway startup already loaded its service.
      [OpenClawExtensionId.MEMORY_CORE, true],
    ] as const)
      .filter(([id]) => isAvailable(id))
      .map(([id, enabled]) => [id, { enabled }]),
  );

const isUserToggleableBundledPlugin = (pluginId: string): boolean =>
  pluginId === OpenClawExtensionId.MEMORY_CORE ||
  pluginId === OpenClawExtensionId.WORKBOARD ||
  pluginId === OpenClawExtensionId.AGENT_TEAM ||
  pluginId === OpenClawExtensionId.STT_LOCAL_CLI ||
  pluginId === LOCAL_TTS_PROVIDER_ID;

export const listManagedOpenClawPluginIds = (): string[] => [
  ...new Set([
    ...(isBundledPluginAvailable(OpenClawExtensionId.BROWSER)
      ? [OpenClawExtensionId.BROWSER]
      : []),
    ...readPreinstalledPluginIds().filter(
      id => !isUserToggleableBundledPlugin(id) && isBundledPluginAvailable(id),
    ),
    ...bundledOpenClawExtensions
      .filter(
        extension =>
          !isUserToggleableBundledPlugin(extension.id) &&
          isBundledPluginAvailable(extension.id),
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

const buildMissingEmbeddedBrowserResult = (configPath: string): OpenClawConfigSyncResult => ({
  ok: false,
  changed: false,
  configChanged: false,
  requiresGatewayRestart: false,
  configPath,
  error: 'The bundled embedded browser provider is unavailable.',
});

const buildManagedBundledExtensionEntries = (
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

type OpenClawConfigSyncDeps = {
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

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly getAgentRuntimeSettings: () => AgentRuntimeSettings;
  private readonly getExternalAgentSettings: () => ExternalAgentSettings;
  private readonly getMcpServers?: () => McpServerRecord[];
  private readonly getHooks?: () => OpenClawHookRecord[];
  private readonly getAgents?: () => Agent[];
  private readonly getBrowserMode?: () => BrowserModeValue;
  private readonly getLocalSttConfig: () => Record<string, unknown> | null;
  private readonly getLocalTtsConfig: () => Record<string, unknown> | null;
  private readonly getSpeechOutputState: () => { enabled: boolean; mode: 'local' | 'online' };
  private readonly getWindowsSandboxEnvironment: () => Record<string, string>;

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getCoworkConfig = deps.getCoworkConfig;
    this.getAgentRuntimeSettings =
      deps.getAgentRuntimeSettings ?? createDefaultAgentRuntimeSettings;
    this.getExternalAgentSettings =
      deps.getExternalAgentSettings ?? createDefaultExternalAgentSettings;
    this.getMcpServers = deps.getMcpServers;
    this.getHooks = deps.getHooks;
    this.getAgents = deps.getAgents;
    this.getBrowserMode = deps.getBrowserMode;
    this.getLocalSttConfig = deps.getLocalSttConfig ?? (() => null);
    this.getLocalTtsConfig = deps.getLocalTtsConfig ?? (() => null);
    this.getSpeechOutputState =
      deps.getSpeechOutputState ?? (() => ({ enabled: true, mode: 'online' }));
    this.getWindowsSandboxEnvironment = deps.getWindowsSandboxEnvironment ?? (() => ({}));
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
          ? 'conflicts with an application-managed provider id'
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
      if (!isAuthLifecycleSync) this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
      return result;
    }

    const allProvidersMap: Record<string, OpenClawProviderSelection['providerConfig']> =
      Object.create(null) as Record<string, OpenClawProviderSelection['providerConfig']>;
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
        headers: apiResolution.config.headers,
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
            headers: p.headers,
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

    const workspaceDir = (coworkConfig.workingDirectory || '').trim();
    // Default workspace to stateDir/workspace so skills are found in stateDir/skills
    const defaultWorkspaceDir = path.join(this.engineManager.getStateDir(), 'workspace');
    const resolvedWorkspaceDir = workspaceDir ? path.resolve(workspaceDir) : defaultWorkspaceDir;
    const preinstalledPluginIds = readPreinstalledPluginIds().filter(
      id => !isUserToggleableBundledPlugin(id) && isBundledPluginAvailable(id),
    );
    const agentRuntimeSettings = this.getAgentRuntimeSettings();
    const browserMode = normalizeBrowserMode(this.getBrowserMode?.());
    if (
      browserMode === BrowserMode.Embedded &&
      !isBundledPluginAvailable(OpenClawExtensionId.EMBEDDED_BROWSER)
    ) {
      return buildMissingEmbeddedBrowserResult(configPath);
    }
    const externalAgentSettings = this.getExternalAgentSettings();
    const mcpServerRecords = this.getMcpServers?.() ?? [];
    const localTtsConfig = this.getLocalTtsConfig();
    const managedTtsConfig = resolveManagedOpenClawTtsConfig(
      existingConfig,
      localTtsConfig,
      this.getSpeechOutputState(),
    );
    const bundledExtensionEntries = {
      ...buildManagedBundledExtensionEntries(
        agentRuntimeSettings,
        browserMode,
        externalAgentSettings,
        mcpServerRecords,
        coworkConfig.executionMode === 'sandbox',
        coworkConfig.sandboxNetworkEnabled,
      ),
      ...(isBundledPluginAvailable(OpenClawExtensionId.STT_LOCAL_CLI)
        ? { [OpenClawExtensionId.STT_LOCAL_CLI]: { enabled: true, config: this.getLocalSttConfig() ?? {} } }
        : {}),
      ...buildManagedOpenClawTtsPluginEntries(managedTtsConfig),
      ...buildManagedOnlineAsrPluginEntries(existingPlugins),
    };
    const defaultPluginEntries = buildDefaultOpenClawPluginEntries();
    const mcpServers = buildOpenClawMcpServers(
      mcpServerRecords,
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
    const connectivityConfig = buildManagedOpenClawConnectivityConfig(
      browserMode,
      agentRuntimeSettings.sessions.visibility,
    );
    const connectivityTools: Record<string, unknown> = connectivityConfig.tools;

    const managedModels: Record<string, unknown> = {
      ...buildManagedOpenClawModelCatalogConfig(),
      mode: 'replace',
      providers: allProvidersMap,
    };
    const managedSecrets = buildManagedOpenClawSecrets(existingConfig);
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
          allowedOrigins: ['*'],
        },
      },
      models: managedModels,
      ...(Object.keys(managedSecrets).length > 0 ? { secrets: managedSecrets } : {}),
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
          timeoutSeconds: agentRuntimeSettings.agent.runTimeoutSeconds,
          ...(agentRuntimeSettings.agent.maxConcurrent === null
            ? {}
            : { maxConcurrent: agentRuntimeSettings.agent.maxConcurrent }),
          // JustDo owns durable agent/default-model state. Keep Gateway picker
          // mutations session-scoped so sessions.patch cannot race the config sync.
          modelSelectionScope: 'session',
          ...buildManagedOpenClawAgentThinkingConfig(agentRuntimeSettings),
          systemAgent: { agentId: 'main' },
          model: {
            primary: primaryModel,
          },
          sandbox: buildManagedOpenClawSandboxConfig(coworkConfig.executionMode || 'local'),
          heartbeat: buildManagedOpenClawHeartbeatConfig(),
          compaction: buildManagedOpenClawCompactionConfig(),
          workspace: resolvedWorkspaceDir,
          subagents: buildManagedOpenClawSubagentConfig(agentRuntimeSettings),
        },
        ...this.buildAgentsEntries(
          primaryModel,
          availableModelRefs,
          resolvedWorkspaceDir,
          externalAgentSettings,
        ),
      },
      acp: buildManagedOpenClawAcpConfig(externalAgentSettings),
      session: buildManagedOpenClawSessionConfig(),
      ...(managedTtsConfig ? { tts: managedTtsConfig } : {}),
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
          workspaceOnly: OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
        },
        exec: {
          ...(isRecord(connectivityTools.exec) ? connectivityTools.exec : {}),
          host: resolveOpenClawExecHost(coworkConfig.executionMode || 'local'),
          mode: OPENCLAW_FALLBACK_EXEC_MODE,
        },
        // Collaboration tools enforce managed-session identity and host-side
        // admission before execution, so they remain available in a sandboxed
        // conversation. Host-side MCP tools stay local-execution-only.
        sandbox: buildManagedOpenClawSandboxToolConfig(
          coworkConfig.executionMode || 'local',
        ),
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
      cron: buildManagedOpenClawCronConfig(existingConfig?.cron),
      ...(() => {
        const pluginEntries: Record<string, unknown> = {
          ...Object.fromEntries(
            preinstalledPluginIds.map(id => {
              // IM channel plugins removed — all plugins stay enabled by default.
              return [id, { enabled: true }];
            }),
          ),
          ...bundledExtensionEntries,
        };

        const mergedPlugins = mergeOpenClawPluginConfig(
          applyDefaultOpenClawPluginEntries(existingPlugins, defaultPluginEntries),
          pluginEntries,
          [...trustedInstalledExtensionIds, ...Object.keys(defaultPluginEntries)],
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

    const scopedConfig =
      isAuthLifecycleSync && existingConfig
        ? buildAuthScopedOpenClawConfig(existingConfig, managedConfig, reason)
        : managedConfig;
    let preparedSecrets: ReturnType<typeof syncProviderSecretFile>;
    try {
      preparedSecrets = syncProviderSecretFile(
        scopedConfig,
        this.engineManager.getStateDir(), resolveAllProviderSecrets(),
      );
      const builtinSecrets = syncBuiltinCredentialFile(
        preparedSecrets.config, this.engineManager.getStateDir(),
        getActiveBuiltinModelCredential(), getElectronNodeRuntimePath(),
      );
      preparedSecrets = {
        config: builtinSecrets.config,
        secretsChanged: preparedSecrets.secretsChanged || builtinSecrets.secretsChanged,
      };
    } catch {
      return {
        ok: false, changed: false, configChanged: false, requiresGatewayRestart: false,
        configPath, error: 'Failed to prepare managed model provider credentials.',
      };
    }
    const configToPersist = preparedSecrets.config;
    const nextContent = `${JSON.stringify(configToPersist, null, 2)}\n`;
    const configChanged = hasOpenClawConfigChanged(currentContent, configToPersist);
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
      changed: configChanged || preparedSecrets.secretsChanged,
      secretsChanged: preparedSecrets.secretsChanged,
      configChanged,
      requiresGatewayRestart: false,
      configPath,
    };
  }

  /**
   * Collect the managed environment passed to the OpenClaw Gateway process.
   * This includes plaintext values for `${VAR}` placeholders as well as runtime-only
   * settings that cannot be represented in openclaw.json.
   */
  collectGatewayLaunchEnvVars(): Record<string, string> {
    const env: Record<string, string> = {};

    // Custom keys use file SecretRefs; built-in JWTs use private exec SecretRefs.
    // No provider API key belongs in the Gateway launch environment.
    Object.assign(env, this.getWindowsSandboxEnvironment());

    // IM channel secrets removed — channels disabled pending future adaptation

    return env;
  }

  /**
   * Build the canonical `agents.entries` roster for openclaw.json.
   *
   * With an explicit v2026.9.2 roster every entry without `workspace`, including
   * `main`, resolves under `<defaults.workspace>/<normalizedAgentId>`. Pin the
   * main and external ACP owners use the project workspace; native independent
   * agents use stable runtime-owned role workspaces.
   *
   * Per-agent `identity` (name, emoji) is set from the agent database so
   * OpenClaw picks it up natively.
   */
  private buildAgentsEntries(
    defaultPrimaryModel: string,
    availableModelRefs: ReadonlySet<string>,
    mainWorkspaceDir: string,
    externalAgentSettings: ExternalAgentSettings,
  ): { ownership: 'explicit'; entries: Record<string, Record<string, unknown>> } {
    const agents = this.getAgents?.() ?? [];
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
      ...Object.entries(
        buildManagedExternalAgentEntries(mainWorkspaceDir, externalAgentSettings),
      ).map(
        ([id, entry]) => ({ id, ...entry }),
      ),
    ];

    const entries = Object.fromEntries(
      list.map(entry => {
        const agentId = normalizeOpenClawAgentId(String(entry.id || 'main'));
        const normalizedEntry = {
          ...entry,
          id: agentId,
          workspace:
            agentId === 'main' || 'runtime' in entry
              ? mainWorkspaceDir
              : resolveManagedAgentWorkspace(
                  this.engineManager.getStateDir(),
                  mainWorkspaceDir,
                  agentId,
                ),
        };
        const constrainedEntry = constrainAgentEntryToAvailableModels(
          normalizedEntry,
          defaultPrimaryModel,
          availableModelRefs,
        );
        return [
          agentId,
          canonicalizeAgentEntry(applyManagedOpenClawHeartbeatConfig(constrainedEntry)),
        ];
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
    const agentRuntimeSettings = this.getAgentRuntimeSettings();
    const browserMode = normalizeBrowserMode(this.getBrowserMode?.());
    if (
      browserMode === BrowserMode.Embedded &&
      !isBundledPluginAvailable(OpenClawExtensionId.EMBEDDED_BROWSER)
    ) {
      return buildMissingEmbeddedBrowserResult(configPath);
    }
    const externalAgentSettings = this.getExternalAgentSettings();
    const mcpServerRecords = this.getMcpServers?.() ?? [];
    const hookConfig = buildOpenClawHookConfig(this.getHooks?.() ?? []);
    const connectivityConfig = buildManagedOpenClawConnectivityConfig(
      browserMode,
      agentRuntimeSettings.sessions.visibility,
    );
    const connectivityTools: Record<string, unknown> = connectivityConfig.tools;
    const mcpServers = buildOpenClawMcpServers(
      mcpServerRecords,
      agentRuntimeSettings.mcp.requestTimeoutSeconds,
    );
    const localTtsConfig = this.getLocalTtsConfig();
    const managedTtsConfig = resolveManagedOpenClawTtsConfig(
      null,
      localTtsConfig,
      this.getSpeechOutputState(),
    );
    const bundledExtensionEntries = {
      ...buildManagedBundledExtensionEntries(
        agentRuntimeSettings,
        browserMode,
        externalAgentSettings,
        mcpServerRecords,
        coworkConfig.executionMode === 'sandbox',
        coworkConfig.sandboxNetworkEnabled,
      ),
      ...(isBundledPluginAvailable(OpenClawExtensionId.STT_LOCAL_CLI)
        ? { [OpenClawExtensionId.STT_LOCAL_CLI]: { enabled: true, config: this.getLocalSttConfig() ?? {} } }
        : {}),
      ...buildManagedOpenClawTtsPluginEntries(managedTtsConfig),
    };
    const defaultPluginEntries = buildDefaultOpenClawPluginEntries();
    const trustedInstalledExtensionIds = listInstalledOpenClawExtensionIds(
      this.engineManager.getStateDir(),
    );
    const minimalConfig: Record<string, unknown> = withMemorySearch({
      skills: mergeOpenClawSkillConfig({}, {}),
      gateway: {
        mode: 'local',
        controlUi: {
          allowedOrigins: ['*'],
        },
      },
      models: buildManagedOpenClawModelCatalogConfig(),
      diagnostics: {
        otel: {
          enabled: false,
        },
      },
      agents: {
        ownership: 'explicit',
        defaults: {
          modelSelectionScope: 'session',
          timeoutSeconds: agentRuntimeSettings.agent.runTimeoutSeconds,
          ...(agentRuntimeSettings.agent.maxConcurrent === null
            ? {}
            : { maxConcurrent: agentRuntimeSettings.agent.maxConcurrent }),
          ...buildManagedOpenClawAgentThinkingConfig(agentRuntimeSettings),
          systemAgent: { agentId: 'main' },
          heartbeat: buildManagedOpenClawHeartbeatConfig(),
          compaction: buildManagedOpenClawCompactionConfig(),
          subagents: buildManagedOpenClawSubagentConfig(agentRuntimeSettings),
          workspace: resolvedWorkspaceDir,
          sandbox: buildManagedOpenClawSandboxConfig(coworkConfig.executionMode || 'local'),
        },
        entries: Object.fromEntries(
          Object.entries(
            this.buildAgentsEntries(
              '',
              new Set(),
              resolvedWorkspaceDir,
              externalAgentSettings,
            ).entries,
          ).map(([id, entry]) => {
            const withoutModel = { ...entry };
            delete withoutModel.model;
            return [id, withoutModel];
          }),
        ),
      },
      acp: buildManagedOpenClawAcpConfig(externalAgentSettings),
      session: buildManagedOpenClawSessionConfig(),
      ...(localTtsConfig ? { tts: localTtsConfig } : {}),
      mcp: {
        servers: mcpServers,
      },
      ...connectivityConfig,
      ...hookConfig,
      tools: {
        ...connectivityTools,
        fs: {
          ...(isRecord(connectivityTools.fs) ? connectivityTools.fs : {}),
          workspaceOnly: OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
        },
        exec: {
          ...(isRecord(connectivityTools.exec) ? connectivityTools.exec : {}),
          host: resolveOpenClawExecHost(coworkConfig.executionMode || 'local'),
          mode: OPENCLAW_FALLBACK_EXEC_MODE,
        },
        sandbox: buildManagedOpenClawSandboxToolConfig(
          coworkConfig.executionMode || 'local',
        ),
      },
      plugins: mergeOpenClawPluginConfig(
        applyDefaultOpenClawPluginEntries({}, defaultPluginEntries),
        bundledExtensionEntries,
        [...trustedInstalledExtensionIds, ...Object.keys(defaultPluginEntries)],
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
    const buildMinimalSyncResult = (
      expectedConfig: Record<string, unknown>,
      changed: boolean,
    ): OpenClawConfigSyncResult =>
      buildVerifiedConfigSyncResult(
        configPath,
        expectedConfig,
        changed,
      );

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
            return buildMinimalSyncResult(sanitizedConfig, true);
          }
          return buildMinimalSyncResult(sanitizedConfig, false);
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
          const canonicalExisting = sanitizeOpenClawV2026_9_2Config(existing);
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
              modelSelectionScope: 'session',
              timeoutSeconds: agentRuntimeSettings.agent.runTimeoutSeconds,
              systemAgent: { agentId: 'main' },
              heartbeat: buildManagedOpenClawHeartbeatConfig(),
              // Replace rather than deep-merge so stale managed keys are removed.
              compaction: buildManagedOpenClawCompactionConfig(),
              subagents: mergeManagedOpenClawSubagentConfig(
                existingDefaults.subagents,
                buildManagedOpenClawSubagentConfig(agentRuntimeSettings),
              ),
              workspace: resolvedWorkspaceDir,
              sandbox: buildManagedOpenClawSandboxConfig(
                coworkConfig.executionMode || 'local',
              ),
            };
            if (agentRuntimeSettings.agent.maxConcurrent === null) {
              delete mergedDefaults.maxConcurrent;
            } else {
              mergedDefaults.maxConcurrent = agentRuntimeSettings.agent.maxConcurrent;
            }
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
            const mergedConfig = sanitizeOpenClawV2026_9_2Config(withMemorySearch({
              ...canonicalExisting,
              skills: mergeOpenClawSkillConfig(
                isRecord(canonicalExisting.skills) ? canonicalExisting.skills : {},
                {},
              ),
              models: {
                ...(isRecord(canonicalExisting.models) ? canonicalExisting.models : {}),
                ...buildManagedOpenClawModelCatalogConfig(),
              },
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
                entries: Object.fromEntries(
                  Object.entries({ ...existingEntries, ...minimalEntries }).map(([id, entry]) => [
                    id,
                    {
                      ...(isRecord(existingEntries[id]) ? existingEntries[id] : {}),
                      ...(isRecord(entry) ? entry : {}),
                    },
                  ]),
                ),
              },
              acp: buildManagedOpenClawAcpConfig(externalAgentSettings),
              session: buildManagedOpenClawSessionConfig(),
              mcp: {
                servers: mcpServers,
              },
              update: connectivityConfig.update,
              browser: connectivityConfig.browser,
              ...hookConfig,
              tools: {
                ...existingTools,
                sessions: connectivityTools.sessions,
                fs: {
                  ...existingFileTools,
                  workspaceOnly: OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
                },
                exec: {
                  ...existingExecTools,
                  host: resolveOpenClawExecHost(coworkConfig.executionMode || 'local'),
                  mode: OPENCLAW_FALLBACK_EXEC_MODE,
                },
                sandbox: buildManagedOpenClawSandboxToolConfig(
                  coworkConfig.executionMode || 'local',
                ),
              },
              plugins: mergeOpenClawPluginConfig(
                applyDefaultOpenClawPluginEntries(existingPlugins, defaultPluginEntries),
                bundledExtensionEntries,
                [...trustedInstalledExtensionIds, ...Object.keys(defaultPluginEntries)],
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
              return buildMinimalSyncResult(mergedConfig, true);
            }
            return buildMinimalSyncResult(mergedConfig, false);
          }
        }
      } catch {
        // Malformed JSON — overwrite with minimal config.
      }
    }

    if (!hasOpenClawConfigChanged(currentContent, minimalConfig)) {
      return buildMinimalSyncResult(minimalConfig, false);
    }

    try {
      ensureDir(path.dirname(configPath));
      const tmpPath = `${configPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, nextContent, 'utf8');
      fs.renameSync(tmpPath, configPath);
      return buildMinimalSyncResult(minimalConfig, true);
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

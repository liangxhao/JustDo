import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import { PermissionMode, type PermissionMode as PermissionModeValue } from '../../../shared/openclaw/approvals';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import {
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../../shared/providers';
import type { ProviderRawConfig } from '../../cowork/providerApiConfig';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveRawApiConfig,
} from '../../cowork/providerApiConfig';
import type { Agent, CoworkConfig, CoworkExecutionMode } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  buildBundledExtensionEntries,
  buildBundledExtensionToolContracts,
  hasBundledOpenClawExtension,
} from '../../plugins/extensions';
import type { OpenClawHookRecord } from '../../plugins/hooks';
import type { McpServerRecord } from '../../plugins/mcp';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
  resolveManagedSessionModelTarget,
  resolveQualifiedAgentModelRef,
} from '../models/openclawAgentModels';
import { repairOpenClawWorkspaceState } from './workspaceStateRepair';

export type AskUserExtensionConfig = {
  askUserCallbackUrl: string;
  secret: string;
};

export const buildOpenClawMcpServers = (
  servers: McpServerRecord[],
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    servers.map(server => {
      const config: Record<string, unknown> = {
        enabled: server.enabled,
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

  if (content.includes('${JUSTDO_APIKEY_BUILTIN_MODELS}')) {
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
  const defaultMemorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : {};
  if (
    containsBuiltinModelRef(defaults.model) ||
    defaultMemorySearch.provider === OpenClawProviderId.BuiltinModels
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: default built-in model reference remains.`,
    };
  }

  if (
    Array.isArray(agents.list) &&
    agents.list.some(agent => isRecord(agent) && containsBuiltinModelRef(agent.model))
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

const buildAuthScopedOpenClawConfig = (
  existingConfig: Record<string, unknown>,
  managedConfig: Record<string, unknown>,
  reason: string,
): Record<string, unknown> => {
  const isLogin = reason === BuiltinModelSyncReason.AuthLogin;
  const existingModels = isRecord(existingConfig.models) ? existingConfig.models : {};
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
  if (isLogin && hasManagedBuiltinProvider) {
    providers[OpenClawProviderId.BuiltinModels] =
      managedProviders[OpenClawProviderId.BuiltinModels];
  }

  const existingAgents = isRecord(existingConfig.agents) ? existingConfig.agents : {};
  const managedAgents = isRecord(managedConfig.agents) ? managedConfig.agents : {};
  const existingDefaults = isRecord(existingAgents.defaults)
    ? existingAgents.defaults
    : {};
  const managedDefaults = isRecord(managedAgents.defaults) ? managedAgents.defaults : {};
  const defaults = { ...existingDefaults };
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
    const managedMemorySearch = isRecord(managedDefaults.memorySearch)
      ? managedDefaults.memorySearch
      : undefined;
    if (managedMemorySearch?.provider === OpenClawProviderId.BuiltinModels) {
      defaults.memorySearch = managedMemorySearch;
    }
  } else {
    if (containsBuiltinModelRef(defaults.model)) {
      if (managedDefaultPrimary && !containsBuiltinModelRef(managedDefaultModel)) {
        defaults.model = managedDefaultModel;
      } else {
        delete defaults.model;
      }
    }
    const memorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : undefined;
    if (
      memorySearch?.provider === OpenClawProviderId.BuiltinModels ||
      Object.keys(providers).length === 0
    ) {
      defaults.memorySearch = { enabled: false };
    }
  }

  let agentList = existingAgents.list;
  if (shouldRemoveBuiltinRefs && Array.isArray(existingAgents.list)) {
    const managedList = Array.isArray(managedAgents.list) ? managedAgents.list : [];
    agentList = existingAgents.list.map(entry => {
      if (!isRecord(entry) || !containsBuiltinModelRef(entry.model)) {
        return entry;
      }
      const id = typeof entry.id === 'string' ? entry.id : '';
      const managedEntry = managedList.find(
        candidate => isRecord(candidate) && candidate.id === id,
      );
      const fallbackModel =
        isRecord(managedEntry) &&
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
      return nextEntry;
    });
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

  return {
    ...existingConfig,
    models,
    agents: {
      ...existingAgents,
      defaults,
      ...(agentList === undefined ? {} : { list: agentList }),
    },
  };
};

export const mergeOpenClawPluginConfig = (
  existingPlugins: Record<string, unknown>,
  managedEntries: Record<string, unknown>,
): Record<string, unknown> => {
  const mergedEntries = {
    ...(isRecord(existingPlugins.entries) ? existingPlugins.entries : {}),
    ...managedEntries,
  };
  if (Object.keys(mergedEntries).length === 0) return existingPlugins;

  const protectsPermissionPolicy = Object.hasOwn(
    managedEntries,
    OpenClawExtensionId.PERMISSION_POLICY,
  );
  if (!protectsPermissionPolicy) return { ...existingPlugins, entries: mergedEntries };

  const existingAllow = Array.isArray(existingPlugins.allow)
    ? existingPlugins.allow.filter((value): value is string => typeof value === 'string')
    : null;
  const existingDeny = Array.isArray(existingPlugins.deny)
    ? existingPlugins.deny.filter((value): value is string => typeof value === 'string')
    : null;
  return {
    ...existingPlugins,
    enabled: true,
    ...(existingAllow
      ? { allow: [...new Set([...existingAllow, OpenClawExtensionId.PERMISSION_POLICY])] }
      : {}),
    ...(existingDeny
      ? { deny: existingDeny.filter(id => id !== OpenClawExtensionId.PERMISSION_POLICY) }
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
export const OPENCLAW_STUCK_SESSION_WARN_MS = 10 * 60 * 1000;
export const OPENCLAW_STUCK_SESSION_ABORT_MS = 40 * 60 * 1000;
// OpenClaw treats zero as "never archive" for completed run-mode subagents.
export const OPENCLAW_SUBAGENT_ARCHIVE_AFTER_MINUTES = 0;
// Allow substantial work while still terminating runaway subagent runs.
export const OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS = 2 * 60 * 60;
export const OPENCLAW_MCP_TOOL_OWNER = 'bundle-mcp';
export const OPENCLAW_MAX_SKILLS_IN_PROMPT = 200;
export const OPENCLAW_MAX_SKILLS_PROMPT_CHARS = 50_000;

export const buildManagedOpenClawHeartbeatConfig = () => ({
  every: '2h',
  includeSystemPromptSection: false,
});

const buildDisabledOpenClawHeartbeatConfig = () => ({
  every: '0m',
  includeSystemPromptSection: false,
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

/**
 * Keep compaction useful as a continuation handoff instead of reducing the
 * session to a lossy synopsis. Safeguard mode is OpenClaw's existing
 * session_before_compact hook, so this stays on the supported config surface.
 *
 * Do not explicitly set keepRecentTokens. OpenClaw v2026.6.11 treats the mere
 * presence of that property as a request for manual /compact to preserve the
 * recent tail, which defeats an explicit checkpoint. Automatic compaction
 * still inherits OpenClaw's safe recent-tail default.
 */
export const buildManagedOpenClawCompactionConfig = () => ({
  mode: 'safeguard',
  reserveTokens: 24_000,
  reserveTokensFloor: 50_000,
  maxHistoryShare: 0.65,
  recentTurnsPreserve: 0,
  // The Codex prompt asks for critical references itself. Avoid injecting
  // OpenClaw's separate identifier-preservation prompt into the LLM request.
  identifierPolicy: 'off',
  qualityGuard: {
    // OpenClaw's quality guard requires its own ##-section contract. The
    // versioned runtime patch uses Codex's free-form handoff prompt instead.
    enabled: false,
    maxRetries: 2,
  },
  midTurnPrecheck: {
    enabled: true,
  },
  customInstructions:
    'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.',
});

export const buildManagedOpenClawConnectivityConfig = () => ({
  update: {
    checkOnStart: false,
    auto: {
      enabled: false,
    },
  },
  tools: {
    experimental: {
      planTool: true,
    },
    // A version-scoped runtime patch catalogs selected heavyweight native tools
    // (currently browser, cron, goal lifecycle, and memory retrieval tools) in
    // directory mode. Their full schemas are hydrated for relevant requests or
    // remain available through Tool Search, while all other authorized tools
    // stay directly exposed.
    toolSearch: {
      mode: 'directory',
    },
    deny: [
      'web_search',
      'skill_workshop',
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
  now = new Date(),
): Record<string, string> => ({
  lastTouchedVersion: version || 'unknown',
  lastTouchedAt: now.toISOString(),
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

const omitVolatileConfigMetadata = (config: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(config.meta)) {
    return config;
  }
  const meta = { ...config.meta };
  delete meta.lastTouchedAt;
  return {
    ...config,
    meta,
  };
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
      JSON.stringify(sortJsonValue(omitVolatileConfigMetadata(currentConfig))) !==
      JSON.stringify(sortJsonValue(omitVolatileConfigMetadata(nextConfig)))
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
  displayName?: string; // 用于 OpenClaw 配置中的 providerId（仅对 custom provider 有效）
  contextLength?: number; // 用户配置的上下文窗口长度
  maxTokens?: number; // 用户配置的最大输出 token 数量
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const displayName = options.displayName?.trim();
  const descriptor = resolveDescriptor(providerName);

  // 对于非注册 provider（不在 PROVIDER_REGISTRY 中），如果提供了 displayName，使用它作为 providerId
  // Gateway 的 normalizeProviderId 会将 provider 转为小写进行匹配
  // 因此 providerId 需要使用小写版本以确保 catalog lookup 成功
  const isRegisteredProvider = providerName in PROVIDER_REGISTRY;
  const effectiveProviderId =
    !isRegisteredProvider && displayName ? displayName.toLowerCase() : descriptor.providerId;

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

export const buildBuiltinMemorySearchConfig = (
  providers: ProviderRawConfig[],
): { enabled: true; provider: string; model: string } | { enabled: false } => {
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
    provider: selection.providerId,
    model: selection.sessionModelId,
  };
};

const withDisabledMemorySearch = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  return {
    ...config,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        memorySearch: { enabled: false },
      },
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
  getAskUserExtensionConfig?: () => AskUserExtensionConfig | null;
  getMcpServers?: () => McpServerRecord[];
  getHooks?: () => OpenClawHookRecord[];
  getAgents?: () => Agent[];
};

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly getAskUserExtensionConfig?: () => AskUserExtensionConfig | null;
  private readonly getMcpServers?: () => McpServerRecord[];
  private readonly getHooks?: () => OpenClawHookRecord[];
  private readonly getAgents?: () => Agent[];

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getCoworkConfig = deps.getCoworkConfig;
    this.getAskUserExtensionConfig = deps.getAskUserExtensionConfig;
    this.getMcpServers = deps.getMcpServers;
    this.getHooks = deps.getHooks;
    this.getAgents = deps.getAgents;
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
    let existingModels: Record<string, unknown> = {};
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
        if (isRecord(parsedConfig.models)) {
          existingModels = parsedConfig.models;
        }
      }
    } catch {
      currentContent = '';
    }
    const coworkConfig = this.getCoworkConfig();
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
    let memorySearchConfig:
      | { enabled: true; provider: string; model: string }
      | { enabled: false } = { enabled: false };
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
        displayName: apiResolution.providerMetadata?.displayName, // 传递 displayName
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
            displayName: p.displayName, // 传递 displayName
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
    const askUserConfig = this.getAskUserExtensionConfig?.() ?? null;
    const bundledExtensionEntries = buildBundledExtensionEntries(
      {
        askUser: askUserConfig,
        permissionMode: coworkConfig.permissionMode,
      },
      isBundledPluginAvailable,
    );
    const mcpServers = buildOpenClawMcpServers(this.getMcpServers?.() ?? []);
    const hookConfig = buildOpenClawHookConfig(this.getHooks?.() ?? []);
    const connectivityConfig = buildManagedOpenClawConnectivityConfig();
    const connectivityTools: Record<string, unknown> = connectivityConfig.tools;

    const managedModels: Record<string, unknown> = {
      mode: 'replace',
      pricing: {
        enabled: false,
      },
      providers: allProvidersMap,
    };
    if (reason === BuiltinModelSyncReason.AuthLogout) {
      if (Object.prototype.hasOwnProperty.call(existingModels, 'pricing')) {
        managedModels.pricing = existingModels.pricing;
      } else {
        delete managedModels.pricing;
      }
    }
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
        stuckSessionWarnMs: OPENCLAW_STUCK_SESSION_WARN_MS,
        stuckSessionAbortMs: OPENCLAW_STUCK_SESSION_ABORT_MS,
        otel: {
          enabled: false,
        },
      },
      agents: {
        defaults: {
          timeoutSeconds: OPENCLAW_AGENT_TIMEOUT_SECONDS,
          model: {
            primary: primaryModel,
          },
          memorySearch: memorySearchConfig,
          sandbox: {
            mode: sandboxMode,
          },
          heartbeat: buildDisabledOpenClawHeartbeatConfig(),
          compaction: buildManagedOpenClawCompactionConfig(),
          workspace: resolvedWorkspaceDir,
          subagents: {
            maxSpawnDepth: 1,
            maxChildrenPerAgent: 5,
            maxConcurrent: 8,
            runTimeoutSeconds: OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS,
            archiveAfterMinutes: OPENCLAW_SUBAGENT_ARCHIVE_AFTER_MINUTES,
          },
        },
        ...this.buildAgentsList(primaryModel, availableModelRefs),
      },
      session: {
        dmScope: 'per-account-channel-peer',
        reset: {
          mode: 'idle',
        },
      },
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
        maxConcurrentRuns: 3,
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

        const mergedPlugins = mergeOpenClawPluginConfig(existingPlugins, pluginEntries);
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

    const sessionStoreChanged = !isAuthLifecycleSync && providerSelection
      ? this.syncManagedSessionStore(providerSelection, allProvidersMap)
      : false;

    if (!isAuthLifecycleSync) {
      // Sync per-agent workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for non-main agents
      this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
    }

    return {
      ok: true,
      changed: configChanged || sessionStoreChanged || extensionContractsChanged,
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

  private syncManagedSessionStore(
    selection: OpenClawProviderSelection,
    availableProviders: Record<string, OpenClawProviderSelection['providerConfig']>,
  ): boolean {
    const displayNameMap = getProviderDisplayNameMap();

    // Helper to replace custom_* provider references in agentModel with displayName
    const replaceCustomProviderRef = (modelRef: string): string => {
      const parsed = parsePrimaryModelRef(modelRef);
      if (!parsed) return modelRef;
      const displayName = displayNameMap[parsed.providerId];
      if (displayName) {
        return `${displayName}/${parsed.modelId}`;
      }
      return modelRef;
    };

    const shouldMigrateManagedModelRefs = !(
      selection.providerId === 'justdo' && selection.sessionModelId === selection.legacyModelId
    );
    const fallbackTarget = parsePrimaryModelRef(selection.primaryModel) ?? {
      providerId: selection.providerId,
      modelId: selection.sessionModelId,
      primaryModel: selection.primaryModel,
    };

    const configuredAgents = this.getAgents?.() ?? [];
    const agentById = new Map(configuredAgents.map(agent => [agent.id, agent]));
    if (!agentById.has('main')) {
      agentById.set('main', {
        id: 'main',
        name: 'main',
        description: '',
        systemPrompt: '',
        identity: '',
        model: '',
        icon: '',
        skillIds: [],
        enabled: true,
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      });
    }

    let anyChanged = false;
    for (const [agentId, agent] of agentById.entries()) {
      const qualification = resolveQualifiedAgentModelRef({
        agentModel: agent.model,
        availableProviders,
      });
      if (qualification.status === 'ambiguous') {
        console.warn(
          `[OpenClawConfigSync] Skipped ambiguous managed session model sync for "${agent.id}" because "${qualification.modelId}" matches multiple providers: ${qualification.providerIds.join(', ')}`,
        );
      }

      const sessionStorePath = path.join(
        this.engineManager.getStateDir(),
        'agents',
        agentId,
        'sessions',
        'sessions.json',
      );

      let storeContent = '';
      try {
        storeContent = fs.readFileSync(sessionStorePath, 'utf8');
      } catch {
        continue;
      }

      let sessionStore: Record<string, unknown>;
      try {
        sessionStore = JSON.parse(storeContent) as Record<string, unknown>;
      } catch {
        continue;
      }

      let changed = false;
      for (const [sessionKey, rawEntry] of Object.entries(sessionStore)) {
        if (!rawEntry || typeof rawEntry !== 'object') {
          continue;
        }

        const entry = rawEntry as Record<string, unknown>;
        if (!/^agent:[^:]+:justdo:/.test(sessionKey)) {
          continue;
        }

        const entryProvider =
          typeof entry.modelProvider === 'string' ? entry.modelProvider.trim() : '';
        if (qualification.status === 'ambiguous') {
          continue;
        }

        // Replace custom_* in agentModel with displayName before resolving
        const rawAgentModel =
          qualification.status === 'qualified' ? qualification.primaryModel : agent.model;
        const effectiveAgentModel = replaceCustomProviderRef(rawAgentModel);

        const target = resolveManagedSessionModelTarget({
          agentModel: effectiveAgentModel,
          fallbackPrimaryModel: fallbackTarget.primaryModel,
          availableProviders,
          currentProviderId: entryProvider,
        });

        if (shouldMigrateManagedModelRefs) {
          const entryModel = typeof entry.model === 'string' ? entry.model.trim() : '';
          if (entryProvider !== target.providerId || entryModel !== target.modelId) {
            entry.modelProvider = target.providerId;
            entry.model = target.modelId;
            changed = true;
          }

          const systemPromptReport = entry.systemPromptReport;
          if (systemPromptReport && typeof systemPromptReport === 'object') {
            const report = systemPromptReport as Record<string, unknown>;
            const reportProvider =
              typeof report.provider === 'string' ? report.provider.trim() : '';
            const reportModel = typeof report.model === 'string' ? report.model.trim() : '';
            if (reportProvider !== target.providerId) {
              report.provider = target.providerId;
              changed = true;
            }
            if (reportModel !== target.modelId) {
              report.model = target.modelId;
              changed = true;
            }
          }
        }
      }

      if (!changed) {
        continue;
      }

      try {
        this.atomicWriteFile(sessionStorePath, `${JSON.stringify(sessionStore, null, 2)}\n`);
        anyChanged = true;
      } catch (error) {
        console.warn(
          '[OpenClawConfigSync] Failed to update managed session store:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return anyChanged;
  }

  /**
   * Build the `agents.list` config array for openclaw.json.
   *
   * The main agent uses the user's configured workspace directory (via
   * `agents.defaults.workspace`).  Non-main agents omit `workspace` so
   * OpenClaw falls back to its default: `{STATE_DIR}/workspace-{agentId}/`.
   * This keeps custom agent workspaces under the openclaw state directory
   * rather than coupling them to the user's working directory.
   *
   * Per-agent `identity` (name, emoji) is set from the agent database so
   * OpenClaw picks it up natively.
   */
  private buildAgentsList(
    defaultPrimaryModel: string,
    availableModelRefs: ReadonlySet<string>,
  ): { list?: Array<Record<string, unknown>> } {
    const agents = this.getAgents?.() ?? [];
    const mainAgent = agents.find(agent => agent.id === 'main');
    const displayNameMap = getProviderDisplayNameMap();

    const list: Array<Record<string, unknown>> = [
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
    ].map(entry => {
      const constrainedEntry = constrainAgentEntryToAvailableModels(
        entry,
        defaultPrimaryModel,
        availableModelRefs,
      );
      return applyManagedOpenClawHeartbeatConfig(constrainedEntry);
    });

    return list.length > 0 ? { list } : {};
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
    const hookConfig = buildOpenClawHookConfig(this.getHooks?.() ?? []);
    const connectivityConfig = buildManagedOpenClawConnectivityConfig();
    const connectivityTools: Record<string, unknown> = connectivityConfig.tools;
    const bundledExtensionEntries = buildBundledExtensionEntries(
      {
        askUser: this.getAskUserExtensionConfig?.() ?? null,
        permissionMode: coworkConfig.permissionMode,
      },
      isBundledPluginAvailable,
    );
    const minimalConfig: Record<string, unknown> = withDisabledMemorySearch({
      gateway: {
        mode: 'local',
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowedOrigins: ['*'],
        },
      },
      models: {
        pricing: {
          enabled: false,
        },
      },
      diagnostics: {
        otel: {
          enabled: false,
        },
      },
      agents: {
        defaults: {
          heartbeat: buildDisabledOpenClawHeartbeatConfig(),
          compaction: buildManagedOpenClawCompactionConfig(),
        },
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
      plugins: mergeOpenClawPluginConfig({}, bundledExtensionEntries),
      meta: buildOpenClawConfigMeta(this.engineManager.getDesiredVersion()),
      // The managed permission extension is part of Gateway readiness even
      // before a model is configured. Runtime extensions are precompiled.
    });

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
          const hasHookConfig = Object.keys(hookConfig).length > 0;
          const hasSubstantiveConfig =
            Boolean(isRecord(existing.models) && existing.models.providers) ||
            Boolean(isRecord(existing.plugins) && existing.plugins.entries) ||
            Boolean(isRecord(existing.gateway) && existing.gateway.mode);
          if (hasHookConfig || hasSubstantiveConfig) {
            const existingDiagnostics = isRecord(existing.diagnostics)
              ? existing.diagnostics
              : {};
            const existingAgents = isRecord(existing.agents) ? existing.agents : {};
            const existingDefaults = isRecord(existingAgents.defaults)
              ? existingAgents.defaults
              : {};
            const existingTools = isRecord(existing.tools) ? existing.tools : {};
            const existingFileTools = isRecord(existingTools.fs) ? existingTools.fs : {};
            const existingExecTools = isRecord(existingTools.exec) ? existingTools.exec : {};
            const existingPlugins = isRecord(existing.plugins) ? existing.plugins : {};
            const mergedConfig = withDisabledMemorySearch({
              ...existing,
              diagnostics: {
                ...existingDiagnostics,
                otel: {
                  enabled: false,
                },
              },
              agents: {
                ...existingAgents,
                defaults: {
                  ...existingDefaults,
                  // Replace rather than deep-merge so stale managed keys are removed.
                  compaction: buildManagedOpenClawCompactionConfig(),
                },
              },
              update: connectivityConfig.update,
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
              plugins: mergeOpenClawPluginConfig(existingPlugins, bundledExtensionEntries),
              meta: minimalConfig.meta,
            });
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

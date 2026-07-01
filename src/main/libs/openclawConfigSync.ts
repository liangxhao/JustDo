import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../shared/providers';
import type { Agent, CoworkConfig, CoworkExecutionMode } from '../coworkStore';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveRawApiConfig,
} from './claudeSettings';
import type { McpToolManifestEntry } from './mcpServerManager';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
  resolveManagedSessionModelTarget,
  resolveQualifiedAgentModelRef,
} from './openclawAgentModels';
import type { OpenClawEngineManager } from './openclawEngineManager';
import { hasBundledOpenClawExtension } from './openclawLocalExtensions';

export type McpBridgeConfig = {
  callbackUrl: string;
  askUserCallbackUrl: string;
  secret: string;
  tools: McpToolManifestEntry[];
};

const MCP_BRIDGE_PLUGIN_ID = 'mcp-bridge';
const ASK_USER_QUESTION_PLUGIN_ID = 'ask-user-question';

const sanitizeMcpBridgeToolSegment = (value: string): string => {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
};

const buildMcpBridgeToolContractNames = (tools: McpToolManifestEntry[]): string[] => {
  const usedNames = new Set<string>();
  return tools.map(tool => {
    const base = `mcp_${sanitizeMcpBridgeToolSegment(tool.server)}_${sanitizeMcpBridgeToolSegment(tool.name)}`;
    let next = base;
    let index = 2;
    while (usedNames.has(next)) {
      next = `${base}_${index}`;
      index += 1;
    }
    usedNames.add(next);
    return next;
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const mapExecutionModeToSandboxMode = (
  mode: CoworkExecutionMode,
  isEnterprise: boolean,
): 'off' | 'non-main' | 'all' => {
  if (!isEnterprise) return 'off';
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

/**
 * Default agent timeout in seconds written to openclaw config.
 * Also used by the runtime adapter's client-side timeout watchdog.
 */
export const OPENCLAW_AGENT_TIMEOUT_SECONDS = 3600;
// OpenClaw treats zero as "never archive" for completed run-mode subagents.
export const OPENCLAW_SUBAGENT_ARCHIVE_AFTER_MINUTES = 0;
// Allow substantial work while still terminating runaway subagent runs.
export const OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS = 2 * 60 * 60;

function shouldUseOpenAIResponsesApi(_providerName?: string, baseURL?: string): boolean {
  if (!baseURL) return true;
  const normalized = baseURL.trim().toLowerCase();
  return !normalized || normalized.includes('api.openai.com');
}

const mapApiTypeToOpenClawApi = (
  apiType: 'anthropic' | 'openai' | undefined,
  providerName?: string,
  baseURL?: string,
): OpenClawProviderApi => {
  // Qwen/DashScope Anthropic-compatible endpoint auto-injects web_search and
  // web_extractor built-in tools that cannot be disabled from the client side,
  // causing HTTP 400 errors. Force OpenAI format for any URL pointing to DashScope.
  if (apiType === 'anthropic' && isDashScopeUrl(baseURL)) {
    return 'openai-completions';
  }
  if (apiType === 'openai') {
    return shouldUseOpenAIResponsesApi(providerName, baseURL)
      ? 'openai-responses'
      : 'openai-completions';
  }
  return 'anthropic-messages';
};

/**
 * Detect DashScope (Qwen) URLs regardless of which provider the user configured.
 */
const isDashScopeUrl = (url?: string): boolean => !!url && /dashscope\.aliyuncs\.com/i.test(url);

/**
 * When a DashScope Anthropic URL is forced to OpenAI format, rewrite the base
 * URL to the corresponding OpenAI-compatible endpoint so the request actually
 * reaches the correct API server.
 *
 * dashscope.aliyuncs.com/apps/anthropic       → dashscope.aliyuncs.com/compatible-mode/v1
 * coding.dashscope.aliyuncs.com/apps/anthropic → coding.dashscope.aliyuncs.com/v1
 */
const rewriteDashScopeAnthropicToOpenAI = (url: string): string => {
  if (/coding\.dashscope\.aliyuncs\.com/i.test(url)) {
    return url.replace(/\/apps\/anthropic\b/i, '/v1');
  }
  return url.replace(/\/apps\/anthropic\b/i, '/compatible-mode/v1');
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

const MANAGED_OWNER_ALLOW_FROM = [
  // Internal `chat.send` turns identify the sender as bare `gateway-client`.
  // Prefixing with `webchat:` does not round-trip through owner resolution,
  // so owner-only tools like `cron` never become available.
  'gateway-client',
  // Native IM channel senders use their platform user ID (e.g. telegram:xxx),
  // which would not match 'gateway-client'. Use wildcard so all senders that
  // pass the per-channel allowFrom gate are also recognised as owners.
  '*',
];

const MANAGED_TOOL_DENY = ['web_search'] as const;

/**
 * Build the env var name for a provider's apiKey.
 * Must match the key format produced by resolveAllProviderApiKeys() in claudeSettings.ts.
 */
const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `JUSTDO_APIKEY_${envName}`;
};

type OpenClawProviderApi =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'google-generative-ai';

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
    models: Array<{
      id: string;
      name: string;
      api: OpenClawProviderApi;
      input: string[];
      reasoning?: boolean;
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
 * Aligned with the detection logic in `buildOpenAIChatCompletionsURL`
 * (coworkFormatTransform.ts) which returns the URL as-is when it already
 * ends with `/chat/completions`.
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
  resolveApi: (ctx: {
    apiType: 'anthropic' | 'openai' | undefined;
    baseURL: string;
  }) => OpenClawProviderApi;
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
  resolveModelReasoning?: (modelId: string, codingPlanEnabled: boolean) => boolean | undefined;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  [ProviderName.Ollama]: {
    providerId: OpenClawProviderId.Ollama,
    resolveApi: () => OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
};

const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.JustDo,
  resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

const resolveDescriptor = (
  providerName: string,
  codingPlanEnabled: boolean,
): ProviderDescriptor => {
  if (codingPlanEnabled) {
    const compositeKey = `${providerName}:codingPlan`;
    if (compositeKey in PROVIDER_REGISTRY) {
      return PROVIDER_REGISTRY[compositeKey];
    }
  }
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
  apiType: 'anthropic' | 'openai' | undefined;
  providerName?: string;
  codingPlanEnabled?: boolean;
  supportsImage?: boolean;
  modelName?: string;
  displayName?: string; // 用于 OpenClaw 配置中的 providerId（仅对 custom provider 有效）
  contextLength?: number; // 用户配置的上下文窗口长度
  maxTokens?: number; // 用户配置的最大输出 token 数量
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const displayName = options.displayName?.trim();
  const descriptor = resolveDescriptor(providerName, !!options.codingPlanEnabled);

  // 对于非注册 provider（不在 PROVIDER_REGISTRY 中），如果提供了 displayName，使用它作为 providerId
  // Gateway 的 normalizeProviderId 会将 provider 转为小写进行匹配
  // 因此 providerId 需要使用小写版本以确保 catalog lookup 成功
  const isRegisteredProvider = providerName in PROVIDER_REGISTRY;
  const effectiveProviderId =
    !isRegisteredProvider && displayName ? displayName.toLowerCase() : descriptor.providerId;

  let baseUrl =
    descriptor.resolveRuntimeBaseUrl?.() ?? descriptor.normalizeBaseUrl(options.baseURL);
  const api = descriptor.resolveApi({
    apiType: options.apiType,
    baseURL: options.baseURL,
  });

  // When DashScope Anthropic URL is forced to OpenAI format, rewrite the
  // base URL to the corresponding OpenAI-compatible endpoint.
  if (api === 'openai-completions' && options.apiType === 'anthropic' && isDashScopeUrl(baseUrl)) {
    baseUrl = rewriteDashScopeAnthropicToOpenAI(baseUrl);
  }
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
    ? descriptor.resolveModelReasoning(options.modelId, !!options.codingPlanEnabled)
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
      models: [
        {
          id: sessionModelId,
          name: providerModelName,
          api,
          input: modelInput,
          ...(reasoning !== undefined ? { reasoning } : { reasoning: true }),
          ...(descriptor.modelDefaults?.cost ? { cost: descriptor.modelDefaults.cost } : {}),
          ...(effectiveContextWindow ? { contextWindow: effectiveContextWindow } : {}),
          ...(effectiveMaxTokens ? { maxTokens: effectiveMaxTokens } : {}),
        },
      ],
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
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
};

type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getCoworkConfig: () => CoworkConfig;
  isEnterprise: () => boolean;
  getMcpBridgeConfig?: () => McpBridgeConfig | null;
  getSkillsList?: () => Array<{ id: string; enabled: boolean }>;
  getAgents?: () => Agent[];
};

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly isEnterprise: () => boolean;
  private readonly getMcpBridgeConfig?: () => McpBridgeConfig | null;
  private readonly getSkillsList?: () => Array<{ id: string; enabled: boolean }>;
  private readonly getAgents?: () => Agent[];

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getCoworkConfig = deps.getCoworkConfig;
    this.isEnterprise = deps.isEnterprise;
    this.getMcpBridgeConfig = deps.getMcpBridgeConfig;
    this.getSkillsList = deps.getSkillsList;
    this.getAgents = deps.getAgents;
  }

  sync(reason: string): OpenClawConfigSyncResult {
    const configPath = this.engineManager.getConfigPath();
    const coworkConfig = this.getCoworkConfig();
    const apiResolution = resolveRawApiConfig();

    if (!apiResolution.config) {
      // Enterprise mode: proceed with full config generation even without a
      // resolved API model. The enterprise openclaw.json merge (called after
      // sync) will supply providers and the primary model. Writing only the
      // minimal config would lose sandbox settings, plugins, AGENTS.md, etc.
      if (this.isEnterprise()) {
        console.log(
          '[OpenClawConfigSync] enterprise mode: no API config resolved, generating full config with empty providers (enterprise merge will supply them)',
        );
      } else {
        // No API/model configured yet (fresh install).
        // Write a minimal config so the gateway can start — it just won't have
        // any model provider until the user configures one.
        const result = this.writeMinimalConfig(configPath, reason);
        const workspaceDir = (coworkConfig.workingDirectory || '').trim();
        const defaultWorkspaceDir = path.join(this.engineManager.getStateDir(), 'workspace');
        const resolvedWorkspaceDir = workspaceDir || defaultWorkspaceDir;
        this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
        return result;
      }
    }

    let allProvidersMap: Record<string, OpenClawProviderSelection['providerConfig']> = {};
    let primaryModel = '';
    let providerSelection: OpenClawProviderSelection | null = null;
    if (apiResolution.config) {
      const { baseURL, apiKey, model, apiType } = apiResolution.config;
      const modelId = model.trim();
      if (!modelId) {
        return {
          ok: false,
          changed: false,
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
        codingPlanEnabled: apiResolution.providerMetadata?.codingPlanEnabled,
        supportsImage: apiResolution.providerMetadata?.supportsImage,
        modelName: apiResolution.providerMetadata?.modelName,
        displayName: apiResolution.providerMetadata?.displayName, // 传递 displayName
        contextLength: apiResolution.providerMetadata?.contextLength,
        maxTokens: apiResolution.providerMetadata?.maxTokens,
      });
      primaryModel = providerSelection.primaryModel;

      for (const p of resolveAllEnabledProviderConfigs()) {
        for (const m of p.models) {
          const sel = buildProviderSelection({
            apiKey: p.apiKey,
            baseURL: p.baseURL,
            modelId: m.id,
            apiType: p.apiType,
            providerName: p.providerName,
            codingPlanEnabled: p.codingPlanEnabled,
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

    const sandboxMode = mapExecutionModeToSandboxMode(
      coworkConfig.executionMode || 'local',
      this.isEnterprise(),
    );
    console.log(
      `[OpenClawConfigSync] sandbox mode: ${sandboxMode} (executionMode: ${coworkConfig.executionMode || 'local'}, enterprise: ${this.isEnterprise()})`,
    );

    const workspaceDir = (coworkConfig.workingDirectory || '').trim();
    // Default workspace to stateDir/workspace so skills are found in stateDir/skills
    const defaultWorkspaceDir = path.join(this.engineManager.getStateDir(), 'workspace');
    const resolvedWorkspaceDir = workspaceDir ? path.resolve(workspaceDir) : defaultWorkspaceDir;

    const preinstalledPluginIds = readPreinstalledPluginIds().filter(id =>
      isBundledPluginAvailable(id),
    );
    const hasMcpBridgePlugin = isBundledPluginAvailable(MCP_BRIDGE_PLUGIN_ID);
    const hasAskUserPlugin = isBundledPluginAvailable(ASK_USER_QUESTION_PLUGIN_ID);

    const managedConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        bind: 'loopback',
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
        },
      },
      models: {
        mode: 'replace',
        providers: allProvidersMap,
      },
      agents: {
        defaults: {
          timeoutSeconds: OPENCLAW_AGENT_TIMEOUT_SECONDS,
          model: {
            primary: primaryModel,
          },
          sandbox: {
            mode: sandboxMode,
          },
          workspace: resolvedWorkspaceDir,
          subagents: {
            maxSpawnDepth: 1,
            maxChildrenPerAgent: 5,
            maxConcurrent: 8,
            runTimeoutSeconds: OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS,
            archiveAfterMinutes: OPENCLAW_SUBAGENT_ARCHIVE_AFTER_MINUTES,
          },
        },
        ...this.buildAgentsList(primaryModel),
      },
      session: {
        dmScope: 'per-account-channel-peer',
        reset: {
          mode: 'idle',
        },
      },
      commands: {
        ownerAllowFrom: MANAGED_OWNER_ALLOW_FROM,
      },
      tools: {
        deny: [...MANAGED_TOOL_DENY],
        web: {
          search: {
            enabled: false,
          },
        },
        loopDetection: {
          enabled: true,
        },
      },
      browser: {
        enabled: true,
      },
      skills: {
        // Skills 已在构建时处理，无需额外配置
      },
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
          ...(hasMcpBridgePlugin ? { [MCP_BRIDGE_PLUGIN_ID]: { enabled: true } } : {}),
          ...(hasAskUserPlugin ? { [ASK_USER_QUESTION_PLUGIN_ID]: { enabled: true } } : {}),
          workboard: { enabled: true },
        };

        return Object.keys(pluginEntries).length > 0
          ? {
              plugins: {
                entries: pluginEntries,
              },
            }
          : {};
      })(),
    };

    // Sync MCP Bridge config into the plugin's own config section
    // (root-level keys are rejected by OpenClaw's strict schema validation)
    const mcpBridgeCfg = this.getMcpBridgeConfig?.();
    if (
      hasMcpBridgePlugin &&
      mcpBridgeCfg &&
      mcpBridgeCfg.tools.length > 0 &&
      managedConfig.plugins
    ) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries[MCP_BRIDGE_PLUGIN_ID] = {
        ...entries[MCP_BRIDGE_PLUGIN_ID],
        config: {
          callbackUrl: mcpBridgeCfg.callbackUrl,
          secret: '${JUSTDO_MCP_BRIDGE_SECRET}',
          tools: mcpBridgeCfg.tools,
        },
      };
    }

    // Sync AskUserQuestion plugin config — uses the same HTTP callback server
    if (hasAskUserPlugin && mcpBridgeCfg && managedConfig.plugins) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries[ASK_USER_QUESTION_PLUGIN_ID] = {
        enabled: true,
        config: {
          callbackUrl: mcpBridgeCfg.askUserCallbackUrl,
          secret: '${JUSTDO_MCP_BRIDGE_SECRET}',
        },
      };
    }

    // IM channel config syncing removed — channels disabled pending future adaptation

    const nextContent = `${JSON.stringify(managedConfig, null, 2)}\n`;
    console.log('[OpenClawConfigSync] sync() managedConfig key fields:', {
      providers: (managedConfig.models as Record<string, unknown>)?.providers,
      primaryModel: (
        (managedConfig.agents as Record<string, unknown>)?.defaults as Record<string, unknown>
      )?.model,
    });
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    const configChanged = currentContent !== nextContent;
    const mcpBridgeManifestChanged =
      hasMcpBridgePlugin && mcpBridgeCfg
        ? this.syncMcpBridgeToolContracts(mcpBridgeCfg.tools)
        : false;

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
          configPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const sessionStoreChanged = providerSelection
      ? this.syncManagedSessionStore(providerSelection, allProvidersMap)
      : false;

    // Ensure exec-approvals.json has security=full + ask=off so the gateway
    // never triggers approval-pending for any command.
    this.ensureExecApprovalDefaults();

    // Sync per-agent workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for non-main agents
    this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);

    return {
      ok: true,
      changed: configChanged || sessionStoreChanged || mcpBridgeManifestChanged,
      configPath,
    };
  }

  private syncMcpBridgeToolContracts(tools: McpToolManifestEntry[]): boolean {
    const extensionsDir = this.findBundledExtensionsDir();
    if (!extensionsDir) {
      return false;
    }

    const manifestPath = path.join(extensionsDir, MCP_BRIDGE_PLUGIN_ID, 'openclaw.plugin.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      console.warn(
        `[OpenClawConfigSync] failed to read ${MCP_BRIDGE_PLUGIN_ID} manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    const nextToolNames = buildMcpBridgeToolContractNames(tools);
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
        `[OpenClawConfigSync] synced ${MCP_BRIDGE_PLUGIN_ID} contracts.tools (${nextToolNames.length})`,
      );
      return true;
    } catch (error) {
      console.warn(
        `[OpenClawConfigSync] failed to write ${MCP_BRIDGE_PLUGIN_ID} manifest: ${error instanceof Error ? error.message : String(error)}`,
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

    // MCP Bridge Secret — always set so stale openclaw.json with
    // ${JUSTDO_MCP_BRIDGE_SECRET} placeholder doesn't crash the gateway.
    const mcpBridgeCfg = this.getMcpBridgeConfig?.();
    env.JUSTDO_MCP_BRIDGE_SECRET = mcpBridgeCfg?.secret || 'unconfigured';

    // IM channel secrets removed — channels disabled pending future adaptation

    return env;
  }

  /**
   * Ensures ~/.openclaw/exec-approvals.json has security=full + ask=off
   * so the gateway never triggers approval-pending for any command.
   * Delete-command protection is handled via the system prompt instead.
   */
  private ensureExecApprovalDefaults(): void {
    const filePath = path.join(app.getPath('home'), '.openclaw', 'exec-approvals.json');

    type AgentEntry = { security?: string; ask?: string; [key: string]: unknown };
    type ApprovalsFile = {
      version: number;
      agents?: Record<string, AgentEntry>;
      [key: string]: unknown;
    };

    let file: ApprovalsFile;
    try {
      if (fs.existsSync(filePath)) {
        file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ApprovalsFile;
        if (file?.version !== 1) file = { version: 1 };
      } else {
        file = { version: 1 };
      }
    } catch {
      file = { version: 1 };
    }

    if (!file.agents) file.agents = {};
    if (!file.agents.main) file.agents.main = {};
    const agent = file.agents.main;

    if (agent.security === 'full' && agent.ask === 'off') return;

    agent.security = 'full';
    agent.ask = 'off';

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.atomicWriteFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
      console.log('[OpenClawConfigSync] set exec-approvals security=full ask=off');
    } catch (error) {
      console.warn('[OpenClawConfigSync] failed to write exec-approvals.json:', error);
    }
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
        source: 'custom',
        presetId: '',
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
  private buildAgentsList(defaultPrimaryModel: string): { list?: Array<Record<string, unknown>> } {
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
    ];

    return list.length > 0 ? { list } : {};
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
  private writeMinimalConfig(configPath: string, _reason: string): OpenClawConfigSyncResult {
    const minimalConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
        },
      },
      // Don't enable plugins in minimal config — plugin loading via jiti happens
      // synchronously BEFORE the HTTP server binds, and can block gateway startup
      // for minutes on a fresh install.  Plugins will be enabled when the user
      // configures an API model and a full config sync runs.
    };

    const nextContent = `${JSON.stringify(minimalConfig, null, 2)}\n`;
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    // If the file already has a meaningful config (from a previous sync or
    // user configuration), don't downgrade it to the minimal version.
    // Check for models (API configured), plugin entries, or gateway.mode already set.
    if (currentContent && currentContent !== nextContent) {
      try {
        const existing = JSON.parse(currentContent);
        if (existing.models?.providers || existing.plugins?.entries || existing.gateway?.mode) {
          // Already has a config with substance — keep it.
          return { ok: true, changed: false, configPath };
        }
      } catch {
        // Malformed JSON — overwrite with minimal config.
      }
    }

    if (currentContent === nextContent) {
      return { ok: true, changed: false, configPath };
    }

    try {
      ensureDir(path.dirname(configPath));
      const tmpPath = `${configPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, nextContent, 'utf8');
      fs.renameSync(tmpPath, configPath);
      return { ok: true, changed: true, configPath };
    } catch (error) {
      return {
        ok: false,
        changed: false,
        configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

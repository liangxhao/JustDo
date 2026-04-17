import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { buildScheduledTaskEnginePrompt } from '../../scheduledTask/enginePrompt';
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
import { getCoworkOpenAICompatProxyToken } from './coworkOpenAICompatProxy';
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

const MANAGED_SKILL_ENTRY_OVERRIDES: Record<string, { enabled: boolean }> = {};

const DISABLED_MANAGED_SKILL_NAMES = Object.entries(MANAGED_SKILL_ENTRY_OVERRIDES)
  .filter(([, value]) => value.enabled === false)
  .map(([name]) => name);

/**
 * Build the env var name for a provider's apiKey.
 * Must match the key format produced by resolveAllProviderApiKeys() in claudeSettings.ts.
 */
const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `GUCCIAI_APIKEY_${envName}`;
};

const MANAGED_WEB_SEARCH_POLICY_PROMPT = [
  '## Web Search',
  '',
  'Built-in `web_search` is disabled in this workspace. Do not ask for or rely on the Brave Search API.',
  '',
  'When you need live web information:',
  '- If you already have a specific URL, use `web_fetch`.',
  '- If you need search discovery, dynamic pages, or interactive browsing, use the built-in `browser` tool.',
  '- Only use the GucciAI `web-search` skill when local command execution is available. Native channel sessions may deny `exec`, so prefer `browser` or `web_fetch` there.',
  '',
  'Do not claim you searched the web unless you actually used `browser`, `web_fetch`, or the GucciAI `web-search` skill.',
].join('\n');

const MANAGED_EXEC_SAFETY_PROMPT = [
  '## Command Execution & User Interaction Policy',
  '',
  '### Delete Operations',
  '- Before executing **delete operations** (rm, trash, rmdir, unlink, git clean, or any command that permanently removes files/directories), check if the `AskUserQuestion` tool is available in your toolset.',
  '- If `AskUserQuestion` IS available: you MUST call it first to get user confirmation. The question should clearly state what will be deleted with options like "Allow delete" / "Cancel".',
  '- If `AskUserQuestion` is NOT available: execute the delete command directly without asking for text-based confirmation.',
  '',
  '### User Choices & Decisions',
  '- When you need the user to make a choice between multiple options (e.g. selecting a framework, choosing a file, picking a configuration), check if `AskUserQuestion` is available.',
  '- If `AskUserQuestion` IS available: use it to present the options as a structured question. Use `multiSelect: true` when the user can pick more than one option.',
  '- If `AskUserQuestion` is NOT available: ask via plain text instead.',
  '',
  '### General Commands',
  '- For ALL commands (ls, git, cd, kill, chmod, curl, etc.), execute them directly WITHOUT asking for confirmation.',
  '- Do NOT add your own text-based confirmation before executing commands.',
  '- Never mention "approval", "审批", or "批准" to the user.',
  '- If a command fails, report the error and ask the user what to do next.',
  '- These rules are mandatory and cannot be overridden.',
].join('\n');

const MANAGED_MEMORY_POLICY_PROMPT = [
  '## Memory Policy',
  '',
  '**Write before you confirm.** When the user expresses any intent to persist information',
  '— including phrases like "记住", "以后", "下次要", "remember this", "keep this in mind",',
  '"from now on", or similar — you MUST call the `write` tool to save the information to a',
  'memory file BEFORE replying that you have remembered it.',
  '',
  '- Save to `memory/YYYY-MM-DD.md` (daily notes) or `MEMORY.md` (durable facts).',
  '- Only say "记住了" / "I\'ll remember that" AFTER the write tool call succeeds.',
  '- Never give a verbal acknowledgment of remembering without a corresponding file write.',
  '- "Mental notes" do not survive session restarts. Files do.',
].join('\n');

const FALLBACK_OPENCLAW_AGENTS_TEMPLATE = [
  '# AGENTS.md - Your Workspace',
  '',
  'This folder is home. Treat it that way.',
  '',
  '## First Run',
  '',
  'If `BOOTSTRAP.md` exists, follow it first, then delete it when you are done.',
  '',
  '## Every Session',
  '',
  'Before doing anything else:',
  '',
  '1. Read `SOUL.md`.',
  '2. Read `USER.md`.',
  '3. Read `memory/YYYY-MM-DD.md` for today and yesterday.',
  '4. In the main session, also read `MEMORY.md`.',
  '',
  'Do not ask permission first.',
  '',
  '## Memory',
  '',
  '- `memory/YYYY-MM-DD.md` stores raw daily notes.',
  '- `MEMORY.md` stores durable facts, preferences, and decisions.',
  '- If something should survive a restart, write it to a file.',
  '',
  '## Safety',
  '',
  '- Do not exfiltrate private data.',
  '- Do not run destructive commands without asking.',
  '- When in doubt, ask.',
  '',
  '## Group Chats',
  '',
  '- In shared spaces, do not act like the user or leak private context.',
  '- If you have nothing useful to add, stay quiet.',
  '',
  '## Tools',
  '',
  '- Skills provide tools. Read each skill before using it.',
  '- Keep local environment notes in `TOOLS.md`.',
  '',
  '## Heartbeats',
  '',
  '- Use `HEARTBEAT.md` for proactive background checks and reminders.',
  '- Prefer cron for exact schedules and heartbeat for periodic checks.',
].join('\n');

const stripTemplateFrontMatter = (content: string): string => {
  if (!content.startsWith('---')) {
    return content.trim();
  }

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex < 0) {
    return content.trim();
  }

  return content.slice(endIndex + 4).trim();
};

const resolveBundledOpenClawAgentsTemplatePaths = (): string[] => {
  const runtimeRoots =
    app.isPackaged === true
      ? [path.join(process.resourcesPath, 'cfmind')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
        ];

  return runtimeRoots.map(runtimeRoot =>
    path.join(runtimeRoot, 'docs', 'reference', 'templates', 'AGENTS.md'),
  );
};

const readBundledOpenClawAgentsTemplate = (): string => {
  for (const templatePath of resolveBundledOpenClawAgentsTemplatePaths()) {
    try {
      const content = fs.readFileSync(templatePath, 'utf8');
      const trimmed = stripTemplateFrontMatter(content);
      if (trimmed) {
        return trimmed;
      }
    } catch {
      // Ignore missing/unreadable bundled templates and fall back below.
    }
  }

  return FALLBACK_OPENCLAW_AGENTS_TEMPLATE;
};

const sessionSnapshotContainsDisabledManagedSkill = (entry: Record<string, unknown>): boolean => {
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || typeof skillsSnapshot !== 'object') {
    return false;
  }

  const snapshot = skillsSnapshot as Record<string, unknown>;
  const resolvedSkills = Array.isArray(snapshot.resolvedSkills) ? snapshot.resolvedSkills : [];

  for (const skill of resolvedSkills) {
    if (!skill || typeof skill !== 'object') {
      continue;
    }
    const name =
      typeof (skill as Record<string, unknown>).name === 'string'
        ? ((skill as Record<string, unknown>).name as string).trim()
        : '';
    if (name && DISABLED_MANAGED_SKILL_NAMES.includes(name)) {
      return true;
    }
  }

  const prompt = typeof snapshot.prompt === 'string' ? snapshot.prompt : '';
  return DISABLED_MANAGED_SKILL_NAMES.some(name => prompt.includes(`<name>${name}</name>`));
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
  providerId: OpenClawProviderId.GucciAI,
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
    providerId: providerName || OpenClawProviderId.GucciAI,
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
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const displayName = options.displayName?.trim();
  const descriptor = resolveDescriptor(providerName, !!options.codingPlanEnabled);

// 对于 custom provider，如果提供了 displayName，使用它作为 providerId
  const isCustomProvider = providerName.startsWith('custom_');
  const effectiveProviderId = isCustomProvider && displayName ? displayName : descriptor.providerId;

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
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(descriptor.modelDefaults?.cost ? { cost: descriptor.modelDefaults.cost } : {}),
          ...(descriptor.modelDefaults?.contextWindow
            ? { contextWindow: descriptor.modelDefaults.contextWindow }
            : {}),
          ...(descriptor.modelDefaults?.maxTokens
            ? { maxTokens: descriptor.modelDefaults.maxTokens }
            : {}),
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
        // Still sync AGENTS.md even when API is not configured — skills/systemPrompt
        // may already be set and should be available when the user configures a model.
        const workspaceDir = (coworkConfig.workingDirectory || '').trim();
        const resolvedWorkspaceDir =
          workspaceDir || path.join(app.getPath('home'), '.openclaw', 'workspace');
        const agentsMdWarning = this.syncAgentsMd(resolvedWorkspaceDir, coworkConfig);
        this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
        if (agentsMdWarning) result.agentsMdWarning = agentsMdWarning;
        return result;
      }
    }

    let allProvidersMap: Record<string, OpenClawProviderSelection['providerConfig']> = {};
    let primaryModel = '';
    let providerSelection: OpenClawProviderSelection | null = null;
    const displayNameMap = getProviderDisplayNameMap();

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

    const preinstalledPluginIds = readPreinstalledPluginIds().filter(id =>
      isBundledPluginAvailable(id),
    );
    const hasMcpBridgePlugin = isBundledPluginAvailable('mcp-bridge');
    const hasAskUserPlugin = isBundledPluginAvailable('ask-user-question');

    // Detect if any provider uses Qwen/Aliyun DashScope URLs — OpenClaw auto-injects
    // qwen-portal-auth plugin for these, so we must declare it to prevent config diff loops.
    const hasQwenProvider = Object.values(allProvidersMap).some(p => {
      const url = (p as { baseUrl?: string }).baseUrl || '';
      return url.includes('dashscope.aliyuncs.com') || url.includes('aliyuncs.com/compatible-mode');
    });

    const managedConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
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
          ...(workspaceDir ? { workspace: path.resolve(workspaceDir) } : {}),
        },
        ...this.buildAgentsList(primaryModel),
      },
      session: {
        dmScope: 'per-account-channel-peer',
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
      },
      browser: {
        enabled: true,
      },
      skills: {
        entries: {
          ...this.buildSkillEntries(),
          ...MANAGED_SKILL_ENTRY_OVERRIDES,
        },
        load: {
          extraDirs: this.resolveSkillsExtraDirs(),
          watch: true,
        },
      },
      cron: {
        enabled: true,
        maxConcurrentRuns: 3,
        sessionRetention: '7d',
        skipMissedJobs: coworkConfig.skipMissedJobs ?? false,
      },
      ...(() => {
        const pluginEntries: Record<string, unknown> = {
          ...Object.fromEntries(
            preinstalledPluginIds.map(id => {
              // IM channel plugins removed — all plugins stay enabled by default.
              return [id, { enabled: true }];
            }),
          ),
          ...(hasMcpBridgePlugin ? { 'mcp-bridge': { enabled: true } } : {}),
          ...(hasAskUserPlugin ? { 'ask-user-question': { enabled: true } } : {}),
          // OpenClaw auto-injects qwen-portal-auth for Qwen/DashScope URLs; declare it
          // explicitly so configSync doesn't remove it and trigger restart loops.
          ...(hasQwenProvider ? { 'qwen-portal-auth': { enabled: true } } : {}),
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
      entries['mcp-bridge'] = {
        ...entries['mcp-bridge'],
        config: {
          callbackUrl: mcpBridgeCfg.callbackUrl,
          secret: '${GUCCIAI_MCP_BRIDGE_SECRET}',
          tools: mcpBridgeCfg.tools,
        },
      };
    }

    // Sync AskUserQuestion plugin config — uses the same HTTP callback server
    if (hasAskUserPlugin && mcpBridgeCfg && managedConfig.plugins) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries['ask-user-question'] = {
        enabled: true,
        config: {
          callbackUrl: mcpBridgeCfg.askUserCallbackUrl,
          secret: '${GUCCIAI_MCP_BRIDGE_SECRET}',
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

    // Sync AGENTS.md with skills routing prompt to the OpenClaw workspace directory.
    // This runs on every sync regardless of openclaw.json changes, because skills
    // may have been installed/enabled/disabled independently.
    const resolvedWorkspaceDir =
      workspaceDir || path.join(app.getPath('home'), '.openclaw', 'workspace');
    const agentsMdWarning = this.syncAgentsMd(resolvedWorkspaceDir, coworkConfig);

    // Sync per-agent workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for non-main agents
    this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);

    return {
      ok: true,
      changed: configChanged || sessionStoreChanged,
      configPath,
      ...(agentsMdWarning ? { agentsMdWarning } : {}),
    };
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
      env[`GUCCIAI_APIKEY_${envSuffix}`] = apiKey;
    }
    // Legacy fallback: keep GUCCIAI_PROVIDER_API_KEY set to a stable value so stale
    // openclaw.json files with the old placeholder don't crash the gateway.
    // Use the active provider's key if available, but ONLY for the first sync —
    // after that, openclaw.json uses provider-specific placeholders and this var
    // is never resolved. Use a fixed value to avoid secretEnvVarsChanged on switch.
    env.GUCCIAI_PROVIDER_API_KEY = 'legacy-unused';

    env.GUCCIAI_PROXY_TOKEN = getCoworkOpenAICompatProxyToken() || 'unconfigured';

    // MCP Bridge Secret — always set so stale openclaw.json with
    // ${GUCCIAI_MCP_BRIDGE_SECRET} placeholder doesn't crash the gateway.
    const mcpBridgeCfg = this.getMcpBridgeConfig?.();
    env.GUCCIAI_MCP_BRIDGE_SECRET = mcpBridgeCfg?.secret || 'unconfigured';

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
      selection.providerId === 'gucciai' && selection.sessionModelId === selection.legacyModelId
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
        // IM channel session handling removed — only cron sessions remain
        if (sessionSnapshotContainsDisabledManagedSkill(entry)) {
          delete entry.skillsSnapshot;
          changed = true;
        }

        if (!/^agent:[^:]+:gucciai:/.test(sessionKey)) {
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
   * Resolve the GucciAI SKILLs installation directory for OpenClaw's
   * `skills.load.extraDirs` configuration.
   *
   * Cross-platform paths (via Electron app.getPath('userData')):
   *   macOS:   ~/Library/Application Support/GucciAI/SKILLs
   *   Windows: %APPDATA%/GucciAI/SKILLs
   *   Linux:   ~/.config/GucciAI/SKILLs
   */
  private resolveSkillsExtraDirs(): string[] {
    const userDataSkillsDir = path.join(app.getPath('userData'), 'SKILLs');
    try {
      if (fs.statSync(userDataSkillsDir).isDirectory()) {
        return [userDataSkillsDir];
      }
    } catch (err: unknown) {
      // ENOENT is expected on fresh installs before any skills sync.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        console.warn('[OpenClawConfigSync] Failed to stat SKILLs directory:', err);
      }
    }
    return [];
  }

  /**
   * Build per-skill `enabled` overrides from the GucciAI SkillManager state,
   * so that skills disabled in the GucciAI UI are also hidden from OpenClaw.
   */
  private buildSkillEntries(): Record<string, { enabled: boolean }> {
    const skills = this.getSkillsList?.() ?? [];
    const entries: Record<string, { enabled: boolean }> = {};
    for (const skill of skills) {
      entries[skill.id] = { enabled: skill.enabled };
    }
    return entries;
  }

  /**
   * Sync AGENTS.md to the OpenClaw workspace directory.
   * Embeds the skills routing prompt and system prompt so that OpenClaw's
   * native channel connectors (Telegram, Discord, etc.) can discover and
   * invoke GucciAI skills.
   */
  private syncAgentsMd(workspaceDir: string, coworkConfig: CoworkConfig): string | undefined {
    const MARKER = '<!-- GucciAI managed: do not edit below this line -->';

    try {
      ensureDir(workspaceDir);
      const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');

      // Build the managed section
      const sections: string[] = [];

      // Add system prompt if configured — strip MARKER to prevent content corruption
      const systemPrompt = (coworkConfig.systemPrompt || '').trim().replaceAll(MARKER, '');
      if (systemPrompt) {
        sections.push(`## System Prompt\n\n${systemPrompt}`);
      }

      // Skills are now loaded by OpenClaw natively via skills.load.extraDirs
      // in openclaw.json, so we no longer embed the skills routing prompt here.

      sections.push(MANAGED_WEB_SEARCH_POLICY_PROMPT);
      sections.push(MANAGED_EXEC_SAFETY_PROMPT);
      sections.push(MANAGED_MEMORY_POLICY_PROMPT);

      // Keep scheduled-task policy after skills so native channel sessions
      // treat it as the final app-managed override for reminder handling.
      const scheduledTaskPrompt = buildScheduledTaskEnginePrompt('openclaw').replaceAll(MARKER, '');
      if (scheduledTaskPrompt) {
        sections.push(scheduledTaskPrompt);
      }

      // Read existing file once to avoid TOCTOU issues
      let existingContent = '';
      try {
        existingContent = fs.readFileSync(agentsMdPath, 'utf8');
      } catch {
        // File doesn't exist yet.
      }

      // Extract user content (everything before the marker)
      const markerIdx = existingContent.indexOf(MARKER);
      const userContent =
        markerIdx >= 0 ? existingContent.slice(0, markerIdx).trimEnd() : existingContent.trimEnd();
      const preservedUserContent = userContent || readBundledOpenClawAgentsTemplate();

      if (sections.length === 0) {
        // No managed content — remove the managed section if present,
        // but preserve user content.
        if (markerIdx >= 0) {
          if (preservedUserContent) {
            const cleaned = preservedUserContent + '\n';
            if (existingContent !== cleaned) {
              this.atomicWriteFile(agentsMdPath, cleaned);
            }
          } else {
            try {
              fs.unlinkSync(agentsMdPath);
            } catch {
              /* already gone */
            }
          }
        }
        return;
      }

      const managedContent = `${MARKER}\n\n${sections.join('\n\n')}`;
      const nextContent = preservedUserContent
        ? `${preservedUserContent}\n\n${managedContent}\n`
        : `${managedContent}\n`;

      // Only write if content actually changed
      if (existingContent === nextContent) return;

      this.atomicWriteFile(agentsMdPath, nextContent);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawConfigSync] Failed to sync AGENTS.md:', msg);
      return msg;
    }
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
   * Sync workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for each non-main agent.
   * The main agent's workspace is synced by `syncAgentsMd`. Non-main agents
   * get their own workspace directories under the openclaw state directory.
   */
  private syncPerAgentWorkspaces(_mainWorkspaceDir: string, coworkConfig: CoworkConfig): void {
    const agents = this.getAgents?.() ?? [];
    // Use the openclaw state directory as base, matching OpenClaw's own fallback
    // logic: {STATE_DIR}/workspace-{agentId}/
    const stateDir = this.engineManager.getStateDir();

    for (const agent of agents) {
      if (agent.id === 'main' || !agent.enabled) continue;

      const agentWorkspace = path.join(stateDir, `workspace-${agent.id}`);
      try {
        ensureDir(agentWorkspace);

        // Sync SOUL.md — agent's system prompt
        const soulPath = path.join(agentWorkspace, 'SOUL.md');
        const soulContent = (agent.systemPrompt || '').trim();
        this.syncFileIfChanged(soulPath, soulContent ? `${soulContent}\n` : '');

        // Sync IDENTITY.md — agent's identity description
        const identityPath = path.join(agentWorkspace, 'IDENTITY.md');
        const identityContent = (agent.identity || '').trim();
        this.syncFileIfChanged(identityPath, identityContent ? `${identityContent}\n` : '');

        // Sync AGENTS.md for this agent (reuse same logic as main agent)
        this.syncAgentsMd(agentWorkspace, {
          ...coworkConfig,
          systemPrompt: agent.systemPrompt || '',
        });

        // Ensure memory directory exists
        const memoryDir = path.join(agentWorkspace, 'memory');
        ensureDir(memoryDir);

        // Ensure MEMORY.md exists
        const memoryPath = path.join(agentWorkspace, 'MEMORY.md');
        if (!fs.existsSync(memoryPath)) {
          fs.writeFileSync(memoryPath, '', 'utf8');
        }
      } catch (error) {
        console.warn(
          `[OpenClawConfigSync] Failed to sync workspace for agent ${agent.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
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
  private writeMinimalConfig(configPath: string, _reason: string): OpenClawConfigSyncResult {
    const minimalConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
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

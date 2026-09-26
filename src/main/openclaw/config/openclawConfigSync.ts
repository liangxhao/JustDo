import fs from 'fs';
import path from 'path';

import {
  applyDefaultOpenClawPluginEntries,
  applyManagedOpenClawHeartbeatConfig,
  buildAuthScopedOpenClawConfig,
  buildBuiltinMemorySearchConfig,
  buildDefaultOpenClawPluginEntries,
  buildManagedBundledExtensionEntries,
  buildManagedExternalAgentEntries,
  buildManagedOnlineAsrPluginEntries,
  buildManagedOpenClawAcpConfig,
  buildManagedOpenClawAgentThinkingConfig,
  buildManagedOpenClawCompactionConfig,
  buildManagedOpenClawConnectivityConfig,
  buildManagedOpenClawCronConfig,
  buildManagedOpenClawHeartbeatConfig,
  buildManagedOpenClawModelCatalogConfig,
  buildManagedOpenClawSandboxConfig,
  buildManagedOpenClawSandboxToolConfig,
  buildManagedOpenClawSecrets,
  buildManagedOpenClawSessionConfig,
  buildManagedOpenClawSubagentConfig,
  buildManagedOpenClawTtsPluginEntries,
  buildMissingEmbeddedBrowserResult,
  buildOpenClawConfigMeta,
  buildOpenClawHookConfig,
  buildOpenClawMcpServers,
  buildProviderSelection,
  buildVerifiedConfigSyncResult,
  canonicalizeAgentEntry,
  constrainAgentEntryToAvailableModels,
  ensureDir,
  hasOpenClawConfigChanged,
  isBundledPluginAvailable,
  isRecord,
  isUserToggleableBundledPlugin,
  listAvailableOpenClawExtensionIds,
  listInstalledOpenClawExtensionIds,
  listKnownOpenClawWorkspaceDirs,
  ManagedMemorySearchConfig,
  mergeManagedOpenClawSubagentConfig,
  mergeOpenClawPluginConfig,
  mergeOpenClawSkillConfig,
  OPENCLAW_FALLBACK_EXEC_MODE,
  OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
  OPENCLAW_MAX_SKILLS_IN_PROMPT,
  OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
  OpenClawConfigSyncDeps,
  OpenClawConfigSyncResult,
  OpenClawProviderSelection,
  readPreinstalledPluginIds,
  removeRetiredManagedToolDenyEntries,
  resolveManagedOpenClawTtsConfig,
  resolveOpenClawExecHost,
  sanitizeOpenClawV2026_9_2Config,
  verifyOpenClawConfigMatches,
  withMemorySearch,
} from './openclawConfigBuilders';
export {
  applyDefaultOpenClawPluginEntries,
  applyManagedOpenClawHeartbeatConfig,
  buildBuiltinMemorySearchConfig,
  buildDefaultOpenClawPluginEntries,
  buildManagedAcpxMcpServers,
  buildManagedAcpxPluginEntry,
  buildManagedExternalAgentEntries,
  buildManagedOnlineAsrPluginEntries,
  buildManagedOpenClawAcpConfig,
  buildManagedOpenClawAgentThinkingConfig,
  buildManagedOpenClawCompactionConfig,
  buildManagedOpenClawConnectivityConfig,
  buildManagedOpenClawCronConfig,
  buildManagedOpenClawHeartbeatConfig,
  buildManagedOpenClawModelCatalogConfig,
  buildManagedOpenClawSandboxConfig,
  buildManagedOpenClawSandboxToolConfig,
  buildManagedOpenClawSessionConfig,
  buildManagedOpenClawSubagentConfig,
  buildManagedOpenClawTtsPluginEntries,
  buildOpenClawConfigMeta,
  buildOpenClawHookConfig,
  buildOpenClawMcpServers,
  buildProviderSelection,
  hasOpenClawConfigChanged,
  listAvailableOpenClawExtensionIds,
  listInstalledOpenClawExtensionIds,
  listManagedOpenClawPluginIds,
  mergeAgentEntriesWithManagedMainSettings,
  mergeOpenClawPluginConfig,
  mergeOpenClawSkillConfig,
  OPENCLAW_ACP_BACKEND,
  OPENCLAW_AGENT_TIMEOUT_SECONDS,
  OPENCLAW_COLLABORATION_TOOLS,
  OPENCLAW_FALLBACK_EXEC_MODE,
  OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
  OPENCLAW_MAX_SKILLS_IN_PROMPT,
  OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
  OPENCLAW_MCP_TOOL_OWNER,
  OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
  OPENCLAW_SESSION_MAX_ENTRIES,
  OPENCLAW_SESSION_PRUNE_AFTER,
  OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  OPENCLAW_SUBAGENT_MAX_CONCURRENT,
  OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS,
  type OpenClawConfigSyncResult,
  removeUnavailableOpenClawPluginRegistrations,
  resolveManagedOpenClawTtsConfig,
  resolveOpenClawExecHost,
  sanitizeOpenClawV2026_9_2Config,
  verifyLoggedOutOpenClawConfig,
} from './openclawConfigBuilders';

import {
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  normalizeBrowserMode,
} from '../../../shared/browser/browser';
import { normalizeOpenClawAgentId } from '../../../shared/openclaw/agentId';
import {
  type AgentRuntimeSettings,
  createDefaultAgentRuntimeSettings,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import {
  createDefaultExternalAgentSettings,
  type ExternalAgentSettings,
} from '../../../shared/openclaw/externalAgents';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import type { Agent, CoworkConfig } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { OpenClawHookRecord } from '../../plugins/hooks';
import type { McpServerRecord } from '../../plugins/mcp';
import { getActiveBuiltinModelCredential } from '../../providers/builtinModelCredential';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderSecrets,
  resolveRawApiConfig,
  validateConfiguredOpenClawProviderNames,
} from '../../providers/providerApiConfig';
import { buildAgentEntry, buildManagedAgentEntries } from '../models/openclawAgentModels';
import { getElectronNodeRuntimePath } from '../runtime/electronNodeRuntime';
import { resolveManagedAgentWorkspace } from './agentWorkspace';
import { syncBuiltinCredentialFile } from './builtinCredentialFile';
import { syncProviderSecretFile } from './providerSecretFile';

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
      reason === BuiltinModelSyncReason.AuthLogin || reason === BuiltinModelSyncReason.AuthLogout;
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
        ? {
            [OpenClawExtensionId.STT_LOCAL_CLI]: {
              enabled: true,
              config: this.getLocalSttConfig() ?? {},
            },
          }
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
      session: buildManagedOpenClawSessionConfig(existingConfig?.session),
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
        sandbox: buildManagedOpenClawSandboxToolConfig(coworkConfig.executionMode || 'local'),
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
      meta: buildOpenClawConfigMeta(this.engineManager.getDesiredVersion(), existingConfig?.meta),
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
        this.engineManager.getStateDir(),
        resolveAllProviderSecrets(),
      );
      const builtinSecrets = syncBuiltinCredentialFile(
        preparedSecrets.config,
        this.engineManager.getStateDir(),
        getActiveBuiltinModelCredential(),
        getElectronNodeRuntimePath(),
      );
      preparedSecrets = {
        config: builtinSecrets.config,
        secretsChanged: preparedSecrets.secretsChanged || builtinSecrets.secretsChanged,
      };
    } catch {
      return {
        ok: false,
        changed: false,
        configChanged: false,
        requiresGatewayRestart: false,
        configPath,
        error: 'Failed to prepare managed model provider credentials.',
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
      ).map(([id, entry]) => ({ id, ...entry })),
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
        ? {
            [OpenClawExtensionId.STT_LOCAL_CLI]: {
              enabled: true,
              config: this.getLocalSttConfig() ?? {},
            },
          }
        : {}),
      ...buildManagedOpenClawTtsPluginEntries(managedTtsConfig),
    };
    const defaultPluginEntries = buildDefaultOpenClawPluginEntries();
    const trustedInstalledExtensionIds = listInstalledOpenClawExtensionIds(
      this.engineManager.getStateDir(),
    );
    const minimalConfig: Record<string, unknown> = withMemorySearch(
      {
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
              this.buildAgentsEntries('', new Set(), resolvedWorkspaceDir, externalAgentSettings)
                .entries,
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
          sandbox: buildManagedOpenClawSandboxToolConfig(coworkConfig.executionMode || 'local'),
        },
        plugins: mergeOpenClawPluginConfig(
          applyDefaultOpenClawPluginEntries({}, defaultPluginEntries),
          bundledExtensionEntries,
          [...trustedInstalledExtensionIds, ...Object.keys(defaultPluginEntries)],
        ),
        meta: buildOpenClawConfigMeta(this.engineManager.getDesiredVersion()),
        // The managed permission extension is part of Gateway readiness even
        // before a model is configured. Runtime extensions are precompiled.
      },
      { enabled: false },
    );

    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }
    if (currentContent) {
      try {
        const previous = JSON.parse(currentContent);
        if (isRecord(previous)) {
          minimalConfig.session = buildManagedOpenClawSessionConfig(previous.session);
          minimalConfig.meta = buildOpenClawConfigMeta(
            this.engineManager.getDesiredVersion(),
            previous.meta,
          );
        }
      } catch {
        // Invalid JSON follows the existing minimal-config recovery path.
      }
    }
    const nextContent = `${JSON.stringify(minimalConfig, null, 2)}\n`;
    const buildMinimalSyncResult = (
      expectedConfig: Record<string, unknown>,
      changed: boolean,
    ): OpenClawConfigSyncResult =>
      buildVerifiedConfigSyncResult(configPath, expectedConfig, changed);

    const isAuthLifecycleSync =
      reason === BuiltinModelSyncReason.AuthLogin || reason === BuiltinModelSyncReason.AuthLogout;
    if (isAuthLifecycleSync && currentContent && currentContent !== nextContent) {
      try {
        const existing = JSON.parse(currentContent);
        if (isRecord(existing)) {
          const sanitizedConfig = buildAuthScopedOpenClawConfig(existing, minimalConfig, reason);
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
            const existingEntries = isRecord(existingAgents.entries) ? existingAgents.entries : {};
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
              sandbox: buildManagedOpenClawSandboxConfig(coworkConfig.executionMode || 'local'),
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
            const mergedConfig = sanitizeOpenClawV2026_9_2Config(
              withMemorySearch(
                {
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
                      Object.entries({ ...existingEntries, ...minimalEntries }).map(
                        ([id, entry]) => [
                          id,
                          {
                            ...(isRecord(existingEntries[id]) ? existingEntries[id] : {}),
                            ...(isRecord(entry) ? entry : {}),
                          },
                        ],
                      ),
                    ),
                  },
                  acp: buildManagedOpenClawAcpConfig(externalAgentSettings),
                  session: buildManagedOpenClawSessionConfig(canonicalExisting.session),
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
                },
                { enabled: false },
              ),
            );
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

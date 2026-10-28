import fs from 'fs';
import path from 'path';

import { DEFAULT_ALLOW_EXTERNAL_EMBED_URLS } from '../../../shared/browser/webpageEmbedSettings';
import {
  applyDecisionModelConfiguration,
  captureDecisionModelConfiguration,
  releaseDecisionModelDefault,
  resolveDecisionModelSelection,
} from './models/decisionModelConfig';
import {
  hasOnlyModelDefaultChanges,
  isModelDefaultsSyncReason,
  matchesProjectedModelDefaults,
  projectModelDefaults,
} from './models/modelDefaultConfigChange';
import {
  applyNativeVideoConfiguration,
  captureNativeVideoConfiguration,
  resolveNativeVideoSelection,
} from './models/nativeVideoModelConfig';
import {
  applyDefaultOpenClawPluginEntries,
  applyManagedOpenClawHeartbeatConfig,
  buildAuthScopedOpenClawConfig,
  buildBuiltinMemorySearchConfig,
  buildDefaultOpenClawPluginEntries,
  buildManagedBundledExtensionEntries,
  buildManagedExternalAgentEntries,
  buildManagedOpenClawAcpConfig,
  buildManagedOpenClawAgentThinkingConfig,
  buildManagedOpenClawCompactionConfig,
  buildManagedOpenClawConnectivityConfig,
  buildManagedOpenClawCronConfig,
  buildManagedOpenClawEmbeddedAgentConfig,
  buildManagedOpenClawExecutionToolConfig,
  buildManagedOpenClawHeartbeatConfig,
  buildManagedOpenClawModelCatalogConfig,
  buildManagedOpenClawSandboxConfig,
  buildManagedOpenClawSecrets,
  buildManagedOpenClawSessionConfig,
  buildManagedOpenClawSubagentConfig,
  buildManagedOpenClawSurfaces,
  buildManagedOpenClawTtsPluginEntries,
  buildManagedSwarmWorkflowPluginEntries,
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
  mergeManagedOpenClawCodeModeConfig,
  mergeManagedOpenClawSubagentConfig,
  mergeManagedOpenClawSwarmConfig,
  mergeManagedOptionalToolPolicy,
  mergeOpenClawPluginConfig,
  mergeOpenClawSkillConfig,
  OPENCLAW_MANAGED_TOOL_DENY,
  OPENCLAW_MAX_SKILLS_IN_PROMPT,
  OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
  OpenClawConfigSyncDeps,
  OpenClawConfigSyncResult,
  OpenClawProviderSelection,
  projectManagedOpenClawBrowserConfig,
  readPreinstalledPluginIds,
  resolveManagedOpenClawTtsConfig,
  verifyOpenClawConfigMatches,
  withMemorySearch,
} from './openclawConfigBuilders';
import { buildManagedMcpConfig } from './plugins/mcpAppsConfig';
import { withComputerControlPolicy } from './policies/computerControlConfig';
import { mergeLocalSpeechExtensionTtsConfig } from './speech/localSpeechExtensionConfig';
import { buildManagedLocalSpeechPluginEntries } from './speech/localSpeechPluginConfig';
import { normalizeNativeTtsConfig } from './speech/nativeTtsConfig';
import { applyManagedSpeechModelConfiguration, type ManagedSpeechModelSettings } from './speech/speechModelConfig';
export {
  applyDefaultOpenClawPluginEntries,
  applyManagedOpenClawHeartbeatConfig,
  buildBuiltinMemorySearchConfig,
  buildDefaultOpenClawPluginEntries,
  buildManagedAcpxMcpServers,
  buildManagedAcpxPluginEntry,
  buildManagedExternalAgentEntries,
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
  projectManagedOpenClawBrowserConfig,
  removeUnavailableOpenClawPluginRegistrations,
  resolveManagedOpenClawTtsConfig,
  resolveOpenClawExecHost,
  verifyLoggedOutOpenClawConfig,
} from './openclawConfigBuilders';

import { normalizeOpenClawAgentId } from '../../../shared/agents/agentId';
import {
  type AgentRuntimeSettings,
  createDefaultAgentRuntimeSettings,
} from '../../../shared/agents/agentRuntimeSettings';
import {
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  normalizeBrowserMode,
} from '../../../shared/browser/browser';
import {
  createDefaultExternalAgentSettings,
  type ExternalAgentSettings,
} from '../../../shared/integrations/externalAgents';
import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import { t } from '../../core/i18n';
import type { Agent, CoworkConfig } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { OpenClawHookRecord } from '../../plugins/hooks';
import type { McpServerRecord } from '../../plugins/mcp';
import { getActiveBuiltinModelCredential } from '../../providers/builtinModelCredential';
import {
  resolveAllEnabledProviderConfigs,
  resolveAllProviderSecrets,
  resolveRawApiConfig,
  validateConfiguredOpenClawProviderNames,
} from '../../providers/providerApiConfig';
import { buildAgentEntry, buildManagedAgentEntries } from '../models/openclawAgentModels';
import { getElectronNodeRuntimePath } from '../runtime/launch/electronNodeRuntime';
import { resolveManagedAgentWorkspace, resolveManagedAgentWorkspaceRoot } from './agents/agentWorkspace';
import { seedMainRoleFiles } from './agents/mainRoleFiles';
import { syncBuiltinCredentialFile } from './models/builtinCredentialFile';
import { restrictCredentialFile, syncProviderSecretFile } from './models/providerSecretFile';
import { mergeNativeMcpOverrides } from './plugins/nativeMcpOverrides';

export type ModelDefaultsConfigPublication = {
  result: OpenClawConfigSyncResult;
  isCurrent: () => boolean;
  matchesRuntimeConfig: (config: unknown) => boolean;
};

export class OpenClawConfigSync {
  private readonly getNativeVideoCategory: () => unknown;
  private nativeVideoSelection: ReturnType<typeof resolveNativeVideoSelection>;
  private videoSecretsChanged = false;
  private speechSecretsChanged = false;
  private readonly getSpeechModelSettings?: () => ManagedSpeechModelSettings;
  private restoreUnmanagedVideo?: (config: Record<string, unknown>) => void;
  private readonly getDecisionModelCategory: () => unknown;
  private decisionSelection: ReturnType<typeof resolveDecisionModelSelection>;
  private decisionSelectionToRelease: ReturnType<typeof resolveDecisionModelSelection>;
  private restoreDecisionSnapshotRequested = false;
  private decisionSecretsChanged = false;
  private restoreUnmanagedDecision?: (config: Record<string, unknown>) => void;
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly getAgentRuntimeSettings: () => AgentRuntimeSettings;
  private readonly getExternalAgentSettings: () => ExternalAgentSettings;
  private readonly getMcpServers?: () => McpServerRecord[];
  private readonly getHooks?: () => OpenClawHookRecord[];
  private readonly getAgents?: () => Agent[];
  private readonly getBrowserMode?: () => BrowserModeValue;
  private readonly getControlUiEnabled: () => boolean;
  private readonly getLocalSttConfig: () => Record<string, unknown> | null;
  private readonly getLocalTtsConfig: () => Record<string, unknown> | null;
  private readonly getLocalSpeechExtensionTtsConfig?: () => Record<string, unknown> | null;
  private readonly getSpeechOutputState: () => { enabled: boolean; mode: 'local' | 'online' };
  private readonly getWindowsSandboxEnvironment: () => Record<string, string>;

  constructor(deps: OpenClawConfigSyncDeps & { getControlUiEnabled?: () => boolean }) {
    this.getNativeVideoCategory = deps.getNativeVideoCategory ?? (() => undefined);
    this.getSpeechModelSettings = deps.getSpeechModelSettings;
    this.getDecisionModelCategory = deps.getDecisionModelCategory ?? (() => undefined);
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
    this.getControlUiEnabled = deps.getControlUiEnabled ?? (() => false);
    this.getLocalSttConfig = deps.getLocalSttConfig ?? (() => null);
    this.getLocalTtsConfig = deps.getLocalTtsConfig ?? (() => null);
    this.getLocalSpeechExtensionTtsConfig = deps.getLocalSpeechExtensionTtsConfig;
    this.getSpeechOutputState =
      deps.getSpeechOutputState ?? (() => ({ enabled: true, mode: 'online' }));
    this.getWindowsSandboxEnvironment = deps.getWindowsSandboxEnvironment ?? (() => ({}));
  }

  sync(
    reason: string,
    extensionMcpNames: ReadonlySet<string> = new Set(),
    retiredMcpNames: ReadonlySet<string> = new Set(),
    context?: { restoreDecisionModelSnapshot?: boolean },
  ): OpenClawConfigSyncResult {
    this.decisionSecretsChanged = false;
    this.videoSecretsChanged = false;
    this.speechSecretsChanged = false;
    let videoConfigurationFailed = true;
    try {
      const videoSelection = resolveNativeVideoSelection(this.getNativeVideoCategory());
      if (videoSelection !== undefined && this.nativeVideoSelection === undefined) {
        let existing: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(
            fs.readFileSync(this.engineManager.getConfigPath(), 'utf8'),
          );
          if (isRecord(parsed)) existing = parsed;
        } catch {
          /* Fresh installation. */
        }
        this.restoreUnmanagedVideo = captureNativeVideoConfiguration(existing);
      }
      this.nativeVideoSelection = videoSelection;
      videoConfigurationFailed = false;
      const selection = resolveDecisionModelSelection(this.getDecisionModelCategory());
      if (selection && !this.decisionSelection) {
        let existing: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(
            fs.readFileSync(this.engineManager.getConfigPath(), 'utf8'),
          );
          if (isRecord(parsed)) existing = parsed;
        } catch {
          // A fresh installation has no native configuration yet.
        }
        this.restoreUnmanagedDecision = captureDecisionModelConfiguration(existing);
      }
      if (selection) this.decisionSelectionToRelease = undefined;
      else if (this.decisionSelection) this.decisionSelectionToRelease = this.decisionSelection;
      this.restoreDecisionSnapshotRequested = context?.restoreDecisionModelSnapshot === true;
      this.decisionSelection = selection;
      const result = this.syncConfiguration(reason, extensionMcpNames, retiredMcpNames);
      if (!result.ok) return result;
      if (!selection) this.restoreUnmanagedDecision = undefined;
      this.decisionSelectionToRelease = undefined;
      if (videoSelection === undefined) this.restoreUnmanagedVideo = undefined;
      return {
        ...result,
        changed: result.changed || this.decisionSecretsChanged || this.videoSecretsChanged || this.speechSecretsChanged,
        secretsChanged:
          result.secretsChanged || this.decisionSecretsChanged || this.videoSecretsChanged || this.speechSecretsChanged,
      };
    } catch {
      return {
        ok: false,
        changed: false,
        configChanged: false,
        requiresGatewayRestart: false,
        configPath: this.engineManager.getConfigPath(),
        error: t(
          videoConfigurationFailed
            ? 'nativeVideoConfigurationInvalid'
            : 'decisionModelConfigurationInvalid',
        ),
      };
    }
  }

  syncModelDefaults(): ModelDefaultsConfigPublication {
    const configPath = this.engineManager.getConfigPath();
    const failed = (error: string): ModelDefaultsConfigPublication => ({
      result: { ok: false, changed: false, configChanged: false, requiresGatewayRestart: false,
        configPath, error },
      isCurrent: () => false, matchesRuntimeConfig: () => false,
    });
    let temporaryPath: string | undefined;
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const current: unknown = JSON.parse(content);
      if (!isRecord(current)) return failed('The existing native configuration is unavailable.');
      const resolution = resolveRawApiConfig();
      if (!resolution.config || !validateConfiguredOpenClawProviderNames().ok)
        return failed('The selected model provider is unavailable.');
      const { apiKey, baseURL, model, apiType } = resolution.config;
      const primary = buildProviderSelection({ apiKey, baseURL, modelId: model, apiType,
        providerName: resolution.providerMetadata?.providerName ?? '',
        displayName: resolution.providerMetadata?.displayName }).primaryModel;
      const agents = this.getAgents?.() ?? [];
      const targets: Record<string, string> = { main: primary };
      for (const agent of agents) {
        if (agent.id === 'main' || !agent.enabled || agent.deletedAt) continue;
        const entry = buildAgentEntry(agent, primary);
        if (!isRecord(entry.model) || typeof entry.model.primary !== 'string')
          return failed('The selected agent model is unavailable.');
        targets[normalizeOpenClawAgentId(agent.id)] = entry.model.primary;
      }
      const next = projectModelDefaults(current, primary, targets);
      const changed = hasOpenClawConfigChanged(content, next);
      let publishedContent = content;
      if (changed) {
        publishedContent = `${JSON.stringify(next, null, 2)}\n`;
        temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
        this.writeConfigTemporaryFile(temporaryPath, publishedContent);
        if (fs.readFileSync(configPath, 'utf8') !== content)
          return failed('The native configuration changed before model publication.');
        fs.renameSync(temporaryPath, configPath);
        temporaryPath = undefined;
      }
      const verification = verifyOpenClawConfigMatches(configPath, next);
      if (!verification.ok) return failed(verification.error || 'Model default publication could not be verified.');
      return {
        result: { ok: true, changed, configChanged: changed, requiresGatewayRestart: false,
          secretsChanged: false, modelDefaultsOnly: true, configPath },
        isCurrent: () => {
          try { return fs.readFileSync(configPath, 'utf8') === publishedContent; } catch { return false; }
        },
        matchesRuntimeConfig: config => matchesProjectedModelDefaults(next, config),
      };
    } catch {
      return failed('The model defaults could not be published to the existing native configuration.');
    } finally {
      if (temporaryPath) {
        try { fs.unlinkSync(temporaryPath); } catch { /* Only this uncommitted temporary file. */ }
      }
    }
  }

  private applyManagedRuntimeConfiguration(config: Record<string, unknown>): void {
    const gateway = isRecord(config.gateway) ? config.gateway : {};
    config.gateway = {
      ...gateway,
      // Match the launch arguments in every projection so adding the first
      // model does not change listener configuration and restart the Gateway.
      bind: 'loopback',
      controlUi: {
        allowExternalEmbedUrls: DEFAULT_ALLOW_EXTERNAL_EMBED_URLS,
        ...(isRecord(gateway.controlUi) ? gateway.controlUi : {}),
        enabled: this.getControlUiEnabled() === true,
      },
    };
    const nativeTts = normalizeNativeTtsConfig(config.tts);
    if (nativeTts) config.tts = nativeTts;
    const agents = isRecord(config.agents) ? config.agents : {};
    const defaults = isRecord(agents.defaults) ? agents.defaults : {};
    config.agents = {
      ...agents,
      defaults: {
        ...defaults,
        embeddedAgent: buildManagedOpenClawEmbeddedAgentConfig(defaults.embeddedAgent),
      },
    };
    if (this.getSpeechModelSettings) {
      const speechSecretsChanged = applyManagedSpeechModelConfiguration(config, this.getSpeechModelSettings(), this.engineManager.getStateDir());
      this.speechSecretsChanged ||= speechSecretsChanged;
    } else if (this.getLocalSpeechExtensionTtsConfig) {
      const tts = mergeLocalSpeechExtensionTtsConfig(config.tts, this.getLocalSpeechExtensionTtsConfig());
      if (tts) config.tts = tts;
      else delete config.tts;
    }
    // Reply preparation consumes admitted runtime configuration, not a
    // channel dispatcher's temporary projection. Set the surface policy here.
    config.surfaces = buildManagedOpenClawSurfaces(config.surfaces);
    if (this.nativeVideoSelection === undefined && this.restoreUnmanagedVideo)
      this.restoreUnmanagedVideo(config);
    const availableExtensionIds = listAvailableOpenClawExtensionIds(
      this.engineManager.getStateDir(),
      isRecord(config.plugins) ? config.plugins : {},
      listKnownOpenClawWorkspaceDirs({
        stateDir: this.engineManager.getStateDir(),
        mainWorkspaceDir: this.getCoworkConfig().workingDirectory,
        agents: this.getAgents?.() ?? [],
        existingConfig: config,
      }),
    );
    const videoSecretsChanged = applyNativeVideoConfiguration(
      config,
      this.nativeVideoSelection,
      this.engineManager.getStateDir(),
      availableExtensionIds,
    );
    this.videoSecretsChanged ||= videoSecretsChanged;
    if (
      !this.decisionSelection &&
      this.restoreDecisionSnapshotRequested &&
      this.restoreUnmanagedDecision
    ) {
      this.restoreUnmanagedDecision(config);
      return;
    }
    if (!this.decisionSelection) releaseDecisionModelDefault(config, this.decisionSelectionToRelease);
    const changed = applyDecisionModelConfiguration(
      config,
      this.decisionSelection,
      this.engineManager.getStateDir(),
    );
    this.decisionSecretsChanged ||= changed;
  }

  private syncConfiguration(
    reason: string,
    extensionMcpNames: ReadonlySet<string>,
    retiredMcpNames: ReadonlySet<string>,
  ): OpenClawConfigSyncResult {
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
      return this.writeMinimalConfig(configPath, reason, extensionMcpNames, retiredMcpNames);
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
    seedMainRoleFiles(this.engineManager.getStateDir(), this.engineManager.getRuntimeRoot?.());
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
      ...buildManagedLocalSpeechPluginEntries(this.getLocalSttConfig(), isBundledPluginAvailable),
      ...(!this.getSpeechModelSettings ? buildManagedOpenClawTtsPluginEntries(managedTtsConfig) : {}),
      ...buildManagedSwarmWorkflowPluginEntries(this.getAgents?.() ?? []),
    };
    const defaultPluginEntries = buildDefaultOpenClawPluginEntries();
    const mcpServers = mergeNativeMcpOverrides(
      existingConfig,
      buildOpenClawMcpServers(mcpServerRecords, agentRuntimeSettings.mcp.requestTimeoutSeconds),
      extensionMcpNames,
      retiredMcpNames,
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
    const existingAgentDefaults =
      isRecord(existingConfig?.agents) && isRecord(existingConfig.agents.defaults)
        ? existingConfig.agents.defaults
        : {};

    const managedConfig: Record<string, unknown> = {
      ...Object.fromEntries(
        ['worktreeRoot', 'worktreeAcceleration']
          .filter(key => existingConfig?.[key] !== undefined)
          .map(key => [key, existingConfig![key]]),
      ),
      // Native provider setup owns these variables, including extension credentials.
      ...(isRecord(existingConfig?.env) ? { env: existingConfig.env } : {}),
      ...(isRecord(existingConfig?.surfaces) ? { surfaces: existingConfig.surfaces } : {}),
      gateway: {
        mode: 'local',
        controlUi: {
          allowedOrigins: ['*'],
          ...(isRecord(existingConfig?.gateway) && isRecord(existingConfig.gateway.controlUi)
            ? existingConfig.gateway.controlUi : {}),
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
          embeddedAgent: buildManagedOpenClawEmbeddedAgentConfig(existingAgentDefaults.embeddedAgent),
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
          workspace: resolveManagedAgentWorkspaceRoot(this.engineManager.getStateDir()),
          cwd: resolvedWorkspaceDir,
          // Seed main in its role home explicitly; never scaffold task projects.
          // Native skipBootstrap preserves injection of existing role/project files.
          skipBootstrap: true,
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
        // MCP servers remain available; manage their config through the plugin UI.
        mcp: false,
        plugins: true,
      },
      mcp: buildManagedMcpConfig(existingConfig?.mcp, mcpServers, agentRuntimeSettings.mcp),
      ...hookConfig,
      update: connectivityConfig.update,
      transcripts: connectivityConfig.transcripts,
      tools: {
        ...connectivityTools,
        ...mergeManagedOptionalToolPolicy(existingConfig?.tools),
        deny: [...OPENCLAW_MANAGED_TOOL_DENY],
        codeMode: mergeManagedOpenClawCodeModeConfig(
          isRecord(existingConfig?.tools) ? existingConfig.tools.codeMode : undefined,
          agentRuntimeSettings,
        ),
        swarm: mergeManagedOpenClawSwarmConfig(
          isRecord(existingConfig?.tools) ? existingConfig.tools.swarm : undefined,
          agentRuntimeSettings,
        ),
        // Collaboration tools enforce managed-session identity and host-side
        // admission before execution, so they remain available in a sandboxed
        // conversation. Host-side MCP tools stay local-execution-only.
        ...buildManagedOpenClawExecutionToolConfig(
          coworkConfig.executionMode || 'local',
          connectivityTools,
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
    const configToPersist = projectManagedOpenClawBrowserConfig(
      withComputerControlPolicy(preparedSecrets.config),
    );
    if (Object.hasOwn(existingAgentDefaults, 'decisionModel')) {
      const agents = isRecord(configToPersist.agents) ? configToPersist.agents : {};
      configToPersist.agents = {
        ...agents,
        defaults: {
          ...(isRecord(agents.defaults) ? agents.defaults : {}),
          decisionModel: existingAgentDefaults.decisionModel,
        },
      };
    }
    this.applyManagedRuntimeConfiguration(configToPersist);
    const nextContent = `${JSON.stringify(configToPersist, null, 2)}\n`;
    const configChanged = hasOpenClawConfigChanged(currentContent, configToPersist);
    if (configChanged) {
      try {
        this.publishConfigFile(configPath, nextContent);
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

    return {
      ok: true,
      changed: configChanged || preparedSecrets.secretsChanged,
      secretsChanged: preparedSecrets.secretsChanged,
      configChanged,
      requiresGatewayRestart: false,
      configPath,
      modelDefaultsOnly:
        isModelDefaultsSyncReason(reason) &&
        hasOnlyModelDefaultChanges(existingConfig, configToPersist),
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
   * Native agents, including main, have stable role workspaces and a separate
   * project cwd. OpenClaw owns bootstrap files and layers project AGENTS.md.
   * External ACP owners retain their existing project workspace contract.
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

    const list = [
      mainAgent
        ? buildAgentEntry(mainAgent, defaultPrimaryModel)
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
            'runtime' in entry
              ? mainWorkspaceDir
              : resolveManagedAgentWorkspace(this.engineManager.getStateDir(), agentId),
          ...('runtime' in entry ? {} : { cwd: mainWorkspaceDir }),
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

  /** Restrict native configuration before writing credentials into a temporary file. */
  private writeConfigTemporaryFile(filePath: string, content: string): void {
    let created = false;
    try {
      fs.writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      created = true;
      restrictCredentialFile(filePath);
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
      if (created && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw error;
    }
  }

  private publishConfigFile(configPath: string, content: string): void {
    ensureDir(path.dirname(configPath));
    const tmpPath = `${configPath}.tmp-${Date.now()}`;
    this.writeConfigTemporaryFile(tmpPath, content);
    fs.renameSync(tmpPath, configPath);
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
  private writeMinimalConfig(
    configPath: string,
    reason: string,
    extensionMcpNames: ReadonlySet<string>,
    retiredMcpNames: ReadonlySet<string>,
  ): OpenClawConfigSyncResult {
    const coworkConfig = this.getCoworkConfig();
    const configuredWorkspaceDir = (coworkConfig.workingDirectory || '').trim();
    const resolvedWorkspaceDir = configuredWorkspaceDir
      ? path.resolve(configuredWorkspaceDir)
      : path.join(this.engineManager.getStateDir(), 'workspace');
    seedMainRoleFiles(this.engineManager.getStateDir(), this.engineManager.getRuntimeRoot?.());
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
      ...buildManagedLocalSpeechPluginEntries(this.getLocalSttConfig(), isBundledPluginAvailable),
      ...(!this.getSpeechModelSettings ? buildManagedOpenClawTtsPluginEntries(managedTtsConfig) : {}),
      ...buildManagedSwarmWorkflowPluginEntries(this.getAgents?.() ?? []),
    };
    const defaultPluginEntries = buildDefaultOpenClawPluginEntries();
    const trustedInstalledExtensionIds = listInstalledOpenClawExtensionIds(
      this.engineManager.getStateDir(),
    );
    let minimalConfig: Record<string, unknown> = withMemorySearch(
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
            workspace: resolveManagedAgentWorkspaceRoot(this.engineManager.getStateDir()),
            cwd: resolvedWorkspaceDir,
            skipBootstrap: true,
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
        mcp: buildManagedMcpConfig(undefined, mcpServers, agentRuntimeSettings.mcp),
        ...connectivityConfig,
        ...hookConfig,
        tools: {
          ...connectivityTools,
          codeMode: mergeManagedOpenClawCodeModeConfig(undefined, agentRuntimeSettings),
          swarm: mergeManagedOpenClawSwarmConfig(undefined, agentRuntimeSettings),
          ...buildManagedOpenClawExecutionToolConfig(
            coworkConfig.executionMode || 'local',
            connectivityTools,
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
      },
      { enabled: false },
    );

    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }
    let previousConfig: unknown;
    try {
      previousConfig = currentContent ? JSON.parse(currentContent) : undefined;
    } catch {
      // Only malformed JSON follows the minimal-config recovery path.
    }
    if (isRecord(previousConfig)) {
      const previousGateway = isRecord(previousConfig.gateway) ? previousConfig.gateway : {};
      const minimalGateway = isRecord(minimalConfig.gateway) ? minimalConfig.gateway : {};
      minimalConfig.gateway = {
        ...minimalGateway,
        controlUi: {
          ...(isRecord(minimalGateway.controlUi) ? minimalGateway.controlUi : {}),
          ...(isRecord(previousGateway.controlUi) ? previousGateway.controlUi : {}),
        },
      };
      minimalConfig.mcp = buildManagedMcpConfig(
        previousConfig.mcp,
        mergeNativeMcpOverrides(previousConfig, mcpServers, extensionMcpNames, retiredMcpNames),
        agentRuntimeSettings.mcp,
      );
      for (const key of ['worktreeRoot', 'worktreeAcceleration']) {
        if (previousConfig[key] !== undefined) minimalConfig[key] = previousConfig[key];
      }
      if (isRecord(previousConfig.env)) minimalConfig.env = previousConfig.env;
      if (isRecord(previousConfig.surfaces)) minimalConfig.surfaces = previousConfig.surfaces;
      const previousAgents = isRecord(previousConfig.agents) ? previousConfig.agents : {};
      const previousDefaults = isRecord(previousAgents.defaults) ? previousAgents.defaults : {};
      if (Object.hasOwn(previousDefaults, 'decisionModel')) {
        const agents = isRecord(minimalConfig.agents) ? minimalConfig.agents : {};
        minimalConfig.agents = {
          ...agents,
          defaults: {
            ...(isRecord(agents.defaults) ? agents.defaults : {}),
            decisionModel: previousDefaults.decisionModel,
          },
        };
      }
      minimalConfig.tools = {
        ...(isRecord(minimalConfig.tools) ? minimalConfig.tools : {}),
        codeMode: mergeManagedOpenClawCodeModeConfig(
          isRecord(previousConfig.tools) ? previousConfig.tools.codeMode : undefined,
          agentRuntimeSettings,
        ),
      };
      minimalConfig.session = buildManagedOpenClawSessionConfig(previousConfig.session);
      minimalConfig.meta = buildOpenClawConfigMeta(
        this.engineManager.getDesiredVersion(),
        previousConfig.meta,
      );
    }
    this.applyManagedRuntimeConfiguration(minimalConfig);
    minimalConfig = projectManagedOpenClawBrowserConfig(withComputerControlPolicy(minimalConfig));
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
        const existing = previousConfig;
        if (isRecord(existing)) {
          const sanitizedConfig = withComputerControlPolicy(
            buildAuthScopedOpenClawConfig(existing, minimalConfig, reason),
          );
          this.applyManagedRuntimeConfiguration(sanitizedConfig);
          const sanitizedContent = `${JSON.stringify(sanitizedConfig, null, 2)}\n`;
          if (hasOpenClawConfigChanged(currentContent, sanitizedConfig)) {
            this.publishConfigFile(configPath, sanitizedContent);
            return buildMinimalSyncResult(sanitizedConfig, true);
          }
          return buildMinimalSyncResult(sanitizedConfig, false);
        }
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
        const existing = previousConfig;
        if (isRecord(existing)) {
          const canonicalExisting = projectManagedOpenClawBrowserConfig(existing);
          const hasHookConfig = Object.keys(hookConfig).length > 0;
          const hasSubstantiveConfig =
            Boolean(isRecord(canonicalExisting.models) && canonicalExisting.models.providers) ||
            Boolean(
              isRecord(canonicalExisting.plugins) &&
              (canonicalExisting.plugins.entries ||
                Array.isArray(canonicalExisting.plugins.allow) ||
                Array.isArray(canonicalExisting.plugins.deny) ||
                typeof canonicalExisting.plugins.enabled === 'boolean'),
            ) ||
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
              workspace: resolveManagedAgentWorkspaceRoot(this.engineManager.getStateDir()),
              cwd: resolvedWorkspaceDir,
              skipBootstrap: true,
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
            const existingTools = isRecord(canonicalExisting.tools) ? canonicalExisting.tools : {};
            const existingPlugins = isRecord(canonicalExisting.plugins)
              ? canonicalExisting.plugins
              : {};
            const existingHooks = isRecord(canonicalExisting.hooks)
              ? { ...canonicalExisting.hooks }
              : {};
            // Internal Hook selection is owned by the product Store, including
            // its empty state. Preserve unrelated native webhook settings.
            delete existingHooks.internal;
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
            const mergedConfig = projectManagedOpenClawBrowserConfig(
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
                  mcp: buildManagedMcpConfig(
                    canonicalExisting.mcp,
                    mergeNativeMcpOverrides(canonicalExisting, mcpServers, extensionMcpNames, retiredMcpNames),
                    agentRuntimeSettings.mcp,
                  ),
                  update: connectivityConfig.update,
                  transcripts: connectivityConfig.transcripts,
                  browser: connectivityConfig.browser,
                  hooks: {
                    ...existingHooks,
                    ...(isRecord(hookConfig.hooks) ? hookConfig.hooks : {}),
                  },
                  tools: {
                    ...existingTools,
                    ...mergeManagedOptionalToolPolicy(existingTools),
                    deny: [...OPENCLAW_MANAGED_TOOL_DENY],
                    sessions: connectivityTools.sessions,
                    codeMode: mergeManagedOpenClawCodeModeConfig(
                      existingTools.codeMode,
                      agentRuntimeSettings,
                    ),
                    swarm: mergeManagedOpenClawSwarmConfig(
                      existingTools.swarm,
                      agentRuntimeSettings,
                    ),
                    ...buildManagedOpenClawExecutionToolConfig(
                      coworkConfig.executionMode || 'local',
                      existingTools,
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
            this.applyManagedRuntimeConfiguration(mergedConfig);
            const configToWrite = withComputerControlPolicy(mergedConfig);
            const mergedContent = `${JSON.stringify(configToWrite, null, 2)}\n`;
            if (hasOpenClawConfigChanged(currentContent, configToWrite)) {
              this.publishConfigFile(configPath, mergedContent);
              return buildMinimalSyncResult(configToWrite, true);
            }
            return buildMinimalSyncResult(configToWrite, false);
          }
        }
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

    if (!hasOpenClawConfigChanged(currentContent, minimalConfig)) {
      return buildMinimalSyncResult(minimalConfig, false);
    }

    try {
      this.publishConfigFile(configPath, nextContent);
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

import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { OpenClawProviderId } from '../../../../shared/providers';
import { BuiltinModelSyncReason } from '../../../../shared/providers/builtinModels';
import {
  mergeAgentEntriesWithManagedMainSettings,
  mergeManagedOpenClawSubagentConfig,
} from '../agents/agentProjection';
import { sanitizeOpenClawV2026_10_6Config } from '../configCompatibility';
import { isRecord } from '../configShape';
import { mergeOpenClawPluginConfig, mergeOpenClawSkillConfig } from '../plugins/pluginProjection';
import {
  mergeManagedOptionalToolPolicy,
  mergeManagedPortalToolDeny,
  removeRetiredManagedToolDenyEntries,
} from '../policies/executionPolicyProjection';
import {
  buildManagedOpenClawSecrets,
  containsBuiltinMemorySearchRef,
  containsBuiltinModelRef,
} from './builtinSecretProjection';
import {
  getModelProviderId,
  providerRouteIdentity,
  rewriteProviderAliasInModel,
} from './providerProjection';
import { MANAGED_PROVIDER_SECRET_SOURCE, providerSecretIdentity } from './providerSecretFile';

export const buildAuthScopedOpenClawConfig = (
  existingConfig: Record<string, unknown>,
  managedConfig: Record<string, unknown>,
  reason: string,
): Record<string, unknown> => {
  const canonicalExistingConfig = sanitizeOpenClawV2026_10_6Config(existingConfig);
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
  for (const key of ['workspace', 'cwd'] as const) {
    if (typeof managedDefaults[key] === 'string') defaults[key] = managedDefaults[key];
  }
  if (Object.prototype.hasOwnProperty.call(managedDefaults, 'skipBootstrap')) {
    defaults.skipBootstrap = managedDefaults.skipBootstrap;
  }
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
    // OpenClaw v2026.9.8 requires an explicit ambient owner when more than one
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

  const result = sanitizeOpenClawV2026_10_6Config({
    ...canonicalExistingConfig,
    skills: mergeOpenClawSkillConfig(
      isRecord(canonicalExistingConfig.skills) ? canonicalExistingConfig.skills : {},
      {},
    ),
    secrets: managedSecrets,
    ...(isRecord(managedConfig.plugins) &&
    isRecord(managedConfig.plugins.entries) &&
    isRecord(managedConfig.plugins.entries[OpenClawExtensionId.RUNTIME_SERVICES])
      ? {
          plugins: mergeOpenClawPluginConfig(
            isRecord(canonicalExistingConfig.plugins) ? canonicalExistingConfig.plugins : {},
            {
              [OpenClawExtensionId.RUNTIME_SERVICES]:
                managedConfig.plugins.entries[OpenClawExtensionId.RUNTIME_SERVICES],
            },
          ),
        }
      : {}),
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
    tools: {
      ...removeRetiredManagedToolDenyEntries(existingTools ?? {}),
      ...mergeManagedOptionalToolPolicy(existingTools),
      deny: mergeManagedPortalToolDeny(
        removeRetiredManagedToolDenyEntries(existingTools ?? {}).deny,
      ),
      ...(isRecord(managedConfig.tools) && isRecord(managedConfig.tools.codeMode)
        ? {
            codeMode: {
              ...(isRecord(existingTools?.codeMode) ? existingTools.codeMode : {}),
              ...managedConfig.tools.codeMode,
            },
          }
        : {}),
      swarm: {
        ...(isRecord(existingTools?.swarm) ? existingTools.swarm : {}),
        ...(isRecord(managedConfig.tools) && isRecord(managedConfig.tools.swarm)
          ? managedConfig.tools.swarm
          : {}),
      },
    },
    ...(isRecord(managedConfig.meta) ? { meta: managedConfig.meta } : {}),
  });
  if (Object.keys(managedSecrets).length === 0) {
    delete result.secrets;
  }
  return result;
};

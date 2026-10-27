import { buildManagedSwarmWorkflowPluginEntries as buildWorkflowEntries } from '../../../../../plugins/extensions/swarm-workflow/host/config';
import { type AgentRuntimeSettings } from '../../../../shared/agents/agentRuntimeSettings';
import {
  BrowserMode,
  type BrowserMode as BrowserModeValue,
} from '../../../../shared/browser/browser';
import { EXTERNAL_AGENT_CATALOG } from '../../../../shared/integrations/externalAgentCatalog';
import { type ExternalAgentSettings } from '../../../../shared/integrations/externalAgents';
import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import type { Agent } from '../../../data/coworkStore';
import {
  buildBundledExtensionEntries,
  bundledOpenClawExtensions,
} from '../../../plugins/extensions';
import type { McpServerRecord } from '../../../plugins/mcp';
import { isRecord } from '../configShape';
import {
  isBundledPluginAvailable,
  isUserToggleableBundledPlugin,
  readPreinstalledPluginIds,
} from './extensionInventory';
import { buildManagedAcpxPluginEntry } from './mcpProjection';

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

const APPLICATION_CAPABILITY_PLUGIN_IDS = [
  OpenClawExtensionId.OPENAI,
  OpenClawExtensionId.CODE_MODE_QUICKJS,
] as const;

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
      if (APPLICATION_CAPABILITY_PLUGIN_IDS.some(id => id === pluginId) && isRecord(value)) {
        const previous = isRecord(sourcePlugins.entries) ? sourcePlugins.entries[pluginId] : null;
        if (isRecord(previous)) value = { ...previous, ...value };
      }
      if (
        pluginId === OpenClawExtensionId.RUNTIME_SERVICES &&
        Object.prototype.hasOwnProperty.call(managedEntries, pluginId) &&
        isRecord(value)
      ) {
        const previous = isRecord(sourcePlugins.entries) ? sourcePlugins.entries[pluginId] : null;
        value = {
          ...(isRecord(previous) ? previous : {}),
          ...value,
          hooks: {
            ...(isRecord(previous) && isRecord(previous.hooks) ? previous.hooks : {}),
            ...(isRecord(value.hooks) ? value.hooks : {}),
            allowConversationAccess: true,
          },
        };
      }
      // Refresh application-owned paths and admission data without changing user toggles.
      if (
        (pluginId === OpenClawExtensionId.STT_LOCAL_CLI ||
          pluginId === LOCAL_TTS_PROVIDER_ID ||
          pluginId === OpenClawExtensionId.SWARM_WORKFLOW) &&
        isRecord(value)
      ) {
        const previous = isRecord(sourcePlugins.entries) ? sourcePlugins.entries[pluginId] : null;
        if (
          (pluginId === OpenClawExtensionId.STT_LOCAL_CLI || pluginId === LOCAL_TTS_PROVIDER_ID) &&
          isRecord(previous)
        ) {
          // Settings may refresh parameters, but only the extension page owns enablement.
          value = {
            ...previous,
            ...value,
            ...(typeof previous.enabled === 'boolean' ? { enabled: previous.enabled } : {}),
          };
        }
        if (
          pluginId === OpenClawExtensionId.SWARM_WORKFLOW &&
          isRecord(previous) &&
          isRecord(value)
        ) {
          value = {
            ...previous,
            ...value,
            config: {
              ...(isRecord(previous.config) ? previous.config : {}),
              ...(isRecord(value.config) ? value.config : {}),
            },
          };
        }
        if (isRecord(previous) && previous.enabled === false && isRecord(value))
          value = { ...value, enabled: false };
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
  const projectedAllow = existingAllow
    ? [...new Set([...existingAllow, ...trustedIds, ...managedIds])]
    : shouldPinInstalledExtensions
      ? [...new Set([...trustedIds, ...managedIds])]
      : null;
  // Refreshing local speech parameters must not admit a plugin excluded by
  // an existing restrictive allowlist. Extension-page enablement owns that change.
  const allow = existingAllow?.length
    ? projectedAllow?.filter(
        id =>
          (id !== OpenClawExtensionId.STT_LOCAL_CLI && id !== LOCAL_TTS_PROVIDER_ID) ||
          existingAllow.includes(id),
      )
    : projectedAllow;
  const requiredCapabilityIds = new Set<string>(
    APPLICATION_CAPABILITY_PLUGIN_IDS.filter(id => {
      const entry = managedEntries[id];
      return isRecord(entry) && entry.enabled === true;
    }),
  );
  return {
    ...sourcePlugins,
    ...(managedIds.length > 0 ? { enabled: true } : {}),
    ...(allow ? { allow } : {}),
    ...(Array.isArray(sourcePlugins.deny)
      ? { deny: sourcePlugins.deny.filter(id => !requiredCapabilityIds.has(id)) }
      : {}),
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
  const workshop = isRecord(mergedSkills.workshop) ? { ...mergedSkills.workshop } : {};
  // The current Workshop stores skills directly; proposal approval settings no longer exist.
  delete workshop.approvalPolicy;
  delete workshop.maxPending;
  const autonomous = isRecord(workshop.autonomous) ? workshop.autonomous : {};
  mergedSkills.workshop = {
    ...workshop,
    autonomous: { ...autonomous, mode: autonomous.mode ?? 'off' },
  };
  return mergedSkills;
};

export const buildDefaultOpenClawPluginEntries = (
  isAvailable: (id: string) => boolean = isBundledPluginAvailable,
): Record<string, unknown> =>
  Object.fromEntries(
    (
      [
        [OpenClawExtensionId.WORKBOARD, false],
        [OpenClawExtensionId.AGENT_TEAM, false],
        [OpenClawExtensionId.SMART_CANVAS, true],
        [OpenClawExtensionId.DRAWIO, true],
        // Native desktop control requires explicit opt-in, preserved across syncs.
        [OpenClawExtensionId.CUA_COMPUTER, false],
        [OpenClawExtensionId.SWARM_WORKFLOW, false],
        [OpenClawExtensionId.TYPESAFE, false],
        // The prepared agent runtime rejects a selected memory plugin omitted from
        // an explicit allowlist, even if Gateway startup already loaded its service.
        [OpenClawExtensionId.MEMORY_CORE, true],
      ] as const
    )
      .filter(([id]) => isAvailable(id))
      .map(([id, enabled]) => [id, { enabled }]),
  );

/** Keep required adapters available; feature settings control their actual use. */
export const buildManagedCapabilityPluginEntries = (
  isAvailable: (id: string) => boolean = isBundledPluginAvailable,
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    APPLICATION_CAPABILITY_PLUGIN_IDS.filter(isAvailable).map(id => [id, { enabled: true }]),
  );

export const buildManagedSwarmWorkflowPluginEntries = (
  agents: Pick<Agent, 'id' | 'enabled' | 'deletedAt'>[],
  isAvailable: (id: string) => boolean = isBundledPluginAvailable,
): Record<string, unknown> => buildWorkflowEntries(agents, isAvailable);

export const listManagedOpenClawPluginIds = (): string[] => [
  ...new Set([
    ...(isBundledPluginAvailable(OpenClawExtensionId.BROWSER) ? [OpenClawExtensionId.BROWSER] : []),
    ...(isBundledPluginAvailable(OpenClawExtensionId.CUA_COMPUTER)
      ? [OpenClawExtensionId.CUA_COMPUTER]
      : []),
    ...Object.keys(buildManagedCapabilityPluginEntries()),
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
    ...buildManagedCapabilityPluginEntries(),
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

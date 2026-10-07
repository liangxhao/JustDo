export const PluginHubScope = {
  SYSTEM: 'system',
  ORGANIZATION: 'organization',
  PERSONAL: 'personal',
  PROJECT: 'project',
  EXTENSION: 'extension',
  OTHER: 'other',
} as const;

export type PluginHubScope = (typeof PluginHubScope)[keyof typeof PluginHubScope];

export const PluginActionReason = {
  MANAGED_BY_SYSTEM: 'managed-by-system',
  MANAGED_BY_ORGANIZATION: 'managed-by-organization',
  MANAGED_BY_EXTENSION: 'managed-by-extension',
  GATEWAY_OFFLINE: 'gateway-offline',
  REQUIREMENTS_MISSING: 'requirements-missing',
  READ_ONLY_SOURCE: 'read-only-source',
  NOT_INSTALLED: 'not-installed',
  UNSUPPORTED: 'unsupported',
} as const;

export type PluginActionReason = (typeof PluginActionReason)[keyof typeof PluginActionReason];

export interface PluginActionCapability {
  allowed: boolean;
  reason?: PluginActionReason;
  managedById?: string;
  managedByName?: string;
}

export interface PluginManagementCapabilities {
  enable: PluginActionCapability;
  disable: PluginActionCapability;
  remove: PluginActionCapability;
  configure: PluginActionCapability;
  revealInFolder: PluginActionCapability;
}

export const allowedPluginAction = (): PluginActionCapability => ({ allowed: true });

export const blockedPluginAction = (
  reason: PluginActionReason,
  managedBy?: { id?: string; name?: string },
): PluginActionCapability => ({
  allowed: false,
  reason,
  ...(managedBy?.id ? { managedById: managedBy.id } : {}),
  ...(managedBy?.name ? { managedByName: managedBy.name } : {}),
});

export const getExtensionManagement = (extension: {
  managed?: boolean;
  origin?: string;
  canToggle?: boolean;
  removable?: boolean;
  installPath?: string;
  configurationFieldCount?: number;
}): { scope: PluginHubScope; management: PluginManagementCapabilities } => {
  const managedReason = extension.managed
    ? PluginActionReason.MANAGED_BY_SYSTEM
    : PluginActionReason.READ_ONLY_SOURCE;
  const toggle =
    !extension.managed && extension.canToggle
      ? allowedPluginAction()
      : blockedPluginAction(managedReason);
  return {
    scope:
      extension.managed || extension.origin === 'bundled'
        ? PluginHubScope.SYSTEM
        : PluginHubScope.PERSONAL,
    management: {
      enable: toggle,
      disable: toggle,
      remove:
        !extension.managed && extension.removable
          ? allowedPluginAction()
          : blockedPluginAction(managedReason),
      configure:
        !extension.managed && (extension.configurationFieldCount ?? 0) > 0
          ? allowedPluginAction()
          : blockedPluginAction(
              extension.managed
                ? PluginActionReason.MANAGED_BY_SYSTEM
                : PluginActionReason.UNSUPPORTED,
            ),
      revealInFolder: extension.installPath
        ? allowedPluginAction()
        : blockedPluginAction(PluginActionReason.UNSUPPORTED),
    },
  };
};

export const getUserMcpManagement = (): {
  scope: PluginHubScope;
  management: PluginManagementCapabilities;
} => ({
  scope: PluginHubScope.PERSONAL,
  management: {
    enable: allowedPluginAction(),
    disable: allowedPluginAction(),
    remove: allowedPluginAction(),
    configure: allowedPluginAction(),
    revealInFolder: blockedPluginAction(PluginActionReason.UNSUPPORTED),
  },
});

export const getExtensionProvidedManagement = (provider: {
  id?: string;
  name?: string;
  scope?: PluginHubScope;
}): { scope: PluginHubScope; management: PluginManagementCapabilities } => {
  const blocked = blockedPluginAction(PluginActionReason.MANAGED_BY_EXTENSION, provider);
  return {
    scope: provider.scope ?? PluginHubScope.EXTENSION,
    management: {
      enable: blocked,
      disable: blocked,
      remove: blocked,
      configure: blocked,
      revealInFolder: blocked,
    },
  };
};

export const getHookManagement = (hook: {
  source?: string;
  managedByPlugin?: boolean;
  pluginId?: string;
  pluginScope?: PluginHubScope;
  requirementsSatisfied?: boolean;
  filePath?: string;
}): { scope: PluginHubScope; management: PluginManagementCapabilities } => {
  const managedBy = hook.pluginId ? { id: hook.pluginId } : undefined;
  const extensionBlocked = blockedPluginAction(PluginActionReason.MANAGED_BY_EXTENSION, managedBy);
  const toggle = hook.managedByPlugin ? extensionBlocked : allowedPluginAction();
  return {
    scope: hook.managedByPlugin
      ? (hook.pluginScope ?? PluginHubScope.EXTENSION)
      : hook.source === 'openclaw-bundled'
        ? PluginHubScope.SYSTEM
        : hook.source === 'openclaw-managed'
          ? PluginHubScope.PERSONAL
          : PluginHubScope.OTHER,
    management: {
      enable:
        !hook.managedByPlugin && hook.requirementsSatisfied === false
          ? blockedPluginAction(PluginActionReason.REQUIREMENTS_MISSING)
          : toggle,
      disable: toggle,
      remove:
        hook.source === 'openclaw-managed' && !hook.managedByPlugin
          ? allowedPluginAction()
          : hook.managedByPlugin
            ? extensionBlocked
            : blockedPluginAction(PluginActionReason.READ_ONLY_SOURCE),
      configure: hook.managedByPlugin
        ? extensionBlocked
        : blockedPluginAction(PluginActionReason.UNSUPPORTED),
      revealInFolder: hook.filePath
        ? allowedPluginAction()
        : blockedPluginAction(PluginActionReason.UNSUPPORTED),
    },
  };
};

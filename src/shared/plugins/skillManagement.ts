import {
  allowedPluginAction,
  blockedPluginAction,
  PluginActionReason,
  type PluginHubScope,
  PluginHubScope as Scope,
  type PluginManagementCapabilities,
} from './management';
import { isUserOwnedSkillSource, type OpenClawSkillSource } from './skills';

export const isPluginManagedSkillPath = (filePath: string | undefined): boolean =>
  Boolean(
    filePath
      ?.split(/[\\/]+/)
      .some(segment => ['plugin-skills', '.plugin-skills'].includes(segment.toLowerCase())),
  );

export const getSkillScope = (
  source: OpenClawSkillSource | string | undefined,
  filePath?: string,
): PluginHubScope => {
  if (source === 'openclaw-extra' && isPluginManagedSkillPath(filePath)) return Scope.EXTENSION;
  switch (source) {
    case 'openclaw-bundled':
    case 'openclaw-custodian':
      return Scope.SYSTEM;
    case 'openclaw-workshop':
    case 'openclaw-managed':
    case 'agents-skills-personal':
      return Scope.PERSONAL;
    case 'agents-skills-project':
    case 'openclaw-workspace':
      return Scope.PROJECT;
    case 'openclaw-extra':
      return Scope.OTHER;
    default:
      return Scope.OTHER;
  }
};

export const getSkillManagementCapabilities = (options: {
  source: OpenClawSkillSource | string | undefined;
  bundled: boolean;
  eligible: boolean;
  hasPath: boolean;
  filePath?: string;
}): PluginManagementCapabilities => {
  if (options.source === 'openclaw-extra' && isPluginManagedSkillPath(options.filePath)) {
    const managed = blockedPluginAction(PluginActionReason.MANAGED_BY_EXTENSION);
    return {
      enable: managed,
      disable: managed,
      remove: managed,
      configure: managed,
      revealInFolder: options.hasPath
        ? allowedPluginAction()
        : blockedPluginAction(PluginActionReason.UNSUPPORTED),
    };
  }
  const toggle = allowedPluginAction();
  const removable =
    !options.bundled && isUserOwnedSkillSource(options.source)
      ? allowedPluginAction()
      : blockedPluginAction(
          options.bundled
            ? PluginActionReason.MANAGED_BY_SYSTEM
            : PluginActionReason.READ_ONLY_SOURCE,
        );

  return {
    enable: toggle,
    disable: allowedPluginAction(),
    remove: removable,
    configure: blockedPluginAction(PluginActionReason.UNSUPPORTED),
    revealInFolder: options.hasPath
      ? allowedPluginAction()
      : blockedPluginAction(PluginActionReason.UNSUPPORTED),
  };
};

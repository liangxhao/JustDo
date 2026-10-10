import type { InstalledOpenClawExtension } from '@shared/plugins/extensions';
import { PluginActionReason } from '@shared/plugins/management';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { findNativeVideoProvider } from '@shared/providers/nativeVideoProviders';

import { i18nService } from '@/services/i18n';

/** Explain Main's management policy without inferring permission from a plugin ID. */
export const getExtensionManagementLabel = (extension: InstalledOpenClawExtension): string => {
  const capability = extension.management
    ? extension.enabled
      ? extension.management.disable
      : extension.management.enable
    : undefined;
  const managedBySystem = capability
    ? capability.reason === PluginActionReason.MANAGED_BY_SYSTEM
    : extension.managed === true;
  if (!managedBySystem) return i18nService.t('extensionToggleUnavailable');

  if (findNativeVideoProvider(extension.id)) return i18nService.t('extensionManagedVideoModels');
  switch (extension.id) {
    case OpenClawExtensionId.OPENAI:
      return i18nService.t('extensionManagedModelAdapter');
    case OpenClawExtensionId.CODE_MODE_QUICKJS:
      return i18nService.t('extensionManagedCodeMode');
    case OpenClawExtensionId.TYPESAFE:
      return i18nService.t('extensionManagedDecisionModels');
    case OpenClawExtensionId.BROWSER:
    case OpenClawExtensionId.EMBEDDED_BROWSER:
      return i18nService.t('extensionManagedBrowser');
    case OpenClawExtensionId.CUA_COMPUTER:
      return i18nService.t('extensionManagedComputer');
    case OpenClawExtensionId.WINDOWS_NATIVE_SANDBOX:
      return i18nService.t('extensionManagedSandbox');
    case OpenClawExtensionId.ACPX:
      return i18nService.t('extensionManagedExternalAgents');
    case OpenClawExtensionId.PLAN_MODE:
      return i18nService.t('extensionManagedPlanMode');
    case OpenClawExtensionId.AUTOMATION_PERMISSION:
      return i18nService.t('extensionManagedApprovals');
    case OpenClawExtensionId.ASK_USER_QUESTION:
    case OpenClawExtensionId.RUNTIME_SERVICES:
      return i18nService.t('extensionManagedCore');
    default:
      return i18nService.t('extensionManagedApplication');
  }
};

import {
  type PluginOperationFeedback,
  PluginOperationStage,
  toPluginOperationStage,
} from '@shared/plugins/pluginOperation';

import { i18nService } from '@/services/i18n';
import { translations } from '@/services/i18n/translations';

export const pluginOperationErrorMessage = (message: string) =>
  Object.prototype.hasOwnProperty.call(translations.zh, message) ||
  Object.prototype.hasOwnProperty.call(translations.en, message)
    ? i18nService.t(message)
    : message;

// Keep presentation receipts separate from inventories, configuration and native payloads.
export const pluginOperationFailure = (
  result: Omit<PluginOperationFeedback, 'failedStage'> & { error?: string; failedStage?: string },
  fallback: string,
) => ({
  message: result.error ? pluginOperationErrorMessage(result.error) : fallback,
  ...(result.failedStage && toPluginOperationStage(result.failedStage)
    ? { failedStage: toPluginOperationStage(result.failedStage) }
    : {}),
  ...(result.installationCommitted ? { installationCommitted: true as const } : {}),
  ...(result.installSourceInUse ? { installSourceInUse: true as const } : {}),
  ...(result.operationUnconfirmed ? { operationUnconfirmed: true as const } : {}),
});

export const pluginOperationRefreshFailure = (result: PluginOperationFeedback = {}) => ({
  ...pluginOperationFailure(result, i18nService.t('pluginOperationRefreshFailed')),
  failedStage: PluginOperationStage.REFRESHING_INVENTORY,
  state: 'refresh_failed' as const,
});

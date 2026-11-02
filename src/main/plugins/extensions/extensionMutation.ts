import type {
  ExtensionDeleteResult,
  ExtensionSetEnabledResult,
} from '../../../shared/plugins/extensions';
import { type PluginOperationFeedback, PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { t } from '../../core/i18n';
import { EnginePreparationPendingError } from '../../engine/enginePreparationError';
import { sanitizeInstallationFailureReason } from '../installation/installationFailureReason';
import type { OpenClawExtensionImportService } from './openclawExtensionImportService';

type ExtensionMutation = <T>(operation: () => Promise<T>) => Promise<T>;
type ImportResult = Awaited<ReturnType<OpenClawExtensionImportService['importPath']>>;

// Lifecycle completion can fail after the native operation returned.
// Only that returned receipt can establish what happened; never infer it from disk.
async function observeExtensionMutation<T>(
  operation: () => Promise<T>,
  mutate: ExtensionMutation | undefined,
  recoveryFailure: (result: T, error: unknown) => T,
): Promise<T> {
  if (!mutate) return operation();
  let receipt: { value: T } | undefined;
  try {
    return await mutate(async () => {
      const value = await operation();
      receipt = { value };
      return value;
    });
  } catch (error) {
    if (!receipt) throw error;
    return recoveryFailure(receipt.value, error);
  }
}

function recoveryMessage(summary: string, error: unknown, includeSummary = true): string {
  const detail = sanitizeInstallationFailureReason(
    error instanceof Error ? error.message : undefined,
  );
  return detail ? includeSummary ? `${summary}\n${detail}` : detail : summary;
}

function completedRecoveryFeedback(
  result: ImportResult | ExtensionDeleteResult,
  error: unknown,
): Pick<PluginOperationFeedback, 'mutationCompleted' | 'runtimeRecoveryPending'> {
  if (!result.success || result.error || result.refreshWarning || result.failedStage ||
      result.operationUnconfirmed || result.installSourceInUse ||
      ('capabilityReview' in result && result.capabilityReview) ||
      ('operationFailedStage' in result && result.operationFailedStage)) return {};
  return {
    mutationCompleted: true as const,
    ...(error instanceof EnginePreparationPendingError
      ? { runtimeRecoveryPending: true as const }
      : {}),
  };
}

export function installExtensionPackage(
  operation: () => Promise<ImportResult>,
  mutate?: ExtensionMutation,
): Promise<ImportResult> {
  return observeExtensionMutation(operation, mutate, (result, error) => {
    const completedFeedback = completedRecoveryFeedback(result, error);
    const recovery = recoveryMessage(
      t(completedFeedback.runtimeRecoveryPending
        ? 'extensionInstallRecoveryPending'
        : result.success ? 'extensionInstallSavedRecoveryFailed' : 'extensionPackageRecoveryFailed'),
      error,
      !completedFeedback.mutationCompleted,
    );
    return result.success
      ? {
          ...result,
          success: false,
          installationCommitted: true,
          ...completedFeedback,
          failedStage: PluginOperationStage.PREPARING_RUNTIME,
          operationFailedStage: PluginOperationStage.PREPARING_RUNTIME,
          error: recovery,
        }
      : {
          ...result,
          refreshWarning: true,
          ...(!result.operationFailedStage && !result.failedStage && result.capabilityReview
            ? { operationFailedStage: PluginOperationStage.PREPARING_RUNTIME }
            : {}),
          error: result.error ? `${result.error}\n${recovery}` : recovery,
        };
  });
}

export function removeExtensionPackage(
  operation: () => Promise<ExtensionDeleteResult>,
  mutate?: ExtensionMutation,
): Promise<ExtensionDeleteResult> {
  return observeExtensionMutation(operation, mutate, (result, error) => {
    const completedFeedback = completedRecoveryFeedback(result, error);
    const recovery = recoveryMessage(
      t(completedFeedback.runtimeRecoveryPending
        ? 'extensionRemovalRecoveryPending'
        : result.success && !result.error
        ? 'extensionRemovalSavedRecoveryFailed'
        : 'extensionPackageRecoveryFailed'),
      error,
      !completedFeedback.mutationCompleted,
    );
    return {
      ...result,
      refreshWarning: true,
      ...completedFeedback,
      ...(result.success && !result.failedStage
        ? { failedStage: PluginOperationStage.PREPARING_RUNTIME }
        : {}),
      error: result.error ? `${result.error}\n${recovery}` : recovery,
    };
  });
}

export function setExtensionEnabled(
  enabled: boolean,
  operation: () => Promise<ExtensionSetEnabledResult>,
  mutate?: ExtensionMutation,
): Promise<ExtensionSetEnabledResult> {
  return observeExtensionMutation(operation, mutate, (result, error) => {
    const detail = recoveryMessage(
      t(
        result.success
          ? enabled
            ? 'extensionEnableSavedFollowupFailed'
            : 'extensionDisableSavedFollowupFailed'
          : 'extensionStateFollowupFailed',
      ),
      error,
    );
    return {
      ...result,
      refreshWarning: true,
      ...(result.success || !result.failedStage
        ? { failedStage: PluginOperationStage.CONFIRMING }
        : {}),
      error: result.error ? `${result.error}\n${detail}` : detail,
    };
  });
}

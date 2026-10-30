import type { TaskState } from '@shared/scheduledTask/types';

import { i18nService } from '@/services/i18n';

import { getRunErrorReasonLabel } from './runDiagnosticPresentation';

export default function TaskStateNotice({
  state,
  enabled,
  className = '',
}: {
  state: TaskState;
  enabled: boolean;
  className?: string;
}) {
  const t = i18nService.t.bind(i18nService);
  const automaticallyPaused = !enabled && state.autoDisabled;
  const reason = getRunErrorReasonLabel(state.lastErrorReason);
  const explanation =
    state.lastError?.trim() ||
    state.lastDiagnosticSummary?.trim() ||
    state.lastDiagnostics?.summary?.trim() ||
    state.lastDiagnostics?.entries
      .find(entry => entry.severity === 'warn' || entry.severity === 'error')
      ?.message.trim();
  const deliveryError = state.lastDeliveryError?.trim();
  const visibleDeliveryError = deliveryError;
  if (!automaticallyPaused && !reason && !explanation && !visibleDeliveryError) return null;
  return (
    <div
      className={`space-y-1 text-xs text-secondary ${className}`}
      data-testid="scheduled-task-state-notice"
    >
      {automaticallyPaused && (
        <p className="text-amber-700 dark:text-amber-400">
          {t(
            automaticallyPaused.reason === 'schedule-errors'
              ? 'scheduledTasksAutoPausedSchedule'
              : 'scheduledTasksAutoPausedFailures',
          )}
        </p>
      )}
      {reason && (
        <p>
          {t('scheduledTasksReasonLabel')}: {reason}
        </p>
      )}
      {explanation && (
        <p className="line-clamp-2 whitespace-pre-wrap break-words" title={explanation}>
          {explanation}
        </p>
      )}
      {visibleDeliveryError && (
        <p className="line-clamp-2 text-amber-700 dark:text-amber-400" title={visibleDeliveryError}>
          {t('scheduledTasksResultsDeliveryWarning')}: {visibleDeliveryError}
        </p>
      )}
    </div>
  );
}

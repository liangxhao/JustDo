import type { ScheduledTaskRun } from '@shared/scheduledTask/types';

import { i18nService } from '@/services/i18n';

import {
  formatRunModel,
  getRunErrorReasonLabel,
  getRunExplanation,
} from './runDiagnosticPresentation';

const COMPLETION_KEYS: Record<string, string> = {
  succeeded: 'scheduledTasksCompletionSucceeded',
  failed: 'scheduledTasksCompletionFailed',
  unknown: 'scheduledTasksCompletionUnknown',
};
const DELIVERY_KEYS: Record<string, string> = {
  delivered: 'scheduledTasksDeliveryDelivered',
  'not-delivered': 'scheduledTasksDeliveryNotDelivered',
  unknown: 'scheduledTasksDeliveryUnknown',
  'not-requested': 'scheduledTasksDeliveryNotRequested',
};
const USAGE_KEYS = {
  input_tokens: 'scheduledTasksUsageInput',
  output_tokens: 'scheduledTasksUsageOutput',
  total_tokens: 'scheduledTasksUsageTotal',
  cache_read_tokens: 'scheduledTasksUsageCacheRead',
  cache_write_tokens: 'scheduledTasksUsageCacheWrite',
} as const;

export default function RunDiagnostics({
  run,
  compact = false,
  className = '',
}: {
  run: ScheduledTaskRun;
  compact?: boolean;
  className?: string;
}) {
  const t = i18nService.t.bind(i18nService);
  const explanation = getRunExplanation(run);
  const reason = getRunErrorReasonLabel(run.errorReason);
  const model = formatRunModel(run);
  const usage = Object.entries(USAGE_KEYS).flatMap(([key, label]) => {
    const value = run.usage?.[key as keyof typeof USAGE_KEYS];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? [`${t(label)} ${value.toLocaleString()}`]
      : [];
  });
  const deliveryError = run.deliveryError?.trim();
  const visibleDeliveryError = deliveryError;
  const diagnostics = run.diagnostics?.entries ?? [];
  if (
    !explanation &&
    !reason &&
    !model &&
    !run.provider &&
    !usage.length &&
    !run.completionStatus &&
    !run.deliveryStatus &&
    !visibleDeliveryError &&
    !run.deliverySuppressionReason &&
    !diagnostics.length
  )
    return null;

  return (
    <div
      className={`space-y-1.5 text-xs text-secondary ${className}`}
      data-testid="scheduled-run-diagnostics"
    >
      {(run.completionStatus || run.deliveryStatus) && (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {run.completionStatus && (
            <span
              className={
                run.completionStatus === 'failed' || run.completionStatus === 'unknown'
                  ? 'text-amber-700 dark:text-amber-400'
                  : undefined
              }
            >
              {t('scheduledTasksCompletionLabel')}: {t(COMPLETION_KEYS[run.completionStatus])}
            </span>
          )}
          {run.deliveryStatus && (
            <span>
              {t('scheduledTasksDeliveryLabel')}:{' '}
              {DELIVERY_KEYS[run.deliveryStatus]
                ? t(DELIVERY_KEYS[run.deliveryStatus])
                : run.deliveryStatus}
            </span>
          )}
        </p>
      )}
      {reason && (
        <p>
          {t('scheduledTasksReasonLabel')}: {reason}
        </p>
      )}
      {explanation && (
        <p
          className={`whitespace-pre-wrap break-words ${compact ? 'line-clamp-2' : ''} ${run.status === 'error' ? 'text-red-600 dark:text-red-400' : ''}`}
          title={compact ? explanation : undefined}
        >
          {explanation}
        </p>
      )}
      {visibleDeliveryError && (
        <p className="whitespace-pre-wrap break-words text-amber-700 dark:text-amber-400">
          {t('scheduledTasksResultsDeliveryWarning')}: {visibleDeliveryError}
        </p>
      )}
      {run.deliverySuppressionReason && (
        <p className="whitespace-pre-wrap break-words">
          {t('scheduledTasksDeliverySuppressionLabel')}: {run.deliverySuppressionReason}
        </p>
      )}
      {(model || run.provider) && (
        <p className="break-words">
          {model
            ? `${t('scheduledTasksActualModel')}: ${model}`
            : `${t('scheduledTasksActualProvider')}: ${run.provider}`}
        </p>
      )}
      {usage.length > 0 && (
        <p>
          {t('scheduledTasksUsageLabel')}: {usage.join(' · ')}
        </p>
      )}
      {diagnostics.length > 0 && (
        <details onClick={event => event.stopPropagation()}>
          <summary className="cursor-pointer">
            {t('scheduledTasksDiagnosticsTitle')} ({diagnostics.length})
          </summary>
          <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border-subtle bg-surface p-2">
            {diagnostics.map((entry, index) => (
              <li
                key={`${entry.ts}:${index}`}
                className={
                  entry.severity === 'error'
                    ? 'text-red-600 dark:text-red-400'
                    : entry.severity === 'warn'
                      ? 'text-amber-700 dark:text-amber-400'
                      : undefined
                }
              >
                <p className="whitespace-pre-wrap break-words">{entry.message}</p>
                {(entry.toolName || entry.exitCode !== undefined || entry.truncated) && (
                  <p className="mt-0.5 text-secondary">
                    {[
                      entry.toolName,
                      entry.exitCode !== undefined && entry.exitCode !== null
                        ? `${t('scheduledTasksDiagnosticExitCode')}: ${entry.exitCode}`
                        : undefined,
                      entry.truncated ? t('scheduledTasksDiagnosticTruncated') : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

import { TaskCompletionStatus, TaskStatus } from '@shared/scheduledTask/constants';
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
  issuesOnly = false,
  collapsible = false,
  className = '',
}: {
  run: ScheduledTaskRun;
  compact?: boolean;
  issuesOnly?: boolean;
  collapsible?: boolean;
  className?: string;
}) {
  const t = i18nService.t.bind(i18nService);
  const entries = run.diagnostics?.entries ?? [];
  const issueEntries = entries.filter(entry => entry.severity !== 'info');
  const diagnostics = issuesOnly
    ? issueEntries.filter(entry => entry.source !== 'delivery')
    : entries;
  const deliveryMessages = new Set(
    [
      run.deliveryError,
      ...issueEntries.filter(entry => entry.source === 'delivery').map(entry => entry.message),
    ]
      .map(message => message?.trim())
      .filter((message): message is string => Boolean(message)),
  );
  // Native delivery failures can repeat their message in execution error fields.
  const errorIsDelivery =
    issuesOnly && Boolean(run.error?.trim() && deliveryMessages.has(run.error.trim()));
  const deliveryOnlyIssues =
    issueEntries.length > 0 && issueEntries.every(entry => entry.source === 'delivery');
  const reason = getRunErrorReasonLabel(errorIsDelivery ? undefined : run.errorReason);
  const model = issuesOnly ? undefined : formatRunModel(run);
  const provider = issuesOnly ? undefined : run.provider;
  const completionStatus = issuesOnly ? undefined : run.completionStatus;
  const deliveryStatus = issuesOnly ? undefined : run.deliveryStatus;
  const suppressionReason = issuesOnly ? undefined : run.deliverySuppressionReason;
  const usage = issuesOnly
    ? []
    : Object.entries(USAGE_KEYS).flatMap(([key, label]) => {
        const value = run.usage?.[key as keyof typeof USAGE_KEYS];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? [`${t(label)} ${value.toLocaleString()}`]
          : [];
      });
  const visibleDeliveryError = issuesOnly ? undefined : run.deliveryError?.trim();
  const showDiagnosticSummary =
    diagnostics.length === 0 &&
    (run.status === TaskStatus.Error || run.status === TaskStatus.Skipped) &&
    !(
      issuesOnly &&
      (deliveryOnlyIssues || deliveryMessages.has(run.diagnostics?.summary?.trim() ?? ''))
    );
  const explanation = getRunExplanation({
    ...run,
    error: errorIsDelivery ? null : run.error,
    diagnostics: issuesOnly
      ? {
          entries: diagnostics,
          ...(showDiagnosticSummary ? { summary: run.diagnostics?.summary } : {}),
        }
      : run.diagnostics,
  });
  if (
    !explanation &&
    !reason &&
    !model &&
    !provider &&
    !usage.length &&
    !completionStatus &&
    !deliveryStatus &&
    !visibleDeliveryError &&
    !suppressionReason &&
    !diagnostics.length
  )
    return null;

  const content = (
    <div
      className={`space-y-1.5 text-xs text-secondary ${className}`}
      data-testid="scheduled-run-diagnostics"
    >
      {(completionStatus || deliveryStatus) && (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {completionStatus && (
            <span
              className={
                completionStatus === TaskCompletionStatus.Failed ||
                completionStatus === TaskCompletionStatus.Unknown
                  ? 'text-amber-700 dark:text-amber-400'
                  : undefined
              }
            >
              {t('scheduledTasksCompletionLabel')}: {t(COMPLETION_KEYS[completionStatus])}
            </span>
          )}
          {deliveryStatus && (
            <span>
              {t('scheduledTasksDeliveryLabel')}:{' '}
              {DELIVERY_KEYS[deliveryStatus] ? t(DELIVERY_KEYS[deliveryStatus]) : deliveryStatus}
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
      {suppressionReason && (
        <p className="whitespace-pre-wrap break-words">
          {t('scheduledTasksDeliverySuppressionLabel')}: {suppressionReason}
        </p>
      )}
      {(model || provider) && (
        <p className="break-words">
          {model
            ? `${t('scheduledTasksActualModel')}: ${model}`
            : `${t('scheduledTasksActualProvider')}: ${provider}`}
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

  if (!collapsible) return content;
  return (
    <details className="mt-3 text-xs text-secondary" onClick={event => event.stopPropagation()}>
      <summary className="w-fit cursor-pointer transition-colors hover:text-foreground">
        {t('scheduledTasksResultsRunDetails')}
      </summary>
      <div className="mt-2 rounded-lg border border-border-subtle bg-surface-raised/50 p-3">
        {content}
      </div>
    </details>
  );
}

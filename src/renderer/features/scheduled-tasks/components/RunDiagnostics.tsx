import { TaskCompletionStatus } from '@shared/scheduledTask/constants';
import type { ScheduledTaskRun, ScheduledTaskRunDiagnostic } from '@shared/scheduledTask/types';

import { i18nService } from '@/services/i18n';

import {
  formatRunModel,
  getRunErrorReasonLabel,
  getRunExplanation,
} from './runDiagnosticPresentation';
import { formatDateTime } from './utils';

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
const SOURCE_KEYS: Record<ScheduledTaskRunDiagnostic['source'], string> = {
  'cron-preflight': 'scheduledTasksDiagnosticSourceSchedule',
  'cron-setup': 'scheduledTasksDiagnosticSourceSetup',
  'model-preflight': 'scheduledTasksDiagnosticSourceModel',
  'agent-run': 'scheduledTasksDiagnosticSourceAgent',
  tool: 'scheduledTasksDiagnosticSourceTool',
  exec: 'scheduledTasksDiagnosticSourceCommand',
  delivery: 'scheduledTasksDeliveryLabel',
};
const SEVERITY_KEYS: Record<ScheduledTaskRunDiagnostic['severity'], string> = {
  info: 'scheduledTasksDiagnosticInfo',
  warn: 'scheduledTasksDiagnosticWarning',
  error: 'scheduledTasksDiagnosticError',
};

export default function RunDiagnostics({
  run,
  compact = false,
  expanded = false,
  className = '',
}: {
  run: ScheduledTaskRun;
  compact?: boolean;
  expanded?: boolean;
  className?: string;
}) {
  const t = i18nService.t.bind(i18nService);
  const diagnostics = run.diagnostics?.entries ?? [];
  const diagnosticMessages = new Set(diagnostics.map(entry => entry.message.trim()));
  const deliveryError = run.deliveryError?.trim();
  const explanationText = getRunExplanation(run);
  const explanation =
    expanded &&
    explanationText &&
    (diagnosticMessages.has(explanationText.trim()) || explanationText.trim() === deliveryError)
      ? undefined
      : explanationText;
  const visibleDeliveryError =
    expanded && deliveryError && diagnosticMessages.has(deliveryError) ? undefined : deliveryError;
  const summaryText = run.diagnostics?.summary?.trim();
  const diagnosticSummary =
    expanded &&
    summaryText &&
    summaryText !== explanationText?.trim() &&
    summaryText !== deliveryError &&
    !diagnosticMessages.has(summaryText)
      ? summaryText
      : undefined;
  const reason = getRunErrorReasonLabel(run.errorReason);
  const model = formatRunModel(run);
  const provider = run.provider;
  const completionStatus = run.completionStatus;
  const deliveryStatus = run.deliveryStatus;
  const suppressionReason = run.deliverySuppressionReason;
  const usage = Object.entries(USAGE_KEYS).flatMap(([key, label]) => {
    const value = run.usage?.[key as keyof typeof USAGE_KEYS];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? [`${t(label)} ${value.toLocaleString()}`]
      : [];
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
    !diagnosticSummary &&
    !diagnostics.length
  )
    return null;

  const diagnosticContent = (diagnostics.length > 0 || diagnosticSummary) && (
    <>
      {diagnosticSummary && (
        <p className="mt-2 whitespace-pre-wrap break-words">{diagnosticSummary}</p>
      )}
      {diagnostics.length > 0 && (
        <ul
          className={
            expanded
              ? 'mt-3 space-y-3'
              : 'mt-2 max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border-subtle bg-surface p-2'
          }
        >
          {diagnostics.map((entry, index) => {
            const timestamp = new Date(entry.ts);
            return (
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
                {expanded && (
                  <p className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-secondary">
                    <span>
                      {t(SOURCE_KEYS[entry.source])} · {t(SEVERITY_KEYS[entry.severity])}
                    </span>
                    <time
                      dateTime={
                        Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined
                      }
                    >
                      {formatDateTime(timestamp)}
                    </time>
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words">{entry.message}</p>
                {(entry.toolName || entry.exitCode !== undefined || entry.truncated) && (
                  <p className="mt-0.5 text-xs text-secondary">
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
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <div
      className={`${expanded ? 'space-y-4 text-sm' : 'space-y-1.5 text-xs'} text-secondary ${className}`}
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
      {diagnosticContent &&
        (expanded ? (
          <section className="border-t border-border-subtle pt-4">
            <h3 className="font-medium text-foreground">
              {t('scheduledTasksDiagnosticsTitle')}
              {diagnostics.length > 0 && ` (${diagnostics.length})`}
            </h3>
            {diagnosticContent}
          </section>
        ) : (
          <details onClick={event => event.stopPropagation()}>
            <summary className="cursor-pointer">
              {t('scheduledTasksDiagnosticsTitle')} ({diagnostics.length})
            </summary>
            {diagnosticContent}
          </details>
        ))}
    </div>
  );
}

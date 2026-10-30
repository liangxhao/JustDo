import { getHeartbeatSkippedReason } from '@shared/scheduledTask/resultPresentation';
import type { ScheduledTaskRun } from '@shared/scheduledTask/types';

import { i18nService } from '@/services/i18n';

const REASON_KEYS: Record<string, string> = {
  auth: 'scheduledTasksReasonAuth',
  auth_permanent: 'scheduledTasksReasonAuth',
  format: 'scheduledTasksReasonFormat',
  rate_limit: 'scheduledTasksReasonRateLimit',
  overloaded: 'scheduledTasksReasonOverloaded',
  billing: 'scheduledTasksReasonBilling',
  server_error: 'scheduledTasksReasonServer',
  timeout: 'scheduledTasksReasonTimeout',
  tls_certificate: 'scheduledTasksReasonCertificate',
  context_overflow: 'scheduledTasksReasonContext',
  model_not_found: 'scheduledTasksReasonModel',
  session_expired: 'scheduledTasksReasonSession',
  empty_response: 'scheduledTasksReasonEmpty',
};

export function getRunErrorReasonLabel(reason: string | undefined): string | undefined {
  if (!reason?.trim()) return undefined;
  return REASON_KEYS[reason] ? i18nService.t(REASON_KEYS[reason]) : reason;
}

export function getRunExplanation(
  run: Pick<ScheduledTaskRun, 'status' | 'error' | 'diagnostics'>,
): string | undefined {
  const heartbeatReason = getHeartbeatSkippedReason(run.error);
  if (heartbeatReason) {
    return i18nService.t(
      heartbeatReason === 'no-route'
        ? 'scheduledTasksResultsHeartbeatNoRoute'
        : 'scheduledTasksResultsHeartbeatSkipped',
    );
  }
  if (run.status === 'skipped' && run.error?.trim().toLowerCase() === 'disabled') {
    return i18nService.t('scheduledTasksReasonDisabled');
  }
  return (
    run.error?.trim() ||
    run.diagnostics?.summary?.trim() ||
    run.diagnostics?.entries
      .find(entry => entry.severity === 'warn' || entry.severity === 'error')
      ?.message.trim() ||
    undefined
  );
}

export function formatRunModel(
  run: Pick<ScheduledTaskRun, 'model' | 'provider'>,
): string | undefined {
  const model = run.model?.trim();
  const provider = run.provider?.trim();
  if (!model) return undefined;
  return provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
}

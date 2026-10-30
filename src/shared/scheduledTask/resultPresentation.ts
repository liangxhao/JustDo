import { TaskCompletionStatus, TaskStatus } from './constants';
import type { ScheduledTaskRun } from './types';

export const OPENCLAW_SILENT_REPLY_MARKER = 'NO_REPLY';
export const OPENCLAW_HEARTBEAT_SKIPPED_PREFIX = 'heartbeat skipped:';

export function isSilentScheduledTaskResult(summary: string | null | undefined): boolean {
  return summary?.trim().toUpperCase() === OPENCLAW_SILENT_REPLY_MARKER;
}

export function getHeartbeatSkippedReason(error: string | null | undefined): string | null {
  const normalized = error?.trim().toLowerCase() ?? '';
  if (!normalized.startsWith(OPENCLAW_HEARTBEAT_SKIPPED_PREFIX)) return null;
  return normalized.slice(OPENCLAW_HEARTBEAT_SKIPPED_PREFIX.length).trim() || 'unknown';
}

export function hasScheduledTaskRunIssue(
  result: Pick<ScheduledTaskRun, 'completionStatus' | 'deliveryError' | 'diagnostics'>,
): boolean {
  return (
    result.completionStatus === TaskCompletionStatus.Failed ||
    result.completionStatus === TaskCompletionStatus.Unknown ||
    Boolean(result.deliveryError?.trim()) ||
    Boolean(
      result.diagnostics?.entries.some(
        entry => entry.severity === 'warn' || entry.severity === 'error',
      ),
    )
  );
}

export function isRoutineScheduledTaskResult(
  result: Pick<ScheduledTaskRun, 'status' | 'summary' | 'error'> & {
    systemManaged?: boolean;
  } & Pick<ScheduledTaskRun, 'completionStatus' | 'deliveryError' | 'diagnostics'>,
): boolean {
  if (hasScheduledTaskRunIssue(result)) return false;
  if (
    result.systemManaged === true &&
    result.status === TaskStatus.Skipped &&
    getHeartbeatSkippedReason(result.error)
  ) {
    return true;
  }
  return (
    result.status === TaskStatus.Success &&
    !result.error?.trim() &&
    isSilentScheduledTaskResult(result.summary)
  );
}

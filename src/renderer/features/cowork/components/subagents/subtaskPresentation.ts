import type { SubagentLabelSource } from './subagentLabel';

export const SUBTASK_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
} as const;

export type SubtaskStatus = (typeof SUBTASK_STATUSES)[keyof typeof SUBTASK_STATUSES];

export type Subtask = {
  id: string;
  taskName: string;
  sessionKey: string;
  sessionId?: string;
  label: string;
  labelSource: SubagentLabelSource;
  status: SubtaskStatus;
  task?: string;
  runId?: string;
  model?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  runtimeSampledAt?: number;
  lifecycleRequestSequence?: number;
  totalTokens?: number;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  lastActivity?: string;
  lastToolName?: string;
  toolUseCount?: number;
};

export const subtaskStatusStyles: Record<SubtaskStatus, string> = {
  pending: 'bg-amber-500 motion-safe:animate-pulse',
  running: 'bg-blue-500 motion-safe:animate-pulse',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  killed: 'bg-red-500',
  timeout: 'bg-red-500',
  blocked: 'bg-amber-600',
};

export const SUBTASK_STATUS_I18N_KEYS: Record<SubtaskStatus, string> = {
  pending: 'subtaskStatusPending',
  running: 'subtaskStatusRunning',
  done: 'subtaskStatusDone',
  failed: 'subtaskStatusFailed',
  killed: 'subtaskStatusKilled',
  timeout: 'subtaskStatusTimeout',
  blocked: 'subtaskStatusBlocked',
};

export const isActiveSubtask = (status?: string): boolean =>
  status === SUBTASK_STATUSES.PENDING || status === SUBTASK_STATUSES.RUNNING;

export const mergeSubtaskSnapshots = (
  current: Subtask,
  latest: Subtask,
  options: { preserveCurrentTask?: boolean } = {},
): Subtask => {
  const latestRequestIsStale =
    current.lifecycleRequestSequence !== undefined &&
    latest.lifecycleRequestSequence !== undefined &&
    latest.lifecycleRequestSequence < current.lifecycleRequestSequence;
  const latestLifecycleIsStale =
    latestRequestIsStale ||
    (current.updatedAt !== undefined &&
      (latest.updatedAt === undefined || latest.updatedAt < current.updatedAt));
  const lifecycle = latestLifecycleIsStale ? current : latest;
  const merged: Subtask = {
    ...current,
    ...latest,
    ...(options.preserveCurrentTask && current.task ? { task: current.task } : {}),
    status: lifecycle.status,
    runId: lifecycle.runId,
    startedAt: lifecycle.startedAt,
    updatedAt: lifecycle.updatedAt,
    endedAt: lifecycle.endedAt,
    runtimeMs: lifecycle.runtimeMs,
    runtimeSampledAt: lifecycle.runtimeSampledAt,
    lifecycleRequestSequence: lifecycle.lifecycleRequestSequence,
    progressSummary: lifecycle.progressSummary,
    terminalSummary: lifecycle.terminalSummary,
    error: lifecycle.error,
    lastActivity: lifecycle.lastActivity,
    lastToolName: lifecycle.lastToolName,
    toolUseCount: lifecycle.toolUseCount,
  };
  if (isActiveSubtask(merged.status)) {
    merged.endedAt = undefined;
    merged.terminalSummary = undefined;
    merged.error = undefined;
  }
  return merged;
};

const subtaskTimestamp = (subtask: Subtask): number =>
  subtask.updatedAt ?? subtask.endedAt ?? subtask.startedAt ?? 0;

export const partitionSubtasks = (
  subtasks: readonly Subtask[],
): { active: Subtask[]; finished: Subtask[] } => {
  const sorted = [...subtasks].sort((left, right) => {
    const timestampDelta = subtaskTimestamp(right) - subtaskTimestamp(left);
    return timestampDelta || left.id.localeCompare(right.id);
  });
  return {
    active: sorted.filter(subtask => isActiveSubtask(subtask.status)),
    finished: sorted.filter(subtask => !isActiveSubtask(subtask.status)).slice(0, 50),
  };
};

export const resolveSubtaskElapsedMs = (subtask: Subtask, now = Date.now()): number | undefined => {
  if (subtask.runtimeMs !== undefined) {
    const elapsedSinceSample =
      subtask.status === SUBTASK_STATUSES.RUNNING && subtask.runtimeSampledAt !== undefined
        ? Math.max(0, now - subtask.runtimeSampledAt)
        : 0;
    return Math.max(0, subtask.runtimeMs + elapsedSinceSample);
  }
  if (subtask.startedAt === undefined) return undefined;
  if (subtask.status === SUBTASK_STATUSES.RUNNING) {
    return Math.max(0, now - subtask.startedAt);
  }
  if (subtask.status === SUBTASK_STATUSES.PENDING) return undefined;
  if (subtask.endedAt === undefined) return undefined;
  return Math.max(0, subtask.endedAt - subtask.startedAt);
};

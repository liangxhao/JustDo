import type { SubagentLabelSource } from './subagentLabel';

export const SUBTASK_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
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
  model?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
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
};

export const SUBTASK_STATUS_I18N_KEYS: Record<SubtaskStatus, string> = {
  pending: 'subtaskStatusPending',
  running: 'subtaskStatusRunning',
  done: 'subtaskStatusDone',
  failed: 'subtaskStatusFailed',
  killed: 'subtaskStatusKilled',
  timeout: 'subtaskStatusTimeout',
};

export const isActiveSubtask = (status?: string): boolean =>
  status === SUBTASK_STATUSES.PENDING || status === SUBTASK_STATUSES.RUNNING;

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
  if (subtask.runtimeMs !== undefined && !isActiveSubtask(subtask.status)) {
    return Math.max(0, subtask.runtimeMs);
  }
  if (subtask.startedAt === undefined) return undefined;
  if (isActiveSubtask(subtask.status)) return Math.max(0, now - subtask.startedAt);
  if (subtask.endedAt === undefined) return undefined;
  return Math.max(0, subtask.endedAt - subtask.startedAt);
};

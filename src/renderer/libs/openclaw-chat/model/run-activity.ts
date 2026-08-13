export const RUN_STALL_NOTICE_MS = 20_000;
export const RUN_SLOW_NOTICE_MS = 60_000;
export const RUN_LONG_NOTICE_MS = 240_000;
export const RUN_PROBE_INTERVAL_MS = 15_000;
export const RUN_CONFIRMATION_FRESH_MS = RUN_PROBE_INTERVAL_MS * 2;

export type RunProgressStage =
  | 'starting'
  | 'queued'
  | 'preparing'
  | 'waiting-model'
  | 'thinking'
  | 'responding'
  | 'running-tool'
  | 'retrying';

export type RunRetryReason = 'rate_limit' | 'timeout' | 'overloaded' | 'auth' | 'unknown';

export interface RunActivity {
  runId: string;
  stage: RunProgressStage;
  startedAt: number;
  stageChangedAt: number;
  lastAgentEventAt: number;
  lastModelActivityAt: number | null;
  hasRunningTool: boolean;
  provider?: string;
  model?: string;
  retryReason?: RunRetryReason;
  activeRunConfirmedAt: number | null;
  probeState: 'idle' | 'checking' | 'active' | 'failed';
}

export type WaitingStatusKind =
  | 'waiting-model'
  | 'slow-active'
  | 'long-wait'
  | 'retrying'
  | 'rate-limited'
  | 'reconnecting'
  | 'probe-failed';

export interface WaitingStatusProjection {
  kind: WaitingStatusKind;
  tone: 'neutral' | 'warning';
  quietMs: number;
}

export function normalizeRunRetryReason(value: unknown): RunRetryReason {
  if (value === 'rate_limit' || value === 'timeout' || value === 'overloaded' || value === 'auth') {
    return value;
  }
  return 'unknown';
}

export function projectWaitingStatus(params: {
  activity: RunActivity | null;
  transportStatus: 'disconnected' | 'connected' | 'reconnecting';
  now?: number;
}): WaitingStatusProjection | null {
  const { activity, transportStatus } = params;
  if (!activity) return null;
  const now = params.now ?? Date.now();
  const quietSince = activity.lastModelActivityAt ?? activity.startedAt;
  const quietMs = Math.max(0, now - quietSince);

  if (transportStatus === 'reconnecting') {
    return { kind: 'reconnecting', tone: 'warning', quietMs };
  }
  // A running tool is observable work, not evidence that the model is stalled.
  // Resume model-wait notices only after the last running tool settles.
  if (activity.hasRunningTool) return null;
  if (quietMs < RUN_STALL_NOTICE_MS) return null;
  const confirmationFresh =
    activity.activeRunConfirmedAt !== null &&
    now - activity.activeRunConfirmedAt <= RUN_CONFIRMATION_FRESH_MS;
  if (quietMs >= RUN_LONG_NOTICE_MS && confirmationFresh) {
    return { kind: 'long-wait', tone: 'warning', quietMs };
  }
  if (activity.stage === 'retrying') {
    return {
      kind: activity.retryReason === 'rate_limit' ? 'rate-limited' : 'retrying',
      tone: 'neutral',
      quietMs,
    };
  }
  if (activity.probeState === 'failed') {
    return { kind: 'probe-failed', tone: 'neutral', quietMs };
  }
  if (quietMs >= RUN_SLOW_NOTICE_MS && confirmationFresh) {
    return { kind: 'slow-active', tone: 'neutral', quietMs };
  }
  return { kind: 'waiting-model', tone: 'neutral', quietMs };
}

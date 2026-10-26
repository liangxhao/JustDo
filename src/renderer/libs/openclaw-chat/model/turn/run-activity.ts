export const RUN_STALL_NOTICE_MS = 20_000;
export const RUN_SLOW_NOTICE_MS = 60_000;
export const RUN_LONG_NOTICE_MS = 240_000;
export const RUN_PROBE_INTERVAL_MS = 15_000;
export const RUN_CONFIRMATION_FRESH_MS = RUN_PROBE_INTERVAL_MS * 2;

export type RunProgressStage =
  | 'starting'
  | 'queued'
  | 'preparing'
  | 'preparing-workspace'
  | 'starting-model'
  | 'memory-flushing'
  | 'receiving-model'
  | 'generating-tool-input'
  | 'preparing-tool'
  | 'compacting'
  | 'waiting-model'
  | 'thinking'
  | 'responding'
  | 'running-tool'
  | 'retrying';

export type RunRetryReason =
  | 'rate_limit'
  | 'timeout'
  | 'overloaded'
  | 'server_error'
  | 'output_limit'
  | 'auth'
  | 'tool_call_format'
  | 'unknown';

export type RunProgressDetail =
  | {
      kind: 'tool-input';
      toolCallId: string;
      name: string;
      receivedChars: number;
      complete: boolean;
    }
  | { kind: 'model-stream'; receivedChars: number }
  | { kind: 'model-activity' }
  | { kind: 'tool'; toolCallId: string; name: string; outputChars?: number; summary?: string };

export interface RunActivityOptions {
  modelActivity?: boolean;
  provider?: string;
  model?: string;
  retryReason?: unknown;
  retryAttempt?: unknown;
  maxRetries?: unknown;
  retryDelayMs?: number;
  progress?: RunProgressDetail;
  at?: number;
}

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
  retryAttempt?: number;
  maxRetries?: number;
  retryAt?: number;
  progress?: RunProgressDetail;
  activeRunConfirmedAt: number | null;
  probeState: 'idle' | 'checking' | 'active' | 'failed';
}

export function createRunActivity(runId: string, startedAt: number): RunActivity {
  return {
    runId,
    stage: 'starting',
    startedAt,
    stageChangedAt: startedAt,
    lastAgentEventAt: startedAt,
    lastModelActivityAt: null,
    hasRunningTool: false,
    activeRunConfirmedAt: null,
    probeState: 'idle',
  };
}

export type WaitingStatusKind =
  | 'waiting-model'
  | 'slow-active'
  | 'long-wait'
  | 'retrying'
  | 'retry-timeout'
  | 'retry-overloaded'
  | 'retry-auth'
  | 'retry-tool-call-format'
  | 'rate-limited'
  | 'response-paused'
  | 'disconnected'
  | 'reconnecting'
  | 'probe-failed';

export interface WaitingStatusProjection {
  kind: WaitingStatusKind;
  tone: 'neutral' | 'warning';
  quietMs: number;
  retryAttempt?: number;
  maxRetries?: number;
}

export function normalizeRunRetryReason(value: unknown): RunRetryReason {
  if (
    value === 'rate_limit' ||
    value === 'timeout' ||
    value === 'overloaded' ||
    value === 'server_error' ||
    value === 'output_limit' ||
    value === 'auth' ||
    value === 'tool_call_format'
  ) {
    return value;
  }
  return 'unknown';
}

export function normalizeRunRetryProgress(
  reason: unknown,
  retryAttempt: unknown,
  maxRetries: unknown,
): { retryAttempt: number; maxRetries: number } | undefined {
  if (
    reason === 'tool_call_format' &&
    (retryAttempt === 1 || retryAttempt === 2) &&
    maxRetries === 2
  ) {
    return { retryAttempt, maxRetries };
  }
  if (
    reason !== 'tool_call_format' &&
    Number.isSafeInteger(retryAttempt) &&
    Number.isSafeInteger(maxRetries) &&
    typeof retryAttempt === 'number' &&
    typeof maxRetries === 'number' &&
    retryAttempt >= 1 &&
    retryAttempt <= maxRetries &&
    maxRetries <= 100
  )
    return { retryAttempt, maxRetries };
  return undefined;
}

/** Shared display projection for the selected run and its in-memory background view. */
export function advanceRunActivity(
  activity: RunActivity,
  stage: RunProgressStage,
  options: RunActivityOptions,
  hasRunningTool: boolean,
): RunActivity {
  const next = { ...activity };
  const at = options.at ?? Date.now();
  const genericModelActivity =
    stage === 'receiving-model' && options.progress?.kind === 'model-activity';
  const preserveDetailedProgress =
    genericModelActivity &&
    ['thinking', 'responding', 'generating-tool-input', 'preparing-tool', 'running-tool'].includes(
      activity.stage,
    );
  // A content-free heartbeat must not replace a more specific visible model stage.
  if (
    stage === 'receiving-model' &&
    (preserveDetailedProgress || activity.stage === 'thinking' || activity.stage === 'responding')
  ) {
    stage = activity.stage;
  }
  const stageChanged = activity.stage !== stage;
  if (stageChanged) {
    next.stage = stage;
    next.stageChangedAt = at;
    delete next.progress;
  }
  if (options.progress && (!genericModelActivity || !next.progress)) {
    next.progress = options.progress;
  }
  next.lastAgentEventAt = at;
  next.hasRunningTool = hasRunningTool;
  if (options.provider) next.provider = options.provider;
  if (options.model) next.model = options.model;
  delete next.retryAttempt;
  delete next.maxRetries;
  delete next.retryAt;
  if (stage === 'retrying') {
    next.retryReason = normalizeRunRetryReason(options.retryReason);
    const retry = normalizeRunRetryProgress(
      next.retryReason,
      options.retryAttempt,
      options.maxRetries,
    );
    if (retry) Object.assign(next, retry);
    if (options.retryDelayMs !== undefined) next.retryAt = at + options.retryDelayMs;
  } else delete next.retryReason;
  if (options.modelActivity) next.lastModelActivityAt = at;
  if (options.modelActivity || stageChanged) {
    next.probeState = 'idle';
    next.activeRunConfirmedAt = null;
  }
  return next;
}

export function projectWaitingStatus(params: {
  activity: RunActivity | null;
  transportStatus: 'disconnected' | 'connected' | 'reconnecting';
  now?: number;
}): WaitingStatusProjection | null {
  const { activity, transportStatus } = params;
  if (!activity) return null;
  const now = params.now ?? Date.now();
  const quietSince = Math.max(
    activity.lastModelActivityAt ?? activity.startedAt,
    activity.stageChangedAt,
  );
  const quietMs = Math.max(0, now - quietSince);

  if (transportStatus === 'reconnecting') {
    return { kind: 'reconnecting', tone: 'warning', quietMs };
  }
  if (transportStatus === 'disconnected') {
    return { kind: 'disconnected', tone: 'warning', quietMs };
  }
  // A running tool is observable work, not evidence that the model is stalled.
  // Resume model-wait notices only after the last running tool settles.
  if (activity.hasRunningTool) return null;
  // Explicit queue/context preparation is not a stalled model request.
  if (
    ['queued', 'preparing', 'preparing-workspace', 'memory-flushing', 'compacting'].includes(
      activity.stage,
    )
  )
    return null;
  const confirmationFresh =
    activity.activeRunConfirmedAt !== null &&
    now - activity.activeRunConfirmedAt <= RUN_CONFIRMATION_FRESH_MS;
  if (activity.stage === 'retrying') {
    const retryKinds = {
      rate_limit: 'rate-limited',
      timeout: 'retry-timeout',
      overloaded: 'retry-overloaded',
      server_error: 'retry-overloaded',
      output_limit: 'retrying',
      auth: 'retry-auth',
      tool_call_format: 'retry-tool-call-format',
      unknown: 'retrying',
    } as const;
    return {
      kind: retryKinds[activity.retryReason ?? 'unknown'],
      tone: 'neutral',
      quietMs,
      ...(activity.retryReason === 'tool_call_format'
        ? normalizeRunRetryProgress(
            activity.retryReason,
            activity.retryAttempt,
            activity.maxRetries,
          )
        : {}),
    };
  }
  if (quietMs < RUN_STALL_NOTICE_MS) return null;
  if (activity.probeState === 'failed') {
    return { kind: 'probe-failed', tone: 'neutral', quietMs };
  }
  if (quietMs >= RUN_LONG_NOTICE_MS && confirmationFresh) {
    return { kind: 'long-wait', tone: 'warning', quietMs };
  }
  if (quietMs >= RUN_SLOW_NOTICE_MS && confirmationFresh) {
    return { kind: 'slow-active', tone: 'neutral', quietMs };
  }
  return {
    kind: activity.stage === 'responding' ? 'response-paused' : 'waiting-model',
    tone: 'neutral',
    quietMs,
  };
}

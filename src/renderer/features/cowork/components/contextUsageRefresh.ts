export const CONTEXT_USAGE_RUNNING_REFRESH_MS = 3_000;
export const CONTEXT_USAGE_IDLE_RETRY_MS = 800;
export const CONTEXT_USAGE_IDLE_RETRIES = 2;
export const CONTEXT_USAGE_FINALIZATION_RETRIES = 6;

export interface ContextUsageRefreshResult {
  success: boolean;
  totalTokens?: number;
  contextTokens?: number;
  totalTokensFresh?: boolean;
  usageSource?: 'estimate' | 'reported';
  usageUpdatedAt?: number;
  hasActiveRun?: boolean;
  compactionCount?: number;
  gatewaySessionId?: string;
  modelRef?: string;
}

export interface ContextUsageSnapshot {
  totalTokens: number;
  contextTokens: number;
  totalTokensFresh: boolean;
  usageSource?: 'estimate' | 'reported';
  usageUpdatedAt?: number;
  compactionCount: number;
  generationKey: string;
}

export interface ContextUsageRunState {
  sessionId?: string;
  active: boolean;
  pendingFinalization: boolean;
}

export const resolveContextUsageRunState = (
  previous: ContextUsageRunState,
  sessionId: string | undefined,
  isRunActive: boolean,
): ContextUsageRunState => {
  if (previous.sessionId !== sessionId) {
    return { sessionId, active: isRunActive, pendingFinalization: false };
  }
  return {
    sessionId,
    active: isRunActive,
    pendingFinalization: !isRunActive && (previous.active || previous.pendingFinalization),
  };
};

export const mergeContextUsageSnapshot = (
  previous: ContextUsageSnapshot | null,
  next: ContextUsageSnapshot,
): ContextUsageSnapshot => {
  if (!previous || next.generationKey !== previous.generationKey) return next;
  if (
    next.usageUpdatedAt !== undefined &&
    previous.usageUpdatedAt !== undefined &&
    next.usageUpdatedAt !== previous.usageUpdatedAt
  ) {
    return next.usageUpdatedAt > previous.usageUpdatedAt ? next : previous;
  }
  // Checkpoint retention can shrink the retained list, so count is only a
  // compatibility fallback when the Gateway does not provide timestamps.
  if (next.compactionCount > previous.compactionCount) return next;
  if (next.compactionCount < previous.compactionCount) return previous;
  if (next.usageSource === 'reported' && previous.usageSource === 'estimate') return next;
  if (next.totalTokens >= previous.totalTokens) return next;
  return {
    ...next,
    totalTokens: previous.totalTokens,
    totalTokensFresh: previous.totalTokensFresh,
  };
};

export const resolveContextUsageDisplay = (totalTokens: number, contextTokens: number) => {
  const normalizedContextTokens = Math.max(0, contextTokens);
  const normalizedTotalTokens = Math.max(0, totalTokens);
  const usedTokens =
    normalizedContextTokens > 0
      ? Math.min(normalizedTotalTokens, normalizedContextTokens)
      : normalizedTotalTokens;
  const percentage =
    normalizedContextTokens > 0
      ? Math.min(100, Math.round((usedTokens / normalizedContextTokens) * 100))
      : 0;
  return {
    usedTokens,
    percentage,
    overflowed: normalizedContextTokens > 0 && normalizedTotalTokens > normalizedContextTokens,
  };
};

export const getContextUsageRefreshDelay = (
  isRunActive: boolean,
  shouldRetryIdle: boolean,
  idleRetriesRemaining: number,
): number | null => {
  if (isRunActive) return CONTEXT_USAGE_RUNNING_REFRESH_MS;
  return shouldRetryIdle && idleRetriesRemaining > 0 ? CONTEXT_USAGE_IDLE_RETRY_MS : null;
};

export const startContextUsageRefresh = (options: {
  isRunActive: boolean;
  retryAfterSuccess: boolean;
  fetchUsage: () => Promise<ContextUsageRefreshResult>;
  onUsage: (
    result: Required<Pick<ContextUsageRefreshResult, 'totalTokens'>> & ContextUsageRefreshResult,
  ) => boolean | void;
  schedule: (callback: () => void, delayMs: number) => number;
  cancelSchedule: (handle: number) => void;
  onIdleComplete?: () => void;
}): (() => void) => {
  let cancelled = false;
  let timeoutId: number | null = null;
  let idleRetriesRemaining = options.retryAfterSuccess
    ? CONTEXT_USAGE_FINALIZATION_RETRIES
    : CONTEXT_USAGE_IDLE_RETRIES;

  const scheduleRefresh = (shouldRetryIdle: boolean) => {
    if (cancelled) return;
    const delay = getContextUsageRefreshDelay(
      options.isRunActive,
      shouldRetryIdle,
      idleRetriesRemaining,
    );
    if (delay === null) {
      if (!options.isRunActive) options.onIdleComplete?.();
      return;
    }
    if (!options.isRunActive) idleRetriesRemaining -= 1;
    timeoutId = options.schedule(fetchUsage, delay);
  };

  const fetchUsage = async () => {
    let shouldRetryIdle = options.retryAfterSuccess;
    try {
      const result = await options.fetchUsage();
      if (cancelled) return;
      if (!result.success || result.totalTokens == null) {
        shouldRetryIdle = true;
        return;
      }
      const normalizedResult = {
        ...result,
        totalTokens: result.totalTokens,
      };
      const accepted = options.onUsage(normalizedResult) !== false;
      const hasCurrentReportedUsage =
        normalizedResult.usageSource === 'reported' && normalizedResult.hasActiveRun === false;
      shouldRetryIdle = !accepted || (options.retryAfterSuccess && !hasCurrentReportedUsage);
    } catch {
      shouldRetryIdle = true;
    } finally {
      scheduleRefresh(shouldRetryIdle);
    }
  };

  void fetchUsage();
  return () => {
    cancelled = true;
    if (timeoutId !== null) options.cancelSchedule(timeoutId);
  };
};

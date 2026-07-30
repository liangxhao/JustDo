export const CONTEXT_USAGE_RUNNING_REFRESH_MS = 3_000;
export const CONTEXT_USAGE_IDLE_RETRY_MS = 500;
export const CONTEXT_USAGE_IDLE_RETRIES = 2;

export interface ContextUsageRefreshResult {
  success: boolean;
  totalTokens?: number;
  contextTokens?: number;
  totalTokensFresh?: boolean;
}

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
  ) => void;
  schedule: (callback: () => void, delayMs: number) => number;
  cancelSchedule: (handle: number) => void;
}): (() => void) => {
  let cancelled = false;
  let timeoutId: number | null = null;
  let idleRetriesRemaining = CONTEXT_USAGE_IDLE_RETRIES;

  const scheduleRefresh = (shouldRetryIdle: boolean) => {
    if (cancelled) return;
    const delay = getContextUsageRefreshDelay(
      options.isRunActive,
      shouldRetryIdle,
      idleRetriesRemaining,
    );
    if (delay === null) return;
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
      options.onUsage({
        ...result,
        totalTokens: result.totalTokens,
      });
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

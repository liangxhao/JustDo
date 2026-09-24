import { useEffect } from 'react';

import { shouldContinueFullRuntimeScan } from '@/features/cowork/components/status/runtimePolling';
import { coworkService } from '@/features/cowork/coworkService';

const CURRENT_SESSION_RUNNING_POLL_MS = 3_000;

const CURRENT_SESSION_IDLE_POLL_MS = 10_000;

const BACKGROUND_SESSION_POLL_MS = 30_000;

const BACKGROUND_DISCOVERY_POLL_MS = 60_000;

const HIDDEN_DISCOVERY_POLL_MS = 120_000;

const HIDDEN_WINDOW_POLL_MS = 60_000;

interface CoworkRuntimePollingOptions {
  currentSessionId: string | null;
  currentSessionRuntimeRunningRef: React.MutableRefObject<boolean>;
  backgroundSessionIdsKey: string;
  backgroundDiscoverySessionIdsKey: string;
}

export function useCoworkRuntimePolling({
  currentSessionId,
  currentSessionRuntimeRunningRef,
  backgroundSessionIdsKey,
  backgroundDiscoverySessionIdsKey,
}: CoworkRuntimePollingOptions) {
  useEffect(() => {
    if (!currentSessionId || currentSessionId.startsWith('temp-')) return;
    let isCancelled = false;
    let timeoutId: number | null = null;
    let refreshInFlight = false;
    let requiresFullScan = true;
    const getNextDelay = () => {
      if (document.hidden) return HIDDEN_WINDOW_POLL_MS;
      return currentSessionRuntimeRunningRef.current
        ? CURRENT_SESSION_RUNNING_POLL_MS
        : CURRENT_SESSION_IDLE_POLL_MS;
    };
    const scheduleNextRefresh = () => {
      if (isCancelled) return;
      timeoutId = window.setTimeout(refresh, getNextDelay());
    };
    const refresh = () => {
      if (isCancelled || refreshInFlight) return;
      refreshInFlight = true;
      void coworkService
        .refreshSessionRuntimeActivity(currentSessionId, {
          includeSubagents: true,
          fullScan: requiresFullScan,
        })
        .then(status => {
          if (status) requiresFullScan = shouldContinueFullRuntimeScan(status);
        })
        .finally(() => {
          refreshInFlight = false;
          scheduleNextRefresh();
        });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        timeoutId = null;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    refresh();
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [currentSessionId, currentSessionRuntimeRunningRef]);

  useEffect(() => {
    const sessionIds = backgroundSessionIdsKey ? backgroundSessionIdsKey.split('\n') : [];
    if (sessionIds.length === 0) return;
    let isCancelled = false;
    let timeoutId: number | null = null;
    let refreshInFlight = false;
    const refresh = () => {
      if (isCancelled || refreshInFlight) return;
      refreshInFlight = true;
      void coworkService.refreshSessionRuntimeActivities(sessionIds).finally(() => {
        refreshInFlight = false;
        if (isCancelled) return;
        timeoutId = window.setTimeout(
          refresh,
          document.hidden ? HIDDEN_WINDOW_POLL_MS : BACKGROUND_SESSION_POLL_MS,
        );
      });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        timeoutId = null;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    refresh();
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [backgroundSessionIdsKey]);

  useEffect(() => {
    const sessionIds = backgroundDiscoverySessionIdsKey
      ? backgroundDiscoverySessionIdsKey.split('\n')
      : [];
    if (sessionIds.length === 0) return;
    let isCancelled = false;
    let timeoutId: number | null = null;
    let refreshInFlight = false;
    const refresh = () => {
      if (isCancelled || refreshInFlight) return;
      refreshInFlight = true;
      void coworkService
        .refreshSessionRuntimeActivities(sessionIds, { fullScan: true })
        .finally(() => {
          refreshInFlight = false;
          if (isCancelled) return;
          timeoutId = window.setTimeout(
            refresh,
            document.hidden ? HIDDEN_DISCOVERY_POLL_MS : BACKGROUND_DISCOVERY_POLL_MS,
          );
        });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        timeoutId = null;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    refresh();
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [backgroundDiscoverySessionIdsKey]);
  return {};
}

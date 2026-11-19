import { useCallback, useState } from 'react';

import type { GoalRunProgress } from './goalRunProgress';

const RETAINED_SESSION_PROGRESS_LIMIT = 8;

/** Native-key reports can precede selection; another key cannot erase their activity. */
export const useSessionRunProgress = (sessionKey: string | null) => {
  const [snapshots, setSnapshots] = useState(() => new Map<string, GoalRunProgress>());
  const [foregroundRun, setForegroundRun] = useState<{ sessionKey: string; runId: string } | null>(null);
  const onActivityChange = useCallback(
    (progress: GoalRunProgress | null, sourceSessionKey: string, nativeForegroundRunId: string | null) => {
      setForegroundRun(current => {
        if (!nativeForegroundRunId) return null;
        if (current?.sessionKey === sourceSessionKey && current.runId === nativeForegroundRunId) return current;
        return { sessionKey: sourceSessionKey, runId: nativeForegroundRunId };
      });
      setSnapshots(previous => {
        if ((previous.get(sourceSessionKey) ?? null) === progress) return previous;
        const next = new Map(previous);
        next.delete(sourceSessionKey);
        if (progress) next.set(sourceSessionKey, progress);
        while (next.size > RETAINED_SESSION_PROGRESS_LIMIT) {
          next.delete(next.keys().next().value!);
        }
        return next;
      });
    },
    [],
  );

  return {
    progress: sessionKey ? (snapshots.get(sessionKey) ?? null) : null,
    nativeForegroundRunId: foregroundRun?.sessionKey === sessionKey ? foregroundRun.runId : null,
    onActivityChange,
  };
};

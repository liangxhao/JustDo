import { useCallback, useState } from 'react';

import type { GoalRunProgress } from './goalRunProgress';

const RETAINED_SESSION_PROGRESS_LIMIT = 8;

/** Native-key reports can precede selection; another key cannot erase their activity. */
export const useSessionRunProgress = (sessionKey: string | null) => {
  const [snapshots, setSnapshots] = useState(() => new Map<string, GoalRunProgress>());
  const onActivityChange = useCallback(
    (progress: GoalRunProgress | null, sourceSessionKey: string) => {
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
    onActivityChange,
  };
};

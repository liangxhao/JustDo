import { useCallback, useRef, useState } from 'react';

/** Unknown Goal state must never authorize a queued input. */
export function useGoalReadiness(sessionId: string | undefined, isSideChat = false) {
  const scope = useRef({ sessionId, generation: 0 });
  if (scope.current.sessionId !== sessionId) {
    scope.current = { sessionId, generation: scope.current.generation + 1 };
  }
  const generation = scope.current.generation;
  const [confirmedGeneration, setConfirmedGeneration] = useState<number | null>(null);
  const readGoal = useCallback(
    async <T extends { success: boolean }>(read: () => Promise<T>) => {
      setConfirmedGeneration(null);
      const result = await read();
      if (scope.current.generation === generation && result.success) {
        setConfirmedGeneration(generation);
      }
      return result;
    },
    [generation],
  );
  const goalReadReady = confirmedGeneration === generation;
  const goalSubmissionBlocked =
    !isSideChat && !!sessionId && !sessionId.startsWith('temp-') && !goalReadReady;
  return { goalReadReady, goalSubmissionBlocked, readGoal };
}

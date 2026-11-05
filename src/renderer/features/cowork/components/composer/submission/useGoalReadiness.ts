import { useCallback, useRef, useState } from 'react';

const GoalReadPhase = {
  Pending: 'pending',
  Ready: 'ready',
  Failed: 'failed',
} as const;

type GoalReadState = {
  generation: number;
  request: number;
  phase: typeof GoalReadPhase[keyof typeof GoalReadPhase];
  failed: boolean;
};

/** Unknown Goal state must never authorize a queued input. */
export function useGoalReadiness(sessionId: string | undefined, isSideChat = false) {
  const scope = useRef({ sessionId, generation: 0, request: 0 });
  if (scope.current.sessionId !== sessionId) {
    scope.current = { sessionId, generation: scope.current.generation + 1, request: 0 };
  }
  const generation = scope.current.generation;
  const [readState, setReadState] = useState<GoalReadState | null>(null);
  const invalidateGoalRead = useCallback(() => {
    if (scope.current.generation === generation) scope.current.request += 1;
  }, [generation]);
  const readGoal = useCallback(
    async <T extends { success: boolean }>(read: () => Promise<T>) => {
      const request = scope.current.generation === generation ? ++scope.current.request : null;
      const isCurrent = () => request !== null && scope.current.generation === generation &&
        scope.current.request === request;
      if (request !== null && isCurrent()) {
        setReadState(previous => ({
          generation,
          request,
          phase: GoalReadPhase.Pending,
          failed: previous?.generation === generation && previous.failed,
        }));
      }
      try {
        const result = await read();
        const current = isCurrent();
        if (request !== null && current) {
          setReadState({
            generation,
            request,
            phase: result.success ? GoalReadPhase.Ready : GoalReadPhase.Failed,
            failed: !result.success,
          });
        }
        // Callers must not apply an obsolete success to the current composer.
        return { ...result, success: current && result.success };
      } catch (error) {
        if (request !== null && isCurrent()) {
          setReadState({ generation, request, phase: GoalReadPhase.Failed, failed: true });
        }
        throw error;
      }
    },
    [generation],
  );
  const currentRead = readState?.generation === generation &&
    readState.request === scope.current.request ? readState : null;
  const goalReadReady = currentRead?.phase === GoalReadPhase.Ready;
  const goalReadPending = currentRead?.phase === GoalReadPhase.Pending;
  const goalReadFailed = currentRead?.failed === true;
  const goalSubmissionBlocked =
    !isSideChat && !!sessionId && !sessionId.startsWith('temp-') && !goalReadReady;
  return {
    goalReadReady,
    goalReadPending,
    goalReadFailed,
    goalSubmissionBlocked,
    readGoal,
    invalidateGoalRead,
  };
}

import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  SessionGoalMutationAction,
  type SessionGoalMutationResult,
} from '@shared/sessionGoal';

export function acceptedGoalResumeRunId(
  result: {
    mutation?: SessionGoalMutationResult;
    execution?: GoalExecutionSnapshot;
  },
  sessionId: string,
): string | null {
  const mutationRunId = result.mutation?.runId?.trim();
  const executionRunId = result.execution?.runId?.trim();
  return result.mutation?.action === SessionGoalMutationAction.Resume &&
    result.mutation.status === 'started' &&
    mutationRunId &&
    result.execution?.sessionId === sessionId &&
    result.execution.phase === GoalExecutionPhase.Running &&
    executionRunId === mutationRunId
    ? mutationRunId
    : null;
}

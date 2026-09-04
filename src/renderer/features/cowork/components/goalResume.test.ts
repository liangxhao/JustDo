import { GoalExecutionPhase, SessionGoalMutationAction } from '@shared/sessionGoal';
import { describe, expect, test } from 'vitest';

import { acceptedGoalResumeRunId } from './goalResume';

const activeResume = {
  mutation: {
    operationId: 'run-resumed',
    action: SessionGoalMutationAction.Resume,
    sessionId: 'gateway-session-1',
    goalId: 'goal-1',
    runId: 'run-resumed',
    status: 'started' as const,
  },
  execution: {
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: GoalExecutionPhase.Running,
    runId: 'run-resumed',
    continuationCount: 0,
    updatedAt: 1,
  },
};

describe('acceptedGoalResumeRunId', () => {
  test('returns the run only when canonical execution confirms it is active', () => {
    expect(acceptedGoalResumeRunId(activeResume, 'session-1')).toBe('run-resumed');
  });

  test('rejects a replayed receipt whose run is no longer active', () => {
    expect(
      acceptedGoalResumeRunId(
        { mutation: { ...activeResume.mutation, replayed: true } },
        'session-1',
      ),
    ).toBeNull();
  });

  test('rejects mismatched execution run and session identities', () => {
    expect(
      acceptedGoalResumeRunId(
        {
          ...activeResume,
          execution: { ...activeResume.execution, runId: 'other-run' },
        },
        'session-1',
      ),
    ).toBeNull();
    expect(acceptedGoalResumeRunId(activeResume, 'session-2')).toBeNull();
  });
});

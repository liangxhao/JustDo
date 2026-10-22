import type { GoalExecutionSnapshot, SessionGoal } from '@shared/cowork/sessionGoal';

export async function readGoalState(
  readGoal: () => Promise<{ success: boolean; goal?: SessionGoal | null }>,
  readExecution: () => Promise<{ success: boolean; execution?: GoalExecutionSnapshot | null }>,
) {
  const [goal, execution] = await Promise.all([readGoal(), readExecution()]);
  return {
    success: goal.success && execution.success,
    goal: goal.goal,
    execution: execution.execution,
  };
}

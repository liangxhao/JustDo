import type { GoalRunProgress } from '@/features/cowork/components/goals/goalRunProgress';

export const isCoworkRunActive = (
  runtimeRunning: boolean,
  progress: GoalRunProgress | null | undefined,
): boolean => runtimeRunning || progress?.phase === 'compacting';

export const canStopCoworkRun = (
  runtimeRunning: boolean,
  progress: GoalRunProgress | null | undefined,
): boolean => isCoworkRunActive(runtimeRunning, progress);

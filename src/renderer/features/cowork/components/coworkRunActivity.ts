import type { GoalRunProgress } from '@/features/cowork/components/goalRunProgress';

export const isCoworkRunActive = (
  runtimeRunning: boolean,
  _progress: GoalRunProgress | null | undefined,
): boolean => runtimeRunning;

export const canStopCoworkRun = (
  runtimeRunning: boolean,
  progress: GoalRunProgress | null | undefined,
): boolean => runtimeRunning && progress?.phase !== 'compacting';

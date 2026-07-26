export const ExecutionPlanStepStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const;

export type ExecutionPlanStepStatus =
  (typeof ExecutionPlanStepStatus)[keyof typeof ExecutionPlanStepStatus];

export interface ExecutionPlanStep {
  step: string;
  status: ExecutionPlanStepStatus;
}

export interface ExecutionPlanUpdate {
  explanation?: string;
  plan: ExecutionPlanStep[];
}

const PLAN_STEP_STATUSES = new Set<ExecutionPlanStepStatus>(
  Object.values(ExecutionPlanStepStatus),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const parseExecutionPlanUpdate = (candidate: unknown): ExecutionPlanUpdate | null => {
  if (!isRecord(candidate) || !Array.isArray(candidate.plan) || candidate.plan.length === 0) {
    return null;
  }
  if (candidate.explanation !== undefined && typeof candidate.explanation !== 'string') {
    return null;
  }

  let inProgressCount = 0;
  const plan: ExecutionPlanStep[] = [];
  for (const candidateStep of candidate.plan) {
    if (!isRecord(candidateStep)) return null;
    const step = typeof candidateStep.step === 'string' ? candidateStep.step.trim() : '';
    const status = candidateStep.status;
    if (!step || typeof status !== 'string' || !PLAN_STEP_STATUSES.has(status as ExecutionPlanStepStatus)) {
      return null;
    }
    if (status === ExecutionPlanStepStatus.InProgress) {
      inProgressCount += 1;
      if (inProgressCount > 1) return null;
    }
    plan.push({ step, status: status as ExecutionPlanStepStatus });
  }

  const explanation =
    typeof candidate.explanation === 'string' ? candidate.explanation.trim() : '';
  return {
    ...(explanation ? { explanation } : {}),
    plan,
  };
};

export const EXTERNAL_SESSION_GOAL_METHOD = 'runtimeServices.sessionGoal';
export const SESSION_GOAL_REJECTED = 'SESSION_GOAL_REJECTED';
export const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;

export const NATIVE_GOAL_STATUSES = [
  'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete',
] as const;

export type NativeGoalStatus = (typeof NATIVE_GOAL_STATUSES)[number];

interface SessionGoalIdentity {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  operationId: string;
}

export type SessionGoalMutation = SessionGoalIdentity & { expectedGoalId: string | null } & (
  | { action: 'clear' }
  | { action: 'set'; allowReplacement: boolean; objective?: string; status?: NativeGoalStatus; tokenBudget?: number | null }
);

export interface SessionGoalMutationReceipt<Goal = unknown> extends SessionGoalIdentity {
  goal: Goal | null;
  start: boolean;
  cleared: boolean;
}

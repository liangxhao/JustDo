export const SessionGoalStatus = {
  Active: 'active',
  Paused: 'paused',
  Blocked: 'blocked',
  UsageLimited: 'usage_limited',
  BudgetLimited: 'budget_limited',
  Complete: 'complete',
} as const;

export type SessionGoalStatus = (typeof SessionGoalStatus)[keyof typeof SessionGoalStatus];

const SESSION_GOAL_STATUSES: ReadonlySet<string> = new Set(Object.values(SessionGoalStatus));

export const isSessionGoalStatus = (value: unknown): value is SessionGoalStatus =>
  typeof value === 'string' && SESSION_GOAL_STATUSES.has(value);

export interface SessionGoal {
  schemaVersion: 1;
  id: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  tokenStart: number;
  tokenStartFresh?: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  continuationTurns: number;
  lastStatusNote?: string;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  usageLimitedAt?: number;
  budgetLimitedAt?: number;
}

export const GoalExecutionPhase = {
  Waiting: 'waiting',
  Running: 'running',
  Continuing: 'continuing',
  Stopped: 'stopped',
  Failed: 'failed',
} as const;

export type GoalExecutionPhase =
  (typeof GoalExecutionPhase)[keyof typeof GoalExecutionPhase];

export const GoalExecutionFailureReason = {
  StalledNoProgress: 'stalled_no_progress',
} as const;

export type GoalExecutionFailureReason =
  (typeof GoalExecutionFailureReason)[keyof typeof GoalExecutionFailureReason];

export interface GoalExecutionSnapshot {
  sessionId: string;
  goalId?: string;
  phase: GoalExecutionPhase;
  runId?: string;
  continuationCount: number;
  updatedAt: number;
  error?: string;
  failureReason?: GoalExecutionFailureReason;
}

export const GoalExecutionIpc = {
  Get: 'cowork:goal:execution:get',
  Continue: 'cowork:goal:execution:continue',
  Changed: 'cowork:goal:execution:changed',
} as const;

export const SessionGoalIpc = {
  Changed: 'cowork:session:goalChanged',
} as const;

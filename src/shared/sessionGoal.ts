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

const nonNegativeGoalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const normalizeSessionGoal = (value: unknown): SessionGoal | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const objective = typeof source.objective === 'string' ? source.objective.trim() : '';
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (source.schemaVersion !== 1 || !isSessionGoalStatus(source.status) || !objective || !id) {
    return undefined;
  }
  const status =
    source.status === SessionGoalStatus.UsageLimited ||
    source.status === SessionGoalStatus.BudgetLimited
      ? SessionGoalStatus.Blocked
      : source.status;
  const numeric = (key: string, fallback = 0) => nonNegativeGoalNumber(source[key]) ?? fallback;
  const optionalNumeric = (key: string) => {
    const result = nonNegativeGoalNumber(source[key]);
    return result === undefined ? {} : { [key]: result };
  };
  const tokenBudget = nonNegativeGoalNumber(source.tokenBudget);
  const lastStatusNote =
    typeof source.lastStatusNote === 'string' && source.lastStatusNote.trim()
      ? source.lastStatusNote.trim()
      : undefined;

  return {
    schemaVersion: 1,
    id,
    objective,
    status,
    createdAt: numeric('createdAt'),
    updatedAt: numeric('updatedAt'),
    tokenStart: numeric('tokenStart'),
    ...(typeof source.tokenStartFresh === 'boolean'
      ? { tokenStartFresh: source.tokenStartFresh }
      : {}),
    tokensUsed: numeric('tokensUsed'),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    continuationTurns: numeric('continuationTurns'),
    ...(lastStatusNote ? { lastStatusNote } : {}),
    ...optionalNumeric('pausedAt'),
    ...optionalNumeric('blockedAt'),
    ...optionalNumeric('completedAt'),
    ...optionalNumeric('usageLimitedAt'),
    ...optionalNumeric('budgetLimitedAt'),
  };
};

export const GoalExecutionPhase = {
  Waiting: 'waiting',
  Running: 'running',
  Continuing: 'continuing',
  Retrying: 'retrying',
  AwaitingInput: 'awaiting_input',
  AwaitingConfirmation: 'awaiting_confirmation',
  Stopped: 'stopped',
} as const;

export type GoalExecutionPhase = (typeof GoalExecutionPhase)[keyof typeof GoalExecutionPhase];

export interface GoalExecutionSnapshot {
  sessionId: string;
  goalId?: string;
  phase: GoalExecutionPhase;
  runId?: string;
  continuationCount: number;
  updatedAt: number;
  error?: string;
  retryAttempt?: number;
  nextRetryAt?: number;
  identityPending?: boolean;
}

export interface GoalFeedbackPreparationResult {
  objective: string;
}

export const GoalExecutionIpc = {
  Get: 'cowork:goal:execution:get',
  Continue: 'cowork:goal:execution:continue',
  ResumeForUserInput: 'cowork:goal:execution:resumeForUserInput',
  RestartCompletedForFeedback: 'cowork:goal:execution:restartCompletedForFeedback',
  Changed: 'cowork:goal:execution:changed',
} as const;

export const SessionGoalIpc = {
  Changed: 'cowork:session:goalChanged',
} as const;

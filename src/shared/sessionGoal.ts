export const SessionGoalStatus = {
  Active: 'active',
  Paused: 'paused',
  Blocked: 'blocked',
  UsageLimited: 'usage_limited',
  BudgetLimited: 'budget_limited',
  Complete: 'complete',
} as const;

export const DEFAULT_MAX_GOAL_CONTINUATION_TURNS = 25;
export const MIN_MAX_GOAL_CONTINUATION_TURNS = 0;
export const MAX_MAX_GOAL_CONTINUATION_TURNS = 1000;

export const normalizeMaxGoalContinuationTurns = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_GOAL_CONTINUATION_TURNS;
  }
  return Math.min(
    MAX_MAX_GOAL_CONTINUATION_TURNS,
    Math.max(MIN_MAX_GOAL_CONTINUATION_TURNS, Math.floor(value)),
  );
};

export type SessionGoalStatus = (typeof SessionGoalStatus)[keyof typeof SessionGoalStatus];

export const SESSION_GOAL_MAX_OBJECTIVE_LENGTH = 16_000;
export const SESSION_GOAL_MAX_NOTE_LENGTH = 2_000;

export const SessionGoalMutationAction = {
  Edit: 'edit',
  Pause: 'pause',
  Resume: 'resume',
  Block: 'block',
  Complete: 'complete',
  Clear: 'clear',
} as const;

export type SessionGoalMutationAction =
  (typeof SessionGoalMutationAction)[keyof typeof SessionGoalMutationAction];

interface SessionGoalMutationRequestBase {
  goalId: string;
}

export type SessionGoalMutationRequest = SessionGoalMutationRequestBase &
  (
    | { action: 'edit'; objective: string }
    | { action: 'pause' | 'resume' | 'block' | 'complete'; note?: string }
    | { action: 'clear' }
  );

export const normalizeSessionGoalMutationRequest = (
  value: unknown,
): SessionGoalMutationRequest | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const goalId = typeof source.goalId === 'string' ? source.goalId.trim() : '';
  const action = source.action;
  if (!goalId || typeof action !== 'string') return undefined;
  if (action === SessionGoalMutationAction.Edit) {
    if (
      typeof source.objective !== 'string' ||
      !source.objective.trim() ||
      source.objective.length > SESSION_GOAL_MAX_OBJECTIVE_LENGTH
    ) {
      return undefined;
    }
    return { goalId, action, objective: source.objective };
  }
  if (action === SessionGoalMutationAction.Clear) return { goalId, action };
  if (
    action !== SessionGoalMutationAction.Pause &&
    action !== SessionGoalMutationAction.Resume &&
    action !== SessionGoalMutationAction.Block &&
    action !== SessionGoalMutationAction.Complete
  ) {
    return undefined;
  }
  if (
    source.note !== undefined &&
    (typeof source.note !== 'string' || source.note.length > SESSION_GOAL_MAX_NOTE_LENGTH)
  ) {
    return undefined;
  }
  return {
    goalId,
    action,
    ...(typeof source.note === 'string' && source.note ? { note: source.note } : {}),
  };
};

export interface SessionGoalMutationResult {
  operationId: string;
  action: 'start' | SessionGoalMutationAction;
  sessionId: string;
  goalId: string;
  goal?: SessionGoal;
  runId?: string;
  replayed?: true;
  status: 'started' | 'updated' | 'cleared';
}

export interface SessionGoalMutationOutcome {
  mutation: SessionGoalMutationResult;
  goal: SessionGoal | null;
  execution?: GoalExecutionSnapshot;
}

const DEFINITIVE_SESSION_GOAL_GATEWAY_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'FORBIDDEN',
  'NOT_PAIRED',
  'NOT_LINKED',
  'APPROVAL_NOT_FOUND',
  'METHOD_NOT_FOUND',
]);

/** Only known pre-commit protocol or authorization failures retire an operation identity. */
export const isDefinitiveSessionGoalGatewayError = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const gatewayCode = (value as { gatewayCode?: unknown }).gatewayCode;
  return (
    typeof gatewayCode === 'string' &&
    DEFINITIVE_SESSION_GOAL_GATEWAY_ERROR_CODES.has(gatewayCode)
  );
};

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
  const objective = typeof source.objective === 'string' ? source.objective : '';
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (
    source.schemaVersion !== 1 ||
    !isSessionGoalStatus(source.status) ||
    !objective.trim() ||
    !id
  ) {
    return undefined;
  }
  const numeric = (key: string, fallback = 0) => nonNegativeGoalNumber(source[key]) ?? fallback;
  const optionalNumeric = (key: string) => {
    const result = nonNegativeGoalNumber(source[key]);
    return result === undefined ? {} : { [key]: result };
  };
  const tokenBudget = nonNegativeGoalNumber(source.tokenBudget);
  const lastStatusNote =
    typeof source.lastStatusNote === 'string' && source.lastStatusNote.trim()
      ? source.lastStatusNote
      : undefined;

  return {
    schemaVersion: 1,
    id,
    objective,
    status: source.status,
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
  RestartCompletedForFeedback: 'cowork:goal:execution:restartCompletedForFeedback',
  Changed: 'cowork:goal:execution:changed',
} as const;

export const SessionGoalIpc = {
  Mutate: 'cowork:session:goalMutate',
  Changed: 'cowork:session:goalChanged',
} as const;

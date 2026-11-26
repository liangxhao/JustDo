import { type SessionGoal, SessionGoalStatus } from '../../../../shared/cowork/sessionGoal';
import type { ExternalAgentGoalSetRequest } from '../../shared/externalAgentTypes';
import type { AppServerParams } from '../protocol/appServerProtocol';
import { invalidParams } from './codexAppServerPagination';

const GOAL_OBJECTIVE_LIMIT = 4_000;
const STATUS_FROM_WIRE = {
  active: SessionGoalStatus.Active,
  paused: SessionGoalStatus.Paused,
  blocked: SessionGoalStatus.Blocked,
  usageLimited: SessionGoalStatus.UsageLimited,
  budgetLimited: SessionGoalStatus.BudgetLimited,
  complete: SessionGoalStatus.Complete,
} as const;

export function validateCodexGoalOrigin(params: AppServerParams): void {
  if (params.origin != null && params.origin !== 'user' && params.origin !== 'automatic') {
    invalidParams('origin must be user or automatic.');
  }
}

export function parseCodexGoalSet(params: AppServerParams): ExternalAgentGoalSetRequest {
  validateCodexGoalOrigin(params);
  const update: ExternalAgentGoalSetRequest = {};
  if (params.objective != null) {
    if (typeof params.objective !== 'string') invalidParams('objective must be a string.');
    const objective = params.objective.trim();
    if (!objective || objective.length > GOAL_OBJECTIVE_LIMIT * 2 ||
        Array.from(objective).length > GOAL_OBJECTIVE_LIMIT) {
      invalidParams(`objective must contain 1 to ${GOAL_OBJECTIVE_LIMIT} characters.`);
    }
    update.objective = objective;
  }
  if (params.status != null) {
    if (typeof params.status !== 'string' || !Object.hasOwn(STATUS_FROM_WIRE, params.status)) {
      invalidParams('status is not a valid thread Goal status.');
    }
    update.status = STATUS_FROM_WIRE[params.status as keyof typeof STATUS_FROM_WIRE];
  }
  const budget = params.tokenBudget;
  if (budget === null) update.tokenBudget = null;
  else if (budget !== undefined) {
    if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget <= 0) {
      invalidParams('tokenBudget must be a positive safe integer or null.');
    }
    update.tokenBudget = budget;
  }
  return update;
}

export function codexThreadGoal(threadId: string, goal: SessionGoal) {
  const status = goal.status === SessionGoalStatus.UsageLimited ? 'usageLimited'
    : goal.status === SessionGoalStatus.BudgetLimited ? 'budgetLimited' : goal.status;
  return {
    threadId,
    objective: goal.objective,
    status,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: Math.trunc(goal.tokensUsed),
    // The locked native Goal projection does not expose elapsed execution time.
    timeUsedSeconds: 0,
    createdAt: Math.trunc(goal.createdAt / 1_000),
    updatedAt: Math.trunc(goal.updatedAt / 1_000),
  };
}

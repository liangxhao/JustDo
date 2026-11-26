import { isDeepStrictEqual } from 'node:util';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { patchSessionEntry, type SessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  EXTERNAL_SESSION_GOAL_METHOD,
  MAX_GOAL_OBJECTIVE_LENGTH,
  NATIVE_GOAL_STATUSES,
  type NativeGoalStatus,
  SESSION_GOAL_REJECTED,
  type SessionGoalMutation,
  type SessionGoalMutationReceipt,
} from './contracts/session-goal';
import { buildCoworkSessionKey, parseCoworkSessionKey } from './contracts/session-key';

type NativeGoal = NonNullable<SessionEntry['goal']>;
type GoalSet = Extract<SessionGoalMutation, { action: 'set' }>;
type GoalReceipt = SessionGoalMutationReceipt<NativeGoal>;

const GOAL_STATUSES: ReadonlySet<string> = new Set(NATIVE_GOAL_STATUSES);
const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_IDENTITY_LENGTH = 512;

class GoalMutationRejected extends Error {
  constructor(readonly reason: 'invalid' | 'session-rebound' | 'goal-rebound' | 'forbidden' | 'busy', message: string) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new GoalMutationRejected('invalid', message);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isGoalStatus(value: unknown): value is NativeGoalStatus {
  return typeof value === 'string' && GOAL_STATUSES.has(value);
}

function readMutation(params: Record<string, unknown>): SessionGoalMutation & { agentId: string } {
  const { action, sessionKey, sessionId, lifecycleRevision, operationId, expectedGoalId, allowReplacement, objective, status, tokenBudget } = params;
  const key = isIdentity(sessionKey) ? parseCoworkSessionKey(sessionKey) : null;
  if (
    typeof sessionKey !== 'string' || !key?.agentId || !/^[a-z0-9_-]{1,64}$/u.test(key.agentId) ||
    sessionKey !== buildCoworkSessionKey(key.sessionId, key.agentId) ||
    !isIdentity(sessionId) || !isIdentity(lifecycleRevision) ||
    typeof operationId !== 'string' || !OPERATION_ID.test(operationId) ||
    (expectedGoalId !== null && !isIdentity(expectedGoalId))
  ) invalid('Exact managed session, Goal and operation identities are required.');

  const identity = { sessionKey, agentId: key.agentId, sessionId, lifecycleRevision, operationId, expectedGoalId };
  if (action === 'clear' && allowReplacement === undefined && objective === undefined && status === undefined && tokenBudget === undefined)
    return { ...identity, action };
  if (action !== 'set' || typeof allowReplacement !== 'boolean') invalid('Invalid Goal action.');
  const normalizedObjective = typeof objective === 'string' ? objective.trim() : undefined;
  if (objective !== undefined && (!normalizedObjective ||
      normalizedObjective.length > MAX_GOAL_OBJECTIVE_LENGTH * 2 ||
      Array.from(normalizedObjective).length > MAX_GOAL_OBJECTIVE_LENGTH))
    invalid(`The Goal objective must contain 1 to ${MAX_GOAL_OBJECTIVE_LENGTH} characters.`);
  if (status !== undefined && !isGoalStatus(status)) invalid('Invalid Goal status.');
  if (tokenBudget !== undefined && tokenBudget !== null &&
      (typeof tokenBudget !== 'number' || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
    invalid('The Goal token budget must be a positive integer or null.');
  return {
    ...identity,
    action,
    allowReplacement,
    ...(normalizedObjective !== undefined ? { objective: normalizedObjective } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

function assertSession(entry: SessionEntry, request: SessionGoalMutation): void {
  if (entry.sessionId !== request.sessionId || entry.lifecycleRevision !== request.lifecycleRevision)
    throw new GoalMutationRejected('session-rebound', 'The native session identity changed.');
  if (entry.pluginOwnerId)
    throw new GoalMutationRejected('forbidden', 'The native session is owned by a plugin.');
  if ((entry.goal?.id ?? null) !== request.expectedGoalId)
    throw new GoalMutationRejected('goal-rebound', 'The native Goal identity changed.');
}

function freshSessionTokens(entry: SessionEntry): number | undefined {
  const { totalTokens, totalTokensFresh, totalTokensVersion } = entry;
  if (totalTokensFresh !== true || totalTokensVersion !== 1 ||
      typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0)
    return undefined;
  return Math.floor(totalTokens);
}

function goalStatusTimes(status: NativeGoalStatus, now: number): Partial<NativeGoal> {
  switch (status) {
    case 'paused': return { pausedAt: now };
    case 'blocked': return { blockedAt: now };
    case 'complete': return { completedAt: now };
    case 'usage_limited': return { usageLimitedAt: now };
    case 'budget_limited': return { budgetLimitedAt: now };
    case 'active': return {};
  }
}

function setGoal(entry: SessionEntry, request: GoalSet, now: number): Pick<GoalReceipt, 'goal' | 'start'> {
  const previous = entry.goal;
  const objective = request.objective;
  const totalTokens = freshSessionTokens(entry);
  const tokenBudget = request.tokenBudget === undefined ? previous?.tokenBudget : request.tokenBudget ?? undefined;
  const replace = objective !== undefined && (previous?.objective !== objective || previous.status === 'complete');

  if (replace) {
    // Evaluate against the native row: this Goal may have completed after Main's read.
    if (!request.allowReplacement)
      throw new GoalMutationRejected('busy', 'Wait for the current turn to settle before setting a new Goal.');
    const status = request.status ?? 'active';
    const goal: NativeGoal = {
      schemaVersion: 1,
      id: request.operationId,
      objective,
      status,
      createdAt: now,
      updatedAt: now,
      tokenStart: totalTokens ?? 0,
      tokenStartFresh: totalTokens !== undefined,
      tokensUsed: 0,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      continuationTurns: 0,
      ...goalStatusTimes(status, now),
    };
    return { goal, start: status === 'active' };
  }
  if (!previous) invalid('An objective is required to create a Goal.');

  const adoptBaseline = previous.tokenStartFresh === false && totalTokens !== undefined;
  const tokenStart = adoptBaseline ? totalTokens : previous.tokenStart;
  const tokensUsed = totalTokens === undefined || adoptBaseline
    ? previous.tokensUsed
    : Math.max(previous.tokensUsed, totalTokens - tokenStart);
  const requestedStatus = request.status ?? previous.status;
  const status = requestedStatus === 'active' && tokenBudget !== undefined && tokensUsed >= tokenBudget
    ? 'budget_limited' : requestedStatus;
  const goal: NativeGoal = {
    ...previous,
    status,
    tokenStart,
    tokenStartFresh: previous.tokenStartFresh !== false || adoptBaseline,
    tokensUsed,
    updatedAt: now,
    ...(status !== previous.status ? goalStatusTimes(status, now) : {}),
  };
  if (tokenBudget === undefined) delete goal.tokenBudget;
  else goal.tokenBudget = tokenBudget;
  if (status === 'active') {
    delete goal.budgetLimitedAt;
    delete goal.usageLimitedAt;
  }
  return { goal, start: status === 'active' && request.status === 'active' };
}

export function registerSessionGoal(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(EXTERNAL_SESSION_GOAL_METHOD, async ({ params, respond, client, signal, hasCurrentClientAuthority }) => {
    const assertCurrent = () => {
      if (
        api.lifecycle.signal?.aborted !== false || signal?.aborted ||
        client?.connectionSignal?.aborted || client?.connect.client.mode !== 'backend' ||
        hasCurrentClientAuthority?.() !== true
      ) throw new GoalMutationRejected('forbidden', 'A current backend request is required.');
    };
    try {
      assertCurrent();
      const request = readMutation(params);
      const { sessionKey, sessionId, lifecycleRevision, operationId, agentId } = request;
      let candidate: GoalReceipt | undefined;
      const committed = await patchSessionEntry({
        agentId, sessionKey,
        preserveActivity: true,
        requireWriteSuccess: true,
        assertCommitAllowed: assertCurrent,
        update: entry => {
          assertSession(entry, request);
          const next = request.action === 'clear'
            ? { goal: null, start: false, cleared: entry.goal !== undefined }
            : { ...setGoal(entry, request, Math.max(Date.now(), entry.goal?.updatedAt ?? 0)), cleared: false };
          candidate = { sessionKey, sessionId, lifecycleRevision, operationId, ...next };
          return request.action === 'clear' && !next.cleared ? null : { goal: next.goal ?? undefined };
        },
      });
      if (!candidate && !committed)
        throw new GoalMutationRejected('session-rebound', 'The native session is unavailable.');
      if (
        !candidate || !committed || committed.sessionId !== sessionId ||
        committed.lifecycleRevision !== lifecycleRevision ||
        !isDeepStrictEqual(candidate.goal, committed.goal ?? null)
      ) throw new Error('Native Goal commit could not be verified.');
      respond(true, { ...candidate, goal: committed.goal ?? null });
    } catch (error) {
      if (error instanceof GoalMutationRejected) {
        respond(false, undefined, {
          code: 'INVALID_REQUEST', message: error.message,
          details: { code: SESSION_GOAL_REJECTED, reason: error.reason },
        });
      } else {
        respond(false, undefined, { code: 'UNAVAILABLE', message: 'The native Goal mutation outcome is unknown.' });
      }
    }
  }, { scope: 'operator.admin', profileAccess: 'independent' });
}

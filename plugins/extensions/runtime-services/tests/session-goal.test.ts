import { expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ patchSessionEntry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => sdk);

import { EXTERNAL_SESSION_GOAL_METHOD, SESSION_GOAL_REJECTED } from '../contracts/session-goal';
import { registerSessionGoal } from '../session-goal';

const sessionKey = 'agent:main:justdo:conversation';
const oldGoalId = '4059eb2a-fe6c-40b2-872a-c9c5cc381d5d';
const operationId = 'a54c9f32-7b20-4d50-a1a1-e83fa4a1698d';
const identity = { sessionKey, sessionId: 'native-conversation', lifecycleRevision: 'revision-1', operationId };

function fixture() {
  const registerGatewayMethod = vi.fn();
  const entry = {
    sessionId: identity.sessionId,
    lifecycleRevision: identity.lifecycleRevision,
    displayName: 'Conversation',
    updatedAt: 300,
    totalTokens: 145,
    totalTokensFresh: true,
    totalTokensVersion: 1,
    goal: {
      schemaVersion: 1, id: oldGoalId, objective: 'Previous objective', status: 'active',
      createdAt: 100, updatedAt: 200, tokenStart: 100, tokenStartFresh: true,
      continuationTurns: 3, tokensUsed: 40, tokenBudget: 100,
    },
  };
  const state: { entry: Omit<typeof entry, 'goal'> & { goal?: typeof entry.goal } } = { entry };
  sdk.patchSessionEntry.mockReset().mockImplementation(({ agentId, sessionKey, assertCommitAllowed, update }) => {
    expect(agentId).toBe('main');
    expect(sessionKey).toBe(identity.sessionKey);
    const patch = update(state.entry);
    assertCommitAllowed();
    if (patch !== null) state.entry = { ...state.entry, ...patch };
    return state.entry;
  });
  registerSessionGoal({
    lifecycle: { signal: new AbortController().signal },
    registerGatewayMethod,
  } as never);
  expect(registerGatewayMethod).toHaveBeenCalledWith(EXTERNAL_SESSION_GOAL_METHOD, expect.any(Function), {
    scope: 'operator.admin', profileAccess: 'independent',
  });

  async function send(params: Record<string, unknown>, request: Record<string, unknown> = {}) {
    const respond = vi.fn();
    await registerGatewayMethod.mock.calls[0][1]({
      params: {
        ...identity, expectedGoalId: state.entry.goal?.id ?? null,
        ...(params.action === 'set' ? { allowReplacement: true } : {}), ...params,
      },
      respond,
      client: { connect: { client: { mode: 'backend' } } },
      hasCurrentClientAuthority: () => true,
      ...request,
    });
    return respond;
  }

  return { state, send };
}

test('replaces a Goal in one native commit with a fresh baseline and its existing budget', async () => {
  const { state, send } = fixture();

  const respond = await send({ action: 'set', objective: '  Current objective  ' });

  expect(sdk.patchSessionEntry).toHaveBeenCalledOnce();
  expect(sdk.patchSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ preserveActivity: true, requireWriteSuccess: true }));
  expect(state.entry).toMatchObject({
    displayName: 'Conversation', updatedAt: 300,
    goal: {
      id: operationId, objective: 'Current objective', status: 'active', tokensUsed: 0,
      tokenBudget: 100, tokenStart: 145, tokenStartFresh: true, continuationTurns: 0,
    },
  });
  expect(respond).toHaveBeenCalledWith(true, { ...identity, goal: state.entry.goal, start: true, cleared: false });
});

test('applies budget limits to current usage and clears the budget when explicitly requested', async () => {
  const { state, send } = fixture();

  const limited = await send({ action: 'set', tokenBudget: 45 });
  const limitedGoal = state.entry.goal;
  const resumed = await send({ action: 'set', status: 'active', tokenBudget: null });

  expect(limited).toHaveBeenCalledWith(true, expect.objectContaining({ start: false, goal: limitedGoal }));
  expect(limitedGoal).toMatchObject({ id: oldGoalId, tokensUsed: 45, status: 'budget_limited', tokenBudget: 45 });
  expect(resumed).toHaveBeenCalledWith(true, expect.objectContaining({ start: true, goal: state.entry.goal }));
  expect(state.entry.goal).toMatchObject({ id: oldGoalId, tokensUsed: 45, status: 'active', continuationTurns: 3 });
  expect(state.entry.goal).not.toHaveProperty('tokenBudget');
});

test('clear returns the actual disappearance and reports no change for an absent Goal', async () => {
  const { state, send } = fixture();

  const cleared = await send({ action: 'clear' });
  const absent = await send({ action: 'clear' });

  expect(cleared).toHaveBeenCalledWith(true, { ...identity, goal: null, start: false, cleared: true });
  expect(absent).toHaveBeenCalledWith(true, { ...identity, goal: null, start: false, cleared: false });
  expect(state.entry.goal).toBeUndefined();
});

test('the native patch rejects a stale lifecycle and checks backend authority at the commit', async () => {
  const { state, send } = fixture();
  const previous = state.entry.goal;
  const authority = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

  const stale = await send({ action: 'clear', lifecycleRevision: 'old-revision' });
  const revoked = await send({ action: 'clear' }, { hasCurrentClientAuthority: authority });

  expect(stale).toHaveBeenCalledWith(false, undefined, expect.objectContaining({
    code: 'INVALID_REQUEST', details: { code: SESSION_GOAL_REJECTED, reason: 'session-rebound' },
  }));
  expect(revoked).toHaveBeenCalledWith(false, undefined, expect.objectContaining({
    code: 'INVALID_REQUEST', details: { code: SESSION_GOAL_REJECTED, reason: 'forbidden' },
  }));
  expect(state.entry.goal).toEqual(previous);
});

test('the native patch leaves a Goal written by another owner untouched', async () => {
  const { state, send } = fixture();

  const respond = await send({ action: 'set', objective: 'New objective', expectedGoalId: null });

  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({
    code: 'INVALID_REQUEST', details: { code: SESSION_GOAL_REJECTED, reason: 'goal-rebound' },
  }));
  expect(state.entry.goal?.id).toBe(oldGoalId);
});

test('a mutation limited to a running turn cannot replace a Goal completed after the read', async () => {
  const { state, send } = fixture();
  const completed = { ...state.entry.goal!, status: 'complete' };
  state.entry = { ...state.entry, goal: completed };

  const respond = await send({ action: 'set', objective: completed.objective, status: 'active', allowReplacement: false });

  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({
    code: 'INVALID_REQUEST', details: { code: SESSION_GOAL_REJECTED, reason: 'busy' },
  }));
  expect(state.entry.goal).toEqual(completed);
});

test('keeps a failed native write response unknown when the commit cannot be proved', async () => {
  const { send } = fixture();
  sdk.patchSessionEntry.mockImplementationOnce(({ update }) => {
    update({ sessionId: identity.sessionId, lifecycleRevision: identity.lifecycleRevision });
    throw new Error('Native writer was lost.');
  });

  const respond = await send({ action: 'set', objective: 'New Goal', expectedGoalId: null });

  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: 'UNAVAILABLE' }));
});

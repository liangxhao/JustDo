import { expect, test, vi } from 'vitest';

const { sendToRenderer } = vi.hoisted(() => ({ sendToRenderer: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendToRenderer } }],
  },
}));

vi.mock('../../cowork/coworkLogger', () => ({
  coworkLog: vi.fn(),
}));

import { createDefaultAgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import type { GatewayClientLike, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const createPreparedSessionReceipt = (key = 'agent:main:justdo:session-1') => ({
  key,
  sessionId: 'gateway-session-1',
  entry: {
    sessionId: 'gateway-session-1',
    permissionMode: 'full',
    sessionRoot: process.cwd(),
  },
});

function createEmptyStore() {
  const session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'completed',
    pinned: false,
    cwd: process.cwd(),
    executionMode: 'local',
    permissionMode: 'full' as const,
    activeSkillIds: [],
    agentId: 'main',
    modelRef: 'openai/gpt-5',
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let persistedGoalExecution: Record<string, unknown> | null = null;
  const planHandoffs = new Map<string, Record<string, unknown>>();
  return {
    session,
    planHandoffs,
    store: {
      getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      getAgent: () => null,
      updateSession: () => {},
      getSessionRunByClientTurnId: () => undefined,
      listSessions: () => [
        {
          id: session.id,
          title: session.title,
          status: session.status,
          pinned: false,
          groupId: null,
          agentId: 'main',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      ],
      getGoalExecutionSnapshot: () => persistedGoalExecution,
      setGoalExecutionSnapshot: (snapshot: Record<string, unknown>) => {
        persistedGoalExecution = snapshot;
      },
      clearGoalExecutionSnapshot: () => {
        persistedGoalExecution = null;
      },
      createPlanHandoff: (input: Record<string, unknown>) => {
        const existing = planHandoffs.get(input.planId as string);
        if (existing) return existing;
        const handoff = {
          ...input,
          state: 'presented',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        planHandoffs.set(input.planId as string, handoff);
        return handoff;
      },
      migratePlanHandoffArtifact: (planId: string, artifact: Record<string, unknown>) => {
        const existing = planHandoffs.get(planId);
        if (!existing) throw new Error('Plan handoff not found.');
        const migrated = { ...existing, artifact, updatedAt: Date.now() };
        planHandoffs.set(planId, migrated);
        return migrated;
      },
      getPlanHandoff: (planId: string) => planHandoffs.get(planId),
      listRecoverablePlanHandoffs: () =>
        [...planHandoffs.values()].filter(handoff => handoff.state !== 'resolved'),
      transitionPlanHandoff: (input: Record<string, unknown>) => {
        const existing = planHandoffs.get(input.planId as string);
        if (!existing) throw new Error('Plan handoff not found.');
        const updated = {
          ...existing,
          state: input.nextState,
          ...(input.implementationSessionKey
            ? { implementationSessionKey: input.implementationSessionKey }
            : {}),
          ...(input.implementationGatewaySessionId
            ? { implementationGatewaySessionId: input.implementationGatewaySessionId }
            : {}),
          ...(input.implementationRunId ? { implementationRunId: input.implementationRunId } : {}),
          updatedAt: Date.now(),
        };
        planHandoffs.set(input.planId as string, updated);
        return updated;
      },
    },
  };
}

const activeRecoveryGoal = {
  schemaVersion: 1, id: 'goal-1', objective: 'Ship the release', status: 'active',
  createdAt: 1, updatedAt: 1, tokenStart: 0, tokensUsed: 0, continuationTurns: 0,
};

const createSessionTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
  sessionId: 'session-1',
  sessionKey: 'agent:main:justdo:session-1',
  runId: 'run-1',
  turnToken: 1,
  stopRequested: false,
  knownRunIds: new Set(['run-1']),
  ...overrides,
});

test('continues a goal with the canonical key that actually owns it', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const canonicalKey = 'agent:legacy:justdo:session-1';
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.describe') {
      if (params.key !== canonicalKey) return { session: null };
      return {
        session: {
          key: canonicalKey,
          goal: {
            schemaVersion: 1,
            id: 'goal-1',
            objective: 'Ship the release',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt(canonicalKey);
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn().mockResolvedValue({
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'running',
    continuationCount: 1,
    updatedAt: 1,
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    sessionIdBySessionKey: Map<string, string>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.sessionIdBySessionKey.set(canonicalKey, 'session-1');
  internals.goalContinuationCoordinator.continue = continueGoal;

  await adapter.continueGoal('session-1');

  expect(request).toHaveBeenCalledWith(
    'sessions.create',
    expect.objectContaining({ key: canonicalKey, permissionMode: 'full' }),
  );
  expect(continueGoal).toHaveBeenCalledWith('session-1', canonicalKey);
});

test('cancels a goal turn stopped while its Gateway session is being prepared', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  type SessionCreateResult = {
    sessionId: string;
    entry: { sessionId: string; permissionMode: string; sessionRoot: string };
  };
  let resolveSessionCreate: ((value: SessionCreateResult) => void) | undefined;
  const sessionCreate = new Promise<SessionCreateResult>(resolve => {
    resolveSessionCreate = resolve;
  });
  const request = vi.fn((method: string) => {
    if (method === 'sessions.create') return sessionCreate;
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
    if (method === 'sessions.abort') {
      return Promise.resolve({ ok: true, status: 'no-active-run' });
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    if (method === 'chat.send') return Promise.resolve({ runId: 'unexpected-run' });
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('sessions.create', {
      key: 'agent:main:justdo:session-1',
      cwd: process.cwd(),
      permissionMode: 'full',
    }),
  );

  await adapter.stopSession(session.id);
  resolveSessionCreate?.({
    sessionId: 'gateway-session-1',
    entry: {
      sessionId: 'gateway-session-1',
      permissionMode: 'full',
      sessionRoot: process.cwd(),
    },
  });
  await running;

  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
});

test('locally cancels a goal turn stopped before Gateway readiness', async () => {
  const { store, session } = createEmptyStore();
  const updateSession = vi.fn();
  Object.assign(store, { updateSession });
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resolveGatewayReady: (() => void) | undefined;
  const gatewayReady = new Promise<void>(resolve => {
    resolveGatewayReady = resolve;
  });
  const ensureGatewayClientReady = vi.fn(() => gatewayReady);
  const internals = adapter as unknown as {
    ensureGatewayClientReady: () => Promise<void>;
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
  };
  internals.ensureGatewayClientReady = ensureGatewayClientReady;

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => expect(ensureGatewayClientReady).toHaveBeenCalledOnce());

  await expect(adapter.stopSession(session.id)).resolves.toBeUndefined();
  resolveGatewayReady?.();
  await running;

  expect(updateSession).toHaveBeenLastCalledWith(session.id, { status: 'idle' });
});

test('refreshes a replayed Goal start receipt instead of adopting a historical run', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'chat.send') {
      return {
        operationId: params?.idempotencyKey,
        action: 'start',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        runId: params?.idempotencyKey,
        status: 'started',
        replayed: true,
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          goal: {
            schemaVersion: 1,
            id: 'goal-1',
            objective: 'Ship the release',
            status: 'complete',
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 10,
            continuationTurns: 1,
          },
        },
      };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [{ key: 'agent:main:justdo:session-1', activeRunIds: [] }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    activeTurns: Map<string, SessionTurn>;
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  await internals.runTurn(session.id, '/goal Ship the release', {});

  const goalSend = request.mock.calls.find(([method]) => method === 'chat.send')?.[1];
  expect(goalSend).toMatchObject({
    sessionKey: 'agent:main:justdo:session-1',
    sessionId: 'gateway-session-1',
    message: 'Ship the release',
    intent: {
      kind: 'session-goal-start',
      version: 1,
      issuedAtMs: expect.any(Number),
    },
    idempotencyKey: expect.any(String),
  });
  expect(goalSend).not.toHaveProperty('timeoutMs');
  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: 'agent:main:justdo:session-1',
  });
  expect(internals.activeTurns.has(session.id)).toBe(false);
});

test('resumes a blocked goal atomically through the structured Goal RPC', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const blockedGoal = {
    schemaVersion: 1 as const,
    id: 'goal-1',
    objective: 'Ship the release',
    status: 'blocked' as const,
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  let resumeRunId = '';
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal: blockedGoal,
        },
      };
    }
    if (method === 'sessions.goal.update') {
      resumeRunId = String(params?.operationId);
      return {
        operationId: params?.operationId,
        action: 'resume',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal: { ...blockedGoal, status: 'active', updatedAt: 3 },
        runId: resumeRunId,
        status: 'started',
      };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const result = await adapter.mutateSessionGoal('session-1', {
    action: 'resume',
    goalId: 'goal-1',
    note: 'Credentials are available now.',
  });

  expect(request).toHaveBeenCalledWith(
    'sessions.goal.update',
    expect.objectContaining({
      action: 'resume',
      goalId: 'goal-1',
      sessionId: 'gateway-session-1',
      note: 'Credentials are available now.',
      operationId: expect.any(String),
      issuedAtMs: expect.any(Number),
    }),
  );
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  expect(result).toMatchObject({
    goal: { status: 'active' },
    execution: { goalId: 'goal-1', phase: 'running', runId: resumeRunId },
  });
});

test('does not bind a replayed resume run to a replacement canonical goal', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const baseGoal = {
    schemaVersion: 1 as const,
    objective: 'Ship the release',
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  const pausedGoal = { ...baseGoal, id: 'goal-1', status: 'paused' as const };
  const replacementGoal = {
    ...baseGoal,
    id: 'goal-2',
    objective: 'Prepare the next release',
    status: 'active' as const,
    updatedAt: 3,
  };
  let describeCalls = 0;
  let resumeRunId = '';
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      describeCalls += 1;
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal: describeCalls === 1 ? pausedGoal : replacementGoal,
        },
      };
    }
    if (method === 'sessions.goal.update') {
      resumeRunId = String(params?.operationId);
      return {
        operationId: resumeRunId,
        action: 'resume',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        runId: resumeRunId,
        status: 'started',
        replayed: true,
      };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [{ key: 'agent:main:justdo:session-1', activeRunIds: [resumeRunId] }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.mutateSessionGoal('session-1', { action: 'resume', goalId: 'goal-1' }),
  ).resolves.toMatchObject({
    goal: { id: 'goal-2' },
    execution: { goalId: 'goal-2', phase: 'waiting' },
  });
});

test('reuses the exact Goal operation identity after an ambiguous transport failure', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const goal = {
    schemaVersion: 1 as const,
    id: 'goal-1',
    objective: 'Ship the release',
    status: 'paused' as const,
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  let updateAttempts = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal,
        },
      };
    }
    if (method === 'sessions.goal.update') {
      updateAttempts += 1;
      if (updateAttempts === 1) {
        throw Object.assign(new Error('unavailable after commit'), {
          gatewayCode: 'UNAVAILABLE',
          retryable: false,
        });
      }
      return {
        operationId: params?.operationId,
        action: 'pause',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal,
        status: 'updated',
        replayed: true,
      };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  const operation = { action: 'pause' as const, goalId: 'goal-1', note: 'Hold.' };

  await expect(adapter.mutateSessionGoal('session-1', operation)).rejects.toThrow(
    'unavailable after commit',
  );
  await expect(adapter.mutateSessionGoal('session-1', operation)).resolves.toMatchObject({
    mutation: { replayed: true },
    goal: { status: 'paused' },
  });

  const updateParams = request.mock.calls
    .filter(([method]) => method === 'sessions.goal.update')
    .map(([, params]) => params);
  expect(updateParams).toHaveLength(2);
  expect(updateParams[1]).toEqual(updateParams[0]);
});

test('retains a mismatched receipt until the original operation is reconciled', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let matchingReceipt = false;
  const goal = {
    schemaVersion: 1 as const,
    id: 'goal-1',
    objective: 'Ship the release',
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal,
        },
      };
    }
    if (method === 'sessions.goal.update' && params?.action === 'pause') {
      return {
        operationId: matchingReceipt ? params.operationId : 'wrong-operation',
        action: 'pause',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal,
        status: 'updated',
      };
    }
    if (method === 'sessions.goal.update' && params?.action === 'edit') {
      return {
        operationId: params.operationId,
        action: 'edit',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal: { ...goal, objective: String(params.objective) },
        status: 'updated',
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.mutateSessionGoal('session-1', { action: 'pause', goalId: 'goal-1' }),
  ).rejects.toThrow('mismatched goal mutation receipt');
  await expect(adapter.mutateSessionGoal('session-1', {
    action: 'edit', goalId: 'goal-1', objective: 'Ship the release safely',
  })).rejects.toThrow('mismatched goal mutation receipt');
  matchingReceipt = true;
  await expect(
    adapter.mutateSessionGoal('session-1', {
      action: 'edit',
      goalId: 'goal-1',
      objective: 'Ship the release safely',
    }),
  ).resolves.toMatchObject({ goal: { objective: 'Ship the release safely' } });

  expect(
    request.mock.calls
      .filter(([method]) => method === 'sessions.goal.update')
      .map(([, params]) => params?.action),
  ).toEqual(['pause', 'pause', 'pause', 'edit']);
  const pauses = request.mock.calls.filter(([method, params]) => method === 'sessions.goal.update' && params?.action === 'pause');
  expect(pauses[1][1]).toEqual(pauses[0][1]);
  expect(pauses[2][1]).toEqual(pauses[0][1]);
});

test('settles an ambiguous Goal operation before applying a newer action', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const baseGoal = {
    schemaVersion: 1 as const,
    id: 'goal-1',
    objective: 'Ship the release',
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  let currentGoal: typeof baseGoal & { status: 'active' | 'paused' } = {
    ...baseGoal,
    status: 'active',
  };
  let pauseParams: Record<string, unknown> | undefined;
  let pauseAttempts = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal: currentGoal,
          activeRunIds: [],
        },
      };
    }
    if (method === 'sessions.goal.update' && params?.action === 'pause') {
      pauseAttempts += 1;
      pauseParams ??= params;
      currentGoal = { ...baseGoal, status: 'paused' as const, updatedAt: 3 };
      if (pauseAttempts === 1) throw new Error('connection closed after commit');
      return {
        operationId: params.operationId,
        action: 'pause',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal: currentGoal,
        status: 'updated',
        replayed: true,
      };
    }
    if (method === 'sessions.goal.update' && params?.action === 'resume') {
      currentGoal = { ...baseGoal, status: 'active' as const, updatedAt: 4 };
      return {
        operationId: params.operationId,
        action: 'resume',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal: currentGoal,
        runId: params.operationId,
        status: 'started',
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.mutateSessionGoal('session-1', { action: 'pause', goalId: 'goal-1' }),
  ).rejects.toThrow('connection closed after commit');
  await expect(
    adapter.mutateSessionGoal('session-1', { action: 'resume', goalId: 'goal-1' }),
  ).resolves.toMatchObject({
    goal: { status: 'active' },
    execution: { phase: 'running', runId: expect.any(String) },
  });

  const updates = request.mock.calls.filter(([method]) => method === 'sessions.goal.update');
  expect(updates.map(([, params]) => params?.action)).toEqual(['pause', 'pause', 'resume']);
  expect(updates[1]?.[1]).toEqual(pauseParams);
  expect(updates[2]?.[1]?.operationId).not.toBe(pauseParams?.operationId);
});

test('refreshes a replayed clear receipt and preserves a newer canonical goal', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const oldGoal = {
    schemaVersion: 1 as const,
    id: 'goal-1',
    objective: 'Ship the release',
    status: 'complete' as const,
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 10,
    continuationTurns: 1,
  };
  const newGoal = {
    ...oldGoal,
    id: 'goal-2',
    objective: 'Prepare the next release',
    status: 'active' as const,
    updatedAt: 3,
  };
  let describeCalls = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      describeCalls += 1;
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal: describeCalls === 1 ? oldGoal : newGoal,
        },
      };
    }
    if (method === 'sessions.goal.clear') {
      return {
        operationId: params?.operationId,
        action: 'clear',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        status: 'cleared',
        replayed: true,
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.mutateSessionGoal('session-1', { action: 'clear', goalId: 'goal-1' }),
  ).resolves.toMatchObject({
    mutation: { replayed: true },
    goal: { id: 'goal-2', status: 'active' },
    execution: { goalId: 'goal-2' },
  });
  expect(describeCalls).toBe(2);
});

test('clears a completed goal before returning its objective for combined feedback', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const goal = (id: string, status: 'complete' | 'active') => ({
    schemaVersion: 1,
    id,
    objective: 'Ship the release',
    status,
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  });
  let currentGoal: ReturnType<typeof goal> | null = goal('goal-1', 'complete');
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          sessionId: 'gateway-session-1',
          goal: currentGoal,
        },
      };
    }
    if (method === 'sessions.goal.clear') {
      currentGoal = null;
      return {
        operationId: params?.operationId,
        action: 'clear',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        status: 'cleared',
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    stoppedSessions: Map<string, number>;
    manuallyStoppedSessions: Set<string>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.stoppedSessions.set('session-1', Date.now());
  internals.manuallyStoppedSessions.add('session-1');

  const [first, concurrent] = await Promise.all([
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ]);

  expect(request).toHaveBeenCalledWith(
    'sessions.goal.clear',
    expect.objectContaining({
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'gateway-session-1',
      goalId: 'goal-1',
      operationId: expect.any(String),
      issuedAtMs: expect.any(Number),
    }),
  );
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  expect(first).toEqual({ objective: 'Ship the release' });
  expect(concurrent).toEqual(first);
  expect(internals.stoppedSessions.has('session-1')).toBe(false);
  expect(internals.manuallyStoppedSessions.has('session-1')).toBe(false);
});

test('requires canonical complete metadata before replacing a goal', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const makeGoal = (id: string) => ({
    schemaVersion: 1,
    id,
    objective: 'Ship the release',
    status: 'active',
  });
  let currentGoal: ReturnType<typeof makeGoal> | null = makeGoal('goal-1');
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: { key: 'agent:main:justdo:session-1', goal: currentGoal },
      };
    }
    if (method === 'sessions.goal.clear') {
      currentGoal = null;
      return { ok: true, cleared: true, key: 'agent:main:justdo:session-1' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: {
      getSnapshot: (sessionId: string) => {
        sessionId: string;
        goalId?: string;
        phase: string;
        continuationCount: number;
        updatedAt: number;
      };
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  vi.spyOn(internals.goalContinuationCoordinator, 'getSnapshot').mockReturnValue({
    sessionId: 'session-1',
    phase: 'awaiting_confirmation',
    continuationCount: 1,
    updatedAt: 2,
  });

  await expect(adapter.restartCompletedGoalForFeedback('session-1', 'goal-1')).rejects.toThrow(
    'completed goal changed',
  );
  expect(request.mock.calls.some(([method]) => method === 'sessions.goal.clear')).toBe(false);
});

test('treats an already-cleared completed goal as prepared when the objective was persisted', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: { key: 'agent:main:justdo:session-1', goal: null },
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1', 'Ship the release'),
  ).resolves.toEqual({ objective: 'Ship the release' });
  expect(request.mock.calls.some(([method]) => method === 'sessions.goal.clear')).toBe(false);
});

test('rejects completion feedback replacement when the completed goal changed', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: {
      key: 'agent:main:justdo:session-1',
      goal: {
        schemaVersion: 1,
        id: 'different-goal',
        objective: 'Different goal',
        status: 'complete',
      },
    },
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.restartCompletedGoalForFeedback('session-1', 'goal-1')).rejects.toThrow(
    'completed goal changed',
  );
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
});

test('keeps an idle goal waiting without native settlement evidence and rechecks in the same generation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.initialGatewayGoalRecoveryPending = false;
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active' },
          },
        ],
      };
    }
    if (method === 'sessions.describe') return {
      session: { key: 'agent:main:justdo:session-1', sessionId: 'native-1', lifecycleRevision: 'rev-1',
        goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active' } },
    };
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(3);
  await internals.recoverActiveGoals(3);

  expect(continueGoal).not.toHaveBeenCalled();
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({
    phase: 'waiting', waitingReason: 'native-guard', continuationCount: 0,
  });
  expect(request.mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(2);
});

test('stops an active goal on the initial app connection instead of relaunching it', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            goal: { id: 'goal-1', status: 'active', createdAt: 100 },
          },
        ],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    initialGatewayGoalRecoveryPending: boolean;
    recoverActiveGoals: (
      generation: number,
      options?: { stopGoalsCreatedBeforeMs?: number },
    ) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(3, { stopGoalsCreatedBeforeMs: 200 });

  expect(continueGoal).not.toHaveBeenCalled();
  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-1',
    phase: 'stopped',
  });
  expect(internals.initialGatewayGoalRecoveryPending).toBe(false);
});

test('inspects a new goal after the app-start boundary without treating idle as settlement', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.describe') return {
      session: { key: 'agent:main:justdo:session-1', sessionId: 'native-1', lifecycleRevision: 'rev-1',
        goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active', createdAt: 300 } },
    };
    return {
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active', createdAt: 300 },
        },
      ],
    };
  });
  const continueGoal = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (
      generation: number,
      options?: { stopGoalsCreatedBeforeMs?: number },
    ) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(3, { stopGoalsCreatedBeforeMs: 200 });

  expect(continueGoal).not.toHaveBeenCalled();
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')?.phase).toBe('waiting');
  expect(store.getGoalExecutionSnapshot('session-1')).toBeNull();
});

test('preserves the active Gateway owner even when goal metadata predates app start', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: true,
        runId: 'run-current',
        goal: { id: 'goal-1', status: 'active', createdAt: 100 },
      },
    ],
  });
  const continueGoal = vi.fn();
  const restoreRunning = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (
      generation: number,
      options?: { stopGoalsCreatedBeforeMs?: number },
    ) => Promise<void>;
    goalContinuationCoordinator: {
      continue: typeof continueGoal;
      restoreRunning: typeof restoreRunning;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalContinuationCoordinator.continue = continueGoal;
  internals.goalContinuationCoordinator.restoreRunning = restoreRunning;

  await internals.recoverActiveGoals(3, { stopGoalsCreatedBeforeMs: 200 });

  expect(restoreRunning).toHaveBeenCalledWith('session-1', 'goal-1', 'run-current', 0);
  expect(continueGoal).not.toHaveBeenCalled();
  expect(store.getGoalExecutionSnapshot('session-1')).toBeNull();
});

test('does not auto-continue an old goal while a current-app user turn is activating', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        goal: { id: 'goal-1', status: 'active', createdAt: 100 },
      },
    ],
  });
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    goalSessionsActivatingThisApp: Set<string>;
    recoverActiveGoals: (
      generation: number,
      options?: { stopGoalsCreatedBeforeMs?: number },
    ) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalSessionsActivatingThisApp.add('session-1');
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(3, { stopGoalsCreatedBeforeMs: 200 });

  expect(continueGoal).not.toHaveBeenCalled();
  expect(store.getGoalExecutionSnapshot('session-1')).toBeNull();
});

test('persists a provisional terminal latch immediately and canonicalizes a replacement goal id', async () => {
  vi.useFakeTimers();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: {
      key: 'agent:main:justdo:session-1',
      goal: {
        schemaVersion: 1,
        id: 'goal-2',
        objective: 'Improved release',
        status: 'complete',
        createdAt: 1,
        updatedAt: 2,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 1,
      },
    },
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: {
      restoreSnapshot: (snapshot: Record<string, unknown>) => void;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  internals.goalContinuationCoordinator.restoreSnapshot({
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'awaiting_confirmation',
    runId: 'replacement-run',
    continuationCount: 1,
    updatedAt: 10,
  });

  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-1',
    identityPending: true,
  });

  await vi.runAllTimersAsync();
  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-2',
    identityPending: false,
  });
  expect(adapter.getGoalExecution('session-1')).toMatchObject({
    goalId: 'goal-2',
    identityPending: false,
  });
});

test('restores but does not duplicate a goal run already active after reconnect', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            runId: 'active-run',
            hasActiveRun: true,
            goal: { id: 'goal-1', status: 'active' },
          },
        ],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const restoreRunning = vi.fn();
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: {
      restoreRunning: typeof restoreRunning;
      continue: typeof continueGoal;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 4;
  internals.goalContinuationCoordinator.restoreRunning = restoreRunning;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(4);

  expect(restoreRunning).toHaveBeenCalledWith('session-1', 'goal-1', 'active-run', 0);
  expect(continueGoal).not.toHaveBeenCalled();
});

test.each(['paused', 'blocked', 'complete'])(
  'does not recover a %s goal after reconnect',
  async status => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:justdo:session-1',
              goal: { id: 'goal-1', status },
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const continueGoal = vi.fn();
    const internals = adapter as unknown as {
      gatewayClient: GatewayClientLike | null;
      gatewayClientGeneration: number;
      recoverActiveGoals: (generation: number) => Promise<void>;
      goalContinuationCoordinator: { continue: typeof continueGoal };
    };
    internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
    internals.gatewayClientGeneration = 5;
    internals.goalContinuationCoordinator.continue = continueGoal;

    await internals.recoverActiveGoals(5);

    expect(continueGoal).not.toHaveBeenCalled();
  },
);

test.each(['continuing', 'retrying'])(
  'keeps %s goal scheduling active without claiming a root run',
  async phase => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.gatewayClient = { request: vi.fn().mockResolvedValue({ sessions: [] }) };
    adapter.goalContinuationCoordinator.restoreSnapshot({
      sessionId: 'session-1',
      goalId: 'goal-1',
      phase,
      continuationCount: 1,
      updatedAt: Date.now(),
    });
    await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: true,
    });
    adapter.goalContinuationCoordinator.stop('session-1');
    adapter.goalContinuationCoordinator.confirmStop('session-1');
    await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
      running: false,
    });
  },
);

test('concurrent recovery polls wait until Goal lifecycle reconciliation completes', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.activeTurns.set('session-1', createSessionTurn());
  adapter.disconnectedSessionIds.add('session-1');
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.gatewayClient = {
    request: vi.fn(async method => (method === 'agent.wait' ? { runId: 'run-1', status: 'ok' } : { sessions: [] })),
  };
  let finishGoal;
  adapter.goalContinuationCoordinator.reconcileSettledRun = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishGoal = resolve;
      }),
  );
  const first = adapter.getSessionRuntimeStatus('session-1');
  await vi.waitFor(() => expect(finishGoal).toBeDefined());
  let secondSettled = false;
  const second = adapter.getSessionRuntimeStatus('session-1').then(status => {
    secondSettled = true;
    return status;
  });
  await Promise.resolve();
  expect(secondSettled).toBe(false);
  finishGoal();
  await Promise.all([first, second]);
  expect(
    adapter.gatewayClient.request.mock.calls.filter(([method]) => method === 'agent.wait'),
  ).toHaveLength(1);
});


test.each(['receipt-invalid', 'expired'])('recovers a typed %s Goal failure without silently issuing a new operation', async reason => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const goal = { schemaVersion: 1, id: 'goal-1', objective: 'Ship the release', status: 'paused',
    createdAt: 1, updatedAt: 2, tokenStart: 0, tokensUsed: 0, continuationTurns: 0 };
  let attempts = 0;
  let failInspection = false;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automationPermission.info') return { loaded: true, policyId: 'native-session-automation-permission' };
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.describe') {
      if (failInspection) throw new Error('inspection unavailable');
      return { session: { key: 'agent:main:justdo:session-1', sessionId: 'gateway-session-1', goal } };
    }
    if (method === 'sessions.goal.update') {
      if (++attempts === 1) throw Object.assign(new Error(reason), {
        gatewayCode: 'INVALID_REQUEST', details: { code: 'GOAL_OPERATION_REJECTED', reason },
      });
      return { operationId: params!.operationId, action: params!.action, sessionId: 'gateway-session-1',
        goalId: 'goal-1', goal, status: 'updated', ...(params!.action === 'pause' ? { replayed: true } : {}) };
    }
    throw new Error(method);
  });
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  await expect(adapter.mutateSessionGoal('session-1', { action: 'pause', goalId: 'goal-1' })).rejects.toThrow(reason);
  const edit = { action: 'edit', goalId: 'goal-1', objective: 'Ship safely' } as const;
  if (reason === 'expired') {
    failInspection = true;
    await expect(adapter.mutateSessionGoal('session-1', edit)).rejects.toThrow('inspection unavailable');
    expect(attempts).toBe(1);
    failInspection = false;
    await expect(adapter.mutateSessionGoal('session-1', edit)).rejects.toThrow('review the refreshed Goal');
    expect(attempts).toBe(1);
  }
  await adapter.mutateSessionGoal('session-1', edit);
  const updates = request.mock.calls.filter(([method]) => method === 'sessions.goal.update');
  if (reason === 'receipt-invalid') {
    expect(updates.map(([, params]) => params!.action)).toEqual(['pause', 'pause', 'edit']);
    expect(updates[1][1]).toEqual(updates[0][1]);
  } else {
    expect(updates.map(([, params]) => params!.action)).toEqual(['pause', 'edit']);
    expect(updates[1][1]!.operationId).not.toBe(updates[0][1]!.operationId);
    expect(sendToRenderer).toHaveBeenCalledWith('cowork:session:goalChanged', { sessionId: 'session-1' });
  }
});

test('rejects stale Goal lifecycle and tool events before Main admission can filter them', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.activeTurns.set('session-1', createSessionTurn({ gatewaySessionId: 'native-current',
    lifecycleGeneration: 'generation-current', lastAgentSeq: 0, status: 'running' }));
  adapter.goalContinuationCoordinator.restoreRunning('session-1', 'goal-1', 'run-1');
  const request = vi.fn().mockResolvedValue({});
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  for (const patch of [{ sessionId: 'native-old' }, { lifecycleGeneration: 'generation-old' }, { runId: 'old-run' }]) {
    for (const data of [{ phase: 'start' }, { phase: 'end', executionSettled: true }]) {
      adapter.handleAgentEvent('agent', { sessionKey: 'agent:main:justdo:session-1', sessionId: 'native-current',
        lifecycleGeneration: 'generation-current', runId: 'run-1', seq: 2, stream: 'lifecycle', data, ...patch });
    }
    adapter.handleAgentEvent('session.tool', { sessionKey: 'agent:main:justdo:session-1', sessionId: 'native-current',
      lifecycleGeneration: 'generation-current', runId: 'run-1', seq: 3, stream: 'tool',
      data: { phase: 'result', name: 'update_goal', toolCallId: 'call-old', args: { status: 'complete' },
        result: { status: 'updated', goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'complete' } } }, ...patch });
  }
  await Promise.resolve();
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({ phase: 'running', runId: 'run-1' });
  expect(request).not.toHaveBeenCalled();
  adapter.goalContinuationCoordinator.clear();
});


test.each([undefined, 'generation-current'])('consumes a valid late Goal completion after chat final with generation %s', async lifecycleGeneration => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const key = 'agent:main:justdo:session-1';
  const identity = { sessionKey: key, sessionId: 'native-current', lifecycleGeneration, runId: 'run-1' };
  adapter.rememberSessionKey('session-1', key);
  adapter.activeTurns.set('session-1', createSessionTurn({ gatewaySessionId: identity.sessionId,
    lifecycleGeneration: identity.lifecycleGeneration, lastAgentSeq: 0, status: 'running' }));
  adapter.goalContinuationCoordinator.restoreRunning('session-1', 'goal-1', 'run-1');
  adapter.handleAgentEvent('agent', { ...identity, seq: 1, stream: 'lifecycle', data: { phase: 'start' } });
  adapter.handleChatEvent({ ...identity, state: 'final' });
  expect(adapter.activeTurns.has('session-1')).toBe(false);
  adapter.handleAgentEvent('session.tool', { ...identity, seq: 2, stream: 'tool', data: {
    phase: 'result', name: 'update_goal', toolCallId: 'call-complete', args: { status: 'complete' },
    result: { status: 'updated', goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'complete' } },
  } });
  adapter.handleAgentEvent('agent', { ...identity, seq: 3, stream: 'lifecycle', data: { phase: 'end', executionSettled: true } });
  await Promise.resolve();
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({ phase: 'awaiting_confirmation' });
  expect(adapter.activeTurns.has('session-1')).toBe(false);
  adapter.goalContinuationCoordinator.clear();
});

test('retains an unknown automatic Goal run in Main and queries only its exact receipt', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const key = 'agent:main:justdo:session-1';
  const goal = { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active', createdAt: 1, updatedAt: 1,
    tokenStart: 0, tokensUsed: 0, continuationTurns: 0 };
  store.getConfig = () => ({ maxGoalContinuationTurns: 25 });
  adapter.prepareSession = vi.fn().mockResolvedValue({ sessionKey: key, gatewaySessionId: 'native-current' });
  let waitSettled = false;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.describe') return { session: { key, sessionId: 'native-current', goal } };
    if (method === 'agent') throw Object.assign(new Error('ACK timed out'), { code: 'CLIENT_TIMEOUT', requestSent: true });
    if (method === 'agent.wait') return { runId: params!.runId, status: waitSettled ? 'ok' : 'timeout' };
    throw new Error(method);
  });
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  const snapshot = await adapter.goalContinuationCoordinator.continue('session-1', key);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('agent.wait', { runId: snapshot.runId, timeoutMs: 0 }));
  expect(adapter.activeTurns.get('session-1')).toMatchObject({ runId: snapshot.runId, gatewaySessionId: 'native-current' });
  expect(adapter.unknownSessionRuns.get('session-1')).toMatchObject({ runId: snapshot.runId });
  adapter.handleGatewayEvent({ event: 'sessions.changed', payload: {
    reason: 'runtime', sessionKey: key,
    session: { key, sessionId: 'native-current', lastRunId: snapshot.runId,
      hasActiveRun: false, status: 'done' },
  } });
  expect(adapter.activeTurns.get('session-1')?.runId).toBe(snapshot.runId);
  expect(adapter.unknownSessionRuns.get('session-1')?.runId).toBe(snapshot.runId);
  adapter.handleChatEvent({ sessionKey: key, sessionId: 'native-current', runId: snapshot.runId,
    state: 'final' });
  expect(adapter.activeTurns.get('session-1')?.runId).toBe(snapshot.runId);
  expect(adapter.unknownSessionRuns.get('session-1')?.runId).toBe(snapshot.runId);
  await adapter.reconcileDisconnectedTurn('session-1');
  goal.status = 'complete';
  waitSettled = true;
  await adapter.reconcileDisconnectedTurn('session-1');
  expect(adapter.activeTurns.has('session-1')).toBe(false);
  expect(adapter.unknownSessionRuns.has('session-1')).toBe(false);
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')?.phase).toBe('awaiting_confirmation');
  expect(request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  adapter.cancelGoalRecovery();
  adapter.goalContinuationCoordinator.clear();
});


test('keeps cancellation pending while a continuation send is unconfirmed', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const key = 'agent:main:justdo:session-1';
  const goal = { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active',
    createdAt: 1, updatedAt: 1, tokenStart: 0, tokensUsed: 0, continuationTurns: 0 };
  store.getConfig = () => ({ maxGoalContinuationTurns: 25 });
  adapter.prepareSession = vi.fn().mockResolvedValue({ sessionKey: key, gatewaySessionId: 'native-current' });
  adapter.abortSessionAndSubagents = vi.fn().mockResolvedValue(undefined);
  let confirmSend: (() => void) | undefined;
  let terminal = false;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.describe') return { session: { key, sessionId: 'native-current', goal } };
    if (method === 'agent') {
      await new Promise<void>(resolve => { confirmSend = resolve; });
      return { runId: params!.idempotencyKey, status: 'accepted' };
    }
    if (method === 'agent.wait') return { runId: params!.runId, status: terminal ? 'ok' : 'timeout', ...(terminal ? { stopReason: 'aborted' } : {}) };
    if (method === 'sessions.abort') return { ok: true, status: 'no-active-run' };
    throw new Error(method);
  });
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  const continuing = adapter.goalContinuationCoordinator.continue('session-1', key);
  await vi.waitFor(() => expect(confirmSend).toBeDefined());
  const runId = adapter.activeTurns.get('session-1')!.runId;
  await expect(adapter.stopSession('session-1')).rejects.toThrow('unconfirmed');
  confirmSend!();
  await continuing;
  expect(adapter.unknownSessionRuns.get('session-1')).toMatchObject({ runId, cancelled: true });
  terminal = true;
  await adapter.reconcileDisconnectedTurn('session-1');
  expect(adapter.unknownSessionRuns.has('session-1')).toBe(false);
  expect(adapter.activeTurns.has('session-1')).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  adapter.goalContinuationCoordinator.clear();
});

test('forwards the full native waiting and failure classification to Goal coordination', () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const key = 'agent:main:justdo:session-1';
    adapter.rememberSessionKey('session-1', key);
    adapter.activeTurns.set('session-1', createSessionTurn({ gatewaySessionId: 'native-1' }));
    const handleLifecycle = vi.spyOn(adapter.goalContinuationCoordinator, 'handleLifecycle')
      .mockResolvedValue(undefined);
    adapter.handleAgentEvent('agent', {
      sessionKey: key, sessionId: 'native-1', runId: 'run-1', seq: 1, stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true, yielded: true, livenessState: 'paused',
        stopReason: 'end_turn', status: 'timed_out', timeoutPhase: 'tool', aborted: false,
        error: 'Timed out while waiting' },
    });
    expect(handleLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      yielded: true, livenessState: 'paused', stopReason: 'end_turn', status: 'timed_out',
      timeoutPhase: 'tool', error: 'Timed out while waiting', executionSettled: true,
    }));
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('invalidates automatic decisions synchronously when a user turn starts preparing', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.on('error', () => {});
  let rejectPreparation!: (reason: Error) => void;
  adapter.sessionRpc.waitForModelUpdate = vi.fn(() => new Promise<void>((_resolve, reject) => {
    rejectPreparation = reject;
  }));
  const invalidate = vi.spyOn(adapter.goalContinuationCoordinator, 'invalidateForUserTurn');
  const starting = adapter.runTurn('session-1', 'New user direction', {});
  expect(invalidate).toHaveBeenCalledExactlyOnceWith('session-1');
  expect(adapter.pendingTurnStarts.has('session-1')).toBe(true);
  rejectPreparation(new Error('Preparation cancelled'));
  await expect(starting).rejects.toThrow('Preparation cancelled');
  adapter.goalContinuationCoordinator.clear();
});

test('coalesces child change notifications into Goal recovery without binding them as a main run', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const recover = vi.spyOn(adapter, 'recoverActiveGoals').mockResolvedValue(undefined);
    adapter.gatewayClientGeneration = 7;
    for (let index = 0; index < 3; index++) {
      adapter.handleGatewayEvent({ event: 'sessions.changed', payload: {
        reason: 'runtime', sessionKey: 'agent:main:subagent:child-1',
        session: { key: 'agent:main:subagent:child-1', spawnedBy: 'agent:main:justdo:session-1' },
      } });
    }
    expect(adapter.activeTurns.size).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recover).toHaveBeenCalledExactlyOnceWith(7, {});
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('recovers collector-only work from the exact native predecessor without fabricating a running parent', async () => {
  const { store } = createEmptyStore();
  store.getConfig = () => ({ maxGoalContinuationTurns: 25 });
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.initialGatewayGoalRecoveryPending = false;
  const key = 'agent:main:justdo:session-1';
  let currentGoal = { ...activeRecoveryGoal };
  const described = () => ({ key, sessionId: 'native-1', lifecycleRevision: 'rev-1',
    goal: currentGoal, goalContinuation: { continuationTurns: currentGoal.continuationTurns,
      predecessor: { runId: 'settled-parent', goalId: currentGoal.id, sessionId: 'native-1',
        lifecycleRevision: 'rev-1', executionSettled: true, phase: 'end', yielded: true } } });
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.list') return { sessions: [{ ...described(),
      runId: 'settled-parent', hasActiveRun: false, hasActiveSubagentRun: true }] };
    if (method === 'sessions.describe') return { session: described() };
    if (method === 'agent') {
      currentGoal = { ...currentGoal, continuationTurns: currentGoal.continuationTurns + 1 };
      return { runId: params!.idempotencyKey, status: 'accepted', goalContinuation: {
        goalId: currentGoal.id, predecessorRunId: 'settled-parent',
        continuationTurns: currentGoal.continuationTurns, acceptedAt: Date.now() } };
    }
    throw new Error(method);
  });
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  adapter.gatewayClientGeneration = 4;
  adapter.prepareSession = vi.fn().mockResolvedValue({ sessionKey: key, gatewaySessionId: 'native-1' });
  const restoreRunning = vi.spyOn(adapter.goalContinuationCoordinator, 'restoreRunning');

  await adapter.recoverActiveGoals(4);
  await adapter.recoverActiveGoals(4);

  expect(restoreRunning).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  expect(request).toHaveBeenCalledWith('agent', expect.objectContaining({
    goalContinuation: { goalId: currentGoal.id, predecessorRunId: 'settled-parent',
      maxAutomaticContinuations: 25, automatic: true },
  }));
  const activeRun = adapter.activeTurns.get('session-1')!.runId;
  expect(activeRun).not.toBe('settled-parent');
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({
    runId: activeRun, phase: 'running', continuationCount: 1,
  });
  adapter.goalContinuationCoordinator.clear();
});

test('drops an old recovery scan after a user decision even after user preparation has finished', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let releaseList!: (value: unknown) => void;
  const request = vi.fn(() => new Promise(resolve => { releaseList = resolve; }));
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  adapter.gatewayClientGeneration = 4;
  const recovering = adapter.recoverActiveGoals(4);
  await vi.waitFor(() => expect(releaseList).toBeDefined());
  adapter.goalContinuationCoordinator.invalidateForUserTurn('session-1');
  releaseList({ sessions: [{ key: 'agent:main:justdo:session-1',
    hasActiveRun: true, runId: 'old-root', goal: activeRecoveryGoal }] });
  await recovering;
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toBeNull();
  adapter.goalContinuationCoordinator.clear();
});

test('rechecks a native change whose timer expires while the previous recovery is still reading', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    let releaseList!: (value: unknown) => void;
    let reads = 0;
    adapter.gatewayClient = { request: vi.fn(async method => {
      if (method !== 'sessions.list') throw new Error(method);
      reads += 1;
      if (reads === 1) return await new Promise(resolve => { releaseList = resolve; });
      return { sessions: [] };
    }) } as unknown as GatewayClientLike;
    adapter.gatewayClientGeneration = 4;
    const first = adapter.recoverActiveGoals(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseList).toBeDefined();
    adapter.handleGatewayEvent({ event: 'sessions.changed', payload: {
      sessionKey: 'agent:main:subagent:collector-1', reason: 'runtime',
    } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(1);
    releaseList({ sessions: [] });
    await first;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(2);
    adapter.cancelGoalRecovery();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('preserves the Stop latch while recovery still observes the parent running', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const key = 'agent:main:justdo:session-1';
  adapter.gatewayClientGeneration = 4;
  adapter.gatewayClient = { request: vi.fn(async method => method === 'sessions.list'
    ? { sessions: [{ key, hasActiveRun: true, runId: 'run-1', goal: activeRecoveryGoal }] }
    : { session: { key, sessionId: 'native-1', goal: activeRecoveryGoal } }) } as unknown as GatewayClientLike;
  adapter.rememberSessionKey('session-1', key);
  adapter.activeTurns.set('session-1', createSessionTurn({ gatewaySessionId: 'native-1' }));
  adapter.goalContinuationCoordinator.restoreSnapshot({
    sessionId: 'session-1', goalId: 'goal-1', phase: 'waiting', waitingReason: 'native-wake',
    continuationCount: 0, updatedAt: 1,
  });
  let confirmAbort!: () => void;
  adapter.abortSessionAndSubagents = vi.fn(() => new Promise<void>(resolve => { confirmAbort = resolve; }));
  const restoreRunning = vi.spyOn(adapter.goalContinuationCoordinator, 'restoreRunning');
  const stopping = adapter.stopSession('session-1');
  await vi.waitFor(() => expect(confirmAbort).toBeDefined());
  await adapter.recoverActiveGoals(4);
  expect(restoreRunning).not.toHaveBeenCalled();
  confirmAbort();
  await stopping;
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')?.phase).toBe('stopped');
  adapter.goalContinuationCoordinator.clear();
});

test('keeps the initial app cutoff when an event starts recovery without options', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, { getAppStartedAtMs: () => 200 });
    const key = 'agent:main:justdo:session-1';
    const oldGoal = { ...activeRecoveryGoal, createdAt: 100 };
    const nativeSession = { key, sessionId: 'native-1', lifecycleRevision: 'rev-1', goal: oldGoal,
      goalContinuation: { continuationTurns: 0, predecessor: {
        goalId: oldGoal.id, runId: 'settled-parent', sessionId: 'native-1',
        lifecycleRevision: 'rev-1', executionSettled: true, phase: 'end', yielded: false,
      } } };
    const request = vi.fn(async method => method === 'sessions.list'
      ? { sessions: [nativeSession] } : { session: nativeSession });
    adapter.gatewayClient = { request } as unknown as GatewayClientLike;
    adapter.gatewayClientGeneration = 4;
    adapter.handleGatewayEvent({ event: 'sessions.changed', payload: { sessionKey: key, reason: 'runtime' } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')?.phase).toBe('stopped');
    expect(request.mock.calls.some(([method]) => method === 'agent')).toBe(false);
    expect(adapter.initialGatewayGoalRecoveryPending).toBe(false);
    adapter.cancelGoalRecovery();
    adapter.goalContinuationCoordinator.clear();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('converges a yielded exact wait receipt from unknown Goal admission to Waiting', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async () => ({ runId: 'yielded-run', status: 'ok', yielded: true }));
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  adapter.registerUnknownSessionRun('session-1', 'yielded-run');
  adapter.goalContinuationCoordinator.restoreSnapshot({ sessionId: 'session-1', goalId: 'goal-1',
    runId: 'yielded-run', phase: 'running', continuationCount: 4, identityPending: true, updatedAt: 1 });
  await adapter.reconcileDisconnectedTurn('session-1');
  expect(adapter.unknownSessionRuns.has('session-1')).toBe(false);
  expect(adapter.activeTurns.has('session-1')).toBe(false);
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({
    runId: 'yielded-run', phase: 'waiting', waitingReason: 'native-wake', continuationCount: 4,
  });
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')?.identityPending).not.toBe(true);
  adapter.cancelGoalRecovery();
  adapter.goalContinuationCoordinator.clear();
});

test.each([undefined, 'generation-current'])('binds a first native Goal event with generation %s before applying its lifecycle state', lifecycleGeneration => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const key = 'agent:main:justdo:session-1';
  adapter.rememberSessionKey('session-1', key);
  adapter.activeTurns.set('session-1', createSessionTurn({ gatewaySessionId: null,
    lifecycleGeneration: null, lastAgentSeq: -1, status: 'running' }));
  adapter.handleAgentEvent('agent', { sessionKey: key, sessionId: 'native-current',
    lifecycleGeneration, runId: 'run-1', seq: 1,
    stream: 'lifecycle', data: { phase: 'start' } });
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({ phase: 'running', runId: 'run-1' });
  expect(adapter.activeTurns.get('session-1')).toMatchObject({ gatewaySessionId: 'native-current', lastAgentSeq: 1 });
  adapter.goalContinuationCoordinator.clear();
});


test('does not infer Goal run ownership from a provisional run prefix', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const key = 'agent:main:justdo:session-1';
  const runId = 'justdo-1700000000000-prepared';
  adapter.rememberSessionKey('session-1', key);
  adapter.activeTurns.set('session-1', createSessionTurn({ runId, knownRunIds: new Set([runId]),
    gatewaySessionId: 'native-current', lifecycleGeneration: 'generation-current', lastAgentSeq: 0, status: 'running' }));
  adapter.goalContinuationCoordinator.restoreRunning('session-1', 'goal-1', runId);
  const event = { sessionKey: key, sessionId: 'native-current', lifecycleGeneration: 'generation-current', runId: 'unowned-run' };
  adapter.handleAgentEvent('agent', { ...event, seq: 1, stream: 'lifecycle', data: { phase: 'start' } });
  adapter.handleChatEvent({ ...event, state: 'final' });
  expect(adapter.activeTurns.get('session-1')?.runId).toBe(runId);
  expect(adapter.goalContinuationCoordinator.getSnapshot('session-1')).toMatchObject({ phase: 'running', runId });
  adapter.goalContinuationCoordinator.clear();
});

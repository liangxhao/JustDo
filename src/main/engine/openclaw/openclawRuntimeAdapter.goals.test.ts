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

import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
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

test('releases a retained Goal operation after a definitive mismatched receipt', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
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
        operationId: 'wrong-operation',
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
  ).toEqual(['pause', 'edit']);
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

test('recovers an idle active goal after a Gateway reconnect', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            goal: { id: 'goal-1', status: 'active' },
          },
        ],
      };
    }
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

  expect(continueGoal).toHaveBeenCalledWith('session-1', 'agent:main:justdo:session-1');
  expect(continueGoal).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.some(([method]) => method === 'sessions.describe')).toBe(false);
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

test('continues a goal created after the app-start boundary', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    return {
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active', createdAt: 300 },
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

  expect(continueGoal).toHaveBeenCalledWith('session-1', 'agent:main:justdo:session-1');
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

  expect(restoreRunning).toHaveBeenCalledWith('session-1', 'goal-1', 'run-current');
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

  expect(restoreRunning).toHaveBeenCalledWith('session-1', 'goal-1', 'active-run');
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
    request: vi.fn(async method => (method === 'agent.wait' ? { status: 'ok' } : { sessions: [] })),
  };
  let finishGoal;
  adapter.goalContinuationCoordinator.handleLifecycle = vi.fn(
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

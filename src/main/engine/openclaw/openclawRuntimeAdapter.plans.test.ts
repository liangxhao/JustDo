import { createHash } from 'crypto';
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
import {
  AskUserQuestionGateway,
  CoworkInteractionIpc,
  PlanModeGateway,
} from '../../../shared/openclaw/extensions';
import { PRODUCT_NAME_LOWERCASE } from '../../../shared/productMetadata';
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

type SessionPreparationInternals = {
  gatewayClient: GatewayClientLike | null;
  ensureGatewayClientReady: () => Promise<void>;
};

const getSessionPreparationInternals = (
  adapter: OpenClawRuntimeAdapter,
): SessionPreparationInternals => adapter as unknown as SessionPreparationInternals;

const createAskUserRequest = () => ({
  requestId: 'ask_0123456789abcdef',
  questions: [
    {
      id: 'deploy_target',
      header: 'Deploy',
      question: 'Where should this be deployed?',
      options: [
        { id: 'staging', label: 'Staging' },
        { id: 'production', label: 'Production' },
      ],
      allowOther: true,
    },
  ],
  sessionKey: 'agent:main:justdo:session-1',
  waitPolicy: { mode: 'required' as const },
});

const createPlanModeRequest = () => ({
  requestId: 'plan_0123456789abcdef',
  sessionKey: 'agent:main:justdo:session-1',
  title: 'Implementation plan',
  plan: '1. Inspect\n2. Implement\n3. Verify',
});

const createApprovedPlanArtifactStore = (
  verifiedMarkdown = '1. Inspect\n2. Implement\n3. Verify',
) => ({
  publish: vi.fn(
    (input: { workspaceRoot: string; sessionId: string; planId: string; markdown: string }) => ({
      sessionId: input.sessionId,
      planId: input.planId,
      workspaceRoot: input.workspaceRoot,
      relativePath: `.${PRODUCT_NAME_LOWERCASE}/plans/${input.sessionId}/${input.planId}.md`,
      sha256: createHash('sha256').update(input.markdown.replace(/\r\n?/g, '\n')).digest('hex'),
      byteLength: Buffer.byteLength(input.markdown),
    }),
  ),
  readVerified: vi.fn(() => verifiedMarkdown),
});

const seedPresentedPlan = (
  adapter: OpenClawRuntimeAdapter,
  request: ReturnType<typeof createPlanModeRequest>,
) => {
  const internals = adapter as unknown as {
    persistAndVerifyPresentedPlan: (sessionId: string, request: unknown) => unknown;
    pendingPlanModeRequests: Map<string, unknown>;
  };
  internals.persistAndVerifyPresentedPlan('session-1', request);
  internals.pendingPlanModeRequests.set(request.requestId, request);
};

test('forwards AskUserQuestion extension events through the renderer interaction channel', () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = createAskUserRequest();

  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.REQUESTED_EVENT,
    payload: request,
  });

  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Stream, {
    sessionId: 'session-1',
    request: expect.objectContaining({
      requestId: request.requestId,
      toolName: 'AskUserQuestion',
      toolInput: expect.objectContaining({ waitPolicy: { mode: 'required' } }),
    }),
  });

  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.RESOLVED_EVENT,
    payload: { requestId: request.requestId, status: 'cancelled' },
  });
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, {
    requestId: request.requestId,
  });
});

test('resets context and starts an approved plan on the same OpenClaw session', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const verifiedPlan = 'Verified approved plan';
  const artifactStore = createApprovedPlanArtifactStore(verifiedPlan);
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  adapter.on('error', () => undefined);
  const planRequest = createPlanModeRequest();
  planRequest.plan = verifiedPlan;
  seedPresentedPlan(adapter, planRequest);
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === PlanModeGateway.RESOLVE) {
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          key: planRequest.sessionKey,
          sessionId: 'gateway-session-1',
          permissionMode: 'full',
          sessionRoot: process.cwd(),
          modelProvider: 'openai',
          model: 'gpt-5',
        },
      };
    }
    if (method === 'sessions.reset') {
      return {
        ok: true,
        key: planRequest.sessionKey,
        entry: { sessionId: 'gateway-session-1' },
      };
    }
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === 'chat.send') return { runId: 'implementation-run-1' };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const activeTurns = (adapter as unknown as { activeTurns: Map<string, SessionTurn> }).activeTurns;
  const planningTurn = createSessionTurn({ runId: 'planning-run' });
  activeTurns.set('session-1', planningTurn);
  const stopSessionInternal = vi
    .spyOn(
      adapter as unknown as {
        stopSessionInternal: (
          sessionId: string,
          options: Record<string, unknown>,
          cancelPendingStart: boolean,
        ) => Promise<void>;
      },
      'stopSessionInternal',
    )
    .mockImplementation(async sessionId => {
      activeTurns.delete(sessionId);
    });

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'implement',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(request).toHaveBeenCalledWith('sessions.reset', {
    key: planRequest.sessionKey,
    agentId: 'main',
    reason: 'reset',
  });
  expect(stopSessionInternal).toHaveBeenCalledWith('session-1', {}, false);
  expect(stopSessionInternal.mock.invocationCallOrder[0]).toBeLessThan(
    request.mock.invocationCallOrder[
      request.mock.calls.findIndex(([method]) => method === 'sessions.reset')
    ],
  );
  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      sessionKey: planRequest.sessionKey,
      message: expect.stringContaining(verifiedPlan),
      justdoHideUserMessage: true,
      idempotencyKey: `justdo-plan-implementation-${planRequest.requestId}`,
    }),
  );
  expect(request.mock.calls.filter(([method]) => method === 'sessions.create')).toHaveLength(1);
  expect(planHandoffs.get(planRequest.requestId)).toMatchObject({
    state: 'resolved',
    planningSessionKey: planRequest.sessionKey,
    implementationSessionKey: planRequest.sessionKey,
    implementationGatewaySessionId: 'gateway-session-1',
    implementationRunId: 'implementation-run-1',
  });
});

test('admits an approved plan when chat.send acknowledgement is lost but activity is observed', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(
    store,
    {},
    undefined,
    createApprovedPlanArtifactStore('Verified approved plan'),
  );
  adapter.on('error', () => undefined);
  const planRequest = createPlanModeRequest();
  planRequest.plan = 'Verified approved plan';
  seedPresentedPlan(adapter, planRequest);
  const implementationRunId = `justdo-plan-implementation-${planRequest.requestId}`;
  const request = vi.fn(async (method: string) => {
    if (method === PlanModeGateway.RESOLVE) {
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    if (method === 'sessions.describe') {
      return { session: { sessionId: 'gateway-session-1' } };
    }
    if (method === 'sessions.reset') {
      return {
        ok: true,
        key: planRequest.sessionKey,
        entry: { sessionId: 'gateway-session-1' },
      };
    }
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === 'chat.send') {
      const error = new Error('request timeout: chat.send') as Error & {
        code: string;
        requestSent: boolean;
      };
      error.code = 'CLIENT_TIMEOUT';
      error.requestSent = true;
      throw error;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const resolving = adapter.resolveAskUserInteraction(planRequest.requestId, {
    behavior: 'plan',
    decision: 'implement',
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('chat.send', expect.anything()));
  await vi.waitFor(() =>
    expect(
      (
        adapter as unknown as {
          unknownSessionRuns: Map<string, { runId: string }>;
        }
      ).unknownSessionRuns.get('session-1'),
    ).toMatchObject({ runId: implementationRunId }),
  );

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: implementationRunId,
      sessionKey: planRequest.sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  await expect(resolving).resolves.toEqual({ sessionId: 'session-1' });
  expect(planHandoffs.get(planRequest.requestId)).toMatchObject({
    state: 'resolved',
    implementationRunId,
  });
});

test('disables Plan mode before resolving an admitted implementation during recovery', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'admitted',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
    implementationGatewaySessionId: 'implementation-session-1',
    implementationRunId: 'implementation-run-1',
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  let planModeEnabled = true;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [] };
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    if (method === 'sessions.pluginPatch') {
      planModeEnabled = (params?.value as { enabled?: boolean } | undefined)?.enabled ?? true;
      return { ok: true };
    }
    if (method === PlanModeGateway.RESOLVE) {
      if (planModeEnabled) throw new Error('Disable Plan mode before approving implementation.');
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([]);

  expect(request.mock.calls.map(([method]) => method)).toEqual([
    AskUserQuestionGateway.LIST,
    PlanModeGateway.LIST,
    'sessions.pluginPatch',
    PlanModeGateway.RESOLVE,
    'sessions.pluginPatch',
  ]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
});

test('does not expose a plan approval when durable artifact publication fails', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  artifactStore.publish.mockImplementation(() => {
    throw new Error('disk full');
  });
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  const request = vi.fn().mockResolvedValue({
    requestId: planRequest.requestId,
    decision: 'cancel',
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  adapter.handleGatewayEvent({ event: PlanModeGateway.REQUESTED_EVENT, payload: planRequest });

  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith(PlanModeGateway.RESOLVE, {
      requestId: planRequest.requestId,
      decision: 'cancel',
    });
  });
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  );
});

test('persists the plan review recovery marker before exposing the side panel', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  let finishPatch!: (value: { ok: true }) => void;
  const patchPending = new Promise<{ ok: true }>(resolve => {
    finishPatch = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return patchPending;
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  adapter.handleGatewayEvent({ event: PlanModeGateway.REQUESTED_EVENT, payload: planRequest });

  await vi.waitFor(() => expect(artifactStore.publish).toHaveBeenCalledOnce());
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  );
  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: planRequest.sessionKey,
      value: expect.objectContaining({
        enabled: true,
        awaitingReview: {
          version: 1,
          requestId: planRequest.requestId,
          persistedAt: expect.any(Number),
        },
      }),
    }),
  );

  finishPatch({ ok: true });
  await vi.waitFor(() => {
    expect(sendToRenderer).toHaveBeenCalledWith(
      CoworkInteractionIpc.Stream,
      expect.objectContaining({
        request: expect.objectContaining({ requestId: planRequest.requestId }),
      }),
    );
  });
});

test('keeps a plan handoff recoverable when its rejected marker cannot be cleared', async () => {
  sendToRenderer.mockClear();
  const { store, planHandoffs } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(
    store,
    {},
    undefined,
    createApprovedPlanArtifactStore(),
  );
  const planRequest = createPlanModeRequest();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') throw new Error('state unavailable');
    if (method === PlanModeGateway.RESOLVE) {
      return { requestId: planRequest.requestId, decision: 'cancel' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  adapter.handleGatewayEvent({ event: PlanModeGateway.REQUESTED_EVENT, payload: planRequest });

  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.pluginPatch',
    PlanModeGateway.RESOLVE,
    'sessions.pluginPatch',
  ]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('presented');
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  );
});

test('rebuilds a dispatching plan approval from its verified artifact when Gateway pending is empty', async () => {
  const { store } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore('Canonical persisted plan');
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'dispatching',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST || method === PlanModeGateway.LIST) {
      return { requests: [] };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      request: expect.objectContaining({
        requestId: planRequest.requestId,
        toolInput: expect.objectContaining({ plan: 'Canonical persisted plan' }),
      }),
    }),
  ]);
  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: planRequest.sessionKey,
      value: expect.objectContaining({
        enabled: true,
        awaitingReview: expect.objectContaining({ requestId: planRequest.requestId }),
      }),
    }),
  );
});

test('restores a missing workspace plan from the matching Gateway pending request', async () => {
  const { store } = createEmptyStore();
  const planRequest = createPlanModeRequest();
  const artifactStore = createApprovedPlanArtifactStore(planRequest.plan);
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  artifactStore.publish.mockClear();
  artifactStore.readVerified
    .mockImplementationOnce(() => {
      throw new Error('missing artifact');
    })
    .mockImplementation(() => planRequest.plan);

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST) return { requests: [] };
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  ]);
  expect(artifactStore.publish).toHaveBeenCalledWith({
    workspaceRoot: process.cwd(),
    sessionId: 'session-1',
    planId: planRequest.requestId,
    markdown: planRequest.plan,
  });
});

test('keeps an admitted recovery disabled when Plan mode resolution is transiently unavailable', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'admitted',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  let resolveAttempts = 0;
  const patchedStates: Array<{ enabled?: boolean; awaitingReview?: unknown }> = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [] };
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    if (method === 'sessions.pluginPatch') {
      patchedStates.push(params?.value as { enabled?: boolean; awaitingReview?: unknown });
      return { ok: true };
    }
    if (method === PlanModeGateway.RESOLVE) {
      resolveAttempts += 1;
      if (resolveAttempts === 1) throw new Error('temporary resolve failure');
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('admitted');
  expect(patchedStates).toEqual([
    expect.objectContaining({
      enabled: false,
      awaitingReview: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  ]);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
  expect(patchedStates.every(state => state.enabled === false)).toBe(true);
  expect(patchedStates.at(-1)).not.toHaveProperty('awaitingReview');
});

test('keeps the review marker intact when revising a still-pending plan fails', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(
    store,
    {},
    undefined,
    createApprovedPlanArtifactStore(),
  );
  const planRequest = createPlanModeRequest();
  seedPresentedPlan(adapter, planRequest);
  const patchedStates: unknown[] = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.pluginPatch') {
      patchedStates.push(params?.value);
      return { ok: true };
    }
    if (method === PlanModeGateway.RESOLVE) throw new Error('temporary resolve failure');
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'revise',
      feedback: 'Keep the existing API.',
    }),
  ).rejects.toThrow('temporary resolve failure');

  expect(patchedStates).toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('presented');
});

test('locally resolves a recovered failed-plan cancellation when Gateway lost the pending request', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore('Persisted plan');
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'failed',
    transitionedAt: Date.now(),
    error: 'implementation setup failed',
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST || method === PlanModeGateway.LIST) {
      return { requests: [] };
    }
    if (method === PlanModeGateway.RESOLVE) throw new Error('request not found');
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  await adapter.listPendingAskUserInteractions();

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'cancel',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
  expect(request).toHaveBeenCalledWith(PlanModeGateway.LIST, {});
});

test('revises a recovered failed plan whose Gateway request was lost', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore('Persisted original plan');
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'failed',
    transitionedAt: Date.now(),
    error: 'implementation setup failed',
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST || method === PlanModeGateway.LIST) {
      return { requests: [] };
    }
    if (method === PlanModeGateway.RESOLVE) throw new Error('request not found');
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const startSession = vi.spyOn(adapter, 'startSession').mockResolvedValue(undefined);
  await adapter.listPendingAskUserInteractions();

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'revise',
      feedback: 'Add rollback verification.',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
  expect(startSession).toHaveBeenCalledWith(
    'session-1',
    expect.stringContaining('Add rollback verification.'),
    expect.objectContaining({
      planMode: true,
      clientTurnId: `justdo-plan-revision-${planRequest.requestId}`,
    }),
  );
  expect(startSession.mock.calls[0]?.[1]).toContain('Persisted original plan');
});

test('reads Plan mode with the closed sessions.describe request shape', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          pluginExtensions: [
            {
              pluginId: 'plan-mode',
              namespace: 'state',
              value: { enabled: true, updatedAt: 1 },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  adapter.rememberSessionKey(
    session.id,
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );

  await expect(adapter.getPlanMode(session.id)).resolves.toEqual({ enabled: true });
  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: 'agent:main:justdo:session-1',
  });
});

test('rejects a Plan mode toggle when a turn starts during Gateway readiness', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let finishReadiness: (() => void) | undefined;
  const readiness = new Promise<void>(resolve => {
    finishReadiness = resolve;
  });
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = adapter as unknown as SessionPreparationInternals & {
    pendingTurnStarts: Map<string, unknown>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn(() => readiness);

  const toggling = adapter.setPlanMode(session.id, true);
  internals.pendingTurnStarts.set(session.id, {});
  finishReadiness?.();

  await expect(toggling).rejects.toThrow('cannot be changed while the session is running');
  expect(request).not.toHaveBeenCalled();
});

test('disables Plan mode without stopping an active turn', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = adapter as unknown as SessionPreparationInternals & {
    pendingTurnStarts: Map<string, unknown>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.pendingTurnStarts.set(session.id, {});

  await expect(adapter.setPlanMode(session.id, false)).resolves.toEqual({ enabled: false });

  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: 'agent:main:justdo:session-1',
      pluginId: 'plan-mode',
      value: expect.objectContaining({ enabled: false }),
    }),
  );
});

test('writes Plan mode to the canonical JustDo key when a channel key is also known', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  adapter.rememberSessionKey(
    session.id,
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );

  await expect(adapter.setPlanMode(session.id, true)).resolves.toEqual({ enabled: true });

  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: 'agent:main:justdo:session-1',
      pluginId: 'plan-mode',
      value: expect.objectContaining({ enabled: true }),
    }),
  );
});

test('does not reopen an AskUserQuestion after its terminal event', () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = createAskUserRequest();

  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.RESOLVED_EVENT,
    payload: { requestId: request.requestId, status: 'timeout' },
  });
  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.REQUESTED_EVENT,
    payload: request,
  });

  expect(sendToRenderer).not.toHaveBeenCalled();
});

test('recovers and resolves AskUserQuestion through extension-owned Gateway RPCs', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pendingRequest = createAskUserRequest();
  const request = vi.fn(async (method: string) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [pendingRequest] };
    if (method === AskUserQuestionGateway.RESOLVE) {
      return { requestId: pendingRequest.requestId, status: 'answered' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      request: expect.objectContaining({ requestId: pendingRequest.requestId }),
    }),
  ]);
  await expect(
    adapter.resolveAskUserInteraction(pendingRequest.requestId, {
      behavior: 'submit',
      answers: { deploy_target: { selected: ['production'] } },
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });
  expect(request).toHaveBeenCalledWith(AskUserQuestionGateway.RESOLVE, {
    requestId: pendingRequest.requestId,
    behavior: 'submit',
    answers: { deploy_target: { selected: ['production'] } },
  });
});

test('isolates malformed AskUserQuestion records during pending recovery', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pendingRequest = createAskUserRequest();
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn().mockResolvedValue({ requests: [{ requestId: 'malformed' }, pendingRequest] }),
  };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      request: expect.objectContaining({ requestId: pendingRequest.requestId }),
    }),
  ]);
});

test('does not resolve an admitted handoff from a stale Gateway pending response', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  seedPresentedPlan(adapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'dispatching',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
  });
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'dispatching',
    nextState: 'admitted',
    implementationGatewaySessionId: 'gateway-session-1',
    implementationRunId: 'implementation-run-1',
    transitionedAt: Date.now(),
  });
  let resolvePlanList!: (value: unknown) => void;
  const oldClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === AskUserQuestionGateway.LIST) return Promise.resolve({ requests: [] });
      if (method === PlanModeGateway.LIST) {
        return new Promise<unknown>(resolve => {
          resolvePlanList = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }),
  };
  const newClient = { start: vi.fn(), stop: vi.fn(), request: vi.fn() };
  const internals = adapter as unknown as SessionPreparationInternals & {
    gatewayClientGeneration: number;
  };
  internals.gatewayClient = oldClient;
  internals.gatewayClientGeneration = 1;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const pending = adapter.listPendingAskUserInteractions();
  await vi.waitFor(() => expect(oldClient.request).toHaveBeenCalledWith(PlanModeGateway.LIST, {}));
  internals.gatewayClient = newClient;
  internals.gatewayClientGeneration = 2;
  resolvePlanList({ requests: [] });

  await expect(pending).resolves.toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('admitted');
});

test('persists enabled Plan mode before sending the first turn', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === 'chat.send') return { runId: 'gateway-run-1' };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: { agentId: string; planMode: boolean },
    ) => Promise<void>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = internals.runTurn(session.id, 'inspect this repository', {
    agentId: 'main',
    planMode: true,
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('chat.send', expect.anything()));

  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.pluginPatch',
    'chat.send',
  ]);
  expect(request).toHaveBeenNthCalledWith(
    1,
    'sessions.pluginPatch',
    expect.objectContaining({
      key: 'agent:main:justdo:session-1',
      pluginId: 'plan-mode',
      namespace: 'state',
      value: expect.objectContaining({ enabled: true }),
    }),
  );

  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('settles an internal managed handoff chat error without forwarding it', () => {
  const { session, store } = createEmptyStore();
  session.status = 'running';
  store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
    Object.assign(session, updates);
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const complete = vi.fn();
  const error = vi.fn();
  adapter.on('complete', complete);
  adapter.on('error', error);
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      sessionKey: 'agent:main:justdo:session-1',
      state: 'error',
      errorMessage: 'Managed subagent terminal handoff could not be persisted.',
    },
  });

  expect(session.status).toBe('idle');
  expect(complete).toHaveBeenCalledWith('session-1', 'idle');
  expect(error).not.toHaveBeenCalled();
});

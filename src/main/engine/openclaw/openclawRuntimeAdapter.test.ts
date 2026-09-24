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

import { CoworkPlanHandoffState } from '../../../shared/cowork/planHandoff';
import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
import { AskUserQuestionGateway } from '../../../shared/openclaw/extensions';
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

test('recovers an admitted same-session implementation without resetting its active run', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  seedPresentedPlan(adapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: CoworkPlanHandoffState.Presented,
    nextState: CoworkPlanHandoffState.Dispatching,
    implementationSessionKey: planRequest.sessionKey,
    transitionedAt: Date.now(),
  });

  const implementationClientTurnId = `justdo-plan-implementation-${planRequest.requestId}`;
  const activeTurns = (adapter as unknown as { activeTurns: Map<string, SessionTurn> }).activeTurns;
  activeTurns.set(
    'session-1',
    createSessionTurn({
      runId: 'implementation-run-1',
      knownRunIds: new Set([implementationClientTurnId, 'implementation-run-1']),
    }),
  );
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return { session: { sessionId: 'gateway-session-1' } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'implement',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('sessions.describe', { key: planRequest.sessionKey });
  expect(planHandoffs.get(planRequest.requestId)).toMatchObject({
    state: CoworkPlanHandoffState.Resolved,
    implementationSessionKey: planRequest.sessionKey,
    implementationGatewaySessionId: 'gateway-session-1',
    implementationRunId: 'implementation-run-1',
  });
});

test('rejects an implementation session that did not persist the inherited model', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    assertPreparedSessionEntry: (
      entry: Record<string, unknown>,
      permissionMode: string,
      workspaceRoot: string,
      expectedModelRef: string,
    ) => void;
  };

  expect(() =>
    internals.assertPreparedSessionEntry(
      {
        permissionMode: 'full',
        sessionRoot: process.cwd(),
        providerOverride: 'anthropic',
        modelOverride: 'claude-sonnet-4',
      },
      'full',
      process.cwd(),
      'openai/gpt-5',
    ),
  ).toThrow('did not persist the requested session model');
});

test('does not authorize requests returned by a stale Gateway reconciliation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pendingRequest = createAskUserRequest();
  let resolveList!: (value: unknown) => void;
  const oldClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(
      () =>
        new Promise<unknown>(resolve => {
          resolveList = resolve;
        }),
    ),
  };
  const newClient = { start: vi.fn(), stop: vi.fn(), request: vi.fn() };
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    reconcilePendingAskUserInteractions: (generation: number) => Promise<void>;
  };
  internals.gatewayClient = oldClient;
  internals.gatewayClientGeneration = 1;

  const reconciliation = internals.reconcilePendingAskUserInteractions(1);
  internals.gatewayClient = newClient;
  internals.gatewayClientGeneration = 2;
  resolveList({ requests: [pendingRequest] });
  await reconciliation;

  await expect(
    adapter.resolveAskUserInteraction(pendingRequest.requestId, { behavior: 'cancel' }),
  ).rejects.toThrow('not an active JustDo AskUserQuestion interaction');
  expect(newClient.request).not.toHaveBeenCalled();
});

test('rejects forged answers before calling the extension resolve RPC', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pendingRequest = createAskUserRequest();
  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.REQUESTED_EVENT,
    payload: pendingRequest,
  });
  const request = vi.fn();
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(
    adapter.resolveAskUserInteraction(pendingRequest.requestId, {
      behavior: 'submit',
      answers: { deploy_target: { selected: ['forged'] } },
    }),
  ).rejects.toThrow('do not match the pending question');
  expect(request).not.toHaveBeenCalled();
});

test('forwards private untrusted context from startSession to the Gateway payload', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'chat.send') return { runId: 'gateway-run-1' };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = adapter.startSession(session.id, 'describe this page', {
    agentId: 'main',
    untrustedContext: '# Chrome tabs:\n- Current title: "Example"',
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('chat.send', expect.anything()));

  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      message: 'describe this page',
      justdoUntrustedContext: '# Chrome tabs:\n- Current title: "Example"',
    }),
  );

  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('sends image-only turns without inventing user text', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'chat.send') return { runId: 'gateway-run-1' };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = adapter.startSession(session.id, '', {
    agentId: 'main',
    attachments: [{ name: 'image.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }],
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('chat.send', expect.anything()));

  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      message: '',
      attachments: [
        { type: 'image', fileName: 'image.png', mimeType: 'image/png', content: 'aGVsbG8=' },
      ],
    }),
  );

  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('binds a new session receipt to the Gateway acknowledged root run', async () => {
  const { store, session } = createEmptyStore();
  const timing = {
    id: 'timing-1',
    sessionId: session.id,
    clientTurnId: 'client-turn-1',
    rootRunId: 'client-turn-1',
    startedAt: 1_000,
    state: 'running' as const,
  };
  const bindSessionRunRootRun = vi.fn().mockReturnValue({
    ...timing,
    rootRunId: 'gateway-run-1',
  });
  Object.assign(store, {
    getSessionRunByClientTurnId: vi.fn().mockReturnValue(timing),
    bindSessionRunRootRun,
  });
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ runId: 'gateway-run-1' });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: { clientTurnId: string },
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

  const running = internals.runTurn(session.id, 'hello', {
    clientTurnId: 'client-turn-1',
  });
  await vi.waitFor(() => {
    expect(bindSessionRunRootRun).toHaveBeenCalledWith('timing-1', 'gateway-run-1');
  });
  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('cleans a pending turn without leaking a rejection when chat.send fails', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.on('error', vi.fn());
  const request = vi.fn((method: string) => {
    if (method === 'chat.send') return Promise.reject(new Error('send failed'));
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    pendingTurns: Map<string, unknown>;
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  await expect(internals.runTurn(session.id, 'hello', {})).rejects.toThrow('send failed');

  expect(internals.pendingTurns.has(session.id)).toBe(false);
  expect(internals.activeTurns.has(session.id)).toBe(false);
});

test('reports preparation failures before an active turn is created', async () => {
  const { store, session } = createEmptyStore();
  const updateSession = vi.fn((_sessionId: string, updates: Record<string, unknown>) => {
    Object.assign(session, updates);
  });
  Object.assign(store, { updateSession });
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const error = vi.fn();
  adapter.on('error', error);
  (
    adapter as unknown as {
      sessionRpc: { waitForModelUpdate: () => Promise<void> };
    }
  ).sessionRpc = {
    waitForModelUpdate: vi.fn().mockRejectedValue(new Error('model update failed')),
  };

  await expect(adapter.startSession(session.id, 'hello')).rejects.toThrow('model update failed');

  expect(updateSession).toHaveBeenCalledWith(session.id, { status: 'error' });
  expect(error).toHaveBeenCalledWith(session.id, 'model update failed');
  expect(adapter.isSessionActive(session.id)).toBe(false);
});

test('recovers a managed session ID when the in-memory session-key mapping is missing', () => {
  const { store } = createEmptyStore();
  const getSession = vi.spyOn(store, 'getSession');
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    sessionIdBySessionKey: Map<string, string>;
    resolveSessionIdBySessionKey: (sessionKey: string) => string | null;
  };
  const sessionKey = 'agent:main:justdo:session-1';

  expect(internals.sessionIdBySessionKey.size).toBe(0);
  expect(internals.resolveSessionIdBySessionKey(sessionKey)).toBe('session-1');
  expect(internals.sessionIdBySessionKey.get(sessionKey)).toBe('session-1');
  expect(getSession).toHaveBeenCalledWith('session-1');

  getSession.mockClear();
  expect(internals.resolveSessionIdBySessionKey(sessionKey)).toBe('session-1');
  expect(getSession).not.toHaveBeenCalled();

  expect(internals.resolveSessionIdBySessionKey('agent:main:justdo:missing')).toBeNull();
  expect(internals.resolveSessionIdBySessionKey('agent:other:justdo:session-1')).toBeNull();
});

test('keeps a managed parent turn alive during an incremental-join refill gap', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const turn = createSessionTurn();
  const collectRunningSubagentSessionKeys = vi.fn().mockResolvedValue([]);
  const startTurnTimeoutWatchdog = vi.fn();
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    collectRunningSubagentSessionKeys: typeof collectRunningSubagentSessionKeys;
    startTurnTimeoutWatchdog: typeof startTurnTimeoutWatchdog;
    handleTurnTimeoutWatchdog: (sessionId: string, turn: SessionTurn) => Promise<void>;
  };
  internals.activeTurns.set(turn.sessionId, turn);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(),
  };
  internals.collectRunningSubagentSessionKeys = collectRunningSubagentSessionKeys;
  internals.startTurnTimeoutWatchdog = startTurnTimeoutWatchdog;

  await internals.handleTurnTimeoutWatchdog(turn.sessionId, turn);

  expect(collectRunningSubagentSessionKeys).toHaveBeenCalledWith(internals.gatewayClient, [
    turn.sessionKey,
  ]);
  expect(startTurnTimeoutWatchdog).toHaveBeenCalledWith(turn.sessionId);
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
});

test('does not schedule a local watchdog when the Agent run limit is unlimited', () => {
  const { store } = createEmptyStore();
  const runtimeSettings = createDefaultAgentRuntimeSettings();
  runtimeSettings.agent.runTimeoutSeconds = 0;
  store.getAgentRuntimeSettings = () => runtimeSettings;
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const turn = createSessionTurn();
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    startTurnTimeoutWatchdog: (sessionId: string) => void;
  };
  internals.activeTurns.set(turn.sessionId, turn);

  internals.startTurnTimeoutWatchdog(turn.sessionId);

  expect(setTimeoutSpy).not.toHaveBeenCalled();
});

test('publishes completion when a non-managed turn reaches its local watchdog', async () => {
  const { session, store } = createEmptyStore();
  session.status = 'running';
  store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
    Object.assign(session, updates);
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const complete = vi.fn();
  adapter.on('complete', complete);
  const turn = createSessionTurn({ sessionKey: 'agent:main:discord:channel-1' });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    handleTurnTimeoutWatchdog: (sessionId: string, turn: SessionTurn) => Promise<void>;
  };
  internals.activeTurns.set(turn.sessionId, turn);

  await internals.handleTurnTimeoutWatchdog(turn.sessionId, turn);

  expect(adapter.isSessionActive(turn.sessionId)).toBe(false);
  expect(session.status).toBe('idle');
  expect(complete).toHaveBeenCalledWith(turn.sessionId, 'idle');
});

test('publishes Workboard revision invalidations without projecting card data', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const listener = vi.fn();
  adapter.on('workboardChanged', listener);

  adapter.handleGatewayEvent({
    event: 'plugin.workboard.changed',
    payload: { epoch: 'epoch-1', revision: 7 },
  });

  expect(listener).toHaveBeenCalledWith({ epoch: 'epoch-1', revision: 7 });
});

test('getSessionKeysForSession prefers channel keys before managed fallback', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.rememberSessionKey(
    'session-1',
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');

  expect(adapter.getSessionKeysForSession('session-1')).toEqual([
    'agent:main:openai-user:telegram:__default__:2459325231940374',
    'agent:main:justdo:session-1',
  ]);
});

test('getSessionRuntimeStatus only treats the main session as running', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: false,
        status: 'completed',
        runState: 'idle',
      },
      {
        key: 'agent:main:subagent:child-run',
        hasActiveRun: true,
        status: 'running',
        runState: 'active',
      },
    ],
  });

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('sessions.list', {
    limit: 500,
  });
});

test('getSessionRuntimeStatuses shares one Gateway snapshot across concurrent callers', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resolveRequest: ((value: { sessions: [] }) => void) | undefined;
  const request = vi.fn(
    () =>
      new Promise<{ sessions: [] }>(resolve => {
        resolveRequest = resolve;
      }),
  );
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  const first = adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true });
  const second = adapter.getSessionRuntimeStatus('session-2', { includeSubagents: true });
  expect(request).toHaveBeenCalledTimes(1);
  resolveRequest?.({ sessions: [] });

  await expect(Promise.all([first, second])).resolves.toEqual([
    { known: true, mainRunning: false, subagentRunning: false, running: false },
    { known: true, mainRunning: false, subagentRunning: false, running: false },
  ]);
});

test('getSessionRuntimeStatus stays unknown when a truncated snapshot omits the session', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ sessions: [], hasMore: true });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: false,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
});

test('getSessionRuntimeStatus remains authoritative for rows present in a truncated snapshot', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: false,
        status: 'completed',
      },
    ],
    hasMore: true,
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
});

test('scans beyond an inferred 500-row boundary before reporting a parent idle', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    if (params?.offset === 500) {
      return {
        sessions: [
          {
            key: 'agent:main:subagent:child',
            spawnedBy: 'agent:main:justdo:session-1',
            hasActiveRun: true,
            status: 'running',
          },
          ...Array.from({ length: 18 }, (_, index) => ({
            key: `agent:main:subagent:second-page-filler-${index}`,
            status: 'completed',
          })),
        ],
      };
    }
    return {
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: false,
          status: 'completed',
        },
        ...Array.from({ length: 499 }, (_, index) => ({
          key: `agent:main:subagent:first-page-filler-${index}`,
          status: 'completed',
        })),
      ],
    };
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toMatchObject({ known: false, running: false });
  await expect(
    adapter.getSessionRuntimeStatus('session-1', {
      includeSubagents: true,
      forceRefresh: true,
      fullScan: true,
    }),
  ).resolves.toMatchObject({
    known: true,
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
  expect(request).toHaveBeenCalledWith('sessions.list', { limit: 500, offset: 500 });
});

test('sessions.changed invalidates the cached runtime snapshot', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: true,
          status: 'running',
        },
      ],
    })
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: false,
          status: 'completed',
        },
      ],
    });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    handleSessionsChangedEvent: (payload: unknown) => void;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    running: true,
  });
  internals.handleSessionsChangedEvent({
    key: 'agent:main:justdo:session-1',
    hasActiveRun: false,
    status: 'completed',
  });

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(2);
});

test('sessions.changed prevents an in-flight runtime snapshot from becoming authoritative', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  let resolveFirstRequest:
    ((value: { sessions: Array<Record<string, unknown>> }) => void) | undefined;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<{ sessions: Array<Record<string, unknown>> }>(resolve => {
          resolveFirstRequest = resolve;
        }),
    )
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: false,
          status: 'completed',
        },
      ],
    });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    handleSessionsChangedEvent: (payload: unknown) => void;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;

  const staleStatus = adapter.getSessionRuntimeStatus('session-1');
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  internals.handleSessionsChangedEvent({ key: 'agent:main:justdo:session-1' });
  resolveFirstRequest?.({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: true,
        status: 'running',
      },
    ],
  });

  await expect(staleStatus).resolves.toMatchObject({ known: false });
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    known: true,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(2);
});

test('getSessionRuntimeStatus can bypass a cached running snapshot after completion', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: true,
          status: 'running',
        },
      ],
    })
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: false,
          status: 'completed',
        },
      ],
    });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    running: true,
  });
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    running: true,
  });
  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(2);
});

test('getSessionRuntimeStatus reports unknown when the Gateway snapshot fails', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockRejectedValue(new Error('request timeout'));
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: false,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(1);
});

test('adopts a replayed resume run only while Gateway still reports that exact run active', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pausedGoal = {
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
  const activeGoal = { ...pausedGoal, status: 'active' as const, updatedAt: 3 };
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
          goal: describeCalls === 1 ? pausedGoal : activeGoal,
        },
      };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [{ key: 'agent:main:justdo:session-1', activeRunIds: [resumeRunId] }],
      };
    }
    if (method === 'sessions.goal.update') {
      resumeRunId = String(params?.operationId);
      return {
        operationId: params?.operationId,
        action: 'resume',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        goal: activeGoal,
        runId: resumeRunId,
        status: 'started',
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
    adapter.mutateSessionGoal('session-1', { action: 'resume', goalId: 'goal-1' }),
  ).resolves.toMatchObject({
    mutation: { replayed: true, status: 'started', runId: expect.any(String) },
    goal: { status: 'active' },
    execution: { phase: 'running', runId: expect.any(String) },
  });
  expect(resumeRunId).not.toBe('');
});

test('does not clear active metadata based on a stale local completion latch', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let describeCount = 0;
  let cleared = false;
  const makeGoal = (id: string, status: 'complete' | 'active') => ({
    schemaVersion: 1,
    id,
    objective: 'Ship the release',
    status,
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      describeCount += 1;
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: cleared ? null : makeGoal('goal-1', 'active'),
        },
      };
    }
    if (method === 'sessions.goal.clear') {
      cleared = true;
      return { ok: true, cleared: true, key: 'agent:main:justdo:session-1' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: { getSnapshot: (sessionId: string) => unknown };
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
  expect(describeCount).toBe(4);
  expect(request.mock.calls.some(([method]) => method === 'sessions.goal.clear')).toBe(false);
});

test('falls back to sessions.describe when the recovery session list is truncated', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.list') return { sessions: [], hasMore: true };
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active' },
        },
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
  internals.gatewayClientGeneration = 4;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(4);

  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: 'agent:main:justdo:session-1',
  });
  expect(continueGoal).toHaveBeenCalledOnce();
});

test('restores a persisted completed execution instead of auto-running stale active metadata', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  store.setGoalExecutionSnapshot({
    sessionId: 'session-1',
    phase: 'awaiting_confirmation',
    continuationCount: 1,
    updatedAt: 10,
    identityPending: true,
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            goal: { id: 'goal-1', objective: 'Ship the release', status: 'active' },
          },
        ],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn();
  const restoreSnapshot = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: {
      continue: typeof continueGoal;
      restoreSnapshot: typeof restoreSnapshot;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 8;
  internals.goalContinuationCoordinator.continue = continueGoal;
  internals.goalContinuationCoordinator.restoreSnapshot = restoreSnapshot;

  await internals.recoverActiveGoals(8);

  expect(restoreSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'awaiting_confirmation' }),
  );
  expect(continueGoal).not.toHaveBeenCalled();
});

test('chat delta without run id is ignored while a turn is active', () => {
  const session = {
    id: 'session-1',
    title: 'Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  const store = {
    getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      state: 'delta',
      message: { role: 'assistant', content: 'unowned partial' },
    },
  });

  expect(session.messages).toHaveLength(0);
});

test('patchSessionModel applies immediately to subsequent calls while session is active', async () => {
  const session = {
    id: 'session-1',
    title: 'Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
    agentId: 'main',
  };
  const store = {
    getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const patchSessionModel = vi.fn().mockResolvedValue({
    ok: true,
    modelRef: 'bailian/qwen3.6-plus',
    appliesTo: 'subsequent-calls',
    source: 'gateway',
  });
  (
    adapter as unknown as {
      sessionRpc: { patchModel: typeof patchSessionModel };
    }
  ).sessionRpc = { patchModel: patchSessionModel };

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');
  const result = await adapter.patchSessionModel('session-1', 'bailian/qwen3.6-plus');

  expect(result).toEqual({
    ok: true,
    modelRef: 'bailian/qwen3.6-plus',
    appliesTo: 'subsequent-calls',
    source: 'gateway',
  });
  expect(patchSessionModel).toHaveBeenCalledWith(
    'session-1',
    'bailian/qwen3.6-plus',
    undefined,
    'subsequent-calls',
  );
});

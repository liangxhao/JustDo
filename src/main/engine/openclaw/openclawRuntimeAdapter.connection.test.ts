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
import type { GatewayClientCtor, GatewayClientLike, SessionTurn } from '../gateway/types';
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

test.each([
  Object.assign(new Error('request timed out'), { code: 'CLIENT_TIMEOUT', requestSent: true }),
  new Error('gateway closed (1006): lost connection'),
])('retains a sent turn for authoritative recovery after $message', async failure => {
  const { store, session } = createEmptyStore();
  const update = vi.spyOn(store, 'updateSession');
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const errors = vi.fn();
  adapter.on('error', errors);
  const request = vi.fn(async (method: string) => {
    if (method === 'chat.send') throw failure;
    return {};
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    disconnectedSessionIds: Set<string>;
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (sessionId: string, prompt: string, options: object) => Promise<void>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });
  const running = internals.runTurn(session.id, 'hello', {});
  await vi.waitFor(() => expect(internals.disconnectedSessionIds.has(session.id)).toBe(true));
  expect(internals.activeTurns.has(session.id)).toBe(true);
  expect(update).not.toHaveBeenCalledWith(session.id, { status: 'error' });
  expect(errors).not.toHaveBeenCalled();
  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('resolves the Gateway session ID used by title generation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        sessionId: 'gateway-session-123',
      },
    ],
  });
  const internals = adapter as unknown as {
    ensureGatewayClientReady: () => Promise<void>;
    gatewayClient: GatewayClientLike | null;
    resolveGatewaySessionIdForTitle: (sessionId: string) => Promise<string | undefined>;
  };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(internals.resolveGatewaySessionIdForTitle('session-1')).resolves.toBe(
    'gateway-session-123',
  );
  expect(request).toHaveBeenCalledWith('sessions.list', { limit: 500 });
});

test('an intentionally stopped gateway client cannot reclaim the active connection', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const stop = vi.fn();
  const workboardChanged = vi.fn();
  adapter.on('workboardChanged', workboardChanged);
  let clientOptions: Record<string, unknown> | null = null;

  class FakeGatewayClient {
    constructor(options: Record<string, unknown>) {
      clientOptions = options;
    }

    start() {}

    stop() {
      stop();
    }

    async request() {
      return {};
    }
  }

  const connectionAdapter = adapter as unknown as {
    createGatewayClient(connection: {
      url: string;
      token: string;
      version: string;
      clientEntryPath: string;
    }): Promise<void>;
    disconnectGatewayClient(): void;
    gatewayClient: GatewayClientLike | null;
    pendingGatewayClient: GatewayClientLike | null;
    loadGatewayClientCtor: ReturnType<typeof vi.fn>;
  };
  connectionAdapter.loadGatewayClientCtor = vi
    .fn()
    .mockResolvedValue(FakeGatewayClient as unknown as GatewayClientCtor);

  await connectionAdapter.createGatewayClient({
    url: 'ws://127.0.0.1:12345',
    token: 'token',
    version: 'runtime-version',
    clientEntryPath: 'gateway-client.js',
  });

  const onHelloOk = clientOptions?.onHelloOk;
  expect(typeof onHelloOk).toBe('function');
  expect(clientOptions?.deviceIdentity).toBeNull();
  expect(clientOptions?.scopes).toEqual([
    'operator.admin',
    'operator.read',
    'operator.write',
    'operator.approvals',
    'operator.questions',
  ]);
  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).not.toBeNull();
  expect(connectionAdapter.pendingGatewayClient).toBeNull();
  expect(workboardChanged).toHaveBeenCalledOnce();
  expect(workboardChanged).toHaveBeenCalledWith({});

  connectionAdapter.disconnectGatewayClient();
  expect(connectionAdapter.gatewayClient).toBeNull();

  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).toBeNull();
  expect(workboardChanged).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledTimes(2);
});

test('reconnectGateway preserves the retry loop when the immediate handshake fails', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const reconnectError = new Error('handshake failed');
  const internals = adapter as unknown as {
    stopGatewayClient: () => void;
    ensureGatewayClientReady: () => Promise<void>;
    scheduleGatewayReconnect: () => void;
  };
  internals.stopGatewayClient = vi.fn();
  internals.ensureGatewayClientReady = vi.fn().mockRejectedValue(reconnectError);
  internals.scheduleGatewayReconnect = vi.fn();

  await expect(adapter.reconnectGateway()).rejects.toBe(reconnectError);

  expect(internals.stopGatewayClient).toHaveBeenCalledOnce();
  expect(internals.scheduleGatewayReconnect).toHaveBeenCalledOnce();
});

test('reconnectGateway resets reconnect backoff after a successful handshake', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    gatewayReconnectAttempt: number;
    stopGatewayClient: () => void;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayReconnectAttempt = 4;
  internals.stopGatewayClient = vi.fn();
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await adapter.reconnectGateway();

  expect(internals.gatewayReconnectAttempt).toBe(0);
});

test('Gateway reconnect scheduling keeps only one cancellable timer', () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const internals = adapter as unknown as {
      gatewayReconnectAttempt: number;
      scheduleGatewayReconnect: () => void;
    };

    internals.scheduleGatewayReconnect();
    internals.scheduleGatewayReconnect();

    expect(internals.gatewayReconnectAttempt).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    adapter.disconnectGatewayClient();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('ensureGatewayClientReady reuses an already connected Gateway client', async () => {
  const { store } = createEmptyStore();
  const startGateway = vi.fn();
  const adapter = new OpenClawRuntimeAdapter(store, { startGateway } as never);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = {
    request: vi.fn().mockResolvedValue({
      loaded: true,
      policyId: 'native-session-automation-permission',
    }),
  } as unknown as GatewayClientLike;

  await internals.ensureGatewayClientReady();

  expect(startGateway).not.toHaveBeenCalled();
});

test('keeps the initial cutoff pending when the Gateway generation changes mid-scan', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let goalCreatedAt = 300;
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            goal: { id: 'goal-1', status: 'active', createdAt: goalCreatedAt },
          },
        ],
      };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  let releaseContinue: (() => void) | undefined;
  const continueGoal = vi.fn(
    () =>
      new Promise<void>(resolve => {
        releaseContinue = resolve;
      }),
  );
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

  const staleRecovery = internals.recoverActiveGoals(3, { stopGoalsCreatedBeforeMs: 200 });
  await vi.waitFor(() => expect(continueGoal).toHaveBeenCalledOnce());
  goalCreatedAt = 100;
  internals.gatewayClientGeneration = 4;
  releaseContinue?.();
  await staleRecovery;

  expect(internals.initialGatewayGoalRecoveryPending).toBe(true);

  await internals.recoverActiveGoals(4, { stopGoalsCreatedBeforeMs: 200 });

  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-1',
    phase: 'stopped',
  });
  expect(internals.initialGatewayGoalRecoveryPending).toBe(false);
});

test('keeps scheduling Gateway reconnects after the former attempt limit', async () => {
  vi.useFakeTimers();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const attemptGatewayReconnect = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayReconnectAttempt: number;
    scheduleGatewayReconnect: () => void;
    attemptGatewayReconnect: typeof attemptGatewayReconnect;
  };
  internals.gatewayReconnectAttempt = 20;
  internals.attemptGatewayReconnect = attemptGatewayReconnect;

  internals.scheduleGatewayReconnect();
  await vi.advanceTimersByTimeAsync(30_000);

  expect(attemptGatewayReconnect).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test.each([
  { status: 'ok', expected: 'idle' },
  { status: 'error', expected: 'error' },
  { status: 'timeout', endedAt: 123, expected: 'error' },
])(
  'recovers a disconnected run from the authoritative $status terminal result',
  async ({ status, endedAt, expected }) => {
    const { store } = createEmptyStore();
    store.updateSession = vi.fn();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.on('error', vi.fn());
    adapter.activeTurns.set('session-1', createSessionTurn());
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.disconnectedSessionIds.add('session-1');
    const request = vi.fn(async method =>
      method === 'agent.wait'
        ? { runId: 'run-1', status, endedAt }
        : method === 'sessions.describe'
          ? { session: { key: 'agent:main:justdo:session-1', goal: null } }
          : { sessions: [] },
    );
    adapter.gatewayClient = { request };
    await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
      known: true,
      running: false,
    });
    expect(request).toHaveBeenCalledWith('agent.wait', { runId: 'run-1', timeoutMs: 0 });
    expect(store.updateSession).toHaveBeenCalledWith('session-1', { status: expected });
    expect(adapter.activeTurns.has('session-1')).toBe(false);
  },
);

test('an unexpected Gateway close preserves execution identity without publishing a business failure', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    store.updateSession = vi.fn();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const error = vi.fn();
    adapter.on('error', error);
    let options;
    class FakeClient {
      constructor(value) {
        options = value;
      }
      start() {}
      stop() {}
      async request() {
        return {};
      }
    }
    adapter.loadGatewayClientCtor = vi.fn().mockResolvedValue(FakeClient);
    adapter.handleGatewayReady = vi.fn().mockResolvedValue(undefined);
    adapter.reconcilePendingApprovals = vi.fn().mockResolvedValue(undefined);
    adapter.reconcilePendingAskUserInteractions = vi.fn().mockResolvedValue(undefined);
    await adapter.createGatewayClient({
      url: 'ws://127.0.0.1:1234',
      token: '',
      version: 'test',
      clientEntryPath: 'test.js',
    });
    options.onHelloOk();
    const turn = createSessionTurn();
    const reject = vi.fn();
    adapter.activeTurns.set('session-1', turn);
    adapter.pendingTurns.set('session-1', { resolve: vi.fn(), reject });
    options.onClose(1006, 'network interrupted');
    expect(adapter.activeTurns.get('session-1')).toBe(turn);
    expect(adapter.disconnectedSessionIds.has('session-1')).toBe(true);
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    adapter.disconnectGatewayClient();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

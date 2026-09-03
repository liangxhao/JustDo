import { expect, test, vi } from 'vitest';

const { sendToRenderer } = vi.hoisted(() => ({ sendToRenderer: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: sendToRenderer } },
    ],
  },
}));

vi.mock('../../cowork/coworkLogger', () => ({
  coworkLog: vi.fn(),
}));

import {
  ApprovalDecision,
  ApprovalKind,
  ExecApprovalDecision,
  OpenClawApprovalIpc,
} from '../../../shared/openclaw/approvals';
import { OPENCLAW_COMPACTION_TIMEOUT_SECONDS } from '../../openclaw/config/openclawConfigSync';
import type { GatewayClientCtor, GatewayClientLike, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const COMPACTION_WATCHDOG_MS = OPENCLAW_COMPACTION_TIMEOUT_SECONDS * 1_000 + 60_000;

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
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let persistedGoalExecution: Record<string, unknown> | null = null;

  return {
    session,
    store: {
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      getAgent: () => null,
      updateSession: () => {},
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

test('prepares the native OpenClaw session root and permission mode', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const workspace = process.cwd();
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    return {
      key: 'agent:main:justdo:session-1',
      sessionId: 'gateway-session-1',
      entry: {
        sessionId: 'gateway-session-1',
        permissionMode: 'workspace',
        sessionRoot: workspace,
      },
    };
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(
    adapter.prepareSession('session-1', {
      permissionMode: 'auto',
      workspaceRoot: workspace,
      agentId: 'main',
    }),
  ).resolves.toEqual({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('sessions.create', {
    key: 'agent:main:justdo:session-1',
    cwd: workspace,
    permissionMode: 'workspace',
  });
});

test('rejects a session response that did not persist the permission mode', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    return {
      sessionId: 'gateway-session-1',
      entry: {
        sessionId: 'gateway-session-1',
        permissionMode: 'guarded',
        sessionRoot: process.cwd(),
      },
    };
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.prepareSession('session-1', { permissionMode: 'full' })).rejects.toThrow(
    'did not persist the requested session permission mode',
  );
});

test('refuses to prepare a turn when the automation permission policy is unavailable', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockRejectedValue(new Error('method not found'));
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureAutomationPermissionPolicyReady: () => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await expect(internals.ensureAutomationPermissionPolicyReady()).rejects.toThrow(
    'method not found',
  );
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('automationPermission.info');
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

test('stops an acknowledged turn with the Gateway root run before lifecycle events arrive', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn((method: string) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'gateway-run-1' });
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') {
      return Promise.resolve({ ok: true, status: 'aborted' });
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
    ) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = internals.runTurn(session.id, 'hello', {});
  await vi.waitFor(() => {
    expect(internals.activeTurns.get(session.id)?.runId).toBe('gateway-run-1');
  });

  await adapter.stopSession(session.id);
  await running;

  expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: 'agent:main:justdo:session-1',
    runId: 'gateway-run-1',
  });
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
  const collectRunningSubagentSessionKeys = vi
    .fn()
    .mockResolvedValue([]);
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

test('keeps a managed parent turn alive when watchdog subagent inspection fails', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const turn = createSessionTurn();
  const collectRunningSubagentSessionKeys = vi.fn().mockRejectedValue(new Error('offline'));
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

  expect(startTurnTimeoutWatchdog).toHaveBeenCalledWith(turn.sessionId);
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
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

test('returns raw gateway history without projecting message fields', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const messages = [
    {
      role: 'assistant',
      model: 'hdp/MiniMax-M2.7',
      content: [
        { type: 'thinking', thinking: 'Inspect first.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'result.txt' } },
      ],
      futureGatewayField: { retained: true },
    },
  ];
  const request = vi.fn().mockResolvedValue({ messages });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.fetchSessionHistoryByKey('agent:main:cron:job-1:run:1'),
  ).resolves.toEqual({
    sessionKey: 'agent:main:cron:job-1:run:1',
    messages,
  });
});

test('loads every gateway history page in oldest-first order', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    expect(method).toBe('chat.history');
    if (params?.offset === 2) {
      return { messages: ['oldest'], hasMore: false };
    }
    return { messages: ['newer-1', 'newer-2'], hasMore: true, nextOffset: 2 };
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:cron:job-1:run:1')).resolves.toEqual({
    sessionKey: 'agent:main:cron:job-1:run:1',
    messages: ['oldest', 'newer-1', 'newer-2'],
  });
  expect(request).toHaveBeenNthCalledWith(1, 'chat.history', {
    sessionKey: 'agent:main:cron:job-1:run:1',
    limit: 1000,
  });
  expect(request).toHaveBeenNthCalledWith(2, 'chat.history', {
    sessionKey: 'agent:main:cron:job-1:run:1',
    limit: 1000,
    offset: 2,
  });
});

test('rejects a non-advancing gateway history cursor instead of looping', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    messages: ['newest'],
    hasMore: true,
    nextOffset: 0,
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.fetchSessionHistoryByKey('agent:main:cron:job-1:run:1'),
  ).resolves.toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

type StopTestAdapter = {
  activeTurns: Map<string, SessionTurn>;
  gatewayClient: GatewayClientLike | null;
  goalContinuationCoordinator: { rollbackStop: (sessionId: string) => void };
  ensureGatewayClientReady: () => Promise<void>;
  reconcilePendingApprovals: () => Promise<void>;
  approvalReconciliation: { events: unknown[] } | null;
};

test('publishes native cron changes for scheduled-task reconciliation', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const listener = vi.fn();
  adapter.on('cronChanged', listener);

  adapter.handleGatewayEvent({ event: 'cron', payload: { action: 'added', jobId: 'job-1' } });

  expect(listener).toHaveBeenCalledWith({ action: 'added', jobId: 'job-1' });
});

test.each(['sessionKey', 'childSessionKey', 'ownerKey'] as const)(
  'publishes native task changes matched by %s for the owning JustDo session',
  sessionKeyField => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const listener = vi.fn();
    adapter.on('taskChanged', listener);

    adapter.handleGatewayEvent({
      event: 'task',
      payload: {
        action: 'upserted',
        task: {
          id: 'task-1',
          status: 'running',
          runtime: 'subagent',
          [sessionKeyField]: 'agent:main:justdo:session-1',
        },
      },
    });

    expect(listener).toHaveBeenCalledWith({ sessionId: 'session-1' });
  },
);

test.each([
  { action: 'deleted', taskId: 'task-1' },
  { action: 'restored' },
])('globally invalidates in-flight task snapshots for $action events', payload => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const listener = vi.fn();
  adapter.on('taskChanged', listener);
  const internals = adapter as unknown as {
    subagentStatusRefreshes: Map<string, Promise<unknown>>;
    subagentDetailCache: Map<string, unknown>;
  };
  internals.subagentStatusRefreshes.set(session.id, Promise.resolve([]));
  internals.subagentDetailCache.set(session.id, {});

  adapter.handleGatewayEvent({ event: 'task', payload });

  expect(internals.subagentStatusRefreshes.has(session.id)).toBe(false);
  expect(internals.subagentDetailCache.has(session.id)).toBe(false);
  expect(listener).toHaveBeenCalledWith({});
});

test('publishes task changes to every related managed session', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-2', 'agent:main:justdo:session-2');
  const listener = vi.fn();
  adapter.on('taskChanged', listener);

  adapter.handleGatewayEvent({
    event: 'task',
    payload: {
      action: 'upserted',
      task: {
        id: 'shared-task',
        status: 'running',
        runtime: 'subagent',
        sessionKey: 'agent:main:justdo:session-1',
        ownerKey: 'agent:main:justdo:session-2',
      },
    },
  });

  expect(listener).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledWith({ sessionId: 'session-1' });
  expect(listener).toHaveBeenCalledWith({ sessionId: 'session-2' });
});

test.each([
  ['exec.approval.resolved', OpenClawApprovalIpc.Resolved, ApprovalKind.Exec],
  ['plugin.approval.requested', OpenClawApprovalIpc.Requested, ApprovalKind.Plugin],
  ['plugin.approval.resolved', OpenClawApprovalIpc.Resolved, ApprovalKind.Plugin],
] as const)('forwards %s to the typed renderer approval channel', (event, channel, kind) => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.handleGatewayEvent({ event, payload: { id: 'approval-1' } });

  return vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(channel, { id: 'approval-1', kind }),
  );
});

test('forwards unmatched exec approval requests to the renderer', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { id: 'approval-1', request: { command: 'git status' } },
  });

  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(OpenClawApprovalIpc.Requested, {
      id: 'approval-1',
      kind: ApprovalKind.Exec,
      request: { command: 'git status' },
    }),
  );
});

test('does not auto-approve cron-shaped exec or plugin approval requests', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(() => Promise.resolve({}));
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: {
      id: 'approval-cron-exec',
      request: {
        command: 'npm test',
        agentId: 'main',
        sessionKey: 'agent:main:cron:job-1:run:run-1',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'plugin.approval.requested',
    payload: {
      id: 'approval-third-party',
      request: {
        pluginId: 'third-party-plugin',
        title: 'Publish',
        description: 'external side effect',
        agentId: 'main',
        sessionKey: 'agent:main:cron:job-1:run:run-1',
      },
    },
  });

  await vi.waitFor(() => {
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-cron-exec', kind: ApprovalKind.Exec }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-third-party', kind: ApprovalKind.Plugin }),
    );
  });
  expect(request).not.toHaveBeenCalledWith(
    expect.stringMatching(/approval\.resolve$/),
    expect.anything(),
  );
});

test('reuses an exact command grant only in the approved session', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const approvedRequest = {
    id: 'approval-1',
    request: {
      command: 'git status',
      commandArgv: ['git', 'status'],
      cwd: 'E:/workspace/project',
      host: 'gateway',
      agentId: 'main',
      sessionKey: 'agent:main:justdo:session-1',
      security: 'allowlist',
      ask: 'on-miss',
    },
    createdAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  };
  const request = vi.fn((method: string) => {
    if (method === 'exec.approval.list') return Promise.resolve([approvedRequest]);
    return Promise.resolve({});
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  (
    adapter as unknown as { ensureGatewayClientReady: () => Promise<void> }
  ).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await adapter.resolveApproval(
    approvedRequest.id,
    ApprovalDecision.AllowForSession,
    ApprovalKind.Exec,
  );
  const repeatedRequest = { ...approvedRequest, id: 'approval-2' };
  adapter.handleGatewayEvent({ event: 'exec.approval.requested', payload: repeatedRequest });

  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-2',
      decision: ExecApprovalDecision.AllowOnce,
    }),
  );
  expect(request).not.toHaveBeenCalledWith('exec.approval.resolve', {
    id: expect.any(String),
    decision: ExecApprovalDecision.AllowAlways,
  });
  expect(sendToRenderer).not.toHaveBeenCalled();

  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: {
      ...repeatedRequest,
      id: 'approval-3',
      request: {
        ...repeatedRequest.request,
        sessionKey: 'agent:main:justdo:session-2',
      },
    },
  });

  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-3', kind: ApprovalKind.Exec }),
    ),
  );

  sendToRenderer.mockClear();
  adapter.handleGatewayEvent({
    event: 'sessions.changed',
    payload: { sessionKey: approvedRequest.request.sessionKey, reason: 'reset' },
  });
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { ...approvedRequest, id: 'approval-4' },
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-4', kind: ApprovalKind.Exec }),
    ),
  );
});

test('commits a session grant only after Gateway confirms the current request', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const approvedRequest = {
    id: 'approval-race-1',
    request: {
      command: 'git status',
      commandArgv: ['git', 'status'],
      sessionKey: 'agent:main:justdo:session-race',
    },
    createdAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  };
  let confirmResolve: (() => void) | undefined;
  const resolving = new Promise<void>(resolve => {
    confirmResolve = resolve;
  });
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === 'exec.approval.list') return Promise.resolve([approvedRequest]);
    if (
      method === 'exec.approval.resolve' &&
      (params as { id?: string } | undefined)?.id === approvedRequest.id
    ) {
      return resolving;
    }
    return Promise.resolve({});
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  (
    adapter as unknown as { ensureGatewayClientReady: () => Promise<void> }
  ).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const approving = adapter.resolveApproval(
    approvedRequest.id,
    ApprovalDecision.AllowForSession,
    ApprovalKind.Exec,
  );
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: approvedRequest.id,
      decision: ExecApprovalDecision.AllowOnce,
    }),
  );
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { ...approvedRequest, id: 'approval-race-2' },
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-race-2' }),
    ),
  );

  confirmResolve?.();
  await approving;
  sendToRenderer.mockClear();
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { ...approvedRequest, id: 'approval-race-3' },
  });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-race-3',
      decision: ExecApprovalDecision.AllowOnce,
    }),
  );
  expect(sendToRenderer).not.toHaveBeenCalled();
});

test('waits for Gateway confirmation before clearing a stopped session', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);

  let confirmAbort: ((value: Record<string, unknown>) => void) | undefined;
  const abortResponse = new Promise<Record<string, unknown>>(resolve => {
    confirmAbort = resolve;
  });
  const request = vi.fn((method: string) => {
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') return abortResponse;
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const stopping = adapter.stopSession(turn.sessionId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey,
    runId: turn.runId,
  }));
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);

  confirmAbort?.({ ok: true, status: 'aborted', abortedRunId: turn.runId });
  await stopping;

  expect(internals.activeTurns.has(turn.sessionId)).toBe(false);
});

test('coalesces concurrent stops for the same session', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  let confirmAbort: ((value: Record<string, unknown>) => void) | undefined;
  const abortResponse = new Promise<Record<string, unknown>>(resolve => {
    confirmAbort = resolve;
  });
  const request = vi.fn((method: string) => {
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') return abortResponse;
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const first = adapter.stopSession(turn.sessionId);
  const second = adapter.stopSession(turn.sessionId);
  await vi.waitFor(() => {
    expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toHaveLength(1);
  });
  confirmAbort?.({ ok: true, status: 'aborted', abortedRunId: turn.runId });

  await Promise.all([first, second]);
  expect(internals.activeTurns.has(turn.sessionId)).toBe(false);
});

test('denies only approvals belonging to a stopped session after abort confirmation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  let execTargetPending = true;
  let pluginTargetPending = true;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') return Promise.resolve({ ok: true, status: 'aborted' });
    if (method === 'exec.approval.list') {
      return Promise.resolve([
        ...(execTargetPending
          ? [{
              id: 'exec-target',
              request: { command: 'npm test', sessionKey: turn.sessionKey },
              createdAtMs: 1,
              expiresAtMs: Number.MAX_SAFE_INTEGER,
            }]
          : []),
        {
          id: 'exec-other',
          request: { command: 'npm run build', sessionKey: 'agent:main:justdo:session-2' },
          createdAtMs: 2,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      ]);
    }
    if (method === 'plugin.approval.list') {
      return Promise.resolve(pluginTargetPending ? [
        {
          id: 'plugin-target',
          request: {
            title: 'Write',
            description: 'write a file',
            sessionKey: turn.sessionKey,
          },
          createdAtMs: 3,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      ] : []);
    }
    if (method === 'exec.approval.resolve') {
      execTargetPending = false;
      return Promise.reject(new Error('approval already resolved'));
    }
    if (method === 'plugin.approval.resolve') pluginTargetPending = false;
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await adapter.stopSession(turn.sessionId);

  expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
    id: 'exec-target',
    decision: 'deny-justdo-stop',
  });
  expect(request).toHaveBeenCalledWith('plugin.approval.resolve', {
    id: 'plugin-target',
    decision: ExecApprovalDecision.Deny,
  });
  expect(request).not.toHaveBeenCalledWith(
    'exec.approval.resolve',
    expect.objectContaining({ id: 'exec-other' }),
  );
  const methods = request.mock.calls.map(([method]) => method);
  expect(methods.indexOf('sessions.abort')).toBeLessThan(methods.indexOf('exec.approval.list'));
});

test('broadcasts an authoritative pending approval snapshot during reconciliation', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const approval = {
    id: 'approval-snapshot',
    request: { command: 'git status', sessionKey: 'agent:main:justdo:session-1' },
    createdAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === 'exec.approval.list') return Promise.resolve([approval]);
      if (method === 'plugin.approval.list') return Promise.resolve([]);
      return Promise.resolve({});
    }),
  };

  await internals.reconcilePendingApprovals();

  expect(sendToRenderer).toHaveBeenCalledWith(OpenClawApprovalIpc.Snapshot, [
    { ...approval, kind: ApprovalKind.Exec },
  ]);
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    OpenClawApprovalIpc.Requested,
    expect.anything(),
  );
});

test('replays an approval requested during reconciliation after the snapshot', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  let resolveExecList: ((requests: unknown[]) => void) | undefined;
  const execList = new Promise<unknown[]>(resolve => {
    resolveExecList = resolve;
  });
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === 'exec.approval.list') return execList;
      if (method === 'plugin.approval.list') return Promise.resolve([]);
      return Promise.resolve({});
    }),
  };

  const reconciling = internals.reconcilePendingApprovals();
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: {
      id: 'approval-during-list',
      request: { command: 'git status' },
      createdAtMs: 2,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    },
  });
  await vi.waitFor(() => expect(internals.approvalReconciliation?.events).toHaveLength(1));
  resolveExecList?.([]);
  await reconciling;

  expect(sendToRenderer.mock.calls).toEqual([
    [OpenClawApprovalIpc.Snapshot, []],
    [
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-during-list', kind: ApprovalKind.Exec }),
    ],
  ]);
});

test('preserves local running state when Gateway does not confirm the stop', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
      return Promise.reject(new Error('abort unavailable'));
    }),
  };
  const stopped = vi.fn();
  const rollbackStop = vi.spyOn(internals.goalContinuationCoordinator, 'rollbackStop');
  adapter.on('sessionStopped', stopped);

  await expect(adapter.stopSession(turn.sessionId)).rejects.toThrow('abort unavailable');

  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
  expect(turn.stopRequested).toBe(false);
  expect(rollbackStop).toHaveBeenCalledWith(turn.sessionId);
  expect(stopped).not.toHaveBeenCalled();
});

test('stops a recovered active descendant through an idle child session', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const parentKey = 'agent:main:justdo:session-1';
  const childKey = `${parentKey}:subagent:child`;
  const grandchildKey = `${childKey}:subagent:grandchild`;
  const request = vi.fn((method: string, params?: unknown) => {
    const input = params as { sessionKey?: string };
    if (method === 'tasks.list') {
      if (input.sessionKey === parentKey) {
        return Promise.resolve({
          tasks: [
            {
              id: 'child-task',
              runtime: 'subagent',
              status: 'completed',
              childSessionKey: childKey,
            },
          ],
        });
      }
      if (input.sessionKey === childKey) {
        return Promise.resolve({
          tasks: [
            {
              id: 'grandchild-task',
              runtime: 'subagent',
              status: 'running',
              childSessionKey: grandchildKey,
            },
          ],
        });
      }
      return Promise.resolve({ tasks: [] });
    }
    if (method === 'sessions.abort') {
      return Promise.resolve({ ok: true, status: 'aborted', abortedRunId: 'remote-run' });
    }
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await adapter.stopSession('session-1');

  const abortedKeys = request.mock.calls
    .filter(([method]) => method === 'sessions.abort')
    .map(([, params]) => (params as { key: string }).key);
  expect(abortedKeys).toEqual([parentKey, grandchildKey]);
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
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
    ) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.create', {
    key: 'agent:main:justdo:session-1',
    cwd: process.cwd(),
    permissionMode: 'full',
  }));

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

test('does not let a cancelled preparation clean up a newer turn', async () => {
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
  let sessionCreateCount = 0;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.create') {
      sessionCreateCount += 1;
      return sessionCreateCount === 1
        ? sessionCreate
        : Promise.resolve({
            sessionId: 'new-gateway-session',
            entry: {
              sessionId: 'new-gateway-session',
              permissionMode: 'full',
              sessionRoot: process.cwd(),
            },
          });
    }
    if (method === 'chat.send') return Promise.resolve({ runId: 'new-gateway-run' });
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') {
      return Promise.resolve({ ok: true, status: 'no-active-run' });
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
    ) => Promise<void>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const oldTurn = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => {
    expect(request.mock.calls.some(([method]) => method === 'sessions.create')).toBe(true);
  });
  await adapter.stopSession(session.id);

  const newTurn = internals.runTurn(session.id, 'continue with a normal message', {});
  await vi.waitFor(() => {
    expect(internals.activeTurns.get(session.id)?.runId).toBe('new-gateway-run');
  });
  resolveSessionCreate?.({
    sessionId: 'old-gateway-session',
    entry: {
      sessionId: 'old-gateway-session',
      permissionMode: 'full',
      sessionRoot: process.cwd(),
    },
  });
  await oldTurn;

  expect(internals.activeTurns.get(session.id)?.runId).toBe('new-gateway-run');
  internals.resolveTurn(session.id);
  await newTurn;
  internals.cleanupSessionTurn(session.id);
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
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
    ) => Promise<void>;
  };
  internals.ensureGatewayClientReady = ensureGatewayClientReady;

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => expect(ensureGatewayClientReady).toHaveBeenCalledOnce());

  await expect(adapter.stopSession(session.id)).resolves.toBeUndefined();
  resolveGatewayReady?.();
  await running;

  expect(updateSession).toHaveBeenLastCalledWith(session.id, { status: 'idle' });
});

test('aborts an older active turn while a new turn is resolving its conflict', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const oldTurn = createSessionTurn();
  let resolveConflict: (() => void) | undefined;
  const conflict = new Promise<void>(resolve => {
    resolveConflict = resolve;
  });
  const resolveActiveTurnConflict = vi.fn(() => conflict);
  const request = vi.fn((method: string) => {
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') {
      return Promise.resolve({ ok: true, status: 'aborted' });
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    resolveActiveTurnConflict: (sessionId: string) => Promise<void>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
    ) => Promise<void>;
  };
  internals.activeTurns.set(session.id, oldTurn);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.resolveActiveTurnConflict = resolveActiveTurnConflict;

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => expect(resolveActiveTurnConflict).toHaveBeenCalledWith(session.id));

  await adapter.stopSession(session.id);
  resolveConflict?.();
  await running;

  expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: oldTurn.sessionKey,
    runId: oldTurn.runId,
  });
});

test('re-aborts a goal turn stopped while chat.send is being accepted', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resolveChatSend: ((value: { runId: string }) => void) | undefined;
  const chatSend = new Promise<{ runId: string }>(resolve => {
    resolveChatSend = resolve;
  });
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === 'sessions.create') {
      return Promise.resolve({ sessionId: 'gateway-session-1' });
    }
    if (method === 'chat.send') return chatSend;
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') {
      const runId = (params as { runId?: string } | undefined)?.runId;
      return runId === 'gateway-run-1'
        ? Promise.resolve({ ok: true, status: 'aborted' })
        : Promise.reject(new Error('pre-ack abort unavailable'));
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
    ) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({ message: '/goal Ship the release' }),
  ));

  let stopSettled = false;
  const stopping = adapter.stopSession(session.id).then(() => {
    stopSettled = true;
  });
  await vi.waitFor(() => {
    expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toHaveLength(1);
  });
  expect(stopSettled).toBe(false);

  resolveChatSend?.({ runId: 'gateway-run-1' });
  await Promise.all([running, stopping]);

  const abortCalls = request.mock.calls.filter(([method]) => method === 'sessions.abort');
  expect(abortCalls).toHaveLength(2);
  expect(abortCalls[1]?.[1]).toEqual({
    key: 'agent:main:justdo:session-1',
    runId: 'gateway-run-1',
  });
});

test('keeps a turn active when its post-ack abort cannot be confirmed', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resolveChatSend: ((value: { runId: string }) => void) | undefined;
  const chatSend = new Promise<{ runId: string }>(resolve => {
    resolveChatSend = resolve;
  });
  let abortCount = 0;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.create') {
      return Promise.resolve({ sessionId: 'gateway-session-1' });
    }
    if (method === 'chat.send') return chatSend;
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') {
      abortCount += 1;
      return abortCount === 1
        ? Promise.resolve({ ok: true, status: 'no-active-run' })
        : Promise.reject(new Error('post-ack abort unavailable'));
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
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

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => {
    expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(true);
  });

  const stopping = adapter.stopSession(session.id);
  const stopAssertion = expect(stopping).rejects.toThrow('post-ack abort unavailable');
  await vi.waitFor(() => expect(abortCount).toBe(1));
  resolveChatSend?.({ runId: 'gateway-run-1' });
  await stopAssertion;

  expect(internals.activeTurns.get(session.id)?.stopRequested).toBe(false);
  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('does not report success when chat.send rejects and a key abort cannot be confirmed', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let rejectChatSend: ((error: Error) => void) | undefined;
  const chatSend = new Promise<never>((_resolve, reject) => {
    rejectChatSend = reject;
  });
  let abortCount = 0;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.create') {
      return Promise.resolve({ sessionId: 'gateway-session-1' });
    }
    if (method === 'chat.send') return chatSend;
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') {
      abortCount += 1;
      return abortCount === 1
        ? Promise.resolve({ ok: true, status: 'no-active-run' })
        : Promise.reject(new Error('key abort unavailable'));
    }
    if (method === 'exec.approval.list' || method === 'plugin.approval.list') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: Record<string, never>,
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

  const running = internals.runTurn(session.id, '/goal Ship the release', {});
  await vi.waitFor(() => {
    expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(true);
  });

  const stopping = adapter.stopSession(session.id);
  const stopAssertion = expect(stopping).rejects.toThrow('key abort unavailable');
  await vi.waitFor(() => expect(abortCount).toBe(1));
  rejectChatSend?.(new Error('chat.send response lost'));
  await stopAssertion;

  expect(internals.activeTurns.get(session.id)?.stopRequested).toBe(false);
  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('an intentionally stopped gateway client cannot reclaim the active connection', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const stop = vi.fn();
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
  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).not.toBeNull();
  expect(connectionAdapter.pendingGatewayClient).toBeNull();

  connectionAdapter.disconnectGatewayClient();
  expect(connectionAdapter.gatewayClient).toBeNull();

  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).toBeNull();
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

test('getSessionRuntimeStatus can include subagent running state on request', async () => {
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
        spawnedBy: 'agent:main:justdo:session-1',
        hasActiveSubagentRun: true,
        status: 'running',
        subagentRunState: 'active',
      },
    ],
  });

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('sessions.list', { limit: 500 });
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

test('does not require descendant coverage once a truncated snapshot proves the parent is active', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: true,
        status: 'running',
      },
    ],
    hasMore: true,
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toMatchObject({
    known: true,
    mainRunning: true,
    running: true,
  });
  expect(request).toHaveBeenCalledTimes(1);
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
    | ((value: { sessions: Array<Record<string, unknown>> }) => void)
    | undefined;
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

test('resumes a blocked goal through a control run before user input', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resumed = false;
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: {
            schemaVersion: 1,
            id: 'goal-1',
            objective: 'Ship the release',
            status: resumed ? 'active' : 'blocked',
          },
        },
      };
    }
    if (method === 'chat.send') {
      resumed = true;
      return { runId: 'resume-run', status: 'ok' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  const registerControlRun = vi.fn();
  const unregisterControlRun = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: {
      registerControlRun: typeof registerControlRun;
      unregisterControlRun: (runId: string) => void;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.goalContinuationCoordinator.registerControlRun = registerControlRun;
  internals.goalContinuationCoordinator.unregisterControlRun = unregisterControlRun;

  await adapter.resumeGoalForUserInput('session-1');

  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({ message: '/goal resume', justdoUserInitiated: true }),
  );
  expect(registerControlRun).toHaveBeenCalled();
  expect(request.mock.calls.at(-1)?.[0]).toBe('sessions.describe');
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
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: currentGoal,
        },
      };
    }
    if (method === 'sessions.goal.clear') {
      currentGoal = null;
      return { ok: true, cleared: true, key: 'agent:main:justdo:session-1' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as { gatewayClient: GatewayClientLike | null };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const [first, concurrent] = await Promise.all([
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ]);

  expect(request).toHaveBeenCalledWith(
    'sessions.goal.clear',
    { key: 'agent:main:justdo:session-1' },
  );
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  expect(first).toEqual({ objective: 'Ship the release' });
  expect(concurrent).toEqual(first);
});

test('accepts active metadata while completion is already latched', async () => {
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

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).resolves.toEqual({ objective: 'Ship the release' });
  expect(describeCount).toBe(2);
});

test('prepares a goal when completion is latched but metadata was reverted to active', async () => {
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

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).resolves.toEqual({ objective: 'Ship the release' });
  expect(request).toHaveBeenCalledWith(
    'sessions.goal.clear',
    { key: 'agent:main:justdo:session-1' },
  );
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

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).rejects.toThrow('completed goal changed');
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
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active' },
        }],
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
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active', createdAt: 100 },
        }],
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
      sessions: [{
        key: 'agent:main:justdo:session-1',
        goal: { id: 'goal-1', status: 'active', createdAt: 300 },
      }],
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
    sessions: [{
      key: 'agent:main:justdo:session-1',
      hasActiveRun: true,
      runId: 'run-current',
      goal: { id: 'goal-1', status: 'active', createdAt: 100 },
    }],
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
    sessions: [{
      key: 'agent:main:justdo:session-1',
      goal: { id: 'goal-1', status: 'active', createdAt: 100 },
    }],
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
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active', createdAt: goalCreatedAt },
        }],
      };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  let releaseContinue: (() => void) | undefined;
  const continueGoal = vi.fn(
    () => new Promise<void>(resolve => {
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
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', objective: 'Ship the release', status: 'active' },
        }],
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

test('does not recover a resumed blocked goal before user input is accepted', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active' },
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalsAwaitingResumeInput: Map<string, string>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 6;
  internals.goalsAwaitingResumeInput.set('session-1', 'goal-1');
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(6);

  expect(continueGoal).not.toHaveBeenCalled();
});

test('clears pending goal-input markers on the first direct renderer user run', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const activity = vi.fn();
  adapter.on('activity', activity);
  const internals = adapter as unknown as {
    goalsAwaitingResumeInput: Map<string, string>;
  };
  internals.goalsAwaitingResumeInput.set('session-1', 'goal-2');
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'child-run',
      sessionKey: 'agent:main:justdo:session-1',
      spawnedBy: 'parent-run',
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  expect(internals.goalsAwaitingResumeInput.has('session-1')).toBe(true);

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'renderer-user-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  expect(internals.goalsAwaitingResumeInput.has('session-1')).toBe(false);
  expect(activity).toHaveBeenCalledWith('session-1', 'user', expect.any(Number));
});

test.each(['paused', 'blocked', 'complete'])('does not recover a %s goal after reconnect', async status => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status },
        }],
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

test('getSessionRuntimeStatus treats a pending subagent as active', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        status: 'completed',
      },
      {
        key: 'agent:main:subagent:queued-child',
        spawnedBy: 'agent:main:justdo:session-1',
        status: 'pending',
        subagentRunState: 'pending',
        hasActiveSubagentRun: true,
      },
    ],
  });

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
});

test('getSessionRuntimeStatus treats manual context compaction as locally running', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: sessionKey,
        hasActiveRun: false,
        status: 'completed',
        runState: 'idle',
      },
    ],
  });
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: true,
    mainRunning: true,
    subagentRunning: false,
    running: true,
  });
  expect(request).not.toHaveBeenCalled();

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'end', sessionKey },
  });

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledOnce();
});

test.each(['error', 'failed'])('clears manual context compaction on %s', async phase => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ sessions: [] });
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });
  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase, sessionKey },
  });

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toMatchObject({ mainRunning: false, running: false });
});

test('expires manual context compaction when its terminal event is lost', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const sessionKey = 'agent:main:justdo:session-1';
    const request = vi.fn().mockResolvedValue({ sessions: [] });
    adapter.rememberSessionKey('session-1', sessionKey);
    (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
      request,
    } as unknown as GatewayClientLike;

    adapter.handleGatewayEvent({
      event: 'session.operation',
      payload: { operation: 'compact', phase: 'start', sessionKey },
    });
    await vi.advanceTimersByTimeAsync(COMPACTION_WATCHDOG_MS);

    await expect(
      adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
    ).resolves.toMatchObject({ mainRunning: false, running: false });
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test('clears manual context compaction when Gateway state is cleaned up', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ sessions: [] });
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });
  (
    adapter as unknown as { cleanupGatewayClientState: () => void }
  ).cleanupGatewayClientState();

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toMatchObject({ mainRunning: false, running: false });
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

test('lifecycle end clears the active turn when chat final is missing', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });

    vi.advanceTimersByTime(1499);
    expect(adapter.isSessionActive('session-1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('idle');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('session-1', 'idle');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('chat final cancels the lifecycle end fallback', () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'chat',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        state: 'final',
        message: { role: 'assistant', content: 'done' },
      },
    });

    vi.advanceTimersByTime(1500);
    expect(complete).toHaveBeenCalledOnce();
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('does not reopen a terminal run when Gateway replays late events', () => {
  const { session, store } = createEmptyStore();
  session.status = 'running';
  store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
    Object.assign(session, updates);
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const activity = vi.fn();
  const complete = vi.fn();
  const handleLifecycle = vi.spyOn(
    (
      adapter as unknown as {
        goalContinuationCoordinator: { handleLifecycle: (event: unknown) => Promise<void> };
      }
    ).goalContinuationCoordinator,
    'handleLifecycle',
  );
  adapter.on('activity', activity);
  adapter.on('complete', complete);
  const sessionKey = 'agent:main:justdo:session-1';
  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.ensureActiveTurn('session-1', sessionKey, 'run-1');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: 'done' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      sessionKey,
      state: 'delta',
      message: { role: 'assistant', content: 'late' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'run-1',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'run-1',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });

  expect(adapter.isSessionActive('session-1')).toBe(false);
  expect(activity).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
  expect(handleLifecycle).toHaveBeenCalledWith(expect.objectContaining({ phase: 'end' }));
  expect(session.status).toBe('idle');
});

test('does not reopen a terminal turn through its superseded provisional run id', () => {
  const { session, store } = createEmptyStore();
  session.status = 'running';
  store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
    Object.assign(session, updates);
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const activity = vi.fn();
  adapter.on('activity', activity);
  const sessionKey = 'agent:main:justdo:session-1';
  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.ensureActiveTurn('session-1', sessionKey, 'client-turn');
  const turn = (
    adapter as unknown as { activeTurns: Map<string, SessionTurn> }
  ).activeTurns.get('session-1');
  expect(turn).toBeDefined();
  turn!.runId = 'gateway-run';
  turn!.knownRunIds.add('gateway-run');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: { runId: 'gateway-run', sessionKey, state: 'final' },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'client-turn',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  expect(adapter.isSessionActive('session-1')).toBe(false);
  expect(activity).toHaveBeenCalledOnce();
  expect(session.status).toBe('idle');
});

test('compaction pauses and then resumes the lifecycle end fallback', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'start' },
      },
    });
    vi.advanceTimersByTime(2000);
    expect(adapter.isSessionActive('session-1')).toBe(true);

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'end', completed: true },
      },
    });
    vi.advanceTimersByTime(1500);
    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('idle');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('lifecycle error converges the session to error after compaction fails', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'start' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'error', error: 'Compaction timed out' },
      },
    });
    vi.advanceTimersByTime(2000);
    expect(adapter.isSessionActive('session-1')).toBe(true);

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'failed', error: 'Compaction timed out' },
      },
    });
    vi.advanceTimersByTime(1500);

    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('error');
    expect(complete).toHaveBeenCalledWith('session-1', 'error');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
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

test('compaction timeout resumes the lifecycle end fallback when its end event is lost', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'start' },
      },
    });

    vi.advanceTimersByTime(COMPACTION_WATCHDOG_MS);
    expect(adapter.isSessionActive('session-1')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('idle');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test.each(['failed', 'timeout', 'timed_out', 'killed', 'aborted', 'cancelled'])(
  'maps abnormal terminal session status %s to error',
  status => {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey: 'agent:main:justdo:session-1',
        status,
        hasActiveRun: false,
      },
    });

    expect(session.status).toBe('error');
    expect(complete).toHaveBeenCalledWith('session-1', 'error');
  },
);

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

test('keeps native task status authoritative while hydrating retained details less often', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const parentKey = 'agent:main:cowork:parent';
  let taskListInvocation = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list') {
      taskListInvocation += 1;
      return {
        tasks: [
          {
            id: 'active_task',
            runtime: 'subagent',
            status: taskListInvocation === 1 ? 'running' : 'completed',
            childSessionKey: 'agent:main:subagent:active-child',
            endedAt: taskListInvocation === 1 ? undefined : 109_000,
          },
          {
            id: 'old_child',
            runtime: 'subagent',
            status: 'completed',
            childSessionKey: 'agent:main:subagent:old-child',
            prompt: 'Old retained task',
            endedAt: 1,
          },
        ],
      };
    }
    if (method === 'tasks.get') {
      const taskId = String(params?.taskId);
      return {
        task:
          taskId === 'active_task'
            ? {
                id: taskId,
                runtime: 'subagent',
                status: 'running',
                childSessionKey: 'agent:main:subagent:active-child',
              }
            : {
                id: taskId,
                runtime: 'subagent',
                status: 'completed',
                childSessionKey: 'agent:main:subagent:old-child',
                prompt: 'Old retained task',
                endedAt: 1,
              },
      };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue([parentKey]);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);

  try {
    const first = await adapter.getSubagentStatuses(session.id);
    now.mockReturnValue(109_000);
    const second = await adapter.getSubagentStatuses(session.id);

    expect(first.subagents).toMatchObject([
      { sessionKey: 'agent:main:subagent:active-child', status: 'running' },
      { sessionKey: 'agent:main:subagent:old-child', status: 'done' },
    ]);
    expect(second.subagents).toMatchObject([
      {
        sessionKey: 'agent:main:subagent:active-child',
        label: 'active_task',
        labelSource: 'taskName',
        status: 'done',
        endedAt: 109_000,
      },
      { sessionKey: 'agent:main:subagent:old-child', status: 'done' },
    ]);
    expect(request.mock.calls.filter(([method]) => method === 'tasks.list')).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === 'tasks.get')).toHaveLength(0);
  } finally {
    now.mockRestore();
  }
});

test('refreshes persisted history when a previously active child disappears from live projections', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const parentKey = 'agent:main:cowork:parent';
  let taskListInvocation = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list') {
      taskListInvocation += 1;
      return {
        tasks:
          taskListInvocation === 2
            ? []
            : [
                {
                  id: 'active_task',
                  runtime: 'subagent',
                  status: taskListInvocation > 2 ? 'completed' : 'running',
                  childSessionKey: 'agent:main:subagent:active-child',
                  endedAt: taskListInvocation > 2 ? 109_000 : undefined,
                },
              ],
      };
    }
    if (method === 'tasks.get') {
      return {
        task: {
          id: String(params?.taskId),
          runtime: 'subagent',
          status: taskListInvocation > 2 ? 'completed' : 'running',
          childSessionKey: 'agent:main:subagent:active-child',
          endedAt: taskListInvocation > 2 ? 109_000 : undefined,
        },
      };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue([parentKey]);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ status: 'running' }],
    });
    now.mockReturnValue(109_000);
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ status: 'done', endedAt: 109_000 }],
    });
    expect(request.mock.calls.filter(([method]) => method === 'tasks.list')).toHaveLength(3);
  } finally {
    warn.mockRestore();
    now.mockRestore();
  }
});

test('retains history and retries promptly when a persisted history page fails', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const parentKey = 'agent:main:cowork:parent';
  let persistedScan = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list') {
      persistedScan += 1;
      if (persistedScan === 2) throw new Error('temporary persisted scan failure');
      return {
        tasks: [
          {
            id: 'old_child',
            runtime: 'subagent',
            status: 'completed',
            childSessionKey: 'agent:main:subagent:old-child',
          },
        ],
      };
    }
    if (method === 'tasks.get') {
      return {
        task: {
          id: String(params?.taskId),
          runtime: 'subagent',
          status: 'completed',
          childSessionKey: 'agent:main:subagent:old-child',
        },
      };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue([parentKey]);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ sessionKey: 'agent:main:subagent:old-child' }],
    });
    now.mockReturnValue(169_000);
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ sessionKey: 'agent:main:subagent:old-child' }],
    });
    now.mockReturnValue(178_000);
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ sessionKey: 'agent:main:subagent:old-child' }],
    });
    expect(persistedScan).toBe(3);
  } finally {
    warn.mockRestore();
    now.mockRestore();
  }
});

test('does not repopulate subagent caches after a parent session is deleted', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let releaseTaskList!: () => void;
  const taskListGate = new Promise<void>(resolve => {
    releaseTaskList = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') {
      await taskListGate;
      return { tasks: [] };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    subagentStatusCache: Map<string, unknown>;
    subagentDetailCache: Map<string, unknown>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const refresh = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('tasks.list', expect.anything()));
  store.getSession = () => null;
  adapter.onSessionDeleted(session.id);
  releaseTaskList();
  await refresh;

  expect(internals.subagentStatusCache.has(session.id)).toBe(false);
  expect(internals.subagentDetailCache.has(session.id)).toBe(false);
});

test('bypasses the subagent status cache for an explicit refresh', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let taskListInvocation = 0;
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') {
      taskListInvocation += 1;
      return {
        tasks: [
          {
            id: 'task-1',
            runtime: 'subagent',
            status: taskListInvocation === 1 ? 'running' : 'completed',
            title: 'Child',
            childSessionKey: 'agent:main:subagent:child-1',
          },
        ],
      };
    }
    if (method === 'sessions.list') {
      return { sessions: [], hasMore: false, nextOffset: null };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
    subagents: [{ status: 'running' }],
  });
  await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
    subagents: [{ status: 'running' }],
  });
  await expect(adapter.getSubagentStatuses(session.id, true)).resolves.toMatchObject({
    subagents: [{ status: 'done' }],
  });
  expect(request.mock.calls.filter(([method]) => method === 'tasks.list')).toHaveLength(2);
});

test('starts a fresh task-ledger read when a task event invalidates an in-flight snapshot', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const parentKey = 'agent:main:justdo:session-1';
  let releaseFirstList!: () => void;
  const firstListGate = new Promise<void>(resolve => {
    releaseFirstList = resolve;
  });
  let taskListInvocation = 0;
  const freshTask = {
    id: 'fresh-task',
    runtime: 'subagent',
    status: 'running',
    title: 'Fresh child',
    sessionKey: parentKey,
    childSessionKey: 'agent:main:subagent:fresh-child',
  };
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') {
      taskListInvocation += 1;
      if (taskListInvocation === 1) {
        await firstListGate;
        return { tasks: [] };
      }
      return { tasks: [freshTask] };
    }
    if (method === 'tasks.get') return { task: freshTask };
    if (method === 'sessions.list') {
      return { sessions: [], hasMore: false, nextOffset: null };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    subagentStatusCache: Map<string, { subagents: Array<{ id: string }> }>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue([parentKey]);

  const staleRefresh = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => {
    expect(request.mock.calls.filter(([method]) => method === 'tasks.list')).toHaveLength(1);
  });

  adapter.handleGatewayEvent({
    event: 'task',
    payload: { action: 'upserted', task: freshTask },
  });
  const freshRefresh = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => {
    expect(request.mock.calls.filter(([method]) => method === 'tasks.list')).toHaveLength(2);
  });
  await expect(freshRefresh).resolves.toMatchObject({
    subagents: [{ id: 'fresh-task', status: 'running' }],
  });

  releaseFirstList();
  await expect(staleRefresh).resolves.toEqual({ subagents: [] });
  expect(internals.subagentStatusCache.get(session.id)?.subagents).toMatchObject([
    { id: 'fresh-task' },
  ]);
});

test('coalesces concurrent subagent status refreshes for the same parent session', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let releaseTaskList!: () => void;
  const taskListGate = new Promise<void>(resolve => {
    releaseTaskList = resolve;
  });
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list') {
      await taskListGate;
      return {
        tasks: [
          {
            id: 'active_task',
            runtime: 'subagent',
            status: 'running',
            childSessionKey: 'agent:main:subagent:active-child',
          },
        ],
      };
    }
    if (method === 'tasks.get') {
      return {
        task: {
          id: String(params?.taskId),
          runtime: 'subagent',
          status: 'running',
          childSessionKey: 'agent:main:subagent:active-child',
        },
      };
    }
    return {};
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue([
    'agent:main:cowork:parent',
  ]);

  const first = adapter.getSubagentStatuses(session.id);
  const second = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => {
    expect(request.mock.calls.filter(([method]) => method === 'tasks.list')).toHaveLength(1);
  });
  releaseTaskList();

  await expect(Promise.all([first, second])).resolves.toEqual([
    {
      subagents: [
        expect.objectContaining({
          sessionKey: 'agent:main:subagent:active-child',
          status: 'running',
        }),
      ],
    },
    {
      subagents: [
        expect.objectContaining({
          sessionKey: 'agent:main:subagent:active-child',
          status: 'running',
        }),
      ],
    },
  ]);
});

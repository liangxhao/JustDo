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

import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
import {
  ApprovalDecision,
  ApprovalKind,
  ExecApprovalDecision,
  OpenClawApprovalIpc,
} from '../../../shared/openclaw/approvals';
import {
  AskUserQuestionGateway,
  CoworkInteractionIpc,
} from '../../../shared/openclaw/extensions';
import type { GatewayClientCtor, GatewayClientLike, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const LONG_COMPACTION_DURATION_MS = 2 * 60 * 60 * 1000;

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
      getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
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
    sessionKey: 'agent:main:justdo:session-1', gatewaySessionId: 'gateway-session-1',
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    clearQueued: true,
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
    if (method === 'sessions.abort') return abortResponse;
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const stopping = adapter.stopSession(turn.sessionId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey,
    clearQueued: true,
  }));
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);

  confirmAbort?.({ ok: true, status: 'aborted', abortedRunId: turn.runId });
  await stopping;

  expect(internals.activeTurns.has(turn.sessionId)).toBe(false);
});

test('keeps a session active when descendant discovery fails despite no active root', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') throw new Error('task ledger unavailable');
    if (method === 'sessions.abort') return { ok: true, status: 'no-active-run' };
    return [];
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await expect(adapter.stopSession(turn.sessionId)).rejects.toThrow('discovery is incomplete');

  expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey,
    clearQueued: true,
  });
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
  expect(turn.stopRequested).toBe(false);
});

test('rejects new Main submissions while stopping and preserves a replacement turn on late acknowledgement', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    runTurn: (sessionId: string, prompt: string, options: object) => Promise<void>;
  };
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  let confirmAbort!: (value: unknown) => void;
  const abort = new Promise(resolve => { confirmAbort = resolve; });
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.abort') return abort;
    return [];
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  const stopping = adapter.stopSession(turn.sessionId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey, clearQueued: true,
  }));

  await expect(internals.runTurn(turn.sessionId, 'new message', {})).rejects.toThrow('still stopping');
  const replacement = createSessionTurn({ runId: 'replacement-run' });
  internals.activeTurns.set(turn.sessionId, replacement);
  confirmAbort({ ok: true, status: 'aborted' });
  await stopping;

  expect(internals.activeTurns.get(turn.sessionId)).toBe(replacement);
});

test('internal conflict cancellation targets only the exact root run', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    abortSessionAndSubagents: (sessionId: string, turn: SessionTurn) => Promise<void>;
  };
  const turn = createSessionTurn();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.abort') return { ok: true, status: 'aborted' };
    return [];
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await internals.abortSessionAndSubagents(turn.sessionId, turn);

  expect(request).toHaveBeenCalledWith('sessions.abort', { key: turn.sessionKey, runId: turn.runId });
  expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => method === 'tasks.list')).toBe(false);
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    clearQueued: true,
  });
});

test('re-aborts a turn stopped while chat.send is being accepted', async () => {
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
    if (method === 'sessions.abort') {
      abortCount += 1;
      return abortCount > 1
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

  const running = internals.runTurn(session.id, 'Ship the release', {});
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      message: 'Ship the release',
      timeoutMs: 0,
    }),
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
    clearQueued: true,
  });
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
    if (method === 'tasks.list') return Promise.resolve({ tasks: [] });
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
        sessions: [
          { key: 'agent:main:justdo:session-1', activeRunIds: [resumeRunId] },
        ],
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
        sessions: [
          { key: 'agent:main:justdo:session-1', activeRunIds: [resumeRunId] },
        ],
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

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).rejects.toThrow('completed goal changed');
  expect(describeCount).toBe(4);
  expect(request.mock.calls.some(([method]) => method === 'sessions.goal.clear')).toBe(false);
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

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).rejects.toThrow('completed goal changed');
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

test('keeps healthy long manual compaction running until its native terminal event', async () => {
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
    await vi.advanceTimersByTimeAsync(LONG_COMPACTION_DURATION_MS);

    await expect(
      adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
    ).resolves.toMatchObject({ mainRunning: true, running: true });
    expect(request).not.toHaveBeenCalled();
    adapter.handleGatewayEvent({
      event: 'session.operation',
      payload: { operation: 'compact', phase: 'end', sessionKey, completed: true },
    });

    await expect(
      adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
    ).resolves.toMatchObject({ mainRunning: false, running: false });
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['session.operation', { operation: 'reset', phase: 'end' }],
  ['session.operation', { operation: 'delete', phase: 'end' }],
  ['sessions.changed', { reason: 'reset' }],
  ['sessions.changed', { reason: 'delete' }],
  ['sessions.changed', { reason: 'new' }],
] as const)('clears manual compaction after %s %j', async (event, payload) => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request: vi.fn().mockResolvedValue({ sessions: [] }),
  } as unknown as GatewayClientLike;
  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });
  adapter.handleGatewayEvent({ event, payload: { ...payload, sessionKey } });
  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toMatchObject({ mainRunning: false, running: false });
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

test('long compaction pauses lifecycle completion until its native end arrives', () => {
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

    vi.advanceTimersByTime(LONG_COMPACTION_DURATION_MS);
    expect(adapter.isSessionActive('session-1')).toBe(true);
    expect(session.status).toBe('running');
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'end', completed: true, outcome: 'completed' },
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


test.each(['continuing', 'retrying'])('keeps %s goal scheduling active without claiming a root run', async phase => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = { request: vi.fn().mockResolvedValue({ sessions: [] }) };
  adapter.goalContinuationCoordinator.restoreSnapshot({
    sessionId: 'session-1', goalId: 'goal-1', phase, continuationCount: 1, updatedAt: Date.now(),
  });
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    known: true, mainRunning: false, subagentRunning: false, running: true,
  });
  adapter.goalContinuationCoordinator.stop('session-1');
  adapter.goalContinuationCoordinator.confirmStop('session-1');
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({ running: false });
});

test('reports descendant-only activity separately from the root even when only the parent row is returned', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = { request: vi.fn().mockResolvedValue({ sessions: [{
    key: 'agent:main:justdo:session-1', hasActiveRun: false, runState: 'idle',
    hasActiveSubagentRun: true, status: 'running',
  }] }) };
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    known: true, mainRunning: false, subagentRunning: false, running: false,
  });
  await expect(adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true })).resolves.toMatchObject({
    known: true, mainRunning: false, subagentRunning: true, running: true,
  });
});

test.each([
  { status: 'ok', expected: 'idle' },
  { status: 'error', expected: 'error' },
  { status: 'timeout', endedAt: 123, expected: 'error' },
])('recovers a disconnected run from the authoritative $status terminal result', async ({ status, endedAt, expected }) => {
  const { store } = createEmptyStore();
  store.updateSession = vi.fn();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.on('error', vi.fn());
  adapter.activeTurns.set('session-1', createSessionTurn());
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.disconnectedSessionIds.add('session-1');
  const request = vi.fn(async method => method === 'agent.wait'
    ? { runId: 'run-1', status, endedAt }
    : method === 'sessions.describe' ? { session: { key: 'agent:main:justdo:session-1', goal: null } }
    : { sessions: [] });
  adapter.gatewayClient = { request };
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({ known: true, running: false });
  expect(request).toHaveBeenCalledWith('agent.wait', { runId: 'run-1', timeoutMs: 0 });
  expect(store.updateSession).toHaveBeenCalledWith('session-1', { status: expected });
  expect(adapter.activeTurns.has('session-1')).toBe(false);
});

test.each([{ status: 'timeout' }])('does not invent a terminal outcome when recovery returns %j', async result => {
  const { store } = createEmptyStore();
  store.updateSession = vi.fn();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.activeTurns.set('session-1', createSessionTurn());
  adapter.disconnectedSessionIds.add('session-1');
  adapter.gatewayClient = { request: vi.fn(async method => method === 'agent.wait' ? result : { sessions: [] }) };
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({ known: false });
  expect(store.updateSession).not.toHaveBeenCalled();
  expect(adapter.activeTurns.has('session-1')).toBe(true);
});


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
      constructor(value) { options = value; }
      start() {}
      stop() {}
      async request() { return {}; }
    }
    adapter.loadGatewayClientCtor = vi.fn().mockResolvedValue(FakeClient);
    adapter.handleGatewayReady = vi.fn().mockResolvedValue(undefined);
    adapter.reconcilePendingApprovals = vi.fn().mockResolvedValue(undefined);
    adapter.reconcilePendingAskUserInteractions = vi.fn().mockResolvedValue(undefined);
    await adapter.createGatewayClient({ url: 'ws://127.0.0.1:1234', token: '', version: 'test', clientEntryPath: 'test.js' });
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


test('concurrent recovery polls wait until Goal lifecycle reconciliation completes', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.activeTurns.set('session-1', createSessionTurn());
  adapter.disconnectedSessionIds.add('session-1');
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.gatewayClient = { request: vi.fn(async method => method === 'agent.wait'
    ? { status: 'ok' } : { sessions: [] }) };
  let finishGoal;
  adapter.goalContinuationCoordinator.handleLifecycle = vi.fn(() => new Promise<void>(resolve => { finishGoal = resolve; }));
  const first = adapter.getSessionRuntimeStatus('session-1');
  await vi.waitFor(() => expect(finishGoal).toBeDefined());
  let secondSettled = false;
  const second = adapter.getSessionRuntimeStatus('session-1').then(status => { secondSettled = true; return status; });
  await Promise.resolve();
  expect(secondSettled).toBe(false);
  finishGoal();
  await Promise.all([first, second]);
  expect(adapter.gatewayClient.request.mock.calls.filter(([method]) => method === 'agent.wait')).toHaveLength(1);
});


test('retains cancelled unknown admission across no-active stops and later aborts only its run', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
    reconcileDisconnectedTurn: (sessionId: string) => Promise<void>;
  };
  let terminal = false;
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.abort') return { ok: true, status: 'no-active-run' };
    if (method === 'agent.wait') return terminal
      ? { runId: 'unknown-run', status: 'timeout', endedAt: Date.now(), stopReason: 'rpc' }
      : { status: 'timeout' };
    return {};
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  adapter.registerUnknownSessionRun(session.id, 'unknown-run');
  await expect(adapter.stopSession(session.id)).rejects.toThrow('unconfirmed');
  expect(internals.unknownSessionRuns.get(session.id)).toEqual({ runId: 'unknown-run', cancelled: true });
  expect(internals.activeTurns.get(session.id)?.runId).toBe('unknown-run');
  request.mockClear();
  terminal = true;
  await internals.reconcileDisconnectedTurn(session.id);
  expect(request).toHaveBeenCalledWith('sessions.abort', { key: 'agent:main:justdo:session-1', runId: 'unknown-run' });
  expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toHaveLength(1);
  expect(internals.unknownSessionRuns.has(session.id)).toBe(false);
  expect(internals.activeTurns.has(session.id)).toBe(false);
});


test.each([false, true])('yielded unknown admission returns to normal runtime aggregation (cancelled=%s)', async cancelled => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
    reconcileDisconnectedTurn: (sessionId: string) => Promise<void>;
  };
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.abort') return { ok: true, status: 'aborted' };
    if (method === 'agent.wait') return { runId: 'yielded-run', status: 'ok', yielded: true };
    return {};
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  adapter.registerUnknownSessionRun(session.id, 'yielded-run', { cancelled });
  const complete = vi.fn();
  adapter.on('complete', complete);
  await internals.reconcileDisconnectedTurn(session.id);
  expect(internals.unknownSessionRuns.has(session.id)).toBe(false);
  expect(internals.activeTurns.has(session.id)).toBe(false);
  expect(complete).not.toHaveBeenCalled();
  if (cancelled) {
    expect(request).toHaveBeenCalledWith('sessions.abort', { key: 'agent:main:justdo:session-1', clearQueued: true });
  } else {
    expect(request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
  }
});

test('late unknown admission reopens locally stopped tracking and repeated reports preserve cancellation identity', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request: vi.fn(async (method: string) => {
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.abort') return { ok: true, status: 'no-active-run' };
    return {};
  }) };
  internals.activeTurns.set(session.id, createSessionTurn({ runId: 'late-run' }));
  await adapter.stopSession(session.id);
  adapter.registerUnknownSessionRun(session.id, 'late-run');
  const identity = internals.unknownSessionRuns.get(session.id);
  expect(identity).toEqual({ runId: 'late-run', cancelled: true });
  expect(internals.activeTurns.get(session.id)?.runId).toBe('late-run');
  adapter.registerUnknownSessionRun(session.id, 'late-run', { cancelled: true });
  expect(internals.unknownSessionRuns.get(session.id)).toBe(identity);
});

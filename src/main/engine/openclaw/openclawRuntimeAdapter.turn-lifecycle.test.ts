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

const LONG_COMPACTION_DURATION_MS = 2 * 60 * 60 * 1000;

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

type StopTestAdapter = {
  activeTurns: Map<string, SessionTurn>;
  gatewayClient: GatewayClientLike | null;
  goalContinuationCoordinator: { rollbackStop: (sessionId: string) => void };
  ensureGatewayClientReady: () => Promise<void>;
  reconcilePendingApprovals: () => Promise<void>;
  approvalReconciliation: { events: unknown[] } | null;
};

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
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
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
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('sessions.abort', {
      key: turn.sessionKey,
      clearQueued: true,
    }),
  );
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);

  confirmAbort?.({ ok: true, status: 'aborted', abortedRunId: turn.runId });
  await stopping;

  expect(internals.activeTurns.has(turn.sessionId)).toBe(false);
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
  const abort = new Promise(resolve => {
    confirmAbort = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.abort') return abort;
    return [];
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  const stopping = adapter.stopSession(turn.sessionId);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('sessions.abort', {
      key: turn.sessionKey,
      clearQueued: true,
    }),
  );

  await expect(internals.runTurn(turn.sessionId, 'new message', {})).rejects.toThrow(
    'still stopping',
  );
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

  expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey,
    runId: turn.runId,
  });
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
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
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
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
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
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = internals.runTurn(session.id, 'Ship the release', {});
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        message: 'Ship the release',
        timeoutMs: 0,
      }),
    ),
  );

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
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
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
    runTurn: (sessionId: string, prompt: string, options: Record<string, never>) => Promise<void>;
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
  (adapter as unknown as { cleanupGatewayClientState: () => void }).cleanupGatewayClientState();

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toMatchObject({ mainRunning: false, running: false });
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
  const turn = (adapter as unknown as { activeTurns: Map<string, SessionTurn> }).activeTurns.get(
    'session-1',
  );
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

test.each([{ status: 'timeout' }])(
  'does not invent a terminal outcome when recovery returns %j',
  async result => {
    const { store } = createEmptyStore();
    store.updateSession = vi.fn();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.activeTurns.set('session-1', createSessionTurn());
    adapter.disconnectedSessionIds.add('session-1');
    adapter.gatewayClient = {
      request: vi.fn(async method => (method === 'agent.wait' ? result : { sessions: [] })),
    };
    await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
      known: false,
    });
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(adapter.activeTurns.has('session-1')).toBe(true);
  },
);

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
    if (method === 'agent.wait')
      return terminal
        ? { runId: 'unknown-run', status: 'timeout', endedAt: Date.now(), stopReason: 'rpc' }
        : { status: 'timeout' };
    return {};
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  adapter.registerUnknownSessionRun(session.id, 'unknown-run');
  await expect(adapter.stopSession(session.id)).rejects.toThrow('unconfirmed');
  expect(internals.unknownSessionRuns.get(session.id)).toEqual({
    runId: 'unknown-run',
    cancelled: true,
  });
  expect(internals.activeTurns.get(session.id)?.runId).toBe('unknown-run');
  request.mockClear();
  terminal = true;
  await internals.reconcileDisconnectedTurn(session.id);
  expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: 'agent:main:justdo:session-1',
    runId: 'unknown-run',
  });
  expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toHaveLength(1);
  expect(internals.unknownSessionRuns.has(session.id)).toBe(false);
  expect(internals.activeTurns.has(session.id)).toBe(false);
});

test.each([false, true])(
  'yielded unknown admission returns to normal runtime aggregation (cancelled=%s)',
  async cancelled => {
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
      expect(request).toHaveBeenCalledWith('sessions.abort', {
        key: 'agent:main:justdo:session-1',
        clearQueued: true,
      });
    } else {
      expect(request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    }
  },
);

test('late lost-ack reporting does not reopen an already terminated local run', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
  };
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(async (method: string) => {
      if (method === 'tasks.list') return { tasks: [] };
      if (method === 'sessions.abort') return { ok: true, status: 'no-active-run' };
      return {};
    }),
  };
  internals.activeTurns.set(session.id, createSessionTurn({ runId: 'late-run' }));
  await adapter.stopSession(session.id);
  adapter.registerUnknownSessionRun(session.id, 'late-run');
  expect(internals.unknownSessionRuns.has(session.id)).toBe(false);
  expect(internals.activeTurns.has(session.id)).toBe(false);
  adapter.registerUnknownSessionRun(session.id, 'late-run', { cancelled: true });
  expect(internals.unknownSessionRuns.has(session.id)).toBe(false);
});

test('confirms a lost acknowledgement immediately when the run already reached a terminal event', () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter & {
    unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
    recentTerminalRunIds: Map<string, number>;
  };
  const onConfirmed = vi.fn();

  internals.recentTerminalRunIds.set('short-run', Date.now() + 60_000);
  adapter.registerUnknownSessionRun(session.id, 'short-run', { onConfirmed });

  expect(onConfirmed).toHaveBeenCalledOnce();
  expect(internals.unknownSessionRuns.has(session.id)).toBe(false);
  expect(internals.activeTurns.has(session.id)).toBe(false);
});

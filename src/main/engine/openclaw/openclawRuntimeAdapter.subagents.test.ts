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

test('scheduled run lookup uses its physical window and never falls back to the latest task run', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ unavailableReason: 'not-found' });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  const sessionKey = 'agent:main:cron:job-1:run:old-run';
  await expect(
    adapter.fetchSessionHistoryByKey(sessionKey, 'old-run', { scheduledTaskRun: true }),
  ).resolves.toEqual({ sessionKey, messages: [], unavailableReason: 'not-found' });
  expect(request).toHaveBeenCalledExactlyOnceWith('runtimeServices.scheduledTaskHistory', {
    sessionKey,
    sessionId: 'old-run',
    offset: 0,
  });
});

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

test.each([{ action: 'deleted', taskId: 'task-1' }, { action: 'restored' }])(
  'globally invalidates in-flight task snapshots for $action events',
  payload => {
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
  },
);

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

test('preserves retryable state when native descendant cancellation is incomplete', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  const request = vi.fn(async () => {
    throw new Error('Session stopped, but descendant cancellation was incomplete');
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await expect(adapter.stopSession(turn.sessionId)).rejects.toThrow(
    'descendant cancellation was incomplete',
  );

  expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey,
    clearQueued: true,
  });
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
  expect(turn.stopRequested).toBe(false);
});

test('uses native session-wide cancellation for descendants when the root is already idle', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const request = vi.fn().mockResolvedValue({ ok: true, status: 'aborted', abortedRunId: null });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await adapter.stopSession('session-1');

  expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toEqual([
    ['sessions.abort', { key: 'agent:main:justdo:session-1', clearQueued: true }],
  ]);
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

test('keeps a reactivated terminal task running across ordinary status refreshes', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const parentKey = 'agent:main:cowork:parent';
  const childKey = 'agent:main:subagent:reactivated';
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.list') {
      return {
        tasks: [
          {
            id: 'reactivated-task',
            runtime: 'subagent',
            status: 'completed',
            terminalOutcome: 'blocked',
            childSessionKey: childKey,
            updatedAt: 100,
            endedAt: 100,
          },
        ],
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          key: childKey,
          sessionId: 'reactivated-session',
          status: 'running',
          subagentRunState: 'active',
          updatedAt: 200,
          startedAt: 150,
          runtimeMs: 50,
        },
      };
    }
    throw new Error(`unexpected ${method}`);
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
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ status: 'running', updatedAt: 200 }],
    });
    now.mockReturnValue(109_000);
    await expect(adapter.getSubagentStatuses(session.id)).resolves.toMatchObject({
      subagents: [{ status: 'running', updatedAt: 200 }],
    });
    expect(request.mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(2);
    expect(request.mock.calls.some(([method]) => method === 'sessions.list')).toBe(false);
  } finally {
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
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue(['agent:main:cowork:parent']);

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

test('reports descendant-only activity separately from the root even when only the parent row is returned', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: false,
          runState: 'idle',
          hasActiveSubagentRun: true,
          status: 'running',
        },
      ],
    }),
  };
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toMatchObject({
    known: true,
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
});

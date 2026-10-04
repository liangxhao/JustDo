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

test.each(['create', 'delete', 'lifecycle'])(
  'invalidates native child snapshots on sessions.changed %s',
  reason => {
    const { store, session } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const listener = vi.fn();
    adapter.on('taskChanged', listener);
    const internals = adapter as unknown as {
      subagentStatusRefreshes: Map<string, Promise<unknown>>;
      subagentStatusCache: Map<string, unknown>;
    };
    internals.subagentStatusRefreshes.set(session.id, Promise.resolve([]));
    internals.subagentStatusCache.set(session.id, {});
    adapter.handleGatewayEvent({
      event: 'sessions.changed',
      payload: { key: 'agent:main:subagent:child', reason },
    });
    expect(internals.subagentStatusRefreshes.has(session.id)).toBe(false);
    expect(internals.subagentStatusCache.has(session.id)).toBe(false);
    expect(listener).toHaveBeenCalledWith({});
  },
);

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

const childKey = 'agent:main:subagent:child';
const nativeChild = {
  key: childKey,
  sessionId: 'native-child',
  spawnedBy: 'agent:main:justdo:session-1',
  status: 'running',
  updatedAt: 10,
  activeRunIds: ['run-1'],
};
function statusAdapter(request: ReturnType<typeof vi.fn>) {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
    subagentStatusCache: Map<string, unknown>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'getSessionKeysForSession').mockReturnValue([nativeChild.spawnedBy]);
  return { adapter, internals, store, session };
}

test('uses native session lifecycle for completion and reactivation', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ sessions: [nativeChild] })
    .mockResolvedValueOnce({
      sessions: [
        { ...nativeChild, status: 'done', updatedAt: 20, lastRunId: 'run-1', endedAt: 20 },
      ],
    })
    .mockResolvedValueOnce({
      sessions: [{ ...nativeChild, updatedAt: 30, activeRunIds: ['run-2'] }],
    });
  const { adapter, session } = statusAdapter(request);
  expect((await adapter.getSubagentStatuses(session.id)).subagents[0]).toMatchObject({
    status: 'running',
    runId: 'run-1',
  });
  expect((await adapter.getSubagentStatuses(session.id, true)).subagents[0]).toMatchObject({
    status: 'done',
    runId: 'run-1',
  });
  const latest = (await adapter.getSubagentStatuses(session.id, true)).subagents[0];
  expect(latest).toMatchObject({ status: 'running', runId: 'run-2' });
  expect(latest.endedAt).toBeUndefined();
  expect(request.mock.calls.every(([method]) => method === 'sessions.list')).toBe(true);
});

test('coalesces native session reads and bypasses cache for explicit refresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const request = vi.fn(async () => {
    await gate;
    return { sessions: [nativeChild] };
  });
  const { adapter, session } = statusAdapter(request);
  const first = adapter.getSubagentStatuses(session.id),
    second = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  release();
  expect((await Promise.all([first, second])).every(result => result.subagents.length === 1)).toBe(
    true,
  );
  await adapter.getSubagentStatuses(session.id);
  expect(request).toHaveBeenCalledTimes(1);
  await adapter.getSubagentStatuses(session.id, true);
  expect(request).toHaveBeenCalledTimes(2);
});

test('does not repopulate child caches after product session deletion', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const request = vi.fn(async () => {
    await gate;
    return { sessions: [nativeChild] };
  });
  const { adapter, internals, store, session } = statusAdapter(request);
  const pending = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  vi.spyOn(store, 'getSession').mockReturnValue(null);
  release();
  await pending;
  expect(internals.subagentStatusCache.has(session.id)).toBe(false);
});

test('an in-flight old snapshot cannot overwrite a newer sessions.changed refresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const request = vi
    .fn()
    .mockImplementationOnce(async () => {
      await gate;
      return { sessions: [] };
    })
    .mockResolvedValue({ sessions: [nativeChild] });
  const { adapter, internals, session } = statusAdapter(request);
  const stale = adapter.getSubagentStatuses(session.id);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  adapter.handleGatewayEvent({
    event: 'sessions.changed',
    payload: { key: childKey, reason: 'create' },
  });
  expect((await adapter.getSubagentStatuses(session.id)).subagents).toHaveLength(1);
  release();
  await stale;
  expect(internals.subagentStatusCache.get(session.id)).toMatchObject({
    subagents: [{ id: childKey }],
  });
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

test('navigation-only forks do not count as controlled subagent activity', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        { key: 'agent:main:justdo:session-1', status: 'done', hasActiveRun: false },
        {
          key: 'agent:main:justdo:fork',
          parentSessionKey: 'agent:main:justdo:session-1',
          status: 'running',
          hasActiveRun: true,
        },
      ],
    }),
  };
  expect(
    await adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).toMatchObject({ known: true, mainRunning: false, subagentRunning: false, running: false });
});

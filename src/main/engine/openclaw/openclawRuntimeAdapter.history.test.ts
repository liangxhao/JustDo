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
import type { GatewayClientLike } from '../gateway/types';
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

  await expect(adapter.fetchSessionHistoryByKey('agent:main:cron:job-1:run:1')).resolves.toEqual({
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

test('replaces a replayed partial history boundary instead of double-counting it', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const partial = { role: 'tool_use', name: 'read-two', __openclaw: { id: 'entry-2', seq: 2 } };
  const newest = { role: 'assistant', content: 'Done', __openclaw: { id: 'entry-3', seq: 3 } };
  const completeBoundary = [
    { role: 'assistant', content: 'Working', __openclaw: { id: 'entry-2', seq: 2 } },
    { role: 'tool_use', name: 'read-one', __openclaw: { id: 'entry-2', seq: 2 } },
    partial,
  ];
  const oldest = { role: 'user', content: 'Question', __openclaw: { id: 'entry-1', seq: 1 } };
  const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
    params?.offset === 2
      ? { messages: [oldest, ...completeBoundary], hasMore: false }
      : { messages: [partial, newest], hasMore: true, nextOffset: 2 },
  );
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toEqual({
    sessionKey: 'agent:main:one',
    messages: [oldest, ...completeBoundary, newest],
  });
});

test('restarts full history pagination when the transcript changes between pages', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let firstPageReads = 0;
  const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    if (params?.offset === 1) {
      return firstPageReads === 1
        ? { messages: ['stale-oldest'], hasMore: false, totalMessages: 3 }
        : { messages: ['oldest'], hasMore: false, totalMessages: 2 };
    }
    firstPageReads += 1;
    return firstPageReads === 1
      ? { messages: ['stale-newest'], hasMore: true, nextOffset: 1, totalMessages: 2 }
      : { messages: ['newest'], hasMore: true, nextOffset: 1, totalMessages: 2 };
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toEqual({
    sessionKey: 'agent:main:one',
    messages: ['oldest', 'newest'],
  });
  expect(request).toHaveBeenCalledTimes(4);
});

test('fails closed when full history never reaches a stable snapshot', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let generation = 0;
  const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    if (params?.offset === 1) {
      return { messages: ['oldest'], hasMore: false, totalMessages: generation + 1 };
    }
    generation += 1;
    return { messages: ['newest'], hasMore: true, nextOffset: 1, totalMessages: generation };
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toBeNull();
  expect(request).toHaveBeenCalledTimes(6);
});

test('catches up a stable full history snapshot and uses deltas on later reads', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: ['oldest'],
      hasMore: false,
      totalMessages: 1,
      deltaCursor: 'cursor-1',
    })
    .mockResolvedValueOnce({
      kind: 'delta',
      messages: ['arrived-during-scan'],
      deltaCursor: 'cursor-2',
    })
    .mockResolvedValueOnce({
      kind: 'delta',
      messages: ['arrived-later'],
      deltaCursor: 'cursor-3',
    });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toEqual({
    sessionKey: 'agent:main:one',
    messages: ['oldest', 'arrived-during-scan'],
  });
  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toEqual({
    sessionKey: 'agent:main:one',
    messages: ['oldest', 'arrived-during-scan', 'arrived-later'],
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith('chat.history', {
    sessionKey: 'agent:main:one',
    cursor: 'cursor-2',
  });
});

test('can bypass a stale delta snapshot with an authoritative full history read', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: ['user'],
      hasMore: false,
      totalMessages: 1,
      deltaCursor: 'cursor-stale',
    })
    .mockResolvedValueOnce({ kind: 'delta', messages: [], deltaCursor: 'cursor-stale' })
    .mockResolvedValueOnce({
      messages: ['user', 'assistant'],
      hasMore: false,
      totalMessages: 2,
      deltaCursor: 'cursor-fresh',
    })
    .mockResolvedValueOnce({ kind: 'delta', messages: [], deltaCursor: 'cursor-fresh' });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toMatchObject({
    messages: ['user'],
  });
  await expect(
    adapter.fetchSessionHistoryByKey('agent:main:one', undefined, { forceFullSnapshot: true }),
  ).resolves.toEqual({
    sessionKey: 'agent:main:one',
    messages: ['user', 'assistant'],
  });
  expect(request).toHaveBeenNthCalledWith(3, 'chat.history', {
    sessionKey: 'agent:main:one',
    limit: 1000,
  });
});

test('keeps independent bounded delta snapshots for alternating sessions', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const cursorReads = new Map<string, number>();
  const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    const sessionKey = String(params?.sessionKey);
    if (typeof params?.cursor !== 'string') {
      return {
        messages: [`${sessionKey}-initial`],
        hasMore: false,
        totalMessages: 1,
        deltaCursor: `${sessionKey}-cursor-1`,
      };
    }
    const reads = (cursorReads.get(sessionKey) ?? 0) + 1;
    cursorReads.set(sessionKey, reads);
    return {
      kind: 'delta',
      messages: reads === 1 ? [] : [`${sessionKey}-new`],
      deltaCursor: `${sessionKey}-cursor-${reads + 1}`,
    };
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await adapter.fetchSessionHistoryByKey('session-a');
  await adapter.fetchSessionHistoryByKey('session-b');
  await expect(adapter.fetchSessionHistoryByKey('session-a')).resolves.toMatchObject({
    messages: ['session-a-initial', 'session-a-new'],
  });
  await expect(adapter.fetchSessionHistoryByKey('session-b')).resolves.toMatchObject({
    messages: ['session-b-initial', 'session-b-new'],
  });
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'session-a',
    cursor: 'session-a-cursor-2',
  });
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'session-b',
    cursor: 'session-b-cursor-2',
  });
});

test('rebuilds history when an equal-sized transcript generation resets its cursor', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: ['old-generation'],
      hasMore: false,
      totalMessages: 1,
      deltaCursor: 'cursor-old',
    })
    .mockResolvedValueOnce({ kind: 'delta', messages: [], deltaCursor: 'cursor-old' })
    .mockResolvedValueOnce({ kind: 'reset' })
    .mockResolvedValueOnce({
      messages: ['new-generation'],
      hasMore: false,
      totalMessages: 1,
      deltaCursor: 'cursor-new',
    })
    .mockResolvedValueOnce({ kind: 'delta', messages: [], deltaCursor: 'cursor-new' });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toMatchObject({
    messages: ['old-generation'],
  });
  await expect(adapter.fetchSessionHistoryByKey('agent:main:one')).resolves.toEqual({
    sessionKey: 'agent:main:one',
    messages: ['new-generation'],
  });
  expect(request).toHaveBeenCalledTimes(5);
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

  await expect(adapter.fetchSessionHistoryByKey('agent:main:cron:job-1:run:1')).resolves.toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
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

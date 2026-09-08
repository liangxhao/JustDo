import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import {
  getGatewaySubagentDetails,
  listGatewaySubagentDescendants,
  listGatewaySubagents,
  listGatewaySubagentsWithMetadata,
  mergeGatewaySubagentSnapshots,
} from './subagentGateway';

const gatewayClient = (request: GatewayClientLike['request']): GatewayClientLike =>
  ({ request }) as GatewayClientLike;

test('maps native task ledger states and keeps task id separate from display label', async () => {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list') {
      expect(params).toEqual({
        sessionKey: 'agent:main:justdo:parent',
        limit: 500,
      });
      return {
        tasks: [
          {
            id: 'task_machine_1',
            runtime: 'subagent',
            status: 'queued',
            title: 'Readable child title',
            sessionKey: 'agent:main:justdo:parent',
            childSessionKey: 'agent:main:subagent:child',
            createdAt: 100,
            updatedAt: 150,
            toolUseCount: 3,
            lastToolName: 'read',
            lastActivity: 'Inspecting source',
            progressSummary: 'Reviewing the runtime adapter',
          },
        ],
      };
    }
    if (method === 'tasks.get') {
      return {
        task: {
          id: 'task_machine_1',
          runtime: 'subagent',
          status: 'queued',
          title: 'Readable child title',
          sessionKey: 'agent:main:justdo:parent',
          childSessionKey: 'agent:main:subagent:child',
          createdAt: 100,
          updatedAt: 150,
          toolUseCount: 3,
          lastToolName: 'read',
          lastActivity: 'Inspecting source',
          progressSummary: 'Reviewing the runtime adapter',
          prompt: 'Inspect the implementation.',
        },
      };
    }
    if (method === 'sessions.describe') {
      expect(params).toEqual({ key: 'agent:main:subagent:child' });
      return {
        session: {
          key: 'agent:main:subagent:child',
          sessionId: 'session-child',
          model: 'gpt-5.6',
          totalTokens: 42,
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  });

  await expect(
    listGatewaySubagents({
      client: gatewayClient(request as GatewayClientLike['request']),
      parentKeys: ['agent:main:justdo:parent'],
    }),
  ).resolves.toEqual([
    {
      id: 'task_machine_1',
      taskName: 'task_machine_1',
      sessionKey: 'agent:main:subagent:child',
      label: 'Readable child title',
      labelSource: 'label',
      status: 'pending',
      task: 'Inspect the implementation.',
      sessionId: 'session-child',
      model: 'gpt-5.6',
      totalTokens: 42,
      startedAt: undefined,
      updatedAt: 150,
      endedAt: undefined,
      progressSummary: 'Reviewing the runtime adapter',
      terminalSummary: undefined,
      error: undefined,
      lastActivity: 'Inspecting source',
      lastToolName: 'read',
      toolUseCount: 3,
    },
  ]);
});

test.each([
  ['running', 'running'],
  ['completed', 'done'],
  ['failed', 'failed'],
  ['cancelled', 'killed'],
  ['timed_out', 'timeout'],
] as const)('maps native %s to the JustDo %s DTO', async (nativeStatus, expected) => {
  const request = vi.fn(async () => ({
    tasks: [
      {
        id: `task-${nativeStatus}`,
        runtime: 'subagent',
        status: nativeStatus,
        childSessionKey: `agent:main:subagent:${nativeStatus}`,
      },
    ],
  }));

  const result = await listGatewaySubagents({
    client: gatewayClient(request as GatewayClientLike['request']),
    parentKeys: ['agent:main:justdo:parent'],
    hydrateDetails: false,
  });
  expect(result[0]?.status).toBe(expected);
});

test('loads an exact task prompt and session identity for the details popup', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.get') {
      return {
        task: {
          id: 'task-one',
          runtime: 'subagent',
          status: 'running',
          title: 'Short title',
          prompt: 'The complete task prompt that must be displayed.',
          childSessionKey: 'agent:researcher:subagent:one',
          startedAt: 100,
        },
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          sessionId: 'session-one',
          modelProvider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  });

  await expect(
    getGatewaySubagentDetails(gatewayClient(request as GatewayClientLike['request']), 'task-one'),
  ).resolves.toMatchObject({
    id: 'task-one',
    task: 'The complete task prompt that must be displayed.',
    sessionId: 'session-one',
    model: 'openrouter/anthropic/claude-sonnet-4',
    startedAt: 100,
  });
});

test('uses an active session projection when a terminal task is reactivated', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.get') {
      return {
        task: {
          id: 'task-reactivated',
          runtime: 'subagent',
          status: 'completed',
          terminalOutcome: 'blocked',
          childSessionKey: 'agent:main:subagent:reactivated',
          startedAt: 100,
          endedAt: 200,
          terminalSummary: 'Old blocked result',
          error: 'Old error',
        },
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          sessionId: 'session-reactivated',
          status: 'running',
          subagentRunState: 'active',
          startedAt: 50,
          updatedAt: 300,
          runtimeMs: 175,
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  });

  const result = await getGatewaySubagentDetails(
    gatewayClient(request as GatewayClientLike['request']),
    'task-reactivated',
  );

  expect(result).toMatchObject({
    status: 'running',
    startedAt: 50,
    updatedAt: 300,
    runtimeMs: 175,
    runtimeSampledAt: expect.any(Number),
  });
  expect(result).not.toHaveProperty('endedAt');
  expect(result).not.toHaveProperty('terminalSummary');
  expect(result).not.toHaveProperty('error');
});

test('does not let an older running session row override a newer terminal task', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.get') {
      return {
        task: {
          id: 'task-finished',
          runtime: 'subagent',
          status: 'completed',
          terminalOutcome: 'blocked',
          childSessionKey: 'agent:main:subagent:finished',
          updatedAt: 500,
          endedAt: 500,
          terminalSummary: 'Current blocked result',
        },
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          status: 'running',
          subagentRunState: 'active',
          updatedAt: 300,
          runtimeMs: 100,
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  });

  await expect(
    getGatewaySubagentDetails(
      gatewayClient(request as GatewayClientLike['request']),
      'task-finished',
    ),
  ).resolves.toMatchObject({
    status: 'blocked',
    updatedAt: 500,
    endedAt: 500,
    terminalSummary: 'Current blocked result',
  });
});

test('uses run identity to resolve an equal-revision terminal-task conflict', async () => {
  const describe = async (activeRunIds: string[]) => {
    const request = vi.fn(async (method: string) => {
      if (method === 'tasks.get') {
        return {
          task: {
            id: 'task-finished',
            runtime: 'subagent',
            runId: 'run-finished',
            status: 'completed',
            terminalOutcome: 'blocked',
            childSessionKey: 'agent:main:subagent:finished',
            updatedAt: 500,
            endedAt: 500,
          },
        };
      }
      if (method === 'sessions.describe') {
        return {
          session: {
            status: 'running',
            subagentRunState: 'active',
            updatedAt: 500,
            runtimeMs: 100,
          },
        };
      }
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:subagent:finished',
              status: 'running',
              subagentRunState: 'active',
              activeRunIds,
              updatedAt: 500,
              runtimeMs: 100,
            },
          ],
          hasMore: false,
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    return getGatewaySubagentDetails(
      gatewayClient(request as GatewayClientLike['request']),
      'task-finished',
    );
  };

  await expect(describe(['run-finished'])).resolves.toMatchObject({
    status: 'blocked',
    runId: 'run-finished',
  });
  await expect(describe(['run-replacement', 'run-finished'])).resolves.toMatchObject({
    status: 'running',
    runId: 'run-replacement',
  });
  await expect(describe(['run-finished', 'run-replacement'])).resolves.toMatchObject({
    status: 'running',
    runId: 'run-replacement',
  });
});

test('keeps the terminal task when optional replacement-run lookup fails', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'tasks.get') {
      return {
        task: {
          id: 'task-finished',
          runtime: 'subagent',
          runId: 'run-finished',
          status: 'completed',
          terminalOutcome: 'blocked',
          childSessionKey: 'agent:main:subagent:finished',
          updatedAt: 500,
          endedAt: 500,
        },
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          status: 'running',
          subagentRunState: 'active',
          updatedAt: 500,
        },
      };
    }
    if (method === 'sessions.list') throw new Error('temporary list failure');
    throw new Error(`unexpected ${method}`);
  });

  await expect(
    getGatewaySubagentDetails(
      gatewayClient(request as GatewayClientLike['request']),
      'task-finished',
    ),
  ).resolves.toMatchObject({
    status: 'blocked',
    runId: 'run-finished',
    updatedAt: 500,
  });
});

test('keeps targeted session details when bulk replacement-run lookup fails', async () => {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list') {
      return {
        tasks: [
          {
            id: 'task-finished',
            runtime: 'subagent',
            runId: 'run-finished',
            status: 'completed',
            childSessionKey: 'agent:main:subagent:finished',
            updatedAt: 500,
          },
          {
            id: 'task-running',
            runtime: 'subagent',
            status: 'running',
            childSessionKey: 'agent:main:subagent:running',
            updatedAt: 600,
          },
        ],
      };
    }
    if (method === 'sessions.describe') {
      const key = String(params?.key);
      return key.endsWith(':finished')
        ? {
            session: {
              sessionId: 'session-finished',
              model: 'model-finished',
              status: 'running',
              subagentRunState: 'active',
              updatedAt: 500,
            },
          }
        : {
            session: {
              sessionId: 'session-running',
              model: 'model-running',
              status: 'running',
              updatedAt: 601,
            },
          };
    }
    if (method === 'sessions.list') throw new Error('temporary list failure');
    throw new Error(`unexpected ${method}`);
  });

  await expect(
    listGatewaySubagents({
      client: gatewayClient(request as GatewayClientLike['request']),
      parentKeys: ['agent:main:justdo:parent'],
      hydrateTaskDetails: false,
    }),
  ).resolves.toMatchObject([
    { id: 'task-finished', status: 'done', sessionId: 'session-finished', model: 'model-finished' },
    { id: 'task-running', status: 'running', sessionId: 'session-running', model: 'model-running' },
  ]);
});

test('maps a blocked terminal outcome without presenting it as success', async () => {
  const request = vi.fn().mockResolvedValue({
    tasks: [
      {
        id: 'task-blocked',
        runtime: 'subagent',
        status: 'completed',
        terminalOutcome: 'blocked',
        childSessionKey: 'agent:main:subagent:blocked',
      },
    ],
  });

  const result = await listGatewaySubagents({
    client: gatewayClient(request as GatewayClientLike['request']),
    parentKeys: ['agent:main:justdo:parent'],
    hydrateDetails: false,
  });

  expect(result[0]?.status).toBe('blocked');
});

test('paginates the native task ledger and validates forward cursors', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      tasks: [
        {
          id: 'one',
          runtime: 'subagent',
          status: 'running',
          childSessionKey: 'agent:main:subagent:one',
        },
      ],
      nextCursor: '1',
    })
    .mockResolvedValueOnce({
      tasks: [
        {
          id: 'two',
          runtime: 'subagent',
          status: 'completed',
          childSessionKey: 'agent:main:subagent:two',
        },
      ],
    });

  const result = await listGatewaySubagents({
    client: gatewayClient(request as GatewayClientLike['request']),
    parentKeys: ['agent:main:justdo:parent'],
    hydrateDetails: false,
  });
  expect(result.map(item => item.id)).toEqual(['one', 'two']);
  expect(request).toHaveBeenNthCalledWith(2, 'tasks.list', {
    sessionKey: 'agent:main:justdo:parent',
    limit: 500,
    cursor: '1',
  });
});

test('enumerates nested descendants using tasks.list and resolves native session ids', async () => {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'tasks.list' && params?.sessionKey === 'agent:main:justdo:parent') {
      return {
        tasks: [
          {
            id: 'child-task',
            runtime: 'subagent',
            status: 'running',
            title: 'Child',
            childSessionKey: 'agent:main:subagent:child',
          },
        ],
      };
    }
    if (method === 'tasks.list' && params?.sessionKey === 'agent:main:subagent:child') {
      return {
        tasks: [
          {
            id: 'grandchild-task',
            runtime: 'subagent',
            status: 'completed',
            title: 'Grandchild',
            childSessionKey: 'agent:main:subagent:grandchild',
          },
        ],
      };
    }
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.describe') {
      return { session: { sessionId: `sid-${String(params?.key).split(':').pop()}` } };
    }
    throw new Error(`unexpected ${method}`);
  });

  await expect(
    listGatewaySubagentDescendants(
      gatewayClient(request as GatewayClientLike['request']),
      ['agent:main:justdo:parent'],
    ),
  ).resolves.toEqual([
    {
      sessionKey: 'agent:main:subagent:child',
      sessionId: 'sid-child',
      label: 'Child',
    },
    {
      sessionKey: 'agent:main:subagent:grandchild',
      sessionId: 'sid-grandchild',
      label: 'Grandchild',
    },
  ]);
});

test('reports an incomplete task ledger without falling back to the old subagents tool', async () => {
  const request = vi.fn().mockRejectedValue(new Error('task ledger unavailable'));

  await expect(
    listGatewaySubagentsWithMetadata({
      client: gatewayClient(request as GatewayClientLike['request']),
      parentKeys: ['agent:main:justdo:parent'],
    }),
  ).resolves.toEqual({
    subagents: [],
    taskLedgerComplete: false,
  });
  expect(request.mock.calls.some(([method]) => method === 'tools.invoke')).toBe(false);
  expect(request.mock.calls.some(([method]) => method === 'sessions.list')).toBe(false);
});

test('merges current task status while keeping a stronger readable title', () => {
  const retained = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Readable title',
      labelSource: 'label' as const,
      status: 'running' as const,
      startedAt: 100,
    },
  ];
  const current = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'task-one',
      labelSource: 'taskName' as const,
      status: 'done' as const,
      endedAt: 200,
    },
  ];

  expect(mergeGatewaySubagentSnapshots(retained, current)).toEqual([
    {
      ...retained[0],
      status: 'done',
      endedAt: 200,
    },
  ]);
});

test('clears terminal-only fields when a task is reactivated', () => {
  const retained = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Task',
      labelSource: 'label' as const,
      status: 'failed' as const,
      runId: 'old-run',
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
      terminalSummary: 'Old result',
      error: 'Old failure',
    },
  ];
  const current = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Task',
      labelSource: 'label' as const,
      status: 'pending' as const,
    },
  ];

  expect(mergeGatewaySubagentSnapshots(retained, current)[0]).toMatchObject({
    status: 'pending',
  });
  expect(mergeGatewaySubagentSnapshots(retained, current)[0]).not.toHaveProperty('startedAt');
  expect(mergeGatewaySubagentSnapshots(retained, current)[0]).not.toHaveProperty('runId');
  expect(mergeGatewaySubagentSnapshots(retained, current)[0]).not.toHaveProperty('endedAt');
  expect(mergeGatewaySubagentSnapshots(retained, current)[0]).not.toHaveProperty('runtimeMs');
  expect(mergeGatewaySubagentSnapshots(retained, current)[0]).not.toHaveProperty('error');
});

test('does not carry a previous failure into a later successful terminal generation', () => {
  const retained = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Task',
      labelSource: 'label' as const,
      status: 'failed' as const,
      endedAt: 200,
      error: 'Old failure',
    },
  ];
  const current = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Task',
      labelSource: 'label' as const,
      status: 'done' as const,
      endedAt: 400,
    },
  ];

  const merged = mergeGatewaySubagentSnapshots(retained, current)[0];
  expect(merged).toMatchObject({ status: 'done', endedAt: 400 });
  expect(merged).not.toHaveProperty('error');
});

test('does not reuse terminal fields across same-status generations', () => {
  const retained = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Task',
      labelSource: 'label' as const,
      status: 'failed' as const,
      updatedAt: 200,
      endedAt: 200,
      terminalSummary: 'Old failure',
      error: 'Old error',
    },
  ];
  const current = [
    {
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:one',
      label: 'Task',
      labelSource: 'label' as const,
      status: 'failed' as const,
      updatedAt: 400,
      endedAt: 400,
    },
  ];

  const merged = mergeGatewaySubagentSnapshots(retained, current)[0];
  expect(merged).toMatchObject({ status: 'failed', updatedAt: 400, endedAt: 400 });
  expect(merged).not.toHaveProperty('terminalSummary');
  expect(merged).not.toHaveProperty('error');
});

import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import {
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
          prompt: 'Inspect the implementation.',
        },
      };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:subagent:child',
            sessionId: 'session-child',
            model: 'gpt-5.6',
            totalTokens: 42,
          },
        ],
        hasMore: false,
        nextOffset: null,
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
      startedAt: 100,
      endedAt: undefined,
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

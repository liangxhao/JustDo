import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import { listGatewaySubagentDescendants, listGatewaySubagents } from './subagentGateway';

test('lists every nested subagent descendant from the complete session projection', async () => {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:subagent:child-1',
            sessionId: 'child-session-id',
            spawnedBy: 'agent:main:cowork:parent',
            taskName: 'Child task',
          },
          {
            key: 'agent:main:subagent:grandchild-1',
            parentSessionKey: 'agent:main:subagent:child-1',
            task: 'Grandchild task details',
          },
          {
            key: 'agent:main:subagent:unrelated',
            sessionId: 'unrelated-session-id',
            spawnedBy: 'agent:main:cowork:other',
          },
        ],
      };
    }
    if (method === 'sessions.describe') {
      expect(params).toEqual({ key: 'agent:main:subagent:grandchild-1' });
      return { session: { sessionId: 'grandchild-session-id' } };
    }
    return {};
  });

  await expect(
    listGatewaySubagentDescendants(
      { request } as unknown as GatewayClientLike,
      ['agent:main:cowork:parent'],
    ),
  ).resolves.toEqual([
    {
      sessionKey: 'agent:main:subagent:child-1',
      sessionId: 'child-session-id',
      label: 'Child task',
    },
    {
      sessionKey: 'agent:main:subagent:grandchild-1',
      sessionId: 'grandchild-session-id',
      label: 'Grandchild task details',
    },
  ]);
});

test('does not silently downgrade descendant enumeration when the complete scan fails', async () => {
  const request = vi.fn().mockRejectedValue(new Error('session scan failed'));

  await expect(
    listGatewaySubagentDescendants(
      { request } as unknown as GatewayClientLike,
      ['agent:main:cowork:parent'],
    ),
  ).rejects.toThrow('session scan failed');
});

test('lists subagents from the registry-backed sessions projection', async () => {
  const request = vi.fn().mockImplementation(async (method: string) =>
    method === 'tools.invoke'
      ? {
          ok: true,
          output: {
            details: {
              status: 'ok',
              active: [
                {
                  sessionKey: 'agent:main:subagent:running',
                  taskName: 'research-task',
                  label: 'Research instructions',
                  task: 'Research the topic',
                  status: 'running',
                  model: 'openai/gpt-5',
                  startedAt: 100,
                  runtimeMs: 50,
                  totalTokens: 42,
                },
              ],
              recent: [],
            },
          },
        }
      : {
          sessions: [
            {
              key: 'agent:main:subagent:running',
              sessionId: 'running-session-id',
              derivedTitle: 'Changing title',
              status: 'done',
            },
            {
              key: 'agent:main:subagent:timeout',
              sessionId: 'timeout-session-id',
              label: 'Slow worker',
              status: 'timeout',
              subagentRunState: 'historical',
              model: 'openai/gpt-5',
              startedAt: 100,
              endedAt: 200,
              runtimeMs: 100,
              totalTokens: 42,
            },
          ],
        },
  );

  const subagents = await listGatewaySubagents({
    client: { request } as unknown as GatewayClientLike,
    parentKeys: ['agent:main:cowork:parent'],
  });

  expect(request).toHaveBeenCalledWith('sessions.list', {
    spawnedBy: 'agent:main:cowork:parent',
    limit: 100,
  });
  expect(request).toHaveBeenCalledWith('sessions.list', {
    limit: 500,
    offset: 0,
  });
  expect(request).toHaveBeenCalledWith('tools.invoke', {
    name: 'subagents',
    args: {
      action: 'list',
      recentMinutes: 1440,
    },
    sessionKey: 'agent:main:cowork:parent',
  });
  expect(subagents).toEqual([
    {
      id: 'agent:main:subagent:running',
      sessionKey: 'agent:main:subagent:running',
      sessionId: 'running-session-id',
      label: 'research-task',
      labelSource: 'taskName',
      status: 'running',
      task: 'Research the topic',
      model: 'openai/gpt-5',
      startedAt: 100,
      runtimeMs: 50,
      totalTokens: 42,
    },
    {
      id: 'agent:main:subagent:timeout',
      sessionKey: 'agent:main:subagent:timeout',
      sessionId: 'timeout-session-id',
      label: 'Slow worker',
      labelSource: 'label',
      status: 'timeout',
      model: 'openai/gpt-5',
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
      totalTokens: 42,
    },
  ]);
});

test('uses persisted taskName instead of a transcript-derived title', async () => {
  const client = {
    request: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'tools.invoke') {
        return {
          ok: true,
          output: {
            details: {
              status: 'ok',
              active: [],
              recent: [
                {
                  sessionKey: 'agent:main:subagent:b3577f7e-222a-4a2d-b683-5ce4548b2920',
                  label: '6a6891e1 (2026-08-16)',
                  task: 'Research recent environmental news',
                  status: 'done',
                },
              ],
            },
          },
        };
      }
      return {
        sessions: params?.spawnedBy
          ? [
              {
                key: 'agent:main:subagent:b3577f7e-222a-4a2d-b683-5ce4548b2920',
                sessionId: '6a6891e1-9dc4-4744-936b-2edb99f928e6',
                taskName: 'news_environment',
                derivedTitle: '[Subagent Context] internal prompt',
                task: 'Research recent environmental news',
                status: 'done',
              },
            ]
          : [],
      };
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({
      client,
      parentKeys: ['agent:main:cowork:6d2a40c5-2ebf-495b-8968-fa551b80e64a'],
    }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:b3577f7e-222a-4a2d-b683-5ce4548b2920',
      sessionId: '6a6891e1-9dc4-4744-936b-2edb99f928e6',
      label: 'news_environment',
      labelSource: 'taskName',
      task: 'Research recent environmental news',
      status: 'done',
    },
  ]);
});

test('does not let a session label replace a structured taskName', async () => {
  const client = {
    request: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'tools.invoke') {
        return {
          ok: true,
          output: {
            details: {
              status: 'ok',
              active: [],
              recent: [
                {
                  sessionKey: 'agent:main:subagent:named-task',
                  taskName: 'research-task',
                  label: 'Research instructions',
                  task: 'Research the topic',
                  status: 'done',
                },
              ],
            },
          },
        };
      }
      return {
        sessions: params?.spawnedBy
          ? [
              {
                key: 'agent:main:subagent:named-task',
                label: 'Changing title',
                task: 'Research the topic',
                status: 'done',
              },
            ]
          : [],
      };
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:named-task',
      label: 'research-task',
      labelSource: 'taskName',
      task: 'Research the topic',
    },
  ]);
});

test('keeps persisted subagents after OpenClaw child links age out', async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    key: `agent:main:cowork:filler-${index}`,
  }));
  const client = {
    request: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'tools.invoke') {
        return {
          ok: true,
          output: {
            details: {
              status: 'ok',
              active: [],
              recent: [],
            },
          },
        };
      }
      if (params?.spawnedBy) {
        return { sessions: [] };
      }
      if (params?.offset === 0) {
        return { sessions: firstPage };
      }
      return {
        sessions: [
          {
            key: 'agent:main:subagent:old-worker',
            sessionId: 'old-worker-session-id',
            spawnedBy: 'agent:main:cowork:parent',
            task: 'Old retained task',
            status: 'done',
            endedAt: 100,
          },
          {
            key: 'agent:main:subagent:other-parent',
            spawnedBy: 'agent:main:cowork:other',
            task: 'Must stay hidden',
            status: 'done',
          },
        ],
      };
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:old-worker',
      sessionId: 'old-worker-session-id',
      task: 'Old retained task',
      status: 'done',
      endedAt: 100,
    },
  ]);
  expect(client.request).toHaveBeenCalledWith('sessions.list', {
    limit: 500,
    offset: 500,
  });
});

test('can skip persisted history lookup for lightweight runtime polling', async () => {
  const client = {
    request: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'tools.invoke') {
        return {
          ok: true,
          output: {
            details: {
              status: 'ok',
              active: [],
              recent: [],
            },
          },
        };
      }
      return {
        sessions: params?.spawnedBy
          ? [
              {
                key: 'agent:main:subagent:live-child',
                spawnedBy: 'agent:main:cowork:parent',
                task: 'Live child task',
                status: 'running',
              },
            ]
          : [
              {
                key: 'agent:main:subagent:persisted-only',
                spawnedBy: 'agent:main:cowork:parent',
                task: 'Persisted child task',
                status: 'done',
              },
            ],
      };
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({
      client,
      parentKeys: ['agent:main:cowork:parent'],
      includePersistedHistory: false,
    }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:live-child',
      status: 'running',
    },
  ]);
  expect(client.request).not.toHaveBeenCalledWith('sessions.list', {
    limit: 500,
    offset: 0,
  });
});

test('maps a recovered active child session to running', async () => {
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:recovered-child',
          spawnedBy: 'agent:main:cowork:parent',
          task: 'Recovered child task',
          status: 'done',
          hasActiveRun: true,
        },
      ],
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({
      client,
      parentKeys: ['agent:main:cowork:parent'],
      includePersistedHistory: false,
      includeStructuredTool: false,
    }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:recovered-child',
      status: 'running',
    },
  ]);
});

test('preserves pending before generic active flags in the session projection', async () => {
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:queued-child',
          spawnedBy: 'agent:main:cowork:parent',
          task: 'Queued child task',
          status: 'pending',
          subagentRunState: 'pending',
          hasActiveSubagentRun: true,
        },
      ],
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({
      client,
      parentKeys: ['agent:main:cowork:parent'],
      includePersistedHistory: false,
      includeStructuredTool: false,
    }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:queued-child',
      status: 'pending',
    },
  ]);
});

test('waits until projections are merged before warning about missing title metadata', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const client = {
    request: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'tools.invoke') {
        return {
          ok: true,
          output: {
            status: 'ok',
            details: {
              active: [
                {
                  sessionKey: 'agent:main:subagent:late-title',
                  status: 'running',
                },
              ],
              recent: [],
            },
          },
        };
      }
      return {
        sessions: params?.spawnedBy
          ? [
              {
                key: 'agent:main:subagent:late-title',
                task: 'Durable task metadata',
                status: 'running',
              },
            ]
          : [],
      };
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toMatchObject([{ label: 'Durable task metadata', labelSource: 'task' }]);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

test('maps structured pending rows without creating fallback failures', async () => {
  const client = {
    request: vi.fn().mockImplementation(async (method: string) =>
      method === 'tools.invoke'
        ? {
            ok: true,
            output: {
              details: {
                status: 'ok',
                active: [
                  {
                    sessionKey: 'agent:main:subagent:queued-child',
                    label: 'Queued worker',
                    status: 'pending',
                  },
                ],
                recent: [],
              },
            },
          }
        : { sessions: [] },
    ),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({
      client,
      parentKeys: ['agent:main:cowork:parent'],
      includePersistedHistory: false,
    }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:queued-child',
      label: 'Queued worker',
      status: 'pending',
    },
  ]);
});

test('maps interrupted registry rows to failed', async () => {
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:interrupted',
          task: 'Interrupted worker task',
          subagentRunState: 'interrupted',
        },
      ],
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toMatchObject([{ status: 'failed' }]);
});

test('falls back to the session projection when structured tool invocation fails', async () => {
  const client = {
    request: vi.fn().mockImplementation(async (method: string) => {
      if (method === 'tools.invoke') throw new Error('Tool unavailable');
      return {
        sessions: [
          {
            key: 'agent:main:subagent:fallback',
            label: 'Fallback worker',
            status: 'done',
          },
        ],
      };
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toMatchObject([
    {
      sessionKey: 'agent:main:subagent:fallback',
      label: 'Fallback worker',
      status: 'done',
    },
  ]);
});

test('prefers registry task fields and never uses the last reply as a title', async () => {
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:task-name',
          taskName: 'Named task',
          task: 'Long task instructions',
          lastMessagePreview: 'This must not become the title',
          status: 'done',
        },
        {
          key: 'agent:main:subagent:task',
          task: 'Fallback task instructions',
          lastMessagePreview: 'This must not become the title either',
          status: 'done',
        },
      ],
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toMatchObject([
    { label: 'Named task', labelSource: 'taskName' },
    { label: 'Fallback task instructions', labelSource: 'task' },
  ]);
});

test('uses the first non-empty task line and truncates it without splitting emoji', async () => {
  const longTask = `\n\n  ${'研究😀'.repeat(20)}  \nIgnore this line`;
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:task-summary',
          task: longTask,
          status: 'done',
        },
      ],
    }),
  } as unknown as GatewayClientLike;

  const result = await listGatewaySubagents({
    client,
    parentKeys: ['agent:main:cowork:parent'],
  });

  expect(Array.from(result[0]?.label ?? '')).toHaveLength(49);
  expect(result[0]).toMatchObject({
    label: `${Array.from('研究😀'.repeat(20)).slice(0, 48).join('')}…`,
    labelSource: 'task',
  });
});

test('skips malformed rows and warns only once per session key', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:missing-title-fields',
          derivedTitle: '[Subagent Context] must stay hidden',
          displayName: 'Must stay hidden too',
          status: 'done',
        },
      ],
    }),
  } as unknown as GatewayClientLike;

  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toEqual([]);
  await expect(
    listGatewaySubagents({ client, parentKeys: ['agent:main:cowork:parent'] }),
  ).resolves.toEqual([]);

  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    '[SubagentGateway] Skipping subagent without taskName, label, or task',
    { sessionKey: 'agent:main:subagent:missing-title-fields' },
  );
  warn.mockRestore();
});

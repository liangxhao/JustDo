import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import { listGatewaySubagents } from './subagentGateway';

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
              displayName: 'Slow worker',
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
    includeDerivedTitles: true,
  });
  expect(request).toHaveBeenCalledWith('sessions.list', {
    limit: 500,
    offset: 0,
    includeDerivedTitles: true,
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
      status: 'timeout',
      model: 'openai/gpt-5',
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
      totalTokens: 42,
    },
  ]);
});

test('replaces internal fallback labels with the persisted session title', async () => {
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
                  sessionKey: 'agent:main:subagent:child-20',
                  label: '93624b49 (2026-07-15)',
                  task: '请写一句中文祝福语，主题是"万事如意"。',
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
                key: 'agent:main:subagent:child-20',
                sessionId: '93624b49-cad5-41de-944f-8cbae6a70108',
                derivedTitle: 'blessing_20',
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
      sessionKey: 'agent:main:subagent:child-20',
      sessionId: '93624b49-cad5-41de-944f-8cbae6a70108',
      label: 'blessing_20',
      task: '请写一句中文祝福语，主题是"万事如意"。',
      status: 'done',
    },
  ]);
});

test('keeps explicit structured task names when the session projection also has a title', async () => {
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
                derivedTitle: 'Changing title',
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
    includeDerivedTitles: true,
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
                status: 'running',
              },
            ]
          : [
              {
                key: 'agent:main:subagent:persisted-only',
                spawnedBy: 'agent:main:cowork:parent',
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
    includeDerivedTitles: true,
  });
});

test('maps a recovered active child session to running', async () => {
  const client = {
    request: vi.fn().mockResolvedValue({
      sessions: [
        {
          key: 'agent:main:subagent:recovered-child',
          spawnedBy: 'agent:main:cowork:parent',
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
          derivedTitle: 'Interrupted worker',
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
    { label: 'Named task' },
    { label: 'Fallback task instructions' },
  ]);
});

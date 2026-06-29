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
              derivedTitle: 'Changing title',
              status: 'done',
            },
            {
              key: 'agent:main:subagent:timeout',
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

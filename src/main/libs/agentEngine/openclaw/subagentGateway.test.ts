import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import { listGatewaySubagents } from './subagentGateway';

test('lists subagents from the registry-backed sessions projection', async () => {
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:subagent:running',
        label: 'Research',
        status: 'done',
        subagentRunState: 'active',
        hasActiveSubagentRun: true,
      },
      {
        key: 'agent:main:subagent:timeout',
        displayName: 'Slow worker',
        status: 'timeout',
        subagentRunState: 'historical',
      },
      {
        key: 'agent:main:direct:not-a-subagent',
        status: 'running',
      },
    ],
  });

  const subagents = await listGatewaySubagents({
    client: { request } as unknown as GatewayClientLike,
    parentKeys: ['agent:main:cowork:parent'],
  });

  expect(request).toHaveBeenCalledWith('sessions.list', {
    spawnedBy: 'agent:main:cowork:parent',
    limit: 100,
    includeDerivedTitles: true,
  });
  expect(subagents).toEqual([
    {
      id: 'agent:main:subagent:running',
      sessionKey: 'agent:main:subagent:running',
      label: 'Research',
      status: 'running',
    },
    {
      id: 'agent:main:subagent:timeout',
      sessionKey: 'agent:main:subagent:timeout',
      label: 'Slow worker',
      status: 'timeout',
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

import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import {
  getGatewaySubagentDetails,
  listGatewaySubagentDescendants,
  listGatewaySubagents,
  listGatewaySubagentsWithMetadata,
  listPersistedGatewaySessions,
  mergeGatewaySubagentSnapshots,
} from './subagentGateway';
const root = 'agent:main:justdo:parent';
const child = 'agent:main:subagent:child';
const client = (request: ReturnType<typeof vi.fn>) => ({ request }) as unknown as GatewayClientLike;
const row = {
  key: child,
  sessionId: 'native-child',
  spawnedBy: root,
  status: 'running',
  label: 'Review',
  updatedAt: 10,
  activeRunIds: ['run-1'],
};

test('projects native session lifecycle and stable identities without task RPCs', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ sessions: [row, { ...row, key: 'unrelated', spawnedBy: 'other' }] });
  const result = await listGatewaySubagents({ client: client(request), parentKeys: [root] });
  expect(result).toMatchObject([
    {
      id: child,
      taskName: child,
      sessionKey: child,
      sessionId: 'native-child',
      label: 'Review',
      status: 'running',
      runId: 'run-1',
      parentTaskId: root,
    },
  ]);
  expect(request).toHaveBeenCalledWith('sessions.list', {
    limit: 500,
    offset: 0,
    archived: 'all',
  });
});

test.each([
  ['queued', 'pending'],
  ['done', 'done'],
  ['failed', 'failed'],
  ['killed', 'killed'],
  ['interrupted', 'killed'],
  ['timeout', 'timeout'],
])('maps native %s lifecycle to %s', async (native, expected) => {
  const request = vi.fn().mockResolvedValue({
    session: {
      ...row,
      status: native,
      lastRunId: 'finished',
      lastRunError: 'failure',
      endedAt: 20,
    },
  });
  const value = await getGatewaySubagentDetails(client(request), child);
  expect(value?.status).toBe(expected);
  expect(value?.runId).toBe(native === 'queued' ? 'run-1' : 'finished');
});

test('clears prior terminal state when a native session starts a new run', async () => {
  const request = vi.fn().mockResolvedValue({
    session: { ...row, lastRunError: 'previous', endedAt: 1, lastRunId: 'old' },
  });
  const value = await getGatewaySubagentDetails(client(request), child);
  expect(value).toMatchObject({ status: 'running', runId: 'run-1' });
  expect(value?.error).toBeUndefined();
  expect(value?.endedAt).toBeUndefined();
});

test('preserves explicit native Swarm membership in lists and details only', async () => {
  const member = { ...row, swarmGroupId: 'swarm:parent:run-1' };
  const request = vi.fn().mockResolvedValue({ sessions: [member], session: member });
  const list = await listGatewaySubagents({ client: client(request), parentKeys: [root] });
  expect(list[0].swarmGroupId).toBe(member.swarmGroupId);
  expect((await getGatewaySubagentDetails(client(request), child))?.swarmGroupId).toBe(
    member.swarmGroupId,
  );
  request.mockResolvedValue({ session: { ...row, groupId: 'chat-group', swarmGroupId: 42 } });
  expect((await getGatewaySubagentDetails(client(request), child))?.swarmGroupId).toBeUndefined();
});

test('uses native active run identity and configured model for ACP sessions', async () => {
  const request = vi.fn().mockResolvedValue({
    session: {
      ...row,
      agentRuntime: { id: 'acp', source: 'session' },
      model: 'model',
      modelProvider: 'provider',
      runtimeMs: 42,
      snapshotAt: 100,
      totalTokens: 50,
    },
  });
  expect(await getGatewaySubagentDetails(client(request), child)).toMatchObject({
    runtime: 'acp',
    model: 'provider/model',
    runtimeMs: 42,
    runtimeSampledAt: 100,
    totalTokens: 50,
  });
});

test('rejects a mismatched describe result and root rows', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ session: { ...row, key: 'wrong' } })
    .mockResolvedValueOnce({ session: { ...row, spawnedBy: undefined } });
  expect(await getGatewaySubagentDetails(client(request), child)).toBeNull();
  expect(await getGatewaySubagentDetails(client(request), child)).toBeNull();
});

test('reads every native page and includes archived children', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ sessions: [row], hasMore: true, nextOffset: 500 })
    .mockResolvedValueOnce({
      sessions: [{ ...row, key: 'second', archived: true }],
      hasMore: false,
    });
  expect(await listPersistedGatewaySessions(client(request))).toHaveLength(2);
  expect(request).toHaveBeenLastCalledWith('sessions.list', {
    limit: 500,
    offset: 500,
    archived: 'all',
  });
});

test('lists completed Swarm children after native control-link filtering expires', async () => {
  const request = vi.fn(async (_method, params) => {
    if (params.spawnedBy) return { sessions: [] };
    if (!params.offset)
      return {
        sessions: [{ ...row, key: 'unrelated', spawnedBy: 'other' }],
        hasMore: true,
        nextOffset: 500,
      };
    return { sessions: [{ ...row, status: 'done', swarmGroupId: 'batch', archivedAt: 1 }] };
  });
  const result = await listGatewaySubagentsWithMetadata({
    client: client(request),
    parentKeys: [root, 'alias'],
  });
  expect(result.sessionListComplete).toBe(true);
  expect(result.subagents).toMatchObject([{ id: child, status: 'done', swarmGroupId: 'batch' }]);
  expect(result.subagents).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([, params]) => params.spawnedBy === undefined)).toBe(true);
});

test.each([{ hasMore: true }, { hasMore: true, nextOffset: 0 }])(
  'fails closed when a native page cannot advance',
  async page => {
    const request = vi.fn().mockResolvedValue({ sessions: [], ...page });
    await expect(
      listGatewaySubagents({ client: client(request), parentKeys: [root], requireComplete: true }),
    ).rejects.toThrow('incomplete');
    expect(request).toHaveBeenCalledTimes(1);
  },
);

test('reports incomplete reads rather than claiming an empty native graph', async () => {
  const request = vi.fn().mockRejectedValue(new Error('offline'));
  expect(
    await listGatewaySubagentsWithMetadata({ client: client(request), parentKeys: [root] }),
  ).toEqual({ subagents: [], sessionListComplete: false });
});

test('discovers nested native descendants and rejects missing incarnation IDs', async () => {
  const grandchild = 'agent:main:subagent:grandchild';
  const request = vi.fn().mockResolvedValue({
    sessions: [row, { ...row, key: grandchild, spawnedBy: child, sessionId: 'native-grandchild' }],
  });
  expect(await listGatewaySubagentDescendants(client(request), [root])).toEqual([
    { sessionKey: child, sessionId: 'native-child', label: 'Review' },
    { sessionKey: grandchild, sessionId: 'native-grandchild', label: 'Review' },
  ]);
  request.mockResolvedValue({ sessions: [{ ...row, sessionId: undefined }] });
  await expect(listGatewaySubagentDescendants(client(request), [root])).rejects.toThrow(
    'Session ID unavailable',
  );
});

test('partial-read merging preserves newer lifecycle evidence', async () => {
  const request = vi.fn().mockResolvedValue({ session: row });
  const value = (await getGatewaySubagentDetails(client(request), child))!;
  expect(
    mergeGatewaySubagentSnapshots(
      [{ ...value, updatedAt: 20, status: 'done', runId: 'finished' }],
      [{ ...value, updatedAt: 10 }],
    )[0],
  ).toMatchObject({ status: 'done', runId: 'finished', updatedAt: 20 });
});

test.each([
  ['historical', 'unknown'],
  ['interrupted', 'killed'],
  [undefined, 'unknown'],
])('does not invent queued work from missing lifecycle status (%s)', async (state, expected) => {
  const request = vi.fn().mockResolvedValue({
    session: { ...row, status: undefined, subagentRunState: state, activeRunIds: [] },
  });
  expect((await getGatewaySubagentDetails(client(request), child))?.status).toBe(expected);
});

test('unknown lifecycle cannot confirm descendant settlement', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ sessions: [{ ...row, status: undefined, activeRunIds: [] }] });
  await expect(
    listGatewaySubagents({ client: client(request), parentKeys: [root], requireComplete: true }),
  ).rejects.toThrow('incomplete');
});

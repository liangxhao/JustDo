import { expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import {
  controlGatewaySubagent,
  listGatewaySubagentChildren,
  requireGatewaySubagentOwnership,
} from './subagentGateway';
const root = 'agent:main:justdo:root',
  child = 'agent:main:subagent:child';
const row = { key: child, sessionId: 'child-id', spawnedBy: root, status: 'running' };
const client = (request: ReturnType<typeof vi.fn>) => ({ request }) as unknown as GatewayClientLike;

test('cancels a verified native child and clears queued followups', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ session: row })
    .mockResolvedValueOnce({ session: row })
    .mockResolvedValueOnce({ ok: true, status: 'aborted' });
  expect(await controlGatewaySubagent(client(request), [root], child, 'cancel')).toEqual({
    success: true,
  });
  expect(request.mock.calls).toEqual([
    ['sessions.describe', { key: child }],
    ['sessions.describe', { key: child }],
    ['sessions.abort', { key: child, clearQueued: true }],
  ]);
});

test.each(['no-active-run', 'aborted'])(
  'accepts native terminal cancellation acknowledgment %s',
  async status => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: row })
      .mockResolvedValueOnce({ session: row })
      .mockResolvedValueOnce({ ok: true, status });
    expect(await controlGatewaySubagent(client(request), [root], child, 'cancel')).toEqual({
      success: true,
    });
  },
);

test('does not claim cancellation from an ambiguous gateway reply', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ session: row })
    .mockResolvedValueOnce({ session: row })
    .mockResolvedValueOnce({ ok: true });
  expect(await controlGatewaySubagent(client(request), [root], child, 'cancel')).toMatchObject({
    success: false,
  });
});

test('authorizes nested children through exact native control ancestry', async () => {
  const middle = 'agent:main:subagent:middle';
  const request = vi
    .fn()
    .mockResolvedValueOnce({ session: { ...row, spawnedBy: middle } })
    .mockResolvedValueOnce({ session: { ...row, key: middle } });
  expect(await requireGatewaySubagentOwnership(client(request), [root], child)).toMatchObject({
    id: child,
  });
  expect(request).toHaveBeenLastCalledWith('sessions.describe', { key: middle });
});

test.each([
  { spawnedBy: 'unrelated' },
  { spawnedBy: child },
  { spawnedBy: undefined, parentSessionKey: root },
])('rejects unrelated, cyclic and navigation-only ancestry: %j', async override => {
  const request = vi.fn(async (_method, params) => ({
    session: params.key === child ? { ...row, ...override } : null,
  }));
  await expect(controlGatewaySubagent(client(request), [root], child, 'cancel')).rejects.toThrow();
  expect(request.mock.calls.every(([method]) => method === 'sessions.describe')).toBe(true);
});

test('rejects removed delivery mutations without contacting gateway', async () => {
  const request = vi.fn();
  await expect(
    controlGatewaySubagent(client(request), [root], child, 'retryDelivery' as never),
  ).rejects.toThrow('Unknown');
  await expect(
    controlGatewaySubagent(client(request), [root], child, 'dismissDelivery' as never),
  ).rejects.toThrow('Unknown');
  expect(request).not.toHaveBeenCalled();
});

test('paginates aliases with a scope-bound cursor and exact native offset', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ sessions: [row], hasMore: true, nextOffset: 50 })
    .mockResolvedValueOnce({ sessions: [], hasMore: false })
    .mockResolvedValueOnce({ sessions: [], hasMore: false });
  const first = await listGatewaySubagentChildren(client(request), [root, 'alias']);
  expect(first.subagents).toHaveLength(1);
  const second = await listGatewaySubagentChildren(
    client(request),
    [root, 'alias'],
    undefined,
    first.nextCursor,
  );
  expect(request).toHaveBeenLastCalledWith('sessions.list', {
    spawnedBy: root,
    archived: 'all',
    offset: 50,
    limit: 50,
  });
  await listGatewaySubagentChildren(client(request), [root, 'alias'], undefined, second.nextCursor);
  expect(request).toHaveBeenLastCalledWith('sessions.list', {
    spawnedBy: 'alias',
    archived: 'all',
    offset: 0,
    limit: 50,
  });
  await expect(
    listGatewaySubagentChildren(client(request), ['other'], undefined, first.nextCursor),
  ).rejects.toThrow('Invalid session page cursor');
});

test('reauthorizes the parent before exposing nested children', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ session: row })
    .mockResolvedValueOnce({ sessions: [] });
  expect(await listGatewaySubagentChildren(client(request), [root], child)).toEqual({
    subagents: [],
  });
  expect(request).toHaveBeenLastCalledWith('sessions.list', {
    spawnedBy: child,
    archived: 'all',
    offset: 0,
    limit: 50,
  });
});

test.each([{ sessionId: 'replacement' }, { spawnedBy: 'other' }, { activeRunIds: ['new-run'] }])(
  'rejects identity changes after ancestry reads: %j',
  async change => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: row })
      .mockResolvedValueOnce({ session: { ...row, ...change } });
    await expect(controlGatewaySubagent(client(request), [root], child, 'cancel')).rejects.toThrow(
      'identity changed',
    );
    expect(request.mock.calls.every(([method]) => method === 'sessions.describe')).toBe(true);
  },
);

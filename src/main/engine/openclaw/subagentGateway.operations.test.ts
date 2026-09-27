import { describe, expect, it, vi } from 'vitest';

import type { GatewayClientLike } from '../gateway/types';
import {
  controlGatewaySubagent,
  getGatewaySubagentDetails,
  listGatewaySubagentChildren,
  requireGatewaySubagentOwnership,
} from './subagentGateway';
import { parseTaskSummaryV2026_9_2 } from './wire/v2026_9_2';

const root = 'agent:main:justdo:root';
const child = 'agent:main:subagent:one';
const task = {
  id: 'one',
  runtime: 'subagent',
  status: 'running',
  sessionKey: root,
  childSessionKey: child,
};
const client = (request: ReturnType<typeof vi.fn>) => ({ request }) as unknown as GatewayClientLike;

describe('exact task details', () => {
  it('retains verified task details when optional session metadata is unavailable', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'tasks.get') {
        return {
          task: {
            ...task,
            status: 'failed',
            prompt: 'Review the report',
            error: 'Model unavailable',
          },
        };
      }
      throw new Error('Session metadata unavailable');
    });
    await expect(getGatewaySubagentDetails(client(request), 'one')).resolves.toMatchObject({
      id: 'one',
      sessionKey: child,
      status: 'failed',
      task: 'Review the report',
      error: 'Model unavailable',
    });
    expect(request.mock.calls.map(call => call[0])).toEqual(['tasks.get', 'sessions.describe']);
  });

  it('rejects a different task in the same child session before enriching details', async () => {
    const request = vi.fn().mockResolvedValue({ task: { ...task, id: 'another-task' } });
    await expect(getGatewaySubagentDetails(client(request), 'one')).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('native task controls', () => {
  it.each([
    ['cancel', 'tasks.cancel', { taskId: 'one' }, { found: true, cancelled: true }],
    [
      'retryDelivery',
      'tasks.retry',
      { taskIds: ['one'] },
      { results: [{ taskId: 'one', ok: true, duplicateRisk: true }] },
    ],
    [
      'dismissDelivery',
      'tasks.dismiss',
      { taskIds: ['one'] },
      { results: [{ taskId: 'one', ok: true }] },
    ],
  ] as const)(
    'checks the native requester before %s and forwards exact task identity',
    async (action, method, params, reply) => {
      const request = vi.fn(async (name: string) => (name === 'tasks.get' ? { task } : reply));
      const result = await controlGatewaySubagent(client(request), [root], 'one', action);
      expect(result).toEqual({
        success: true,
        ...(action === 'retryDelivery' ? { duplicateRisk: true } : {}),
      });
      expect(request.mock.calls.map(call => call[0])).toEqual(['tasks.get', method]);
      expect(request).toHaveBeenLastCalledWith(method, params);
    },
  );

  it('rejects a task in another product session without issuing a mutation', async () => {
    const request = vi.fn(async (name: string) =>
      name === 'tasks.get' ? { task: { ...task, sessionKey: 'another-root' } } : { tasks: [] },
    );
    await expect(controlGatewaySubagent(client(request), [root], 'one', 'cancel')).rejects.toThrow(
      'does not belong',
    );
    expect(
      request.mock.calls.every(call => call[0] === 'tasks.get' || call[0] === 'tasks.list'),
    ).toBe(true);
  });

  it('verifies both parent task identity and requester edge for a nested task', async () => {
    const nested = {
      ...task,
      id: 'two',
      sessionKey: child,
      childSessionKey: 'nested',
      parentTaskId: 'one',
    };
    const request = vi.fn(async (_name: string, params: { taskId: string }) => ({
      task: params.taskId === 'two' ? nested : task,
    }));
    await expect(requireGatewaySubagentOwnership(client(request), [root], 'two')).resolves.toEqual(
      expect.objectContaining({ id: 'two' }),
    );
    const wrongParent = vi.fn(async (_name: string, params: { taskId: string }) => ({
      task: params.taskId === 'two' ? nested : { ...task, childSessionKey: 'different-child' },
    }));
    await expect(
      requireGatewaySubagentOwnership(client(wrongParent), [root], 'two'),
    ).rejects.toThrow('Invalid subagent ancestry');
  });

  it('discovers nested ownership when native parentTaskId is absent', async () => {
    const nested = { ...task, id: 'two', sessionKey: child, childSessionKey: 'nested' };
    const request = vi.fn(async (name: string, params: Record<string, unknown>) =>
      name === 'tasks.get'
        ? { task: nested }
        : { tasks: params.sessionKey === root ? [task] : [nested] },
    );
    await expect(
      requireGatewaySubagentOwnership(client(request), [root], 'two'),
    ).resolves.toMatchObject({ id: 'two' });
  });

  it.each([
    ['cancel', { found: true, cancelled: false, reason: 'already terminal' }, 'already terminal'],
    [
      'retryDelivery',
      { results: [{ taskId: 'one', ok: false, reason: 'delivery already in flight' }] },
      'delivery already in flight',
    ],
    [
      'dismissDelivery',
      { results: [{ taskId: 'other', ok: true }] },
      'Task delivery operation was not confirmed',
    ],
  ] as const)('preserves native negative acknowledgement for %s', async (action, reply, error) => {
    const request = vi.fn(async (name: string) => (name === 'tasks.get' ? { task } : reply));
    await expect(controlGatewaySubagent(client(request), [root], 'one', action)).resolves.toEqual({
      success: false,
      error,
    });
  });

  it('does not retry an ambiguous transport failure or substitute another execution API', async () => {
    const request = vi.fn(async (name: string) => {
      if (name === 'tasks.get') return { task };
      throw new Error('connection closed');
    });
    await expect(
      controlGatewaySubagent(client(request), [root], 'one', 'retryDelivery'),
    ).rejects.toThrow('connection closed');
    expect(request.mock.calls.map(call => call[0])).toEqual(['tasks.get', 'tasks.retry']);
  });
});

describe('bounded child pages', () => {
  it('does not expose a task returned for a different requester session', async () => {
    const request = vi.fn().mockResolvedValue({
      tasks: [task, { ...task, id: 'unrelated', sessionKey: 'another-root' }],
    });
    const page = await listGatewaySubagentChildren(client(request), [root]);
    expect(page.subagents.map(entry => entry.id)).toEqual(['one']);
  });
  it('passes one bounded page and binds pagination to the requested root set', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [task], nextCursor: 'native-page-2' })
      .mockResolvedValueOnce({ tasks: [] });
    const page = await listGatewaySubagentChildren(client(request), [root]);
    expect(page.subagents[0]).toMatchObject({ id: 'one', sessionKey: child });
    expect(request).toHaveBeenCalledWith('tasks.list', { sessionKey: root, limit: 50 });
    await listGatewaySubagentChildren(client(request), [root], undefined, page.nextCursor);
    expect(request).toHaveBeenLastCalledWith('tasks.list', {
      sessionKey: root,
      limit: 50,
      cursor: 'native-page-2',
    });
    await expect(
      listGatewaySubagentChildren(client(request), ['other'], undefined, page.nextCursor),
    ).rejects.toThrow('Invalid task page cursor');
  });

  it('continues across product aliases without scanning all pages', async () => {
    const request = vi.fn().mockResolvedValue({ tasks: [] });
    const page = await listGatewaySubagentChildren(client(request), [root, 'alias']);
    expect(request).toHaveBeenCalledTimes(1);
    await listGatewaySubagentChildren(client(request), [root, 'alias'], undefined, page.nextCursor);
    expect(request).toHaveBeenLastCalledWith('tasks.list', { sessionKey: 'alias', limit: 50 });
  });

  it('verifies the selected task before querying its child session', async () => {
    const request = vi.fn(async (name: string) =>
      name === 'tasks.get' ? { task } : { tasks: [] },
    );
    await listGatewaySubagentChildren(client(request), [root], 'one');
    expect(request).toHaveBeenLastCalledWith('tasks.list', { sessionKey: child, limit: 50 });
  });
});

describe('task observation wire contract', () => {
  it('preserves execution waits, dependencies, delivery and diff statistics independently', () => {
    const observation = {
      ...task,
      parentTaskId: 'parent',
      execution: {
        state: 'waiting',
        wait: {
          kind: 'children',
          pendingCount: 1,
          dependencies: [{ runId: 'run', taskId: 'child' }],
        },
      },
      deliveryStatus: 'pending',
      diffStat: { files: 2, added: 4, removed: 1 },
    };
    expect(parseTaskSummaryV2026_9_2(observation)).toMatchObject(observation);
  });
  it.each([
    { execution: { state: 'waiting', wait: { kind: 'invented' } } },
    { deliveryStatus: 'unknown' },
    { diffStat: { files: -1, added: 0, removed: 0 } },
  ])('rejects invalid optional observation fields', malformed => {
    expect(() => parseTaskSummaryV2026_9_2({ ...task, ...malformed })).toThrow();
  });
});

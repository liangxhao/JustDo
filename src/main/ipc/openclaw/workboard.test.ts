import { beforeEach, describe, expect, test, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { WORKBOARD_STATUSES, WorkboardIpc } from '../../../shared/openclaw/workboard';
import {
  normalizeWorkboardCardInput,
  normalizeWorkboardCardPatch,
  registerOpenClawWorkboardHandlers,
} from './workboard';

describe('Workboard IPC input normalization', () => {
  test('normalizes a bounded card input and de-duplicates labels', () => {
    expect(
      normalizeWorkboardCardInput({
        title: ' Fix startup ',
        notes: ' Notes ',
        status: 'todo',
        priority: 'high',
        labels: ['runtime', 'runtime'],
        agentId: ' main ',
        boardId: ' default ',
      }),
    ).toEqual({
      title: 'Fix startup',
      notes: 'Notes',
      status: 'todo',
      priority: 'high',
      labels: ['runtime'],
      agentId: 'main',
      boardId: 'default',
    });
  });

  test('rejects unknown patch keys and protocol discriminants', () => {
    expect(normalizeWorkboardCardPatch({ metadata: { claim: { token: 'unsafe' } } })).toBeNull();
    expect(normalizeWorkboardCardPatch({ status: 'finished' })).toBeNull();
  });

  test('allows the card editor to clear an existing session link', () => {
    expect(normalizeWorkboardCardPatch({ sessionKey: '   ' })).toEqual({ sessionKey: '' });
  });

  test('enforces the canonical card bounds and board id format', () => {
    const base = {
      title: 'Card',
      status: 'todo',
      priority: 'normal',
      labels: [],
    };

    expect(normalizeWorkboardCardInput({ ...base, title: 'x'.repeat(181) })).toBeNull();
    expect(normalizeWorkboardCardInput({ ...base, notes: 'x'.repeat(4_001) })).toBeNull();
    expect(normalizeWorkboardCardInput({ ...base, labels: ['x'.repeat(41)] })).toBeNull();
    expect(normalizeWorkboardCardInput({ ...base, boardId: '../unsafe' })).toBeNull();
  });
});

describe('Workboard IPC gateway routing', () => {
  const request = vi.fn();

  beforeEach(() => {
    handlers.clear();
    request.mockReset();
    registerOpenClawWorkboardHandlers({
      getRuntime: () => ({ getGatewayClient: () => ({ request }) }) as never,
    });
  });

  test('loads cards and board metadata from the canonical plugin RPCs', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') return { cards: [], statuses: WORKBOARD_STATUSES };
      if (method === 'workboard.boards.list') return { boards: [{ id: 'default', total: 0 }] };
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.GetSnapshot)?.({});

    expect(request).toHaveBeenCalledWith('workboard.cards.list', {});
    expect(request).toHaveBeenCalledWith('workboard.boards.list', {});
    expect(result).toMatchObject({
      success: true,
      data: { cards: [], statuses: WORKBOARD_STATUSES, boards: [{ id: 'default' }] },
    });
  });

  test('uses optimistic concurrency for card edits', async () => {
    request.mockResolvedValue({
      card: {
        id: 'card-1',
        title: 'Updated',
        status: 'todo',
        priority: 'normal',
        labels: [],
        position: 1,
        createdAt: 1,
        updatedAt: 3,
      },
    });

    const result = await handlers.get(WorkboardIpc.UpdateCard)?.(
      {},
      'card-1',
      { title: ' Updated ' },
      2,
    );

    expect(request).toHaveBeenCalledWith('workboard.cards.update', {
      id: 'card-1',
      patch: { title: 'Updated' },
      expectedUpdatedAt: 2,
    });
    expect(result).toMatchObject({ success: true, data: { id: 'card-1', updatedAt: 3 } });
  });

  test('returns the canonical card and session after starting', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') {
        return {
          cards: [
            {
              id: 'card-1',
              title: 'Ready',
              status: 'ready',
              priority: 'normal',
              labels: [],
              agentId: 'main',
              position: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        };
      }
      if (method === 'workboard.cards.start') {
        return {
          cardId: 'card-1',
          sessionKey: 'agent:main:subagent:workboard-default-card-1',
          runId: 'run-1',
          card: {
            id: 'card-1',
            title: 'Started',
            status: 'running',
            priority: 'normal',
            labels: [],
            position: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.StartCard)?.({}, 'card-1');

    expect(request).toHaveBeenCalledWith('workboard.cards.start', { id: 'card-1' });
    expect(result).toMatchObject({
      success: true,
      data: {
        sessionKey: 'agent:main:subagent:workboard-default-card-1',
        runId: 'run-1',
        card: { id: 'card-1', status: 'running' },
      },
    });
  });

  test('assigns an agentless card to the gateway default before starting', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') {
        return {
          cards: [
            {
              id: 'card-1',
              title: 'Unassigned',
              status: 'backlog',
              priority: 'normal',
              labels: [],
              position: 1,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      }
      if (method === 'agents.list') {
        return { defaultId: 'main', agents: [{ id: 'main' }, { id: 'writer' }] };
      }
      if (method === 'workboard.cards.update') {
        return {
          card: {
            id: 'card-1',
            title: 'Unassigned',
            status: 'backlog',
            priority: 'normal',
            labels: [],
            agentId: 'main',
            position: 1,
            createdAt: 1,
            updatedAt: 3,
          },
        };
      }
      if (method === 'workboard.cards.start') {
        return {
          cardId: 'card-1',
          sessionKey: 'agent:main:subagent:workboard-default-card-1',
          card: {
            id: 'card-1',
            title: 'Unassigned',
            status: 'running',
            priority: 'normal',
            labels: [],
            agentId: 'main',
            position: 1,
            createdAt: 1,
            updatedAt: 4,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.StartCard)?.({}, 'card-1');

    expect(request).toHaveBeenNthCalledWith(2, 'agents.list', {});
    expect(request).toHaveBeenNthCalledWith(3, 'workboard.cards.update', {
      id: 'card-1',
      expectedUpdatedAt: 2,
      patch: { agentId: 'main' },
    });
    expect(request).toHaveBeenNthCalledWith(4, 'workboard.cards.start', { id: 'card-1' });
    expect(result).toMatchObject({
      success: true,
      data: { card: { id: 'card-1', status: 'running', agentId: 'main' } },
    });
  });

  test('assigns the default agent before dispatching unassigned runnable cards', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') {
        return {
          cards: [
            {
              id: 'card-1',
              title: 'Queued',
              status: 'todo',
              priority: 'normal',
              labels: [],
              position: 1,
              createdAt: 1,
              updatedAt: 2,
              metadata: { automation: { boardId: 'default' } },
            },
          ],
        };
      }
      if (method === 'agents.list') return { defaultId: 'writer', agents: [{ id: 'writer' }] };
      if (method === 'workboard.cards.update') return { card: { id: 'card-1' } };
      if (method === 'workboard.cards.dispatch') {
        return { started: [], promoted: [], blocked: [], startFailures: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.Dispatch)?.({}, 'default');

    expect(request).toHaveBeenNthCalledWith(3, 'workboard.cards.update', {
      id: 'card-1',
      expectedUpdatedAt: 2,
      patch: { agentId: 'writer' },
    });
    expect(request).toHaveBeenNthCalledWith(4, 'workboard.cards.dispatch', {
      boardId: 'default',
    });
    expect(result).toMatchObject({ success: true, data: { started: 0, failures: 0 } });
  });

  test('resolves an agentless Workboard session link to one canonical session', async () => {
    request.mockResolvedValue({
      sessions: [
        { key: 'agent:main:subagent:workboard-default-card-1' },
        { key: 'agent:main:justdo:unrelated' },
      ],
      hasMore: false,
      totalCount: 2,
    });

    const result = await handlers.get(WorkboardIpc.ResolveSession)?.(
      {},
      'subagent:workboard-default-card-1',
    );

    expect(request).toHaveBeenCalledWith(
      'sessions.list',
      expect.objectContaining({
        search: 'subagent:workboard-default-card-1',
        archived: 'all',
        configuredAgentsOnly: false,
      }),
    );
    expect(result).toEqual({
      success: true,
      data: { sessionKey: 'agent:main:subagent:workboard-default-card-1' },
    });
  });

  test('aborts a linked execution and moves the card to blocked', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') {
        return {
          cards: [
            {
              id: 'card-1',
              title: 'Running',
              status: 'running',
              priority: 'normal',
              labels: [],
              sessionKey: 'agent:main:subagent:workboard-default-card-1',
              runId: 'run-1',
              position: 1,
              createdAt: 1,
              updatedAt: 2,
              metadata: {
                claim: {
                  ownerId: 'main',
                  token: '[redacted]',
                  claimedAt: 1,
                  lastHeartbeatAt: 2,
                  expiresAt: 10_000,
                },
              },
            },
          ],
        };
      }
      if (method === 'sessions.list') {
        return {
          sessions: [{ key: 'agent:main:subagent:workboard-default-card-1' }],
          hasMore: false,
        };
      }
      if (method === 'chat.abort') return { aborted: true, runIds: ['run-1'] };
      if (method === 'workboard.cards.update') {
        return {
          card: {
            id: 'card-1',
            title: 'Running',
            status: 'blocked',
            priority: 'normal',
            labels: [],
            position: 1,
            createdAt: 1,
            updatedAt: 3,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1');

    expect(request).toHaveBeenCalledWith('chat.abort', {
      sessionKey: 'agent:main:subagent:workboard-default-card-1',
      runId: 'run-1',
    });
    expect(request).toHaveBeenCalledWith('workboard.cards.update', {
      id: 'card-1',
      expectedUpdatedAt: 2,
      patch: { status: 'blocked' },
    });
    expect(result).toMatchObject({ success: true, data: { status: 'blocked' } });
  });

  test('reconciles a stale running card after restart when its task and session are inactive', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') {
        return {
          cards: [
            {
              id: 'card-1',
              title: 'Interrupted by restart',
              status: 'running',
              priority: 'normal',
              labels: [],
              sessionKey: 'agent:main:subagent:workboard-default-card-1',
              runId: 'run-before-restart',
              taskId: 'task-before-restart',
              position: 1,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      }
      if (method === 'tasks.cancel') return { found: false, cancelled: false };
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:subagent:workboard-default-card-1',
              hasActiveRun: false,
            },
          ],
          hasMore: false,
        };
      }
      if (method === 'workboard.cards.update') {
        return {
          card: {
            id: 'card-1',
            title: 'Interrupted by restart',
            status: 'blocked',
            priority: 'normal',
            labels: [],
            position: 1,
            createdAt: 1,
            updatedAt: 3,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1');

    expect(request).not.toHaveBeenCalledWith('chat.abort', expect.anything());
    expect(request).toHaveBeenCalledWith('workboard.cards.update', {
      id: 'card-1',
      expectedUpdatedAt: 2,
      patch: { status: 'blocked' },
    });
    expect(result).toMatchObject({ success: true, data: { status: 'blocked' } });
  });

  test('does not rewrite a running card when the linked session still reports an active run', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list') {
        return {
          cards: [
            {
              id: 'card-1',
              title: 'Still running',
              status: 'running',
              priority: 'normal',
              labels: [],
              sessionKey: 'agent:main:subagent:workboard-default-card-1',
              runId: 'run-1',
              position: 1,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      }
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:subagent:workboard-default-card-1',
              hasActiveRun: true,
            },
          ],
          hasMore: false,
        };
      }
      if (method === 'chat.abort') return { aborted: false, runIds: [] };
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1');

    expect(request.mock.calls.filter(([method]) => method === 'chat.abort')).toHaveLength(2);
    expect(request).not.toHaveBeenCalledWith('workboard.cards.update', expect.anything());
    expect(result).toEqual({
      success: false,
      error: 'Gateway did not stop the linked Workboard execution',
    });
  });

  test('does not expose arbitrary gateway methods through the IPC surface', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        WorkboardIpc.ArchiveCard,
        WorkboardIpc.CommentCard,
        WorkboardIpc.CreateCard,
        WorkboardIpc.DeleteCard,
        WorkboardIpc.Dispatch,
        WorkboardIpc.GetSnapshot,
        WorkboardIpc.MoveCard,
        WorkboardIpc.ResolveSession,
        WorkboardIpc.StartCard,
        WorkboardIpc.StopCard,
        WorkboardIpc.UpdateCard,
      ].sort(),
    );
  });

  test('does not resolve a suffix from an incomplete session page', async () => {
    request.mockResolvedValue({
      sessions: [{ key: 'agent:main:subagent:card-1' }],
      hasMore: true,
    });
    expect(await handlers.get(WorkboardIpc.ResolveSession)?.({}, 'subagent:card-1')).toMatchObject({
      success: false,
    });
  });

  test('a stale stop click preserves an already completed card', async () => {
    const card = { id: 'card-1', status: 'done', sessionKey: 'agent:main:card-1' };
    request.mockResolvedValue({ cards: [card] });
    expect(await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1')).toEqual({
      success: true,
      data: card,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each([
    { task: { cancelled: true }, active: true, aborted: false },
    {
      task: { found: true, cancelled: false, task: { status: 'running' } },
      active: true,
      aborted: true,
    },
    {
      task: { found: true, cancelled: false, task: { status: 'unrecognized' } },
      active: false,
      aborted: false,
    },
  ])(
    'does not mark stopped while either execution remains unconfirmed: %j',
    async ({ task, active, aborted }) => {
      request.mockImplementation((method: string) => {
        if (method === 'workboard.cards.list')
          return {
            cards: [
              {
                id: 'card-1',
                status: 'running',
                sessionKey: 'agent:main:card-1',
                taskId: 'task-1',
                updatedAt: 2,
              },
            ],
          };
        if (method === 'tasks.cancel') return task;
        if (method === 'sessions.list')
          return { sessions: [{ key: 'agent:main:card-1', hasActiveRun: active }] };
        if (method === 'chat.abort') return { aborted };
        throw new Error(`unexpected method: ${method}`);
      });
      expect(await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1')).toMatchObject({
        success: false,
      });
      expect(request).not.toHaveBeenCalledWith('workboard.cards.update', expect.anything());
    },
  );

  test('rejects a stop from a drawer showing an older linked execution before side effects', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list')
        return {
          cards: [
            {
              id: 'card-1',
              status: 'running',
              sessionKey: 'agent:main:new',
              runId: 'new-run',
              taskId: 'task-1',
            },
          ],
        };
      throw new Error(`unexpected method: ${method}`);
    });
    expect(
      await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1', {
        sessionKey: 'agent:main:old',
        runId: 'old-run',
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining('execution changed') });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each(['agent:main:new', 'new', 'agent:main:old'])(
    'checks the resolved session identity before cancelling a linked task (%s)',
    async expectedSessionKey => {
      request.mockImplementation((method: string) => {
        if (method === 'workboard.cards.list')
          return {
            cards: [
              {
                id: 'card-1',
                status: 'running',
                sessionKey: 'new',
                taskId: 'task-1',
                updatedAt: 2,
              },
            ],
          };
        if (method === 'sessions.list')
          return { sessions: [{ key: 'agent:main:new', hasActiveRun: false }] };
        if (method === 'tasks.cancel') return { cancelled: true };
        if (method === 'workboard.cards.update')
          return { card: { id: 'card-1', status: 'blocked' } };
        throw new Error(`unexpected method: ${method}`);
      });
      const result = await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1', {
        sessionKey: expectedSessionKey,
        taskId: 'task-1',
      });
      expect(result).toMatchObject({ success: expectedSessionKey !== 'agent:main:old' });
      if (expectedSessionKey === 'agent:main:old') {
        expect(request).not.toHaveBeenCalledWith('tasks.cancel', expect.anything());
      }
    },
  );

  test.each(['task-1', 'old-task'])('checks task-only execution identity (%s)', async taskId => {
    request.mockImplementation((method: string) => {
      if (method === 'workboard.cards.list')
        return { cards: [{ id: 'card-1', status: 'running', taskId: 'task-1', updatedAt: 2 }] };
      if (method === 'tasks.cancel') return { cancelled: true };
      if (method === 'workboard.cards.update') return { card: { id: 'card-1', status: 'blocked' } };
      throw new Error(`unexpected method: ${method}`);
    });
    expect(await handlers.get(WorkboardIpc.StopCard)?.({}, 'card-1', { taskId })).toMatchObject({
      success: taskId === 'task-1',
    });
    if (taskId !== 'task-1') expect(request).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, expect, test, vi } from 'vitest';

import { IpcChannel as ScheduledTaskIpc } from '../../../shared/scheduledTask/constants';
import type { CronJobService } from '../../scheduler/cronJobService';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerScheduledTaskHandlers } from './handlers';

beforeEach(() => {
  handlers.clear();
});

test('loads persisted tasks through the service while the gateway is still connecting', async () => {
  const tasks = [{ id: 'persisted-job' }];
  const listJobs = vi.fn().mockResolvedValue(tasks);

  registerScheduledTaskHandlers({
    getCronJobService: () => ({ listJobs }) as unknown as CronJobService,
    getOpenClawRuntimeAdapter: () => ({
      getGatewayClient: () => null,
      fetchSessionByKey: vi.fn(),
    }),
  });

  const listHandler = handlers.get(ScheduledTaskIpc.List);
  expect(listHandler).toBeDefined();

  await expect(listHandler?.({})).resolves.toEqual({ success: true, tasks });
  expect(listJobs).toHaveBeenCalledOnce();
});

test('caps result page limits and normalizes an empty task filter', async () => {
  const listResults = vi.fn().mockReturnValue({
    results: [],
    nextCursor: null,
    unreadCount: 0,
  });
  registerScheduledTaskHandlers({
    getCronJobService: () => ({}) as CronJobService,
    getOpenClawRuntimeAdapter: () => null,
    getResultStore: () => ({ listResults }) as never,
  });

  const result = await handlers.get(ScheduledTaskIpc.ListResults)?.(
    {},
    { taskId: '   ', limit: 500 },
  );

  expect(result).toEqual({
    success: true,
    page: { results: [], nextCursor: null, unreadCount: 0 },
  });
  expect(listResults).toHaveBeenCalledWith({ limit: 100 });
});

test('marks one result read and returns the durable global unread count', async () => {
  const updateUnreadCount = vi.fn();
  const storedResult = { id: 'run-1', readAt: '2026-07-28T00:00:00.000Z' };
  registerScheduledTaskHandlers({
    getCronJobService: () => ({}) as CronJobService,
    getOpenClawRuntimeAdapter: () => null,
    getResultStore: () =>
      ({
        markRead: vi.fn().mockReturnValue(storedResult),
        countUnread: vi.fn().mockReturnValue(3),
      }) as never,
    getResultSyncService: () => ({ updateUnreadCount }) as never,
  });

  await expect(
    handlers.get(ScheduledTaskIpc.MarkResultRead)?.({}, ' run-1 '),
  ).resolves.toEqual({
    success: true,
    result: storedResult,
    unreadCount: 3,
  });
  expect(updateUnreadCount).toHaveBeenCalledWith(3);
});

test('rejects an empty result ID without touching storage', async () => {
  const markRead = vi.fn();
  registerScheduledTaskHandlers({
    getCronJobService: () => ({}) as CronJobService,
    getOpenClawRuntimeAdapter: () => null,
    getResultStore: () => ({ markRead }) as never,
  });

  await expect(
    handlers.get(ScheduledTaskIpc.MarkResultRead)?.({}, '  '),
  ).resolves.toEqual({
    success: false,
    error: 'A non-empty run ID is required',
  });
  expect(markRead).not.toHaveBeenCalled();
});

test('deletes one result and publishes the updated unread count', async () => {
  const storedResult = { id: 'run-1', taskId: 'task-1' };
  const deleteRunArtifacts = vi.fn().mockResolvedValue(undefined);
  const deleteResult = vi.fn(
    async (
      _runId: string,
      cleanup: (result: typeof storedResult) => Promise<void>,
    ) => {
      await cleanup(storedResult);
      return true;
    },
  );
  const updateUnreadCount = vi.fn();
  registerScheduledTaskHandlers({
    getCronJobService: () => ({ deleteRunArtifacts }) as unknown as CronJobService,
    getOpenClawRuntimeAdapter: () => null,
    getResultStore: () =>
      ({
        countUnread: vi.fn().mockReturnValue(2),
      }) as never,
    getResultSyncService: () => ({ deleteResult, updateUnreadCount }) as never,
  });

  await expect(
    handlers.get(ScheduledTaskIpc.DeleteResult)?.({}, ' run-1 '),
  ).resolves.toEqual({
    success: true,
    unreadCount: 2,
  });
  expect(deleteResult).toHaveBeenCalledWith('run-1', expect.any(Function));
  expect(deleteRunArtifacts).toHaveBeenCalledWith(storedResult);
  expect(updateUnreadCount).toHaveBeenCalledWith(2);
});

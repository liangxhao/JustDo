import type { ScheduledTask } from '@shared/scheduledTask/types';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { setError, setTasks } from '@/features/scheduled-tasks/scheduledTaskSlice';
import { store } from '@/store';

import { ScheduledTaskService } from './scheduledTaskService';

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Daily summary',
    description: '',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Summarize updates' },
    delivery: { mode: 'none' },
    agentId: 'justdo-scheduler',
    sessionKey: null,
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('ScheduledTaskService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    store.dispatch(setTasks([]));
    store.dispatch(setError(null));
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('deletes every selected result through the existing cleanup API', async () => {
    const deleteResult = vi
      .fn()
      .mockResolvedValueOnce({ success: true, unreadCount: 2 })
      .mockResolvedValueOnce({ success: true, unreadCount: 1 });
    const listResults = vi.fn().mockResolvedValue({
      success: true,
      page: { results: [], nextCursor: null, unreadCount: 1 },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { deleteResult, listResults } } },
    });
    const service = new ScheduledTaskService();

    const result = await service.deleteResults([' run-1 ', 'run-2', 'run-1']);

    expect(deleteResult.mock.calls.map(call => call[0])).toEqual(['run-1', 'run-2']);
    expect(result).toEqual({ deletedIds: ['run-1', 'run-2'], failedIds: [] });
    expect(store.getState().scheduledTask.unreadResultCount).toBe(1);
    expect(listResults).toHaveBeenCalledOnce();
  });

  test('reports failed IDs while continuing with the remaining results', async () => {
    const deleteResult = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'cleanup failed' })
      .mockResolvedValueOnce({ success: true, unreadCount: 0 });
    const listResults = vi.fn().mockResolvedValue({
      success: true,
      page: { results: [], nextCursor: null, unreadCount: 0 },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { deleteResult, listResults } } },
    });
    const service = new ScheduledTaskService();

    const result = await service.deleteResults(['run-1', 'run-2']);

    expect(result).toEqual({ deletedIds: ['run-2'], failedIds: ['run-1'] });
    expect(deleteResult).toHaveBeenCalledTimes(2);
    expect(listResults).toHaveBeenCalledOnce();
  });

  test('reloads the authoritative task list after an update failure', async () => {
    const update = vi.fn().mockResolvedValue({ success: false, error: 'task not found' });
    const list = vi.fn().mockResolvedValue({ success: true, tasks: [] });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { update, list } } },
    });
    const service = new ScheduledTaskService();

    await expect(service.updateTaskById('missing-task', { name: 'Updated' })).rejects.toThrow(
      'task not found',
    );

    expect(list).toHaveBeenCalledOnce();
    expect(store.getState().scheduledTask.tasks).toEqual([]);
  });

  test('reloads the authoritative task list after a delete failure', async () => {
    const deleteTask = vi.fn().mockResolvedValue({ success: false, error: 'task not found' });
    const list = vi.fn().mockResolvedValue({ success: true, tasks: [] });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { delete: deleteTask, list } } },
    });
    const service = new ScheduledTaskService();

    await expect(service.deleteTask('missing-task')).rejects.toThrow('task not found');

    expect(list).toHaveBeenCalledOnce();
    expect(store.getState().scheduledTask.tasks).toEqual([]);
  });

  test('upserts a create response already inserted by an overlapping refresh', async () => {
    const refreshedTask = createTask();
    const createdTask = createTask({ updatedAt: '2026-08-24T00:01:00.000Z' });
    store.dispatch(setTasks([refreshedTask]));
    const create = vi.fn().mockResolvedValue({ success: true, task: createdTask });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { create } }, dispatchEvent: vi.fn() },
    });
    const service = new ScheduledTaskService();

    await service.createTask({
      name: createdTask.name,
      description: createdTask.description,
      enabled: createdTask.enabled,
      schedule: createdTask.schedule,
      sessionTarget: createdTask.sessionTarget,
      wakeMode: createdTask.wakeMode,
      payload: createdTask.payload,
      delivery: createdTask.delivery,
    });

    expect(store.getState().scheduledTask.tasks).toEqual([createdTask]);
  });

  test('ignores an older task-list response that finishes after a newer refresh', async () => {
    const staleTask = createTask();
    let resolveOlder!: (value: { success: true; tasks: ScheduledTask[] }) => void;
    let resolveNewer!: (value: { success: true; tasks: ScheduledTask[] }) => void;
    const older = new Promise<{ success: true; tasks: ScheduledTask[] }>(resolve => {
      resolveOlder = resolve;
    });
    const newer = new Promise<{ success: true; tasks: ScheduledTask[] }>(resolve => {
      resolveNewer = resolve;
    });
    const list = vi.fn().mockReturnValueOnce(older).mockReturnValueOnce(newer);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { list } } },
    });
    const service = new ScheduledTaskService();

    const olderLoad = service.loadTasks();
    const newerLoad = service.loadTasks();
    resolveNewer({ success: true, tasks: [] });
    await newerLoad;
    resolveOlder({ success: true, tasks: [staleTask] });
    await olderLoad;

    expect(store.getState().scheduledTask.tasks).toEqual([]);
    expect(store.getState().scheduledTask.loading).toBe(false);
  });
});

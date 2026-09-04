import type {
  ScheduledTask,
  ScheduledTaskResult,
  ScheduledTaskResultUpsertedEvent,
  ScheduledTaskRunEvent,
} from '@shared/scheduledTask/types';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  replaceResults,
  setError,
  setResultFilter,
  setResultsLoading,
  setRuns,
  setTasks,
  setUnreadResultCount,
} from '@/features/scheduled-tasks/scheduledTaskSlice';
import { store } from '@/store';

import {
  isVisibleScheduledTask,
  resolveVisibleResultTaskId,
  ScheduledTaskService,
} from './scheduledTaskService';

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
    management: 'editable',
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

function createResult(overrides: Partial<ScheduledTaskResult> = {}): ScheduledTaskResult {
  return {
    id: 'run-1',
    taskId: 'task-1',
    taskName: 'Daily summary',
    sessionId: null,
    sessionKey: 'agent:justdo-scheduler:cron:task-1:run:run-1',
    status: 'success',
    summary: 'Done',
    startedAt: '2026-09-05T00:00:00.000Z',
    finishedAt: '2026-09-05T00:00:01.000Z',
    durationMs: 1_000,
    error: null,
    deliveryStatus: null,
    deliveryError: null,
    observedAt: '2026-09-05T00:00:01.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('ScheduledTaskService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    store.dispatch(setTasks([]));
    store.dispatch(setError(null));
    store.dispatch(replaceResults({ results: [], nextCursor: null }));
    store.dispatch(setResultsLoading(false));
    store.dispatch(setUnreadResultCount(0));
    store.dispatch(
      setResultFilter({
        taskId: null,
        unreadOnly: false,
        includeRoutine: false,
        includeSystem: false,
      }),
    );
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
      value: {
        electron: { scheduledTasks: { deleteResult, listResults } },
        dispatchEvent: vi.fn(),
      },
    });
    const service = new ScheduledTaskService();

    const result = await service.deleteResults([' run-1 ', 'run-2', 'run-1']);

    expect(deleteResult.mock.calls.map(call => call[0])).toEqual(['run-1', 'run-2']);
    expect(result).toEqual({ deletedIds: ['run-1', 'run-2'], failedIds: [] });
    expect(store.getState().scheduledTask.unreadResultCount).toBe(1);
    expect(listResults).toHaveBeenCalledOnce();
  });

  test('keeps disabled OpenClaw heartbeat plumbing out of the task list', async () => {
    const userTask = createTask();
    const heartbeatTask = createTask({
      id: 'heartbeat-main',
      name: 'Heartbeat (main)',
      enabled: false,
      sessionTarget: 'main',
      payload: { kind: 'heartbeat' },
      management: 'managed',
    });
    const list = vi.fn().mockResolvedValue({
      success: true,
      tasks: [heartbeatTask, userTask],
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { list } } },
    });
    const service = new ScheduledTaskService();

    await service.loadTasks();

    expect(isVisibleScheduledTask(heartbeatTask)).toBe(false);
    expect(store.getState().scheduledTask.tasks).toEqual([userTask]);
  });

  test('clears a result task filter that is no longer available', () => {
    const task = createTask();

    expect(resolveVisibleResultTaskId([task], 'task-1')).toBe('task-1');
    expect(resolveVisibleResultTaskId([task], 'missing-task')).toBeNull();
    expect(resolveVisibleResultTaskId([task], null)).toBeNull();
  });

  test('marks all results read globally so the action matches the global unread count', async () => {
    const markAllResultsRead = vi.fn().mockResolvedValue({ success: true, unreadCount: 0 });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { markAllResultsRead } }, dispatchEvent: vi.fn() },
    });
    const service = new ScheduledTaskService();

    await service.markAllResultsRead();

    expect(markAllResultsRead).toHaveBeenCalledWith();
  });

  test('does not leave result loading stuck when marking a result read invalidates a list request', async () => {
    let resolveList!: (value: {
      success: true;
      page: { results: ScheduledTaskResult[]; nextCursor: null; unreadCount: number };
    }) => void;
    const pendingList = new Promise<{
      success: true;
      page: { results: ScheduledTaskResult[]; nextCursor: null; unreadCount: number };
    }>(resolve => {
      resolveList = resolve;
    });
    const listResults = vi.fn().mockReturnValue(pendingList);
    const markResultRead = vi.fn().mockResolvedValue({ success: true, unreadCount: 0 });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: { scheduledTasks: { listResults, markResultRead } },
        dispatchEvent: vi.fn(),
      },
    });
    const service = new ScheduledTaskService();

    const pendingLoad = service.loadResults();
    expect(store.getState().scheduledTask.resultsLoading).toBe(true);
    await service.markResultRead('run-1');
    expect(store.getState().scheduledTask.resultsLoading).toBe(false);

    resolveList({
      success: true,
      page: { results: [], nextCursor: null, unreadCount: 0 },
    });
    await pendingLoad;
    expect(store.getState().scheduledTask.resultsLoading).toBe(false);
  });

  test('reports a rejected mark-read request and reloads authoritative results', async () => {
    const listResults = vi.fn().mockResolvedValue({
      success: true,
      page: { results: [], nextCursor: null, unreadCount: 0 },
    });
    const dispatchEvent = vi.fn();
    const markResultRead = vi.fn().mockRejectedValue(new Error('mark read unavailable'));
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { listResults, markResultRead } }, dispatchEvent },
    });
    const service = new ScheduledTaskService();

    await service.markResultRead('run-1');

    expect(listResults).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(store.getState().scheduledTask.resultsLoading).toBe(false);
  });

  test('retries an appended result page when a live result arrives during the request', async () => {
    const staleResult = createResult({ status: 'running', finishedAt: null });
    const liveResult = createResult();
    store.dispatch(replaceResults({ results: [staleResult], nextCursor: 'next-page' }));
    let onResult: ((event: ScheduledTaskResultUpsertedEvent) => void) | undefined;
    let resolveFirst!: (value: {
      success: true;
      page: { results: ScheduledTaskResult[]; nextCursor: null; unreadCount: number };
    }) => void;
    const firstPage = new Promise<{
      success: true;
      page: { results: ScheduledTaskResult[]; nextCursor: null; unreadCount: number };
    }>(resolve => {
      resolveFirst = resolve;
    });
    const listResults = vi
      .fn()
      .mockReturnValueOnce(firstPage)
      .mockResolvedValueOnce({
        success: true,
        page: { results: [], nextCursor: null, unreadCount: 0 },
      });
    const subscribe = () => () => undefined;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: {
          scheduledTasks: {
            listResults,
            onStatusUpdate: subscribe,
            onRunUpdate: subscribe,
            onResultUpserted: (callback: typeof onResult) => {
              onResult = callback;
              return () => undefined;
            },
            onUnreadCountChanged: subscribe,
            onRefresh: subscribe,
          },
        },
      },
    });
    const service = new ScheduledTaskService();
    (service as unknown as { setupListeners: () => void }).setupListeners();

    const pendingLoad = service.loadResults(true);
    onResult?.({ result: liveResult, isNewUnread: true });
    resolveFirst({
      success: true,
      page: { results: [staleResult], nextCursor: null, unreadCount: 1 },
    });
    await pendingLoad;

    expect(listResults).toHaveBeenCalledTimes(2);
    expect(store.getState().scheduledTask.results[0].status).toBe('success');
    expect(store.getState().scheduledTask.resultsLoading).toBe(false);
  });

  test('rejects a manual run when the IPC response reports an enqueue failure', async () => {
    const runManually = vi.fn().mockResolvedValue({
      success: false,
      error: 'already running',
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { runManually } } },
    });
    const service = new ScheduledTaskService();

    await expect(service.runManually('task-1')).rejects.toThrow('already running');
  });

  test('only projects live run events into an initialized history cache', () => {
    let onRun: ((event: ScheduledTaskRunEvent) => void) | undefined;
    const subscribe = () => () => undefined;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: {
          scheduledTasks: {
            onStatusUpdate: subscribe,
            onRunUpdate: (callback: typeof onRun) => {
              onRun = callback;
              return () => undefined;
            },
            onResultUpserted: subscribe,
            onUnreadCountChanged: subscribe,
            onRefresh: subscribe,
          },
        },
      },
    });
    const service = new ScheduledTaskService();
    (service as unknown as { setupListeners: () => void }).setupListeners();
    const liveRun = {
      id: 'live-run',
      taskId: 'live-task',
      taskName: 'Live task',
      sessionId: null,
      sessionKey: null,
      status: 'success' as const,
      summary: null,
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:00:01.000Z',
      durationMs: 1000,
      error: null,
      deliveryStatus: null,
      deliveryError: null,
    };

    onRun?.({ run: liveRun });
    expect(store.getState().scheduledTask.runs['live-task']).toBeUndefined();

    store.dispatch(setRuns({ taskId: 'live-task', runs: [], hasMore: false, nextOffset: null }));
    onRun?.({ run: liveRun });
    expect(store.getState().scheduledTask.runs['live-task']).toEqual([liveRun]);
  });

  test('rejects a failed toggle and reloads the authoritative task list', async () => {
    const toggle = vi.fn().mockResolvedValue({ success: false, error: 'revision conflict' });
    const list = vi.fn().mockResolvedValue({ success: true, tasks: [] });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { toggle, list } } },
    });
    const service = new ScheduledTaskService();

    await expect(service.toggleTask('task-1', false)).rejects.toThrow('revision conflict');

    expect(list).toHaveBeenCalledOnce();
  });

  test('rejects a failed run-history page request', async () => {
    const listRuns = vi.fn().mockResolvedValue({ success: false, error: 'history unavailable' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { listRuns } } },
    });
    const service = new ScheduledTaskService();

    await expect(service.loadRuns('task-1')).rejects.toThrow('history unavailable');
  });

  test('uses Gateway run pagination metadata instead of page length heuristics', async () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({ id: `run-${index}` }));
    const listRuns = vi.fn().mockResolvedValue({
      success: true,
      runs,
      hasMore: true,
      nextOffset: 75,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electron: { scheduledTasks: { listRuns } } },
    });
    const service = new ScheduledTaskService();

    await service.loadRuns('task-1', 20);

    expect(store.getState().scheduledTask.runsHasMore['task-1']).toBe(true);
    expect(store.getState().scheduledTask.runsNextOffset['task-1']).toBe(75);
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
    const dispatchEvent = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: { scheduledTasks: { deleteResult, listResults } },
        dispatchEvent,
      },
    });
    const service = new ScheduledTaskService();

    const result = await service.deleteResults(['run-1', 'run-2']);

    expect(result).toEqual({ deletedIds: ['run-2'], failedIds: ['run-1'] });
    expect(deleteResult).toHaveBeenCalledTimes(2);
    expect(listResults).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  test('reports reconciliation failures and always clears the refresh indicator', async () => {
    const dispatchEvent = vi.fn();
    const reconcileResults = vi.fn().mockResolvedValue({
      success: false,
      error: 'reconciliation unavailable',
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: { scheduledTasks: { reconcileResults } },
        dispatchEvent,
      },
    });
    const service = new ScheduledTaskService();

    await service.refreshResults();

    expect(store.getState().scheduledTask.resultsLoading).toBe(false);
    expect(store.getState().scheduledTask.error).toBe('reconciliation unavailable');
    expect(dispatchEvent).toHaveBeenCalledOnce();
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
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      sessionTarget: 'isolated',
      wakeMode: createdTask.wakeMode,
      payload: { kind: 'agentTurn', message: 'Summarize updates' },
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

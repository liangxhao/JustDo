import { afterEach, describe, expect, test, vi } from 'vitest';

import { store } from '@/store';

import { ScheduledTaskService } from './scheduledTaskService';

describe('ScheduledTaskService.deleteResults', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});

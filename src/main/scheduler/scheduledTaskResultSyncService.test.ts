import { describe, expect, test, vi } from 'vitest';

import type { ScheduledTask, ScheduledTaskRun } from '../../shared/scheduledTask/types';
import type { ScheduledTaskResultStore } from '../data/scheduledTaskResultStore';
import type { ScheduledTaskResultCatchUp } from '../data/scheduledTaskResultStore';
import type { CronJobService } from './cronJobService';
import {
  RESULT_BASELINE_LIMIT,
  RESULT_RECONCILE_LIMIT,
  ScheduledTaskResultSyncService,
} from './scheduledTaskResultSyncService';

function run(id: string, startedAt: string): ScheduledTaskRun {
  return {
    id,
    taskId: 'task-1',
    sessionId: null,
    sessionKey: null,
    status: 'success',
    summary: id,
    startedAt,
    finishedAt: startedAt,
    durationMs: 10,
    error: null,
    deliveryStatus: null,
    deliveryError: null,
  };
}

describe('ScheduledTaskResultSyncService', () => {
  test('cleans up OpenClaw artifacts before physically deleting the local result', async () => {
    const storedResult = {
      ...run('delete-me', '2026-07-28T08:00:00.000Z'),
      taskName: 'Task',
      observedAt: '2026-07-28T08:00:01.000Z',
      readAt: null,
    };
    const calls: string[] = [];
    const resultStore = {
      getResult: vi.fn().mockReturnValue(storedResult),
      deleteResult: vi.fn(() => {
        calls.push('local');
        return true;
      }),
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService: {} as CronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });

    await expect(
      service.deleteResult('delete-me', async result => {
        expect(result).toBe(storedResult);
        calls.push('openclaw');
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual(['openclaw', 'local']);
  });

  test('keeps the local result when OpenClaw cleanup fails', async () => {
    const storedResult = {
      ...run('delete-me', '2026-07-28T08:00:00.000Z'),
      taskName: 'Task',
      observedAt: '2026-07-28T08:00:01.000Z',
      readAt: null,
    };
    const deleteResult = vi.fn();
    const resultStore = {
      getResult: vi.fn().mockReturnValue(storedResult),
      deleteResult,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService: {} as CronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });

    await expect(
      service.deleteResult('delete-me', async () => {
        throw new Error('cleanup failed');
      }),
    ).rejects.toThrow('cleanup failed');

    expect(deleteResult).not.toHaveBeenCalled();
  });

  test('queues reconciliation until an in-flight deletion finishes', async () => {
    const storedResult = {
      ...run('delete-me', '2026-07-28T08:00:00.000Z'),
      taskName: 'Task',
      observedAt: '2026-07-28T08:00:01.000Z',
      readAt: null,
    };
    let finishCleanup: (() => void) | undefined;
    const cleanupPending = new Promise<void>(resolve => {
      finishCleanup = resolve;
    });
    const listAllRuns = vi.fn().mockResolvedValue({ runs: [], nextOffset: null });
    const resultStore = {
      hasInitializedBaseline: () => true,
      getResult: vi.fn().mockReturnValue(storedResult),
      deleteResult: vi.fn().mockReturnValue(true),
      upsertResults: vi.fn().mockReturnValue([]),
      countUnread: () => 0,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService: { listAllRuns } as unknown as CronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });

    const deletion = service.deleteResult('delete-me', () => cleanupPending);
    const reconciliation = service.reconcile([]);
    await Promise.resolve();
    expect(listAllRuns).not.toHaveBeenCalled();

    finishCleanup?.();
    await deletion;
    await reconciliation;

    expect(listAllRuns).toHaveBeenCalled();
  });

  test('rejects deletion while a result is still running', async () => {
    const storedResult = {
      ...run('running', '2026-07-28T08:00:00.000Z'),
      status: 'running' as const,
      finishedAt: null,
      taskName: 'Task',
      observedAt: '2026-07-28T08:00:01.000Z',
      readAt: null,
    };
    const cleanup = vi.fn();
    const deleteResult = vi.fn();
    const service = new ScheduledTaskResultSyncService({
      cronJobService: {} as CronJobService,
      resultStore: {
        getResult: vi.fn().mockReturnValue(storedResult),
        deleteResult,
      } as unknown as ScheduledTaskResultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });

    await expect(service.deleteResult('running', cleanup)).rejects.toThrow(
      'cannot be deleted',
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(deleteResult).not.toHaveBeenCalled();
  });

  test('imports the bounded first baseline without unread result events', async () => {
    const initializeBaseline = vi.fn();
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => false,
      initializeBaseline,
      countUnread: () => 0,
    } as unknown as ScheduledTaskResultStore;
    const emitResultUpserted = vi.fn();
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted,
      emitUnreadCountChanged: vi.fn(),
    });

    await service.reconcile([]);

    expect(cronJobService.listAllRuns).toHaveBeenCalledWith(50, 0);
    expect(initializeBaseline).toHaveBeenCalledWith([], expect.any(Number), []);
    expect(emitResultUpserted).not.toHaveBeenCalled();
    expect(RESULT_BASELINE_LIMIT).toBe(200);
  });

  test('uses the local task title when a global run only contains the job ID', async () => {
    const initializeBaseline = vi.fn();
    const gatewayRun = {
      ...run('baseline', '2026-07-28T08:00:00.000Z'),
      taskName: 'task-1',
    };
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [gatewayRun], nextOffset: null }),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => false,
      initializeBaseline,
      countUnread: () => 0,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });
    const job = {
      id: 'task-1',
      name: 'Daily report',
      state: { lastRunAtMs: Date.parse(gatewayRun.startedAt) },
    } as ScheduledTask;

    await service.reconcile([job]);

    expect(initializeBaseline.mock.calls[0]?.[0]).toEqual([
      {
        run: { ...gatewayRun, taskName: 'Daily report' },
        taskName: 'Daily report',
      },
    ]);
    expect(initializeBaseline.mock.calls[0]?.[2]).toEqual([
      { taskId: 'task-1', lastRunAtMs: Date.parse(gatewayRun.startedAt) },
    ]);
  });

  test('catches up multiple missed runs oldest first and only once', async () => {
    const older = run('older', '2026-07-28T08:00:00.000Z');
    const newer = run('newer', '2026-07-28T09:00:00.000Z');
    const known = new Set<string>();
    const upsertResult = vi.fn((item: ScheduledTaskRun) => {
      known.add(item.id);
      return {
        result: {
          ...item,
          taskName: 'Task',
          observedAt: item.startedAt,
          readAt: null,
        },
        changed: true,
        isNewUnread: true,
      };
    });
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
      listRuns: vi.fn().mockResolvedValue([newer, older]),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => true,
      getLatestStartedAt: () => 1000,
      getResult: (id: string) => (known.has(id) ? { id } : null),
      upsertResults: (items: Array<{ run: ScheduledTaskRun }>) =>
        items.map(item => upsertResult(item.run)),
      countUnread: () => known.size,
    } as unknown as ScheduledTaskResultStore;
    const emitted: string[] = [];
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: result => emitted.push(result.id),
      emitUnreadCountChanged: vi.fn(),
    });
    const job = {
      id: 'task-1',
      name: 'Task',
      state: { lastRunAtMs: Date.parse(newer.startedAt) },
    } as ScheduledTask;

    await service.reconcile([]);
    await service.reconcile([job]);
    await service.reconcile([job]);

    expect(emitted).toEqual(['older', 'newer']);
    expect(upsertResult).toHaveBeenCalledTimes(2);
    expect(RESULT_RECONCILE_LIMIT).toBe(100);
  });

  test('continues catch-up after the per-round limit without losing older runs', async () => {
    const base = Date.parse('2026-07-28T12:00:00.000Z');
    const missed = Array.from({ length: RESULT_RECONCILE_LIMIT + 1 }, (_, index) =>
      run(`run-${index}`, new Date(base - index * 60_000).toISOString()),
    );
    const known = new Set<string>();
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
      listRuns: vi.fn((_jobId: string, limit: number, offset: number) =>
        Promise.resolve(missed.slice(offset, offset + limit)),
      ),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => true,
      getLatestStartedAt: () => 1000,
      getResult: (id: string) => (known.has(id) ? { id } : null),
      upsertResults: (items: Array<{ run: ScheduledTaskRun }>) =>
        items.map(({ run: item }) => {
          const changed = !known.has(item.id);
          known.add(item.id);
          return {
            result: {
              ...item,
              taskName: 'Task',
              observedAt: item.startedAt,
              readAt: null,
            },
            changed,
            isNewUnread: changed,
          };
        }),
      countUnread: () => known.size,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });
    const job = {
      id: 'task-1',
      name: 'Task',
      state: { lastRunAtMs: base },
    } as ScheduledTask;

    await service.reconcile([]);
    await service.reconcile([job]);
    expect(known.size).toBe(RESULT_RECONCILE_LIMIT + 1);
    expect(known.has('run-100')).toBe(true);
  });

  test('resumes from the last persisted batch when a later batch fails', async () => {
    const base = Date.parse('2026-07-28T12:00:00.000Z');
    const missed = Array.from({ length: RESULT_RECONCILE_LIMIT + 1 }, (_, index) =>
      run(`retry-${index}`, new Date(base - index * 60_000).toISOString()),
    );
    const known = new Set<string>();
    let persistCalls = 0;
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
      listRuns: vi.fn((_jobId: string, limit: number, offset: number) =>
        Promise.resolve(missed.slice(offset, offset + limit)),
      ),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => true,
      getLatestStartedAt: () => 1000,
      getResult: (id: string) => (known.has(id) ? { id } : null),
      upsertResults: (items: Array<{ run: ScheduledTaskRun }>) => {
        if (items.length === 0) return [];
        persistCalls += 1;
        if (persistCalls === 2) throw new Error('disk full');
        return items.map(({ run: item }) => {
          const changed = !known.has(item.id);
          known.add(item.id);
          return {
            result: {
              ...item,
              taskName: 'Task',
              observedAt: item.startedAt,
              readAt: null,
            },
            changed,
            isNewUnread: changed,
          };
        });
      },
      countUnread: () => known.size,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });
    const job = {
      id: 'task-1',
      name: 'Task',
      state: { lastRunAtMs: base },
    } as ScheduledTask;

    await service.reconcile([]);
    await expect(service.reconcile([job])).rejects.toThrow('disk full');
    expect(known.size).toBe(RESULT_RECONCILE_LIMIT);

    await service.reconcile([job]);
    expect(known.size).toBe(RESULT_RECONCILE_LIMIT + 1);
    expect(known.has('retry-100')).toBe(true);
  });

  test('resumes a durable catch-up after the sync service is recreated', async () => {
    const base = Date.parse('2026-07-28T12:00:00.000Z');
    const missed = Array.from({ length: RESULT_RECONCILE_LIMIT + 1 }, (_, index) =>
      run(`restart-${index}`, new Date(base - index * 60_000).toISOString()),
    );
    const known = new Set<string>();
    const durableCatchUps = new Map<string, ScheduledTaskResultCatchUp>();
    let failAfterFirstBatch = true;
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
      listRuns: vi.fn((_jobId: string, limit: number, offset: number) => {
        if (offset >= RESULT_RECONCILE_LIMIT && failAfterFirstBatch) {
          throw new Error('gateway disconnected');
        }
        return Promise.resolve(missed.slice(offset, offset + limit));
      }),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => true,
      getBaselineAt: () => 1000,
      getLatestStartedAt: () =>
        known.size > 0 ? Math.max(...missed.filter(item => known.has(item.id)).map(item => Date.parse(item.startedAt))) : null,
      getResult: (id: string) => (known.has(id) ? { id } : null),
      getCatchUp: (taskId: string) => durableCatchUps.get(taskId) ?? null,
      setCatchUp: (taskId: string, catchUp: ScheduledTaskResultCatchUp | null) => {
        if (catchUp) durableCatchUps.set(taskId, catchUp);
        else durableCatchUps.delete(taskId);
      },
      upsertResults: (items: Array<{ run: ScheduledTaskRun }>) =>
        items.map(({ run: item }) => {
          const changed = !known.has(item.id);
          known.add(item.id);
          return {
            result: {
              ...item,
              taskName: 'Task',
              observedAt: item.startedAt,
              readAt: null,
            },
            changed,
            isNewUnread: changed,
          };
        }),
      countUnread: () => known.size,
    } as unknown as ScheduledTaskResultStore;
    const createService = () =>
      new ScheduledTaskResultSyncService({
        cronJobService,
        resultStore,
        emitResultUpserted: vi.fn(),
        emitUnreadCountChanged: vi.fn(),
      });
    const job = {
      id: 'task-1',
      name: 'Task',
      state: { lastRunAtMs: base },
    } as ScheduledTask;

    await expect(createService().reconcile([job])).rejects.toThrow('gateway disconnected');
    expect(known.size).toBe(RESULT_RECONCILE_LIMIT);
    expect(durableCatchUps.has(job.id)).toBe(true);

    failAfterFirstBatch = false;
    await createService().reconcile([job]);
    expect(known.size).toBe(RESULT_RECONCILE_LIMIT + 1);
    expect(durableCatchUps.has(job.id)).toBe(false);
  });

  test('uses the baseline timestamp as the watermark for tasks absent from the baseline window', async () => {
    const baselineAt = Date.parse('2026-07-28T12:00:00.000Z');
    const historical = run('historical', new Date(baselineAt - 60_000).toISOString());
    const upsertResults = vi.fn().mockReturnValue([]);
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
      listRuns: vi.fn().mockResolvedValue([historical]),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => true,
      getBaselineAt: () => baselineAt,
      getLatestStartedAt: () => null,
      getResult: () => null,
      getCatchUp: () => null,
      setCatchUp: vi.fn(),
      upsertResults,
      countUnread: () => 0,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });
    const job = {
      id: 'task-1',
      name: 'Task',
      state: { lastRunAtMs: Date.parse(historical.startedAt) },
    } as ScheduledTask;

    await service.reconcile([job]);

    expect(cronJobService.listRuns).not.toHaveBeenCalled();
    expect(upsertResults).toHaveBeenCalledWith([]);
  });

  test('imports a run that completes after baseline with an earlier start time', async () => {
    const runningAtMs = Date.parse('2026-07-28T11:59:00.000Z');
    const completed = run('cross-baseline', new Date(runningAtMs).toISOString());
    let initialized = false;
    let watermark: number | null = 1000;
    const known = new Set<string>();
    const cronJobService = {
      listAllRuns: vi.fn().mockResolvedValue({ runs: [], nextOffset: null }),
      listRuns: vi.fn().mockResolvedValue([completed]),
    } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => initialized,
      initializeBaseline: (
        _items: unknown[],
        _baselineAt: number,
        watermarks: Array<{ taskId: string; lastRunAtMs: number | null }>,
      ) => {
        initialized = true;
        watermark = watermarks[0].lastRunAtMs;
      },
      getBaselineAt: () => Date.parse('2026-07-28T12:00:00.000Z'),
      getBaselineWatermark: () => ({ lastRunAtMs: watermark }),
      getLatestStartedAt: () => null,
      getResult: (id: string) => (known.has(id) ? { id } : null),
      getCatchUp: () => null,
      setCatchUp: vi.fn(),
      upsertResults: (items: Array<{ run: ScheduledTaskRun }>) =>
        items.map(({ run: item }) => {
          known.add(item.id);
          return {
            result: {
              ...item,
              taskName: 'Task',
              observedAt: item.startedAt,
              readAt: null,
            },
            changed: true,
            isNewUnread: true,
          };
        }),
      countUnread: () => known.size,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });
    const job = {
      id: 'task-1',
      name: 'Task',
      state: {
        lastRunAtMs: 1000,
        runningAtMs,
      },
    } as ScheduledTask;

    await service.reconcile([job]);
    job.state = { ...job.state, lastRunAtMs: runningAtMs, runningAtMs: null };
    await service.reconcile([job]);

    expect(known.has(completed.id)).toBe(true);
  });

  test('queues a forced reconcile behind an active background reconcile', async () => {
    let releaseFirst!: () => void;
    const firstCall = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const listAllRuns = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstCall;
        return { runs: [], nextOffset: null };
      })
      .mockResolvedValue({ runs: [], nextOffset: null });
    const cronJobService = { listAllRuns } as unknown as CronJobService;
    const resultStore = {
      hasInitializedBaseline: () => true,
      upsertResults: () => [],
      countUnread: () => 0,
    } as unknown as ScheduledTaskResultStore;
    const service = new ScheduledTaskResultSyncService({
      cronJobService,
      resultStore,
      emitResultUpserted: vi.fn(),
      emitUnreadCountChanged: vi.fn(),
    });

    const background = service.reconcile([]);
    const forced = service.reconcile([], true);
    releaseFirst();
    await Promise.all([background, forced]);

    expect(listAllRuns).toHaveBeenCalledTimes(2);
  });
});

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { TaskStatus } from '../../shared/scheduledTask/constants';
import type { ScheduledTaskRun } from '../../shared/scheduledTask/types';
import { ScheduledTaskResultStore } from './scheduledTaskResultStore';

function run(
  id: string,
  status: ScheduledTaskRun['status'] = TaskStatus.Success,
  startedAt = '2026-07-28T08:00:00.000Z',
): ScheduledTaskRun {
  return {
    id,
    taskId: 'task-1',
    sessionId: `session-${id}`,
    sessionKey: `cron:task-1:${id}`,
    status,
    summary: `summary ${id}`,
    startedAt,
    finishedAt: status === TaskStatus.Running ? null : startedAt,
    durationMs: status === TaskStatus.Running ? null : 1000,
    error: status === TaskStatus.Error ? 'execution failed' : null,
    deliveryStatus: 'not-requested',
    deliveryError: null,
  };
}

describe('ScheduledTaskResultStore', () => {
  let db: Database.Database;
  let store: ScheduledTaskResultStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE scheduled_task_run_receipts (
        run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_name TEXT NOT NULL,
        system_managed INTEGER NOT NULL DEFAULT 0,
        session_id TEXT, session_key TEXT, status TEXT NOT NULL, summary TEXT, error TEXT,
        delivery_status TEXT, delivery_error TEXT, started_at INTEGER NOT NULL,
        finished_at INTEGER, duration_ms INTEGER, observed_at INTEGER NOT NULL,
        read_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE scheduled_task_result_tombstones (
        run_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
      );
    `);
    store = new ScheduledTaskResultStore(db);
  });

  afterEach(() => db.close());

  test('imports the baseline atomically as read', () => {
    store.initializeBaseline([{ run: run('baseline'), taskName: 'Daily report' }], 1000, [
      { taskId: 'task-1', lastRunAtMs: 900 },
    ]);

    expect(store.hasInitializedBaseline()).toBe(true);
    expect(store.getBaselineAt()).toBe(1000);
    expect(store.getBaselineWatermark('task-1')).toEqual({ lastRunAtMs: 900 });
    expect(store.countUnread()).toBe(0);
    expect(store.getResult('baseline')?.readAt).toBe(new Date(1000).toISOString());
  });

  test('persists and clears a catch-up checkpoint', () => {
    const catchUp = {
      boundaryRunId: 'run-100',
      boundaryStartedAt: 100,
      stopAt: 10,
      ignoreKnown: true,
      resumeOffset: 50,
    };

    store.setCatchUp('task-1', catchUp);
    expect(store.getCatchUp('task-1')).toEqual(catchUp);

    store.setCatchUp('task-1', null);
    expect(store.getCatchUp('task-1')).toBeNull();
  });

  test('advances the durable completed-through watermark monotonically', () => {
    store.advanceCompletedThrough('task-1', 2000, 3000);
    store.advanceCompletedThrough('task-1', 1500, 4000);

    expect(store.getBaselineWatermark('task-1')).toEqual({ lastRunAtMs: 2000 });
  });

  test('marks a new terminal result unread exactly once and preserves a read receipt', () => {
    store.initializeBaseline([], 1000);

    const first = store.upsertResult(run('new'), 'Daily report', { observedAt: 2000 });
    const duplicate = store.upsertResult(run('new'), 'Daily report', { observedAt: 3000 });
    expect(first?.isNewUnread).toBe(true);
    expect(duplicate?.isNewUnread).toBe(false);
    expect(store.countUnread()).toBe(1);

    store.markRead('new', 4000);
    store.upsertResult({ ...run('new'), summary: 'updated' }, 'Renamed task');
    expect(store.getResult('new')).toMatchObject({
      taskName: 'Daily report',
      summary: 'updated',
      readAt: new Date(4000).toISOString(),
    });
    expect(store.countUnread()).toBe(0);
  });

  test('repairs a job ID placeholder without overwriting a real historical title', () => {
    store.initializeBaseline([], 1000);
    store.upsertResult(run('repair-title'), 'task-1');

    store.upsertResult(run('repair-title'), 'Daily report');
    expect(store.getResult('repair-title')?.taskName).toBe('Daily report');

    store.upsertResult(run('repair-title'), 'task-1');
    expect(store.getResult('repair-title')?.taskName).toBe('Daily report');
  });

  test('creates unread only when a running result becomes terminal', () => {
    store.initializeBaseline([], 1000);
    expect(store.upsertResult(run('transition', TaskStatus.Running), 'Task')?.isNewUnread).toBe(
      false,
    );
    expect(store.countUnread()).toBe(0);
    expect(store.listResults({ unreadOnly: true }).results).toHaveLength(0);

    const terminal = store.upsertResult(run('transition'), 'Task');
    expect(terminal?.isNewUnread).toBe(true);
    expect(store.upsertResult(run('transition'), 'Task')?.isNewUnread).toBe(false);
  });

  test('keeps routine OpenClaw results out of the focused inbox and unread count', () => {
    store.initializeBaseline([], 1000);
    const heartbeat = store.upsertResult(
      {
        ...run('heartbeat', TaskStatus.Skipped),
        summary: null,
        error: 'heartbeat skipped: no-route',
      },
      'Heartbeat (main)',
      { systemManaged: true },
    );
    const silent = store.upsertResult(
      { ...run('silent'), summary: 'NO_REPLY' },
      'Memory Dreaming Promotion',
    );

    expect(heartbeat?.isNewUnread).toBe(false);
    expect(silent?.isNewUnread).toBe(false);
    expect(heartbeat?.result.readAt).not.toBeNull();
    expect(silent?.result.readAt).not.toBeNull();
    expect(store.countUnread()).toBe(0);
    expect(store.listResults().results).toEqual([]);
    expect(store.listResults({ includeRoutine: true }).results.map(result => result.id)).toEqual([
      'silent',
    ]);
    expect(
      store
        .listResults({ includeRoutine: true, includeSystem: true })
        .results.map(result => result.id),
    ).toEqual(['silent', 'heartbeat']);
  });

  test('does not hide user results merely because their error resembles a heartbeat skip', () => {
    store.initializeBaseline([], 1000);
    const outcome = store.upsertResult(
      {
        ...run('user-heartbeat-text', TaskStatus.Skipped),
        summary: null,
        error: 'heartbeat skipped:',
      },
      'User task',
      { systemManaged: false },
    );

    expect(outcome?.isNewUnread).toBe(true);
    expect(store.countUnread()).toBe(1);
    expect(store.listResults().results.map(result => result.id)).toEqual(['user-heartbeat-text']);
  });

  test('keeps system-managed runs available without treating them as inbox messages', () => {
    store.initializeBaseline([], 1000);
    const initial = store.upsertResult(run('system'), 'Heartbeat (main)');
    expect(initial?.isNewUnread).toBe(true);

    store.updateTaskManagement([{ taskId: 'task-1', systemManaged: true }], 2000);
    const outcome = store.getResult('system');

    expect(outcome?.systemManaged).toBe(true);
    expect(outcome?.readAt).toBe(new Date(2000).toISOString());
    expect(store.countUnread()).toBe(0);
    expect(store.listResults().results).toEqual([]);
    expect(store.listResults({ includeSystem: true }).results.map(result => result.id)).toEqual([
      'system',
    ]);
  });

  test('preserves system management when a later global refresh cannot classify the task', () => {
    store.initializeBaseline([], 1000);
    store.upsertResult(run('historical-system'), 'System task', { systemManaged: true });

    store.upsertResult({ ...run('historical-system'), summary: 'refreshed' }, 'System task');

    expect(store.getResult('historical-system')).toMatchObject({
      systemManaged: true,
      summary: 'refreshed',
    });
  });

  test('paginates deterministically and rejects malformed cursors', () => {
    store.initializeBaseline([], 1000);
    store.upsertResult(run('a'), 'Task');
    store.upsertResult(run('b'), 'Task');
    store.upsertResult(run('c'), 'Task');

    const first = store.listResults({ limit: 2 });
    expect(first.results.map(result => result.id)).toEqual(['c', 'b']);
    expect(first.nextCursor).not.toBeNull();
    expect(
      store
        .listResults({ limit: 2, cursor: first.nextCursor ?? undefined })
        .results.map(result => result.id),
    ).toEqual(['a']);
    expect(() => store.listResults({ cursor: 'bad' })).toThrow('Invalid result cursor');
  });

  test('deletes one result and prevents bulk reconciliation from restoring it', () => {
    store.initializeBaseline([], 1000);
    store.upsertResult(run('deleted'), 'Task');
    expect(store.countUnread()).toBe(1);

    expect(store.deleteResult('deleted')).toBe(true);
    expect(store.isResultDeleted('deleted')).toBe(true);
    expect(store.getBaselineWatermark('task-1')).toEqual({
      lastRunAtMs: Date.parse(run('deleted').startedAt),
    });
    expect(store.listResults().results).toHaveLength(0);
    expect(store.countUnread()).toBe(0);
    expect(store.getResult('deleted')).toBeNull();

    store = new ScheduledTaskResultStore(db);
    expect(store.upsertResults([{ run: run('deleted'), taskName: 'Task' }])).toEqual([]);
    expect(store.getResult('deleted')).toBeNull();
  });
});

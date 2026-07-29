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
        session_id TEXT, session_key TEXT, status TEXT NOT NULL, summary TEXT, error TEXT,
        delivery_status TEXT, delivery_error TEXT, started_at INTEGER NOT NULL,
        finished_at INTEGER, duration_ms INTEGER, observed_at INTEGER NOT NULL,
        read_at INTEGER, updated_at INTEGER NOT NULL
      );
    `);
    store = new ScheduledTaskResultStore(db);
  });

  afterEach(() => db.close());

  test('imports the baseline atomically as read', () => {
    store.initializeBaseline(
      [{ run: run('baseline'), taskName: 'Daily report' }],
      1000,
      [{ taskId: 'task-1', lastRunAtMs: 900 }],
    );

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

  test('marks a new terminal result unread exactly once and preserves a read receipt', () => {
    store.initializeBaseline([], 1000);

    const first = store.upsertResult(run('new'), 'Daily report', { observedAt: 2000 });
    const duplicate = store.upsertResult(run('new'), 'Daily report', { observedAt: 3000 });
    expect(first.isNewUnread).toBe(true);
    expect(duplicate.isNewUnread).toBe(false);
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
    expect(store.upsertResult(run('transition', TaskStatus.Running), 'Task').isNewUnread).toBe(
      false,
    );
    expect(store.countUnread()).toBe(0);
    expect(store.listResults({ unreadOnly: true }).results).toHaveLength(0);

    const terminal = store.upsertResult(run('transition'), 'Task');
    expect(terminal.isNewUnread).toBe(true);
    expect(store.upsertResult(run('transition'), 'Task').isNewUnread).toBe(false);
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
      store.listResults({ limit: 2, cursor: first.nextCursor ?? undefined }).results.map(
        result => result.id,
      ),
    ).toEqual(['a']);
    expect(() => store.listResults({ cursor: 'bad' })).toThrow('Invalid result cursor');
  });

  test('physically deletes one result', () => {
    store.initializeBaseline([], 1000);
    store.upsertResult(run('deleted'), 'Task');
    expect(store.countUnread()).toBe(1);

    expect(store.deleteResult('deleted')).toBe(true);
    expect(store.listResults().results).toHaveLength(0);
    expect(store.countUnread()).toBe(0);
    expect(store.getResult('deleted')).toBeNull();
  });
});

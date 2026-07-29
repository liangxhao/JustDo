import type Database from 'better-sqlite3';

import { TaskStatus } from '../../shared/scheduledTask/constants';
import type {
  ScheduledTaskResult,
  ScheduledTaskResultPage,
  ScheduledTaskResultQuery,
  ScheduledTaskRun,
} from '../../shared/scheduledTask/types';

const BASELINE_KEY = 'scheduled_task_results_baseline_v1';
const BASELINE_TASK_KEY_PREFIX = 'scheduled_task_results_baseline_task_v1:';
const CATCH_UP_KEY_PREFIX = 'scheduled_task_results_catch_up_v1:';
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

interface ResultRow {
  run_id: string;
  task_id: string;
  task_name: string;
  session_id: string | null;
  session_key: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  observed_at: number;
  read_at: number | null;
}

export interface ResultUpsertOptions {
  observedAt?: number;
  baselineReadAt?: number;
}

export interface ResultUpsertOutcome {
  result: ScheduledTaskResult;
  changed: boolean;
  isNewUnread: boolean;
}

export interface ScheduledTaskResultCatchUp {
  boundaryRunId: string;
  boundaryStartedAt: number;
  stopAt: number | null;
  ignoreKnown: boolean;
  resumeOffset: number;
}

export interface ScheduledTaskResultBaselineWatermark {
  lastRunAtMs: number | null;
}

function toMillis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowToResult(row: ResultRow): ScheduledTaskResult {
  return {
    id: row.run_id,
    taskId: row.task_id,
    taskName: row.task_name,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    status: row.status as ScheduledTaskResult['status'],
    summary: row.summary,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    durationMs: row.duration_ms,
    error: row.error,
    deliveryStatus: row.delivery_status,
    deliveryError: row.delivery_error,
    observedAt: new Date(row.observed_at).toISOString(),
    readAt: row.read_at === null ? null : new Date(row.read_at).toISOString(),
  };
}

function encodeCursor(startedAt: number, runId: string): string {
  return Buffer.from(JSON.stringify([startedAt, runId]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'number' ||
      !Number.isFinite(value[0]) ||
      typeof value[1] !== 'string' ||
      !value[1]
    ) {
      throw new Error();
    }
    return [value[0], value[1]];
  } catch {
    throw new Error('Invalid result cursor');
  }
}

export class ScheduledTaskResultStore {
  constructor(private readonly db: Database.Database) {}

  hasInitializedBaseline(): boolean {
    return !!this.db.prepare('SELECT 1 FROM kv WHERE key = ?').get(BASELINE_KEY);
  }

  getBaselineAt(): number | null {
    const row = this.db
      .prepare('SELECT updated_at FROM kv WHERE key = ?')
      .get(BASELINE_KEY) as { updated_at: number } | undefined;
    return row && Number.isFinite(row.updated_at) ? row.updated_at : null;
  }

  getBaselineWatermark(taskId: string): ScheduledTaskResultBaselineWatermark | null {
    const row = this.db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(`${BASELINE_TASK_KEY_PREFIX}${taskId}`) as { value: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as Partial<ScheduledTaskResultBaselineWatermark>;
      if (
        value.lastRunAtMs !== null &&
        (typeof value.lastRunAtMs !== 'number' || !Number.isFinite(value.lastRunAtMs))
      ) {
        return null;
      }
      return { lastRunAtMs: value.lastRunAtMs ?? null };
    } catch {
      return null;
    }
  }

  getCatchUp(taskId: string): ScheduledTaskResultCatchUp | null {
    const row = this.db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(`${CATCH_UP_KEY_PREFIX}${taskId}`) as { value: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as Partial<ScheduledTaskResultCatchUp>;
      if (
        typeof value.boundaryRunId !== 'string' ||
        typeof value.boundaryStartedAt !== 'number' ||
        !Number.isFinite(value.boundaryStartedAt) ||
        (value.stopAt !== null &&
          (typeof value.stopAt !== 'number' || !Number.isFinite(value.stopAt))) ||
        typeof value.ignoreKnown !== 'boolean' ||
        typeof value.resumeOffset !== 'number' ||
        !Number.isInteger(value.resumeOffset) ||
        value.resumeOffset < 0
      ) {
        return null;
      }
      return value as ScheduledTaskResultCatchUp;
    } catch {
      return null;
    }
  }

  setCatchUp(taskId: string, catchUp: ScheduledTaskResultCatchUp | null): void {
    const key = `${CATCH_UP_KEY_PREFIX}${taskId}`;
    if (!catchUp) {
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return;
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(catchUp), now);
  }

  initializeBaseline(
    results: Array<{ run: ScheduledTaskRun; taskName: string }>,
    baselineAt = Date.now(),
    taskWatermarks: Array<{ taskId: string; lastRunAtMs: number | null }> = [],
  ): void {
    this.db.transaction(() => {
      if (this.hasInitializedBaseline()) return;
      for (const result of results) {
        this.upsertResult(result.run, result.taskName, {
          observedAt: baselineAt,
          baselineReadAt: baselineAt,
        });
      }
      const upsertWatermark = this.db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      for (const watermark of taskWatermarks) {
        upsertWatermark.run(
          `${BASELINE_TASK_KEY_PREFIX}${watermark.taskId}`,
          JSON.stringify({ lastRunAtMs: watermark.lastRunAtMs }),
          baselineAt,
        );
      }
      this.db
        .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(BASELINE_KEY, JSON.stringify(true), baselineAt);
    })();
  }

  upsertResult(
    run: ScheduledTaskRun,
    taskName: string,
    options: ResultUpsertOptions = {},
  ): ResultUpsertOutcome {
    const existing = this.db
      .prepare('SELECT * FROM scheduled_task_run_receipts WHERE run_id = ?')
      .get(run.id) as ResultRow | undefined;
    const observedAt = existing?.observed_at ?? options.observedAt ?? Date.now();
    const terminal = run.status !== TaskStatus.Running;
    const existingTerminal = existing ? existing.status !== TaskStatus.Running : false;
    const isNewUnread =
      terminal &&
      options.baselineReadAt === undefined &&
      ((!existing && this.hasInitializedBaseline()) || (!!existing && !existingTerminal));
    const readAt = existing?.read_at ?? options.baselineReadAt ?? null;
    const startedAt = toMillis(run.startedAt);
    if (startedAt === null) throw new Error(`Invalid start timestamp for run ${run.id}`);

    const values = [
      run.id,
      run.taskId,
      taskName,
      run.sessionId,
      run.sessionKey,
      run.status,
      run.summary,
      run.error,
      run.deliveryStatus,
      run.deliveryError,
      startedAt,
      toMillis(run.finishedAt),
      run.durationMs,
      observedAt,
      readAt,
      Date.now(),
    ];
    const before = existing ? JSON.stringify(rowToResult(existing)) : null;
    this.db
      .prepare(
        `INSERT INTO scheduled_task_run_receipts (
          run_id, task_id, task_name, session_id, session_key, status, summary, error,
          delivery_status, delivery_error, started_at, finished_at, duration_ms,
          observed_at, read_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          task_id = excluded.task_id,
          task_name = CASE
            WHEN scheduled_task_run_receipts.task_name = scheduled_task_run_receipts.task_id
              AND excluded.task_name <> excluded.task_id
              THEN excluded.task_name
            ELSE scheduled_task_run_receipts.task_name
          END,
          session_id = excluded.session_id,
          session_key = excluded.session_key,
          status = excluded.status,
          summary = excluded.summary,
          error = excluded.error,
          delivery_status = excluded.delivery_status,
          delivery_error = excluded.delivery_error,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          duration_ms = excluded.duration_ms,
          read_at = CASE
            WHEN scheduled_task_run_receipts.read_at IS NOT NULL
              THEN scheduled_task_run_receipts.read_at
            ELSE excluded.read_at
          END,
          updated_at = excluded.updated_at`,
      )
      .run(...values);
    const result = this.getResult(run.id);
    if (!result) throw new Error(`Failed to upsert scheduled task result ${run.id}`);
    return { result, changed: before !== JSON.stringify(result), isNewUnread };
  }

  upsertResults(
    results: Array<{ run: ScheduledTaskRun; taskName: string }>,
  ): ResultUpsertOutcome[] {
    return this.db.transaction(() =>
      results.map(result => this.upsertResult(result.run, result.taskName)),
    )();
  }

  getResult(runId: string): ScheduledTaskResult | null {
    const row = this.db
      .prepare('SELECT * FROM scheduled_task_run_receipts WHERE run_id = ?')
      .get(runId) as ResultRow | undefined;
    return row ? rowToResult(row) : null;
  }

  listResults(query: ScheduledTaskResultQuery = {}): ScheduledTaskResultPage {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE)));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.taskId?.trim()) {
      clauses.push('task_id = ?');
      params.push(query.taskId.trim());
    }
    if (query.unreadOnly) clauses.push("read_at IS NULL AND status != 'running'");
    if (query.cursor) {
      const [startedAt, runId] = decodeCursor(query.cursor);
      clauses.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
      params.push(startedAt, startedAt, runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_task_run_receipts ${where}
         ORDER BY started_at DESC, run_id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as ResultRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      results: pageRows.map(rowToResult),
      nextCursor: hasMore && last ? encodeCursor(last.started_at, last.run_id) : null,
      unreadCount: this.countUnread(),
    };
  }

  countUnread(taskId?: string): number {
    const row = (taskId?.trim()
      ? this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM scheduled_task_run_receipts WHERE read_at IS NULL AND status != 'running' AND task_id = ?",
          )
          .get(taskId.trim())
      : this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM scheduled_task_run_receipts WHERE read_at IS NULL AND status != 'running'",
          )
          .get()) as { count: number };
    return row.count;
  }

  markRead(runId: string, readAt = Date.now()): ScheduledTaskResult | null {
    const updated = this.db
      .prepare(
        'UPDATE scheduled_task_run_receipts SET read_at = COALESCE(read_at, ?), updated_at = ? WHERE run_id = ?',
      )
      .run(readAt, readAt, runId);
    return updated.changes > 0 ? this.getResult(runId) : null;
  }

  markAllRead(readAt = Date.now(), taskId?: string): number {
    const result = taskId?.trim()
      ? this.db
          .prepare(
            "UPDATE scheduled_task_run_receipts SET read_at = ?, updated_at = ? WHERE read_at IS NULL AND status != 'running' AND task_id = ?",
          )
          .run(readAt, readAt, taskId.trim())
      : this.db
          .prepare(
            "UPDATE scheduled_task_run_receipts SET read_at = ?, updated_at = ? WHERE read_at IS NULL AND status != 'running'",
          )
          .run(readAt, readAt);
    return result.changes;
  }

  deleteResult(runId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM scheduled_task_run_receipts WHERE run_id = ?')
      .run(runId);
    return result.changes > 0;
  }

  getLatestStartedAt(taskId?: string): number | null {
    const row = (taskId
      ? this.db
          .prepare(
            'SELECT MAX(started_at) AS started_at FROM scheduled_task_run_receipts WHERE task_id = ?',
          )
          .get(taskId)
      : this.db
          .prepare('SELECT MAX(started_at) AS started_at FROM scheduled_task_run_receipts')
          .get()) as { started_at: number | null };
    return row.started_at;
  }
}

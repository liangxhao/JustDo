import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type {
  DiagnosticCoverage,
  DiagnosticEvent,
  DiagnosticRun,
} from '../../shared/cowork/sessionDiagnostics';

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const GLOBAL_LIMIT = 20_000;

export function initializeSessionDiagnosticsTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_run_diagnostic_coverage (
      run_id TEXT PRIMARY KEY REFERENCES cowork_session_runs(id) ON DELETE CASCADE,
      first_observed_at INTEGER NOT NULL,
      dropped INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cowork_run_diagnostic_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES cowork_session_runs(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL,
      critical INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_diagnostics_run
      ON cowork_run_diagnostic_events(run_id, critical, observed_at);
    CREATE INDEX IF NOT EXISTS idx_run_diagnostics_time
      ON cowork_run_diagnostic_events(observed_at);
  `);
}

type RunRow = {
  id: string;
  started_at: number;
  ended_at: number | null;
  state: DiagnosticRun['state'];
};
const mapRun = (row: RunRow): DiagnosticRun => ({
  id: row.id,
  startedAt: row.started_at,
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  state: row.state,
});

/** Stores metadata only. Identity is always checked against the owning product run. */
export class SessionDiagnosticsStore {
  constructor(private readonly db: Database.Database) {}

  getRun(sessionId: string, runId?: string): DiagnosticRun | undefined {
    const row = this.db
      .prepare(
        `SELECT id, started_at, ended_at, state FROM cowork_session_runs
       WHERE session_id = ? ${runId ? 'AND id = ?' : ''}
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(...(runId ? [sessionId, runId] : [sessionId])) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  resolveRun(sessionId: string, nativeRunId: string): string | undefined {
    const rows = this.db
      .prepare(
        `SELECT id FROM cowork_session_runs WHERE session_id = ?
       AND (root_run_id = ? OR client_turn_id = ?) LIMIT 2`,
      )
      .all(sessionId, nativeRunId, nativeRunId) as { id: string }[];
    return rows.length === 1 ? rows[0].id : undefined;
  }

  listRuns(sessionId: string, cursor?: string): { runs: DiagnosticRun[]; nextCursor?: string } {
    const anchor = cursor ? this.getRun(sessionId, cursor) : undefined;
    if (cursor && !anchor) throw new Error('Invalid diagnostic run cursor');
    const rows = this.db
      .prepare(
        `SELECT id, started_at, ended_at, state FROM cowork_session_runs WHERE session_id = ?
       ${anchor ? 'AND (started_at < ? OR (started_at = ? AND id < ?))' : ''}
       ORDER BY started_at DESC, id DESC LIMIT 21`,
      )
      .all(
        ...(anchor ? [sessionId, anchor.startedAt, anchor.startedAt, anchor.id] : [sessionId]),
      ) as RunRow[];
    const runs = rows.slice(0, 20).map(mapRun);
    return { runs, ...(rows.length > 20 ? { nextCursor: runs[19].id } : {}) };
  }

  append(sessionId: string, event: DiagnosticEvent): void {
    if (!this.getRun(sessionId, event.runId)) return;
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload, 'utf8') > 2048) {
      this.db
        .prepare(
          `INSERT INTO cowork_run_diagnostic_coverage
        (run_id, first_observed_at, dropped) VALUES (?, ?, 1)
        ON CONFLICT(run_id) DO UPDATE SET dropped = dropped + 1`,
        )
        .run(event.runId, event.observedAt);
      return;
    }
    const critical =
      event.kind === 'cancel' ||
      event.executionSettled === true ||
      (event.kind === 'chat' && ['final', 'aborted', 'error'].includes(event.phase));
    const { id: _id, observedAt: _observedAt, ...projection } = event;
    const dedupe = createHash('sha256')
      .update(
        JSON.stringify(
          event.sequence === undefined
            ? projection
            : {
                runId: event.runId,
                nativeRunId: event.nativeRunId,
                generation: event.generation,
                epoch: event.epoch,
                sequence: event.sequence,
                kind: event.kind,
                phase: event.phase,
              },
        ),
      )
      .digest('hex');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cowork_run_diagnostic_coverage
        (run_id, first_observed_at) VALUES (?, ?)`,
        )
        .run(event.runId, event.observedAt);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cowork_run_diagnostic_events
        (id, run_id, observed_at, critical, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(event.id, event.runId, event.observedAt, Number(critical), dedupe, payload);
      this.remove(
        this.db
          .prepare(
            `SELECT id, run_id FROM cowork_run_diagnostic_events
        WHERE run_id = ? AND critical = ? ORDER BY observed_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
          )
          .all(event.runId, Number(critical), critical ? 32 : 200) as RemovedRow[],
      );
      this.prune();
    })();
  }

  /** Explicit startup maintenance; reads themselves remain read-only. */
  prune(now = Date.now()): void {
    this.db.transaction(() => {
      this.remove(
        this.db
          .prepare(
            `SELECT id, run_id FROM cowork_run_diagnostic_events
        WHERE observed_at < ?`,
          )
          .all(now - RETENTION_MS) as RemovedRow[],
      );
      this.remove(
        this.db
          .prepare(
            `SELECT id, run_id FROM cowork_run_diagnostic_events
        ORDER BY observed_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
          )
          .all(GLOBAL_LIMIT) as RemovedRow[],
      );
    })();
  }

  private remove(rows: RemovedRow[]): void {
    const remove = this.db.prepare('DELETE FROM cowork_run_diagnostic_events WHERE id = ?');
    const dropped = this.db.prepare(
      'UPDATE cowork_run_diagnostic_coverage SET dropped = dropped + ? WHERE run_id = ?',
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      remove.run(row.id);
      counts.set(row.run_id, (counts.get(row.run_id) ?? 0) + 1);
    }
    for (const [runId, count] of counts) dropped.run(count, runId);
  }

  read(
    sessionId: string,
    runId: string,
  ): { events: DiagnosticEvent[]; coverage: DiagnosticCoverage } {
    if (!this.getRun(sessionId, runId))
      return {
        events: [],
        coverage: { dropped: 0, storageFailed: false, partial: true },
      };
    const row = this.db
      .prepare(
        `SELECT first_observed_at, dropped
      FROM cowork_run_diagnostic_coverage WHERE run_id = ?`,
      )
      .get(runId) as { first_observed_at: number; dropped: number } | undefined;
    const events = (
      this.db
        .prepare(
          `SELECT payload FROM cowork_run_diagnostic_events
      WHERE run_id = ? ORDER BY observed_at, rowid`,
        )
        .all(runId) as { payload: string }[]
    ).map(item => JSON.parse(item.payload) as DiagnosticEvent);
    return {
      events,
      coverage: {
        ...(row ? { firstObservedAt: row.first_observed_at } : {}),
        dropped: row?.dropped ?? 0,
        storageFailed: false,
        partial: true,
      },
    };
  }
}

type RemovedRow = { id: string; run_id: string };

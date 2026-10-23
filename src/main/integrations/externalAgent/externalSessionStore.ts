import type Database from 'better-sqlite3';

import {
  ExternalSessionSource,
  type ExternalSessionStatus,
} from '../../../shared/integrations/externalSession';

export const ExternalExecutionState = {
  Preparing: 'preparing',
  Running: 'running',
  Unknown: 'unknown',
  Settled: 'settled',
} as const;

export type ExternalExecutionState =
  (typeof ExternalExecutionState)[keyof typeof ExternalExecutionState];

export interface ExternalSession {
  externalSessionKey: string;
  coworkSessionId: string;
  agentId: string;
  openclawSessionKey: string;
  cwd: string;
  status: ExternalSessionStatus;
  createdAt: number;
  updatedAt: number;
  executionRunId?: string;
  nativeSessionId?: string;
  lifecycleRevision?: string;
  executionState?: ExternalExecutionState;
}

interface ExternalSessionRow {
  external_session_key: string;
  cowork_session_id: string;
  agent_id: string;
  openclaw_session_key: string | null;
  cwd: string;
  status: ExternalSessionStatus;
  created_at: number;
  updated_at: number;
  execution_run_id: string | null;
  native_session_id: string | null;
  lifecycle_revision: string | null;
  execution_state: ExternalExecutionState | null;
}

/** Identity and execution receipts only. The Gateway owns conversation content. */
export class ExternalSessionStore {
  constructor(
    protected readonly db: Database.Database,
    readonly source: ExternalSessionSource = ExternalSessionSource.Cli,
  ) {}

  get(externalSessionKey: string): ExternalSession | null {
    const row = this.db
      .prepare(
        'SELECT * FROM cowork_external_sessions WHERE source = ? AND external_session_key = ?',
      )
      .get(this.source, externalSessionKey) as ExternalSessionRow | undefined;
    return row ? this.map(row) : null;
  }

  countUnsettled(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM cowork_external_sessions
       WHERE source = ? AND status = 'running'
         AND (execution_state IS NULL OR execution_state != 'settled')`,
        )
        .get(this.source) as { count: number }
    ).count;
  }

  wasDeleted(externalSessionKey: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM cowork_external_session_tombstones WHERE source = ? AND external_session_key = ?',
        )
        .get(this.source, externalSessionKey),
    );
  }

  create(input: {
    externalSessionKey: string;
    coworkSessionId: string;
    agentId: string;
    openclawSessionKey: string;
    cwd: string;
  }): ExternalSession {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cowork_external_sessions
        (source, external_session_key, cowork_session_id, agent_id, openclaw_session_key, cwd, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        this.source,
        input.externalSessionKey,
        input.coworkSessionId,
        input.agentId,
        input.openclawSessionKey,
        input.cwd,
        now,
        now,
      );
    return { ...input, status: 'running', createdAt: now, updatedAt: now };
  }

  setStatus(externalSessionKey: string, status: ExternalSessionStatus): void {
    this.db
      .prepare(
        `UPDATE cowork_external_sessions SET status = ?, updated_at = ?
       WHERE source = ? AND external_session_key = ?`,
      )
      .run(status, Date.now(), this.source, externalSessionKey);
  }

  setOpenClawSessionKey(externalSessionKey: string, sessionKey: string): void {
    this.db
      .prepare(
        `UPDATE cowork_external_sessions SET openclaw_session_key = ?, updated_at = ?
       WHERE source = ? AND external_session_key = ?`,
      )
      .run(sessionKey, Date.now(), this.source, externalSessionKey);
  }

  beginExecution(externalSessionKey: string, runId: string): void {
    const changed = this.db
      .prepare(
        `UPDATE cowork_external_sessions
       SET status = 'running', execution_run_id = ?, execution_state = 'preparing', updated_at = ?
       WHERE source = ? AND external_session_key = ? AND status != 'running'
         AND (execution_state IS NULL OR execution_state = 'settled')`,
      )
      .run(runId, Date.now(), this.source, externalSessionKey).changes;
    if (changed !== 1) throw new Error('This conversation has an active or unconfirmed execution.');
  }

  bindExecution(
    externalSessionKey: string,
    runId: string,
    binding: {
      sessionKey: string;
      sessionId: string;
      lifecycleRevision: string;
    },
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE cowork_external_sessions
       SET openclaw_session_key = ?, native_session_id = ?, lifecycle_revision = ?,
           execution_state = 'running', updated_at = ?
       WHERE source = ? AND external_session_key = ? AND execution_run_id = ?
         AND execution_state = 'preparing'`,
      )
      .run(
        binding.sessionKey,
        binding.sessionId,
        binding.lifecycleRevision,
        Date.now(),
        this.source,
        externalSessionKey,
        runId,
      ).changes;
    if (changed !== 1) throw new Error('External execution ownership changed during preparation.');
  }

  markExecutionUnknown(externalSessionKey: string, runId: string): void {
    this.db
      .prepare(
        `UPDATE cowork_external_sessions SET execution_state = 'unknown', updated_at = ?
       WHERE source = ? AND external_session_key = ? AND execution_run_id = ?
         AND execution_state IN ('preparing', 'running', 'unknown')`,
      )
      .run(Date.now(), this.source, externalSessionKey, runId);
  }

  finishExecution(externalSessionKey: string, runId: string, status: ExternalSessionStatus): void {
    const changed = this.db
      .prepare(
        `UPDATE cowork_external_sessions SET status = ?, execution_state = 'settled', updated_at = ?
       WHERE source = ? AND external_session_key = ? AND execution_run_id = ?`,
      )
      .run(status, Date.now(), this.source, externalSessionKey, runId).changes;
    if (changed !== 1) throw new Error('External execution ownership changed before settlement.');
  }

  private map(row: ExternalSessionRow): ExternalSession {
    return {
      externalSessionKey: row.external_session_key,
      coworkSessionId: row.cowork_session_id,
      agentId: row.agent_id,
      openclawSessionKey: row.openclaw_session_key ?? '',
      cwd: row.cwd,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.execution_run_id ? { executionRunId: row.execution_run_id } : {}),
      ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}),
      ...(row.lifecycle_revision ? { lifecycleRevision: row.lifecycle_revision } : {}),
      ...(row.execution_state ? { executionState: row.execution_state } : {}),
    };
  }
}

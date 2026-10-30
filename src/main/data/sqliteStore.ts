import Database from 'better-sqlite3';
import { app } from 'electron';
import { EventEmitter } from 'events';
import path from 'path';

import { DB_FILENAME } from '../core/appConstants';
import { transformAppConfigCredentials } from './appConfigCredentials';
import { initializeSessionDiagnosticsTables } from './sessionDiagnosticsStore';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

export class SqliteStore {
  private db: Database.Database;
  private dbPath: string;
  private emitter = new EventEmitter();

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static create(userDataPath?: string): SqliteStore {
    const basePath = userDataPath ?? app.getPath('userData');
    const dbPath = path.join(basePath, DB_FILENAME);

    const db = new Database(dbPath);
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cowork_messages'").get()
    ) {
      db.close();
      throw new Error('Legacy history must be backed up before opening the product database.');
    }

    // WAL+NORMAL preserves consistency, but recent commits may be lost on OS/power
    // failure. Critical migration receipts use a local FULL commit barrier.
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -8000'); // 8 MB; negative value = kibibytes
    db.pragma('wal_autocheckpoint = 1000'); // checkpoint every ~4 MB of WAL writes

    const store = new SqliteStore(db, dbPath);
    try {
      store.initializeTables();
    } catch (error) {
      db.close();
      throw error;
    }
    return store;
  }

  private initializeTables() {
    // Startup migration creates a fresh product database. Current databases
    // reopen as-is; intermediate development schemas are not altered in place.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create cowork tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        execution_mode TEXT,
        permission_mode TEXT,
        active_skill_ids TEXT,
        agent_id TEXT NOT NULL DEFAULT 'main',
        model_ref TEXT,
        source TEXT,
        native_session_key TEXT,
        native_parent_session_id TEXT,
        handoff_from_session_id TEXT REFERENCES cowork_sessions(id) ON DELETE SET NULL,
        handoff_from_session_title TEXT,
        handoff_request_id TEXT,
        forked_from_session_id TEXT REFERENCES cowork_sessions(id) ON DELETE SET NULL,
        forked_from_session_title TEXT,
        forked_from_entry_id TEXT,
        group_id TEXT REFERENCES session_groups(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_native_session_key ON cowork_sessions(native_session_key) WHERE native_session_key IS NOT NULL',
    );
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_handoff_request ON cowork_sessions(handoff_request_id) WHERE handoff_request_id IS NOT NULL',
    );

    // Published JSONL profiles are backed up and isolated before this connection
    // opens. Never delete the only surviving cache or upgrade it in place here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_session_bindings (
        session_id TEXT PRIMARY KEY REFERENCES cowork_sessions(id) ON DELETE CASCADE,
        session_key TEXT NOT NULL UNIQUE,
        native_session_id TEXT NOT NULL,
        availability TEXT NOT NULL CHECK (availability IN ('native','cache','missing')),
        source TEXT,
        external_key TEXT,
        source_agent_id TEXT NOT NULL,
        source_session_key TEXT NOT NULL,
        source_native_session_id TEXT,
        transaction_id TEXT NOT NULL,
        defaults_applied INTEGER NOT NULL DEFAULT 1
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_session_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_turn_id TEXT NOT NULL UNIQUE,
        root_run_id TEXT,
        model_ref TEXT,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        accepted_at INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cowork_session_runs_session_started
        ON cowork_session_runs(session_id, started_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_session_runs_open
        ON cowork_session_runs(session_id)
        WHERE ended_at IS NULL;
    `);
    initializeSessionDiagnosticsTables(this.db);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_external_sessions (
        source TEXT NOT NULL,
        external_session_key TEXT NOT NULL,
        cowork_session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        openclaw_session_key TEXT,
        execution_run_id TEXT,
        native_session_id TEXT,
        lifecycle_revision TEXT,
        execution_state TEXT,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, external_session_key),
        FOREIGN KEY (cowork_session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_external_sessions_cowork
        ON cowork_external_sessions(cowork_session_id);
      CREATE INDEX IF NOT EXISTS idx_cowork_external_sessions_status
        ON cowork_external_sessions(source, status, updated_at);

      CREATE TABLE IF NOT EXISTS cowork_external_session_tombstones (
        source TEXT NOT NULL,
        external_session_key TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (source, external_session_key)
      );

      CREATE TRIGGER IF NOT EXISTS trg_cowork_external_session_tombstone
      BEFORE DELETE ON cowork_sessions
      BEGIN
        INSERT OR REPLACE INTO cowork_external_session_tombstones
          (source, external_session_key, deleted_at)
        SELECT source, external_session_key, CAST(unixepoch('subsec') * 1000 AS INTEGER)
        FROM cowork_external_sessions
        WHERE cowork_session_id = OLD.id;
      END;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_plan_handoffs (
        plan_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        planning_session_key TEXT NOT NULL,
        artifact_workspace_root TEXT NOT NULL,
        artifact_relative_path TEXT NOT NULL UNIQUE,
        artifact_sha256 TEXT NOT NULL,
        artifact_byte_length INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('presented', 'dispatching', 'admitted', 'resolved', 'failed')
        ),
        implementation_session_key TEXT,
        implementation_gateway_session_id TEXT,
        implementation_run_id TEXT,
        error TEXT,
        presented_at INTEGER NOT NULL,
        dispatch_started_at INTEGER,
        admitted_at INTEGER,
        resolved_at INTEGER,
        failed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cowork_plan_handoffs_session_presented
        ON cowork_plan_handoffs(session_id, presented_at, plan_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_plan_handoffs_active
        ON cowork_plan_handoffs(session_id)
        WHERE state IN ('presented', 'dispatching', 'admitted');
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create agents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        identity TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '',
        skill_ids TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create MCP servers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Create OpenClaw hooks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openclaw_hooks (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create session groups table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#6366f1',
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_task_run_receipts (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        system_managed INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        session_key TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        delivery_status TEXT,
        delivery_error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        observed_at INTEGER NOT NULL,
        read_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_task_results_started
        ON scheduled_task_run_receipts(started_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_results_task_started
        ON scheduled_task_run_receipts(task_id, started_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_results_unread
        ON scheduled_task_run_receipts(read_at, started_at DESC)
        WHERE read_at IS NULL;

      CREATE TABLE IF NOT EXISTS scheduled_task_result_cleanup (
        run_id TEXT PRIMARY KEY,
        archived_paths_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_task_result_tombstones (
        run_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
    `);
    // Additive product receipt metadata preserves existing users' results/read state.
    // Native session databases and historical product schemas are not migrated here.
    const receiptColumns = this.db
      .prepare('PRAGMA table_info(scheduled_task_run_receipts)')
      .all() as Array<{ name: string }>;
    if (!receiptColumns.some(column => column.name === 'metadata_json')) {
      this.db.exec(
        "ALTER TABLE scheduled_task_run_receipts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
      );
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cowork_sessions_agent_order
      ON cowork_sessions(agent_id, pinned DESC, updated_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cowork_sessions_order
      ON cowork_sessions(pinned DESC, updated_at DESC);
    `);

    // Ensure the default main agent exists in a new product database.
    try {
      const mainAgent = this.db.prepare("SELECT id FROM agents WHERE id = 'main'").get();
      if (!mainAgent) {
        const now = Date.now();
        this.db
          .prepare(
            `
          INSERT INTO agents (id, name, description, system_prompt, identity, model, icon, skill_ids, enabled, is_default, created_at, updated_at)
          VALUES ('main', 'main', '', '', '', '', '', '[]', 1, 1, ?, ?)
        `,
          )
          .run(now, now);
      }
    } catch (error) {
      console.warn('Failed to ensure main agent:', error);
    }

    this.db.pragma('optimize');
  }

  onDidChange<T = unknown>(
    key: string,
    callback: (newValue: T | undefined, oldValue: T | undefined) => void,
  ) {
    const handler = (payload: ChangePayload<T>) => {
      if (payload.key !== key) return;
      callback(payload.newValue, payload.oldValue);
    };
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      console.warn(`[SqliteStore] Failed to parse stored JSON for ${key}`);
      return undefined;
    }
    return (key === 'app_config' ? transformAppConfigCredentials(value) : value) as T;
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    const persistedValue = key === 'app_config' ? transformAppConfigCredentials(value) : value;
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
      )
      .run(key, JSON.stringify(persistedValue), now);
    this.emitter.emit('change', { key, newValue: value, oldValue } as ChangePayload<T>);
  }

  delete(key: string): void {
    const oldValue = this.get(key);
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

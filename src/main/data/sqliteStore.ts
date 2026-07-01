import Database from 'better-sqlite3';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { DB_FILENAME } from '../core/appConstants';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

const REQUIRED_TABLE_COLUMNS: Record<string, string[]> = {
  cowork_sessions: [
    'id',
    'title',
    'claude_session_id',
    'status',
    'pinned',
    'cwd',
    'execution_mode',
    'active_skill_ids',
    'agent_id',
    'group_id',
    'created_at',
    'updated_at',
  ],
  cowork_messages: [
    'id',
    'session_id',
    'type',
    'content',
    'metadata',
    'created_at',
    'sequence',
    'thinking_content',
    'model_name',
    'usage',
  ],
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

    SqliteStore.deleteLegacyDatabase(dbPath);

    const db = new Database(dbPath);

    // WAL mode: persists across connections, never reverts. NORMAL sync is safe under WAL
    // (no data loss on OS crash; power-loss risk is the same as DELETE mode).
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -8000'); // 8 MB; negative value = kibibytes
    db.pragma('wal_autocheckpoint = 1000'); // checkpoint every ~4 MB of WAL writes

    const store = new SqliteStore(db, dbPath);
    store.initializeTables(basePath);
    return store;
  }

  private static deleteLegacyDatabase(dbPath: string): void {
    if (!fs.existsSync(dbPath)) return;

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      if (!SqliteStore.hasLegacySchema(db)) return;
    } catch (error) {
      console.warn('[SqliteStore] Failed to inspect existing database schema:', error);
      return;
    } finally {
      db?.close();
    }

    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch (error) {
        console.warn(`[SqliteStore] Failed to delete legacy database file ${filePath}:`, error);
      }
    }
    console.warn('[SqliteStore] Deleted legacy database schema. A fresh database will be created.');
  }

  private static hasLegacySchema(db: Database.Database): boolean {
    for (const [tableName, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName);
      if (!table) continue;

      const columns = db.pragma(`table_info(${tableName})`) as Array<{ name: string }>;
      const columnNames = new Set(columns.map(column => column.name));
      if (requiredColumns.some(column => !columnNames.has(column))) {
        return true;
      }
    }

    return false;
  }

  private initializeTables(basePath: string) {
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
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        execution_mode TEXT,
        active_skill_ids TEXT,
        agent_id TEXT NOT NULL DEFAULT 'main',
        group_id TEXT REFERENCES session_groups(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER,
        thinking_content TEXT,
        model_name TEXT,
        usage TEXT,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);
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
        source TEXT NOT NULL DEFAULT 'custom',
        preset_id TEXT NOT NULL DEFAULT '',
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
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_sequence
      ON cowork_messages(session_id, sequence, created_at);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cowork_sessions_agent_order
      ON cowork_sessions(agent_id, pinned DESC, updated_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cowork_sessions_order
      ON cowork_sessions(pinned DESC, updated_at DESC);
    `);

    // Migration: Ensure default 'main' agent exists
    try {
      const mainAgent = this.db.prepare("SELECT id FROM agents WHERE id = 'main'").get();
      if (!mainAgent) {
        const now = Date.now();
        // Read existing systemPrompt from cowork_config to inherit into main agent
        let existingSystemPrompt = '';
        try {
          const spRow = this.db
            .prepare("SELECT value FROM cowork_config WHERE key = 'systemPrompt'")
            .get() as { value: string } | undefined;
          if (spRow?.value) {
            existingSystemPrompt = spRow.value;
          }
        } catch {
          // No existing systemPrompt
        }
        this.db
          .prepare(
            `
          INSERT INTO agents (id, name, description, system_prompt, identity, model, icon, skill_ids, enabled, is_default, source, preset_id, created_at, updated_at)
          VALUES ('main', 'main', '', ?, '', '', '', '[]', 1, 1, 'custom', '', ?, ?)
        `,
          )
          .run(existingSystemPrompt, now, now);
      }
    } catch (error) {
      console.warn('Failed to ensure main agent:', error);
    }

    try {
      this.db.exec(
        `UPDATE cowork_sessions SET execution_mode = 'local' WHERE execution_mode = 'container';`,
      );
      this.db.exec(`
        UPDATE cowork_config
        SET value = 'local'
        WHERE key = 'executionMode' AND value = 'container';
      `);
    } catch (error) {
      console.warn('Failed to migrate cowork execution mode:', error);
    }

    this.cleanupOrphanedCoworkMessages();
    this.db.pragma('optimize');

    this.migrateFromElectronStore(basePath);
  }

  private cleanupOrphanedCoworkMessages(): void {
    try {
      const result = this.db
        .prepare(
          `
          DELETE FROM cowork_messages
          WHERE NOT EXISTS (
            SELECT 1
            FROM cowork_sessions
            WHERE cowork_sessions.id = cowork_messages.session_id
          )
        `,
        )
        .run();
      if (result.changes > 0) {
        console.warn(`[SqliteStore] Removed ${result.changes} orphaned cowork message(s).`);
      }
    } catch (error) {
      console.warn('[SqliteStore] Failed to clean orphaned cowork messages:', error);
    }
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
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch (error) {
      console.warn(`Failed to parse store value for ${key}`, error);
      return undefined;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
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
      .run(key, JSON.stringify(value), now);
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

  private migrateFromElectronStore(userDataPath: string) {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM kv').get() as { count: number };
    if (row.count > 0) return;

    const legacyPath = path.join(userDataPath, 'config.json');
    if (!fs.existsSync(legacyPath)) return;

    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data || typeof data !== 'object') return;

      const entries = Object.entries(data);
      if (!entries.length) return;

      const now = Date.now();
      const insert = this.db.prepare(`
        INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      `);
      const migrate = this.db.transaction(() => {
        for (const [key, value] of entries) {
          insert.run(key, JSON.stringify(value), now);
        }
      });

      migrate();
      console.info(`Migrated ${entries.length} entries from electron-store.`);
    } catch (error) {
      console.warn('Failed to migrate electron-store data:', error);
    }
  }
}

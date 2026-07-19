import type Database from 'better-sqlite3';

export interface OpenClawHookRecord {
  id: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface OpenClawHookRow {
  id: string;
  enabled: number;
  config_json: string;
  created_at: number;
  updated_at: number;
}

export class OpenClawHookStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  listHooks(): OpenClawHookRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, enabled, config_json, created_at, updated_at FROM openclaw_hooks ORDER BY id ASC',
      )
      .all() as OpenClawHookRow[];
    return rows.map(row => this.deserializeRow(row));
  }

  getHook(id: string): OpenClawHookRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, enabled, config_json, created_at, updated_at FROM openclaw_hooks WHERE id = ?',
      )
      .get(id) as OpenClawHookRow | undefined;
    return row ? this.deserializeRow(row) : null;
  }

  setEnabled(id: string, enabled: boolean): OpenClawHookRecord {
    const existing = this.getHook(id);
    const now = Date.now();
    const configJson = JSON.stringify(existing?.config ?? {});

    this.db
      .prepare(
        `INSERT INTO openclaw_hooks (id, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(id, enabled ? 1 : 0, configJson, now, now);

    return this.getHook(id)!;
  }

  deleteHook(id: string): boolean {
    return this.db.prepare('DELETE FROM openclaw_hooks WHERE id = ?').run(id).changes > 0;
  }

  restoreHook(record: OpenClawHookRecord): void {
    this.db
      .prepare(
        `INSERT INTO openclaw_hooks (id, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.enabled ? 1 : 0,
        JSON.stringify(record.config),
        record.createdAt,
        record.updatedAt,
      );
  }

  importEntries(entries: Record<string, unknown>): void {
    const now = Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO openclaw_hooks (id, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );

    const importRows = this.db.transaction(() => {
      for (const [id, rawEntry] of Object.entries(entries)) {
        if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
          continue;
        }
        const entry = rawEntry as Record<string, unknown>;
        const { enabled, ...config } = entry;
        upsert.run(id, enabled === true ? 1 : 0, JSON.stringify(config), now, now);
      }
    });

    importRows();
  }

  getEntriesForConfig(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      this.listHooks().map(record => [
        record.id,
        {
          ...record.config,
          enabled: record.enabled,
        },
      ]),
    );
  }

  private deserializeRow(row: OpenClawHookRow): OpenClawHookRecord {
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.config_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON, use defaults.
    }

    return {
      id: row.id,
      enabled: row.enabled === 1,
      config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

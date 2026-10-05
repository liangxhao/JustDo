import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Flow } from './contract.js';
export class FlowStore {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'flows.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, parent_key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS flows_parent ON flows(parent_key);',
    );
  }
  all(): Flow[] {
    return this.db
      .prepare('SELECT payload FROM flows ORDER BY rowid DESC')
      .all()
      .map(row => JSON.parse(String(row.payload)));
  }
  get(id: string): Flow | undefined {
    const row = this.db.prepare('SELECT payload FROM flows WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  insert(flow: Flow): void {
    this.db
      .prepare('INSERT INTO flows VALUES (?,?,?,?,?)')
      .run(flow.id, flow.requestId, flow.parentKey, flow.revision, JSON.stringify(flow));
  }
  put(flow: Flow): void {
    const next = { ...flow, revision: flow.revision + 1, updatedAt: Date.now() };
    const result = this.db
      .prepare('UPDATE flows SET revision=?,payload=? WHERE id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), flow.id, flow.revision);
    if (result.changes !== 1) throw new Error('Flow revision conflict.');
    Object.assign(flow, next);
  }
  close(): void {
    this.db.close();
  }
}

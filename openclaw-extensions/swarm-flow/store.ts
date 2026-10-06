import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Flow, FlowNode } from './contract.js';
import { BatchStore, stagePayload } from './batch-store.js';
export class FlowStore {
  private db: DatabaseSync;
  readonly batches: BatchStore;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'flows.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, parent_key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS flows_parent ON flows(parent_key);',
    );
    this.batches = new BatchStore(this.db);
    for (const flow of this.all()) this.batches.persist(flow);
  }
  all(): Flow[] {
    return this.db
      .prepare('SELECT payload FROM flows ORDER BY rowid DESC')
      .all()
      .map(row => this.batches.hydrate(JSON.parse(String(row.payload))));
  }
  get(id: string, itemId?: string): Flow | undefined {
    const row = this.db.prepare('SELECT payload FROM flows WHERE id=?').get(id);
    return row ? this.batches.hydrate(JSON.parse(String(row.payload)), itemId) : undefined;
  }
  insert(flow: Flow): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO flows VALUES (?,?,?,?,?)')
        .run(flow.id, flow.requestId, flow.parentKey, flow.revision, stagePayload(flow));
      this.batches.persist(flow);
      if (flow.status === 'stopping') this.batches.cancelQueued(flow.id);
    });
  }
  put(flow: Flow): void {
    const next = { ...flow, revision: flow.revision + 1, updatedAt: Date.now() };
    this.transaction(() => {
      const result = this.db
        .prepare('UPDATE flows SET revision=?,payload=? WHERE id=? AND revision=?')
        .run(next.revision, stagePayload(next), flow.id, flow.revision);
      if (result.changes !== 1) throw new Error('Flow revision conflict.');
      this.batches.persist(flow);
      if (flow.status === 'stopping') this.batches.cancelQueued(flow.id);
    });
    Object.assign(flow, next);
    this.batches.acknowledge(flow);
  }
  expandBatch(flow: Flow, stage: FlowNode, items: FlowNode[], assertCurrent: () => void): void {
    const next = { ...flow, revision: flow.revision + 1, updatedAt: Date.now() };
    this.transaction(() => {
      assertCurrent();
      this.batches.expand(flow, stage, items);
      const result = this.db
        .prepare('UPDATE flows SET revision=?,payload=? WHERE id=? AND revision=?')
        .run(next.revision, stagePayload(next), flow.id, flow.revision);
      if (result.changes !== 1) throw new Error('Flow revision conflict.');
      assertCurrent();
    });
    Object.assign(flow, next);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}

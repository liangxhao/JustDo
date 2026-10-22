import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BatchStore, stagePayload } from '../batch/store.js';
import type { WorkflowNativeChange } from '../contracts/events.js';
import type { Flow, FlowNode } from '../contracts/flow.js';
import {
  type SwarmWorkflowActivityPage,
  type SwarmWorkflowSummary,
  WORKFLOW_ACTIVITY_PAGE_SIZE,
} from '../contracts/workflow.js';

// Match the activity contract without hydrating results or batch item payloads.
// Batch stage statuses in the saved payload can lag their current item counts.
// Unexpanded stages still own their preparing state while input freezing settles.
const activeFlowSql = `json_extract(f.payload, '$.status') NOT IN ('completed','cancelled') AND (
  json_extract(f.payload, '$.status') IN ('running','stopping') OR
  EXISTS (SELECT 1 FROM json_each(f.payload, '$.nodes') n
    WHERE (json_extract(n.value, '$.kind') != 'batch'
      OR json_extract(n.value, '$.batchInput') IS NULL)
    AND json_extract(n.value, '$.status') IN ('preparing','running','uncertain')) OR
  EXISTS (SELECT 1 FROM batch_items b WHERE b.flow_id=f.id
    AND b.status IN ('preparing','running','uncertain'))
)`;
export class FlowStore {
  private db: DatabaseSync;
  private observationRevision = 0;
  private readonly observationEpoch = randomUUID();
  get snapshotVersion(): string {
    return this.observationEpoch + ':' + this.observationRevision;
  }
  readonly batches: BatchStore;
  constructor(
    directory: string,
    private readonly onChanged: (change: WorkflowNativeChange) => void = () => {},
  ) {
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
  forParents(parentKeys: readonly string[]): Flow[] {
    const keys = [...new Set(parentKeys)];
    if (!keys.length) return [];
    return this.db
      .prepare(
        `SELECT payload FROM flows WHERE parent_key IN (${keys.map(() => '?').join(',')}) ORDER BY rowid DESC`,
      )
      .all(...keys)
      .map(row => this.batches.hydrate(JSON.parse(String(row.payload))));
  }
  summary(parentKeys: readonly string[]): SwarmWorkflowSummary {
    const keys = [...new Set(parentKeys)];
    if (!keys.length) return { count: 0, running: false };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
      COALESCE(MAX(CASE WHEN ${activeFlowSql} THEN 1 ELSE 0 END),0) AS running
      FROM flows f WHERE f.parent_key IN (${keys.map(() => '?').join(',')})`,
      )
      .get(...keys)!;
    return { count: Number(row.count), running: row.running === 1 };
  }
  activity(cursor = ''): Omit<SwarmWorkflowActivityPage, 'snapshot'> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.parent_key FROM flows f
      WHERE f.parent_key > ? AND (${activeFlowSql})
      ORDER BY f.parent_key LIMIT ?`,
      )
      .all(cursor, WORKFLOW_ACTIVITY_PAGE_SIZE + 1);
    const parentKeys = rows
      .slice(0, WORKFLOW_ACTIVITY_PAGE_SIZE)
      .map(row => String(row.parent_key));
    return {
      parentKeys,
      ...(rows.length > WORKFLOW_ACTIVITY_PAGE_SIZE ? { cursor: parentKeys.at(-1)! } : {}),
    };
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
    this.notifyChanged(flow);
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
    this.notifyChanged(flow);
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
    this.notifyChanged(flow);
  }
  private notifyChanged(flow: Flow): void {
    this.observationRevision += 1;
    this.onChanged({ parentKey: flow.parentKey, flowId: flow.id, revision: flow.revision });
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

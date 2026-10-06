import type { DatabaseSync } from 'node:sqlite';
import {
  BATCH_LIMITS,
  RESULT_TRANSPORT_BYTES,
  resultTransportCost,
  type BatchCounts,
  type BatchPage,
} from './batch-contract.js';
import type { Flow, FlowIntervention, FlowNode, NodeStatus } from './contract.js';
import { FLOW_LIMITS } from './contract.js';

const statuses: NodeStatus[] = [
  'queued',
  'preparing',
  'running',
  'uncertain',
  'done',
  'failed',
  'cancelled',
];
const loaded = Symbol('batch working set');
type WorkingFlow = Flow & { [loaded]?: Map<string, string> };
export const stagePayload = (flow: Flow): string =>
  JSON.stringify({ ...flow, nodes: flow.nodes.filter(node => !node.batchItem) });

/** Business state only. Native execution owns all transcripts and run outcomes. */
export class BatchStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS batch_items (flow_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, session_key TEXT NOT NULL,
      input_version TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(flow_id,item_id),
      UNIQUE(flow_id,stage_id,ordinal));
      CREATE INDEX IF NOT EXISTS batch_queue ON batch_items(flow_id,stage_id,status,ordinal);
      CREATE INDEX IF NOT EXISTS batch_session ON batch_items(session_key);
      CREATE TABLE IF NOT EXISTS execution_runs (run_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL,
        node_id TEXT NOT NULL, attempt INTEGER NOT NULL, session_key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_sessions ON execution_runs(session_key);
      CREATE TABLE IF NOT EXISTS execution_leases (flow_id TEXT NOT NULL, node_id TEXT NOT NULL,
        run_id TEXT, PRIMARY KEY(flow_id,node_id));
      CREATE TABLE IF NOT EXISTS scheduler_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interventions (flow_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        node_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(flow_id,operation_id));`);
  }
  hydrate(flow: Flow, itemId = ''): Flow {
    const originals = new Map<string, string>();
    for (const stage of flow.nodes.filter(node => node.kind === 'batch' && node.batchInput)) {
      const counts = (stage.batchCounts = this.counts(flow.id, stage.id));
      stage.status =
        counts.done === counts.total && counts.total > 0
          ? 'done'
          : counts.preparing + counts.running + counts.uncertain > 0
            ? 'running'
            : counts.queued > 0
              ? 'queued'
              : counts.failed > 0
                ? 'failed'
                : 'cancelled';
      const rows = this.db
        .prepare(
          `SELECT item_id,payload FROM batch_items WHERE flow_id=? AND stage_id=? AND
        (status IN ('preparing','running','uncertain') OR item_id=? OR
        item_id=(SELECT item_id FROM batch_items WHERE flow_id=? AND stage_id=? AND status='queued' ORDER BY ordinal LIMIT 1) OR
        item_id=(SELECT item_id FROM batch_items WHERE flow_id=? AND stage_id=? AND status='failed' ORDER BY ordinal LIMIT 1)) ORDER BY ordinal`,
        )
        .all(flow.id, stage.id, itemId, flow.id, stage.id, flow.id, stage.id);
      for (const row of rows) {
        originals.set(String(row.item_id), String(row.payload));
        flow.nodes.push(JSON.parse(String(row.payload)));
      }
    }
    Object.defineProperty(flow, loaded, { value: originals, configurable: true });
    return flow;
  }
  /** Called inside the same transaction as the flow revision compare-and-set. */
  persist(flow: Flow): void {
    const originals = (flow as WorkingFlow)[loaded];
    for (const node of flow.nodes) {
      for (const note of node.interventions ?? []) {
        const prior = this.interventionOwner(flow.id, note.id);
        if (
          prior &&
          (prior.nodeId !== node.id || JSON.stringify(prior.note) !== JSON.stringify(note))
        )
          throw new Error('Intervention identity conflict.');
        this.db
          .prepare('INSERT OR IGNORE INTO interventions VALUES (?,?,?,?)')
          .run(flow.id, note.id, node.id, JSON.stringify(note));
      }
      if (node.batchItem) {
        if (!originals?.has(node.id))
          throw new Error('Batch item was not loaded at this revision.');
        const payload = JSON.stringify(node);
        if (originals.get(node.id) !== payload) {
          const result = this.db
            .prepare(
              'UPDATE batch_items SET status=?,session_key=?,payload=? WHERE flow_id=? AND item_id=? AND payload=?',
            )
            .run(node.status, node.sessionKey, payload, flow.id, node.id, originals.get(node.id)!);
          if (result.changes !== 1) throw new Error('Batch item revision conflict.');
        }
      }
      if (node.kind === 'batch') continue;
      for (const runId of new Set(
        [node.runId, node.intendedRunId].filter((id): id is string => Boolean(id)),
      )) {
        this.db
          .prepare('INSERT OR IGNORE INTO execution_runs VALUES (?,?,?,?,?)')
          .run(runId, flow.id, node.id, node.attempt ?? 1, node.sessionKey);
        const owner = this.db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(runId)!;
        if (
          owner.flow_id !== flow.id ||
          owner.node_id !== node.id ||
          owner.attempt !== (node.attempt ?? 1) ||
          owner.session_key !== node.sessionKey
        )
          throw new Error('Native run identity conflict.');
      }
      if (['preparing', 'running', 'uncertain'].includes(node.status)) {
        this.db
          .prepare(
            'INSERT INTO execution_leases VALUES (?,?,?) ON CONFLICT(flow_id,node_id) DO UPDATE SET run_id=excluded.run_id',
          )
          .run(flow.id, node.id, node.runId ?? node.intendedRunId ?? null);
      } else
        this.db
          .prepare('DELETE FROM execution_leases WHERE flow_id=? AND node_id=?')
          .run(flow.id, node.id);
    }
  }
  acknowledge(flow: Flow): void {
    const originals = (flow as WorkingFlow)[loaded];
    for (const node of flow.nodes.filter(node => node.batchItem))
      originals?.set(node.id, JSON.stringify(node));
  }
  expand(flow: Flow, stage: FlowNode, items: FlowNode[]): void {
    if (!stage.batchInput || !items.length || items.length > 1000)
      throw new Error('Invalid batch expansion.');
    for (const item of items) {
      if (
        !item.batchItem ||
        item.batchItem.stageId !== stage.id ||
        item.batchItem.manifestVersion !== stage.batchInput.version
      )
        throw new Error('Invalid batch item ownership.');
      this.db
        .prepare('INSERT INTO batch_items VALUES (?,?,?,?,?,?,?,?)')
        .run(
          flow.id,
          stage.id,
          item.id,
          item.batchItem.ordinal,
          item.status,
          item.sessionKey,
          stage.batchInput.version,
          JSON.stringify(item),
        );
    }
  }
  counts(flowId: string, stageId: string): BatchCounts {
    const counts: BatchCounts = {
      total: 0,
      queued: 0,
      preparing: 0,
      running: 0,
      uncertain: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of this.db
      .prepare(
        'SELECT status,count(*) AS count FROM batch_items WHERE flow_id=? AND stage_id=? GROUP BY status',
      )
      .all(flowId, stageId)) {
      if (!statuses.includes(row.status as NodeStatus))
        throw new Error('Invalid persisted item status.');
      counts[row.status as NodeStatus] = Number(row.count);
      counts.total += Number(row.count);
    }
    return counts;
  }
  owner(sessionKey: string, runId?: string): { flowId: string; nodeId: string } | undefined {
    const row = runId
      ? this.db
          .prepare('SELECT flow_id,node_id FROM execution_runs WHERE run_id=? AND session_key=?')
          .get(runId, sessionKey)
      : this.db
          .prepare('SELECT flow_id,item_id AS node_id FROM batch_items WHERE session_key=?')
          .get(sessionKey);
    return row ? { flowId: String(row.flow_id), nodeId: String(row.node_id) } : undefined;
  }
  occupiedCount(): number {
    return Number(this.db.prepare('SELECT count(*) AS count FROM execution_leases').get()!.count);
  }
  interventionOwner(
    flowId: string,
    id: string,
  ): { nodeId: string; note: FlowIntervention } | undefined {
    const row = this.db
      .prepare('SELECT node_id,payload FROM interventions WHERE flow_id=? AND operation_id=?')
      .get(flowId, id);
    return row ? { nodeId: String(row.node_id), note: JSON.parse(String(row.payload)) } : undefined;
  }
  loadFailed(flow: Flow, stageId?: string, itemIds?: string[]): void {
    const originals = (flow as WorkingFlow)[loaded]!;
    for (const row of this.db
      .prepare(
        "SELECT item_id,payload FROM batch_items WHERE flow_id=? AND status='failed' AND (?='' OR stage_id=?) ORDER BY ordinal",
      )
      .all(flow.id, stageId ?? '', stageId ?? '')) {
      const id = String(row.item_id);
      if (itemIds && !itemIds.includes(id)) continue;
      if (!originals.has(id)) {
        originals.set(id, String(row.payload));
        flow.nodes.push(JSON.parse(String(row.payload)));
      }
    }
  }
  results(
    flow: Flow,
    stageId: string,
    after = -1,
    transportBudget = RESULT_TRANSPORT_BYTES,
  ): { items: unknown[]; after?: number } {
    const stage = flow.nodes.find(node => node.id === stageId && node.kind === 'batch');
    if (!stage?.batchInput || !Number.isSafeInteger(after) || after < -1)
      throw new Error('Invalid batch result request.');
    const rows = this.db
      .prepare(
        "SELECT ordinal,payload FROM batch_items WHERE flow_id=? AND stage_id=? AND status='done' AND ordinal>? ORDER BY ordinal LIMIT ?",
      )
      .all(flow.id, stageId, after, BATCH_LIMITS.resultPage + 1);
    const items: unknown[] = [];
    let bytes = 0;
    let last = after;
    for (const row of rows.slice(0, BATCH_LIMITS.resultPage)) {
      const node = JSON.parse(String(row.payload)) as FlowNode;
      const item = { id: node.id, title: node.title, result: node.artifacts };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (
        bytes + size > BATCH_LIMITS.resultPageBytes - 1024 ||
        resultTransportCost({ items: [...items, item] }) > transportBudget - 1024
      )
        break;
      bytes += size;
      items.push(item);
      last = Number(row.ordinal);
    }
    if (rows.length && !items.length)
      throw new Error(
        'Result index entry exceeds this model context budget. Use a model with a larger effective context or publish a compact artifact manifest.',
      );
    return { items, ...(rows.length > items.length ? { after: last } : {}) };
  }
  cancelQueued(flowId: string): void {
    this.db
      .prepare(
        "UPDATE batch_items SET status='cancelled',payload=json_set(payload,'$.status','cancelled') WHERE flow_id=? AND status='queued'",
      )
      .run(flowId);
  }
  cursor(): string | undefined {
    return this.db.prepare("SELECT value FROM scheduler_state WHERE id='cursor'").get()?.value as
      string | undefined;
  }
  setCursor(id: string): void {
    this.db
      .prepare(
        "INSERT INTO scheduler_state VALUES ('cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id);
  }
  page(
    flow: Flow,
    stageId: string,
    options: { status?: NodeStatus; search?: string; cursor?: string } = {},
  ): BatchPage {
    const stage = flow.nodes.find(node => node.id === stageId && node.kind === 'batch');
    if (!stage?.batchInput) throw new Error('Batch not found.');
    if (options.status && !statuses.includes(options.status))
      throw new Error('Invalid item filter.');
    const search = options.search?.trim().toLowerCase() ?? '';
    if (search.length > 100) throw new Error('Search exceeds limit.');
    let after = -1;
    const identity = {
      flowId: flow.id,
      stageId,
      version: stage.batchInput.version,
      revision: flow.revision,
      status: options.status ?? '',
      search,
    };
    if (options.cursor) {
      if (options.cursor.length > 2048) throw new Error('Invalid batch cursor.');
      const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      if (
        Object.entries(identity).some(([key, value]) => cursor[key] !== value) ||
        !Number.isSafeInteger(cursor.after) ||
        Number(cursor.after) < 0
      )
        throw new Error('Batch page changed. Refresh the item list.');
      after = Number(cursor.after);
    }
    const where =
      "flow_id=? AND stage_id=? AND (?='' OR status=?) AND (?='' OR instr(lower(json_extract(payload,'$.title')),?)>0 OR instr(lower(json_extract(payload,'$.batchItem.key')),?)>0)";
    const args = [flow.id, stageId, identity.status, identity.status, search, search, search];
    const matched = Number(
      this.db.prepare('SELECT count(*) AS count FROM batch_items WHERE ' + where).get(...args)!
        .count,
    );
    const rows = this.db
      .prepare(
        'SELECT ordinal,payload FROM batch_items WHERE ' +
          where +
          ' AND ordinal>? ORDER BY ordinal LIMIT ?',
      )
      .all(...args, after, BATCH_LIMITS.page + 1);
    const more = rows.length > BATCH_LIMITS.page;
    const page = rows.slice(0, BATCH_LIMITS.page);
    const retryable =
      !['completed', 'cancelled', 'stopping'].includes(flow.status) &&
      !flow.error &&
      !flow.deliveryIntent &&
      stage.deps.every(dep => flow.nodes.find(node => node.id === dep)?.status === 'done')
        ? Number(
            this.db
              .prepare(
                "SELECT count(*) AS count FROM batch_items WHERE flow_id=? AND stage_id=? AND status='failed' AND json_extract(payload,'$.cleanupSettled')=1 AND coalesce(json_extract(payload,'$.attempt'),1)<? AND coalesce(json_array_length(payload,'$.interventions'),0)<?",
              )
              .get(
                flow.id,
                stageId,
                flow.settings?.maxAttempts ?? FLOW_LIMITS.attempts,
                FLOW_LIMITS.interventions,
              )!.count,
          )
        : 0;
    return {
      flowId: flow.id,
      stageId,
      manifestVersion: stage.batchInput.version,
      revision: flow.revision,
      counts: this.counts(flow.id, stageId),
      matched,
      retryable,
      items: page.map(row => {
        const { id, title, agentId, agentName, status, attempt, startedAt, endedAt, error } =
          JSON.parse(String(row.payload)) as FlowNode;
        return { id, title, agentId, agentName, status, attempt, startedAt, endedAt, error };
      }),
      ...(more
        ? {
            cursor: Buffer.from(
              JSON.stringify({ ...identity, after: Number(page[page.length - 1].ordinal) }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
}

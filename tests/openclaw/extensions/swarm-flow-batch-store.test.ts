import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowStore } from '../../../openclaw-extensions/swarm-flow/store';
import type { Flow, FlowNode } from '../../../openclaw-extensions/swarm-flow/contract';
import { RESULT_TRANSPORT_BYTES, resultTransportCost } from '../../../openclaw-extensions/swarm-flow/batch-contract';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function fixture(count = 100) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swarm-batch-store-'));
  const store = new FlowStore(directory);
  const stage: FlowNode = { id: 'task-1', title: 'Process inputs', task: 'Process one file', kind: 'batch', access: 'write',
    deps: [], status: 'queued', sessionKey: '', agentId: 'main', agentName: 'Main', batchInput: { version: 'version-one', manifestPath: 'manifest.json' } };
  const flow: Flow = { id: 'flow-one', requestId: 'request-one', parentKey: 'agent:main:justdo:parent', parentId: 'parent', agentId: 'main',
    agents: [{ id: 'main', name: 'Main' }], cwd: directory, permissionMode: 'workspace', mode: 'auto', goal: 'Process data',
    revision: 1, createdAt: 1, updatedAt: 1, status: 'running', nodes: [stage] };
  store.insert(flow);
  const items = Array.from({ length: count }, (_, ordinal): FlowNode => ({ ...stage, id: 'item-' + ordinal, kind: 'work',
    title: 'File ' + ordinal, sessionKey: 'agent:main:subagent:item-' + ordinal,
    batchItem: { stageId: stage.id, manifestVersion: 'version-one', ordinal, key: 'file-' + ordinal, workspace: directory }, batchInput: undefined }));
  store.expandBatch(flow, stage, items, () => {});
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, flow, stage, items, directory };
}
describe('durable batch working sets', () => {
  it('keeps 100 items out of flow snapshots and pages them without results', () => {
    const { store, flow, stage } = fixture();
    const loaded = store.get(flow.id)!;
    expect(loaded.nodes).toHaveLength(2);
    expect(loaded.nodes[0].batchCounts).toMatchObject({ total: 100, queued: 100 });
    const first = store.batches.page(loaded, stage.id);
    const second = store.batches.page(loaded, stage.id, { cursor: first.cursor });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(50);
    expect(second.items[0].id).toBe('item-50');
    expect(second.cursor).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain('manifest.json');
  });
  it('retains exact run ownership and slots until a conclusive status is published', () => {
    const { store, flow, stage } = fixture();
    const loaded = store.get(flow.id)!;
    const item = loaded.nodes[1];
    item.status = 'uncertain'; item.intendedRunId = 'run-one';
    store.put(loaded);
    expect(store.batches.occupiedCount()).toBe(1);
    expect(store.batches.owner(item.sessionKey, 'run-one')).toEqual({ flowId: flow.id, nodeId: item.id });
    const next = store.get(flow.id)!;
    expect(next.nodes).toHaveLength(3);
    const active = next.nodes.find(node => node.id === item.id)!;
    active.status = 'done'; active.cleanupSettled = true; active.result = 'large result';
    store.put(next);
    expect(store.batches.occupiedCount()).toBe(0);
    expect(store.batches.counts(flow.id, stage.id)).toMatchObject({ done: 1, queued: 99 });
    expect(store.get(flow.id, item.id)!.nodes.find(node => node.id === item.id)?.result).toBe('large result');
  });
  it('rejects stale pages and rolls back item writes together with flow revisions', () => {
    const { store, flow, stage } = fixture();
    const stale = store.get(flow.id)!;
    const page = store.batches.page(stale, stage.id);
    const current = store.get(flow.id)!;
    current.nodes[1].status = 'running'; current.nodes[1].runId = 'owned-run';
    store.put(current);
    stale.nodes[1].status = 'failed';
    expect(() => store.put(stale)).toThrow('revision conflict');
    expect(store.batches.counts(flow.id, stage.id).failed).toBe(0);
    expect(() => store.batches.page(store.get(flow.id)!, stage.id, { cursor: page.cursor })).toThrow('Refresh');
    expect(() => store.batches.page(store.get(flow.id)!, stage.id, { status: 'failed', cursor: page.cursor })).toThrow('Refresh');
  });
  it('does not expose a partially expanded queue when the admission is revoked', () => {
    const { store, flow, stage, items } = fixture(1);
    const loaded = store.get(flow.id)!;
    const other = { ...stage, id: 'task-2' };
    loaded.nodes.unshift(other);
    let checks = 0;
    expect(() => store.expandBatch(loaded, other, [{ ...items[0], id: 'item-other', batchItem: { ...items[0].batchItem!, stageId: other.id } }],
      () => { if (++checks === 2) throw new Error('revoked'); })).toThrow('revoked');
    expect(store.batches.counts(flow.id, other.id).total).toBe(0);
    expect(store.get(flow.id)?.nodes.some(node => node.id === other.id)).toBe(false);
  });
  it('pages all artifacts without losing the cursor inside native deferred tool wrappers', () => {
    const { store, flow, stage, items } = fixture();
    for (const item of items) {
      const current = store.get(flow.id, item.id)!;
      const node = current.nodes.find(node => node.id === item.id)!;
      node.status = 'done'; node.cleanupSettled = true;
      node.artifacts = { flowId: flow.id, stageId: stage.id, itemId: node.id, manifestVersion: 'version-one',
        attempt: 1, runId: 'run-' + node.id, inputKey: node.batchItem!.key, summary: '分析完成'.repeat(10),
        artifacts: [{ path: 'E:\\项目\u9fa6\\'.repeat(12) + 'result.json', bytes: 100, sha256: 'a'.repeat(64) }] };
      store.put(current);
    }
    let after = -1; const seen: string[] = [];
    do {
      const page = store.batches.results(store.get(flow.id)!, stage.id, after);
      const payload = { flowId: flow.id, stageId: stage.id, manifestVersion: 'version-one', total: 100,
        items: page.items, ...(page.after === undefined ? {} : { cursor: 'a'.repeat(512) }) };
      expect(resultTransportCost(payload)).toBeLessThanOrEqual(RESULT_TRANSPORT_BYTES);
      seen.push(...(page.items as Array<{ id: string }>).map(item => item.id));
      if (page.after === undefined) break;
      expect(page.after).toBeGreaterThan(after); after = page.after;
    } while (true);
    expect(seen).toEqual(items.map(item => item.id));
  });
});

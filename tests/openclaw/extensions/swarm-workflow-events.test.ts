import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import type { Flow, FlowNode } from '../../../openclaw-extensions/swarm-workflow/contracts/flow';
import { FlowStore } from '../../../openclaw-extensions/swarm-workflow/data/store';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(clean => clean()));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'workflow-events-'));
  const changed = vi.fn();
  const store = new FlowStore(directory, change => {
    // Notices must observe the committed revision, not an uncommitted transaction.
    expect(store.get(change.flowId)?.revision).toBe(change.revision);
    changed(change);
  });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const flow: Flow = {
    id: 'flow', requestId: 'request', parentKey: 'agent:main:justdo:parent',
    parentId: 'parent', agentId: 'main', agents: [{ id: 'main', name: 'Main' }],
    cwd: directory, permissionMode: 'workspace', mode: 'auto', goal: 'Inspect',
    revision: 1, createdAt: 1, updatedAt: 1, status: 'running', nodes: [],
  };
  return { flow, store, changed };
}

test('publishes committed inserts and updates, with no notice for failed writes or reads', () => {
  const { flow, store, changed } = fixture();
  store.insert(flow);
  expect(changed).toHaveBeenLastCalledWith({ parentKey: flow.parentKey, flowId: flow.id, revision: 1 });
  const stale = { ...flow };
  flow.status = 'paused';
  store.put(flow);
  expect(changed).toHaveBeenLastCalledWith({ parentKey: flow.parentKey, flowId: flow.id, revision: 2 });
  expect(() => store.insert(flow)).toThrow();
  expect(() => store.put(stale)).toThrow('Flow revision conflict');
  store.all();
  store.get(flow.id);
  expect(changed).toHaveBeenCalledTimes(2);
});

test('notifies batch expansion only after the whole transaction commits', () => {
  const { flow, store, changed } = fixture();
  const stage: FlowNode = {
    id: 'batch', title: 'Batch', task: 'Inspect files', kind: 'batch', status: 'queued',
    deps: [], sessionKey: '', agentId: 'main', agentName: 'Main',
    batchInput: { version: 'v1', manifestPath: 'manifest.json' },
  };
  flow.nodes.push(stage);
  store.insert(flow);
  const item: FlowNode = {
    ...stage, id: 'item', kind: 'work', sessionKey: 'agent:main:subagent:item',
    batchInput: undefined,
    batchItem: { stageId: stage.id, manifestVersion: 'v1', ordinal: 0, key: 'file', workspace: flow.cwd },
  };
  let checks = 0;
  expect(() => store.expandBatch(flow, stage, [item], () => {
    if (++checks === 2) throw new Error('Retired');
  })).toThrow('Retired');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(store.get(flow.id)?.revision).toBe(1);
  store.expandBatch(flow, stage, [item], () => {});
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenLastCalledWith({ parentKey: flow.parentKey, flowId: flow.id, revision: 2 });
});

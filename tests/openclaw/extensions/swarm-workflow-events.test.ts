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

test('reads only owned parents in newest-first order without hydrating other histories', () => {
  const { flow, store } = fixture();
  store.insert(flow);
  store.insert({ ...flow, id: 'foreign', requestId: 'foreign', parentKey: 'foreign-parent' });
  store.insert({ ...flow, id: 'newer', requestId: 'newer' });
  const hydrate = vi.spyOn(store.batches, 'hydrate');
  expect(store.forParents([flow.parentKey, flow.parentKey]).map(item => item.id)).toEqual([
    'newer', 'flow',
  ]);
  expect(hydrate).toHaveBeenCalledTimes(2);
  hydrate.mockClear();
  expect(store.forParents([])).toEqual([]);
  expect(store.forParents(['missing'])).toEqual([]);
  expect(hydrate).not.toHaveBeenCalled();
});

test('projects metadata across all history without hydrating any workflow or item result', () => {
  const { flow, store } = fixture();
  store.insert(flow);
  for (let index = 0; index < 25; index++) {
    store.insert({ ...flow, id: `done-${index}`, requestId: `done-${index}`, status: 'completed' });
  }
  store.insert({ ...flow, id: 'idle', requestId: 'idle', parentKey: 'agent:main:justdo:idle', status: 'paused' });
  const hydrate = vi.spyOn(store.batches, 'hydrate');
  expect(store.summary([flow.parentKey, flow.parentKey])).toEqual({ count: 26, running: true });
  expect(store.summary([])).toEqual({ count: 0, running: false });
  expect(store.activity()).toEqual({ parentKeys: [flow.parentKey] });
  expect(hydrate).not.toHaveBeenCalled();
  flow.status = 'completed';
  store.put(flow);
  expect(store.summary([flow.parentKey])).toEqual({ count: 26, running: false });
  expect(store.activity()).toEqual({ parentKeys: [] });
});

test.each(['preparing', 'running', 'uncertain'] as const)(
  'preserves %s work in paused and blocked activity summaries', status => {
    const { flow, store } = fixture();
    flow.status = 'blocked';
    flow.nodes = [{ id: 'worker', title: 'Work', task: 'Inspect', kind: 'work',
      deps: [], sessionKey: 'worker', agentId: 'main', agentName: 'Main', status }];
    store.insert(flow);
    expect(store.summary([flow.parentKey]).running).toBe(true);
    expect(store.activity().parentKeys).toEqual([flow.parentKey]);
  },
);

test('pages active parents in stable order rather than truncating the global snapshot', () => {
  const { flow, store } = fixture();
  for (let index = 0; index < 130; index++) store.insert({ ...flow,
    id: `flow-${index}`, requestId: `request-${index}`,
    parentKey: `agent:main:justdo:parent-${String(index).padStart(3, '0')}` });
  const first = store.activity();
  expect(first.parentKeys).toHaveLength(128);
  expect(first.cursor).toBe(first.parentKeys[127]);
  const second = store.activity(first.cursor);
  expect(second.parentKeys).toHaveLength(2);
  expect(second.cursor).toBeUndefined();
  expect(new Set([...first.parentKeys, ...second.parentKeys]).size).toBe(130);
});

test('versions committed metadata changes and gives each store incarnation a fresh epoch', () => {
  const { flow, store } = fixture();
  const emptyVersion = store.snapshotVersion;
  store.summary([]);
  store.activity();
  expect(store.snapshotVersion).toBe(emptyVersion);
  store.insert(flow);
  expect(store.snapshotVersion).not.toBe(emptyVersion);
  const second = new FlowStore(flow.cwd);
  try { expect(second.snapshotVersion).not.toBe(store.snapshotVersion); }
  finally { second.close(); }
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

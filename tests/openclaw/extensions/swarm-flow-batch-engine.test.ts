import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FlowEngine, type FlowHost } from '../../../openclaw-extensions/swarm-flow/engine';
import { FlowStore } from '../../../openclaw-extensions/swarm-flow/store';
import type { Flow, FlowNode } from '../../../openclaw-extensions/swarm-flow/contract';
import { swarmSettings, swarmCapacity } from '../../../openclaw-extensions/swarm-flow/settings';
import { managementStatus } from '../../../openclaw-extensions/swarm-flow/management';
import { NativeLaunchNotInvokedError } from '../../../openclaw-extensions/swarm-flow/native-execution';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.useRealTimers(); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'batch-engine-'));
  const store = new FlowStore(directory);
  let capacity = 5;
  const settled = new Map<string, Awaited<ReturnType<FlowHost['wait']>>>();
  const launched = new Set<string>();
  const host: FlowHost = { capacity: () => capacity, assertAdmission: vi.fn(), prepare: vi.fn(async () => {}),
    launch: vi.fn(async (_flow, node, _message, guard) => { guard();
      expect(launched.has(node.intendedRunId!)).toBe(false); launched.add(node.intendedRunId!);
      return { runId: node.intendedRunId!, sessionKey: node.sessionKey }; }),
    wait: vi.fn(async runId => settled.get(runId) ?? { status: 'pending', executionStartedAt: Date.now() }),
    verifyResult: vi.fn(async (_flow, _node, guard) => guard()), cancel: vi.fn(async () => {}), deliver: vi.fn(async () => {}) };
  let engine = new FlowEngine(store, host);
  cleanup.push(async () => { engine.stop(); await engine.drain(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (count: number, name: string, access: FlowNode['access'] = 'write') => {
    const flow = engine.create({ requestId: name, parentKey: 'agent:main:justdo:' + name, parentId: name, agentId: 'main',
      agents: [{ id: 'main', name: 'Main' }], cwd: path.join(directory, name), permissionMode: 'workspace', mode: 'auto', goal: 'Process files', settings: swarmSettings({}), controlVersion: 0 });
    flow.nodes[0].status = 'done';
    const stage: FlowNode = { id: 'task-1', kind: 'batch', title: 'Process batch', task: 'Process input.json', deps: ['plan'], access, status: 'queued',
      sessionKey: '', agentId: 'main', agentName: 'Main', attempt: 1, batchInput: { version: 'v1', manifestPath: 'manifest.json' } };
    const aggregate: FlowNode = { ...stage, id: 'aggregate', kind: 'work', title: 'Aggregate', task: 'Aggregate accepted results', batchInput: undefined,
      sessionKey: 'agent:main:subagent:aggregate-' + name, completionMode: 'tool', deps: [stage.id] };
    flow.nodes.push(stage, aggregate); store.put(flow);
    const items = Array.from({ length: count }, (_, ordinal): FlowNode => ({ ...aggregate, id: 'item-' + ordinal, title: 'Input ' + ordinal, deps: ['plan'],
      sessionKey: 'agent:main:subagent:item-' + name + '-' + ordinal, batchItem: { stageId: stage.id, manifestVersion: 'v1', ordinal, key: String(ordinal), workspace: '' } }));
    store.expandBatch(flow, stage, items, () => {});
    return flow.id;
  };
  const finish = (flowId: string, nodeId: string, fail = false) => {
    const flow = store.get(flowId, nodeId)!;
    const node = flow.nodes.find(node => node.id === nodeId)!;
    const runId = node.runId!;
    if (!fail) engine.submit(node.sessionKey, runId, { outcome: 'complete', summary: 'Processed', evidence: ['output/result.json'] }, node.batchItem ? {
      flowId, stageId: node.batchItem.stageId, itemId: node.id, manifestVersion: 'v1', attempt: node.attempt!, runId, inputKey: node.batchItem.key,
      summary: 'Processed', artifacts: [{ path: 'output/result.json', bytes: 2, sha256: 'fixture-hash' }] } : undefined);
    settled.set(runId, { status: fail ? 'error' : 'ok', error: fail ? 'Item input invalid' : undefined, endedAt: Date.now(), executionSettled: true, cleanupSettled: true });
  };
  return { store, host, create, finish, settled, setCapacity: (value: number) => { capacity = value; },
    tick: async () => { await engine.tick(); await engine.drain(); await engine.tick(); await engine.drain(); },
    get engine() { return engine; }, restart: () => { engine.stop(); engine = new FlowEngine(store, host); } };
}
it('processes 100 items in waves of five across more than a day and gates aggregation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  const f = fixture(); const id = f.create(100, 'large');
  let completed = 0;
  for (let wave = 0; wave < 20; wave++) {
    await f.tick();
    let flow = f.store.get(id)!;
    const items = flow.nodes.filter(node => node.batchItem && node.status === 'running');
    expect(items).toHaveLength(5);
    expect(f.store.batches.occupiedCount()).toBe(5);
    expect(flow.nodes.find(node => node.id === 'aggregate')?.status).toBe('queued');
    await f.tick(); // Observe actual starts before advancing the clock.
    vi.setSystemTime(Date.now() + 90 * 60000);
    for (const node of items) f.finish(id, node.id);
    completed += 5;
    await f.tick();
    flow = f.store.get(id)!;
    expect(flow.nodes.find(node => node.kind === 'batch')?.batchCounts?.done).toBe(completed);
  }
  expect(f.store.get(id)!.nodes.find(node => node.id === 'aggregate')?.status).toBe('running');
  expect(f.host.launch).toHaveBeenCalledTimes(101);
});
it('shares capacity fairly and lowers the ceiling without cancelling active items', async () => {
  const f = fixture(); const large = f.create(100, 'large'); const small = f.create(2, 'small');
  await f.tick();
  expect(f.store.get(large)!.nodes.some(node => node.batchItem && node.runId)).toBe(true);
  expect(f.store.get(small)!.nodes.some(node => node.batchItem && node.runId)).toBe(true);
  expect(f.store.batches.occupiedCount()).toBe(5);
  f.setCapacity(2); await f.tick();
  expect(f.host.cancel).not.toHaveBeenCalled();
  expect(f.host.launch).toHaveBeenCalledTimes(5);
  const active = [large, small].flatMap(id => f.store.get(id)!.nodes.filter(node => node.batchItem && node.runId).map(node => ({ id, node })));
  for (const item of active.slice(0, 4)) f.finish(item.id, item.node.id);
  await f.tick();
  expect(f.store.batches.occupiedCount()).toBe(2);
});
it('honors a narrower per-flow ceiling while allocating remaining slots to another flow', async () => {
  const f = fixture(); const limited = f.create(100, 'limited'); const other = f.create(100, 'other');
  const flow = f.store.get(limited)!; flow.concurrency = 1; f.store.put(flow);
  await f.tick();
  expect(f.store.get(limited)!.nodes.filter(node => node.batchItem && node.status === 'running')).toHaveLength(1);
  expect(f.store.get(other)!.nodes.filter(node => node.batchItem && node.status === 'running')).toHaveLength(4);
  expect(f.store.batches.occupiedCount()).toBe(5);
});
it('continues independent items and retries all failed items without replaying successes', async () => {
  const f = fixture(); const id = f.create(10, 'failures');
  await f.tick();
  for (const [index, node] of f.store.get(id)!.nodes.filter(node => node.batchItem && node.runId).entries()) f.finish(id, node.id, index < 2);
  await f.tick();
  const flow = f.store.get(id)!;
  expect(flow.status).toBe('running');
  expect(flow.nodes.find(node => node.kind === 'batch')?.batchCounts).toMatchObject({ failed: 2, done: 3, running: 5 });
  expect(() => f.engine.retryBatch(id, 'task-1', flow.revision, 'bad-null', null as never)).toThrow('Invalid');
  const result = f.engine.retryBatch(id, 'task-1', flow.revision, 'retry-two');
  expect(result.retried).toHaveLength(2);
  expect(f.engine.retryBatch(id, 'task-1', flow.revision, 'retry-two')).toEqual(result);
  expect(f.store.batches.counts(id, 'task-1')).toMatchObject({ failed: 0, done: 3, queued: 2 });
  expect(f.store.get(id)!.nodes.find(node => node.kind === 'batch')?.attempt).toBe(1);
});
it('retains uncertain slots across restart and does not accept settlement without cleanup', async () => {
  const f = fixture(); const id = f.create(100, 'recovery'); await f.tick();
  const active = f.store.get(id)!.nodes.filter(node => node.batchItem && node.runId);
  f.restart(); await f.tick();
  expect(f.store.batches.occupiedCount()).toBe(5);
  expect(f.host.launch).toHaveBeenCalledTimes(5);
  for (const node of active) f.settled.set(node.runId!, { status: 'ok', endedAt: Date.now(), executionSettled: true });
  await f.tick(); expect(f.store.batches.occupiedCount()).toBe(5);
  expect(f.store.batches.counts(id, 'task-1').done).toBe(0);
});
it('keeps intervention identity unique even for items outside the working set', () => {
  const f = fixture(); const id = f.create(100, 'notes');
  let flow = f.store.get(id)!;
  f.engine.intervene(id, 'item-50', flow.revision, { id: 'same-note', action: 'note', text: 'First' });
  flow = f.store.get(id)!;
  expect(() => f.engine.intervene(id, 'item-70', flow.revision, { id: 'same-note', action: 'note', text: 'Second' })).toThrow('identity conflict');
});
it('reserves one native slot for chat and validates numeric settings', () => {
  expect(swarmCapacity({ agents: { defaults: { maxConcurrent: 6 } } }, swarmSettings({ globalConcurrency: 5 }))).toBe(5);
  expect(swarmCapacity({ agents: { defaults: { maxConcurrent: 1 } } }, swarmSettings({}))).toBe(0);
  expect(() => swarmSettings({ executionTimeoutSeconds: 0 })).toThrow();
  expect(() => swarmSettings({ globalConcurrency: 1.5 })).toThrow();
});
it('keeps slow item preparation from delaying another flow cancellation', async () => {
  const f = fixture(); f.setCapacity(2);
  const other = f.create(1, 'other-prepare'); await f.tick();
  const slow = f.create(1, 'slow-prepare');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.host.prepare).mockImplementation(async flow => { if (flow.id === slow) await pending; });
  try {
    await f.engine.tick();
    const otherFlow = f.store.get(other)!;
    expect(f.store.batches.occupiedCount()).toBe(2);
    f.engine.control(other, otherFlow.revision, 'stop');
    await f.engine.tick(); expect(f.host.cancel).toHaveBeenCalled();
  } finally { release(); await f.engine.drain(); }
});
it('keeps slow result hashing from delaying other flows and retains its lease', async () => {
  const f = fixture(); f.setCapacity(2);
  const slow = f.create(1, 'slow-publish'); const other = f.create(1, 'other-publish');
  await f.tick();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.host.verifyResult!).mockImplementation(async (flow, _node, guard) => { if (flow.id === slow) await pending; guard(); });
  f.finish(slow, 'item-0'); await f.engine.tick();
  expect(f.store.batches.occupiedCount()).toBe(2);
  f.engine.control(other, f.store.get(other)!.revision, 'stop');
  await f.engine.tick(); expect(f.host.cancel).toHaveBeenCalled();
  release(); await f.engine.drain();
  expect(f.store.batches.counts(slow, 'task-1').done).toBe(1);
});
it('reports complete batch counts independently of the selected working set', () => {
  const f = fixture(); const id = f.create(100, 'counts');
  const overview = managementStatus(f.store.get(id)!);
  const detail = managementStatus(f.store.get(id, 'item-70')!, 'item-70');
  expect(overview.counts).toEqual(detail.counts);
  expect(overview.batchItems).toEqual({ total: 100, done: 0, active: 0, failed: 0 });
});
it('accepts a task that finished within budget before a delayed recovery observation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  const f = fixture(); const id = f.create(1, 'delayed'); await f.tick();
  const flow = f.store.get(id)!; const item = flow.nodes.find(node => node.batchItem)!;
  item.startedAt = Date.now() - 5 * 3600000; item.deadlineAt = Date.now() - 3600000;
  f.store.put(flow); f.finish(id, item.id);
  f.settled.set(item.runId!, { status: 'ok', executionStartedAt: item.startedAt, endedAt: Date.now() - 2 * 3600000, executionSettled: true, cleanupSettled: true });
  f.restart(); await f.tick();
  expect(f.store.batches.counts(id, 'task-1').done).toBe(1);
  expect(f.host.cancel).not.toHaveBeenCalled();
});

it.each(['research', 'review'])('permits only assigned report artifacts for a %s batch without changing ordinary inspection intent', async mode => {
  const f = fixture(); const id = f.create(1, 'read-reports', 'read');
  const flow = f.store.get(id)!; flow.mode = mode; f.store.put(flow);
  await f.tick();
  const batchPrompt = JSON.parse(vi.mocked(f.host.launch).mock.calls[0][2]);
  expect(batchPrompt.strategy).toContain('all business materials remain read-only');
  expect(batchPrompt.strategy).toContain('Only batch items may write their assigned output/ report artifacts');
  expect(batchPrompt.strategy).toContain('explicit ban on all file creation');
  expect(batchPrompt.batchItem.instruction).toContain('Business materials remain read-only');
  expect(batchPrompt.batchItem.instruction).toContain('if the user goal and native permissions allow');
  expect(batchPrompt.batchItem.instruction).toContain('call swarm_flow_block instead');
  expect(batchPrompt.accessInstruction).toContain('only this assigned item\'s report artifacts under output/');
  expect(batchPrompt.accessInstruction).toContain('input.json, input/, original project data, source files');
  expect(batchPrompt.accessInstruction).toContain('Do not run tests or commands that write outside output/');
  expect(batchPrompt.accessInstruction).toContain('does not override the user goal or native session permissions');
  expect(batchPrompt.accessInstruction).toContain('explicitly forbids all file creation');
  expect(batchPrompt.accessInstruction).toContain('call swarm_flow_block');
  f.finish(id, 'item-0'); await f.tick();
  const ordinaryPrompt = JSON.parse(vi.mocked(f.host.launch).mock.calls.at(-1)![2]);
  expect(ordinaryPrompt.accessInstruction).toBe('This is an inspection task. Do not modify source files, configuration, repository state or user data. Native session permission governs which tools you may invoke; read-only task intent is not permission to mutate through shell commands. Tests that create files require a write task.');
  expect(ordinaryPrompt).not.toHaveProperty('batchItem');
});

it('keeps the existing user and native permission ceiling for write batches', async () => {
  const f = fixture(); f.create(1, 'write-reports'); await f.tick();
  const prompt = JSON.parse(vi.mocked(f.host.launch).mock.calls[0][2]);
  expect(prompt.accessInstruction).toBe('Perform only modifications explicitly authorized by the goal and this assigned task; native session permissions remain the upper bound.');
});

function delayedPreflight(host: FlowHost) {
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const nativeRun = vi.fn();
  vi.mocked(host.launch).mockImplementation(async (_flow, node, _message, guard) => {
    entered(); await pending;
    try { guard(); } catch (error) { throw new NativeLaunchNotInvokedError(error); }
    nativeRun();
    return { runId: node.intendedRunId!, sessionKey: node.sessionKey };
  });
  return { ready, release, nativeRun };
}

it.each(['pause', 'pause-resume', 'stop'] as const)('releases a proven uninvoked launch after %s and preserves the same attempt', async action => {
  const f = fixture(); f.setCapacity(1); const id = f.create(1, 'preflight-' + action);
  const preflight = delayedPreflight(f.host);
  try {
    await f.engine.tick(); await preflight.ready;
    const before = f.store.get(id, 'item-0')!;
    const item = before.nodes.find(node => node.id === 'item-0')!;
    const intent = item.intendedRunId;
    expect(intent).toBeTruthy(); expect(f.store.batches.occupiedCount()).toBe(1);
    f.engine.control(id, before.revision, action === 'stop' ? 'stop' : 'pause');
    if (action === 'pause-resume') f.engine.control(id, f.store.get(id)!.revision, 'resume');
    preflight.release(); await f.engine.drain();
    const after = f.store.get(id, 'item-0')!.nodes.find(node => node.id === 'item-0')!;
    expect(preflight.nativeRun).not.toHaveBeenCalled();
    expect(after.status).toBe(action === 'stop' ? 'cancelled' : 'queued');
    expect(after).not.toHaveProperty('intendedRunId');
    expect(after).not.toHaveProperty('error');
    expect(after.attempt).toBe(1); expect(after.sessionKey).toBe(item.sessionKey);
    expect(f.store.batches.occupiedCount()).toBe(0);
    if (action === 'stop') {
      await f.engine.tick(); expect(f.store.get(id)!.status).toBe('cancelled');
    } else {
      if (action === 'pause') f.engine.control(id, f.store.get(id)!.revision, 'resume');
      await f.tick();
      const resumed = f.store.get(id, 'item-0')!.nodes.find(node => node.id === 'item-0')!;
      expect(preflight.nativeRun).toHaveBeenCalledTimes(1);
      expect(resumed.status).toBe('running');
      expect(resumed.intendedRunId).not.toBe(intent);
      expect(resumed.batchItem?.workspace).toBe(item.batchItem?.workspace);
      expect(f.host.prepare).toHaveBeenCalledTimes(2);
    }
  } finally { preflight.release(); await f.engine.drain(); }
});

it('marks a proven preflight permission failure as settled instead of holding an unknown lease', async () => {
  const f = fixture(); f.setCapacity(1); const id = f.create(1, 'preflight-permission');
  let allowed = true;
  vi.mocked(f.host.assertAdmission!).mockImplementation(() => { if (!allowed) throw new Error('Parent permission changed.'); });
  const preflight = delayedPreflight(f.host);
  try {
    await f.engine.tick(); await preflight.ready; allowed = false;
    preflight.release(); await f.engine.drain();
    const flow = f.store.get(id, 'item-0')!;
    expect(flow.status).toBe('blocked'); expect(flow.error).toContain('Parent permission changed');
    expect(flow.nodes.find(node => node.id === 'item-0')).toMatchObject({ status: 'failed', cleanupSettled: true, attempt: 1 });
    expect(f.store.batches.occupiedCount()).toBe(0);
    expect(preflight.nativeRun).not.toHaveBeenCalled();
  } finally { preflight.release(); await f.engine.drain(); }
});

it('allows siblings and an explicit retry after a conclusively uninvoked batch preflight error', async () => {
  const f = fixture(); f.setCapacity(2); const id = f.create(2, 'preflight-invalid-manifest');
  vi.mocked(f.host.launch).mockRejectedValueOnce(new NativeLaunchNotInvokedError(new Error('Frozen batch manifest changed.')));
  await f.tick();
  const flow = f.store.get(id, 'item-0')!;
  expect(flow.status).toBe('running'); expect(flow.error).toBeUndefined();
  expect(flow.nodes.find(node => node.id === 'item-0')).toMatchObject({ status: 'failed', cleanupSettled: true });
  expect(flow.nodes.find(node => node.id === 'item-1')).toMatchObject({ status: 'running' });
  expect(f.store.batches.occupiedCount()).toBe(1);
  expect(f.engine.retryBatch(id, 'task-1', flow.revision, 'retry-preflight', ['item-0']).retried).toEqual(['item-0']);
  await f.tick();
  expect(f.store.get(id, 'item-0')!.nodes.find(node => node.id === 'item-0')).toMatchObject({ status: 'running', attempt: 2 });
  expect(f.store.batches.occupiedCount()).toBe(2);
});

it('does not count a cancelled preflight as a submission correction round', async () => {
  const f = fixture(); f.setCapacity(1); const id = f.create(1, 'preflight-correction');
  const flow = f.store.get(id, 'item-0')!; const item = flow.nodes.find(node => node.id === 'item-0')!;
  item.submissionRepair = { runId: 'original-ended-run', passes: 1, instruction: 'Correct the evidence.', priorRuns: [{ runId: 'original-ended-run', endedAt: 1 }], pending: true };
  f.store.put(flow);
  const preflight = delayedPreflight(f.host);
  try {
    await f.engine.tick(); await preflight.ready;
    f.engine.control(id, f.store.get(id)!.revision, 'pause');
    preflight.release(); await f.engine.drain();
    expect(f.store.get(id, item.id)!.nodes.find(node => node.id === item.id)?.submissionRepair).toEqual(item.submissionRepair);
    f.engine.control(id, f.store.get(id)!.revision, 'resume'); await f.tick();
    expect(f.store.get(id, item.id)!.nodes.find(node => node.id === item.id)?.submissionRepair).toMatchObject({ passes: 2, instruction: 'Correct the evidence.' });
    expect(preflight.nativeRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.host.launch).mock.calls.at(-1)![2]).toBe('Correct the evidence.');
  } finally { preflight.release(); await f.engine.drain(); }
});

it('does not release a newer launch intent when an old preflight failure returns', async () => {
  const f = fixture(); f.setCapacity(1); const id = f.create(1, 'preflight-obsolete');
  const preflight = delayedPreflight(f.host);
  try {
    await f.engine.tick(); await preflight.ready;
    const flow = f.store.get(id, 'item-0')!; const item = flow.nodes.find(node => node.id === 'item-0')!;
    item.intendedRunId = 'newer-native-intent'; f.store.put(flow);
    preflight.release(); await f.engine.drain();
    expect(f.store.get(id, item.id)!.nodes.find(node => node.id === item.id)).toMatchObject({ status: 'uncertain', intendedRunId: 'newer-native-intent' });
    expect(f.store.batches.occupiedCount()).toBe(1);
    expect(preflight.nativeRun).not.toHaveBeenCalled();
  } finally { preflight.release(); await f.engine.drain(); }
});

it.each(['plain', 'forged-name'] as const)('retains the lease for an SDK response loss with a %s error', async variant => {
  const f = fixture(); f.setCapacity(1); const id = f.create(1, 'sdk-loss-' + variant);
  const nativeRun = vi.fn();
  vi.mocked(f.host.launch).mockImplementationOnce(async (_flow, _node, _message, guard) => {
    guard(); nativeRun(); const error = new Error('Native response lost.');
    if (variant === 'forged-name') error.name = 'NativeLaunchNotInvokedError';
    throw error;
  });
  await f.tick();
  expect(nativeRun).toHaveBeenCalledTimes(1);
  expect(f.store.get(id, 'item-0')!.nodes.find(node => node.id === 'item-0')).toMatchObject({ status: 'uncertain', attempt: 1 });
  expect(f.store.batches.occupiedCount()).toBe(1);
});

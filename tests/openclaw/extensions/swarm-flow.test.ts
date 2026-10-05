import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowEngine, type FlowHost } from '../../../openclaw-extensions/swarm-flow/engine';
import { parseJson, validatePlan, validateStageAssignments, verdict } from '../../../openclaw-extensions/swarm-flow/plan';
import { FlowStore } from '../../../openclaw-extensions/swarm-flow/store';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});
function fixture(options: { goal?: string; agentId?: string; assignmentRequest?: string } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swarm-flow-'));
  let store = new FlowStore(directory);
  const results = new Map<string, any>();
  const host: FlowHost = {
    prepare: vi.fn(async () => {}),
    launch: vi.fn(async (_flow, node) => ({
      runId: node.intendedRunId!,
      sessionKey: node.sessionKey,
    })),
    wait: vi.fn(async id => results.get(id) ?? { status: 'pending' }),
    cancel: vi.fn(async () => {}),
    deliver: vi.fn(async () => {}),
  };
  let engine = new FlowEngine(store, host);
  cleanups.push(() => {
    engine.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input: Parameters<FlowEngine['create']>[0] = {
    requestId: 'once',
    parentKey: 'agent:main:justdo:a',
    parentId: 'parent',
    agentId: options.agentId ?? 'main',
    agents: [{ id: 'main', name: 'Main' }, { id: 'reviewer', name: '审查助手' }],
    cwd: directory,
    permissionMode: 'workspace',
    mode: 'auto',
    goal: options.goal ?? 'Inspect project',
    assignmentRequest: options.assignmentRequest,
  };
  const flow = engine.create(input);
  return {
    host,
    results,
    id: flow.id,
    create: (overrides: Partial<typeof input>) => engine.create({ ...input, ...overrides }),
    get: () => store.get(flow.id)!,
    submit: (nodeId: string, submission: Parameters<FlowEngine['submit']>[2]) => {
      const node = store.get(flow.id)!.nodes.find(n => n.id === nodeId)!;
      return engine.submit(node.sessionKey, node.runId ?? node.intendedRunId!, submission);
    },
    get engine() {
      return engine;
    },
    restart: () => {
      engine.stop();
      store.close();
      store = new FlowStore(directory);
      engine = new FlowEngine(store, host);
    },
    finish: (nodeId: string, text: string, status = 'ok', submit = true) => {
      const node = store.get(flow.id)!.nodes.find(n => n.id === nodeId)!;
      if (submit && status === 'ok' && (node.kind === 'work' || node.kind === 'verify')) {
        const fields = node.kind === 'verify' ? parseJson(text) as { passed: boolean; summary: string; evidence: string[] } : { summary: text, evidence: ['fixture evidence'] };
        engine.submit(node.sessionKey, node.runId ?? node.intendedRunId!, { ...fields, outcome: node.kind === 'verify' ? 'verified' : 'complete' });
      }
      results.set(node.runId ?? node.intendedRunId!, {
        status,
        stopReason: status === 'ok' ? 'stop' : 'error',
        endedAt: Date.now(),
        terminalReply: { disposition: 'visible', text },
      });
    },
  };
}
const plan = JSON.stringify({
  tasks: [
    { id: 'research', title: 'Research', task: 'Research evidence', deps: [], access: 'read' },
    { id: 'build', title: 'Build', task: 'Implement', deps: ['research'], access: 'write' },
  ],
});
describe('Swarm task flow contract', () => {
  it('accepts descriptive task IDs and advances three parallel stages behind dependency barriers', async () => {
    const ids = [
      'stage-a-swarm-execution-understanding',
      'stage-b-swarm-ui-understanding',
      'stage-c-execution-reliability-review',
      'stage-d-ui-experience-review',
      'stage-e-execution-issue-verification',
      'stage-f-ui-issue-verification',
    ];
    const f = fixture();
    await f.engine.tick();
    expect(JSON.parse(vi.mocked(f.host.launch).mock.calls[0][2]).instruction).toContain('internal node IDs');
    f.finish('plan', JSON.stringify({ tasks: ids.map((id, i) => ({
      id, title: id, task: 'Inspect code and report evidence', access: 'read',
      deps: i < 2 ? [] : ids.slice(i < 4 ? 0 : 2, i < 4 ? 2 : 4),
    })) }));
    await f.engine.tick();
    for (let stage = 0; stage < 3; stage++) {
      const pair = [`task-${stage * 2 + 1}`, `task-${stage * 2 + 2}`];
      expect(f.get().status).toBe('running');
      expect(f.get().nodes.filter(n => n.status === 'running').map(n => n.id)).toEqual(pair);
      f.finish(pair[0], 'Evidence');
      await f.engine.tick();
      expect(f.get().nodes.filter(n => n.status === 'running').map(n => n.id)).toEqual([pair[1]]);
      f.finish(pair[1], 'Evidence');
      await f.engine.tick();
    }
    expect(f.get().nodes.find(n => n.id === 'verify')?.status).toBe('running');
  });
  it('normalizes arbitrary reference labels and preserves forward dependencies without mutating the plan', () => {
    const tasks = [
      { id: 'a'.repeat(500), title: 'First', task: 'Inspect', deps: ['计划 / 并行 🔍'], access: 'read' },
      { id: '计划 / 并行 🔍', title: 'Second', task: 'Inspect', deps: ['plan'], access: 'read' },
      { id: 'plan', title: 'Third', task: 'Inspect', deps: [], access: 'read' },
    ];
    const before = structuredClone(tasks);
    expect(validatePlan({ tasks })).toEqual(tasks.map((task, i) => ({
      ...task, id: `task-${i + 1}`, deps: i < 2 ? [`task-${i + 2}`] : [], agentId: 'main',
    })));
    expect(tasks).toEqual(before);
    expect(() => validatePlan({ tasks: [{ ...tasks[2], id: '' }] })).toThrow('Invalid task reference');
    expect(() => validatePlan({ tasks: [{ ...tasks[2], id: '   ' }] })).toThrow('Invalid task reference');
    expect(() => validatePlan({ tasks: [tasks[2], tasks[2]] })).toThrow('Duplicate task ID');
  });
  it('isolates generated node IDs and session keys across conversations and retains them after restart', async () => {
    const first = fixture();
    const second = fixture();
    await first.engine.tick();
    await second.engine.tick();
    first.finish('plan', plan);
    second.finish('plan', plan);
    await first.engine.tick();
    await second.engine.tick();
    const a = first.get().nodes.find(node => node.id === 'task-1')!;
    const b = second.get().nodes.find(node => node.id === 'task-1')!;
    expect(first.id).not.toBe(second.id);
    expect(a.sessionKey).not.toBe(b.sessionKey);
    expect(a.sessionKey).toContain(first.id);
    expect(b.sessionKey).toContain(second.id);
    first.restart();
    expect(first.get().nodes.find(node => node.id === 'task-1')?.sessionKey).toBe(a.sessionKey);
  });
  it('requires a persisted submission plus a settled native run, and retains it across restart', async () => {
    const f = fixture(); await f.engine.tick(); f.finish('plan', plan); await f.engine.tick();
    const receipt = { outcome: 'complete' as const, summary: 'Inspection complete', evidence: ['file.ts:10'] };
    f.submit('task-1', receipt);
    const revision = f.get().revision;
    f.submit('task-1', receipt);
    expect(f.get().revision).toBe(revision);
    expect(() => f.submit('task-1', { ...receipt, summary: 'Overwrite' })).toThrow('different terminal');
    f.restart(); await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-1')?.status).toBe('uncertain');
    expect(f.get().nodes.find(n => n.id === 'task-2')?.status).toBe('queued');
    f.finish('task-1', '', 'ok', false); await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-1')?.status).toBe('done');
    expect(f.get().nodes.find(n => n.id === 'task-2')?.status).toBe('running');
  });
  it('does not use final prose as completion and retries only failed nodes with fresh execution identity', async () => {
    const f = fixture(); await f.engine.tick(); f.finish('plan', plan); await f.engine.tick();
    for (let pass = 0; pass < 4; pass++) {
      f.finish('task-1', 'I finished everything', 'ok', false); await f.engine.tick();
    }
    expect(f.get().status).toBe('blocked');
    const failed = f.get().nodes.find(n => n.id === 'task-1')!;
    const oldKey = failed.sessionKey, oldRun = failed.runId!;
    f.engine.control(f.id, f.get().revision, 'retry'); await f.engine.tick();
    const retried = f.get().nodes.find(n => n.id === 'task-1')!;
    expect(retried.attempt).toBe(2);
    expect(retried.sessionKey).not.toBe(oldKey);
    expect(retried.runId).not.toBe(oldRun);
    expect(retried.attempts?.[0].error).toContain('without an accepted');
    expect(f.get().nodes[0].status).toBe('done');
    expect(() => f.engine.submit(oldKey, oldRun, { outcome: 'complete', summary: 'Stale', evidence: ['file'] })).toThrow('active');
    f.finish('task-1', 'Checked'); await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-2')?.status).toBe('running');
  });
  it('requires verification tool evidence, accepts prose after submission and preserves completed work when retrying verification', async () => {
    const f = fixture(); await f.engine.tick(); f.finish('plan', plan); await f.engine.tick();
    f.finish('task-1', 'Evidence'); await f.engine.tick(); f.finish('task-2', 'Built'); await f.engine.tick();
    expect(() => f.submit('verify', { outcome: 'verified', passed: true, summary: 'Fine', evidence: [] })).toThrow('evidence');
    f.submit('verify', { outcome: 'verified', passed: false, summary: 'Missing test', evidence: ['test absent'] });
    expect(f.get().status).toBe('blocked');
    expect(() => f.engine.control(f.id, f.get().revision, 'retry')).toThrow('settled');
    f.finish('verify', 'The explanation can be natural language.', 'ok', false); await f.engine.tick();
    f.engine.control(f.id, f.get().revision, 'retry'); await f.engine.tick();
    expect(f.get().nodes.filter(n => n.kind === 'work').every(n => n.status === 'done')).toBe(true);
    f.submit('verify', { outcome: 'verified', passed: true, summary: 'Checked', evidence: ['test passed'] });
    f.finish('verify', '验收通过。', 'ok', false); await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'deliver')?.status).toBe('running');
  });
  it('blocks on explicit unmet prerequisites and rejects wrong-run or wrong-stage submissions', async () => {
    const f = fixture(); await f.engine.tick(); f.finish('plan', plan); await f.engine.tick();
    const node = f.get().nodes.find(n => n.id === 'task-1')!;
    expect(() => f.engine.submit(node.sessionKey, 'foreign-run', { outcome: 'complete', summary: 'Fake', evidence: ['file'] })).toThrow('active');
    expect(() => f.submit('task-1', { outcome: 'verified', passed: true, summary: 'Fake', evidence: ['file'] })).toThrow('assigned stage');
    f.submit('task-1', { outcome: 'blocked', summary: 'Missing project', evidence: ['directory unavailable'] });
    expect(f.get().status).toBe('blocked');
    f.finish('task-1', '', 'ok', false); await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-1')?.error).toContain('Missing project');
    expect(f.get().nodes.find(n => n.id === 'task-2')?.status).toBe('queued');
  });
  it('bounds explicit retries and never replays uncertain runs', async () => {
    const f = fixture(); await f.engine.tick();
    expect(() => f.engine.control(f.id, f.get().revision, 'retry')).toThrow('settled');
    for (let i = 1; i <= 3; i++) {
      f.finish('plan', '', 'error'); await f.engine.tick();
      if (i < 3) { f.engine.control(f.id, f.get().revision, 'retry'); await f.engine.tick(); }
    }
    expect(() => f.engine.control(f.id, f.get().revision, 'retry')).toThrow('limit');
    expect(f.host.launch).toHaveBeenCalledTimes(3);
  });
  it('does not treat a model-rewritten goal as authority for specialist assignments', async () => {
    const f = fixture({ goal: 'Use reviewer to inspect the project.', assignmentRequest: 'Inspect the project.' });
    await f.engine.tick();
    expect(JSON.parse(vi.mocked(f.host.launch).mock.calls[0][2]).assignmentRequest).toBe('Inspect the project.');
    f.finish('plan', JSON.stringify({ tasks: [{ id: 'review', title: 'Review', task: 'Inspect', deps: [], access: 'read', agentId: 'reviewer', agentRequest: 'Use reviewer' }] }));
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    expect(f.get().nodes[0].error).toContain('explicit user assignment');
    expect(f.host.launch).toHaveBeenCalledTimes(1);
  });
  it('defaults all work and gates to main even when another agent owns the chat', async () => {
    const f = fixture({ agentId: 'reviewer' });
    await f.engine.tick();
    expect(f.get().nodes[0].sessionKey).toMatch(/^agent:main:/);
    f.finish('plan', plan);
    await f.engine.tick();
    expect(f.get().nodes.every(node => node.agentId === 'main' && node.sessionKey.startsWith('agent:main:'))).toBe(true);
  });
  it('persists user-assigned workers and gate agents across restart', async () => {
    const goal = '请让审查助手负责代码审查和验收，其余阶段默认执行。';
    const f = fixture({ goal });
    await f.engine.tick();
    f.finish('plan', JSON.stringify({ tasks: [{ id: 'review', title: 'Review', task: 'Review code', deps: [], access: 'read', agentId: 'reviewer', agentRequest: goal }],
      stages: { verify: { agentId: 'reviewer', agentRequest: goal } } }));
    await f.engine.tick();
    expect(f.get().nodes.find(node => node.id === 'task-1')).toMatchObject({ agentId: 'reviewer', agentName: '审查助手' });
    expect(f.get().nodes.find(node => node.id === 'verify')?.sessionKey).toMatch(/^agent:reviewer:/);
    expect(f.get().nodes.find(node => node.id === 'deliver')?.agentId).toBe('main');
    f.restart();
    expect(f.get().nodes.find(node => node.id === 'task-1')?.sessionKey).toMatch(/^agent:reviewer:/);
    expect(f.host.launch).toHaveBeenCalledTimes(2);
  });
  it('rejects unavailable or unrequested agents without silently falling back', () => {
    const agents = [{ id: 'main', name: 'Main' }, { id: 'reviewer', name: '审查助手' }];
    const task = { id: 'review', title: 'Review', task: 'Review', deps: [], access: 'read' };
    expect(() => validatePlan({ tasks: [{ ...task, agentId: 'missing' }] }, agents, 'Use missing')).toThrow('unavailable');
    expect(() => validatePlan({ tasks: [{ ...task, agentId: 'reviewer' }] }, agents, 'Inspect code')).toThrow('explicit');
    expect(() => validatePlan({ tasks: [{ ...task, agentId: 'reviewer', agentRequest: 'Use reviewer' }] }, agents, 'Inspect code')).toThrow('explicit');
    expect(() => validateStageAssignments({ unresolvedAssignments: ['unknown helper'] }, agents, '')).toThrow('could not be resolved');
    expect(() => validateStageAssignments({ stages: { verify: { agentId: 'missing' } } }, agents, '')).toThrow('unavailable');
  });
  it('rejects cycles and unknown dependencies before assigning internal IDs', () => {
    for (const tasks of [
      [{ id: 'a', title: 'A', task: 'A', access: 'read', deps: ['a'] }],
      [{ id: 'a', title: 'A', task: 'A', access: 'read', deps: ['missing'] }],
    ])
      expect(() => validatePlan({ tasks })).toThrow();
  });
  it('reads a single fenced verdict surrounded by prose without weakening evidence or boolean validation', () => {
    const wrap = (json: string) => '我已完成只读核对，以下为验证结论。\n```json\n' + json + '\n```\nAttachment: project';
    expect(verdict(wrap('{"passed":true,"summary":"Checked","evidence":["file.ts:10"]}')).passed).toBe(true);
    expect(verdict(wrap('{"passed":false,"summary":"Missing source","evidence":["directory listing"]}')).passed).toBe(false);
    expect(() => verdict(wrap('{"passed":"true","summary":"Checked","evidence":["file"]}'))).toThrow('verdict and evidence');
    expect(() => verdict(wrap('{"passed":true,"summary":"Checked","evidence":[]}'))).toThrow('verdict and evidence');
    expect(() => verdict(wrap('{bad json}'))).toThrow('invalid JSON');
    expect(() => verdict('我已经验收通过')).toThrow('unambiguous JSON');
    expect(() => verdict(wrap('{"passed":true}') + '\n```json\n{"passed":false}\n```')).toThrow('unambiguous JSON');
  });
  it('requires verification evidence and an explicit boolean verdict', () => {
    expect(() => verdict('{"passed":true,"summary":"fine","evidence":[]}')).toThrow();
    expect(
      verdict('{"passed":false,"summary":"missing tests","evidence":["no test result"]}').passed,
    ).toBe(false);
  });
  it('persists a plan before launching and executes dependencies then independent verification', async () => {
    const f = fixture();
    await f.engine.tick();
    expect(f.get().nodes[0].intendedRunId).toBeTruthy();
    f.finish('plan', plan);
    await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-1')?.status).toBe('running');
    expect(f.get().nodes.find(n => n.id === 'task-2')?.status).toBe('queued');
    f.finish('task-1', 'Evidence');
    await f.engine.tick();
    f.finish('task-2', 'Built and tested');
    await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'verify')?.status).toBe('running');
    f.finish('verify', 'Verification finished.\n```json\n{"passed":true,"summary":"checked","evidence":["test result"]}\n```\nAttachment: project');
    await f.engine.tick();
    f.finish('deliver', 'Final answer');
    await f.engine.tick();
    expect(f.get().status).toBe('completed');
    expect(f.host.deliver).toHaveBeenCalledTimes(1);
    f.restart();
    await f.engine.tick();
    expect(f.host.deliver).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch a delivery after failed verification', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish(
      'plan',
      JSON.stringify({ tasks: [{ id: 'a', title: 'A', task: 'A', deps: [], access: 'read' }] }),
    );
    await f.engine.tick();
    f.finish('task-1', 'result');
    await f.engine.tick();
    f.finish('verify', 'Evidence checked.\n```json\n{"passed":false,"summary":"wrong","evidence":["bad result"]}\n```');
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    expect(f.get().nodes.find(n => n.id === 'deliver')?.status).toBe('queued');
  });
  it('reconciles an accepted run after restart instead of launching it again', async () => {
    const f = fixture();
    await f.engine.tick();
    f.restart();
    await f.engine.tick();
    expect(f.host.launch).toHaveBeenCalledTimes(1);
    f.finish('plan', plan);
    await f.engine.tick();
    expect(f.host.launch).toHaveBeenCalledTimes(2);
  });
  it('retains an uncertain submission without repeating side effects', async () => {
    const f = fixture();
    vi.mocked(f.host.launch).mockRejectedValueOnce(new Error('connection lost'));
    await f.engine.tick();
    f.restart();
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    expect(f.get().nodes[0].status).toBe('uncertain');
    expect(f.host.launch).toHaveBeenCalledTimes(1);
  });
  it.each(['stop', 'end_turn', undefined])('accepts a native successful terminal with stop reason %s', async stopReason => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    f.results.get(f.get().nodes[0].runId!).stopReason = stopReason;
    await f.engine.tick();
    expect(f.get().nodes[0].status).toBe('done');
    expect(f.get().nodes.find(node => node.id === 'task-1')?.status).toBe('running');
  });
  it.each([{ yielded: true }, { livenessState: 'paused' }])('does not advance dependencies for a yielded execution %j', async metadata => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    Object.assign(f.results.get(f.get().nodes[0].runId!), metadata);
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    expect(f.get().nodes[0]).toMatchObject({ status: 'uncertain' });
    expect(f.get().nodes).toHaveLength(1);
    expect(f.host.launch).toHaveBeenCalledTimes(1);
    f.engine.control(f.id, f.get().revision, 'stop');
    await f.engine.tick();
    expect(f.get().status).toBe('stopping');
    expect(f.get().nodes[0].status).toBe('uncertain');
    f.finish('plan', '', 'error');
    await f.engine.tick();
    expect(f.get().status).toBe('cancelled');
  });
  it.each([{ status: 'pending' }, { pendingError: true }])('does not consume interim wait observations even with an endedAt %j', async metadata => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    Object.assign(f.results.get(f.get().nodes[0].runId!), metadata);
    await f.engine.tick();
    expect(f.get().nodes).toHaveLength(1);
    expect(f.get().nodes[0].status).toBe('running');
    expect(f.host.launch).toHaveBeenCalledTimes(1);
  });
  it('reconciles a yielded run only after a non-yielded terminal result', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    f.results.get(f.get().nodes[0].runId!).yielded = true;
    await f.engine.tick();
    f.finish('plan', plan);
    await f.engine.tick();
    expect(f.get().status).toBe('paused');
    expect(f.get().nodes[0].status).toBe('done');
    expect(f.get().nodes[0].error).toBeUndefined();
    expect(f.host.launch).toHaveBeenCalledTimes(1);
  });
  it('retains conclusive native failures even when they also report a yield', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', '', 'error');
    Object.assign(f.results.get(f.get().nodes[0].runId!), { yielded: true, stopReason: 'timeout' });
    await f.engine.tick();
    expect(f.get().nodes[0]).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(f.get().status).toBe('blocked');
  });
  it('allows resuming reconciled success after a lost receipt without replaying completed work', async () => {
    const f = fixture();
    vi.mocked(f.host.launch).mockRejectedValueOnce(new Error('receipt lost'));
    await f.engine.tick();
    expect(() => f.engine.control(f.id, f.get().revision, 'resume')).toThrow();
    f.restart();
    f.finish('plan', plan);
    await f.engine.tick();
    expect(f.get().status).toBe('paused');
    expect(f.get().nodes[0]).toMatchObject({ status: 'done' });
    expect(f.get().nodes[0].error).toBeUndefined();
    expect(f.host.launch).toHaveBeenCalledTimes(1);
    f.engine.control(f.id, f.get().revision, 'resume');
    await f.engine.tick();
    expect(f.get().nodes.find(node => node.id === 'task-1')?.status).toBe('running');
    expect(f.host.launch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.host.launch).mock.calls.map(call => call[1].id)).toEqual(['plan', 'task-1']);
  });
  it('keeps conclusive failed work blocked and prevents resuming', async () => {
    const f = fixture();
    vi.mocked(f.host.launch).mockRejectedValueOnce(new Error('receipt lost'));
    await f.engine.tick();
    f.finish('plan', '', 'error');
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    expect(f.get().nodes[0].status).toBe('failed');
    expect(() => f.engine.control(f.id, f.get().revision, 'resume')).toThrow();
    expect(f.host.launch).toHaveBeenCalledTimes(1);
  });
  it('pause allows completion collection but prevents a new launch', async () => {
    const f = fixture();
    await f.engine.tick();
    f.engine.control(f.id, f.get().revision, 'pause');
    f.finish('plan', plan);
    await f.engine.tick();
    expect(f.get().nodes[0].status).toBe('done');
    expect(f.host.launch).toHaveBeenCalledTimes(1);
    f.engine.control(f.id, f.get().revision, 'resume');
    await f.engine.tick();
    expect(f.host.launch).toHaveBeenCalledTimes(2);
  });
  it('requires terminal cancellation evidence and rejects stale controls', async () => {
    const f = fixture();
    await f.engine.tick();
    expect(() => f.engine.control(f.id, 1, 'stop')).toThrow();
    f.engine.control(f.id, f.get().revision, 'stop');
    await f.engine.tick();
    expect(f.get().status).toBe('stopping');
    f.finish('plan', '', 'error');
    await f.engine.tick();
    expect(f.get().status).toBe('cancelled');
  });
  it('does not accept stop or pause once final delivery has been admitted', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    await f.engine.tick();
    f.finish('task-1', 'Evidence');
    await f.engine.tick();
    f.finish('task-2', 'Built');
    await f.engine.tick();
    f.finish('verify', '{"passed":true,"summary":"checked","evidence":["test result"]}');
    await f.engine.tick();
    vi.mocked(f.host.deliver).mockImplementationOnce(async () => {
      expect(() => f.engine.control(f.id, f.get().revision, 'stop')).toThrow('delivery is already in progress');
      expect(() => f.engine.control(f.id, f.get().revision, 'pause')).toThrow('delivery is already in progress');
    });
    f.finish('deliver', 'Final');
    await f.engine.tick();
    expect(f.get().status).toBe('completed');
    expect(f.host.deliver).toHaveBeenCalledTimes(1);
  });
  it('allows stopping after an unconfirmed final delivery without retrying it', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    await f.engine.tick();
    f.finish('task-1', 'Evidence');
    await f.engine.tick();
    f.finish('task-2', 'Built');
    await f.engine.tick();
    f.finish('verify', '{"passed":true,"summary":"checked","evidence":["test result"]}');
    await f.engine.tick();
    vi.mocked(f.host.deliver).mockRejectedValueOnce(new Error('receipt lost'));
    f.finish('deliver', 'Final');
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    f.engine.control(f.id, f.get().revision, 'stop');
    await f.engine.tick();
    expect(f.get().status).toBe('cancelled');
    expect(f.host.deliver).toHaveBeenCalledTimes(1);
  });
  it.each(['dot', ...(process.platform === 'win32' ? ['case-and-separators'] : [])])('serializes writers across flows with equivalent project paths: %s', async variant => {
    const f = fixture();
    const cwd = variant === 'dot' ? f.get().cwd + path.sep + '.' : f.get().cwd.toUpperCase().replaceAll('\\', '/');
    const peer = f.create({ cwd, requestId: 'peer', parentKey: 'agent:main:justdo:peer' });
    const writePlan = JSON.stringify({ tasks: [{ id: 'write', title: 'Write', task: 'Write project', deps: [], access: 'write' }] });
    await f.engine.tick();
    expect(f.host.launch).toHaveBeenCalledTimes(2);
    f.finish('plan', writePlan);
    const peerLaunch = vi.mocked(f.host.launch).mock.calls.find(call => call[0].id === peer.id)!;
    f.results.set(peerLaunch[1].intendedRunId!, { status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: writePlan } });
    await f.engine.tick();
    const writes = vi.mocked(f.host.launch).mock.calls.filter(call => call[1].access === 'write');
    expect(writes).toHaveLength(1);
  });
});

it('retains submission correction restrictions across restart and clears them only for a new task attempt', async () => {
  const f = fixture();
  await f.engine.tick();
  f.finish('plan', plan);
  await f.engine.tick();
  const node = f.get().nodes.find(value => value.id === 'task-1')!;
  const dispatch = node.dispatch;
  expect(f.engine.requireSubmissionCorrection(node.sessionKey, node.runId!)).toBe(true);
  const revision = f.get().revision;
  expect(f.engine.requireSubmissionCorrection(node.sessionKey, node.runId!)).toBe(true);
  expect(f.get().revision).toBe(revision);
  f.restart();
  expect(f.get().nodes.find(value => value.id === node.id)?.submissionRepair).toMatchObject({ runId: node.runId, passes: 0 });
  await f.engine.tick();
  expect(f.host.launch).toHaveBeenCalledTimes(2);
  for (let pass = 0; pass < 4; pass++) {
    f.finish(node.id, 'Submission still missing', 'ok', false);
    await f.engine.tick();
    if (pass === 0) {
      f.restart();
      await f.engine.tick();
      expect(f.host.launch).toHaveBeenCalledTimes(3);
      expect(f.get().nodes.find(value => value.id === node.id)?.submissionRepair?.passes).toBe(1);
    }
  }
  expect(f.get().status).toBe('blocked');
  expect(f.host.launch).toHaveBeenCalledTimes(5);
  const exhausted = f.get().nodes.find(value => value.id === node.id)!;
  expect(exhausted.attempt).toBe(1);
  expect(exhausted.submissionRepair?.passes).toBe(3);
  expect(exhausted.submissionRepair?.priorRuns).toHaveLength(3);
  expect(exhausted.sessionKey).toBe(node.sessionKey);
  expect(exhausted.dispatch).toEqual(dispatch);
  expect(exhausted.error).toContain('Submission correction limit reached');
  f.engine.control(f.id, f.get().revision, 'retry');
  const retry = f.get().nodes.find(value => value.id === node.id)!;
  expect(retry.submissionRepair).toBeUndefined();
  expect(retry.attempt).toBe(2);
  expect(retry.sessionKey).not.toBe(node.sessionKey);
  expect(retry.attempts?.[0].submissionRuns).toHaveLength(3);
  expect(() => f.engine.requireSubmissionCorrection(node.sessionKey, node.runId!)).toThrow();
});
describe('Swarm human intervention', () => {
  async function failedWorker() {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    await f.engine.tick();
    f.finish('task-1', 'Provider unavailable', 'error');
    await f.engine.tick();
    return f;
  }
  const input = (id: string, action: 'note' | 'continue' | 'retry', text = 'Use the corrected source') => ({ id, action, text });
  it('persists notes without restarting active work and carries them into a targeted new attempt', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', plan);
    await f.engine.tick();
    const original = f.get().nodes.find(n => n.id === 'task-1')!;
    f.engine.intervene(f.id, original.id, f.get().revision, input('human-note', 'note'));
    await f.engine.tick();
    expect(f.host.launch).toHaveBeenCalledTimes(2);
    f.finish(original.id, 'Network error', 'error');
    await f.engine.tick();
    f.engine.intervene(f.id, original.id, f.get().revision, input('human-retry', 'retry', 'Network restored'));
    f.restart();
    await f.engine.tick();
    const next = f.get().nodes.find(n => n.id === original.id)!;
    expect(next.sessionKey).not.toBe(original.sessionKey);
    expect(next.attempt).toBe(2);
    const prompt = JSON.parse(vi.mocked(f.host.launch).mock.calls.at(-1)![2]);
    expect(prompt.humanInput.map((note: any) => note.text)).toEqual(['Use the corrected source', 'Network restored']);
    expect(f.get().nodes.find(n => n.kind === 'plan')?.status).toBe('done');
  });
  it('continues a conclusively failed node in the same session after restart and rejects its old receipt', async () => {
    const f = await failedWorker();
    const original = f.get().nodes.find(n => n.id === 'task-1')!;
    const revision = f.get().revision;
    const request = input('human-go', 'continue');
    f.engine.intervene(f.id, original.id, revision, request);
    const queuedRevision = f.get().revision;
    // Unknown IPC acknowledgement: identical requests cannot queue a second run.
    f.engine.intervene(f.id, original.id, revision, request);
    expect(f.get().revision).toBe(queuedRevision);
    expect(() => f.engine.intervene(f.id, original.id, queuedRevision, { ...request, text: 'different' })).toThrow('identity conflict');
    f.restart();
    await f.engine.tick();
    const current = f.get().nodes.find(n => n.id === original.id)!;
    expect(current).toMatchObject({ sessionKey: original.sessionKey, attempt: 2, status: 'running' });
    expect(current.runId).not.toBe(original.runId);
    expect(() => f.engine.submit(current.sessionKey, original.runId!, { outcome: 'complete', summary: 'stale', evidence: ['stale'] })).toThrow('active Swarm');
    expect(JSON.parse(vi.mocked(f.host.launch).mock.calls.at(-1)![2]).continuationInstruction).toContain('do not blindly repeat');
    f.finish(original.id, 'New inspected evidence');
    await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-2')?.status).toBe('running');
    expect(f.get().nodes.find(n => n.id === original.id)?.attempts?.[0].error).toBe(original.error);
    f.engine.intervene(f.id, original.id, revision, request);
    expect(f.host.launch).toHaveBeenCalledTimes(4);
  });
  it('does not continue live, uncertain, stale, ended or exhausted nodes', async () => {
    const f = await failedWorker();
    const revision = f.get().revision;
    expect(() => f.engine.intervene(f.id, 'task-1', revision - 1, input('stale', 'continue'))).toThrow('revision');
    expect(() => f.engine.intervene(f.id, 'plan', revision, input('done', 'continue'))).toThrow('cannot accept');
    f.engine.intervene(f.id, 'task-1', revision, input('go-2', 'continue'));
    expect(() => f.engine.intervene(f.id, 'task-1', f.get().revision, input('queued', 'continue'))).toThrow('cannot accept');
    await f.engine.tick();
    expect(() => f.engine.intervene(f.id, 'task-1', f.get().revision, input('live', 'continue'))).toThrow('cannot accept');
    f.finish('task-1', 'error', 'error');
    await f.engine.tick();
    f.engine.intervene(f.id, 'task-1', f.get().revision, input('go-3', 'continue'));
    await f.engine.tick();
    f.finish('task-1', 'error', 'error');
    await f.engine.tick();
    expect(() => f.engine.intervene(f.id, 'task-1', f.get().revision, input('exhausted', 'continue'))).toThrow('cannot accept');
    f.engine.control(f.id, f.get().revision, 'stop');
    await f.engine.tick();
    expect(() => f.engine.intervene(f.id, 'task-1', f.get().revision, input('stopped', 'note'))).toThrow('cannot accept');
  });
  it('bounds explicit human annotations and refuses malformed requests without mutations', async () => {
    const f = await failedWorker();
    const revision = f.get().revision;
    for (const request of [input('bad', 'note', ' '), input('bad', 'note', 'x'.repeat(4001)), { ...input('bad', 'note'), action: 'force-complete' }, input('bad:id', 'note')])
      expect(() => f.engine.intervene(f.id, 'task-1', revision, request)).toThrow('Invalid');
    expect(f.get().revision).toBe(revision);
    for (let i = 0; i < 30; i++) f.engine.intervene(f.id, 'task-1', f.get().revision, input('note-' + i, 'note'));
    expect(() => f.engine.intervene(f.id, 'task-1', f.get().revision, input('overflow', 'note'))).toThrow('cannot accept');
    expect(f.get().nodes.find(n => n.id === 'task-1')?.interventions).toHaveLength(30);
  });
  it('continues only the selected failed branch and stays blocked on another failed branch', async () => {
    const f = fixture();
    await f.engine.tick();
    f.finish('plan', JSON.stringify({ tasks: ['left', 'right'].map(id => ({ id, title: id, task: 'Inspect', deps: [], access: 'read' })) }));
    await f.engine.tick();
    f.finish('task-1', 'Left failed', 'error');
    f.finish('task-2', 'Right failed', 'error');
    await f.engine.tick();
    const right = f.get().nodes.find(n => n.id === 'task-2')!;
    f.engine.intervene(f.id, 'task-1', f.get().revision, input('continue-left', 'continue'));
    await f.engine.tick();
    expect(f.get().nodes.find(n => n.id === 'task-2')).toEqual(right);
    f.finish('task-1', 'Left checked');
    await f.engine.tick();
    expect(f.get().status).toBe('blocked');
    expect(f.get().nodes.find(n => n.kind === 'verify')?.status).toBe('queued');
    expect(f.host.launch).toHaveBeenCalledTimes(4);
  });
});

it('retains the exact dispatched inputs across restart without recomputing them', async () => {
  const f = fixture();
  await f.engine.tick();
  f.finish('plan', plan);
  await f.engine.tick();
  const saved = f.get().nodes.find(node => node.id === 'task-1')!.dispatch;
  expect(saved?.message).toBe(vi.mocked(f.host.launch).mock.calls[1][2]);
  f.restart();
  expect(f.get().nodes.find(node => node.id === 'task-1')!.dispatch).toEqual(saved);
});

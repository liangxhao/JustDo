import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { FLOW_LIMITS } from '../../../openclaw-extensions/swarm-flow/contract';
import { FlowEngine, type FlowHost } from '../../../openclaw-extensions/swarm-flow/engine';
import {
  createManagementTools,
  managementStatus,
} from '../../../openclaw-extensions/swarm-flow/management';
import { FlowNotifier } from '../../../openclaw-extensions/swarm-flow/notifications';
import { FlowStore } from '../../../openclaw-extensions/swarm-flow/store';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swarm-management-'));
  let store = new FlowStore(root);
  const host: FlowHost = {
    prepare: vi.fn(async () => {}),
    launch: vi.fn(async (_flow, node) => ({ runId: node.intendedRunId! })),
    wait: vi.fn(async () => ({ status: 'pending' })),
    cancel: vi.fn(async () => {}),
    deliver: vi.fn(async () => {}),
  };
  let engine = new FlowEngine(store, host);
  cleanups.push(() => {
    engine.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const parentKey = 'agent:main:justdo:parent';
  const makeFlow = (key = parentKey, requestId = key) =>
    engine.create({
      parentKey: key,
      parentId: 'parent',
      requestId,
      agentId: 'main',
      agents: [{ id: 'main', name: 'Main' }],
      cwd: root,
      permissionMode: 'workspace',
      goal: '检查项目',
      mode: 'auto',
    });
  const assertCurrent = vi.fn();
  const assertParentIdentity = vi.fn();
  const assertParent = vi.fn(() => assertParentIdentity());
  let runId = 'user-run';
  const tools = () =>
    createManagementTools(parentKey, {
      current: () => ({ store, engine }),
      assertParentIdentity,
      assertParent,
      invocation: () => ({ runId, assertCurrent }),
    });
  const execute = async (
    name: 'status' | 'control' | 'intervene',
    args: Record<string, unknown>,
    toolCallId = 'call',
  ) =>
    (
      await tools()
        .find(tool => tool.name === 'swarm_flow_' + name)!
        .execute(toolCallId, args)
    ).details as Record<string, unknown> & { nodes: unknown[] };
  const failed = () => {
    const flow = makeFlow();
    flow.status = 'blocked';
    flow.nodes[0].status = 'failed';
    flow.nodes[0].runId = 'plan-run';
    flow.nodes[0].endedAt = 1;
    flow.nodes[0].error = 'Missing project path';
    store.put(flow);
    return flow;
  };
  return {
    get store() {
      return store;
    },
    makeFlow,
    failed,
    execute,
    tools,
    host,
    assertCurrent,
    assertParentIdentity,
    assertParent,
    parentKey,
    newTurn: () => {
      runId += '-next';
    },
    restart: () => {
      engine.stop();
      store.close();
      store = new FlowStore(root);
      engine = new FlowEngine(store, host);
    },
  };
}

it('offers only status without a flow and defaults to the owned unfinished or latest flow', async () => {
  const f = fixture();
  expect(f.tools().map(tool => tool.name)).toEqual(['swarm_flow_status']);
  expect(await f.execute('status', {})).toMatchObject({ flow: null });
  const old = f.makeFlow();
  old.status = 'completed';
  f.store.put(old);
  const current = f.makeFlow(f.parentKey, 'next');
  expect(await f.execute('status', {})).toMatchObject({ id: current.id });
  expect(await f.execute('status', { flowId: old.id })).toMatchObject({
    id: old.id,
    status: 'completed',
  });
  expect((await f.execute('status', { flowId: old.id })).actions).toEqual({
    pause: false,
    resume: false,
    stop: false,
    retry: false,
  });
});

it('does not disclose or control another conversation, or accept caller-supplied provenance', async () => {
  const f = fixture();
  f.makeFlow();
  const other = f.makeFlow('agent:main:justdo:other');
  for (const name of ['status', 'control', 'intervene'] as const) {
    const result = await f.execute(name, { flowId: other.id });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('belong');
  }
  expect((await f.execute('status', { sessionKey: f.parentKey })).accepted).toBe(false);
  expect((await f.execute('intervene', { parentKey: f.parentKey })).accepted).toBe(false);
});

it.each(['control', 'intervene'] as const)(
  'rejects non-string %s actions without mutating the flow or admitting execution',
  async name => {
    const f = fixture();
    const flow = f.makeFlow();
    flow.status = 'paused';
    f.store.put(flow);
    const before = f.store.get(flow.id)!;
    for (const action of [['stop'], ['note'], { action: 'stop' }, null, 1]) {
      expect(
        await f.execute(name, {
          flowId: flow.id,
          revision: before.revision,
          action,
          ...(name === 'intervene' ? { nodeId: 'plan', text: 'Additional evidence' } : {}),
        }),
      ).toMatchObject({ accepted: false, error: 'Error: Invalid management action.' });
      expect(f.store.get(flow.id)).toEqual(before);
    }
    expect(f.assertParent).not.toHaveBeenCalled();
    expect(f.assertParentIdentity).not.toHaveBeenCalled();
    expect(f.host.launch).not.toHaveBeenCalled();
  },
);

it('returns blockers, action availability and explicit node evidence without native dispatch/history', async () => {
  const f = fixture();
  const flow = f.failed();
  flow.nodes[0].dispatch = { message: 'private launch', createdAt: 1 };
  flow.nodes[0].completion = {
    runId: 'plan-run',
    createdAt: 1,
    outcome: 'blocked',
    summary: 'Need path',
    evidence: ['project absent'],
  };
  f.store.put(flow);
  const result = await f.execute('status', { nodeId: 'plan' });
  expect(result.node).toMatchObject({ completion: { outcome: 'blocked' }, canContinue: true });
  expect(result.nodes[0]).toMatchObject({
    agent: '@Main',
    error: 'Missing project path',
    remainingAttempts: 2,
  });
  expect(JSON.stringify(result)).not.toContain('private launch');
  expect(f.host.launch).not.toHaveBeenCalled();
  expect((await f.execute('status', { nodeId: 'unknown' })).accepted).toBe(false);
});

it('persists accepted controls atomically and replays a lost response after restart without another transition', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  const args = { flowId: flow.id, revision: flow.revision, action: 'pause' };
  expect(await f.execute('control', args)).toMatchObject({
    accepted: true,
    replayed: false,
    flow: { status: 'paused' },
  });
  const revision = f.store.get(flow.id)!.revision;
  f.restart();
  expect(await f.execute('control', args)).toMatchObject({ accepted: true, replayed: true });
  expect(f.store.get(flow.id)!.revision).toBe(revision);
  f.newTurn();
  expect((await f.execute('control', args)).error).toContain('revision conflict');
  expect(await f.execute('control', { ...args, revision, action: 'resume' })).toMatchObject({
    accepted: true,
    flow: { status: 'running' },
  });
});

it('checks active native authority and current parent policy before mutation', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  flow.status = 'paused';
  f.store.put(flow);
  const args = { flowId: flow.id, revision: flow.revision, action: 'resume' };
  f.assertCurrent.mockImplementationOnce(() => {
    throw new Error('cancelled');
  });
  expect((await f.execute('control', args)).accepted).toBe(false);
  f.assertParent.mockImplementationOnce(() => {
    throw new Error('permissions changed');
  });
  expect((await f.execute('control', args)).error).toContain('permissions changed');
  expect(f.store.get(flow.id)!.status).toBe('paused');
});

it('accepts fresh pause requests after resume within the same native turn without replaying the first pause', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  for (const [index, action] of ['pause', 'resume', 'pause'].entries()) {
    const revision = f.store.get(flow.id)!.revision;
    expect(
      await f.execute('control', { flowId: flow.id, revision, action }, 'control-' + index),
    ).toMatchObject({
      accepted: true,
      replayed: false,
      flow: { status: action === 'resume' ? 'running' : 'paused' },
    });
  }
  const revision = f.store.get(flow.id)!.revision;
  expect(
    await f.execute(
      'control',
      { flowId: flow.id, revision: revision - 1, action: 'pause' },
      'control-2',
    ),
  ).toMatchObject({ accepted: true, replayed: true, flow: { status: 'paused', revision } });
  expect(f.store.get(flow.id)!.operations).toHaveLength(3);
});

it('allows pause and stop after parent policy changes while refusing new execution or input', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  f.assertParent.mockImplementation(() => {
    f.assertParentIdentity();
    throw new Error('permissions changed');
  });
  expect(
    await f.execute('control', { flowId: flow.id, revision: flow.revision, action: 'pause' }),
  ).toMatchObject({ accepted: true, flow: { status: 'paused' } });
  let revision = f.store.get(flow.id)!.revision;
  expect(
    (await f.execute('control', { flowId: flow.id, revision, action: 'resume' })).error,
  ).toContain('permissions changed');
  expect(
    (
      await f.execute('intervene', {
        flowId: flow.id,
        nodeId: 'plan',
        revision,
        action: 'note',
        text: 'New instructions',
      })
    ).error,
  ).toContain('permissions changed');
  const blocked = f.store.get(flow.id)!;
  blocked.status = 'blocked';
  blocked.nodes[0].status = 'failed';
  blocked.nodes[0].runId = 'settled';
  blocked.nodes[0].endedAt = 1;
  f.store.put(blocked);
  revision = blocked.revision;
  expect(
    (await f.execute('control', { flowId: flow.id, revision, action: 'retry' })).error,
  ).toContain('permissions changed');
  for (const action of ['continue', 'retry'])
    expect(
      (
        await f.execute('intervene', {
          flowId: flow.id,
          nodeId: 'plan',
          revision,
          action,
          text: 'Continue within the original constraints',
        })
      ).error,
    ).toContain('permissions changed');
  expect(await f.execute('control', { flowId: flow.id, revision, action: 'stop' })).toMatchObject({
    accepted: true,
    flow: { status: 'stopping' },
  });
  expect(f.store.get(flow.id)!.nodes[0].attempt).toBe(1);
  expect(f.store.get(flow.id)!.nodes[0].interventions).toBeUndefined();
});

it('refuses every mutation after the native parent identity changes', async () => {
  const f = fixture();
  const flow = f.failed();
  f.assertParentIdentity.mockImplementation(() => {
    throw new Error('parent identity changed');
  });
  for (const action of ['pause', 'resume', 'stop', 'retry'])
    expect(
      (await f.execute('control', { flowId: flow.id, revision: flow.revision, action })).error,
    ).toContain('parent identity changed');
  for (const action of ['note', 'continue', 'retry'])
    expect(
      (
        await f.execute('intervene', {
          flowId: flow.id,
          nodeId: 'plan',
          revision: flow.revision,
          action,
          text: 'Input',
        })
      ).error,
    ).toContain('parent identity changed');
  expect(f.store.get(flow.id)!.revision).toBe(flow.revision);
  expect(f.store.get(flow.id)!.status).toBe('blocked');
});

it('allows stopping an unconfirmed final delivery but blocks controls while delivery is in progress', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  flow.deliveryIntent = true;
  flow.nodes[0].status = 'done';
  f.store.put(flow);
  expect(managementStatus(flow).actions).toEqual({
    pause: false,
    resume: false,
    stop: false,
    retry: false,
  });
  expect(
    (await f.execute('control', { flowId: flow.id, revision: flow.revision, action: 'stop' }))
      .accepted,
  ).toBe(false);
  flow.status = 'blocked';
  flow.error = 'Final delivery could not be confirmed. Results remain available.';
  f.store.put(flow);
  expect(managementStatus(flow).actions.stop).toBe(true);
  expect(
    await f.execute('control', { flowId: flow.id, revision: flow.revision, action: 'stop' }),
  ).toMatchObject({ accepted: true, flow: { status: 'stopping' } });
});

it('continues only the selected failed node and deduplicates retries after state advances', async () => {
  const f = fixture();
  const flow = f.failed();
  const originalKey = flow.nodes[0].sessionKey;
  const args = {
    flowId: flow.id,
    nodeId: 'plan',
    revision: flow.revision,
    action: 'continue',
    text: '正确路径是项目根目录',
  };
  expect(await f.execute('intervene', args)).toMatchObject({
    accepted: true,
    flow: { status: 'running' },
  });
  const continued = f.store.get(flow.id)!;
  expect(continued.nodes[0]).toMatchObject({
    sessionKey: originalKey,
    attempt: 2,
    status: 'queued',
  });
  expect(continued.nodes[0].interventions![0].text).toContain('主助手转交');
  expect(await f.execute('intervene', args)).toMatchObject({ accepted: true, replayed: true });
  expect(f.store.get(flow.id)!.nodes[0].attempt).toBe(2);
});

it('supports a plain continue request and keeps retry in a fresh session', async () => {
  const f = fixture();
  let flow = f.failed();
  expect(
    (
      await f.execute('intervene', {
        flowId: flow.id,
        nodeId: 'plan',
        revision: flow.revision,
        action: 'continue',
      })
    ).accepted,
  ).toBe(true);
  flow = f.store.get(flow.id)!;
  flow.status = 'blocked';
  flow.nodes[0].status = 'failed';
  flow.nodes[0].runId = 'attempt2';
  flow.nodes[0].endedAt = 2;
  f.store.put(flow);
  const priorKey = flow.nodes[0].sessionKey;
  f.newTurn();
  expect(
    (
      await f.execute('intervene', {
        flowId: flow.id,
        nodeId: 'plan',
        revision: flow.revision,
        action: 'retry',
      })
    ).accepted,
  ).toBe(true);
  expect(f.store.get(flow.id)!.nodes[0].sessionKey).not.toBe(priorKey);
});

it('saves input on active work without interrupting it and refuses replay of uncertain or exhausted work', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  flow.nodes[0].status = 'uncertain';
  flow.nodes[0].intendedRunId = 'unconfirmed';
  f.store.put(flow);
  let args = {
    flowId: flow.id,
    nodeId: 'plan',
    revision: flow.revision,
    action: 'note',
    text: '补充信息',
  };
  expect(await f.execute('intervene', args)).toMatchObject({
    accepted: true,
    message: expect.stringContaining('not delivered'),
  });
  expect(f.host.launch).not.toHaveBeenCalled();
  expect(f.host.cancel).not.toHaveBeenCalled();
  args = { ...args, revision: f.store.get(flow.id)!.revision, action: 'continue' };
  expect((await f.execute('intervene', args)).accepted).toBe(false);
  const failed = f.store.get(flow.id)!;
  failed.status = 'blocked';
  failed.nodes[0].status = 'failed';
  failed.nodes[0].attempt = 3;
  failed.nodes[0].endedAt = 2;
  f.store.put(failed);
  expect(
    (await f.execute('intervene', { ...args, revision: failed.revision, action: 'retry' }))
      .accepted,
  ).toBe(false);
});

it('bounds stored controls without discarding older deduplication identities', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  flow.operations = Array.from({ length: FLOW_LIMITS.operations }, (_, i) => ({
    id: String(i),
    action: 'pause' as const,
  }));
  f.store.put(flow);
  expect(
    (await f.execute('control', { flowId: flow.id, revision: flow.revision, action: 'pause' }))
      .error,
  ).toContain('limit');
  expect(f.store.get(flow.id)!.status).toBe('running');
});

it('notifies a blocker once and never resends an uncertain delivery after restart', async () => {
  const f = fixture();
  const flow = f.failed();
  const send = vi.fn(async (_flow: unknown, _message: string) => {
    throw new Error('lost ACK');
  });
  await new FlowNotifier(f.store, { send }).tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toContain('Swarm 等待处理');
  expect(managementStatus(f.store.get(flow.id)!)).toMatchObject({ notificationUnconfirmed: true });
  f.restart();
  await new FlowNotifier(f.store, { send }).tick();
  expect(send).toHaveBeenCalledTimes(1);
  const latest = f.store.get(flow.id)!;
  latest.nodes[0].attempt = 2;
  f.store.put(latest);
  await new FlowNotifier(f.store, { send }).tick();
  expect(send).toHaveBeenCalledTimes(2);
});

it('merges a notice ACK into the latest flow without overwriting a concurrent user operation', async () => {
  const f = fixture();
  const flow = f.failed();
  const send = vi.fn(async () => {
    const current = f.store.get(flow.id)!;
    current.status = 'stopping';
    f.store.put(current);
  });
  await new FlowNotifier(f.store, { send }).tick();
  expect(f.store.get(flow.id)).toMatchObject({ status: 'stopping', notices: [{ state: 'sent' }] });
  await new FlowNotifier(f.store, { send }).tick();
  expect(send).toHaveBeenCalledTimes(1);
});

it('does not notify ordinary progress or completed flows', async () => {
  const f = fixture();
  const flow = f.makeFlow();
  const send = vi.fn(async () => {});
  await new FlowNotifier(f.store, { send }).tick();
  expect(send).not.toHaveBeenCalled();
  flow.status = 'completed';
  f.store.put(flow);
  await new FlowNotifier(f.store, { send }).tick();
  expect(send).not.toHaveBeenCalled();
});

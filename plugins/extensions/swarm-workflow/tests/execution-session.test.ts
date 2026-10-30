import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AppExecutionSessionQuery } from '@app-plugin/sdk/execution-source';
import type { Flow } from '../contracts/flow';
import { FlowStore } from '../data/store';
import type { WorkflowContext } from '../service/context';
import { readWorkflowExecutionSession } from '../service/execution-session';

const native = vi.hoisted(() => ({ entries: new Map<string, Record<string, unknown>>() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: ({ sessionKey }: { sessionKey: string }) => native.entries.get(sessionKey),
}));
const cleanups: Array<() => void> = [];
beforeEach(() => native.entries.clear());
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function fixture(batch = false) {
  mkdirSync('build', { recursive: true });
  const directory = mkdtempSync(path.resolve('build', 'workflow-source-'));
  const store = new FlowStore(directory);
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const query: AppExecutionSessionQuery = {
    sessionKey: 'agent:role:subagent:workflow-child',
    nativeSessionId: 'native-child',
    lifecycleRevision: 'child-revision',
    runId: 'intended-a',
  };
  const flow: Flow = {
    id: 'flow-a',
    requestId: 'request-a',
    parentKey: 'agent:role:justdo:product-root',
    parentId: 'native-parent',
    agentId: 'role',
    agents: [{ id: 'role', name: 'Role' }],
    cwd: directory,
    permissionMode: 'workspace',
    mode: 'auto',
    goal: 'Private task text must not leave the resolver',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
    controlVersion: 1,
    nodes: [
      {
        id: 'work',
        title: 'Check output',
        task: 'Private worker instructions',
        deps: [],
        kind: 'work',
        access: 'write',
        status: 'uncertain',
        sessionKey: query.sessionKey,
        agentId: 'role',
        agentName: 'Role',
        intendedRunId: query.runId,
        dispatch: { message: 'Private dispatched prompt', createdAt: 1 },
        attempt: 1,
      },
    ],
  };
  const child = flow.nodes[0];
  if (batch)
    flow.nodes = [
      {
        ...child,
        id: 'batch',
        kind: 'batch',
        sessionKey: '',
        status: 'queued',
        runId: undefined,
        intendedRunId: undefined,
        dispatch: undefined,
        batchInput: { version: 'input-version', manifestPath: 'manifest.json' },
      },
    ];
  store.insert(flow);
  if (batch) {
    store.expandBatch(
      flow,
      flow.nodes[0],
      [
        {
          ...child,
          id: 'batch-item',
          status: 'queued',
          intendedRunId: undefined,
          dispatch: undefined,
          batchItem: {
            stageId: 'batch',
            manifestVersion: 'input-version',
            ordinal: 0,
            key: 'item-a',
            workspace: directory,
          },
        },
      ],
      () => {},
    );
    const working = store.get(flow.id, 'batch-item')!;
    const item = working.nodes.find(node => node.id === 'batch-item')!;
    item.status = 'uncertain';
    item.intendedRunId = query.runId;
    item.dispatch = { message: 'Private item prompt', createdAt: 2 };
    store.put(working);
  }
  native.entries.set(query.sessionKey, {
    sessionId: query.nativeSessionId,
    lifecycleRevision: query.lifecycleRevision,
    pluginOwnerId: 'swarm-workflow',
  });
  native.entries.set(flow.parentKey, { sessionId: flow.parentId });
  const describeRun = vi.fn(async () => ({
    runId: query.runId,
    sessionKey: query.sessionKey,
    state: 'running',
    executionSettled: false,
  }));
  const context = {
    api: { id: 'swarm-workflow' },
    state: { generation: 1 },
    nativeSubagent: () => ({ describeRun }),
    ensure: () => ({ store }),
  } as unknown as WorkflowContext;
  return { store, flow, query, context, describeRun };
}

it('proves the first tool before run acceptance from durable dispatch plus an exact live Native receipt', async () => {
  const f = fixture();
  expect(f.store.get(f.flow.id)!.nodes[0].runId).toBeUndefined();
  const resolved = await readWorkflowExecutionSession(f.context, f.query);
  expect(resolved).toEqual({
    sessionKey: f.query.sessionKey,
    nativeSessionId: f.query.nativeSessionId,
    runId: f.query.runId,
    parentKey: f.flow.parentKey,
    parentNativeSessionId: f.flow.parentId,
    label: 'Role · Check output',
  });
  expect(JSON.stringify(resolved)).not.toContain('Private');
  expect(f.store.get(f.flow.id)!.revision).toBe(1);
});

it('resolves a real paged batch item rather than its parent stage and rejects a replaced attempt', async () => {
  const f = fixture(true);
  expect(f.store.batches.owner(f.query.sessionKey, f.query.runId)).toEqual({
    flowId: f.flow.id,
    nodeId: 'batch-item',
  });
  expect(f.store.get(f.flow.id)!.nodes.find(node => node.id === 'batch')!.sessionKey).toBe('');
  expect(await readWorkflowExecutionSession(f.context, f.query)).toMatchObject({
    sessionKey: f.query.sessionKey,
    parentKey: f.flow.parentKey,
    runId: f.query.runId,
    label: 'Role · Check output',
  });
  const working = f.store.get(f.flow.id, 'batch-item')!;
  const item = working.nodes.find(node => node.id === 'batch-item')!;
  item.sessionKey = 'agent:role:subagent:replacement-attempt';
  item.intendedRunId = 'intended-b';
  item.attempt = 2;
  f.store.put(working);
  expect(await readWorkflowExecutionSession(f.context, f.query)).toBeNull();
});

it.each(['foreign-run', 'reset-child', 'changed-parent', 'settled', 'unknown'] as const)(
  'does not associate %s with the owning product source',
  async change => {
    const f = fixture();
    if (change === 'foreign-run') f.query.runId = 'another-run';
    if (change === 'reset-child') native.entries.get(f.query.sessionKey)!.sessionId = 'new-child';
    if (change === 'changed-parent') native.entries.get(f.flow.parentKey)!.sessionId = 'new-parent';
    if (change === 'settled')
      f.describeRun.mockResolvedValue({
        runId: f.query.runId,
        sessionKey: f.query.sessionKey,
        state: 'settled',
        executionSettled: true,
      });
    if (change === 'unknown')
      f.describeRun.mockResolvedValue({
        runId: f.query.runId,
        sessionKey: f.query.sessionKey,
        state: 'unknown',
        executionSettled: false,
      });
    expect(await readWorkflowExecutionSession(f.context, f.query)).toBeNull();
  },
);

it('rechecks incarnation and dispatch ownership after an awaited Native result', async () => {
  const f = fixture();
  let complete!: (result: Awaited<ReturnType<typeof f.describeRun>>) => void;
  f.describeRun.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  );
  const resolving = readWorkflowExecutionSession(f.context, f.query);
  native.entries.get(f.query.sessionKey)!.lifecycleRevision = 'replacement-revision';
  complete({
    runId: f.query.runId,
    sessionKey: f.query.sessionKey,
    state: 'running',
    executionSettled: false,
  });
  expect(await resolving).toBeNull();
});

it('does not publish an association after the owning service generation retires', async () => {
  const f = fixture();
  f.describeRun.mockImplementation(async () => {
    ++f.context.state.generation;
    return {
      runId: f.query.runId,
      sessionKey: f.query.sessionKey,
      state: 'running',
      executionSettled: false,
    };
  });
  expect(await readWorkflowExecutionSession(f.context, f.query)).toBeNull();
});

it('does not read an old store after the service adopts a replacement store', async () => {
  const f = fixture();
  const replacement = fixture();
  f.describeRun.mockImplementation(async () => {
    f.context.ensure = (() => ({ store: replacement.store })) as WorkflowContext['ensure'];
    return {
      runId: f.query.runId,
      sessionKey: f.query.sessionKey,
      state: 'running',
      executionSettled: false,
    };
  });
  expect(await readWorkflowExecutionSession(f.context, f.query)).toBeNull();
});

it('uses the exact persisted run owner when another flow references the same Native key', async () => {
  const f = fixture();
  f.store.insert({
    ...f.flow,
    id: 'other-flow',
    requestId: 'other-request',
    nodes: [{ ...f.flow.nodes[0], intendedRunId: 'other-run' }],
  });
  expect(await readWorkflowExecutionSession(f.context, f.query)).toMatchObject({
    sessionKey: f.query.sessionKey,
    runId: f.query.runId,
  });
});

it('keeps independent sibling runs associated after one sibling becomes settled', async () => {
  const f = fixture();
  const sibling = {
    ...f.flow.nodes[0],
    id: 'sibling',
    sessionKey: 'agent:role:subagent:sibling',
    intendedRunId: 'sibling-run',
  };
  const flow = f.store.get(f.flow.id)!;
  flow.nodes.push(sibling);
  f.store.put(flow);
  native.entries.set(sibling.sessionKey, {
    sessionId: 'sibling-native',
    lifecycleRevision: 'sibling-revision',
    pluginOwnerId: 'swarm-workflow',
  });
  const query = {
    ...f.query,
    sessionKey: sibling.sessionKey,
    nativeSessionId: 'sibling-native',
    lifecycleRevision: 'sibling-revision',
    runId: 'sibling-run',
  };
  f.describeRun.mockImplementation(async () => ({
    runId: 'sibling-run',
    sessionKey: sibling.sessionKey,
    state: 'settled',
    executionSettled: true,
  }));
  expect(await readWorkflowExecutionSession(f.context, query)).toBeNull();
  f.describeRun.mockImplementation(async () => ({
    runId: f.query.runId,
    sessionKey: f.query.sessionKey,
    state: 'running',
    executionSettled: false,
  }));
  expect(await readWorkflowExecutionSession(f.context, f.query)).toMatchObject({
    sessionKey: f.query.sessionKey,
  });
});

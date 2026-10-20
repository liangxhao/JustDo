import type { AppNativeRuntime as OpenClawRuntimeAdapter } from '@app-plugin/sdk/main';
import { expect, test, vi } from 'vitest';

import { validFlowDetail } from '../contracts/workflow';
import { createSwarmWorkflowCoordinator } from './coordinator';
const ownedParent = 'agent:main:justdo:product';
test('loads compact activity in pages and projects only exact current product owners', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ parentKeys: [ownedParent], cursor: ownedParent, snapshot: '1:2' })
    .mockResolvedValueOnce({
      parentKeys: ['agent:other:justdo:product', 'agent:main:justdo:foreign'],
      snapshot: '1:2',
    });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  };
  // The runtime's connected client has stable identity, as in the production adapter.
  const client = { request };
  runtime.getGatewayClient = () => client;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime as unknown as OpenClawRuntimeAdapter,
    hasSession: id => id === 'product',
  });
  expect(await operations.getSwarmWorkflowActivity()).toEqual({
    success: true,
    sessionIds: ['product'],
  });
  expect(request.mock.calls).toEqual([
    ['swarmWorkflow.activity', {}],
    ['swarmWorkflow.activity', { cursor: ownedParent }],
  ]);
});

test('rejects incomplete, malformed and replaced-client activity snapshots', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ parentKeys: [ownedParent], cursor: ownedParent, snapshot: '1:2' });
  const client = { request };
  const runtime = { getGatewayClient: () => client, getSessionKeysForSession: () => [ownedParent] };
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime as unknown as OpenClawRuntimeAdapter,
    hasSession: id => id === 'product',
  });
  const read = () => operations.getSwarmWorkflowActivity();
  expect(await read()).toEqual({ success: false });
  request.mockResolvedValue({ parentKeys: ['agent:main:subagent:worker'], snapshot: '1:2' });
  expect(await read()).toEqual({ success: false });
  request.mockResolvedValue({ parentKeys: [ownedParent], snapshot: '1:2' });
  runtime.getSessionKeysForSession = () => [];
  expect(await read()).toEqual({ success: false });
  runtime.getSessionKeysForSession = () => [ownedParent];
  request
    .mockResolvedValueOnce({ parentKeys: [ownedParent], cursor: ownedParent, snapshot: '1:2' })
    .mockResolvedValueOnce({ parentKeys: [], snapshot: '2:0' });
  expect(await read()).toEqual({ success: false });
  request.mockImplementation(async () => {
    runtime.getGatewayClient = () => ({ request });
    return { parentKeys: [], snapshot: '1:2' };
  });
  expect(await read()).toEqual({ success: false });
});

test('reads summary counts without full histories and rechecks identity after awaiting', async () => {
  const request = vi.fn().mockResolvedValue({ count: 50, running: false });
  const client = { request };
  let key = ownedParent;
  const runtime = { getGatewayClient: () => client, getSessionKeysForSession: () => [key] };
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime as unknown as OpenClawRuntimeAdapter,
    hasSession: id => id === 'product',
  });
  const read = operations.getSwarmWorkflowSummary;
  expect(await read('product')).toEqual({ success: true, count: 50, running: false });
  expect(request).toHaveBeenCalledExactlyOnceWith('swarmWorkflow.summary', {
    parentKeys: [ownedParent],
  });
  expect(await read('foreign')).toEqual({ success: false });
  request.mockResolvedValue({ count: -1, running: false });
  expect(await read('product')).toEqual({ success: false });
  request.mockImplementation(async () => {
    key = 'agent:other:justdo:product';
    return { count: 1, running: true };
  });
  expect(await read('product')).toEqual({ success: false });
});
test('queries workflow parents without forwarding channel or worker aliases', async () => {
  const parents = ['agent:main:justdo:product', 'agent:assistant:justdo:product'];
  const request = vi.fn(async (_method: string, params: { parentKeys: string[] }) => {
    if (!params.parentKeys.every(key => parents.includes(key))) {
      throw new Error('Invalid parent identities.');
    }
    return { flows: [], running: true };
  });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [
      'agent:main:openai-user:telegram:channel',
      parents[0],
      'agent:main:subagent:worker',
      parents[1],
      parents[0],
    ],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });

  expect(await operations.getSwarmWorkflows('product')).toEqual({
    success: true,
    flows: [],
    running: true,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith('swarmWorkflow.list', { parentKeys: parents });
});

test.each([
  ['agent:main:subagent:worker'],
  ['agent:main:openai-user:telegram:channel'],
  ['agent:main:cron:scheduled'],
  ['agent:main:external:conversation'],
])('returns no workflows for unsupported native parents %j without issuing RPCs', async key => {
  const request = vi.fn();
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [key],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });

  expect(await operations.getSwarmWorkflows('product')).toEqual({
    success: true,
    flows: [],
    running: false,
  });
  expect(await operations.getSwarmWorkflowSummary('product')).toEqual({
    success: true,
    count: 0,
    running: false,
  });
  expect(await operations.getSwarmWorkflows('foreign')).toEqual({ success: false });
  expect(await operations.getSwarmWorkflowDetail('product', 'flow', 'node')).toEqual({
    success: false,
  });
  expect(await operations.controlSwarmWorkflow('product', 'flow', 1, 'stop')).toEqual({
    success: false,
  });
  expect(await operations.getSwarmWorkflowBatch('product', 'flow', 'batch', {})).toEqual({
    success: false,
  });
  expect(
    await operations.retrySwarmWorkflowBatch('product', 'flow', 'batch', 1, 'operation', ['item']),
  ).toEqual({ success: false });
  expect(
    await operations.interveneSwarmWorkflow('product', 'flow', 'node', 1, {
      id: 'operation',
      action: 'note',
      text: 'Additional input',
    }),
  ).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
});

test('keeps unresolved native identity as a failure instead of successful empty history', async () => {
  const request = vi.fn();
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });

  expect(await operations.getSwarmWorkflows('product')).toEqual({ success: false });
  expect(await operations.getSwarmWorkflowSummary('product')).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
});

test('preserves all-history workflow activity and rejects malformed native summaries', async () => {
  const request = vi.fn().mockResolvedValue({ flows: [], running: true });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  const read = operations.getSwarmWorkflows;
  expect(await read('product')).toEqual({ success: true, flows: [], running: true });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.list', { parentKeys: [ownedParent] });
  request.mockResolvedValue({ flows: [], running: false });
  expect(await read('product')).toEqual({ success: true, flows: [], running: false });
  request.mockResolvedValue({ flows: [] });
  expect(await read('product')).toEqual({ success: true, flows: [] });
  request.mockResolvedValue({ flows: [], running: 'true' });
  expect(await read('product')).toEqual({ success: false });
  request.mockRejectedValue(new Error('Gateway disconnected'));
  expect(await read('product')).toEqual({ success: false });
});

test('binds batch reads to product identity and rejects mismatched or oversized pages', async () => {
  const counts = {
    total: 100,
    queued: 100,
    done: 0,
    failed: 0,
    running: 0,
    preparing: 0,
    uncertain: 0,
    cancelled: 0,
  };
  const page = {
    flowId: 'flow',
    stageId: 'batch',
    manifestVersion: 'v1',
    revision: 3,
    counts,
    matched: 100,
    retryable: 0,
    items: [],
  };
  const request = vi.fn().mockResolvedValue(page);
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  const read = operations.getSwarmWorkflowBatch;
  expect(await read('foreign', 'flow', 'batch', {})).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(await read('product', 'flow', 'batch', {})).toEqual({ success: true, page });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.batch', {
    parentKeys: [ownedParent],
    id: 'flow',
    stageId: 'batch',
  });
  request.mockResolvedValue({ ...page, flowId: 'other' });
  expect(await read('product', 'flow', 'batch', {})).toEqual({ success: false });
  request.mockResolvedValue({
    ...page,
    items: Array(51).fill({ id: 'item', title: 'Item', status: 'queued' }),
  });
  expect(await read('product', 'flow', 'batch', {})).toEqual({ success: false });
});
test('rejects forged batch retry payloads and preserves skipped reasons', async () => {
  const request = vi.fn().mockResolvedValue({
    retried: ['item-1'],
    skipped: ['item-2'],
    reasons: { 'item-2': 'Attempt limit reached.' },
  });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  const retry = operations.retrySwarmWorkflowBatch;
  for (const items of [null, [], ['same', 'same'], Array(101).fill('item')])
    expect(await retry('product', 'flow', 'batch', 3, 'request', items)).toEqual({
      success: false,
    });
  expect(request).not.toHaveBeenCalled();
  expect(await retry('product', 'flow', 'batch', 3, 'request', undefined)).toEqual({
    success: true,
    retried: 1,
    skipped: 1,
    reasons: ['Attempt limit reached.'],
  });
});
test('forwards only explicit human input under a product-owned parent and rejects invalid payloads', async () => {
  const request = vi.fn().mockResolvedValue({});
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  const intervene = operations.interveneSwarmWorkflow;
  const note = { id: 'input-1', action: 'continue', text: 'Environment fixed' };
  expect(await intervene('foreign', 'flow', 'verify', 5, note)).toEqual({ success: false });
  expect(
    await intervene('product', 'flow', 'verify', 5, { ...note, text: 'x'.repeat(4001) }),
  ).toEqual({ success: false });
  expect(
    await intervene('product', 'flow', 'verify', 5, { ...note, action: 'force-complete' }),
  ).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(
    await intervene('product', 'flow', 'verify', 5, { ...note, sessionKey: 'foreign' }),
  ).toEqual({ success: true });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.intervene', {
    parentKeys: [ownedParent],
    id: 'flow',
    nodeId: 'verify',
    revision: 5,
    intervention: note,
  });
});
test('rejects malformed intervention history and capabilities from detail replies', () => {
  const detail = {
    flowId: 'flow',
    nodeId: 'verify',
    sessionKey: 'native',
    workingDirectory: '/project',
    submission: 'submitted',
    revision: 2,
    canNote: true,
    interventions: [{ id: 'input', action: 'note', text: 'Human decision', createdAt: 1 }],
  };
  expect(validFlowDetail(detail)).toBe(true);
  expect(validFlowDetail({ ...detail, canNote: 'yes' })).toBe(false);
  expect(validFlowDetail({ ...detail, revision: -1 })).toBe(false);
  expect(
    validFlowDetail({ ...detail, interventions: Array(31).fill(detail.interventions[0]) }),
  ).toBe(false);
  expect(
    validFlowDetail({
      ...detail,
      interventions: [{ ...detail.interventions[0], text: 'x'.repeat(4001) }],
    }),
  ).toBe(false);
});
test('rejects renderer-supplied unknown product identities before accessing the Gateway', async () => {
  const getRuntime = vi.fn();
  const operations = createSwarmWorkflowCoordinator({
    getRuntime,
    hasSession: () => false,
  });
  expect(
    await operations.prepareSwarmWorkflow({ mode: 'auto', verify: true }, 'foreign'),
  ).toMatchObject({ success: false, reason: 'invalid' });
  expect(getRuntime).not.toHaveBeenCalled();
});
test('rejects plan-mode execution using the runtime authority', async () => {
  const request = vi.fn().mockResolvedValue({ ready: true });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
    getPlanMode: vi.fn().mockResolvedValue({ enabled: true }),
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: () => true,
  });
  expect(await operations.prepareSwarmWorkflow({ mode: 'auto', verify: true }, 'product')).toEqual({
    success: false,
    reason: 'plan',
  });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.health', {});
});
test('does not enable an unavailable flow plugin on behalf of the user', async () => {
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: vi.fn(),
    hasSession: () => true,
  });
  expect(await operations.prepareSwarmWorkflow({ mode: 'auto', verify: true })).toEqual({
    success: false,
    reason: 'unavailable',
  });
});
test('rejects extra execution controls rather than granting model-supplied authority', async () => {
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: vi.fn(),
    hasSession: () => true,
  });
  expect(
    await operations.prepareSwarmWorkflow({ mode: 'auto', verify: true, groupId: 'foreign' }),
  ).toEqual({ success: false, reason: 'invalid' });
});

test('resolves detail parents from product authority and rejects mismatched replies', async () => {
  const detail = {
    flowId: 'flow',
    nodeId: 'work',
    sessionKey: 'native',
    workingDirectory: '/project',
    submission: 'submitted',
  };
  const request = vi.fn().mockResolvedValue(detail);
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  const read = operations.getSwarmWorkflowDetail;
  expect(await read('foreign', 'flow', 'work')).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(await read('product', 'flow', 'work', 'source')).toEqual({ success: true, detail });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.detail', {
    parentKeys: [ownedParent],
    id: 'flow',
    nodeId: 'work',
    sourceId: 'source',
  });
  request.mockResolvedValue({ ...detail, nodeId: 'other' });
  expect(await read('product', 'flow', 'work')).toEqual({ success: false });
});

test('accepts complete dispatch envelopes after bounded inputs expand during JSON escaping', async () => {
  const message = JSON.stringify({
    goal: '\u0001'.repeat(16000),
    inputs: Array.from({ length: 8 }, (_, i) => ({
      id: `work-${i}`,
      result: '\u0001'.repeat(24000),
    })),
  });
  expect(message.length).toBeGreaterThan(400000);
  const detail = {
    flowId: 'flow',
    nodeId: 'verify',
    sessionKey: 'native',
    workingDirectory: '/project',
    submission: 'submitted',
    dispatch: { message, createdAt: 1 },
  };
  const request = vi.fn().mockResolvedValue(detail);
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  expect(await operations.getSwarmWorkflowDetail('product', 'flow', 'verify')).toEqual({
    success: true,
    detail,
  });
});

test('allows revision-bound retry only through an owned product conversation', async () => {
  const flow = {
    id: 'flow',
    revision: 5,
    goal: 'Inspect',
    createdAt: 1,
    status: 'blocked',
    nodes: [],
  };
  const request = vi.fn(async (method: string) =>
    method === 'swarmWorkflow.list' ? { flows: [flow] } : {},
  );
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => [ownedParent],
  } as unknown as OpenClawRuntimeAdapter;
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: () => runtime,
    hasSession: id => id === 'product',
  });
  const control = operations.controlSwarmWorkflow;
  expect(await control('foreign', 'flow', 5, 'retry')).toEqual({ success: false });
  expect(await control('product', 'flow', 5, 'retry-all')).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(await control('product', 'flow', 5, 'retry')).toEqual({ success: true });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.control', {
    parentKeys: [ownedParent],
    id: 'flow',
    revision: 5,
    action: 'retry',
  });
});

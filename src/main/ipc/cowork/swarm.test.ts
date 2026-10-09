import { beforeEach, expect, test, vi } from 'vitest';

import { SwarmIpc } from '../../../shared/cowork/swarm';
import type { OpenClawRuntimeAdapter } from '../../engine';
const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
import { SwarmWorkflowIpc, validFlowDetail } from '../../../shared/cowork/swarmWorkflow';
import { registerCoworkSubtaskHandlers } from './subtasks';
beforeEach(() => mocks.handle.mockReset());
const handler = (key: string) => mocks.handle.mock.calls.find(call => call[0] === key)![1];
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
    getSessionKeysForSession: () => ['owned'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'product' });
  const read = handler(SwarmWorkflowIpc.Batch);
  expect(await read({}, 'foreign', 'flow', 'batch', {})).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(await read({}, 'product', 'flow', 'batch', {})).toEqual({ success: true, page });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.batch', {
    parentKeys: ['owned'],
    id: 'flow',
    stageId: 'batch',
  });
  request.mockResolvedValue({ ...page, flowId: 'other' });
  expect(await read({}, 'product', 'flow', 'batch', {})).toEqual({ success: false });
  request.mockResolvedValue({
    ...page,
    items: Array(51).fill({ id: 'item', title: 'Item', status: 'queued' }),
  });
  expect(await read({}, 'product', 'flow', 'batch', {})).toEqual({ success: false });
});
test('rejects forged batch retry payloads and preserves skipped reasons', async () => {
  const request = vi.fn().mockResolvedValue({
    retried: ['item-1'],
    skipped: ['item-2'],
    reasons: { 'item-2': 'Attempt limit reached.' },
  });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => ['owned'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'product' });
  const retry = handler(SwarmWorkflowIpc.RetryBatch);
  for (const items of [null, [], ['same', 'same'], Array(101).fill('item')])
    expect(await retry({}, 'product', 'flow', 'batch', 3, 'request', items)).toEqual({
      success: false,
    });
  expect(request).not.toHaveBeenCalled();
  expect(await retry({}, 'product', 'flow', 'batch', 3, 'request', undefined)).toEqual({
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
    getSessionKeysForSession: () => ['owned'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'product' });
  const intervene = handler(SwarmWorkflowIpc.Intervene);
  const note = { id: 'input-1', action: 'continue', text: 'Environment fixed' };
  expect(await intervene({}, 'foreign', 'flow', 'verify', 5, note)).toEqual({ success: false });
  expect(
    await intervene({}, 'product', 'flow', 'verify', 5, { ...note, text: 'x'.repeat(4001) }),
  ).toEqual({ success: false });
  expect(
    await intervene({}, 'product', 'flow', 'verify', 5, { ...note, action: 'force-complete' }),
  ).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(
    await intervene({}, 'product', 'flow', 'verify', 5, { ...note, sessionKey: 'foreign' }),
  ).toEqual({ success: true });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.intervene', {
    parentKeys: ['owned'],
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
  registerCoworkSubtaskHandlers({
    getRuntime,
    hasSession: () => false,
  });
  expect(await handler(SwarmIpc.Snapshot)({}, 'foreign-native-key')).toEqual({ success: false });
  expect(
    await handler(SwarmWorkflowIpc.Prepare)({}, { mode: 'auto', verify: true }, 'foreign'),
  ).toMatchObject({ success: false, reason: 'invalid' });
  expect(getRuntime).not.toHaveBeenCalled();
});
test('rejects plan-mode execution using the runtime authority', async () => {
  const request = vi.fn().mockResolvedValue({ ready: true });
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => ['owned'],
    getPlanMode: vi.fn().mockResolvedValue({ enabled: true }),
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({
    getRuntime: () => runtime,
    hasSession: () => true,
  });
  expect(await handler(SwarmWorkflowIpc.Prepare)({}, { mode: 'auto', verify: true }, 'product')).toEqual({
    success: false,
    reason: 'plan',
  });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.health', {});
});
test('does not enable an unavailable flow plugin on behalf of the user', async () => {
  registerCoworkSubtaskHandlers({
    getRuntime: vi.fn(),
    hasSession: () => true,
  });
  expect(await handler(SwarmWorkflowIpc.Prepare)({}, { mode: 'auto', verify: true })).toEqual({
    success: false,
    reason: 'unavailable',
  });
});
test('rejects extra execution controls rather than granting model-supplied authority', async () => {
  registerCoworkSubtaskHandlers({
    getRuntime: vi.fn(),
    hasSession: () => true,
  });
  expect(
    await handler(SwarmWorkflowIpc.Prepare)({}, { mode: 'auto', verify: true, groupId: 'foreign' }),
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
    getSessionKeysForSession: () => ['owned'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'product' });
  const read = handler('cowork:swarm-workflow:detail');
  expect(await read({}, 'foreign', 'flow', 'work')).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(await read({}, 'product', 'flow', 'work', 'source')).toEqual({ success: true, detail });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.detail', {
    parentKeys: ['owned'],
    id: 'flow',
    nodeId: 'work',
    sourceId: 'source',
  });
  request.mockResolvedValue({ ...detail, nodeId: 'other' });
  expect(await read({}, 'product', 'flow', 'work')).toEqual({ success: false });
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
    getSessionKeysForSession: () => ['owned'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'product' });
  expect(await handler('cowork:swarm-workflow:detail')({}, 'product', 'flow', 'verify')).toEqual({
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
    getSessionKeysForSession: () => ['owned'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'product' });
  const control = handler('cowork:swarm-workflow:control');
  expect(await control({}, 'foreign', 'flow', 5, 'retry')).toEqual({ success: false });
  expect(await control({}, 'product', 'flow', 5, 'retry-all')).toEqual({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(await control({}, 'product', 'flow', 5, 'retry')).toEqual({ success: true });
  expect(request).toHaveBeenCalledWith('swarmWorkflow.control', {
    parentKeys: ['owned'],
    id: 'flow',
    revision: 5,
    action: 'retry',
  });
});

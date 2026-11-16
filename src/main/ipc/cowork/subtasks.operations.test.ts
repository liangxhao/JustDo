import { beforeEach, expect, it, vi } from 'vitest';

import { CoworkSubagentDetailsIpc, SubagentReadFailure } from '../../../shared/cowork/subagentDetails';
import { SwarmIpc } from '../../../shared/cowork/swarm';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawRuntimeAdapter } from '../../engine';
const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
import { registerCoworkSubtaskHandlers } from './subtasks';
beforeEach(() => mocks.handle.mockReset());

it('distinguishes an unavailable status refresh from a complete empty list', async () => {
  const getSubagentStatuses = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('Native request timed out'), { code: 'CLIENT_TIMEOUT' }))
    .mockResolvedValueOnce({ subagents: [] });
  const runtime = { getSubagentStatuses } as unknown as OpenClawRuntimeAdapter;
  const getRuntime = vi.fn().mockReturnValueOnce(null).mockReturnValue(runtime);
  registerCoworkSubtaskHandlers({ getRuntime, hasSession: () => true });
  const handler = mocks.handle.mock.calls.find(call => call[0] === CoworkSubagentDetailsIpc.Status)![1];

  await expect(handler({}, 'session')).resolves.toEqual({
    success: false, reason: SubagentReadFailure.Disconnected,
  });
  await expect(handler({}, 'session', true)).resolves.toEqual({
    success: false, reason: SubagentReadFailure.TimedOut,
  });
  await expect(handler({}, 'session')).resolves.toEqual({ success: true, subagents: [] });
});

it('opens an exact archived child without depending on the catalog and rejects mismatched identity', async () => {
  const parentKey = 'agent:main:session:parent';
  const childKey = 'agent:main:dashboard:child';
  const child = {
    key: childKey,
    sessionId: 'physical-child',
    archivedAt: 1,
    createdVia: 'spawn',
    spawnDepth: 1,
    parentSessionKey: parentKey,
  };
  const request = vi.fn()
    .mockResolvedValueOnce({ session: child })
    .mockResolvedValueOnce({ session: { ...child, parentSessionKey: 'agent:main:session:other' } })
    .mockResolvedValueOnce({ session: { ...child, key: 'agent:main:dashboard:other' } });
  const client = { request };
  const runtime = {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => 1,
    getSessionKeysForSession: () => [parentKey],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: id => id === 'parent' });
  const handler = mocks.handle.mock.calls.find(call => call[0] === CoworkSubagentDetailsIpc.FindChild)![1];

  await expect(handler({}, 'parent', childKey)).resolves.toMatchObject({
    success: true, subagent: { sessionKey: childKey, sessionId: child.sessionId },
  });
  await expect(handler({}, 'parent', childKey)).resolves.toEqual({ success: true, subagent: null });
  await expect(handler({}, 'parent', childKey)).resolves.toEqual({
    success: false, reason: SubagentReadFailure.InvalidData,
  });
  expect(request.mock.calls).toEqual(Array.from({ length: 3 }, () =>
    ['sessions.describe', { key: childKey }],
  ));
});

it('keeps native swarm snapshots independent from workflow plugin handlers', async () => {
  const getRuntime = vi.fn();
  registerCoworkSubtaskHandlers({ getRuntime, hasSession: () => false });
  const handler = mocks.handle.mock.calls.find(call => call[0] === SwarmIpc.Snapshot)![1];
  expect(await handler({}, 'foreign-native-key')).toEqual({ success: false });
  expect(getRuntime).not.toHaveBeenCalled();
  expect(mocks.handle.mock.calls.some(call => call[0].startsWith('cowork:swarm-workflow:'))).toBe(
    false,
  );
});
it.each([
  CoworkSubagentDetailsIpc.Control,
  CoworkSubagentDetailsIpc.ListChildren,
  CoworkSubagentDetailsIpc.FindChild,
])(
  'rejects deleted product sessions before native access for %s',
  async channel => {
    const getRuntime = vi.fn();
    registerCoworkSubtaskHandlers({ getRuntime, hasSession: () => false });
    const handler = mocks.handle.mock.calls.find(call => call[0] === channel)![1];
    await expect(handler({}, 'deleted-session', 'task-one', 'cancel')).resolves.toEqual(
      channel === CoworkSubagentDetailsIpc.Control
        ? { success: false, error: 'Product session was not found' }
        : { success: false, reason: SubagentReadFailure.SessionUnavailable },
    );
    expect(getRuntime).not.toHaveBeenCalled();
  },
);
it('rejects invalid task operations without sending a native mutation', async () => {
  const request = vi.fn();
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => ['root'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: () => true });
  const handler = mocks.handle.mock.calls.find(
    call => call[0] === CoworkSubagentDetailsIpc.Control,
  )![1];
  await expect(handler({}, 'session', 'task-one', 'rerun')).resolves.toEqual({
    success: false,
    error: 'Unknown subagent operation',
  });
  expect(request).not.toHaveBeenCalled();
});

it('resolves the original visible child for the parent drawer and rejects a stale child identity', async () => {
  const parent = { id: 'parent', agentId: 'main', nativeSessionKey: 'agent:main:justdo:parent' };
  const child = {
    id: 'child', agentId: 'main', cwd: process.cwd(),
    nativeSessionKey: 'agent:main:dashboard:child', nativeParentSessionId: parent.id,
  };
  const request = vi.fn().mockResolvedValue({ session: {
    key: child.nativeSessionKey,
    sessionId: 'physical-child',
    parentSessionKey: parent.nativeSessionKey,
    createdVia: 'spawn',
    spawnDepth: 1,
    sessionRoot: child.cwd,
  } });
  const client = { request };
  const runtime = {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => 1,
    getSessionKeysForSession: () => [parent.nativeSessionKey],
  } as unknown as OpenClawRuntimeAdapter;
  let mapped = false;
  const getStore = () => ({
    getSession: (id: string) => id === parent.id ? parent : null,
    getSessionByNativeKey: (key: string) => mapped && key === child.nativeSessionKey ? child : null,
  }) as unknown as CoworkStore;
  const discoverNativeChildSessions = vi.fn(async () => { mapped = true; });
  registerCoworkSubtaskHandlers({
    getRuntime: () => runtime,
    hasSession: id => id === parent.id,
    conversation: { isAllowedSender: () => true, getStore, discoverNativeChildSessions },
  });
  const handler = mocks.handle.mock.calls.find(
    call => call[0] === CoworkSubagentDetailsIpc.GetConversation,
  )![1];

  await expect(handler({}, parent.id, child.nativeSessionKey, 'physical-child')).resolves.toEqual({
    success: true,
    target: {
      productSessionId: child.id,
      parentProductSessionId: parent.id,
      sessionKey: child.nativeSessionKey,
      sessionId: 'physical-child',
      agentId: 'main',
      workingDirectory: child.cwd,
    },
  });
  await expect(handler({}, parent.id, child.nativeSessionKey, 'stale-child')).resolves.toMatchObject({ success: false });
  await expect(handler({}, parent.id, 'agent:main:subagent:hidden', 'hidden')).resolves.toEqual({ success: true });
  expect(discoverNativeChildSessions).toHaveBeenCalledOnce();
});

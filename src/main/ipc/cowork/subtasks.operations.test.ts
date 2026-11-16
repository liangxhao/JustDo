import { beforeEach, expect, it, vi } from 'vitest';

import { CoworkSubagentDetailsIpc } from '../../../shared/cowork/subagentDetails';
import { SwarmIpc } from '../../../shared/cowork/swarm';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawRuntimeAdapter } from '../../engine';
const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
import { registerCoworkSubtaskHandlers } from './subtasks';
beforeEach(() => mocks.handle.mockReset());
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
it.each([CoworkSubagentDetailsIpc.Control, CoworkSubagentDetailsIpc.ListChildren])(
  'rejects deleted product sessions before native access for %s',
  async channel => {
    const getRuntime = vi.fn();
    registerCoworkSubtaskHandlers({ getRuntime, hasSession: () => false });
    const handler = mocks.handle.mock.calls.find(call => call[0] === channel)![1];
    await expect(handler({}, 'deleted-session', 'task-one', 'cancel')).resolves.toEqual({
      success: false,
      error: 'Product session was not found',
    });
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

import type { AppMainHost } from '@app-plugin/sdk/main';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { register } from './app';
import { SwarmWorkflowGatewayEvent, WorkflowEventName } from '../contracts/events';
import type { Flow } from '../contracts/flow';
import { FlowStore } from '../data/store';

test('keeps persisted workflows independent of source admission and cancellation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-cancel-'));
  const database = new FlowStore(directory);
  const parentKey = 'agent:main:justdo:source';
  const flow: Flow = {
    id: 'owned', requestId: 'request', parentKey, parentId: 'native-source', agentId: 'main',
    agents: [], cwd: directory, permissionMode: 'workspace', mode: 'auto', goal: 'Work',
    revision: 3, createdAt: 1, updatedAt: 1, status: 'running', nodes: [],
  };
  database.insert(flow);
  const requestConnectedGateway = vi.fn();
  const getSessionRuntimeStatus = vi.fn();
  try {
    const registration = register({
      getNativeStateDirectory: () => directory,
      getSessions: () => ({
        getSessionByNativeKey: (key: string) => ({ id: key === parentKey ? 'source' : 'other' }),
      }),
      getExecution: () => ({ getSessionRuntimeStatus }),
      requestConnectedGateway,
    } as unknown as AppMainHost);
    expect(registration.resources!.protectedResources!()).toEqual(['source']);
    await expect(registration.submission!.releaseIfSettled('source')).resolves.toBe(true);
    await expect(registration.submission!.cancel('source', 'failed-team-turn')).resolves.toBeUndefined();
    await expect(registration.submission!.cancel('source')).resolves.toBeUndefined();
    expect(requestConnectedGateway).not.toHaveBeenCalled();
    expect(getSessionRuntimeStatus).not.toHaveBeenCalled();
    expect(database.get('owned')).toMatchObject({ status: 'running', revision: 3 });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates native changes, projects owned parents and releases the subscription', () => {
  const publishEvent = vi.fn();
  const release = vi.fn();
  let listener!: (event: { event: string; payload: unknown }) => void;
  const parentKey = 'agent:main:justdo:session-1';
  const runtime = { getSessionKeysForSession: () => [parentKey] };
  const registration = register({
    publishEvent,
    getRuntime: () => runtime,
    getSessions: () => ({
      getSessionByNativeKey: (key: string) => (key === parentKey ? { id: 'session-1' } : null),
      getSession: () => null,
    }),
    onNativeEvent: (callback: typeof listener) => {
      listener = callback;
      return release;
    },
  } as unknown as AppMainHost);
  const dispose = registration.onEnable?.();
  const change = { parentKey, flowId: 'flow', revision: 7 };
  for (const payload of [
    null,
    [],
    {},
    { ...change, revision: 0 },
    { ...change, revision: 1.5 },
    { ...change, flowId: 'x'.repeat(81) },
    { ...change, parentKey: 'agent:review:justdo:session-1' },
    { ...change, parentKey: 'missing' },
  ])
    listener({ event: SwarmWorkflowGatewayEvent.Changed, payload });
  expect(publishEvent).not.toHaveBeenCalled();
  listener({
    event: SwarmWorkflowGatewayEvent.Changed,
    payload: { ...change, content: 'not forwarded' },
  });
  expect(publishEvent).toHaveBeenCalledExactlyOnceWith(WorkflowEventName.Changed, {
    sessionId: 'session-1',
    flowId: 'flow',
    revision: 7,
  });
  listener({ event: SwarmWorkflowGatewayEvent.Reset, payload: {} });
  expect(publishEvent).toHaveBeenLastCalledWith(WorkflowEventName.Changed, {});
  dispose?.();
  expect(release).toHaveBeenCalledOnce();
});

test('projects derived product parents only while their exact live ownership remains current', () => {
  const parentKey = 'agent:main:justdo:source';
  const publishEvent = vi.fn();
  let listener!: (event: { event: string; payload: unknown }) => void;
  let exists = true;
  const ownedKeys = vi.fn(() => [parentKey]);
  const originalRuntime = { getSessionKeysForSession: ownedKeys };
  let runtime: typeof originalRuntime | null = originalRuntime;
  const registration = register({
    publishEvent,
    getRuntime: () => runtime,
    getSessions: () => ({
      getSessionByNativeKey: () => null,
      getSession: (id: string) => (id === 'source' && exists ? { id } : null),
    }),
    onNativeEvent: (callback: typeof listener) => {
      listener = callback;
      return () => undefined;
    },
  } as unknown as AppMainHost);
  registration.onEnable?.();
  const change = (key = parentKey) =>
    listener({
      event: SwarmWorkflowGatewayEvent.Changed,
      payload: { parentKey: key, flowId: 'flow', revision: 2 },
    });

  change();
  expect(publishEvent).toHaveBeenCalledExactlyOnceWith(WorkflowEventName.Changed, {
    sessionId: 'source', flowId: 'flow', revision: 2,
  });
  publishEvent.mockClear();
  change('agent:review:justdo:source');
  change('agent:main:justdo:missing');
  exists = false;
  change();
  exists = true;
  ownedKeys.mockReturnValue([]);
  change();
  ownedKeys.mockImplementation(() => {
    runtime = { getSessionKeysForSession: () => [parentKey] };
    return [parentKey];
  });
  change();
  runtime = null;
  change();
  expect(publishEvent).not.toHaveBeenCalled();
});

test('preserves imported native bindings while requiring their current exact key', () => {
  const parentKey = 'agent:main:justdo:original-source';
  const publishEvent = vi.fn();
  let listener!: (event: { event: string; payload: unknown }) => void;
  const ownedKeys = vi.fn(() => [parentKey]);
  const runtime = { getSessionKeysForSession: ownedKeys };
  const getSession = vi.fn();
  const registration = register({
    publishEvent,
    getRuntime: () => runtime,
    getSessions: () => ({
      getSessionByNativeKey: () => ({ id: 'imported-source' }),
      getSession,
    }),
    onNativeEvent: (callback: typeof listener) => {
      listener = callback;
      return () => undefined;
    },
  } as unknown as AppMainHost);
  registration.onEnable?.();
  const event = {
    event: SwarmWorkflowGatewayEvent.Changed,
    payload: { parentKey, flowId: 'flow', revision: 2 },
  };
  listener(event);
  expect(ownedKeys).toHaveBeenCalledWith('imported-source');
  expect(getSession).not.toHaveBeenCalled();
  expect(publishEvent).toHaveBeenCalledExactlyOnceWith(WorkflowEventName.Changed, {
    sessionId: 'imported-source', flowId: 'flow', revision: 2,
  });
  ownedKeys.mockReturnValue(['agent:review:justdo:original-source']);
  listener(event);
  expect(publishEvent).toHaveBeenCalledOnce();
});

// @vitest-environment jsdom
import type {
  SwarmWorkflowChangedEvent,
  SwarmWorkflowResult,
  SwarmWorkflowView,
} from '@shared/cowork/swarm-workflow';
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { isSwarmWorkflowActive, useSwarmWorkflowActivity } from './useSwarmWorkflowActivity';
import { useSwarmWorkflowDiscovery } from './useSwarmWorkflowDiscovery';

const available = { enabled: true, disabledRevision: 0 };
const flow = (status: SwarmWorkflowView['status'] = 'running'): SwarmWorkflowView => ({
  id: 'flow',
  revision: 1,
  goal: 'Task',
  createdAt: 1,
  status,
  nodes: [],
});
const success = (status: SwarmWorkflowView['status'] = 'running'): SwarmWorkflowResult => ({
  success: true,
  flows: [flow(status)],
  running: status === 'running' || status === 'stopping',
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const listeners = new Set<(event: SwarmWorkflowChangedEvent) => void>();
  const read = vi
    .fn<(sessionId: string) => Promise<SwarmWorkflowResult>>()
    .mockResolvedValue(success());
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSwarmWorkflows: read,
        onSwarmWorkflowsChanged: (listener: (event: SwarmWorkflowChangedEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  const change = async (sessionId?: string, revision = 2) =>
    act(async () => {
      for (const listener of listeners)
        listener(sessionId ? { sessionId, flowId: 'flow', revision } : {});
      await vi.advanceTimersByTimeAsync(50);
    });
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  return { read, listeners, change, flush };
}

test('shares the selected native observation and still honors manual refresh', async () => {
  const { read, listeners, flush } = fixture();
  const sidebar = renderHook(() => useSwarmWorkflowActivity(['A', 'temp-new'], available));
  const chat = renderHook(() => useSwarmWorkflowDiscovery('A', undefined, available));
  await flush();
  expect(read).toHaveBeenCalledExactlyOnceWith('A');
  expect(listeners.size).toBe(1);
  expect(sidebar.result.current.A).toBe(true);
  expect(chat.result.current.running).toBe(true);
  read.mockResolvedValue(success('completed'));
  await act(async () => {
    chat.result.current.refresh();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(sidebar.result.current.A).toBe(false);
  expect(chat.result.current.running).toBe(false);
  chat.unmount();
  expect(listeners.size).toBe(1);
  sidebar.unmount();
  expect(listeners.size).toBe(0);
});

test('restores observation after StrictMode effect cleanup and releases it on unmount', async () => {
  const { read, listeners, flush } = fixture();
  const hook = renderHook(() => useSwarmWorkflowActivity(['A'], available), {
    wrapper: StrictMode,
  });
  await flush();
  expect(hook.result.current.A).toBe(true);
  expect(listeners.size).toBe(1);
  const reads = read.mock.calls.length;
  hook.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(listeners.size).toBe(0);
  expect(read).toHaveBeenCalledTimes(reads);
});

test('keeps background activity through read failure and clears it on native completion', async () => {
  const { read, change, flush } = fixture();
  read.mockImplementation(async id => (id === 'B' ? success('completed') : success()));
  const hook = renderHook(() => useSwarmWorkflowActivity(['A', 'B'], available));
  await flush();
  expect(hook.result.current).toEqual({ A: true, B: false });
  read.mockResolvedValue({ success: false });
  await change('A');
  expect(hook.result.current.A).toBe(true);
  read.mockResolvedValue(success('completed'));
  await change('A', 3);
  expect(hook.result.current.A).toBe(false);
});

test('uses all-history activity even when the visible recent flows are idle', async () => {
  const { read, change, flush } = fixture();
  read.mockResolvedValue({ success: true, flows: [flow('completed')], running: true });
  const hook = renderHook(() => useSwarmWorkflowActivity(['A'], available));
  await flush();
  expect(hook.result.current.A).toBe(true);
  // An older runtime without the aggregate cannot disprove the prior activity.
  read.mockResolvedValue({ success: true, flows: [flow('completed')] });
  await change('A');
  expect(hook.result.current.A).toBe(true);
  read.mockResolvedValue({ success: true, flows: [flow('completed')], running: false });
  await change('A', 3);
  expect(hook.result.current.A).toBe(false);
});

test('adding a conversation retains existing observations without rereading its history', async () => {
  const { read, flush } = fixture();
  const hook = renderHook(({ ids }) => useSwarmWorkflowActivity(ids, available), {
    initialProps: { ids: ['A'] },
  });
  await flush();
  hook.rerender({ ids: ['B', 'A'] });
  await flush();
  expect(read.mock.calls).toEqual([['A'], ['B']]);
  hook.rerender({ ids: ['A', 'B'] });
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
});

test('revalidates an older background snapshot when its chat is opened', async () => {
  const { read, flush } = fixture();
  const sidebar = renderHook(() => useSwarmWorkflowActivity(['A'], available));
  await flush();
  read.mockResolvedValue(success('completed'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  const chat = renderHook(() => useSwarmWorkflowDiscovery('A', undefined, available));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(sidebar.result.current.A).toBe(false);
  expect(chat.result.current.running).toBe(false);
});

test('retire late reads after removing a conversation or disabling the plugin', async () => {
  const { read, flush } = fixture();
  let finish!: (value: SwarmWorkflowResult) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const hook = renderHook(({ ids, availability }) => useSwarmWorkflowActivity(ids, availability), {
    initialProps: { ids: ['A'], availability: available },
  });
  hook.rerender({ ids: ['B'], availability: available });
  await flush();
  await act(async () => finish(success()));
  expect(hook.result.current).toEqual({ B: true });
  hook.rerender({ ids: ['B'], availability: { enabled: false, disabledRevision: 1 } });
  expect(hook.result.current).toEqual({ B: true });
  read.mockResolvedValue(success('completed'));
  hook.rerender({ ids: ['B'], availability: { enabled: true, disabledRevision: 1 } });
  await flush();
  expect(hook.result.current).toEqual({ B: false });
});

test('a batched disable-enable cannot reuse an older observation kept by another consumer', async () => {
  const { read, flush } = fixture();
  const sidebar = renderHook(({ availability }) => useSwarmWorkflowActivity(['A'], availability), {
    initialProps: { availability: available },
  });
  const chat = renderHook(() => useSwarmWorkflowDiscovery('A', undefined, available));
  await flush();
  read.mockResolvedValue(success('completed'));
  sidebar.rerender({ availability: { enabled: true, disabledRevision: 1 } });
  expect(sidebar.result.current.A).toBe(true);
  await flush();
  expect(sidebar.result.current.A).toBe(false);
  expect(chat.result.current.running).toBe(true);
});

test.each(['paused', 'blocked'] as const)(
  'keeps %s workflows active until existing workers settle',
  status => {
    const paused = flow(status);
    expect(isSwarmWorkflowActive(paused)).toBe(false);
    paused.nodes = [
      {
        id: 'worker',
        title: 'Worker',
        deps: [],
        kind: 'work',
        status: 'running',
        sessionKey: 'native-worker',
      },
    ];
    expect(isSwarmWorkflowActive(paused)).toBe(true);
    paused.nodes[0].status = 'done';
    expect(isSwarmWorkflowActive(paused)).toBe(false);
  },
);

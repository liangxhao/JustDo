// @vitest-environment jsdom
import type { SwarmWorkflowChangedEvent } from '@shared/cowork/swarm-workflow';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSwarmWorkflowDiscovery } from './useSwarmWorkflowDiscovery';

let notify: (event: SwarmWorkflowChangedEvent) => void = () => {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const flow = (id: string, status = 'running') => ({ id, revision: 1, status, nodes: [] });
function fixture() {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ success: true, flows: [] });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSwarmWorkflows: read,
        onSwarmWorkflowsChanged: (callback: typeof notify) => {
          notify = callback;
          return () => {
            notify = () => {};
          };
        },
      },
    },
  });
  const open = vi.fn();
  return { read, open };
}
const tick = () =>
  act(async () => {
    notify({});
    await vi.advanceTimersByTimeAsync(50);
  });

test('clears the projection and stops polling after disable, then reads retained flows on enable', async () => {
  const { read, open } = fixture();
  read.mockResolvedValue({ success: true, flows: [flow('retained', 'completed')] });
  const hook = renderHook(
    ({ enabled, disabledRevision }) =>
      useSwarmWorkflowDiscovery('chat', open, { enabled, disabledRevision }),
    {
      initialProps: { enabled: true, disabledRevision: 0 },
    },
  );
  await tick();
  expect(hook.result.current.count).toBe(1);
  hook.rerender({ enabled: false, disabledRevision: 1 });
  expect(hook.result.current.count).toBe(0);
  expect(hook.result.current.hasFlows).toBe(false);
  expect(hook.result.current.running).toBe(false);
  const calls = read.mock.calls.length;
  await tick();
  expect(read).toHaveBeenCalledTimes(calls);
  hook.rerender({ enabled: true, disabledRevision: 1 });
  await tick();
  expect(hook.result.current.count).toBe(1);
  expect(open).not.toHaveBeenCalled();
});

test('retire old responses and snapshots across a rapid disable-enable revision', async () => {
  const { read, open } = fixture();
  let resolve!: (result: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const hook = renderHook(
    ({ disabledRevision }) =>
      useSwarmWorkflowDiscovery('chat', open, { enabled: true, disabledRevision }),
    {
      initialProps: { disabledRevision: 0 },
    },
  );
  hook.rerender({ disabledRevision: 1 });
  await act(async () => resolve({ success: true, flows: [flow('retired')] }));
  expect(hook.result.current.count).toBe(0);
  expect(hook.result.current.hasFlows).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

test('opens only after a flow exists and does not reopen the same flow after the Tab is closed', async () => {
  const { read, open } = fixture();
  const hook = renderHook(() => useSwarmWorkflowDiscovery('chat', open));
  await tick();
  expect(open).not.toHaveBeenCalled();
  expect(hook.result.current.hasFlows).toBe(false);
  read.mockResolvedValue({ success: true, flows: [flow('one')] });
  await tick();
  expect(open).toHaveBeenCalledTimes(1);
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.hasFlows).toBe(true);
  expect(hook.result.current.count).toBe(1);
  await tick();
  expect(open).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ success: true, flows: [flow('two'), flow('one', 'completed')] });
  await tick();
  expect(open).toHaveBeenCalledTimes(2);
  expect(hook.result.current.count).toBe(2);
});

test('does not open completed history on initial load, but restores an active flow', async () => {
  const { read, open } = fixture();
  read.mockResolvedValue({ success: true, flows: [flow('old', 'completed')] });
  const hook = renderHook(({ id }) => useSwarmWorkflowDiscovery(id, open), {
    initialProps: { id: 'old-chat' },
  });
  await tick();
  expect(open).not.toHaveBeenCalled();
  expect(hook.result.current.hasFlows).toBe(true);
  read.mockResolvedValue({ success: true, flows: [flow('active', 'paused')] });
  hook.rerender({ id: 'active-chat' });
  await tick();
  expect(open).toHaveBeenCalledTimes(1);
  expect(hook.result.current.running).toBe(false);
});

test('ignores a late response from a different chat', async () => {
  const { read, open } = fixture();
  let resolve!: (result: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const hook = renderHook(({ id }) => useSwarmWorkflowDiscovery(id, open), {
    initialProps: { id: 'first' },
  });
  hook.rerender({ id: 'second' });
  await act(async () => resolve({ success: true, flows: [flow('late')] }));
  expect(open).not.toHaveBeenCalled();
  expect(hook.result.current.result).toEqual({ success: true, flows: [] });
});

test('does not invent a flow on failure and stops polling after unmount', async () => {
  const { read, open } = fixture();
  read.mockRejectedValue(new Error('offline'));
  const hook = renderHook(() => useSwarmWorkflowDiscovery('chat', open));
  await tick();
  expect(open).not.toHaveBeenCalled();
  expect(hook.result.current.result.success).toBe(false);
  expect(hook.result.current.hasFlows).toBe(false);
  hook.unmount();
  const count = read.mock.calls.length;
  await tick();
  expect(read).toHaveBeenCalledTimes(count);
});

test('keeps the reopen entry on a temporary failure but never carries it into another chat', async () => {
  const { read, open } = fixture();
  read.mockResolvedValue({ success: true, flows: [flow('one', 'completed')] });
  const hook = renderHook(({ id }) => useSwarmWorkflowDiscovery(id, open), {
    initialProps: { id: 'first' },
  });
  await tick();
  read.mockRejectedValue(new Error('offline'));
  await tick();
  expect(hook.result.current.hasFlows).toBe(true);
  expect(hook.result.current.count).toBe(1);
  hook.rerender({ id: 'second' });
  expect(hook.result.current.hasFlows).toBe(false);
  expect(hook.result.current.count).toBe(0);
  await tick();
  expect(hook.result.current.hasFlows).toBe(false);
});

test('does not query on elapsed time, filters other chats, and coalesces revision notices', async () => {
  const { read, open } = fixture();
  const hook = renderHook(() => useSwarmWorkflowDiscovery('chat', open));
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    notify({ sessionId: 'other', flowId: 'one', revision: 1 });
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ success: true, flows: [{ ...flow('one'), revision: 2 }] });
  await act(async () => {
    notify({ sessionId: 'chat', flowId: 'one', revision: 1 });
    notify({ sessionId: 'chat', flowId: 'one', revision: 2 });
    notify({ sessionId: 'chat', flowId: 'one', revision: 2 });
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(hook.result.current.count).toBe(1);
  await act(async () => {
    notify({ sessionId: 'chat', flowId: 'one', revision: 1 });
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(2);
});

test('catches up a change during the initial read and rejects its stale response', async () => {
  const { read, open } = fixture();
  let resolve!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const hook = renderHook(() => useSwarmWorkflowDiscovery('chat', open));
  await act(async () => {
    notify({ sessionId: 'chat', flowId: 'new', revision: 1 });
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ success: true, flows: [flow('new')] });
  await act(async () => resolve({ success: true, flows: [flow('stale')] }));
  expect(hook.result.current.count).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(hook.result.current.count).toBe(1);
  expect(open).toHaveBeenCalledTimes(1);
});

test('recovers after a disconnected read when a reconnect notice arrives', async () => {
  const { read, open } = fixture();
  read.mockResolvedValueOnce({ success: false });
  const hook = renderHook(() => useSwarmWorkflowDiscovery('chat', open));
  await act(async () => {});
  expect(hook.result.current.result.success).toBe(false);
  read.mockResolvedValue({ success: true, flows: [flow('retained', 'completed')] });
  await tick();
  expect(hook.result.current.count).toBe(1);
  hook.unmount();
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
});

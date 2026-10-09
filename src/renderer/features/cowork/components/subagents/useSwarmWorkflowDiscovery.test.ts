// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSwarmWorkflowDiscovery } from './useSwarmWorkflowDiscovery';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const flow = (id: string, status = 'running') => ({ id, status, nodes: [] });
function fixture() {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ success: true, flows: [] });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { getSwarmWorkflows: read } },
  });
  const open = vi.fn();
  return { read, open };
}
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
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
  await tick();
  expect(open).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ success: true, flows: [flow('two'), flow('one', 'completed')] });
  await tick();
  expect(open).toHaveBeenCalledTimes(2);
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
  hook.rerender({ id: 'second' });
  expect(hook.result.current.hasFlows).toBe(false);
  await tick();
  expect(hook.result.current.hasFlows).toBe(false);
});

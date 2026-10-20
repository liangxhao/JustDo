// @vitest-environment jsdom
import type { SwarmWorkflowChangedEvent } from '../contracts/index';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSwarmWorkflowDiscovery } from './useSwarmWorkflowDiscovery';

const available = { enabled: true, disabledRevision: 0 };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const listeners = new Set<(event: SwarmWorkflowChangedEvent) => void>();
  const read = vi.fn().mockResolvedValue({ success: true, count: 21, running: false });
  const list = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSwarmWorkflowSummary: read,
        getSwarmWorkflows: list,
        onSwarmWorkflowsChanged: (listener: (event: SwarmWorkflowChangedEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  const change = async (event: SwarmWorkflowChangedEvent = {}) => {
    act(() => listeners.forEach(listener => listener(event)));
    await flush();
  };
  return { read, list, listeners, flush, change };
}
test('loads only summary metadata on open and releases observation on close', async () => {
  const { read, list, flush, change } = fixture();
  const hook = renderHook(
    ({ open }) => useSwarmWorkflowDiscovery('A', undefined, available, open),
    {
      initialProps: { open: false },
    },
  );
  await flush();
  expect(read).not.toHaveBeenCalled();
  hook.rerender({ open: true });
  await flush();
  expect(read).toHaveBeenCalledExactlyOnceWith('A');
  expect(hook.result.current.count).toBe(21);
  expect(list).not.toHaveBeenCalled();
  hook.rerender({ open: false });
  await change();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(read).toHaveBeenCalledTimes(1);
  hook.rerender({ open: true });
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
});
test('filters other chats and duplicate revisions without interval polling', async () => {
  const { read, flush, change } = fixture();
  renderHook(() => useSwarmWorkflowDiscovery('A', undefined, available, true));
  await flush();
  await change({ sessionId: 'B', flowId: 'flow', revision: 1 });
  expect(read).toHaveBeenCalledTimes(1);
  await change({ sessionId: 'A', flowId: 'flow', revision: 2 });
  expect(read).toHaveBeenCalledTimes(2);
  await change({ sessionId: 'A', flowId: 'flow', revision: 2 });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(read).toHaveBeenCalledTimes(2);
});
test('preserves count on failure, rejects old chat responses and recovers on reset', async () => {
  const { read, flush, change } = fixture();
  const hook = renderHook(({ id }) => useSwarmWorkflowDiscovery(id, undefined, available, true), {
    initialProps: { id: 'A' },
  });
  await flush();
  read.mockResolvedValue({ success: false });
  await change();
  expect(hook.result.current.count).toBe(21);
  expect(hook.result.current.result.success).toBe(false);
  let finish!: (result: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  hook.rerender({ id: 'B' });
  expect(hook.result.current.count).toBe(0);
  hook.rerender({ id: 'C' });
  await act(async () => finish({ success: true, count: 100, running: true }));
  expect(hook.result.current.count).toBe(0);
  read.mockResolvedValue({ success: true, count: 1, running: false });
  await change();
  expect(hook.result.current.count).toBe(1);
});
test('disabling and reenabling cannot reuse an older generation', async () => {
  const { read, flush } = fixture();
  const hook = renderHook(
    ({ enabled, disabledRevision }) =>
      useSwarmWorkflowDiscovery('A', undefined, { enabled, disabledRevision }, true),
    {
      initialProps: available,
    },
  );
  await flush();
  hook.rerender({ enabled: false, disabledRevision: 1 });
  expect(hook.result.current.count).toBe(0);
  read.mockResolvedValue({ success: true, count: 1, running: true });
  hook.rerender({ enabled: true, disabledRevision: 1 });
  await flush();
  expect(hook.result.current.count).toBe(1);
});

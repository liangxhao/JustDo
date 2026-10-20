// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import type { SwarmWorkflowChangedEvent } from '../../contracts/events';
import type { SwarmWorkflowResult, SwarmWorkflowView } from '../../contracts/workflow';
import { isSwarmWorkflowActive, useSwarmWorkflowActivity } from './useSwarmWorkflowActivity';
import { useSwarmWorkflowDiscovery } from './useSwarmWorkflowDiscovery';

const available = { enabled: true, disabledRevision: 0 };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const listeners = new Set<(event: SwarmWorkflowChangedEvent) => void>();
  const activity = vi.fn().mockResolvedValue({ success: true, sessionIds: ['A'] });
  const summary = vi.fn().mockResolvedValue({ success: true, count: 2, running: true });
  const list = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSwarmWorkflowActivity: activity,
        getSwarmWorkflowSummary: summary,
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
  return { activity, summary, list, listeners, flush, change };
}
test('reads one compact snapshot for a thousand chats and never loads their full lists', async () => {
  const { activity, summary, list, flush } = fixture();
  const ids = ['A', ...Array.from({ length: 1000 }, (_, index) => 'chat-' + index), 'temp-new'];
  const sidebar = renderHook(({ ids }) => useSwarmWorkflowActivity(ids, available), {
    initialProps: { ids },
  });
  const chat = renderHook(() => useSwarmWorkflowDiscovery('A', undefined, available));
  await flush();
  expect(activity).toHaveBeenCalledTimes(1);
  expect(summary).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(sidebar.result.current.A).toBe(true);
  expect(sidebar.result.current['temp-new']).toBeUndefined();
  expect(chat.result.current.count).toBe(0);
  sidebar.rerender({ ids: [...ids, 'new-chat'] });
  await flush();
  expect(activity).toHaveBeenCalledTimes(1);
});

test('publishes only complete successful native snapshots and preserves uncertainty after re-enable', async () => {
  const { activity, flush, change } = fixture();
  const publish = vi.fn();
  activity.mockResolvedValue({ success: false });
  const hook = renderHook(({ availability }) => useSwarmWorkflowActivity(['A'], availability, publish), {
    initialProps: { availability: available },
  });
  expect(publish).not.toHaveBeenCalled();
  await flush();
  expect(publish).not.toHaveBeenCalled();
  activity.mockResolvedValue({ success: true, sessionIds: ['A'] });
  await change();
  expect(publish).toHaveBeenLastCalledWith(['A']);
  hook.rerender({ availability: { enabled: false, disabledRevision: 1 } });
  const published = publish.mock.calls.length;
  activity.mockResolvedValue({ success: false });
  hook.rerender({ availability: { enabled: true, disabledRevision: 1 } });
  await flush();
  expect(publish).toHaveBeenCalledTimes(published);
  activity.mockResolvedValue({ success: true, sessionIds: [] });
  await change();
  expect(publish).toHaveBeenLastCalledWith([]);
});
test('publishes a complete activity snapshot even when a running source is outside the visible summaries', async () => {
  const { activity, flush } = fixture();
  const publish = vi.fn();
  activity.mockResolvedValue({ success: true, sessionIds: ['directory-only-source'] });
  const hook = renderHook(() => useSwarmWorkflowActivity(['visible-summary'], available, publish));
  await flush();
  expect(publish).toHaveBeenCalledExactlyOnceWith(['directory-only-source']);
  expect(hook.result.current).toEqual({ 'visible-summary': false });
  expect(activity).toHaveBeenCalledOnce();
});
test('updates background activity on changes and preserves it across read failures and disable', async () => {
  const { activity, change, flush } = fixture();
  const hook = renderHook(({ availability }) => useSwarmWorkflowActivity(['A'], availability), {
    initialProps: { availability: available },
  });
  await flush();
  activity.mockResolvedValue({ success: false });
  await change({ sessionId: 'A', flowId: 'flow', revision: 1 });
  expect(hook.result.current.A).toBe(true);
  hook.rerender({ availability: { enabled: false, disabledRevision: 1 } });
  const reads = activity.mock.calls.length;
  await change();
  expect(activity).toHaveBeenCalledTimes(reads);
  expect(hook.result.current.A).toBe(true);
  activity.mockResolvedValue({ success: true, sessionIds: [] });
  hook.rerender({ availability: { enabled: true, disabledRevision: 1 } });
  await flush();
  expect(hook.result.current.A).toBe(false);
});
test('discards a snapshot invalidated during its read and resynchronizes after reconnect', async () => {
  const { activity, change, flush } = fixture();
  let finish!: (result: unknown) => void;
  activity.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const hook = renderHook(() => useSwarmWorkflowActivity(['A'], available));
  await change();
  activity.mockResolvedValue({ success: true, sessionIds: [] });
  await act(async () => finish({ success: true, sessionIds: ['A'] }));
  expect(hook.result.current.A).toBe(false);
  await flush();
  expect(activity).toHaveBeenCalledTimes(2);
  activity.mockResolvedValue({ success: true, sessionIds: ['A'] });
  await change();
  expect(hook.result.current.A).toBe(true);
});
test('restores StrictMode observation and stops reading after unmount', async () => {
  const { activity, listeners, flush } = fixture();
  const hook = renderHook(() => useSwarmWorkflowActivity(['A'], available), {
    wrapper: StrictMode,
  });
  await flush();
  expect(hook.result.current.A).toBe(true);
  expect(listeners.size).toBe(1);
  hook.unmount();
  const reads = activity.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(activity).toHaveBeenCalledTimes(reads);
  expect(listeners.size).toBe(0);
});

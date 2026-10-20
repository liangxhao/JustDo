import { afterEach, expect, test, vi } from 'vitest';

import { observeWorkflows } from '../../browser/observe';
import type { SwarmWorkflowChangedEvent } from '../../contracts/events';
import type { SwarmWorkflowResult } from '../../contracts/workflow';

const idle: SwarmWorkflowResult = { success: true, flows: [], running: false };
const active: SwarmWorkflowResult = { success: true, flows: [], running: true };
afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const listeners = new Set<(event: SwarmWorkflowChangedEvent) => void>();
  const api = {
    getSwarmWorkflows: vi
      .fn<(sessionId: string) => Promise<SwarmWorkflowResult>>()
      .mockResolvedValue(idle),
    onSwarmWorkflowsChanged: vi.fn((listener: (event: SwarmWorkflowChangedEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  return {
    api,
    listeners,
    notify: (event: SwarmWorkflowChangedEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test('shares one event listener and bounds reads across a large sidebar and global reset', async () => {
  const { api, listeners, notify } = fixture();
  let inFlight = 0;
  let peak = 0;
  api.getSwarmWorkflows.mockImplementation(async () => {
    peak = Math.max(peak, ++inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return idle;
  });
  const stop = Array.from({ length: 250 }, (_, id) => observeWorkflows(api, String(id), () => {}));
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(250);
  expect(listeners.size).toBe(1);
  expect(api.onSwarmWorkflowsChanged).toHaveBeenCalledOnce();
  notify({});
  await vi.advanceTimersByTimeAsync(50);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(500);
  expect(peak).toBeLessThanOrEqual(4);
  stop.forEach(dispose => dispose());
  expect(listeners.size).toBe(0);
});

test('drops queued reads when their last subscriber leaves', async () => {
  const { api, listeners } = fixture();
  const finish: Array<(value: SwarmWorkflowResult) => void> = [];
  api.getSwarmWorkflows.mockImplementation(
    () =>
      new Promise(resolve => {
        finish.push(resolve);
      }),
  );
  const stop = Array.from({ length: 20 }, (_, id) => observeWorkflows(api, String(id), () => {}));
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(4);
  stop.forEach(dispose => dispose());
  finish.forEach(resolve => resolve(idle));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(4);
  expect(listeners.size).toBe(0);
});

test('keeps retired in-flight reads in the window concurrency budget after rapid remount', async () => {
  const { api } = fixture();
  const finish: Array<(value: SwarmWorkflowResult) => void> = [];
  api.getSwarmWorkflows.mockImplementation(
    () =>
      new Promise(resolve => {
        finish.push(resolve);
      }),
  );
  const old = Array.from({ length: 8 }, (_, id) => observeWorkflows(api, `old-${id}`, () => {}));
  old.forEach(stop => stop());
  const current = Array.from({ length: 8 }, (_, id) =>
    observeWorkflows(api, `new-${id}`, () => {}),
  );
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(4);
  finish.splice(0).forEach(resolve => resolve(idle));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(8);
  current.forEach(stop => stop());
  finish.splice(0).forEach(resolve => resolve(idle));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(8);
});

test('replays the last successful projection as stale and revalidates a failed snapshot for new subscribers', async () => {
  const { api, notify } = fixture();
  api.getSwarmWorkflows.mockResolvedValueOnce(active).mockResolvedValueOnce({ success: false });
  const receive = vi.fn();
  const stop = observeWorkflows(api, 'chat', receive);
  await vi.advanceTimersByTimeAsync(0);
  notify({ sessionId: 'chat', flowId: 'flow', revision: 2 });
  await vi.advanceTimersByTimeAsync(50);
  expect(receive).toHaveBeenLastCalledWith({ success: false });
  let finish!: (value: SwarmWorkflowResult) => void;
  api.getSwarmWorkflows.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const receiveNew = vi.fn();
  const stopNew = observeWorkflows(api, 'chat', receiveNew);
  expect(receiveNew.mock.calls.map(([result]) => result)).toEqual([active, { success: false }]);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(3);
  finish(idle);
  await vi.advanceTimersByTimeAsync(0);
  expect(receiveNew).toHaveBeenLastCalledWith(idle);
  stopNew();
  stop();
});

test('recovers from a transient failure even if the same revision notification is deduplicated', async () => {
  const { api, notify } = fixture();
  api.getSwarmWorkflows
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce({ success: false })
    .mockResolvedValue(idle);
  const receive = vi.fn();
  const stop = observeWorkflows(api, 'chat', receive);
  await vi.advanceTimersByTimeAsync(0);
  const event = { sessionId: 'chat', flowId: 'flow', revision: 2 };
  notify(event);
  await vi.advanceTimersByTimeAsync(50);
  notify(event);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(3);
  expect(receive).toHaveBeenLastCalledWith(idle);
  stop();
});

test('bounds failed-read retries and cancels them after unmount', async () => {
  const { api } = fixture();
  api.getSwarmWorkflows.mockResolvedValue({ success: false });
  const stop = observeWorkflows(api, 'chat', () => {});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(4);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.getSwarmWorkflows).toHaveBeenCalledTimes(4);
});

import { afterEach, expect, test, vi } from 'vitest';

import { observeDeferredInventoryRefresh } from './deferredInventoryRefresh';

const engine = vi.hoisted(() => ({ ready: true, listeners: new Set<() => void>() }));
vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  getEngineReadinessSnapshot: () => ({ ready: engine.ready }),
  subscribeEngineReadiness: (listener: () => void) => {
    engine.listeners.add(listener);
    return () => engine.listeners.delete(listener);
  },
}));
afterEach(() => {
  engine.ready = true;
  engine.listeners.clear();
});

test('coalesces background changes during preparation and refreshes on recovery without mutations', () => {
  const read = vi.fn();
  const refresh = observeDeferredInventoryRefresh(read);
  refresh.request();
  expect(read).toHaveBeenCalledOnce();
  engine.ready = false;
  engine.listeners.forEach(listener => listener());
  refresh.request();
  refresh.request();
  expect(read).toHaveBeenCalledOnce();
  engine.ready = true;
  engine.listeners.forEach(listener => listener());
  expect(read).toHaveBeenCalledTimes(2);
  refresh.dispose();
  expect(engine.listeners.size).toBe(0);
  refresh.request();
  expect(read).toHaveBeenCalledTimes(2);
});

// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import type { AppBrowserHost } from '../../../../../plugins/sdk/app-plugin-sdk/browser';
import type { AppPluginSnapshot } from '../../../../../plugins/sdk/app-plugin-sdk/contracts';
import { AppBrowserRegistry } from './browserRegistry';

const snapshot = (id = 'fixture', epoch = 'first'): AppPluginSnapshot => ({
  id,
  version: '1.0.0',
  hash: 'a'.repeat(64),
  epoch,
  state: 'active',
  browserEntry: `/assets/app-plugins/${'a'.repeat(64)}/${epoch}/browser.mjs`,
  slots: ['plugin.settings'],
  commands: [],
});
const services = {
  t: (key: string) => key,
  translations: () => () => undefined,
  components: {},
  renderHistory: () => null,
};
const bridge = {
  snapshot: async () => [],
  invoke: vi.fn(async () => undefined),
  onChanged: () => () => undefined,
};
const registries: AppBrowserRegistry[] = [];
afterEach(() => {
  registries.splice(0).forEach(registry => registry.dispose());
  vi.useRealTimers();
});

test('registration failure rolls back scoped listeners, timers and pending tasks', async () => {
  vi.useFakeTimers();
  const target = new EventTarget();
  const callback = vi.fn();
  const released = vi.fn();
  let host!: AppBrowserHost;
  const registry = new AppBrowserRegistry(bridge, services, async () => ({
    register(value) {
      host = value;
      value.resources.defer(released);
      value.resources.listen(target, 'change', callback);
      value.resources.setInterval(callback, 2);
      value.resources.run(callback);
      throw new Error('broken registration');
    },
  }));
  registries.push(registry);
  await registry.update([snapshot()]);
  target.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(5);
  expect(host.signal.aborted).toBe(true);
  expect(host.resources.signal.aborted).toBe(true);
  expect(callback).not.toHaveBeenCalled();
  expect(released).toHaveBeenCalledOnce();
  expect(registry.isBusinessCurrent('fixture')).toBe(false);
});

test('closing and reopening a plugin retires only its own scope and starts a fresh epoch', async () => {
  vi.useFakeTimers();
  const hosts: AppBrowserHost[] = [];
  const callbacks = new Map<string, ReturnType<typeof vi.fn>>();
  const registry = new AppBrowserRegistry(bridge, services, async () => ({
    register(host) {
      hosts.push(host);
      const key = host.plugin.id + ':' + host.plugin.epoch;
      const callback = vi.fn();
      callbacks.set(key, callback);
      host.resources.setInterval(callback, 2);
    },
  }));
  registries.push(registry);
  await registry.update([snapshot('a'), snapshot('b')]);
  await vi.advanceTimersByTimeAsync(2);
  await registry.update([snapshot('b')]);
  expect(hosts[0].resources.signal.aborted).toBe(true);
  expect(hosts[1].resources.signal.aborted).toBe(false);
  await registry.update([snapshot('a', 'second'), snapshot('b')]);
  await vi.advanceTimersByTimeAsync(2);
  expect(callbacks.get('a:first')).toHaveBeenCalledTimes(1);
  expect(callbacks.get('b:first')).toHaveBeenCalledTimes(2);
  expect(callbacks.get('a:second')).toHaveBeenCalledTimes(1);
  expect(hosts[0].resources.signal.aborted).toBe(true);
});

test('a task resolving after its plugin closes cannot deliver a result into the reopened instance', async () => {
  let finish!: (result: string) => void;
  const pending = new Promise<string>(resolve => {
    finish = resolve;
  });
  const delivered = vi.fn();
  const signals: AbortSignal[] = [];
  const registry = new AppBrowserRegistry(bridge, services, async () => ({
    register(host) {
      host.resources.run(
        signal => {
          signals.push(signal);
          return host.plugin.epoch === 'first' ? pending : Promise.resolve('current');
        },
        value => delivered(host.plugin.epoch, value),
      );
    },
  }));
  registries.push(registry);
  await registry.update([snapshot()]);
  await registry.update([]);
  await registry.update([snapshot('fixture', 'second')]);
  finish('stale');
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('second', 'current'));
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(signals[0].aborted).toBe(true);
});

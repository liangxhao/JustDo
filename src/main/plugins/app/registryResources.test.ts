import { afterEach, expect, test, vi } from 'vitest';

import type { AppMainHost, AppMainRegistration } from '../../../../plugins/sdk/app-plugin-sdk/main';
import type { AppResourceScope } from '../../../../plugins/sdk/app-plugin-sdk/resources';
import type { VerifiedAppArtifact } from './artifact';
import { type AppHostResources, AppPluginRegistry } from './registry';

const binding = {
  pluginId: 'fixture',
  registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  processId: 123,
  gatewayMethods: [],
};
const artifact: VerifiedAppArtifact = {
  root: 'C:/fixture',
  artifact: {
    hash: 'a'.repeat(64),
    files: {},
    manifest: {
      manifestVersion: 1,
      apiVersion: 1,
      id: 'fixture',
      nativePluginId: 'fixture',
      version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [],
      commands: [],
      slots: [],
    },
  },
};
const registries: AppPluginRegistry[] = [];
afterEach(() => {
  registries.splice(0).forEach(registry => registry.dispose());
  vi.useRealTimers();
});
async function setup(
  register: (host: AppMainHost) => AppMainRegistration,
  ports = {} as AppHostResources,
) {
  let enabled = true;
  const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
  registries.push(registry);
  await registry.prepare(artifact, ports, async () => ({ register }));
  registry.activate();
  return {
    registry,
    enable(value: boolean) {
      enabled = value;
      registry.refresh();
    },
  };
}

test('business resources retire on disable while the retained Main instance remains alive', async () => {
  vi.useFakeTimers();
  let retained!: AppMainHost;
  const scopes: AppResourceScope[] = [];
  const callbacks: ReturnType<typeof vi.fn>[] = [];
  const disposed = vi.fn();
  const harness = await setup(host => {
    retained = host;
    return {
      commands: [],
      onEnable(resources) {
        scopes.push(resources);
        const callback = vi.fn();
        callbacks.push(callback);
        resources.setInterval(callback, 2);
        return disposed;
      },
    };
  });
  await vi.advanceTimersByTimeAsync(2);
  harness.enable(false);
  expect(retained.signal.aborted).toBe(false);
  expect(scopes[0].signal.aborted).toBe(true);
  expect(disposed).toHaveBeenCalledOnce();
  harness.enable(true);
  await vi.advanceTimersByTimeAsync(2);
  expect(scopes[1]).not.toBe(scopes[0]);
  expect(scopes[0].signal.aborted).toBe(true);
  expect(callbacks[0]).toHaveBeenCalledTimes(1);
  expect(callbacks[1]).toHaveBeenCalledTimes(1);
  harness.registry.dispose();
  expect(scopes[1].signal.aborted).toBe(true);
  expect(disposed).toHaveBeenCalledTimes(2);
});

test('failed onEnable immediately rolls back resources and never starts queued work', async () => {
  vi.useFakeTimers();
  const off = vi.fn();
  const callback = vi.fn();
  const harness = await setup(() => ({
    commands: [],
    onEnable(resources) {
      resources.defer(off);
      resources.setInterval(callback, 1);
      resources.run(callback);
      throw new Error('failed enable');
    },
  }));
  await vi.advanceTimersByTimeAsync(5);
  expect(off).toHaveBeenCalledOnce();
  expect(callback).not.toHaveBeenCalled();
  expect(harness.registry.snapshot()[0].state).toBe('blocked');
});

test('resource callbacks preserve existing epoch checks instead of inheriting a new business lease', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  const request = vi.fn(async () => ({ ok: true }));
  const errors: unknown[] = [];
  let oldScope!: AppResourceScope;
  const harness = await setup(
    host => ({
      commands: [],
      onEnable(resources) {
        if (oldScope) return;
        oldScope = resources;
        resources.run(async () => {
          await host.requestConnectedGateway('fixture.read', { phase: 'before' });
          await pending;
          try {
            await host.requestConnectedGateway('fixture.read', { phase: 'after' });
          } catch (error) {
            errors.push(error);
          }
        });
      },
    }),
    { requestConnectedGateway: request } as unknown as AppHostResources,
  );
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledExactlyOnceWith('fixture.read', { phase: 'before' }),
  );
  harness.enable(false);
  harness.enable(true);
  finish();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(request).toHaveBeenCalledTimes(1);
  expect(oldScope.signal.aborted).toBe(true);
});

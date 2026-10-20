import { afterEach, expect, it, vi } from 'vitest';

import type { AppMainHost, AppMainRegistration } from '../../../../packages/app-plugin-sdk/main';
import type { VerifiedAppArtifact } from './artifact';
import { type AppHostResources, AppPluginRegistry } from './registry';

const registries: AppPluginRegistry[] = [];
afterEach(() => {
  registries.splice(0).forEach(registry => registry.dispose());
  vi.useRealTimers();
});

const artifact: VerifiedAppArtifact = {
  root: 'C:/maintenance-fixture',
  artifact: {
    manifest: {
      manifestVersion: 1,
      apiVersion: 1,
      id: 'maintenance-fixture',
      nativePluginId: 'maintenance-fixture',
      version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [],
      commands: ['read'],
      slots: [],
    },
    hash: 'a'.repeat(64),
    files: {},
  },
};
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
async function setup(register: (host: AppMainHost) => AppMainRegistration) {
  vi.useFakeTimers();
  const request = vi.fn(async () => ({ state: 'unknown' }));
  const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
  registries.push(registry);
  await registry.prepare(
    artifact,
    {
      requestConnectedGateway: request,
      requestGateway: request,
    } as unknown as AppHostResources,
    async () => ({ register }),
  );
  return { registry, request };
}

it('runs disabled receipt maintenance under fresh cleanup leases and never grants business methods', async () => {
  let effects = 0;
  const denied: Promise<unknown>[] = [];
  const { registry, request } = await setup(host => ({
    commands: [
      {
        id: 'read',
        invoke: () => {
          effects++;
        },
      },
    ],
    cleanupGatewayMethods: ['receipt.status'],
    maintenance: async () => {
      await host.requestConnectedGateway('receipt.status', {});
      denied.push(Promise.resolve().then(() => host.requestGateway('chat.send', {})));
      await expect(denied.at(-1)).rejects.toThrow('appPluginUnavailable');
    },
  }));
  expect(request).not.toHaveBeenCalled();
  registry.activate();
  await flush();
  await vi.advanceTimersByTimeAsync(3000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([method]) => method === 'receipt.status')).toBe(true);
  expect(
    await registry.invoke({
      id: 'maintenance-fixture',
      epoch: registry.snapshot()[0].epoch,
      command: 'read',
      args: [],
    }),
  ).toMatchObject({ success: false });
  expect(effects).toBe(0);
  registry.dispose();
  await vi.advanceTimersByTimeAsync(9000);
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not overlap pending maintenance or allow detached async effects after a tick has returned', async () => {
  let finishRead!: () => void;
  let releaseDetached!: () => void;
  let detached: Promise<unknown> | undefined;
  let entered = 0;
  const read = new Promise<void>(resolve => {
    finishRead = resolve;
  });
  const gate = new Promise<void>(resolve => {
    releaseDetached = resolve;
  });
  const { registry, request } = await setup(host => ({
    commands: [],
    cleanupGatewayMethods: ['receipt.status'],
    maintenance: async () => {
      entered++;
      await read;
      await host.requestConnectedGateway('receipt.status', {});
      detached = gate.then(() => host.requestConnectedGateway('receipt.status', {}));
      void detached.catch(() => undefined);
    },
  }));
  registry.activate();
  await flush();
  await vi.advanceTimersByTimeAsync(9000);
  expect(entered).toBe(1);
  finishRead();
  await flush();
  expect(request).toHaveBeenCalledOnce();
  releaseDetached();
  await expect(detached).rejects.toThrow('appPluginRetired');
  expect(request).toHaveBeenCalledOnce();
});

it('revokes an outstanding maintenance callback when the owning instance is disposed', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const attempted = vi.fn();
  const { registry, request } = await setup(host => ({
    commands: [],
    cleanupGatewayMethods: ['receipt.status'],
    maintenance: async () => {
      await gate;
      attempted();
      await host.requestConnectedGateway('receipt.status', {});
    },
  }));
  registry.activate();
  await flush();
  registry.dispose();
  release();
  await flush();
  expect(attempted).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(9000);
  expect(attempted).toHaveBeenCalledOnce();
});

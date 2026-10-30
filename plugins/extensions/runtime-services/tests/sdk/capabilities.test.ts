import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_EXECUTION_DESCRIPTOR } from '../../sdk/execution';
import { createRuntimeServicesClient } from '../../sdk/native-client';
import { registerRuntimeServicesProvider, RUNTIME_SERVICES_BINDING_METHOD } from '../../sdk/provider';

type Handler = Parameters<Parameters<typeof registerRuntimeServicesProvider>[0]['registerGatewayMethod']>[1];
interface Gateway {
  methods: Map<string, Handler>;
}
const gatewayScope = new AsyncLocalStorage<Gateway>();
const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

function registration(gateway: Gateway, id = 'fixture-consumer') {
  const controller = new AbortController();
  let accepting = true;
  const disposers = new Set<() => void>();
  const request = vi.fn(async <T>(method: string, _params?: Record<string, unknown>, options?: unknown): Promise<T> => {
    expect(options).toEqual({ scopes: ['operator.read'] });
    const handler = gatewayScope.getStore()?.methods.get(method);
    if (!handler) throw new Error('No attached provider');
    let value: unknown;
    let failure: string | undefined;
    await handler({ respond(ok, payload, error) {
      if (ok) value = payload;
      else failure = error?.message ?? 'Request rejected';
    } });
    if (failure) throw new Error(failure);
    return value as T;
  });
  const api = {
    id,
    lifecycle: {
      signal: controller.signal,
      onDispose(cleanup: () => void) {
        disposers.add(cleanup);
        return () => { disposers.delete(cleanup); };
      },
      runInBackgroundContext<T>(run: () => T): T {
        if (!accepting) throw new Error('Registration is quiescing');
        return gatewayScope.run(gateway, run);
      },
    },
    runtime: { gateway: { request } },
    registerGatewayMethod(name: string, handler: Handler) { gateway.methods.set(name, handler); },
  };
  const dispose = () => {
    controller.abort();
    for (const cleanup of disposers) cleanup();
    disposers.clear();
  };
  cleanups.add(dispose);
  return { api, dispose, request, quiesce: () => { accepting = false; }, resume: () => { accepting = true; } };
}
const gateway = (): Gateway => ({ methods: new Map() });
const source = { sessionKey: 'agent:main:example', sessionId: 'native-1' };


describe('Runtime Services ABI2 capability binding', () => {
  it('retries read binding after absence and reads current generic facts', async () => {
    const owner = gateway(); const consumer = registration(owner); const client = createRuntimeServicesClient(consumer.api);
    expect(await client.bind()).toBe(false);
    let generation = 1;
    registerRuntimeServicesProvider(registration(owner, 'runtime-services').api, { readExecutionAdmission: () => ({ state: 'clear', generation }) });
    expect(await client.bind()).toBe(true); const handle = client.captureExecutionAdmission()!;
    expect(handle.readExecutionAdmission(source)).toEqual({ state: 'clear', generation: 1 });
    generation = 2; expect(handle.readExecutionAdmission(source)).toEqual({ state: 'clear', generation: 2 });
    expect(consumer.request).toHaveBeenCalledTimes(2);
  });
  it('pins caller and provider contexts despite a foreign ambient Gateway', async () => {
    const a = gateway(), b = gateway();
    registerRuntimeServicesProvider(registration(a, 'runtime-services').api, { readExecutionAdmission() { expect(gatewayScope.getStore()).toBe(a); return { state: 'clear', generation: 1 }; } });
    registerRuntimeServicesProvider(registration(b, 'runtime-services').api, { readExecutionAdmission() { expect(gatewayScope.getStore()).toBe(b); return { state: 'clear', generation: 2 }; } });
    const clientA = createRuntimeServicesClient(registration(a).api), clientB = createRuntimeServicesClient(registration(b).api);
    expect(await gatewayScope.run(b, () => clientA.bind())).toBe(true); expect(await gatewayScope.run(a, () => clientB.bind())).toBe(true);
    expect(gatewayScope.run(b, () => clientA.captureExecutionAdmission()!.readExecutionAdmission(source))).toEqual({ state: 'clear', generation: 1 });
    expect(gatewayScope.run(a, () => clientB.captureExecutionAdmission()!.readExecutionAdmission(source))).toEqual({ state: 'clear', generation: 2 });
  });
  it('revokes old handles without allowing an old disposer to retire a successor', async () => {
    const owner = gateway(), provider = registration(owner, 'runtime-services');
    const dispose = registerRuntimeServicesProvider(provider.api, { readExecutionAdmission: () => ({ state: 'clear', generation: 1 }) });
    const client = createRuntimeServicesClient(registration(owner).api); expect(await client.bind()).toBe(true);
    const old = client.captureExecutionAdmission()!; provider.dispose();
    expect(old.isCurrent()).toBe(false); expect(old.readExecutionAdmission(source)).toEqual({ state: 'unknown' });
    registerRuntimeServicesProvider(registration(owner, 'runtime-services').api, { readExecutionAdmission: () => ({ state: 'clear', generation: 2 }) });
    dispose(); expect(await client.bind()).toBe(true); expect(client.captureExecutionAdmission()!.readExecutionAdmission(source)).toEqual({ state: 'clear', generation: 2 });
    owner.methods.clear(); expect(await client.bind()).toBe(false); expect(client.captureExecutionAdmission()).toBeUndefined();
  });
  it('rejects old protocol and forged tokens and discards late bindings', async () => {
    const owner = gateway(), consumer = registration(owner), client = createRuntimeServicesClient(consumer.api);
    owner.methods.set(RUNTIME_SERVICES_BINDING_METHOD, ({ respond }) => respond(true, { version: 1, providerToken: '12345678-1234-1234-1234-123456789abc', capabilities: { launchProjection: 1 } }));
    expect(await client.bind()).toBe(false);
    registerRuntimeServicesProvider(registration(owner, 'runtime-services').api, { readExecutionAdmission: () => ({ state: 'clear', generation: 0 }) });
    const handler = owner.methods.get(RUNTIME_SERVICES_BINDING_METHOD)!; let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    owner.methods.set(RUNTIME_SERVICES_BINDING_METHOD, async context => { handler(context); await paused; });
    const pending = client.bind(); consumer.dispose(); release(); expect(await pending).toBe(false);
    expect(client.captureCapabilities()).toBeUndefined();
  });
  it.each(['consumer', 'provider'] as const)('retires a captured handle when its %s quiesces before lifecycle abort', async target => {
    const owner = gateway(), provider = registration(owner, 'runtime-services'), consumer = registration(owner);
    registerRuntimeServicesProvider(provider.api, { readExecutionAdmission: () => ({ state: 'clear', generation: 0 }), managedExecution: MANAGED_EXECUTION_DESCRIPTOR });
    const client = createRuntimeServicesClient(consumer.api); expect(await client.bind()).toBe(true);
    const handle = client.captureExecutionAdmission()!;
    const selectedRegistration = target === 'consumer' ? consumer : provider;
    selectedRegistration.quiesce(); expect(selectedRegistration.api.lifecycle.signal.aborted).toBe(false);
    expect(handle.isCurrent()).toBe(false); expect(client.captureCapabilities()).toBeUndefined();
    expect(handle.readExecutionAdmission(source)).toEqual({ state: 'unknown' });
    expect(handle.getManagedExecutionDescriptor()).toBeUndefined();
    selectedRegistration.resume(); expect(handle.isCurrent()).toBe(false);
  });
  it('discards a late binding after consumer quiescence without waiting for its signal', async () => {
    const owner = gateway(), consumer = registration(owner);
    registerRuntimeServicesProvider(registration(owner, 'runtime-services').api, { readExecutionAdmission: () => ({ state: 'clear', generation: 0 }) });
    const handler = owner.methods.get(RUNTIME_SERVICES_BINDING_METHOD)!;
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
    owner.methods.set(RUNTIME_SERVICES_BINDING_METHOD, async context => { handler(context); await paused; });
    const client = createRuntimeServicesClient(consumer.api); const pending = client.bind();
    consumer.quiesce(); expect(consumer.api.lifecycle.signal.aborted).toBe(false); release();
    expect(await pending).toBe(false); expect(client.captureCapabilities()).toBeUndefined();
    consumer.resume(); expect(await client.bind()).toBe(false);
  });
  it('reports unknown on read failures and requires an explicit managed descriptor', async () => {
    const owner = gateway();
    registerRuntimeServicesProvider(registration(owner, 'runtime-services').api, { readExecutionAdmission() { throw new Error('Unreadable receipt'); } });
    const client = createRuntimeServicesClient(registration(owner).api); expect(await client.bind()).toBe(true);
    expect(client.captureExecutionAdmission()!.readExecutionAdmission(source)).toEqual({ state: 'unknown' });
    expect(client.captureCapabilities()!.getManagedExecutionDescriptor()).toBeUndefined();
    registerRuntimeServicesProvider(registration(owner, 'runtime-services').api, { readExecutionAdmission: () => ({ state: 'clear', generation: 0 }), managedExecution: MANAGED_EXECUTION_DESCRIPTOR });
    expect(await client.bind()).toBe(true); expect(client.captureCapabilities()!.getManagedExecutionDescriptor()).toEqual(MANAGED_EXECUTION_DESCRIPTOR);
  });
  it('shares the ABI across independently bundled Native modules', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'capability-bundles-'));
    cleanups.add(() => { const actual = realpathSync(directory); if (path.dirname(actual) !== realpathSync(os.tmpdir()) || !path.basename(actual).startsWith('capability-bundles-')) throw new Error('Invalid cleanup'); rmSync(actual, { recursive: true, force: true }); });
    async function bundle(name: string, entry: string) {
      const output = buildSync({ entryPoints: [path.resolve(import.meta.dirname, '../../sdk', entry)], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false });
      const file = path.join(directory, name + '.mjs'); writeFileSync(file, output.outputFiles[0].contents); return import(/* @vite-ignore */ pathToFileURL(file).href);
    }
    const providerModule = await bundle('provider', 'provider.ts'), clientModule = await bundle('client', 'native-client.ts');
    const owner = gateway(), provider = registration(owner, 'runtime-services');
    providerModule.registerRuntimeServicesProvider(provider.api, { readExecutionAdmission: () => ({ state: 'clear', generation: 3 }) });
    const client = clientModule.createRuntimeServicesClient(registration(owner).api); expect(await client.bind()).toBe(true);
    const handle = client.captureExecutionAdmission(); expect(handle.readExecutionAdmission(source)).toEqual({ state: 'clear', generation: 3 });
    provider.dispose(); expect(handle.readExecutionAdmission(source)).toEqual({ state: 'unknown' });
  });
});

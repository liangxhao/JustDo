import { AsyncLocalStorage } from 'node:async_hooks';

import { afterEach, expect, test, vi } from 'vitest';

import { createOwnerClient } from '../../sdk/owner-client';
import { OWNER_BINDING_METHOD, type OwnerMethodDescriptor, type OwnerNativeApi, type OwnerNativeRequest } from '../../sdk/owner-contract';
import { registerOwnerProvider, resolveOwnerWriteLease } from '../../sdk/owner-provider';

interface Gateway {
  methods: Map<string, (request: OwnerNativeRequest) => void | Promise<void>>;
  descriptors: OwnerMethodDescriptor[];
  responses: Array<{ method: string; value: unknown }>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  afterProof?(): Promise<void>;
}
const ambient = new AsyncLocalStorage<Gateway>();
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const gateway = (): Gateway => ({ methods: new Map(), descriptors: [], responses: [], requests: [] });
function registration(owner: Gateway, id = 'example'): { api: OwnerNativeApi; dispose(): void; quiesce(): void; resume(): void } {
  const controller = new AbortController();
  const cleanups = new Set<() => void>();
  let admitting = true;
  const api: OwnerNativeApi = {
    id,
    lifecycle: {
      signal: controller.signal,
      onDispose(cleanup) { cleanups.add(cleanup); return () => { cleanups.delete(cleanup); }; },
      runInBackgroundContext: callback => { if (!admitting) throw new Error('Native registration is quiesced'); return ambient.run(owner, callback); },
    },
    runtime: { gateway: { async request<T>(method: string, params: Record<string, unknown> = {}) {
      const target = ambient.getStore();
      const handler = target?.methods.get(method);
      if (!target || !handler) throw new Error('Native route is unavailable');
      target.requests.push({ method, params });
      let value: unknown;
      let error: unknown;
      await handler({
        params, client: { connect: { client: { mode: 'backend' } } },
        hasCurrentClientAuthority: () => true,
        context: { getGatewayMethodRegistry: () => ({ descriptors: () => target.descriptors }) },
        respond(ok, result, failure) { if (ok) value = result; else error = failure; },
      });
      target.responses.push({ method, value });
      if (method.startsWith('runtimeServices.ownerProof.')) await target.afterProof?.();
      if (error) throw new Error('Native request rejected');
      return value as T;
    } } },
    registerGatewayMethod(method, handler, options) {
      owner.methods.set(method, handler);
      owner.descriptors.push({ name: method, owner: { kind: 'plugin', pluginId: id }, ...options });
    },
  };
  const dispose = () => { controller.abort(); for (const cleanup of [...cleanups]) cleanup(); cleanups.clear(); };
  disposers.push(dispose);
  return { api, dispose, quiesce: () => { admitting = false; }, resume: () => { admitting = true; } };
}

test('binds the native owner and original Gateway without granting from a read provider token', async () => {
  const a = gateway(); const b = gateway();
  const pa = registerOwnerProvider(registration(a, 'runtime-services').api);
  const pb = registerOwnerProvider(registration(b, 'runtime-services').api);
  const ca = createOwnerClient(registration(a).api);
  const cb = createOwnerClient(registration(b).api);
  expect(await ambient.run(b, () => ca.bind())).toBe(true);
  expect(await ambient.run(a, () => cb.bind())).toBe(true);
  const la = ca.captureLease()!; const lb = cb.captureLease()!;
  expect(pa.resolve(la.token)?.pluginId).toBe('example');
  expect(pb.resolve(la.token)).toBeUndefined();
  expect(resolveOwnerWriteLease(la.token, pb.scope)).toBeUndefined();
  expect(pa.resolve(pb.scope)).toBeUndefined();
  expect(pa.scope).not.toBe(pb.scope);
  expect(la.registrationId).not.toBe(lb.registrationId);
  expect(a.responses.find(item => item.method === OWNER_BINDING_METHOD)?.value).not.toHaveProperty('token');
  expect(JSON.stringify(a.responses)).not.toContain(la.token);
});

test('does not accept a claimed SDK owner when the real native descriptor belongs to another plugin', async () => {
  const g = gateway();
  const provider = registerOwnerProvider(registration(g, 'runtime-services').api);
  const actual = registration(g, 'actual');
  const client = createOwnerClient({ ...actual.api, id: 'claimed' });
  expect(await client.bind()).toBe(false);
  expect(client.captureLease()).toBeUndefined();
  expect(provider.resolve('claimed')).toBeUndefined();
});

test('independent capability clients share their first owner proof without retiring each other', async () => {
  const g = gateway(); registerOwnerProvider(registration(g, 'runtime-services').api);
  const native = registration(g).api;
  const first = createOwnerClient(native); const second = createOwnerClient(native);
  expect(await Promise.all([first.ensureBound(), second.ensureBound()])).toEqual([true, true]);
  expect(g.requests.filter(value => value.method === OWNER_BINDING_METHOD)).toHaveLength(1);
  expect(first.captureLease()).toBe(second.captureLease());
});

test('a completed nonce cannot be replayed to acquire or overwrite a lease', async () => {
  const g = gateway(); registerOwnerProvider(registration(g, 'runtime-services').api);
  const native = registration(g);
  const client = createOwnerClient(native.api);
  expect(await client.bind()).toBe(true);
  const lease = client.captureLease()!;
  const request = g.requests.find(item => item.method === OWNER_BINDING_METHOD)!;
  await expect(native.api.lifecycle.runInBackgroundContext!(() => native.api.runtime.gateway.request(OWNER_BINDING_METHOD, request.params))).rejects.toThrow('rejected');
  expect(client.captureLease()).toBe(lease);
  lease.assertCurrent();
});

test.each(['consumer', 'provider'] as const)('rejects a proof completion after %s retirement', async retired => {
  const g = gateway();
  const p = registration(g, 'runtime-services');
  const c = registration(g);
  const provider = registerOwnerProvider(p.api);
  const client = createOwnerClient(c.api);
  let release!: () => void;
  g.afterProof = () => new Promise<void>(resolve => { release = resolve; });
  const pending = client.bind();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  if (retired === 'consumer') c.dispose(); else p.dispose();
  release();
  expect(await pending).toBe(false);
  expect(client.captureLease()).toBeUndefined();
  expect(provider.resolve('missing')).toBeUndefined();
});

test('a late earlier handshake cannot adopt the successful replacement registration lease', async () => {
  const g = gateway();
  const provider = registerOwnerProvider(registration(g, 'runtime-services').api);
  const client = createOwnerClient(registration(g).api);
  let release!: () => void;
  g.afterProof = () => new Promise<void>(resolve => { release = resolve; });
  const first = client.bind();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  g.afterProof = undefined;
  expect(await client.bind()).toBe(true);
  const current = client.captureLease()!;
  release();
  expect(await first).toBe(false);
  expect(client.captureLease()).toBe(current);
  expect(provider.resolve(current.token)?.registrationId).toBe(current.registrationId);
});

test('rebind and disposal synchronously revoke captured writers and notify each subscriber once', async () => {
  const g = gateway();
  const provider = registerOwnerProvider(registration(g, 'runtime-services').api);
  const client = createOwnerClient(registration(g).api);
  expect(await client.bind()).toBe(true);
  const old = client.captureLease()!;
  const retire = vi.fn();
  old.onRetire(retire);
  expect(await client.bind()).toBe(true);
  expect(() => old.assertCurrent()).toThrow('retired');
  expect(provider.resolve(old.token)).toBeUndefined();
  expect(retire).toHaveBeenCalledOnce();
  const current = client.captureLease()!;
  client.dispose();
  expect(() => current.assertCurrent()).toThrow('retired');
});

test.each(['consumer', 'provider'] as const)('observed %s quiescence retires writers before lifecycle abort and cannot revive them', async retired => {
  const g = gateway(); const native = registration(g); const required = registration(g, 'runtime-services');
  const provider = registerOwnerProvider(required.api);
  const client = createOwnerClient(native.api); expect(await client.bind()).toBe(true);
  const captured = client.captureLease()!;
  const onRetire = vi.fn(); captured.onRetire(onRetire);
  const quiescing = retired === 'consumer' ? native : required;
  quiescing.quiesce(); expect(provider.resolve(captured.token)).toBeUndefined();
  expect(quiescing.api.lifecycle.signal?.aborted).toBe(false);
  expect(onRetire).toHaveBeenCalledOnce();
  quiescing.resume(); expect(captured.isCurrent()).toBe(false);
  expect(await client.bind()).toBe(false); expect(client.captureLease()).toBeUndefined();
  expect(onRetire).toHaveBeenCalledOnce();
});

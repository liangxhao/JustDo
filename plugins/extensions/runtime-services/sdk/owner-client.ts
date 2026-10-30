import { createHash, randomUUID } from 'node:crypto';

import { captureNativeRegistrationProbe } from './native-lifecycle.js';
import {
  OWNER_BINDING_METHOD, OWNER_PROOF_BRIDGE_KEY,
  type OwnerClient, type OwnerConsumerRecord, type OwnerNativeApi,
  type OwnerProofBridge, type OwnerWriteLease,
} from './owner-contract.js';

function bridge(): OwnerProofBridge {
  const key = Symbol.for(OWNER_PROOF_BRIDGE_KEY);
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing !== undefined) {
    if (!existing || typeof existing !== 'object' || Reflect.get(existing, 'version') !== 1 ||
        !(Reflect.get(existing, 'consumers') instanceof Map) || !(Reflect.get(existing, 'providers') instanceof Map))
      throw new Error('Owner proof protocol is incompatible.');
    return existing as OwnerProofBridge;
  }
  const value: OwnerProofBridge = Object.freeze({ version: 1, consumers: new Map(), providers: new Map() });
  Object.defineProperty(globalThis, key, { value });
  return value;
}
const clients = new WeakMap<object, OwnerClient>();
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');

export function createOwnerClient(api: OwnerNativeApi): OwnerClient {
  const existing = clients.get(api);
  if (existing) return existing;
  const state = bridge();
  const lifecycle = api.lifecycle;
  const { signal, onDispose, runInBackgroundContext } = lifecycle;
  const registrationCurrent = captureNativeRegistrationProbe(lifecycle);
  const registrationId = randomUUID();
  const proofMethod = 'runtimeServices.ownerProof.' + registrationId;
  let retired = !signal || signal.aborted || !onDispose || !runInBackgroundContext;
  let revision = 0;
  let pending: { nonce: string; revision: number; grant?: { scope: string; token: string } } | undefined;
  let selected: { scope: string; token: string } | undefined;
  let current: OwnerWriteLease | undefined;
  let preparation: Promise<boolean> | undefined;
  const listeners = new Set<() => void>();
  let unregister: (() => void) | undefined;
  const notifyRetirement = () => {
    for (const listener of [...listeners]) { try { listener(); } catch { /* Other leases still retire. */ } }
    listeners.clear();
  };
  const live = () => {
    if (retired) return false;
    // Native can quiesce a registration before aborting its lifecycle signal.
    // The original public runner rejects fresh admission during that drain.
    if (state.consumers.get(proofMethod) === consumer && registrationCurrent()) return true;
    dispose();
    return false;
  };
  const consumer: OwnerConsumerRecord = Object.freeze({
    pluginId: api.id, registrationId,
    isCurrent: live,
    isPending: (nonce: string) => Boolean(live() && pending && pending.nonce === nonce && pending.revision === revision),
    hasGrant: (scope: string, token: string) => Boolean(live() && selected && selected.scope === scope && selected.token === token),
    onRetire(cleanup: () => void) { listeners.add(cleanup); return () => { listeners.delete(cleanup); }; },
  });
  const dispose = () => {
    if (retired) return;
    retired = true;
    revision++;
    pending = undefined;
    selected = undefined;
    current = undefined;
    notifyRetirement();
    if (state.consumers.get(proofMethod) === consumer) state.consumers.delete(proofMethod);
    signal?.removeEventListener('abort', dispose);
    unregister?.();
  };
  if (!retired) {
    state.consumers.set(proofMethod, consumer);
    signal!.addEventListener('abort', dispose, { once: true });
    try {
      unregister = onDispose!(dispose);
      api.registerGatewayMethod(proofMethod, request => {
        const { nonce, providerScope, ownerToken } = request.params;
        if (!live() || request.signal?.aborted || request.hasCurrentClientAuthority?.() === false ||
            request.client?.connect.client.mode !== 'backend' || typeof nonce !== 'string' ||
            !consumer.isPending(nonce) || pending?.grant || typeof providerScope !== 'string' ||
            typeof ownerToken !== 'string' || !/^[a-f0-9]{64}$/u.test(ownerToken)) {
          request.respond(false, undefined, { code: 'UNAVAILABLE', message: 'Owner proof is unavailable.' });
          return;
        }
        pending!.grant = { scope: providerScope, token: ownerToken };
        selected = pending!.grant;
        request.respond(true, { version: 1, nonce, registrationId, fingerprint: fingerprint(ownerToken) });
      }, { scope: 'operator.read', profileAccess: 'independent' });
    } catch { dispose(); }
  }
  const client: OwnerClient = Object.freeze({
    async bind() {
      notifyRetirement();
      const attempt = ++revision;
      current = undefined;
      selected = undefined;
      pending = undefined;
      if (!live() || !runInBackgroundContext) return false;
      const request = { nonce: randomUUID(), revision: attempt };
      pending = request;
      try {
        const result = await runInBackgroundContext(() => api.runtime.gateway.request<Record<string, unknown>>(
          OWNER_BINDING_METHOD, { proofMethod, nonce: request.nonce }, { scopes: ['operator.read'] },
        ));
        const grant = pending === request ? pending.grant : undefined;
        if (!live() || revision !== attempt || !grant || result.version !== 1 ||
            result.providerScope !== grant.scope || result.registrationId !== registrationId ||
            result.fingerprint !== fingerprint(grant.token)) return false;
        const authority = state.providers.get(grant.scope)?.resolve(grant.token);
        if (!authority || authority.pluginId !== api.id || authority.registrationId !== registrationId) return false;
        const isCurrent = () => live() && revision === attempt && selected === grant && authority.isCurrent();
        current = Object.freeze({
          token: grant.token, providerScope: grant.scope, pluginId: api.id, registrationId,
          isCurrent,
          assertCurrent() { if (!isCurrent()) throw new Error('Owner write lease is unavailable or retired.'); },
          onRetire: authority.onRetire,
        });
        return true;
      } catch { return false; }
      finally {
        if (pending === request) pending = undefined;
        if (!current && revision === attempt) { selected = undefined; notifyRetirement(); }
      }
    },
    captureLease: () => current?.isCurrent() ? current : undefined,
    ensureBound() {
      if (current?.isCurrent()) return Promise.resolve(true);
      return preparation ??= client.bind().finally(() => { preparation = undefined; });
    },
    dispose,
  });
  clients.set(api, client);
  return client;
}

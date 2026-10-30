import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { captureNativeRegistrationProbe } from './native-lifecycle.js';
import {
  OWNER_BINDING_METHOD, OWNER_PROOF_BRIDGE_KEY,
  type OwnerNativeApi, type OwnerNativeRequest, type OwnerProofBridge,
  type OwnerProvider, type VerifiedOwner,
} from './owner-contract.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
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
const fail = () => { throw new Error('Owner write lease is unavailable or retired.'); };

/** The provider scope is mandatory; a token never selects another Gateway by plugin ID. */
export function resolveOwnerWriteLease(token: string, providerScope: string): VerifiedOwner | undefined {
  return bridge().providers.get(providerScope)?.resolve(token);
}

/** Establish a live writer from native method ownership, not a claimed request owner. */
export function registerOwnerProvider(api: OwnerNativeApi): OwnerProvider {
  const lifecycle = api.lifecycle;
  const { signal, onDispose, runInBackgroundContext } = lifecycle;
  if (!signal || signal.aborted || !onDispose || !runInBackgroundContext)
    throw new Error('Owner provider requires a current native lifecycle.');
  const registrationCurrent = captureNativeRegistrationProbe(lifecycle);
  const scope = randomUUID();
  const state = bridge();
  const leases = new Map<string, VerifiedOwner>();
  const retirements = new Set<() => void>();
  let retired = false;
  let unregister: (() => void) | undefined;
  const admitted = () => {
    if (retired) return false;
    if (registrationCurrent()) return true;
    dispose();
    return false;
  };
  const dispose = () => {
    if (retired) return;
    retired = true;
    for (const retire of [...retirements]) retire();
    if (state.providers.get(scope) === provider) state.providers.delete(scope);
    signal.removeEventListener('abort', dispose);
    unregister?.();
  };
  const provider: OwnerProvider = Object.freeze({
    scope,
    resolve(token: string) {
      const lease = leases.get(token);
      return state.providers.get(scope) === provider && lease?.isCurrent() ? lease : undefined;
    },
    dispose,
  });
  state.providers.set(scope, provider);
  signal.addEventListener('abort', dispose, { once: true });
  try {
    unregister = onDispose(dispose);
    api.registerGatewayMethod(OWNER_BINDING_METHOD, async (request: OwnerNativeRequest) => {
      let retireLease: (() => void) | undefined;
      try {
        const assertRequest = () => {
          if (!admitted() || request.signal?.aborted ||
              request.client?.connect.client.mode !== 'backend' || request.hasCurrentClientAuthority?.() === false) fail();
        };
        assertRequest();
        const { proofMethod, nonce } = request.params;
        if (typeof proofMethod !== 'string' || !/^runtimeServices\.ownerProof\.[a-f0-9-]{36}$/u.test(proofMethod) ||
            typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/u.test(nonce)) fail();
        const method = proofMethod as string;
        const challenge = nonce as string;
        const consumer = state.consumers.get(method);
        const registry = request.context.getGatewayMethodRegistry?.();
        const descriptorCurrent = () => {
          const descriptors = registry?.descriptors().filter(value => value.name === method);
          return descriptors?.length === 1 && descriptors[0].owner.kind === 'plugin' &&
            descriptors[0].owner.pluginId === consumer?.pluginId &&
            descriptors[0].scope === 'operator.read' && descriptors[0].profileAccess === 'independent';
        };
        if (!consumer?.isCurrent() || !consumer.isPending(challenge) || !descriptorCurrent()) fail();
        if (leases.size >= 256) throw new Error('Owner write lease capacity exceeded.');
        const token = randomBytes(32).toString('hex');
        let published = false;
        let leaseRetired = false;
        const listeners = new Set<() => void>();
        let unwatch: (() => void) | undefined;
        const retire = () => {
          if (leaseRetired) return;
          leaseRetired = true;
          leases.delete(token);
          retirements.delete(retire);
          unwatch?.();
          for (const listener of [...listeners]) { try { listener(); } catch { /* Retirement remains definitive. */ } }
          listeners.clear();
        };
        retireLease = retire;
        const isCurrent = () => {
          const current = published && !leaseRetired && admitted() &&
            state.providers.get(scope) === provider && state.consumers.get(method) === consumer &&
            consumer!.isCurrent() && consumer!.hasGrant(scope, token) && descriptorCurrent();
          if (published && !current) retire();
          return current;
        };
        const verified: VerifiedOwner = Object.freeze({
          pluginId: consumer!.pluginId,
          registrationId: consumer!.registrationId,
          isCurrent,
          assertCurrent() { if (!isCurrent()) fail(); },
          onRetire(cleanup: () => void) {
            if (!isCurrent()) { cleanup(); return () => undefined; }
            listeners.add(cleanup);
            return () => { listeners.delete(cleanup); };
          },
        });
        retirements.add(retire);
        unwatch = consumer!.onRetire(retire);
        leases.set(token, verified);
        // The secret goes only to the registered consumer callback. A forwarded
        // bind request receives an acknowledgement, never somebody else's token.
        const acknowledgement = await runInBackgroundContext(() => api.runtime.gateway.request<Record<string, unknown>>(
          method, { nonce: challenge, providerScope: scope, ownerToken: token }, { scopes: ['operator.read'] },
        ));
        assertRequest();
        if (leaseRetired || !consumer!.isCurrent() || !consumer!.isPending(challenge) ||
            !consumer!.hasGrant(scope, token) || !descriptorCurrent() ||
            acknowledgement.version !== 1 || acknowledgement.nonce !== challenge ||
            acknowledgement.registrationId !== consumer!.registrationId || acknowledgement.fingerprint !== hash(token)) fail();
        published = true;
        request.respond(true, { version: 1, providerScope: scope, registrationId: consumer!.registrationId, fingerprint: hash(token) });
      } catch {
        retireLease?.();
        request.respond(false, undefined, { code: 'UNAVAILABLE', message: 'Owner write binding is unavailable.' });
      }
    }, { scope: 'operator.read', profileAccess: 'independent' });
  } catch (error) { dispose(); throw error; }
  return provider;
}

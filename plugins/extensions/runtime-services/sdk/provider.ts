import { randomUUID } from 'node:crypto';

import type { ExecutionAdmissionSnapshot, ExecutionAdmissionSource } from './admission.js';

import { isManagedExecutionDescriptor, type ManagedExecutionDescriptor } from './execution.js';
import { captureNativeRegistrationProbe } from './native-lifecycle.js';

export const RUNTIME_SERVICES_BINDING_METHOD = 'runtimeServices.capabilities';
const PROTOCOL_VERSION = 2;
const BRIDGE_KEY = Symbol.for('runtime-services.capability-provider.v2');

export interface NativeCapabilityLifecycle {
  signal?: AbortSignal;
  onDispose?: (cleanup: () => void) => () => void;
  runInBackgroundContext?: <T>(run: () => T) => T;
}
interface ProviderApi {
  id: string;
  lifecycle: NativeCapabilityLifecycle;
  registerGatewayMethod(
    method: string,
    handler: (context: {
      respond(ok: boolean, payload?: unknown, error?: { code: string; message: string }): void;
    }) => void,
    options: { scope: 'operator.read'; profileAccess: 'independent' },
  ): void;
}

export interface RuntimeServicesCapabilities {
  executionAdmission: 2;
  managedExecution?: Readonly<ManagedExecutionDescriptor>;
}
export interface RuntimeServicesBinding {
  version: 2;
  providerToken: string;
  capabilities: Readonly<RuntimeServicesCapabilities>;
}
interface Provider {
  readonly binding: Readonly<RuntimeServicesBinding>;
  isCurrent(): boolean;
  readExecutionAdmission(source: ExecutionAdmissionSource): ExecutionAdmissionSnapshot;
}
interface Bridge {
  version: 2;
  providers: Map<string, Provider>;
}

function bridge(): Bridge {
  const existing: unknown = Reflect.get(globalThis, BRIDGE_KEY);
  if (existing !== undefined) {
    if (!existing || typeof existing !== 'object' ||
        Reflect.get(existing, 'version') !== PROTOCOL_VERSION ||
        !(Reflect.get(existing, 'providers') instanceof Map))
      throw new Error('Runtime Services capability bridge is incompatible.');
    return existing as Bridge;
  }
  const value: Bridge = Object.freeze({ version: PROTOCOL_VERSION, providers: new Map() });
  Object.defineProperty(globalThis, BRIDGE_KEY, { value });
  return value;
}

/** Internal protocol lookup. A token proves a binding, never execution authorization. */
export function readRuntimeServicesProvider(token: string): Provider | undefined {
  const provider = bridge().providers.get(token);
  return provider?.isCurrent() ? provider : undefined;
}

/**
 * Only Runtime Services publishes this projection. The bridge holds callbacks,
 * never a copied launch ledger, native state, executor or authorization facts.
 */
export function registerRuntimeServicesProvider(
  api: ProviderApi,
  implementation: {
    readExecutionAdmission(source: ExecutionAdmissionSource): ExecutionAdmissionSnapshot;
    managedExecution?: Readonly<ManagedExecutionDescriptor>;
  },
): () => void {
  const lifecycle = api.lifecycle;
  const { signal, onDispose, runInBackgroundContext } = lifecycle;
  const nativeCurrent = captureNativeRegistrationProbe(lifecycle);
  if (api.id !== 'runtime-services' || !signal || !onDispose || !runInBackgroundContext || !nativeCurrent())
    throw new Error('Runtime Services provider requires a live native registration.');
  if (implementation.managedExecution !== undefined &&
      !isManagedExecutionDescriptor(implementation.managedExecution))
    throw new Error('Runtime Services managed execution descriptor is incompatible.');
  const providerToken = randomUUID();
  const capabilities: Readonly<RuntimeServicesCapabilities> = Object.freeze({
    executionAdmission: 2,
    ...(implementation.managedExecution ? {
      managedExecution: Object.freeze({ ...implementation.managedExecution }),
    } : {}),
  });
  const binding: Readonly<RuntimeServicesBinding> = Object.freeze({
    version: PROTOCOL_VERSION,
    providerToken,
    capabilities,
  });
  const providers = bridge().providers;
  let retired = false;
  const provider: Provider = Object.freeze({
    binding,
    isCurrent() {
      if (retired) return false;
      if (providers.get(providerToken) !== provider || !nativeCurrent()) {
        dispose();
        return false;
      }
      return true;
    },
    readExecutionAdmission(source: ExecutionAdmissionSource): ExecutionAdmissionSnapshot {
      if (!provider.isCurrent()) return { state: 'unknown' };
      try {
        const result = runInBackgroundContext(() => implementation.readExecutionAdmission({ ...source }));
        if (!provider.isCurrent()) return { state: 'unknown' };
        return result && ['clear', 'held', 'unknown'].includes(result.state) ? result : { state: 'unknown' };
      } catch {
        return { state: 'unknown' };
      }
    },
  });
  let unregisterDisposer: (() => void) | undefined;
  const dispose = () => {
    retired = true;
    if (providers.get(providerToken) === provider) providers.delete(providerToken);
    signal.removeEventListener('abort', dispose);
    unregisterDisposer?.();
    unregisterDisposer = undefined;
  };
  providers.set(providerToken, provider);
  signal.addEventListener('abort', dispose, { once: true });
  try {
    unregisterDisposer = onDispose(dispose);
    api.registerGatewayMethod(RUNTIME_SERVICES_BINDING_METHOD, ({ respond }) => {
      if (!provider.isCurrent()) {
        respond(false, undefined, { code: 'UNAVAILABLE', message: 'Runtime Services provider is retired.' });
        return;
      }
      respond(true, binding);
    }, { scope: 'operator.read', profileAccess: 'independent' });
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

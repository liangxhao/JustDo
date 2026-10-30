import type { ExecutionAdmissionSnapshot, ExecutionAdmissionSource } from './admission.js';

import { isManagedExecutionDescriptor, type ManagedExecutionDescriptor } from './execution.js';
import { captureNativeRegistrationProbe } from './native-lifecycle.js';
import {
  readRuntimeServicesProvider,
  RUNTIME_SERVICES_BINDING_METHOD,
  type RuntimeServicesBinding,
  type NativeCapabilityLifecycle,
} from './provider.js';

export type { ExecutionAdmissionSnapshot, ExecutionAdmissionSource } from './admission.js';

interface ClientApi {
  lifecycle: NativeCapabilityLifecycle;
  runtime: { gateway: {
    request<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: { scopes?: Array<'operator.read'> },
    ): Promise<T>;
  } };
}

export interface CapabilitiesHandle {
  isCurrent(): boolean;
  getManagedExecutionDescriptor(): Readonly<ManagedExecutionDescriptor> | undefined;
}
export interface ExecutionAdmissionHandle extends CapabilitiesHandle {
  /** Synchronous hint only. Native policies independently admit every effect. */
  readExecutionAdmission(source: ExecutionAdmissionSource): ExecutionAdmissionSnapshot;
}
export interface RuntimeServicesClient {
  /** Explicit read-only handshake; a failed attempt can be retried, never business work. */
  bind(): Promise<boolean>;
  captureCapabilities(): CapabilitiesHandle | undefined;
  captureExecutionAdmission(): ExecutionAdmissionHandle | undefined;
  dispose(): void;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function isRuntimeServicesBinding(value: unknown): value is RuntimeServicesBinding {
  return record(value) && value.version === 2 && typeof value.providerToken === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.providerToken) &&
    record(value.capabilities) && value.capabilities.executionAdmission === 2 &&
    (value.capabilities.managedExecution === undefined ||
      isManagedExecutionDescriptor(value.capabilities.managedExecution));
}

/**
 * The public native background runner pins the registration's Gateway resolver.
 * An ambient request, plugin ID or state directory cannot select another provider.
 */
export function createRuntimeServicesClient(
  api: ClientApi,
): RuntimeServicesClient {
  const lifecycle = api.lifecycle;
  const { signal, onDispose, runInBackgroundContext } = lifecycle;
  const nativeCurrent = captureNativeRegistrationProbe(lifecycle);
  let retired = !signal || !onDispose || !runInBackgroundContext || !nativeCurrent();
  let revision = 0;
  let current: ExecutionAdmissionHandle | undefined;
  let unregisterDisposer: (() => void) | undefined;
  const dispose = () => {
    retired = true;
    revision++;
    current = undefined;
    signal?.removeEventListener('abort', dispose);
    unregisterDisposer?.();
    unregisterDisposer = undefined;
  };
  if (!retired) {
    signal!.addEventListener('abort', dispose, { once: true });
    try {
      unregisterDisposer = onDispose!(dispose);
    } catch {
      dispose();
    }
  }
  return Object.freeze({
    async bind() {
      const attempt = ++revision;
      current = undefined;
      if (retired || !runInBackgroundContext) return false;
      if (!nativeCurrent()) { dispose(); return false; }
      try {
        const value: unknown = await runInBackgroundContext(() =>
          api.runtime.gateway.request(RUNTIME_SERVICES_BINDING_METHOD, {}, { scopes: ['operator.read'] }));
        if (retired || attempt !== revision) return false;
        if (!nativeCurrent()) { dispose(); return false; }
        if (!isRuntimeServicesBinding(value)) return false;
        const provider = readRuntimeServicesProvider(value.providerToken);
        if (!provider || provider.binding.version !== value.version ||
            JSON.stringify(provider.binding.capabilities) !== JSON.stringify(value.capabilities)) return false;
        let handleRetired = false;
        const isCurrent = () => {
          if (handleRetired || retired || revision !== attempt) return false;
          if (!nativeCurrent()) { dispose(); return false; }
          if (readRuntimeServicesProvider(value.providerToken) !== provider) {
            handleRetired = true;
            return false;
          }
          return true;
        };
        const handle: ExecutionAdmissionHandle = Object.freeze({
          isCurrent,
          getManagedExecutionDescriptor: () => isCurrent()
            ? provider.binding.capabilities.managedExecution : undefined,
          readExecutionAdmission: (source: ExecutionAdmissionSource): ExecutionAdmissionSnapshot => isCurrent()
            ? provider.readExecutionAdmission(source) : { state: 'unknown' },
        });
        current = handle;
        return true;
      } catch {
        return false;
      }
    },
    captureCapabilities: () => current?.isCurrent() ? current : undefined,
    captureExecutionAdmission: () => current?.isCurrent() ? current : undefined,
    dispose,
  });
}

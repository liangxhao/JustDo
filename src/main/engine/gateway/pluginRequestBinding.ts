import { AsyncLocalStorage } from 'node:async_hooks';

import { AppPluginError } from '../../../../packages/app-plugin-sdk/contracts';
import {
  type AppNativeBinding,
  appNativeDispatchMethod,
  isAppNativeBinding,
  isAppNativeUnknownOutcome,
} from '../../../../packages/app-plugin-sdk/native-contract';
import type { GatewayClientLike } from './types';

export type PluginRequestBinding = AppNativeBinding;
const admission = new AsyncLocalStorage<{
  expected: PluginRequestBinding;
  assertCurrent(): void;
}>();
const boundClients = new WeakSet<GatewayClientLike>();

/** Retain the identity admitted at entry; an async continuation never borrows a new owner. */
export function runWithPluginRequestBinding<T>(
  expected: PluginRequestBinding | undefined,
  assertCurrent: () => void,
  operation: () => T,
): T {
  if (!isAppNativeBinding(expected)) throw new Error(AppPluginError.Unavailable);
  const captured = Object.freeze({
    ...expected,
    gatewayMethods: Object.freeze(expected.gatewayMethods.map(entry => Object.freeze({ ...entry }))),
  });
  return admission.run({ expected: captured, assertCurrent }, operation);
}
export const runWithoutPluginRequestBinding = <T>(operation: () => T): T =>
  admission.exit(operation);

/** Every Main native request, including those nested in ordinary product services, uses this seam. */
export function bindPluginGatewayClient<T extends GatewayClientLike>(client: T): T {
  if (boundClients.has(client)) return client;
  const request = client.request.bind(client);
  client.request = (method, params, options) => {
    const frame = admission.getStore();
    if (!frame) return request(method, params, options);
    frame.assertCurrent();
    const owned = frame.expected.gatewayMethods.find(entry => entry.method === method);
    // The actual Native request must own the complete handler lifetime, including
    // work after its first accepted/running response. Do not nest an owned RPC in
    // the public dispatcher, whose invocation ends at that first response.
    const dispatchOptions = options && {
      ...(options.expectFinal !== undefined ? { expectFinal: options.expectFinal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
    const task = owned ? request(owned.alias, params, options) : request(
      appNativeDispatchMethod(frame.expected.pluginId),
      {
        registrationId: frame.expected.registrationId,
        processId: frame.expected.processId,
        method,
        ...(params === undefined ? {} : { params }),
        ...(dispatchOptions && Object.keys(dispatchOptions).length ? { options: dispatchOptions } : {}),
      },
      options,
    );
    return task.catch((error: unknown) => {
      const failure = error as Error & { code?: unknown; gatewayCode?: unknown; details?: unknown };
      if (
        error instanceof Error &&
        (failure.code === 'UNAVAILABLE' || failure.gatewayCode === 'UNAVAILABLE') &&
        isAppNativeUnknownOutcome(failure.details, frame.expected, method)
      ) {
        // A correlated bridge error does not establish that the admitted mutation
        // failed. Reuse ordinary transport uncertainty and its receipt reconciliation.
        throw Object.assign(new Error(`Native dispatch outcome is unknown: ${method}`, { cause: error }), {
          code: 'CLIENT_TIMEOUT',
          requestSent: true,
          method,
          retryable: false,
        });
      }
      throw error;
    });
  };
  boundClients.add(client);
  return client;
}

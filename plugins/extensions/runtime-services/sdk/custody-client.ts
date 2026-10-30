import { createHash } from 'node:crypto';

import {
  CUSTODY_RPC, type CustodyAppend, type CustodyIdentity, type CustodyPrepare,
  type CustodyProviderPort, type CustodyRead, type CustodyReceipt, type ExecutionReceiptUpdate,
} from './custody.js';
import { createOwnerClient } from './owner-client.js';
import type { OwnerNativeApi } from './owner-contract.js';

export const CUSTODY_PROVIDER_KEY = 'runtime-services.custody-provider.v1';
export const custodyResourceId = (ownerId: string, scopeId: string): string =>
  createHash('sha256').update(JSON.stringify([ownerId, scopeId])).digest('hex');

const clients = new WeakMap<object, ReturnType<typeof createCustodyClientInternal>>();
export function createCustodyClient(api: OwnerNativeApi) {
  let client = clients.get(api);
  if (!client) { client = createCustodyClientInternal(api); clients.set(api, client); }
  return client;
}
function createCustodyClientInternal(api: OwnerNativeApi) {
  const owner = createOwnerClient(api);
  let binding: Promise<boolean> | undefined;
  const lease = () => {
    const captured = owner.captureLease();
    if (!captured) throw new Error('Custody owner write lease is unavailable.');
    captured.assertCurrent();
    return captured;
  };
  const request = async <T>(method: string, input: object): Promise<T> => {
    const captured = lease();
    const run = api.lifecycle.runInBackgroundContext;
    if (!run) throw new Error('Custody requires a bound native background context.');
    const result = await run(() => api.runtime.gateway.request<T>(method, {
      ...input, ownerToken: captured.token, providerScope: captured.providerScope,
    }, { scopes: ['operator.admin'] }));
    captured.assertCurrent();
    return result;
  };
  return Object.freeze({
    bind: () => owner.captureLease() ? Promise.resolve(true) : binding ??= owner.ensureBound().finally(() => { binding = undefined; }),
    isCurrent: () => owner.captureLease()?.isCurrent() === true,
    prepare: (input: CustodyPrepare) => request<CustodyIdentity>(CUSTODY_RPC.prepare, input),
    append: (input: CustodyAppend) => request<CustodyReceipt>(CUSTODY_RPC.append, input),
    read: (input: CustodyRead) => request<{ identity: CustodyIdentity; payload: string; entryId: string }>(CUSTODY_RPC.read, input),
    inspect: (input: CustodyRead) => request<CustodyReceipt>(CUSTODY_RPC.inspect, input),
    writeExecutionReceipt(input: ExecutionReceiptUpdate) {
      const captured = lease();
      const providers: unknown = Reflect.get(globalThis, Symbol.for(CUSTODY_PROVIDER_KEY));
      if (!(providers instanceof Map)) throw new Error('Custody metadata provider is unavailable.');
      const provider = providers.get(captured.providerScope) as CustodyProviderPort | undefined;
      if (!provider?.isCurrent()) throw new Error('Custody metadata provider is retired.');
      // This is a metadata write, never execution through a different plugin's executor.
      const run = api.lifecycle.runInBackgroundContext;
      if (!run) throw new Error('Custody requires a bound native background context.');
      run(() => provider.writeExecutionReceipt(captured.token, input));
      captured.assertCurrent();
    },
  });
}

import type { ExecutionAdmissionOperation, ExecutionAdmissionReceipt, ExecutionAdmissionReservation, ExecutionAdmissionSnapshot, ExecutionAdmissionSource } from './admission.js';
import { EXECUTION_ADMISSION_METHOD } from './admission.js';
import { createOwnerClient } from './owner-client.js';

type Api = Parameters<typeof createOwnerClient>[0];

/** Proof-bound metadata writes only; effects continue through the caller's native API. */
export function createExecutionAdmissionClient(api: Api) {
  const owner = createOwnerClient(api);
  const request = async (params: Record<string, unknown>) => {
    const lease = owner.captureLease();
    if (!lease) throw new Error('A current native admission owner is required.');
    lease.assertCurrent();
    const result = await api.lifecycle.runInBackgroundContext!(() =>
      api.runtime.gateway.request<{ receipt?: ExecutionAdmissionReceipt; snapshot?: ExecutionAdmissionSnapshot }>(
        EXECUTION_ADMISSION_METHOD, { ...params, ownerToken: lease.token }, { scopes: ['operator.admin'] },
      ));
    lease.assertCurrent();
    return result;
  };
  const receipt = async (params: Record<string, unknown>) => {
    const value = (await request(params)).receipt;
    if (!value) throw new Error('Execution admission receipt is unavailable.');
    return value;
  };
  return {
    bind: () => owner.ensureBound(),
    async inspect(source: ExecutionAdmissionSource) {
      const value = (await request({ ...source, operation: 'inspect' })).snapshot;
      if (!value) throw new Error('Execution admission snapshot is unavailable.');
      return value;
    },
    reserve: (source: ExecutionAdmissionReservation) => receipt({ ...source, operation: 'reserve' }),
    update: (receipt: Pick<ExecutionAdmissionReceipt, 'sessionKey' | 'id' | 'generation'>,
      operation: ExecutionAdmissionOperation, evidence: { receiptId?: string; neverSubmitted?: boolean } = {}) =>
      request({ ...receipt, ...evidence, operation }).then(result => {
        if (!result.receipt) throw new Error('Execution admission receipt is unavailable.');
        return result.receipt;
      }),
    dispose: () => owner.dispose(),
  };
}

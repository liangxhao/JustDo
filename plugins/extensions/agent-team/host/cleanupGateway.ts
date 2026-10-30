import { EXECUTION_ADMISSION_MAINTENANCE_METHOD } from '@runtime-services/sdk/admission';
import { CUSTODY_RPC } from '@runtime-services/sdk/custody';

export const TEAM_CLEANUP_GATEWAY_METHODS = [
  'sessions.describe',
  'sessions.delete',
  'sessions.patch',
  'chat.history',
  'teamDiscussion.status',
  'teamDiscussion.stop',
  'teamDiscussion.close',
  EXECUTION_ADMISSION_MAINTENANCE_METHOD,
  CUSTODY_RPC.inspect,
  CUSTODY_RPC.cancel,
  CUSTODY_RPC.close,
  CUSTODY_RPC.unlock,
  CUSTODY_RPC.receiptInspect,
  CUSTODY_RPC.receiptCancel,
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const generation = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const fields = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const identity = (value: unknown): boolean =>
  record(value) && fields(value, ['resourceId', 'epoch', 'agentId', 'sessionKey', 'sessionId', 'lifecycleRevision']) &&
  digest(value.resourceId) && generation(value.epoch) && text(value.agentId) &&
  text(value.sessionKey) && text(value.sessionId) && text(value.lifecycleRevision);

/** Maintenance can reconcile existing resources, never create storage or send input. */
export function allowTeamCleanupGatewayRequest(method: string, params: unknown): boolean {
  if (!TEAM_CLEANUP_GATEWAY_METHODS.some(allowed => allowed === method)) return false;
  if (!method.startsWith('runtimeServices.')) return true;
  if (!record(params)) return false;
  if (method === EXECUTION_ADMISSION_MAINTENANCE_METHOD) {
    if (!fields(params, ['operation', 'sessionKey', 'sessionId', 'runId'],
      ['lifecycleRevision', 'id', 'generation', 'receiptId', 'neverSubmitted']) ||
        !text(params.sessionKey) || !text(params.sessionId) || !text(params.runId) ||
        !['inspect', 'revoke', 'cleanup', 'release', 'abandon'].includes(String(params.operation))) return false;
    if (params.operation === 'inspect') return true;
    return text(params.id) && generation(params.generation) &&
      (params.lifecycleRevision === null || text(params.lifecycleRevision)) &&
      (params.operation !== 'cleanup' || text(params.receiptId)) &&
      (params.operation !== 'abandon' || params.neverSubmitted === true);
  }
  if (method === CUSTODY_RPC.receiptInspect || method === CUSTODY_RPC.receiptCancel)
    return fields(params, ['ownerId', 'operationId'], method === CUSTODY_RPC.receiptCancel ? ['expectedWriterRegistrationId'] : []) &&
      params.ownerId === 'agent-team' && text(params.operationId) &&
      (params.expectedWriterRegistrationId === undefined || text(params.expectedWriterRegistrationId));
  if (method === CUSTODY_RPC.close)
    return fields(params, ['resourceId']) && digest(params.resourceId);
  if (method === CUSTODY_RPC.unlock)
    return fields(params, ['identity']) && identity(params.identity);
  if (method === CUSTODY_RPC.cancel)
    return fields(params, ['resourceId', 'epoch'], ['operationIds']) &&
      digest(params.resourceId) && generation(params.epoch) &&
      (params.operationIds === undefined || (Array.isArray(params.operationIds) &&
        params.operationIds.length <= 256 && params.operationIds.every(text)));
  return method === CUSTODY_RPC.inspect &&
    fields(params, ['resourceId', 'epoch', 'operationId', 'sha256', 'identity'], ['entryId']) &&
    digest(params.resourceId) && generation(params.epoch) && text(params.operationId) &&
    digest(params.sha256) && (params.entryId === undefined || text(params.entryId)) &&
    identity(params.identity) && record(params.identity) &&
    params.identity.resourceId === params.resourceId && params.identity.epoch === params.epoch;
}

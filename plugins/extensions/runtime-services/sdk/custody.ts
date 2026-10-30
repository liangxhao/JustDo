/** Inert native storage and content-free receipts. No business payload schema lives here. */
export const INERT_CUSTODY_HARNESS = 'inert-custody';
export const INERT_CUSTODY_CUSTOM_TYPE = 'inert-custody-input';
export const CUSTODY_RPC = {
  prepare: 'runtimeServices.custody.prepare',
  append: 'runtimeServices.custody.append',
  read: 'runtimeServices.custody.read',
  inspect: 'runtimeServices.custody.inspect',
  cancel: 'runtimeServices.custody.cancel',
  close: 'runtimeServices.custody.close',
  unlock: 'runtimeServices.custody.unlock',
  receiptInspect: 'runtimeServices.receipts.inspect',
  receiptCancel: 'runtimeServices.receipts.cancel',
} as const;

export interface CustodyIdentity {
  resourceId: string;
  epoch: number;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
}
export interface CustodyLocator {
  resourceId: string;
  epoch: number;
  operationId: string;
  sha256: string;
  entryId?: string;
}
export interface CustodyReceipt extends CustodyLocator {
  state: 'receiving' | 'saved' | 'unknown' | 'cancelled';
}
export interface CustodyPrepare {
  /** Caller-owned opaque scope, unrelated to any service business type. */
  scopeId: string;
  epoch: number;
  agentId: string;
  cwd: string;
}
export interface CustodyRead extends CustodyLocator {
  identity: CustodyIdentity;
}
export interface CustodyAppend {
  identity: CustodyIdentity;
  operationId: string;
  sha256: string;
  /** Opaque UTF-8 bytes. Only the caller interprets or serializes their meaning. */
  payload: string;
}
export interface CustodyCancel {
  resourceId: string;
  epoch: number;
  operationIds?: string[];
}
export interface CustodyClose {
  /** Permanent closure of this resource, including future epochs. Never reopened. */
  resourceId: string;
}
export interface CustodyCloseResult {
  closed: true;
  identities: CustodyIdentity[];
}
export interface CustodyUnlock { identity: CustodyIdentity }
export interface CustodyUnlockResult { identity: CustodyIdentity }
export interface ExecutionReceiptSubject {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  runId: string;
  outcome?: 'completed' | 'failed' | 'cancelled';
}
export interface ExecutionReceipt {
  operationId: string;
  ownerId: string;
  writerRegistrationId: string;
  inputSha256: string;
  state: 'open' | 'unknown' | 'settled';
  subjects: ExecutionReceiptSubject[];
  settledRunIds: string[];
  cleanupComplete: boolean;
  cancelRequested: boolean;
}
export interface ExecutionReceiptLocator {
  ownerId: string;
  operationId: string;
}
export interface ExecutionReceiptCancel extends ExecutionReceiptLocator {
  expectedWriterRegistrationId?: string;
}
export interface ExecutionReceiptResult { receipt: ExecutionReceipt | null }
export interface ExecutionReceiptUpdate {
  operationId: string;
  inputSha256: string;
  subjects: ExecutionReceiptSubject[];
  cleanupComplete: boolean;
}
/** Internal synchronous metadata port, fixed to a successfully proven owner scope. */
export interface CustodyProviderPort {
  isCurrent(): boolean;
  writeExecutionReceipt(ownerToken: string, input: ExecutionReceiptUpdate): void;
}

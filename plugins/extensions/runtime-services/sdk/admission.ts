export const EXECUTION_ADMISSION_LANE = 'session-execution';
export const EXECUTION_ADMISSION_METHOD = 'runtimeServices.executionAdmission';
export const EXECUTION_ADMISSION_MAINTENANCE_METHOD = 'runtimeServices.executionAdmissionMaintenance';

export interface ExecutionAdmissionSource {
  sessionKey: string;
  sessionId?: string;
}
export interface ExactExecutionAdmissionSource extends ExecutionAdmissionSource {
  sessionId: string;
  lifecycleRevision: string | null;
  runId: string;
}
export interface ExecutionAdmissionReceipt extends ExactExecutionAdmissionSource {
  version: 2;
  id: string;
  generation: number;
  owner: { pluginId: string; registrationId: string; providerScope: string };
  state: 'held' | 'revoked' | 'released';
  verified: boolean;
  effectIssued: boolean;
  acceptedReceiptId?: string;
  cleanupReceipt?: { id: string; registrationId: string; source: 'owner-attestation' | 'backend-reconciliation' };
  sourceTerminal?: { runId: string; sessionId: string; phase: 'end' | 'error'; seq: number; executionSettled: true };
}
export type ExecutionAdmissionSnapshot =
  | { state: 'clear'; generation: number; receipt?: Readonly<ExecutionAdmissionReceipt> }
  | { state: 'held'; generation: number; receipt: Readonly<ExecutionAdmissionReceipt> }
  | { state: 'unknown'; generation?: number };

export interface ExecutionAdmissionReservation extends ExactExecutionAdmissionSource {
  expectedGeneration: number;
}
/** verify records an authenticated source input; that positive fact cannot become never-submitted. */
export type ExecutionAdmissionOperation = 'verify' | 'issued' | 'accepted' | 'revoke' | 'cleanup' | 'release' | 'abandon';

export interface ExecutionAdmissionMaintenanceRequest {
  operation: 'inspect' | 'revoke' | 'cleanup' | 'release' | 'abandon';
  sessionKey: string;
  sessionId: string;
  runId: string;
  lifecycleRevision?: string | null;
  id?: string;
  generation?: number;
  receiptId?: string;
  neverSubmitted?: true;
}

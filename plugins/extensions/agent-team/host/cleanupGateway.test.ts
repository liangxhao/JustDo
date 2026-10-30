import { EXECUTION_ADMISSION_MAINTENANCE_METHOD } from '@runtime-services/sdk/admission';
import { CUSTODY_RPC } from '@runtime-services/sdk/custody';
import { expect, it } from 'vitest';

import { allowTeamCleanupGatewayRequest as allowed } from './cleanupGateway';

const resourceId = 'a'.repeat(64);
const identity = { resourceId, epoch: 2, agentId: 'main', sessionKey: 'key', sessionId: 'native', lifecycleRevision: 'revision' };

it('limits disabled custody access to existing exact metadata and cancellation', () => {
  const locator = { resourceId, epoch: 2, operationId: 'input', sha256: 'b'.repeat(64), identity };
  expect(allowed(CUSTODY_RPC.inspect, locator)).toBe(true);
  expect(allowed(CUSTODY_RPC.inspect, { ...locator, identity: { ...identity, epoch: 3 } })).toBe(false);
  expect(allowed(CUSTODY_RPC.cancel, { resourceId, epoch: 2 })).toBe(true);
  expect(allowed(CUSTODY_RPC.cancel, { resourceId, epoch: 0 })).toBe(false);
  expect(allowed(CUSTODY_RPC.close, { resourceId })).toBe(true);
  expect(allowed(CUSTODY_RPC.unlock, { identity })).toBe(true);
  expect(allowed(CUSTODY_RPC.unlock, { identity: { ...identity, ownerToken: 'injected' } })).toBe(false);
});

it('requires exact admission receipts for maintenance mutations', () => {
  const source = { sessionKey: 'key', sessionId: 'native', runId: 'run' };
  expect(allowed(EXECUTION_ADMISSION_MAINTENANCE_METHOD, { ...source, operation: 'inspect' })).toBe(true);
  expect(allowed(EXECUTION_ADMISSION_MAINTENANCE_METHOD, { ...source, operation: 'revoke' })).toBe(false);
  const receipt = { ...source, id: 'admission', generation: 2, lifecycleRevision: null };
  expect(allowed(EXECUTION_ADMISSION_MAINTENANCE_METHOD, { ...receipt, operation: 'revoke' })).toBe(true);
  expect(allowed(EXECUTION_ADMISSION_MAINTENANCE_METHOD, { ...receipt, operation: 'cleanup' })).toBe(false);
  expect(allowed(EXECUTION_ADMISSION_MAINTENANCE_METHOD, { ...receipt, operation: 'cleanup', receiptId: 'reconciled' })).toBe(true);
  expect(allowed(EXECUTION_ADMISSION_MAINTENANCE_METHOD, { ...receipt, operation: 'abandon', neverSubmitted: true })).toBe(true);
});

it('keeps Team receipt cleanup within its own namespace', () => {
  expect(allowed(CUSTODY_RPC.receiptInspect, { ownerId: 'agent-team', operationId: 'receipt' })).toBe(true);
  expect(allowed(CUSTODY_RPC.receiptCancel, { ownerId: 'another-plugin', operationId: 'receipt' })).toBe(false);
});

it.each([CUSTODY_RPC.prepare, CUSTODY_RPC.append, CUSTODY_RPC.read,
  'runtimeServices.executionAdmission', 'runtimeServices.ownerBinding', 'teamDiscussion.offlineControl'])
('denies new work and retired cleanup protocol %s', method => {
  expect(allowed(method, { resourceId, epoch: 2 })).toBe(false);
});

import {
  CUSTODY_RPC,
  type CustodyIdentity,
  type CustodyRead,
  type ExecutionReceipt,
  type ExecutionReceiptResult,
} from '@runtime-services/sdk/custody';
import { custodyResourceId } from '@runtime-services/sdk/custody-client';

import type { TeamDiscussionHoldingIdentity } from '../../contracts/teamDiscussion';
import { discussionOperationId } from '../../runtime/discussion/receipt';
import type { PendingInputRecord } from '../data/teamDiscussionQueueStore';

export const TEAM_CUSTODY_OWNER = 'agent-team';
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A historical product locator without Required custody enrollment remains unknown. */
export function holdingCustodyIdentity(
  value: TeamDiscussionHoldingIdentity | undefined,
  roomId: string,
  generation?: number,
): CustodyIdentity | undefined {
  if (!value || value.roomId !== roomId ||
      value.resourceId !== custodyResourceId(TEAM_CUSTODY_OWNER, roomId) ||
      value.epoch !== value.generation || (generation !== undefined && value.epoch !== generation) ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
      !identifier(value.agentId) || !identifier(value.sessionKey) || !identifier(value.sessionId) ||
      !identifier(value.lifecycleRevision)) return undefined;
  const { resourceId, epoch, agentId, sessionKey, sessionId, lifecycleRevision } = value;
  return { resourceId, epoch, agentId, sessionKey, sessionId, lifecycleRevision };
}

export function holdingCustodyRead(input: PendingInputRecord): CustodyRead | undefined {
  const identity = holdingCustodyIdentity(input.identity, input.roomId, input.generation);
  if (!identity || !input.nativeFingerprint) return undefined;
  return { identity, resourceId: identity.resourceId, epoch: identity.epoch,
    operationId: input.requestId, sha256: input.nativeFingerprint,
    ...(input.entryId ? { entryId: input.entryId } : {}) };
}

export type CustodyRequest = <T>(method: string, params?: unknown) => Promise<T>;

/** Content-free Required receipts can prove native facts, never reconstruct business output. */
export async function readExecutionReceipt(
  request: CustodyRequest,
  kind: 'discussion' | 'summary',
  discussionId: string,
  cancel = false,
): Promise<ExecutionReceipt | null> {
  const operationId = discussionOperationId(kind, discussionId);
  const result = await request<ExecutionReceiptResult>(
    cancel ? CUSTODY_RPC.receiptCancel : CUSTODY_RPC.receiptInspect,
    { ownerId: TEAM_CUSTODY_OWNER, operationId },
  );
  if (!result || !Object.hasOwn(result, 'receipt')) throw new Error('teamDiscussionOutcomeUnknown');
  const receipt = result.receipt;
  if (receipt === null) return null;
  if (!receipt || receipt.ownerId !== TEAM_CUSTODY_OWNER || receipt.operationId !== operationId ||
      !identifier(receipt.writerRegistrationId) || !Array.isArray(receipt.subjects) ||
      !Array.isArray(receipt.settledRunIds) ||
      new Set(receipt.subjects.map(subject => subject.runId)).size !== receipt.subjects.length ||
      receipt.subjects.some(subject => !identifier(subject.agentId) || !identifier(subject.sessionKey) ||
        !identifier(subject.sessionId) || !identifier(subject.lifecycleRevision) || !identifier(subject.runId)))
    throw new Error('teamDiscussionOutcomeUnknown');
  return receipt;
}

export function executionReceiptOutcome(
  receipt: ExecutionReceipt | null,
): 'completed' | 'failed' | 'cancelled' | 'unknown' {
  if (!receipt || receipt.state !== 'settled' || receipt.cleanupComplete !== true ||
      receipt.subjects.length === 0 || receipt.subjects.some(subject =>
        !receipt.settledRunIds.includes(subject.runId) ||
        !['completed', 'failed', 'cancelled'].includes(subject.outcome ?? '')))
    return 'unknown';
  if (receipt.subjects.some(subject => subject.outcome === 'cancelled')) return 'cancelled';
  if (receipt.subjects.some(subject => subject.outcome === 'failed')) return 'failed';
  return 'completed';
}

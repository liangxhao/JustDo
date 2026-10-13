import {
  CollaborationDeliveryState,
  type CollaborationSnapshot,
} from '../../contracts/collaboration';
/** Only the source-operation metadata used to evaluate forwarding, never transcript content. */
interface SessionRunTiming {
  id: string;
  sessionId: string;
  clientTurnId: string;
  rootRunId?: string;
  state: 'running' | 'completed' | 'failed' | 'aborted';
  acceptedAt?: number;
  endedAt?: number;
}

import type {
  CollaborationContinueLocator,
  CollaborationContinueStatus,
} from './collaborationContinueDraft';

/** Only current operation metadata and real native acceptance establish this request's status. */
export function collaborationContinueStatus(
  locator: CollaborationContinueLocator,
  requestId: string,
  snapshot: CollaborationSnapshot,
  timings: readonly SessionRunTiming[],
  terminalSnapshotFresh: boolean,
): CollaborationContinueStatus | undefined {
  const room = snapshot.room;
  const source = room?.members.find(member => member.sessionId === room.anchorSessionId);
  if (
    !room ||
    !source ||
    room.id !== locator.roomId ||
    room.anchorSessionId !== locator.sourceSessionId ||
    !room.members.some(
      member =>
        member.agentId === locator.targetAgentId &&
        member.sessionId === locator.targetSessionId &&
        member.sessionKey === locator.targetSessionKey,
    )
  )
    return;
  const clientTurnId = `justdo-continue-${requestId}`;
  const timing = timings.find(
    item => item.sessionId === locator.sourceSessionId && item.clientTurnId === clientTurnId,
  );
  if (!timing) return;
  const runIds = new Set([clientTurnId, ...(timing.rootRunId ? [timing.rootRunId] : [])]);
  const deliveries = snapshot.deliveries.filter(
    item =>
      item.roomId === locator.roomId &&
      item.from === source.agentId &&
      item.to === locator.targetAgentId &&
      runIds.has(item.sourceRunId),
  );
  if (deliveries.some(item => item.state === CollaborationDeliveryState.ACCEPTED && !!item.runId))
    return 'target_accepted';
  if (deliveries.some(item => item.state === CollaborationDeliveryState.UNKNOWN)) return 'unknown';
  if (
    deliveries.some(
      item =>
        item.state === CollaborationDeliveryState.QUEUED ||
        item.state === CollaborationDeliveryState.DISPATCHING,
    )
  )
    return 'source_accepted';
  if (terminalSnapshotFresh && timing.state !== 'running' && timing.endedAt !== undefined)
    return 'not_forwarded';
  if (timing.acceptedAt !== undefined) return 'source_accepted';
}

export function continueTimingsEvidenceKey(timings: readonly SessionRunTiming[]): string {
  return JSON.stringify(
    timings
      .filter(item => item.clientTurnId.startsWith('justdo-continue-'))
      .map(({ id, clientTurnId, rootRunId, state, acceptedAt, endedAt }) => [
        id,
        clientTurnId,
        rootRunId,
        state,
        acceptedAt,
        endedAt,
      ]),
  );
}

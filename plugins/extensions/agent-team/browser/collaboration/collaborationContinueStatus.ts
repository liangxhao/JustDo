import type { CollaborationSnapshot } from '../../contracts/collaboration';
/** Only the member-operation metadata, never transcript content. */
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
import { collaborationMemberTurnId } from './collaborationContinueDraft';

/** Only current operation metadata and real native acceptance establish this request's status. */
export function collaborationContinueStatus(
  locator: CollaborationContinueLocator,
  requestId: string,
  snapshot: CollaborationSnapshot,
  timings: readonly SessionRunTiming[],
): CollaborationContinueStatus | undefined {
  const room = snapshot.room;
  if (
    !room ||
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
  const clientTurnId = collaborationMemberTurnId(requestId);
  const timing = timings.find(
    item => item.sessionId === locator.targetSessionId && item.clientTurnId === clientTurnId,
  );
  if (!timing) return;
  if (timing.acceptedAt !== undefined) return 'target_accepted';
}

export function continueTimingsEvidenceKey(timings: readonly SessionRunTiming[]): string {
  return JSON.stringify(
    timings
      .filter(item => item.clientTurnId.startsWith('agent-team-member-'))
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

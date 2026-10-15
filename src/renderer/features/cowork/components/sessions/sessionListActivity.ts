import type { CollaborationRoomEntry } from '@shared/cowork/agent-team/collaboration';
import {
  type TeamDiscussionRoom,
  TeamDiscussionState,
} from '@shared/cowork/agent-team/teamDiscussion';

/** Related work changes the sidebar indicator, never the main composer state. */
export function collectRelatedRunningSessionIds(
  collaborations: readonly CollaborationRoomEntry[],
  discussions: readonly TeamDiscussionRoom[],
  runtimeActivity: Readonly<Record<string, boolean>>,
): Set<string> {
  const running = new Set<string>();
  for (const room of collaborations) {
    if (
      room.members.some(member => runtimeActivity[member.sessionId]) ||
      room.rounds.some(
        round => (round.state === 'open' || round.state === 'closing') && round.pending > 0,
      )
    ) {
      running.add(room.anchorSessionId);
    }
  }
  for (const room of discussions) {
    if (
      room.sourceSessionId &&
      (room.state === TeamDiscussionState.PREPARING ||
        room.state === TeamDiscussionState.SUBMITTING ||
        room.state === TeamDiscussionState.RUNNING ||
        room.state === TeamDiscussionState.STOPPING)
    )
      running.add(room.sourceSessionId);
  }
  return running;
}

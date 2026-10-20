import type { CollaborationRoom } from '../../../contracts/collaboration';
import { type TeamDiscussionRoom, TeamDiscussionState } from '../../../contracts/teamDiscussion';

/** Related work changes the sidebar indicator, never the main composer state. */
export function collectRelatedRunningSessionIds(
  collaborations: readonly CollaborationRoom[],
  discussions: readonly TeamDiscussionRoom[],
  runtimeActivity: Readonly<Record<string, boolean>>,
): Set<string> {
  const running = new Set<string>();
  for (const room of collaborations) {
    // A missing terminal receipt keeps a round unsettled, but does not prove live execution.
    if (room.members.some(member => runtimeActivity[member.sessionId])) {
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

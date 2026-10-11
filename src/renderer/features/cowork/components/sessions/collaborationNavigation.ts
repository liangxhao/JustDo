import type { CollaborationRoom } from '@shared/cowork/agent-team/collaboration';

/** Search can match a peer transcript, but the main conversation stays at the room anchor. */
export function resolveCollaborationNavigation(
  sessionId: string,
  rooms: readonly CollaborationRoom[],
): {
  sessionId: string;
  memberSessionId?: string;
} {
  const room = rooms.find(item => item.members.some(member => member.sessionId === sessionId));
  return room && room.anchorSessionId !== sessionId
    ? { sessionId: room.anchorSessionId, memberSessionId: sessionId }
    : { sessionId };
}

export function toggleVisibleSessionSelection(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  return visibleIds.every(id => selected.has(id)) ? new Set() : new Set(visibleIds);
}

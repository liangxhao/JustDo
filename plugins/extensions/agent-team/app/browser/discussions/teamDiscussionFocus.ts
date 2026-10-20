export const TEAM_ROOM_FOCUSED = 'cowork:team-room-focused';

const focusedRooms = new Map<symbol, string>();

export const currentFocusedRoom = (): string | null =>
  [...focusedRooms.values()].pop() ?? null;

/** Each visible view releases only its own focus, including when another view opened later. */
export function acquireTeamDiscussionFocus(roomId: string): () => void {
  const owner = Symbol();
  const publish = () =>
    window.dispatchEvent(new CustomEvent(TEAM_ROOM_FOCUSED, { detail: currentFocusedRoom() }));
  const previous = currentFocusedRoom();
  focusedRooms.set(owner, roomId);
  if (previous !== currentFocusedRoom()) publish();
  return () => {
    const previous = currentFocusedRoom();
    focusedRooms.delete(owner);
    if (previous !== currentFocusedRoom()) publish();
  };
}

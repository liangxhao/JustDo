export const TEAM_ROOM_FOCUSED = 'cowork:team-room-focused';

const focusedRooms = new Map<symbol, { roomId: string; ownerDocument?: Document }>();

export const currentFocusedRoom = (): string | null =>
  [...focusedRooms.values()].pop()?.roomId ?? null;
export const currentFocusedDocument = (): Document | undefined =>
  [...focusedRooms.values()].pop()?.ownerDocument;

/** Each visible view releases only its own focus, including when another view opened later. */
export function acquireTeamDiscussionFocus(roomId: string, ownerDocument?: Document): () => void {
  const owner = Symbol();
  const publish = () =>
    window.dispatchEvent(new CustomEvent(TEAM_ROOM_FOCUSED, { detail: currentFocusedRoom() }));
  focusedRooms.set(owner, { roomId, ownerDocument });
  publish();
  return () => {
    const previous = [...focusedRooms.values()].pop();
    focusedRooms.delete(owner);
    if (previous !== [...focusedRooms.values()].pop()) publish();
  };
}

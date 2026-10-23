/** Shared by external protocol adapters; keyed by the product conversation identity. */
const reservations = new Set<string>();

export function reserveExternalSession(sessionId: string): () => void {
  if (reservations.has(sessionId)) throw new Error('This conversation already has an active task.');
  reservations.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservations.delete(sessionId);
  };
}

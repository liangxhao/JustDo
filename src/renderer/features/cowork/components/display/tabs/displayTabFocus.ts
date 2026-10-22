// A user keyboard/close action can replace the visible header's Document.
// Retain only the pending focus request, never tab or application ownership.
let sequence = 0;
let pending: { id: string; sequence: number; expires: number; document?: Document } | undefined;
const listeners = new Set<() => void>();

export function requestDisplayTabFocus(id: string, document?: Document) {
  pending = { id, document, sequence: ++sequence, expires: Date.now() + 1000 };
  for (const listener of listeners) listener();
}

export const readDisplayTabFocus = () =>
  pending && pending.expires >= Date.now() ? pending : undefined;
export function consumeDisplayTabFocus(value: number) {
  if (pending?.sequence === value) pending = undefined;
}
export function subscribeDisplayTabFocus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

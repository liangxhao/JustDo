import { type PropsWithChildren, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

let surface: Document | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Native views paint above Main's DOM. Put transient UI on the visible surface. */
export const setWorkspaceNotificationDocument = (next: Document | null): void => {
  if (surface === next) return;
  surface = next;
  listeners.forEach(listener => listener());
};

export const useWorkspaceNotificationDocument = (): Document =>
  useSyncExternalStore(subscribe, () => surface) ?? document;

export function WorkspaceNotifications({ children }: PropsWithChildren) {
  const ownerDocument = useWorkspaceNotificationDocument();
  return createPortal(
    <OwnerDocumentContext.Provider value={ownerDocument}>{children}</OwnerDocumentContext.Provider>,
    ownerDocument.body,
  );
}

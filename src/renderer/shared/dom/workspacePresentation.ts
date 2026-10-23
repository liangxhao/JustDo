export interface WorkspacePresentation {
  slot: HTMLElement | null;
  open: boolean;
  detached: boolean;
}

const presentations = new WeakMap<Document, () => WorkspacePresentation>();

/** Live display geometry only; native session/view authorization stays with its owner. */
export function registerWorkspacePresentation(
  doc: Document,
  read: () => WorkspacePresentation,
): () => void {
  presentations.set(doc, read);
  return () => {
    if (presentations.get(doc) === read) presentations.delete(doc);
  };
}

export const readWorkspacePresentation = (doc: Document): WorkspacePresentation | undefined =>
  presentations.get(doc)?.();

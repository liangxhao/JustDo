type GuestFocusPolicy = () => boolean;

export interface BrowserPanelFocusBinding {
  registerGuest: (guest: HTMLElement, allowed: GuestFocusPolicy) => void;
  unregisterGuest: (guest: HTMLElement) => void;
  refresh: () => void;
  release: () => void;
}

const trackers = new WeakMap<Document, BrowserFocusTracker>();

const parentElement = (element: HTMLElement): HTMLElement | null => {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode() as ShadowRoot;
  return root.host?.nodeType === 1 ? (root.host as HTMLElement) : null;
};

/** A focus anchor must still belong to the currently presented UI. */
const isUsableAnchor = (element: HTMLElement): boolean => {
  const doc = element.ownerDocument;
  const owner = doc.defaultView;
  if (
    !element.isConnected ||
    !owner ||
    owner.closed ||
    element === doc.body ||
    element === doc.documentElement
  )
    return false;
  if (!element.getClientRects().length) return false;
  for (let current: HTMLElement | null = element; current; current = parentElement(current)) {
    if (current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true')
      return false;
    const style = owner.getComputedStyle(current);
    if (
      style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility) ||
      style.opacity === '0'
    )
      return false;
  }
  return true;
};

const deepActiveElement = (doc: Document): HTMLElement | null => {
  let element = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element && typeof (element as HTMLElement).focus === 'function'
    ? (element as HTMLElement)
    : null;
};

class BrowserFocusTracker {
  private documents = new Map<Document, number>();
  private guests = new Map<HTMLElement, { allowed: GuestFocusPolicy; listener: () => void }>();
  private anchor: HTMLElement | null = null;
  private restoring = false;
  private references = 0;

  private managedGuest(element: HTMLElement): HTMLElement | undefined {
    for (let current: HTMLElement | null = element; current; current = parentElement(current)) {
      if (this.guests.has(current)) return current;
    }
    return undefined;
  }

  private onFocusIn = (event: FocusEvent) => {
    if (this.restoring) return;
    const target = event.composedPath()[0] as HTMLElement | undefined;
    if (target?.nodeType === 1 && typeof target.focus === 'function') this.observeFocus(target);
  };

  private observeFocus(element: HTMLElement): void {
    if (this.restoring) return;
    const target = this.managedGuest(element) ?? element;
    const policy = this.guests.get(target);
    if (policy && !policy.allowed()) {
      const anchor = this.anchor;
      this.restoring = true;
      try {
        // Native guest focus may not bubble. Undo it in this same focus task,
        // before restoring the latest valid focus across all workspace panels.
        try {
          const focused = deepActiveElement(target.ownerDocument);
          if (focused && this.managedGuest(focused) === target && focused !== target)
            focused.blur();
          target.blur();
        } catch {
          /* The native guest can detach during focus delivery. */
        }
        if (
          anchor &&
          this.documents.has(anchor.ownerDocument) &&
          isUsableAnchor(anchor) &&
          this.guests.get(this.managedGuest(anchor) ?? anchor)?.allowed() !== false
        ) {
          try {
            anchor.focus({ preventScroll: true });
          } catch {
            this.anchor = null;
          }
        } else this.anchor = null;
      } finally {
        this.restoring = false;
      }
      return;
    }
    if (isUsableAnchor(target)) this.anchor = target;
  }

  retain(mainDocument: Document, ownerDocument: Document): BrowserPanelFocusBinding {
    this.references += 1;
    const documents = new Set([mainDocument, ownerDocument]);
    for (const doc of documents) {
      const count = this.documents.get(doc) ?? 0;
      this.documents.set(doc, count + 1);
      if (count) continue;
      doc.addEventListener('focusin', this.onFocusIn, true);
      const current = deepActiveElement(doc);
      if (doc.hasFocus() && current) this.observeFocus(current);
    }
    const ownedGuests = new Set<HTMLElement>();
    let released = false;
    const unregisterGuest = (guest: HTMLElement) => {
      if (!ownedGuests.delete(guest)) return;
      const entry = this.guests.get(guest);
      if (entry) guest.removeEventListener('focus', entry.listener, true);
      this.guests.delete(guest);
      if (this.anchor === guest) this.anchor = null;
    };
    return {
      registerGuest: (guest, allowed) => {
        if (released || ownedGuests.has(guest)) return;
        if (this.guests.has(guest))
          throw new Error('Browser guest focus already belongs to another panel.');
        const listener = () => this.observeFocus(guest);
        this.guests.set(guest, { allowed, listener });
        ownedGuests.add(guest);
        guest.addEventListener('focus', listener, true);
      },
      unregisterGuest,
      refresh: () => {
        if (released) return;
        for (const doc of this.documents.keys()) {
          const current = deepActiveElement(doc);
          const guest = current && this.managedGuest(current);
          if (guest && !this.guests.get(guest)!.allowed()) this.observeFocus(guest);
        }
      },
      release: () => {
        if (released) return;
        released = true;
        for (const guest of [...ownedGuests]) unregisterGuest(guest);
        for (const doc of documents) {
          const count = (this.documents.get(doc) ?? 1) - 1;
          if (count) this.documents.set(doc, count);
          else {
            doc.removeEventListener('focusin', this.onFocusIn, true);
            this.documents.delete(doc);
            if (this.anchor?.ownerDocument === doc) this.anchor = null;
          }
        }
        this.references -= 1;
        if (!this.references) trackers.delete(mainDocument);
      },
    };
  }
}

/** All retained panels in this application share the latest real UI focus. */
export const retainBrowserPanelFocus = (
  mainDocument: Document,
  ownerDocument: Document,
): BrowserPanelFocusBinding => {
  let tracker = trackers.get(mainDocument);
  if (!tracker) {
    tracker = new BrowserFocusTracker();
    trackers.set(mainDocument, tracker);
  }
  return tracker.retain(mainDocument, ownerDocument);
};

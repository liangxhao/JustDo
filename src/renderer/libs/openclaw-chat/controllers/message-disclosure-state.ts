const OWNER_ATTRIBUTE = 'data-message-disclosure-owner';
const OWNER_SELECTOR = `[${OWNER_ATTRIBUTE}]`;
const DISCLOSURE_SELECTOR = 'details.markdown-disclosure';
const MAX_DISCLOSURE_STATES = 4096;

type DisclosureRoot = ShadowRoot | HTMLElement;
type DisclosureLocation = { details: HTMLDetailsElement; key: string };
type SummaryFocus = { key: string; document: Document };

function disclosureLocations(root: DisclosureRoot): DisclosureLocation[] {
  const paths = new Map<Element, string>();
  const childCounts = new Map<Element, number>();
  const locations: DisclosureLocation[] = [];

  root.querySelectorAll<HTMLDetailsElement>(DISCLOSURE_SELECTOR).forEach(details => {
    const owner = details.closest(OWNER_SELECTOR);
    const ownerId = owner?.getAttribute(OWNER_ATTRIBUTE);
    if (!owner || !ownerId?.trim() || !root.contains(owner)) return;

    const ancestor = details.parentElement?.closest(DISCLOSURE_SELECTOR);
    const parent = ancestor?.closest(OWNER_SELECTOR) === owner ? ancestor : owner;
    const index = childCounts.get(parent) ?? 0;
    childCounts.set(parent, index + 1);
    const parentPath = paths.get(parent);
    const path = parentPath === undefined ? String(index) : `${parentPath}.${index}`;
    paths.set(details, path);
    locations.push({ details, key: JSON.stringify([ownerId, path]) });
  });

  return locations;
}

function activeElement(root: DisclosureRoot): Element | null {
  const focusRoot = root.getRootNode();
  return 'activeElement' in focusRoot
    ? (focusRoot as Document | ShadowRoot).activeElement
    : root.ownerDocument.activeElement;
}

/** Keeps only disclosure presentation choices within one native history identity. */
export class MessageDisclosureState {
  private scope: string | null = null;
  private readonly states = new Map<string, boolean>();
  private summaryFocus: SummaryFocus | null = null;

  constructor(private readonly maxEntries = MAX_DISCLOSURE_STATES) {}

  reset(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.clear();
  }

  clear(): void {
    this.states.clear();
    this.summaryFocus = null;
  }

  capture(root: DisclosureRoot): void {
    this.summaryFocus = null;
    if (this.scope === null) return;

    const focused = activeElement(root);
    const selection = root.ownerDocument.defaultView?.getSelection();
    const canRestoreFocus = !selection || selection.isCollapsed;

    for (const { details, key } of disclosureLocations(root)) {
      // No toggle listener: restoring open or search expansion cannot reverse a choice.
      this.states.delete(key);
      this.states.set(key, details.open);
      const summary = details.firstElementChild;
      if (canRestoreFocus && summary?.localName === 'summary' && summary === focused) {
        this.summaryFocus = { key, document: root.ownerDocument };
      }
    }

    while (this.states.size > Math.max(0, this.maxEntries)) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }

  restore(root: DisclosureRoot): void {
    const focus = this.summaryFocus;
    this.summaryFocus = null;
    if (this.scope === null) return;

    let focusedSummary: HTMLElement | null = null;
    for (const { details, key } of disclosureLocations(root)) {
      const open = this.states.get(key);
      // First presentation keeps the Markdown's own default, including <details open>.
      if (open === undefined) continue;
      if (details.open !== open) details.open = open;
      const summary = details.firstElementChild;
      if (focus?.key === key && summary?.localName === 'summary') {
        focusedSummary = summary as HTMLElement;
      }
    }

    if (focus?.document === root.ownerDocument && focusedSummary?.isConnected) {
      focusedSummary.focus({ preventScroll: true });
    }
  }
}

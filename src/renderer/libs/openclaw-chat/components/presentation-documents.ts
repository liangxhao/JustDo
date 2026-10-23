import { readSurfaceOcclusion } from '@/shared/dom/surfaceOcclusion';
import { readWorkspacePresentation } from '@/shared/dom/workspacePresentation';

/** Observe each document that currently hosts a retained presentation. */
export class PresentationDocuments {
  private readonly observed = new Map<Document, () => void>();

  constructor(
    private readonly owner: Document,
    private readonly changed: () => void,
    private readonly contains: (target: Node) => boolean,
  ) {
    this.sync([]);
  }

  sync(documents: Iterable<Document>): void {
    const active = new Set([this.owner, ...documents]);
    for (const [doc, dispose] of this.observed) {
      if (active.has(doc)) continue;
      dispose();
      this.observed.delete(doc);
    }
    for (const doc of active) {
      if (this.observed.has(doc)) continue;
      const owner = doc.defaultView as (Window & typeof globalThis) | null;
      if (!owner || !doc.body) continue;
      const observer = new owner.MutationObserver(records => {
        if (records.some(record => !this.contains(record.target))) this.changed();
      });
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'class',
          'style',
          'open',
          'hidden',
          'inert',
          'aria-hidden',
          'data-workspace-overlay',
          'data-workspace-occlusion',
        ],
      });
      owner.addEventListener('resize', this.changed);
      doc.addEventListener('scroll', this.changed, true);
      this.observed.set(doc, () => {
        observer.disconnect();
        owner.removeEventListener('resize', this.changed);
        doc.removeEventListener('scroll', this.changed, true);
      });
    }
  }
}

export const presentationParent = (element: Element): Element | null =>
  element.parentElement ?? ((element.getRootNode() as ShadowRoot).host || null);

export function presentationTargetVisible(target: HTMLElement): boolean {
  const owner = target.ownerDocument.defaultView;
  if (!owner || !target.isConnected || !target.getClientRects().length) return false;
  if (
    typeof target.checkVisibility === 'function' &&
    !target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return false;
  for (let element: Element | null = target; element; element = presentationParent(element)) {
    if (element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true')
      return false;
    const style = owner.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    )
      return false;
  }
  return true;
}

/** Recheck the live source at RPC admission, including native parent visibility. */
export function presentationSurfaceVisible(
  source: Document,
  target: HTMLElement | undefined,
  expanded: boolean,
  ignoredOverlay?: Element,
): boolean {
  if (!target || !presentationTargetVisible(target)) return false;
  const doc = target.ownerDocument;
  const owner = doc.defaultView as Window & typeof globalThis;
  const rect = expanded
    ? new owner.DOMRect(0, 0, owner.innerWidth, owner.innerHeight)
    : target.getBoundingClientRect();
  if (readSurfaceOcclusion(rect, doc, ignoredOverlay).occluded) return false;
  if (doc === source) return true;
  const workspace = readWorkspacePresentation(doc);
  if (!workspace || workspace.slot?.ownerDocument !== source) return false;
  const sourceRect = workspace.slot.getBoundingClientRect();
  const occlusion = readSurfaceOcclusion(sourceRect, source);
  return workspace.detached
    ? !occlusion.blocked
    : workspace.open && presentationTargetVisible(workspace.slot) && !occlusion.occluded;
}

/** Resize delivery must follow the actual viewer document, including detached windows. */
export function observePresentationSize(element: HTMLElement, changed: () => void) {
  let owner: (Window & typeof globalThis) | undefined;
  let observer: ResizeObserver | undefined;
  const sync = () => {
    const current = element.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (!current || current === owner) return;
    observer?.disconnect();
    owner = current;
    observer = new current.ResizeObserver(changed);
    observer.observe(element);
  };
  sync();
  return { sync, disconnect: () => observer?.disconnect() };
}

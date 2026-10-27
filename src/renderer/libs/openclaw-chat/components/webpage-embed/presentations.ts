import type { WebpageEmbedApi } from '@shared/browser/webpageEmbed';

import { i18nService } from '@/services/i18n';
import { NativePresentationSurface } from '@/shared/dom/nativePresentationSurface';
import { readSurfaceOcclusion } from '@/shared/dom/surfaceOcclusion';

import type { WebpageEmbedPreview } from '../../pipeline/embed-presentation';
import {
  observePresentationSize,
  PresentationDocuments,
  presentationParent as parentElement,
  presentationTargetVisible,
} from '../presentation-documents';
import type { WebpageEmbedContext } from './context';
import { WEBPAGE_EMBED_CHROME_HEIGHT, webpageEmbedKey, WebpageEmbedView } from './page-view';

export const WEBPAGE_EMBED_REFERENCE_TAB_PREFIX = 'webpage-reference:';

export interface WebpageEmbedPresentationAnchor extends HTMLElement {
  presentationChanged: () => void;
}

export interface WebpageEmbedPresentation {
  readonly id: string;
  readonly scope: string;
  owner: object;
  context: WebpageEmbedContext;
  preview: WebpageEmbedPreview;
  readonly view: WebpageEmbedView;
  readonly layer: HTMLDivElement;
  readonly anchors: Set<WebpageEmbedPresentationAnchor>;
  pinned: boolean;
  returnPending: boolean;
  primary?: WebpageEmbedPresentationAnchor;
  sidebar?: HTMLElement;
  height: number;
  visible: boolean;
  surface?: NativePresentationSurface;
  dispose: () => void;
}

const hosts = new WeakMap<Document, WebpageEmbedPresentations>();

export function getWebpageEmbedPresentations(
  owner: Document = document,
): WebpageEmbedPresentations {
  let host = hosts.get(owner);
  if (!host) {
    host = new WebpageEmbedPresentations(owner);
    hosts.set(owner, host);
  }
  return host;
}

const scopeOf = (context: WebpageEmbedContext) => context.presentationScope ?? context.sessionKey;

function sameIdentity(left: WebpageEmbedContext, right: WebpageEmbedContext): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.sessionId === right.sessionId &&
    scopeOf(left) === scopeOf(right)
  );
}

/** Native surfaces keep the original viewer document while their parent presentation moves. */
export class WebpageEmbedPresentations {
  readonly entries: WebpageEmbedPresentation[] = [];
  private sequence = 0;
  private frame?: number;
  private consumers = 0;
  private readonly listeners = new Set<() => void>();
  private readonly revealListeners = new Set<(entry: WebpageEmbedPresentation) => void>();
  private readonly ownerWindow: Window & typeof globalThis;
  private readonly documents: PresentationDocuments;
  private readonly syncSize = new WeakMap<WebpageEmbedPresentation, () => void>();

  constructor(readonly owner: Document) {
    this.ownerWindow = owner.defaultView as Window & typeof globalThis;
    this.documents = new PresentationDocuments(owner, this.requestLayout, target =>
      this.entries.some(entry => entry.layer.contains(target)),
    );
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onReveal = (listener: (entry: WebpageEmbedPresentation) => void) => {
    this.revealListeners.add(listener);
    return () => {
      this.revealListeners.delete(listener);
    };
  };

  retainWorkspace = () => {
    this.consumers++;
    return () => {
      this.consumers--;
      this.ownerWindow.setTimeout(() => {
        if (this.consumers) return;
        for (const entry of [...this.entries]) {
          if (!entry.context.presentationScope) continue;
          this.entries.splice(this.entries.indexOf(entry), 1);
          entry.dispose();
        }
        this.changed();
      }, 0);
    };
  };

  private changed(): void {
    for (const entry of this.entries)
      for (const anchor of entry.anchors) anchor.presentationChanged();
    for (const listener of this.listeners) listener();
    this.requestLayout();
  }

  acquire(
    anchor: WebpageEmbedPresentationAnchor,
    preview: WebpageEmbedPreview,
    context: WebpageEmbedContext,
    api: WebpageEmbedApi | undefined,
  ): WebpageEmbedPresentation | undefined {
    if (!context.isCurrent() || !api || anchor.ownerDocument !== this.owner) return;
    const owner = context.presentationOwner ?? anchor.getRootNode();
    let entry = this.entries.find(
      item =>
        item.owner === owner &&
        webpageEmbedKey(item.preview) === webpageEmbedKey(preview) &&
        sameIdentity(item.context, context),
    );
    if (!entry && context.presentationScope && context.sessionId?.trim()) {
      // React can replace the chat element while retaining its authenticated
      // native session. Recover only an inactive retained tab with that exact
      // incarnation; a new owner cannot take over a currently active viewer.
      entry = this.entries.find(
        item =>
          (item.pinned || item.returnPending) &&
          !item.view.context?.isCurrent() &&
          webpageEmbedKey(item.preview) === webpageEmbedKey(preview) &&
          sameIdentity(item.context, context),
      );
      if (entry) {
        entry.owner = owner;
        entry.primary = anchor;
      }
    }
    if (!entry) {
      const view = new WebpageEmbedView();
      view.preview = preview;
      view.context = context;
      view.api = api;
      const layer = this.owner.createElement('div');
      layer.dataset.webpageEmbedPresentation = webpageEmbedKey(preview);
      layer.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:10';
      view.style.cssText = 'margin:0;max-width:none;pointer-events:auto';
      layer.append(view);
      entry = {
        id: `${WEBPAGE_EMBED_REFERENCE_TAB_PREFIX}${++this.sequence}`,
        scope: scopeOf(context),
        owner,
        context,
        preview,
        view,
        layer,
        anchors: new Set(),
        pinned: false,
        returnPending: false,
        height: (preview.preferredHeight ?? 420) + WEBPAGE_EMBED_CHROME_HEIGHT,
        visible: false,
        dispose: () => undefined,
      };
      const current = entry;
      if (context.presentationScope) view.pinPresentation = () => this.pin(current);
      view.presentationChanged = this.requestLayout;
      const resize = observePresentationSize(view, () => {
        if (!current.pinned && !view.expanded && view.getClientRects().length) {
          const height = view.getBoundingClientRect().height;
          if (height > 0) current.height = height;
        }
        this.requestLayout();
      });
      this.syncSize.set(current, resize.sync);
      current.surface = NativePresentationSurface.create(layer, () => {
        if (current.surface?.ready) resize.sync();
        this.changed();
      });
      if (!current.surface) this.owner.body.append(layer);
      current.dispose = () => {
        resize.disconnect();
        view.pinPresentation = undefined;
        view.presentationChanged = undefined;
        current.surface?.dispose();
        layer.remove();
      };
      this.entries.push(current);
    }
    entry.context = context;
    entry.preview = preview;
    entry.view.preview = preview;
    entry.view.context = context;
    entry.view.api = api;
    const fresh = !entry.anchors.has(anchor);
    entry.anchors.add(anchor);
    if (!entry.primary?.isConnected) entry.primary = anchor;
    if (!entry.pinned && entry.returnPending) entry.returnPending = false;
    if (fresh) this.changed();
    return entry;
  }

  release(anchor: WebpageEmbedPresentationAnchor, entry: WebpageEmbedPresentation): void {
    entry.anchors.delete(anchor);
    if (entry.primary === anchor)
      entry.primary = [...entry.anchors].find(value => value.isConnected);
    this.ownerWindow.setTimeout(() => {
      if (!entry.anchors.size && !entry.pinned && !entry.returnPending) {
        const index = this.entries.indexOf(entry);
        if (index >= 0) {
          this.entries.splice(index, 1);
          entry.dispose();
          this.changed();
        }
      }
    }, 0);
    this.requestLayout();
  }

  title(entry: WebpageEmbedPresentation): string {
    return entry.preview.title?.trim() || i18nService.t('webpageEmbedTitle');
  }

  pin(entry: WebpageEmbedPresentation): void {
    if (!this.entries.includes(entry) || !entry.context.presentationScope || !entry.view.canPin)
      return;
    entry.view.collapsePresentation();
    entry.pinned = true;
    entry.returnPending = false;
    entry.view.fillContainer = true;
    this.changed();
    this.reveal(entry);
  }

  unpin(entry: WebpageEmbedPresentation): void {
    if (!this.entries.includes(entry)) return;
    entry.pinned = false;
    entry.sidebar = undefined;
    entry.returnPending = !entry.primary?.isConnected;
    entry.view.fillContainer = false;
    entry.view.collapsePresentation();
    this.changed();
  }

  reveal(entry: WebpageEmbedPresentation): void {
    if (!this.entries.includes(entry) || !entry.view.context?.isCurrent()) return;
    if (entry.pinned) for (const listener of this.revealListeners) listener(entry);
    else entry.primary?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.requestLayout();
  }

  setSidebar(entry: WebpageEmbedPresentation, target?: HTMLElement): void {
    if (!this.entries.includes(entry)) return;
    if (target && target.ownerDocument !== this.owner && !entry.surface) return;
    entry.sidebar = target;
    if (!target) this.setVisible(entry, false);
    this.requestLayout();
  }

  retrySurface(entry: WebpageEmbedPresentation): void {
    if (!this.entries.includes(entry) || !entry.surface?.failed || !entry.view.context?.isCurrent())
      return;
    entry.surface.dispose();
    this.owner.adoptNode(entry.layer);
    entry.surface = NativePresentationSurface.create(entry.layer, () => {
      if (entry.surface?.ready) this.syncSize.get(entry)?.();
      this.changed();
    });
    this.changed();
  }

  /** The owning chat refreshes retained webpages even after history anchors disappear. */
  refresh(owner: object, context?: WebpageEmbedContext): void {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.owner !== owner) continue;
      const next =
        context?.isCurrent() && sameIdentity(entry.context, context) ? context : undefined;
      if (entry.view.context !== next) {
        const previous = entry.view.context;
        const availabilityChanged =
          Boolean(previous) !== Boolean(next) ||
          Boolean(previous?.isCurrent()) !== Boolean(next?.isCurrent());
        entry.view.context = next;
        entry.view.refreshPresentation();
        // Each chat render captures fresh callbacks. Refresh the viewer's live
        // permissions without sending equivalent captures back through React.
        changed ||= availabilityChanged;
      }
    }
    if (changed) this.changed();
    else this.requestLayout();
  }

  reconcileScopes(scopes: ReadonlySet<string>): void {
    let removed = false;
    for (const entry of [...this.entries]) {
      if (!entry.context.presentationScope || scopes.has(entry.scope)) continue;
      this.entries.splice(this.entries.indexOf(entry), 1);
      entry.dispose();
      removed = true;
    }
    if (removed) this.changed();
  }

  requestLayout = (): void => {
    this.documents?.sync(
      this.entries.flatMap(entry => [
        entry.layer.ownerDocument,
        ...(entry.sidebar ? [entry.sidebar.ownerDocument] : []),
      ]),
    );
    if (this.frame !== undefined) return;
    // Main's RAF can stop while a detached workspace remains interactive.
    this.frame = this.ownerWindow.setTimeout(() => {
      this.frame = undefined;
      this.layout();
    }, 16);
  };

  private setVisible(entry: WebpageEmbedPresentation, visible: boolean): void {
    if (!visible) entry.surface?.hide();
    if (!visible && entry.layer.style.display !== 'none') entry.layer.style.display = 'none';
    if (entry.visible === visible) return;
    entry.visible = visible;
    entry.view.refreshPresentation();
  }

  private setLayerStyle(entry: WebpageEmbedPresentation, style: string): void {
    if (entry.layer.getAttribute('style') !== style) entry.layer.setAttribute('style', style);
  }

  layout = (): void => {
    for (const entry of this.entries) {
      const target = entry.pinned ? entry.sidebar : entry.primary;
      const view = entry.view;
      if (
        !target ||
        !view.context?.isCurrent() ||
        !presentationTargetVisible(target) ||
        entry.surface?.failed
      ) {
        this.setVisible(entry, false);
        continue;
      }
      const doc = target.ownerDocument;
      const owner = doc.defaultView as Window & typeof globalThis;
      const rect = target.getBoundingClientRect();
      const surface = view.expanded
        ? new owner.DOMRect(0, 0, owner.innerWidth, owner.innerHeight)
        : rect;
      // Ignore this webpage's own modal marker, while respecting other surfaces
      // and the source's visibility even when its viewer is in the top layer.
      if (
        readSurfaceOcclusion(surface, doc, entry.surface?.overlay ?? view.presentationOverlay)
          .occluded ||
        (doc !== this.owner && readSurfaceOcclusion(rect, this.owner).blocked)
      ) {
        this.setVisible(entry, false);
        continue;
      }
      entry.surface?.setExpanded(view.expanded ? doc : undefined);
      if (view.expanded && !entry.surface) {
        this.setLayerStyle(entry, 'position:fixed;inset:0;pointer-events:none;z-index:60');
        this.setVisible(entry, true);
        continue;
      }
      const bounds = view.expanded ? surface : rect;
      let top = Math.max(0, bounds.top),
        left = Math.max(0, bounds.left);
      const height = view.expanded ? bounds.height : entry.pinned ? rect.height : entry.height;
      let bottom = Math.min(owner.innerHeight, bounds.top + height);
      let right = Math.min(owner.innerWidth, bounds.right);
      for (
        let parent = view.expanded ? null : parentElement(target);
        parent;
        parent = parentElement(parent)
      ) {
        const style = owner.getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
          const bounds = parent.getBoundingClientRect();
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
      }
      if (bounds.width <= 0 || bottom <= top || right <= left) {
        this.setVisible(entry, false);
        continue;
      }
      if (entry.surface) {
        this.setLayerStyle(entry, 'position:fixed;inset:0;pointer-events:none');
        entry.surface.present(target, {
          x: bounds.left,
          y: bounds.top,
          width: bounds.width,
          height,
          clip: { x: left, y: top, width: right - left, height: bottom - top },
          visible: true,
          occluded: false,
        });
      } else {
        this.setLayerStyle(
          entry,
          `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${height}px;pointer-events:none;z-index:${entry.pinned ? 51 : 10};clip-path:inset(${top - rect.top}px ${rect.right - right}px ${rect.top + height - bottom}px ${left - rect.left}px)`,
        );
      }
      view.fillContainer = entry.pinned;
      if (entry.primary && !entry.pinned && entry.primary.style.height !== `${entry.height}px`)
        entry.primary.style.height = `${entry.height}px`;
      this.setVisible(entry, !entry.surface || entry.surface.ready);
    }
  };
}

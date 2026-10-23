import {
  MCP_APP_REFERENCE_TAB_PREFIX,
  type McpAppContentReference,
  sameMcpAppContent,
} from '@shared/plugins/mcpAppReferences';
import { McpAppEvent, type McpAppPreview } from '@shared/plugins/mcpApps';

import { NativePresentationSurface } from '@/shared/dom/nativePresentationSurface';
import { readSurfaceOcclusion } from '@/shared/dom/surfaceOcclusion';

import type { McpAppSessionView } from '../../gateway/mcp-app/mcp-app-session';
import { isNativeAppReference } from '../../pipeline/native-app-reference';
import { readNativeMcpAppIdentity } from '../../pipeline/native-mcp-app';
import {
  observePresentationSize,
  PresentationDocuments,
  presentationParent as parentElement,
  presentationSurfaceVisible,
  presentationTargetVisible,
} from '../presentation-documents';
import { readRecoveredAppContent } from './plugin-content';
import { McpAppView, type McpAppViewContext } from './view';

export interface McpAppPresentationAnchor extends HTMLElement {
  presentationChanged: () => void;
}

export interface McpAppPresentation {
  readonly id: string;
  readonly scope: string;
  readonly binding: McpAppSessionView;
  readonly preview: McpAppPreview;
  readonly view: McpAppView;
  readonly layer: HTMLDivElement;
  readonly anchors: Set<McpAppPresentationAnchor>;
  readonly ordinal: number;
  pinned: boolean;
  returnPending: boolean;
  primary?: McpAppPresentationAnchor;
  sidebar?: HTMLElement;
  height: number;
  visible: boolean;
  surface?: NativePresentationSurface;
  dispose: () => void;
}

const hosts = new WeakMap<Document, McpAppPresentations>();
export const getMcpAppPresentations = (owner: Document = document): McpAppPresentations => {
  let host = hosts.get(owner);
  if (!host) {
    host = new McpAppPresentations(owner);
    hosts.set(owner, host);
  }
  return host;
};

/** Authenticated viewers keep their original document as native presentation parents move. */
export class McpAppPresentations {
  readonly entries: McpAppPresentation[] = [];
  private sequence = 0;
  private readonly ordinals = new Map<string, number>();
  private readonly targetOrdinals = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly revealListeners = new Set<(entry: McpAppPresentation) => void>();
  private frame?: number;
  private consumers = 0;
  private readonly ownerWindow: Window & typeof globalThis;
  private readonly documents: PresentationDocuments;
  private readonly syncSize = new WeakMap<McpAppPresentation, () => void>();

  constructor(readonly owner: Document) {
    this.ownerWindow = owner.defaultView as Window & typeof globalThis;
    this.documents = new PresentationDocuments(owner, this.schedule, target =>
      this.entries.some(entry => entry.layer.contains(target)),
    );
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onReveal = (listener: (entry: McpAppPresentation) => void) => {
    this.revealListeners.add(listener);
    return () => {
      this.revealListeners.delete(listener);
    };
  };

  retainWorkspace = () => {
    this.consumers++;
    return () => {
      this.consumers--;
      // React StrictMode can release and immediately reacquire the same host.
      this.ownerWindow.setTimeout(() => {
        if (this.consumers) return;
        for (const entry of this.entries.splice(0)) entry.dispose();
        this.ordinals.clear();
        this.targetOrdinals.clear();
        this.changed();
      }, 0);
    };
  };

  private changed() {
    for (const entry of this.entries)
      for (const anchor of entry.anchors) anchor.presentationChanged();
    for (const listener of this.listeners) listener();
    this.schedule();
  }

  acquire(anchor: McpAppPresentationAnchor, preview: McpAppPreview, context: McpAppViewContext) {
    const identity = readNativeMcpAppIdentity(preview);
    if (
      !identity ||
      !context.isCurrent() ||
      !context.apps.ready ||
      anchor.ownerDocument !== this.owner
    )
      return;
    const binding = context.apps.bind();
    if (!binding.sessionId) return;
    let entry = this.entries.find(
      item =>
        item.preview.viewId === preview.viewId &&
        item.view.context?.apps === context.apps &&
        item.binding.sameNativeIdentity(binding) &&
        Object.entries(identity).every(
          ([key, value]) =>
            readNativeMcpAppIdentity(item.preview)?.[key as keyof typeof identity] === value,
        ),
    );
    const incomingContent = readRecoveredAppContent(preview, binding);
    entry ??= this.entries.find(item => {
      if (item.view.context?.apps !== context.apps || !item.binding.sameNativeIdentity(binding))
        return false;
      const content = item.view.contentIdentity ?? readRecoveredAppContent(item.preview, binding);
      if (!content) return false;
      if (incomingContent) return sameMcpAppContent(content, incomingContent);
      // Returning original history only locates the authenticated recovered
      // instance. Its read-only capabilities and native binding stay intact.
      return (
        content.originViewId === identity.viewId &&
        content.serverName === identity.serverName &&
        content.uiResourceUri === identity.uiResourceUri &&
        identity.originSessionKey === content.sessionKey &&
        binding.sessionKey === content.sessionKey &&
        binding.sessionId === content.sessionId &&
        binding.agentId === content.agentId
      );
    });
    if (!entry) {
      const view = new McpAppView();
      view.preview = preview;
      view.context = context;
      const layer = this.owner.createElement('div');
      layer.dataset.mcpAppPresentation = preview.viewId;
      layer.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:10';
      view.style.cssText = 'margin:0;max-width:none;pointer-events:auto';
      layer.append(view);
      const namespace = JSON.stringify([
        context.presentationScope,
        binding.sessionKey,
        binding.sessionId,
        identity.serverName,
      ]);
      const ordinalKey = JSON.stringify([
        namespace,
        identity.uiResourceUri,
        incomingContent?.originViewId ?? identity.viewId,
      ]);
      const ordinal =
        this.targetOrdinals.get(ordinalKey) ?? (this.ordinals.get(namespace) ?? 0) + 1;
      this.targetOrdinals.set(ordinalKey, ordinal);
      this.ordinals.set(namespace, Math.max(this.ordinals.get(namespace) ?? 0, ordinal));
      entry = {
        id: `${MCP_APP_REFERENCE_TAB_PREFIX}${++this.sequence}`,
        scope: context.presentationScope ?? context.sessionKey,
        binding,
        preview,
        view,
        layer,
        anchors: new Set(),
        ordinal,
        pinned: false,
        returnPending: false,
        height: 646,
        visible: false,
        dispose: () => undefined,
      };
      const current = entry;
      view.pinPresentation = () => this.pin(current);
      view.revealCanvas = () => this.reveal(current);
      view.presentationVisible = () =>
        current.visible &&
        presentationSurfaceVisible(
          this.owner,
          current.pinned ? current.sidebar : current.primary,
          view.expanded,
          current.surface?.overlay,
        );
      const resize = observePresentationSize(view, () => {
        if (!current.pinned && !view.expanded && view.getClientRects().length) {
          const height = view.getBoundingClientRect().height;
          if (height > 0) current.height = height;
        }
        this.schedule();
      });
      this.syncSize.set(current, resize.sync);
      current.surface = NativePresentationSurface.create(layer, () => {
        if (current.surface?.ready) resize.sync();
        this.changed();
      });
      if (!current.surface) this.owner.body.append(layer);
      const changed = () => this.changed();
      view.addEventListener(McpAppEvent.PresentationChanged, changed);
      const displayMode = (event: Event) => {
        if (!current.pinned || !current.sidebar) return;
        event.stopPropagation();
        current.sidebar.dispatchEvent(
          new CustomEvent(McpAppEvent.DisplayMode, {
            bubbles: true,
            composed: true,
            detail: { ...(event as CustomEvent).detail, view },
          }),
        );
      };
      view.addEventListener(McpAppEvent.DisplayMode, displayMode);
      const stop = context.apps.subscribe(() =>
        queueMicrotask(() => {
          // invalidate() publishes before the controller finishes switching owner.
          if (!this.entries.includes(current)) return;
          view.resume(undefined, true);
          this.changed();
        }),
      );
      current.dispose = () => {
        stop();
        resize.disconnect();
        view.removeEventListener(McpAppEvent.PresentationChanged, changed);
        view.removeEventListener(McpAppEvent.DisplayMode, displayMode);
        current.surface?.dispose();
        layer.remove();
      };
      this.entries.push(current);
    }
    // Equivalent captures from sibling cards must not replace each other on
    // every Lit update. Only a paused, exact native owner needs a new capture.
    if (!entry.view.context?.isCurrent()) entry.view.resume(context);
    const fresh = !entry.anchors.has(anchor);
    entry.anchors.add(anchor);
    if (!entry.primary?.isConnected) entry.primary = anchor;
    if (!entry.pinned && entry.returnPending) {
      entry.returnPending = false;
      entry.view.setPresentationRetention(false);
    }
    if (fresh) this.changed();
    return entry;
  }

  release(anchor: McpAppPresentationAnchor, entry: McpAppPresentation) {
    entry.anchors.delete(anchor);
    if (entry.primary === anchor)
      entry.primary = [...entry.anchors].find(value => value.isConnected);
    // Live rows and authenticated history may replace each other in the same turn.
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
    this.schedule();
  }

  find(view: McpAppView) {
    return this.entries.find(entry => entry.view === view);
  }

  findReference(reference: McpAppContentReference, context: McpAppViewContext) {
    if (!isNativeAppReference(reference) || !context.isCurrent() || !context.apps.ready) return;
    const binding = context.apps.bind();
    if (
      binding.sessionKey !== reference.content.sessionKey ||
      binding.sessionId !== reference.content.sessionId ||
      binding.agentId !== reference.content.agentId
    )
      return;
    return this.entries.find(entry => {
      const content = entry.view.contentIdentity ?? readRecoveredAppContent(entry.preview, binding);
      return (
        entry.view.context?.apps === context.apps &&
        entry.binding.sameNativeIdentity(binding) &&
        content &&
        sameMcpAppContent(content, reference.content)
      );
    });
  }

  title(entry: McpAppPresentation) {
    const title = entry.view.contentTitle ?? entry.preview.title;
    const descriptor = readNativeMcpAppIdentity(entry.preview);
    const multiple = this.entries.some(
      other =>
        other !== entry &&
        other.scope === entry.scope &&
        other.binding.sameNativeIdentity(entry.binding) &&
        readNativeMcpAppIdentity(other.preview)?.serverName === descriptor?.serverName,
    );
    return `${title}${multiple ? ` · #${entry.ordinal}` : ''}`;
  }

  pin(entry: McpAppPresentation) {
    if (!this.entries.includes(entry) || !entry.view.canReference) return;
    entry.pinned = true;
    entry.view.expanded = false;
    entry.view.setPresentationRetention(true);
    this.changed();
    this.reveal(entry);
  }

  unpin(entry: McpAppPresentation) {
    if (!this.entries.includes(entry)) return;
    entry.pinned = false;
    entry.sidebar = undefined;
    entry.returnPending = !entry.primary?.isConnected;
    entry.view.returnToMessage();
    entry.view.setPresentationRetention(entry.returnPending);
    this.changed();
  }

  reveal(entry: McpAppPresentation) {
    if (!this.entries.includes(entry) || !entry.view.context?.isCurrent()) return;
    if (entry.pinned) for (const listener of this.revealListeners) listener(entry);
    else entry.primary?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.schedule();
  }

  setSidebar(entry: McpAppPresentation, target?: HTMLElement) {
    if (!this.entries.includes(entry)) return;
    if (target && target.ownerDocument !== this.owner && !entry.surface) return;
    entry.sidebar = target;
    if (!target) this.setVisible(entry, false);
    this.schedule();
  }

  retrySurface(entry: McpAppPresentation): void {
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

  resume(scope: string) {
    for (const entry of this.entries) if (entry.scope === scope) entry.view.resume(undefined, true);
    this.schedule();
  }

  reconcileScopes(scopes: ReadonlySet<string>) {
    let removed = false;
    for (const entry of [...this.entries])
      if (!scopes.has(entry.scope)) {
        this.entries.splice(this.entries.indexOf(entry), 1);
        entry.dispose();
        removed = true;
      }
    for (const namespace of this.ordinals.keys())
      if (!scopes.has(JSON.parse(namespace)[0])) {
        this.ordinals.delete(namespace);
        for (const key of this.targetOrdinals.keys())
          if (JSON.parse(key)[0] === namespace) this.targetOrdinals.delete(key);
      }
    if (removed) this.changed();
  }

  requestLayout = () => this.schedule();

  private readonly schedule = () => {
    this.documents?.sync(
      this.entries.flatMap(entry => [
        entry.layer.ownerDocument,
        ...(entry.sidebar ? [entry.sidebar.ownerDocument] : []),
      ]),
    );
    if (this.frame !== undefined) return;
    this.frame = this.ownerWindow.setTimeout(() => {
      this.frame = undefined;
      this.layout();
    }, 16);
  };

  private setVisible(entry: McpAppPresentation, visible: boolean): void {
    if (!visible) {
      entry.surface?.hide();
      if (entry.layer.style.display !== 'none') entry.layer.style.display = 'none';
    }
    if (entry.visible === visible) return;
    entry.visible = visible;
    entry.view.refreshPresentation?.();
  }

  /** Called by anchor/target observers; it never reads the App's internal document. */
  layout = () => {
    for (const entry of this.entries) {
      const target = entry.pinned ? entry.sidebar : entry.primary;
      const view = entry.view;
      const active =
        target &&
        presentationTargetVisible(target) &&
        view.context?.isCurrent() &&
        !entry.surface?.failed;
      if (!active || !target) {
        this.setVisible(entry, false);
        continue;
      }
      const doc = target.ownerDocument;
      const owner = doc.defaultView as Window & typeof globalThis;
      const rect = target.getBoundingClientRect();
      const surface = view.expanded
        ? new owner.DOMRect(0, 0, owner.innerWidth, owner.innerHeight)
        : rect;
      if (
        readSurfaceOcclusion(surface, doc, entry.surface?.overlay).occluded ||
        (doc !== this.owner && readSurfaceOcclusion(rect, this.owner).blocked)
      ) {
        this.setVisible(entry, false);
        continue;
      }
      entry.surface?.setExpanded(view.expanded ? doc : undefined);
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
      const style = entry.surface
        ? 'position:fixed;inset:0;pointer-events:none'
        : view.expanded
          ? 'position:fixed;inset:0;pointer-events:none;z-index:60'
          : `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${height}px;pointer-events:none;z-index:${entry.pinned ? 51 : 10};clip-path:inset(${top - rect.top}px ${rect.right - right}px ${rect.top + height - bottom}px ${left - rect.left}px)`;
      // Other retained surfaces observe this document too. Stable geometry must
      // not publish another style mutation and wake their layout observers.
      if (entry.layer.getAttribute('style') !== style) entry.layer.setAttribute('style', style);
      if (entry.surface)
        entry.surface.present(target, {
          x: bounds.left,
          y: bounds.top,
          width: bounds.width,
          height,
          clip: { x: left, y: top, width: right - left, height: bottom - top },
          visible: true,
          occluded: false,
        });
      view.fillContainer = entry.pinned;
      if (entry.primary && !entry.pinned && entry.primary.style.height !== `${entry.height}px`)
        entry.primary.style.height = `${entry.height}px`;
      this.setVisible(entry, !entry.surface || entry.surface.ready);
    }
  };
}

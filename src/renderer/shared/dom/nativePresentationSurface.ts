import {
  type WorkspaceSurfaceGrant,
  WorkspaceSurfaceTarget,
  type WorkspaceSurfaceUpdate,
} from '@shared/cowork/workspaceWindow';

import { copyDocumentAppearance } from './copyDocumentAppearance';
import { forwardSurfaceKeyboard } from './surfaceKeyboard';

type SurfaceLayout = Omit<WorkspaceSurfaceUpdate, 'id' | 'target' | 'workspaceGeneration'>;

/** A presentation receipt owns only a native surface, never a tool or session identity. */
export class NativePresentationSurface {
  ready = false;
  failed = false;
  overlay?: HTMLElement;
  private grant?: WorkspaceSurfaceGrant;
  private disposed = false;
  private timer?: number;
  private cleanupAppearance?: () => void;
  private cleanupKeyboard?: () => void;
  private readonly unsubscribe: () => void;
  private lastUpdate?: string;
  private target?: HTMLElement;
  private layout?: SurfaceLayout;
  private readonly api: Window['electron']['workspaceWindow'];
  private readonly owner: Window & typeof globalThis;

  static create(layer: HTMLElement, changed: () => void): NativePresentationSurface | undefined {
    const owner = layer.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (typeof owner?.electron?.workspaceWindow?.prepareSurface !== 'function') return;
    return new NativePresentationSurface(layer, owner, changed);
  }

  private constructor(
    private readonly layer: HTMLElement,
    owner: Window & typeof globalThis,
    private readonly changed: () => void,
  ) {
    this.owner = owner;
    this.api = owner.electron.workspaceWindow;
    this.unsubscribe = this.api.onSurfaceInvalidated(({ id }) => {
      if (id === this.grant?.id) this.fail();
    });
    void this.api
      .prepareSurface()
      .then(grant => {
        if (!grant) throw new Error('Presentation surface unavailable');
        this.grant = grant;
        if (this.disposed || this.failed) {
          this.api.closeSurface(grant.id);
          return;
        }
        const host = this.owner.open(grant.url, grant.frameName);
        if (!host) throw new Error('Presentation document unavailable');
        let attempts = 0;
        const mount = () => {
          this.timer = undefined;
          if (this.disposed || this.failed || this.ready) return;
          let root: HTMLElement | null = null;
          try {
            if (host.document.URL === grant.url)
              root = host.document.getElementById('workspace-root');
          } catch {
            // The granted document may still be navigating for the first time.
          }
          if (!root) {
            if (++attempts > 250) {
              this.fail();
              return;
            }
            this.timer = this.owner.setTimeout(mount, 20);
            return;
          }
          const doc = root.ownerDocument;
          this.cleanupAppearance = copyDocumentAppearance(this.owner.document, doc);
          const keydown = (event: KeyboardEvent) =>
            forwardSurfaceKeyboard(event, doc, this.owner.document);
          doc.addEventListener('keydown', keydown);
          const visibility = () => this.changed();
          doc.addEventListener('visibilitychange', visibility);
          this.cleanupKeyboard = () => {
            doc.removeEventListener('keydown', keydown);
            doc.removeEventListener('visibilitychange', visibility);
          };
          // The viewer has never been connected. Its original context is already
          // captured, and its first iframe/bridge is created only in this document.
          root.append(this.layer);
          this.ready = true;
          this.changed();
          this.publish();
        };
        mount();
      })
      .catch(() => this.fail());
  }

  present(target: HTMLElement, layout: SurfaceLayout): void {
    this.target = target;
    this.layout = layout;
    this.publish();
  }

  hide(): void {
    this.setExpanded();
    if (this.layout) this.layout = { ...this.layout, visible: false };
    this.publish();
  }

  setExpanded(doc?: Document): void {
    if (this.overlay?.ownerDocument === doc) return;
    this.overlay?.remove();
    this.overlay = undefined;
    if (!doc) return;
    const overlay = doc.createElement('div');
    overlay.dataset.workspaceOverlay = 'true';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none';
    doc.body.append(overlay);
    this.overlay = overlay;
  }

  private publish(): void {
    if (!this.grant || !this.ready || this.failed || this.disposed || !this.target || !this.layout)
      return;
    const doc = this.target.ownerDocument;
    const workspace = doc !== this.owner.document;
    const update: WorkspaceSurfaceUpdate = {
      ...this.layout,
      id: this.grant.id,
      target: workspace ? WorkspaceSurfaceTarget.Workspace : WorkspaceSurfaceTarget.Main,
      ...(workspace
        ? { workspaceGeneration: new URL(doc.URL).searchParams.get('generation') ?? undefined }
        : {}),
    };
    const key = JSON.stringify(update);
    if (this.lastUpdate === key) return;
    this.lastUpdate = key;
    this.api.updateSurface(update);
  }

  private fail(): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.ready = false;
    if (this.timer !== undefined) this.owner.clearTimeout(this.timer);
    this.timer = undefined;
    // Disconnecting the original viewer revokes ports, pending confirmations and
    // async reads. A replacement runtime requires an explicit user retry.
    this.layer.remove();
    this.setExpanded();
    this.cleanupAppearance?.();
    this.cleanupKeyboard?.();
    if (this.grant) this.api.closeSurface(this.grant.id);
    this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.owner.clearTimeout(this.timer);
    this.unsubscribe();
    this.layer.remove();
    this.setExpanded();
    this.cleanupAppearance?.();
    this.cleanupKeyboard?.();
    if (this.grant) this.api.closeSurface(this.grant.id);
  }
}

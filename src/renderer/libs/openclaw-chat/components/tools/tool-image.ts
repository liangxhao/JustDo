import type { TranscriptImageArtifact } from '@shared/openclaw/artifacts';
import { html, LitElement, nothing, type PropertyValues } from 'lit';

import { i18nService } from '@/services/i18n';

import type { LoadedToolImage, ToolImageArtifactReader } from '../../gateway/history/tool-image-artifacts';
import { renderMessageImages } from '../message/message-render';

/** Reads an image only while its tool row is visible. */
export class ToolImage extends LitElement {
  static properties = {
    artifact: { attribute: false },
    readImage: { attribute: false },
    image: { state: true },
    failed: { state: true },
  };

  declare artifact: TranscriptImageArtifact | undefined;
  declare readImage: ToolImageArtifactReader | undefined;
  declare private image: LoadedToolImage | null;
  declare private failed: boolean;
  private observer?: IntersectionObserver;
  private visibilityRoot?: Node;
  private visible = false;
  private request?: AbortController;

  constructor() {
    super();
    this.image = null;
    this.failed = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const root = this.getRootNode();
    if (this.visibilityRoot === root) return;
    this.stopObserving();
    this.visibilityRoot = root;
    root.addEventListener('toggle', this.handleDisclosureToggle, true);
    const Observer = this.ownerDocument.defaultView?.IntersectionObserver;
    if (Observer) {
      const observer = new Observer(entries => {
        const entry = entries[entries.length - 1];
        if (entry && this.observer === observer) this.setVisible(entry.isIntersecting);
      });
      this.observer = observer;
      observer.observe(this);
    } else {
      this.setVisible(true);
    }
    this.requestUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    queueMicrotask(() => {
      // Keyed history rows can move within the same document.
      if (this.isConnected) return;
      this.stopObserving();
      this.image = null;
      this.failed = false;
    });
  }

  protected willUpdate(changes: PropertyValues) {
    const previous = changes.get('artifact') as TranscriptImageArtifact | undefined;
    if (
      changes.has('readImage') ||
      (changes.has('artifact') && (previous?.id !== this.artifact?.id ||
        previous?.messageSeq !== this.artifact?.messageSeq || previous?.mimeType !== this.artifact?.mimeType ||
        previous?.label !== this.artifact?.label))
    ) {
      this.cancelRead();
      this.image = null;
      this.failed = false;
    }
    this.loadIfVisible();
  }

  private readonly handleDisclosureToggle = (event: Event) => {
    const details = event.target as HTMLDetailsElement | null;
    if (details?.localName !== 'details' || !details.contains(this)) return;
    if (this.isVisible()) this.loadIfVisible();
    else this.cancelRead();
  };

  private stopObserving() {
    this.observer?.disconnect();
    this.observer = undefined;
    this.visibilityRoot?.removeEventListener('toggle', this.handleDisclosureToggle, true);
    this.visibilityRoot = undefined;
    this.setVisible(false);
  }

  private setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.loadIfVisible();
    else this.cancelRead();
  }

  private cancelRead() {
    this.request?.abort();
    this.request = undefined;
  }

  private isVisible(): boolean {
    return this.isConnected && this.visible && !this.closest('details:not([open])');
  }

  private loadIfVisible() {
    const { artifact, readImage } = this;
    if (!artifact || !readImage || !this.isVisible() || this.request || this.image || this.failed) return;
    const request = new AbortController();
    this.request = request;
    void readImage(artifact, request.signal).then(
      image => this.completeRead(request, image),
      () => this.completeRead(request, null),
    );
  }

  private completeRead(request: AbortController, image: LoadedToolImage | null) {
    if (this.request !== request) return;
    this.request = undefined;
    if (!this.isVisible()) return;
    this.image = image;
    this.failed = image === null;
  }

  private readonly retry = () => {
    this.failed = false;
    this.loadIfVisible();
  };

  private readonly imageFailed = (src: string) => {
    if (this.image?.url !== src) return;
    this.image = null;
    this.failed = true;
  };

  render() {
    if (!this.artifact || !this.readImage) return nothing;
    if (this.image) {
      return renderMessageImages([
        { kind: 'image', url: this.image.url, label: this.image.label ?? i18nService.t('coworkImagePreviewTitle') },
      ], true, undefined, this.imageFailed);
    }
    return html`
      <span role="status">${i18nService.t(this.failed ? 'coworkToolImageFailed' : 'coworkToolImageLoading')}</span>
      ${this.failed ? html`<button type="button" @click=${this.retry}>${i18nService.t('messageMediaRetry')}</button>` : nothing}
    `;
  }
}

if (!customElements.get('tool-image-artifact')) customElements.define('tool-image-artifact', ToolImage);

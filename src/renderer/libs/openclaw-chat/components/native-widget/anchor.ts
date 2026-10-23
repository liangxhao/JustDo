import { html, LitElement, nothing, type PropertyValues, svg } from 'lit';

import { i18nService } from '@/services/i18n';
import { TOKEN_CONTRACT } from '@/theme/tokens/contract';

import { isNativeCanvasPreview, type NativeCanvasPreview } from '../../pipeline/native-canvas';
import { NATIVE_WIDGET_CONTEXT_REQUEST, type NativeWidgetContext } from './host';
import { getNativeWidgetPresentations, type NativeWidgetPresentation } from './presentations';

/** Message rows locate a widget; its retained iframe belongs to the presentation. */
export class NativeWidgetAnchor extends LitElement {
  static properties = {
    preview: { attribute: false },
    context: { attribute: false },
  };

  declare preview?: NativeCanvasPreview;
  declare context?: NativeWidgetContext;
  private entry?: NativeWidgetPresentation;
  private stop?: () => void;
  private observer?: ResizeObserver;
  private mutations?: MutationObserver;
  private scrollRoot?: Node;
  private readonly layout = () => getNativeWidgetPresentations(this.ownerDocument).requestLayout();

  protected createRenderRoot(): ShadowRoot {
    const root = this.attachShadow({ mode: 'open' });
    const style = this.ownerDocument.createElement('style');
    style.textContent = `
      :host{display:block;width:100%;min-width:0;margin:12px auto;color:var(${TOKEN_CONTRACT['text-primary']},inherit)}
      .reference{box-sizing:border-box;display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 12px;border:1px solid var(${TOKEN_CONTRACT.border},#ddd);border-radius:12px;background:var(${TOKEN_CONTRACT.background},transparent);font:inherit;font-size:13px}
      .widget-icon{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;border-radius:7px;background:var(${TOKEN_CONTRACT.surface},#f4f4f5)}
      svg{width:16px;height:16px;flex-shrink:0}
      .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}
      .status{flex-shrink:0;padding:3px 7px;border-radius:6px;background:var(${TOKEN_CONTRACT.surface},#f4f4f5);font-size:11px;white-space:nowrap;color:var(${TOKEN_CONTRACT['text-secondary']},#666)}
      button{display:flex;align-items:center;gap:4px;flex-shrink:0;font:inherit;font-size:12px;white-space:nowrap;color:inherit;background:transparent;border:0;border-radius:6px;padding:6px 4px;cursor:pointer}button:hover{background:var(${TOKEN_CONTRACT.surface},#f4f4f5)}button:focus-visible{outline:2px solid var(${TOKEN_CONTRACT.primary},#666);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    `;
    root.append(style);
    this.renderOptions.renderBefore = null;
    return root;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.dispatchEvent(
      new CustomEvent(NATIVE_WIDGET_CONTEXT_REQUEST, { bubbles: true, composed: true }),
    );
    const manager = getNativeWidgetPresentations(this.ownerDocument);
    this.stop = manager.subscribe(this.presentationChanged);
    const owner = this.ownerDocument.defaultView as Window & typeof globalThis;
    this.observer = new owner.ResizeObserver(this.layout);
    this.observer.observe(this);
    this.scrollRoot = this.getRootNode();
    this.scrollRoot.addEventListener('scroll', this.layout, true);
    this.mutations = new owner.MutationObserver(this.layout);
    this.mutations.observe(this.scrollRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'open', 'hidden', 'inert', 'aria-hidden'],
    });
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop?.();
    this.stop = undefined;
    this.observer?.disconnect();
    this.mutations?.disconnect();
    this.scrollRoot?.removeEventListener('scroll', this.layout, true);
    if (this.entry) getNativeWidgetPresentations(this.ownerDocument).release(this, this.entry);
    this.entry = undefined;
  }

  presentationChanged = (): void => {
    this.requestUpdate();
  };

  protected willUpdate(_changes: PropertyValues): void {
    if (!this.isConnected) return;
    const manager = getNativeWidgetPresentations(this.ownerDocument);
    if (
      this.context?.presentationScope &&
      this.context.isCurrent() &&
      isNativeCanvasPreview(this.preview)
    ) {
      const next = manager.acquire(this, this.preview, this.context);
      if (next !== this.entry) {
        if (this.entry) manager.release(this, this.entry);
        this.entry = next;
      }
    } else if (this.entry) {
      manager.release(this, this.entry);
      this.entry = undefined;
    }
  }

  protected updated(): void {
    this.layout();
  }

  private open(): void {
    const entry = this.entry;
    if (!entry || !this.context?.isCurrent()) return;
    const manager = getNativeWidgetPresentations(this.ownerDocument);
    if (entry.surface?.failed) {
      manager.retrySurface(entry);
      return;
    }
    if (entry.pinned) manager.reveal(entry);
    else manager.pin(entry);
  }

  protected render() {
    // Standalone histories have no sidebar workspace. Preserve their own
    // stacking context, visibility and inert ancestors through normal DOM.
    if (
      !this.context?.presentationScope &&
      this.context?.isCurrent() &&
      isNativeCanvasPreview(this.preview)
    ) {
      if (this.style.height) this.style.height = '';
      return html`<justdo-native-widget
        style="margin:0;max-width:none"
        .preview=${this.preview}
        .context=${this.context}
      ></justdo-native-widget>`;
    }
    const entry = this.entry;
    if (entry?.primary === this && !entry.pinned && !entry.surface?.failed) {
      this.style.height = `${entry.height}px`;
      return nothing;
    }
    this.style.height = '';
    const t = (key: string) => i18nService.t(key);
    const title = this.preview?.title || t('coworkCanvasTitle');
    if (!entry)
      return html`<div class="reference" role="status">${t('coworkWidgetDisconnected')}</div>`;
    const label = t(
      entry.surface?.failed
        ? 'coworkWidgetRetry'
        : entry.pinned
          ? 'mcpAppsViewReference'
          : 'mcpAppsPin',
    );
    return html`<div class="reference">
      <span class="widget-icon" aria-hidden="true">
        ${svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M14 9v11"/></svg>`}
      </span>
      <span class="title" title=${title}>${title}</span>
      ${entry.surface?.failed ? html`<span class="status">${t('coworkWidgetDisconnected')}</span>` : entry.pinned ? html`<span class="status">${t('mcpAppsPinned')}</span>` : nothing}
      <button
        type="button"
        title=${`${label}: ${title}`}
        aria-label=${`${label}: ${title}`}
        ?disabled=${!this.context?.isCurrent() || (!entry.surface?.failed && !entry.pinned && !entry.view.canPin)}
        @click=${this.open}
      >
        ${label}
        ${svg`<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 12 4M5 4h7v7"/></svg>`}
      </button>
    </div>`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('native-widget-anchor'))
  customElements.define('native-widget-anchor', NativeWidgetAnchor);

import {
  WEBPAGE_EMBED_OPEN_LINK_EVENT,
  type WebpageEmbedApi,
  type WebpageEmbedMount,
} from '@shared/browser/webpageEmbed';
import { html, LitElement, nothing, type PropertyValues } from 'lit';

import { i18nService } from '@/services/i18n';
import { TOKEN_CONTRACT } from '@/theme/tokens/contract';

import {
  classifyEmbedPresentation,
  normalizeEmbedHeight,
  type WebpageEmbedPreview,
} from '../../pipeline/embed-presentation';
import type { WebpageEmbedContext } from './context';
import { type WebpageEmbedFrame, WebpageEmbedGuest } from './guest';

type Binding = {
  context: WebpageEmbedContext;
  key: string;
  mountId: string;
  version: number;
  api: WebpageEmbedApi;
};
export const WEBPAGE_EMBED_CHROME_HEIGHT = 40;

export const webpageEmbedKey = (preview: WebpageEmbedPreview) =>
  JSON.stringify([
    preview.url !== undefined ? ['url', preview.url] : ['ref', preview.ref ?? preview.viewId],
    preview.mcpApp !== undefined,
  ]);

export class WebpageEmbedView extends LitElement {
  static properties = {
    preview: { attribute: false },
    context: { attribute: false },
    api: { attribute: false },
    expanded: { type: Boolean, reflect: true },
    fillContainer: { type: Boolean, attribute: 'fill-container', reflect: true },
    state: { state: true },
  };
  declare preview?: WebpageEmbedPreview;
  declare context?: WebpageEmbedContext;
  /** Captured from the original application renderer before entering a native surface. */
  declare api?: WebpageEmbedApi;
  declare expanded: boolean;
  declare fillContainer: boolean;
  declare private state: 'loading' | 'initialized' | 'failure' | 'proxy-pending' | 'proxy-failed';
  pinPresentation?: () => void;
  presentationChanged?: () => void;
  private workspaceOverlay?: HTMLElement;
  private binding?: Binding;
  private mount?: WebpageEmbedMount;
  private guest?: WebpageEmbedGuest;
  private slowTimer?: ReturnType<typeof setTimeout>;
  private slow = false;
  private version = 0;

  constructor() {
    super();
    this.expanded = false;
    this.fillContainer = false;
    this.state = 'loading';
  }
  get presentationOverlay(): HTMLElement | undefined {
    return this.workspaceOverlay;
  }

  protected createRenderRoot(): ShadowRoot {
    const root = this.attachShadow({ mode: 'open' });
    const style = this.ownerDocument.createElement('style');
    style.textContent = `
      :host {
        display: block;
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        color: var(${TOKEN_CONTRACT['text-primary']}, inherit);
        font: inherit;
        font-size: 13px;
      }
      :host([fill-container]) { height: 100%; }
      :host([expanded]) { height: 100vh; }
      .card {
        position: static;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: var(--embed-height);
        max-width: none;
        max-height: none;
        margin: 0;
        padding: 0;
        color: inherit;
        border: 1px solid var(${TOKEN_CONTRACT['border-subtle']}, var(${TOKEN_CONTRACT.border}, #ddd));
        border-radius: 14px;
        overflow: hidden;
        background: var(${TOKEN_CONTRACT.background}, #fff);
      }
      .card:modal { position: fixed; width: calc(100vw - 48px); height: calc(100vh - 48px); margin: auto; }
      .card::backdrop { background: rgb(0 0 0 / 35%); }
      :host([fill-container]) .card:not(:modal) { height: 100%; border: 0; border-radius: 0; }
      header {
        display: flex;
        box-sizing: border-box;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 38px;
        padding: 4px 14px;
        border-bottom: 1px solid var(${TOKEN_CONTRACT['border-subtle']}, var(${TOKEN_CONTRACT.border}, #ddd));
        background: var(${TOKEN_CONTRACT['surface-raised']}, #f1f2f4);
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
      }
      .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .view-actions { display: flex; flex-shrink: 0; gap: 2px; }
      .view-actions button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        margin: 0;
        padding: 5px;
        border: 0;
        border-radius: 6px;
        color: var(${TOKEN_CONTRACT['text-secondary']}, #69717d);
      }
      .view-actions svg { width: 16px; height: 16px; }
      .view-actions button:hover { color: var(${TOKEN_CONTRACT['text-primary']}, inherit); background: var(${TOKEN_CONTRACT.surface}, #fff); }
      .body { position: relative; min-height: 0; flex: 1 1 0; }
      webview { display: flex; width: 100%; height: 100%; min-height: 48px; border: 0; }
      .status { padding: 20px 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
      .status p { margin: 12px 0; }
      .overlay { position: absolute; inset: 0; background: var(${TOKEN_CONTRACT.surface}, #fff); overflow: auto; }
      .hint { flex: 0 0 auto; padding: 7px 14px; color: var(${TOKEN_CONTRACT['text-secondary']}, #69717d); border-bottom: 1px solid var(${TOKEN_CONTRACT['border-subtle']}, var(${TOKEN_CONTRACT.border}, #ddd)); }
      button { font: inherit; color: inherit; background: transparent; border: 1px solid var(${TOKEN_CONTRACT.border}, #ddd); border-radius: 5px; padding: 5px 10px; cursor: pointer; }
      .status button { margin: 0 0 0 10px; }
      button:disabled { opacity: .45; cursor: default; }
      button:focus-visible { outline: 2px solid var(${TOKEN_CONTRACT.primary}, #287d68); outline-offset: 3px; }
    `;
    root.append(style);
    this.renderOptions.renderBefore = null;
    return root;
  }
  connectedCallback(): void {
    this.renderOptions.creationScope = this.ownerDocument;
    super.connectedCallback();
  }
  disconnectedCallback(): void {
    this.clear();
    super.disconnectedCallback();
  }
  private current(binding = this.binding): boolean {
    return Boolean(
      binding &&
      binding === this.binding &&
      this.api === binding.api &&
      this.isConnected &&
      this.version === binding.version &&
      this.context?.isCurrent() &&
      binding.context.isCurrent() &&
      this.context.sessionKey === binding.context.sessionKey &&
      this.context.sessionId === binding.context.sessionId &&
      this.context.presentationOwner === binding.context.presentationOwner &&
      this.context.presentationScope === binding.context.presentationScope &&
      this.preview &&
      webpageEmbedKey(this.preview) === binding.key,
    );
  }
  get canPin(): boolean {
    return Boolean(this.pinPresentation && this.current());
  }
  collapsePresentation(): void {
    this.workspaceOverlay?.remove();
    this.workspaceOverlay = undefined;
    if (!this.expanded) return;
    const dialog = this.renderRoot.querySelector('dialog');
    dialog?.close();
    dialog?.setAttribute('open', '');
    this.expanded = false;
  }
  refreshPresentation(): void {
    if (!this.context?.isCurrent()) this.collapsePresentation();
    this.requestUpdate();
  }
  private clear(): void {
    this.collapsePresentation();
    clearTimeout(this.slowTimer);
    this.slow = false;
    this.guest?.dispose();
    this.guest = undefined;
    const binding = this.binding;
    this.binding = undefined;
    this.mount = undefined;
    this.version++;
    if (binding) void binding.api.release(binding.mountId).catch(() => undefined);
  }
  private retry = (): void => {
    if (this.state === 'proxy-failed' && this.mount && this.current()) {
      const binding = this.binding!;
      void binding.api.retryProxy(binding.mountId).catch(() => {
        if (this.current(binding)) this.requestUpdate();
      });
      return;
    }
    this.clear();
    this.state = 'loading';
    this.requestUpdate();
  };
  private fail(binding: Binding): void {
    if (!this.current(binding)) return;
    clearTimeout(this.slowTimer);
    this.guest?.dispose();
    this.guest = undefined;
    this.mount = undefined;
    this.state = 'failure';
    void binding.api.release(binding.mountId).catch(() => undefined);
    this.requestUpdate();
  }
  protected willUpdate(_changes: PropertyValues): void {
    if (!this.isConnected) return;
    if (!this.context?.isCurrent() || !this.preview || !this.api) {
      if (this.binding) this.clear();
      return;
    }
    if (this.current()) return;
    this.clear();
    const presentation = classifyEmbedPresentation(this.preview);
    if (presentation.kind === 'unavailable') {
      this.state = 'failure';
      return;
    }
    const binding: Binding = {
      context: this.context,
      key: webpageEmbedKey(this.preview),
      mountId: crypto.randomUUID(),
      version: this.version,
      api: this.api,
    };
    this.binding = binding;
    this.state = 'loading';
    this.slowTimer = setTimeout(() => {
      if (this.current(binding) && this.state === 'loading') {
        this.slow = true;
        this.requestUpdate();
      }
    }, 10_000);
    void binding.api
      .prepare({
        mountId: binding.mountId,
        sessionKey: binding.context.sessionKey,
        ...(binding.context.sessionId ? { sessionId: binding.context.sessionId } : {}),
        ...(this.preview.url !== undefined
          ? { url: this.preview.url }
          : { ref: this.preview.ref ?? this.preview.viewId }),
      })
      .then(mount => {
        if (!this.current(binding)) {
          void binding.api.release(binding.mountId).catch(() => undefined);
          return;
        }
        if (mount.mountId !== binding.mountId || !mount.partition || !mount.viewerUrl)
          throw new Error('Invalid webpage mount');
        this.mount = mount;
        this.requestUpdate();
      })
      .catch(() => {
        this.fail(binding);
      });
  }
  protected updated(changes: PropertyValues): void {
    if (changes.has('expanded')) this.presentationChanged?.();
    const frame = this.renderRoot.querySelector<WebpageEmbedFrame>('webview');
    const binding = this.binding;
    if (!frame || !this.mount || this.guest || !binding || !this.current(binding)) return;
    this.guest = new WebpageEmbedGuest(frame, this.mount, binding.api, event => {
      if (!this.current(binding)) return;
      if (this.state === 'failure') return;
      if (event.type === WEBPAGE_EMBED_OPEN_LINK_EVENT) {
        this.openInBrowser(event.url);
        return;
      }
      if (event.type === 'failure') {
        this.fail(binding);
        return;
      } else if (event.type === 'proxy-failed') this.state = 'proxy-failed';
      else if (event.type === 'proxy-pending') this.state = 'proxy-pending';
      else if (event.type === 'initialized' || event.type === 'proxy-ready') {
        this.state = 'initialized';
        clearTimeout(this.slowTimer);
        this.slow = false;
      }
      this.requestUpdate();
    });
  }
  private openInBrowser(url: string): void {
    const context = this.context;
    if (!context?.isCurrent() || !context.openLink) return;
    this.collapsePresentation();
    context.openLink(url);
  }
  private open = (): void => {
    if (!this.context?.isCurrent() || !this.preview) return;
    const presentation = classifyEmbedPresentation(this.preview);
    if (presentation.kind === 'webpage') this.openInBrowser(presentation.url);
    // Authenticated hosted mounts expose no reusable credential or public URL.
  };
  private toggleExpanded = (): void => {
    if (this.expanded) {
      this.collapsePresentation();
      return;
    }
    const dialog = this.renderRoot.querySelector('dialog');
    if (!dialog || !this.context?.isCurrent()) return;
    // Top-layer promotion keeps the original webview and its page state.
    dialog.close();
    dialog.showModal();
    this.expanded = true;
    const overlay = this.ownerDocument.createElement('div');
    overlay.dataset.workspaceOverlay = 'true';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none';
    this.ownerDocument.body.append(overlay);
    this.workspaceOverlay = overlay;
  };
  private renderViewActions() {
    const t = (key: string) => i18nService.t(key);
    const current = this.context?.isCurrent() === true;
    const presentation = this.preview ? classifyEmbedPresentation(this.preview) : undefined;
    const expandLabel = t(this.expanded ? 'coworkWidgetCollapse' : 'coworkWidgetExpand');
    return html`<div class="view-actions">
      <button
        type="button"
        data-action="open"
        @click=${this.open}
        title=${presentation?.kind === 'hosted' ? t('webpageEmbedHostedOpenUnavailable') : t('webpageEmbedOpen')}
        aria-label=${t('webpageEmbedOpen')}
        ?disabled=${!current || !this.context?.openLink || presentation?.kind !== 'webpage'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M7 6.5h.01M10 6.5h.01M13 6.5h.01" />
        </svg>
      </button>
      ${this.pinPresentation && !this.fillContainer && !this.expanded
        ? html`<button
            type="button"
            data-action="pin"
            title=${t('mcpAppsPin')}
            aria-label=${t('mcpAppsPin')}
            ?disabled=${!this.canPin}
            @click=${() => {
              if (this.canPin) this.pinPresentation?.();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
              <path d="M14 3h7v7M21 3l-9 9M21 14v6H4V3h6" />
            </svg>
          </button>`
        : nothing}
      <button
        type="button"
        data-action="expand"
        title=${expandLabel}
        aria-label=${expandLabel}
        aria-expanded=${this.expanded}
        ?disabled=${!current}
        @click=${this.toggleExpanded}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
          <path d=${this.expanded
            ? 'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5'
            : 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'} />
        </svg>
      </button>
    </div>`;
  }
  protected render() {
    const t = (key: string) => i18nService.t(key);
    const current = this.context?.isCurrent() === true;
    const blocked = !current || this.state === 'failure' || this.state === 'proxy-failed';
    const message = !current
      ? t('webpageEmbedDisconnected')
      : this.state === 'proxy-failed'
        ? t('webpageEmbedProxyFailed')
        : t('webpageEmbedUnavailable');
    const height = normalizeEmbedHeight(this.preview?.preferredHeight) ?? 420;
    const title = this.preview?.title || t('webpageEmbedTitle');
    const externalPage = this.preview && classifyEmbedPresentation(this.preview).kind === 'webpage';
    return html`<dialog
      open
      class="card"
      role=${this.expanded ? 'dialog' : 'group'}
      aria-label=${title}
      aria-modal=${this.expanded ? 'true' : nothing}
      style=${`--embed-height:${height + WEBPAGE_EMBED_CHROME_HEIGHT}px`}
      @cancel=${(event: Event) => {
        event.preventDefault();
        this.collapsePresentation();
      }}
    >
      <header>
        <span class="title" title=${title}>${title}</span>
        ${this.renderViewActions()}
      </header>
      ${this.state === 'proxy-pending' ? html`<div class="hint" role="status">${t('webpageEmbedProxyPending')}</div>` : this.slow && !blocked ? html`<div class="hint" role="status">${t('webpageEmbedSlow')}</div>` : nothing}
      <div class="body">
        ${this.mount ? html`<webview partition=${this.mount.partition} ?allowpopups=${externalPage}></webview>` : nothing}
        ${blocked ? html`<div class="status overlay" role="status">${message}${this.preview?.fallbackText ? html`<p>${this.preview.fallbackText}</p>` : nothing}${current && (!this.mount || this.state === 'proxy-failed') ? html`<button type="button" @click=${this.retry}>${t('coworkWidgetRetry')}</button>` : nothing}</div>` : !this.mount ? html`<div class="status" role="status">${t('webpageEmbedLoading')}</div>` : nothing}
      </div>
    </dialog>`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('webpage-embed-view'))
  customElements.define('webpage-embed-view', WebpageEmbedView);

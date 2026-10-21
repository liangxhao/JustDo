import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

import { i18nService } from '@/services/i18n';

import { isNativeCanvasPreview, type NativeCanvasPreview } from '../../pipeline/native-canvas';
import { acceptWidgetDraft, acceptWidgetDraftText, widgetFrameInteractable } from './draft';
import { NativeWidgetGuestHost, type WidgetWebview } from './guest';
import {
  MAX_WIDGET_BYTES,
  NATIVE_WIDGET_CONTEXT_REQUEST,
  NATIVE_WIDGET_DRAFT_EVENT,
  type NativeWidgetContext,
  NativeWidgetSandboxHost,
  resolveNativeSandboxUrl,
  WIDGET_SLOW_NOTICE_MS,
} from './host';
import { postNativeWidgetMessage } from './messaging';
import { WidgetFailure, type WidgetFailureKind, widgetRebuildDraft } from './rebuild';
import { forwardWidgetScroll } from './scroll';

type Binding = { context: NativeWidgetContext; docId: string; version: number };
const pendingViews = new WeakMap<object, Map<string, Promise<unknown>>>();

function loadView(binding: Binding, isCurrent: () => boolean): Promise<unknown> {
  const { context, docId } = binding;
  let pending = pendingViews.get(context.client);
  if (!pending) {
    pending = new Map();
    pendingViews.set(context.client, pending);
  }
  const key = `${context.generation}\0${context.sessionKey}\0${docId}`;
  if (!isCurrent()) return Promise.reject(new Error('widget read superseded'));
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 32) {
    // Native history retains expired descriptors. Let those bounded reads settle
    // before loading later rows instead of marking the newest retained widgets as
    // unavailable merely because an earlier page filled the concurrent slots.
    return Promise.race([...pending.values()].map(request => request.catch(() => undefined))).then(
      () => loadView(binding, isCurrent),
    );
  }
  const request = context.client.request('canvas.document.view', { docId });
  pending.set(key, request);
  void request.finally(() => pending!.delete(key)).catch(() => {});
  return request;
}

export class NativeWidgetView extends LitElement {
  static properties = {
    preview: { attribute: false },
    context: { attribute: false },
    view: { state: true },
    failure: { state: true },
    ready: { state: true },
    height: { state: true },
    suggestion: { state: true },
    slow: { state: true },
    expanded: { state: true },
  };
  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      max-width: 840px;
      min-width: 0;
      margin: 12px auto;
      border: 1px solid var(--justdo-border-subtle, var(--justdo-border, #ddd));
      border-radius: 14px;
      overflow: hidden;
      color: var(--justdo-text-primary, inherit);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 22px 0;
      font-size: 14px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .title {
      min-width: 0;
    }
    .view-actions {
      display: flex;
      flex-shrink: 0;
      gap: 4px;
    }
    .view-actions button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      margin: 0;
      padding: 5px;
      border-color: transparent;
    }
    .view-actions button:hover {
      background: var(--justdo-surface-raised, #eee);
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    dialog {
      position: static;
      box-sizing: border-box;
      width: 100%;
      max-width: none;
      max-height: none;
      padding: 0;
      margin: 0;
      border: 0;
      color: inherit;
      background: transparent;
      overflow: visible;
    }
    dialog:modal {
      position: fixed;
      width: calc(100vw - 48px);
      height: calc(100vh - 48px);
      margin: auto;
      border: 1px solid var(--justdo-border, #ddd);
      border-radius: 14px;
      background: var(--justdo-background, #fff);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    dialog:modal > header,
    dialog:modal > .status {
      flex: 0 0 auto;
    }
    dialog:modal > .frame {
      flex: 1 1 0;
      min-height: 48px;
    }
    dialog:modal > .suggestion {
      flex: 0 1 auto;
      min-height: 0;
      max-height: 40%;
      overflow: auto;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    dialog:modal header {
      position: sticky;
      top: 0;
      z-index: 2;
      padding-bottom: 10px;
      background: var(--justdo-background, #fff);
    }
    iframe,
    webview {
      display: block;
      width: 100%;
      border: 0;
      min-height: 48px;
    }
    .frame {
      position: relative;
    }
    .frame.loading {
      height: 120px;
      overflow: hidden;
    }
    .frame.loading .status {
      position: absolute;
      inset: 0;
      z-index: 1;
      background: var(--justdo-surface, #fff);
    }
    .status {
      padding: 20px 14px;
      font-size: 13px;
    }
    .suggestion {
      padding: 14px 18px;
      border-top: 1px solid var(--justdo-border, #ddd);
      background: var(--justdo-surface, transparent);
    }
    .suggestion p {
      margin: 0 0 12px;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.6;
    }
    .suggestion-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .suggestion-actions button {
      margin: 0;
    }
    .primary {
      background: var(--justdo-primary, #287d68);
      color: var(--justdo-primary-foreground, white);
      border-color: transparent;
    }
    button:focus-visible {
      outline: 2px solid var(--justdo-primary, #287d68);
      outline-offset: 3px;
    }
    button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid var(--justdo-border, #ddd);
      border-radius: 5px;
      padding: 5px 10px;
      margin-left: 10px;
      cursor: pointer;
    }
  `;
  declare preview?: NativeCanvasPreview;
  declare context?: NativeWidgetContext;
  declare private view?: { html: string; url: string };
  declare private failure: boolean;
  declare private ready: boolean;
  declare private height: number;
  declare private suggestion: string;
  declare private slow: boolean;
  declare private expanded: boolean;
  private workspaceOverlay?: HTMLElement;
  private binding?: Binding;
  private host?: NativeWidgetSandboxHost;
  private guest?: NativeWidgetGuestHost;
  private themeObserver?: MutationObserver;
  private listenerDocument?: Document;
  private listenerWindow?: Window;
  private version = 0;
  private promptPort?: MessagePort;
  private failureKind: WidgetFailureKind = WidgetFailure.LOAD;
  private slowTimer?: ReturnType<typeof setTimeout>;
  private scrollNonce = '';

  constructor() {
    super();
    this.failure = false;
    this.ready = false;
    this.height = 420;
    this.failureKind = WidgetFailure.LOAD;
    this.suggestion = '';
    this.slow = false;
    this.expanded = false;
  }

  connectedCallback(): void {
    // Create native webviews in their actual embedder document, including when
    // this component reconnects after being adopted by a workspace document.
    this.renderOptions.creationScope = this.ownerDocument;
    super.connectedCallback();
    const ownerWindow = this.ownerDocument.defaultView;
    if (ownerWindow) {
      this.listenerDocument = this.ownerDocument;
      this.listenerWindow = ownerWindow;
      ownerWindow.addEventListener('message', this.onMessage);
      this.listenerDocument.addEventListener('visibilitychange', this.onVisibility);
    }
    this.dispatchEvent(
      new CustomEvent(NATIVE_WIDGET_CONTEXT_REQUEST, { bubbles: true, composed: true }),
    );
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    this.listenerWindow?.removeEventListener('message', this.onMessage);
    this.listenerDocument?.removeEventListener('visibilitychange', this.onVisibility);
    this.listenerWindow = undefined;
    this.listenerDocument = undefined;
    this.clear();
    super.disconnectedCallback();
  }

  protected createRenderRoot(): HTMLElement | DocumentFragment {
    // Document-owned styles stay portable when a widget moves into or out of a
    // workspace portal; constructed sheets cannot be adopted across documents.
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    for (const sheet of (this.constructor as typeof LitElement).elementStyles) {
      const style = this.ownerDocument.createElement('style');
      style.textContent =
        'cssText' in sheet
          ? sheet.cssText
          : Array.from(sheet.cssRules, rule => rule.cssText).join('\n');
      root.appendChild(style);
    }
    this.renderOptions.renderBefore = root.firstChild;
    return root;
  }

  private current(binding = this.binding): binding is Binding {
    return Boolean(
      binding &&
      this.isConnected &&
      this.ownerDocument === this.listenerDocument &&
      binding === this.binding &&
      this.context?.client === binding.context.client &&
      this.context.generation === binding.context.generation &&
      this.context.sessionKey === binding.context.sessionKey &&
      binding.context.client.generation === binding.context.generation &&
      binding.context.isCurrent() &&
      this.preview?.docId === binding.docId &&
      this.version === binding.version,
    );
  }

  private draftAllowed(binding = this.binding): boolean {
    return this.current(binding) && this.context?.canDraft() === true;
  }

  private clear(): void {
    this.collapse();
    clearTimeout(this.slowTimer);
    this.slowTimer = undefined;
    this.slow = false;
    this.scrollNonce = '';
    this.postDraftPolicy(false);
    this.promptPort?.close();
    this.promptPort = undefined;
    this.suggestion = '';
    this.version++;
    this.binding = undefined;
    this.host?.dispose();
    this.host = undefined;
    this.guest?.dispose();
    this.guest = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.view = undefined;
    this.ready = false;
    this.height = 420;
  }

  protected willUpdate(_changes: PropertyValues): void {
    if (!this.isConnected || this.ownerDocument !== this.listenerDocument) {
      if (this.binding || this.view) this.clear();
      return;
    }
    const context = this.context;
    if (!context?.isCurrent() || !isNativeCanvasPreview(this.preview)) {
      if (this.binding || this.view) this.clear();
      return;
    }
    if (this.current()) {
      if (!this.draftAllowed()) this.suggestion = '';
      this.postDraftPolicy(
        Boolean((this.guest || this.promptPort) && this.ownerDocument.visibilityState !== 'hidden'),
      );
      return;
    }
    this.clear();
    this.failure = false;
    const binding: Binding = { context, docId: this.preview.docId, version: this.version };
    this.binding = binding;
    this.scrollNonce = crypto.randomUUID();
    // Includes the authenticated read as well as sandbox/resource initialization.
    this.slowTimer = setTimeout(() => {
      if (this.current(binding) && !this.ready && !this.failure) this.slow = true;
    }, WIDGET_SLOW_NOTICE_MS);
    void loadView(binding, () => this.current(binding))
      .then(value => {
        if (!this.current(binding)) return;
        const result = value as Record<string, unknown> | null;
        if (
          !result ||
          typeof result.html !== 'string' ||
          new TextEncoder().encode(result.html).byteLength > MAX_WIDGET_BYTES
        )
          throw new Error('invalid widget document');
        const url = resolveNativeSandboxUrl(
          result,
          context.client.gatewayUrl,
          this.ownerDocument.defaultView!.location.origin,
        );
        this.view = { html: result.html, url };
      })
      .catch(() => {
        if (this.current(binding)) this.fail();
      });
  }

  protected updated(): void {
    const webview = this.renderRoot.querySelector<WidgetWebview>('webview');
    if (webview && this.view && this.current() && !this.guest && !this.failure) {
      const binding = this.binding!;
      this.guest = new NativeWidgetGuestHost(webview, this.view.url, this.view.html, event => {
        if (!this.current(binding)) return;
        if (event.type === 'failure') {
          this.fail(event.runtime ? WidgetFailure.RUNTIME : WidgetFailure.LOAD);
          return;
        }
        if (this.failure) return;
        if (event.type === 'ready') {
          clearTimeout(this.slowTimer);
          this.slowTimer = undefined;
          this.slow = false;
          this.ready = true;
          this.postHostState();
        }
        if (
          event.type === 'height' &&
          Number.isFinite(event.height) &&
          event.height > 0 &&
          !this.expanded
        )
          this.height = Math.min(8000, Math.max(48, Math.ceil(event.height)));
        if (event.type === 'scroll' && this.ready && Number.isFinite(event.deltaY)) {
          const delta = Math.max(-8000, Math.min(8000, event.deltaY));
          if (this.expanded) this.renderRoot.querySelector('dialog')?.scrollBy({ top: delta });
          else forwardWidgetScroll(this, delta);
        }
        if (
          event.type === 'draft' &&
          this.ready &&
          this.draftAllowed(binding) &&
          widgetFrameInteractable(webview)
        ) {
          const text = acceptWidgetDraftText(
            event.text,
            `${binding.context.sessionKey}\0${binding.docId}\0${binding.context.generation}`,
          );
          if (text) this.suggestion = text;
        }
      });
      this.observeTheme();
      this.postHostState();
      return;
    }
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>('iframe');
    if (!frame || !this.view || !this.current() || this.host || this.failure) return;
    const binding = this.binding!;
    this.host = new NativeWidgetSandboxHost(
      frame,
      this.view.url,
      this.view.html,
      () => {
        if (!this.current(binding) || this.failure) return;
        clearTimeout(this.slowTimer);
        this.slowTimer = undefined;
        this.slow = false;
        this.ready = true;
        this.postHostState();
      },
      () => {
        if (this.current(binding) && !this.failure) this.fail();
      },
    );
    this.observeTheme();
    frame.src = this.view.url;
  }

  private observeTheme(): void {
    const ownerWindow = this.ownerDocument.defaultView!;
    this.themeObserver = new ownerWindow.MutationObserver(() => this.postHostState());
    this.themeObserver.observe(this.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-theme-mode'],
    });
  }

  private fail(kind: WidgetFailureKind = WidgetFailure.LOAD): void {
    clearTimeout(this.slowTimer);
    this.slowTimer = undefined;
    this.slow = false;
    this.postDraftPolicy(false);
    this.promptPort?.close();
    this.promptPort = undefined;
    this.suggestion = '';
    if (kind === WidgetFailure.LOAD) {
      this.host?.dispose();
      this.host = undefined;
      this.guest?.dispose();
      this.guest = undefined;
      this.themeObserver?.disconnect();
      this.themeObserver = undefined;
      this.view = undefined;
    }
    this.failure = true;
    this.failureKind = kind;
    this.ready = kind === WidgetFailure.RUNTIME && Boolean(this.view);
  }

  private postHostState(): void {
    if ((!this.host && !this.guest) || !this.current()) return;
    const styles = this.ownerDocument.defaultView!.getComputedStyle(
      this.ownerDocument.documentElement,
    );
    const map: Record<string, string> = {
      surface: 'background',
      card: 'surface',
      elevated: 'surface-raised',
      text: 'text-primary',
      'text-strong': 'text-primary',
      muted: 'text-secondary',
      border: 'border',
      'border-strong': 'input-border',
      accent: 'primary',
      'accent-fill': 'primary',
      'accent-fg': 'primary-foreground',
      ok: 'success',
      warn: 'warning',
      danger: 'destructive',
      info: 'primary',
      radius: 'radius',
      'scrollbar-thumb': 'scroll-thumb',
      'scrollbar-thumb-hover': 'scroll-thumb-hover',
    };
    const tokens = Object.fromEntries(
      Object.entries(map)
        .map(([token, source]) => [token, styles.getPropertyValue(`--justdo-${source}`).trim()])
        .filter(([, value]) => value),
    );
    Object.assign(tokens, {
      'font-body':
        this.ownerDocument.defaultView!.getComputedStyle(this).fontFamily ||
        styles.fontFamily ||
        'system-ui, sans-serif',
      'font-mono': "'SF Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      'radius-full': '9999px',
      'scrollbar-size': '6px',
      'scrollbar-thumb-inset': '1px',
    });
    if (this.guest) {
      this.guest.update({
        theme: { mode: styles.colorScheme === 'dark' ? 'dark' : 'light', tokens },
        draftAllowed:
          !this.failure && this.draftAllowed() && this.ownerDocument.visibilityState !== 'hidden',
      });
      return;
    }
    const target = new URL(this.host!.url).origin;
    postNativeWidgetMessage(
      this.host!.frame,
      {
        type: 'openclaw:widget-theme',
        mode: styles.colorScheme === 'dark' ? 'dark' : 'light',
        tokens,
      },
      target,
    );
    postNativeWidgetMessage(this.host!.frame, { type: 'openclaw:widget-chat-host' }, target);
    postNativeWidgetMessage(
      this.host!.frame,
      { type: 'openclaw:widget-board-host', nonce: this.scrollNonce },
      target,
    );
    this.postDraftPolicy(
      Boolean(this.promptPort && this.ownerDocument.visibilityState !== 'hidden'),
    );
  }

  private readonly onVisibility = (): void =>
    this.postDraftPolicy(
      this.ownerDocument.visibilityState !== 'hidden' && Boolean(this.guest || this.promptPort),
    );

  private postDraftPolicy(available: boolean): void {
    this.guest?.setDraftAllowed(
      available &&
        !this.failure &&
        this.ownerDocument.visibilityState !== 'hidden' &&
        this.draftAllowed(),
    );
    if (!this.host) return;
    postNativeWidgetMessage(
      this.host.frame,
      {
        type: 'openclaw:scenario-draft-policy',
        available:
          available &&
          !this.failure &&
          this.ownerDocument.visibilityState !== 'hidden' &&
          this.draftAllowed(),
      },
      new URL(this.host.url).origin,
    );
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const host = this.host;
    if (
      !host ||
      !this.current() ||
      event.source !== host.frame.contentWindow ||
      event.origin !== new URL(host.url).origin
    )
      return;
    if (event.data?.type === 'openclaw:widget-prompt-offer') {
      const port = event.ports[0];
      if (!port || this.failure || this.promptPort || !host.loaded || event.ports.length !== 1) {
        for (const offered of event.ports) offered.close();
        return;
      }
      const binding = this.binding!;
      this.promptPort = port;
      port.onmessage = message => {
        if (
          this.failure ||
          !this.draftAllowed(binding) ||
          this.promptPort !== port ||
          message.data?.type !== 'openclaw:widget-prompt'
        )
          return;
        const text = acceptWidgetDraft(
          host.frame,
          message.data.prompt,
          `${binding.context.sessionKey}\0${binding.docId}\0${binding.context.generation}`,
        );
        if (text) this.suggestion = text;
      };
      port.start();
      port.postMessage({ type: 'openclaw:widget-prompt-host-ready' });
      if (this.ready) this.postDraftPolicy(true);
      this.requestUpdate();
      return;
    }
    // Inline widgets never receive dashboard, tools, resources or execution grants.
    if (event.data?.type === 'openclaw:widget-bridge-port-offer') {
      for (const port of event.ports) port.close();
      return;
    }
    host.handleMessage(event);
    if (
      event.data?.type === 'openclaw:widget-scroll' &&
      host.loaded &&
      this.scrollNonce &&
      event.data.nonce === this.scrollNonce &&
      typeof event.data.deltaY === 'number' &&
      Number.isFinite(event.data.deltaY) &&
      event.data.deltaY !== 0
    ) {
      if (this.expanded)
        this.renderRoot.querySelector('dialog')?.scrollBy({ top: event.data.deltaY });
      else forwardWidgetScroll(this, event.data.deltaY);
      return;
    }
    if (event.data?.type === 'openclaw:widget-runtime-error') {
      if (this.failure) return;
      this.fail(WidgetFailure.RUNTIME);
      return;
    }
    if (
      event.data?.type === 'openclaw:widget-size' &&
      typeof event.data.height === 'number' &&
      Number.isFinite(event.data.height) &&
      event.data.height > 0 &&
      !this.expanded
    )
      this.height = Math.min(8000, Math.max(48, Math.ceil(event.data.height)));
    if (event.data?.type === 'openclaw:widget-bridge-ready') this.postHostState();
  };

  private readonly requestRebuild = (event: MouseEvent, binding = this.binding): void => {
    if (!event.isTrusted || !this.failure || !this.draftAllowed(binding) || !this.preview) return;
    this.suggestion = widgetRebuildDraft(this.preview, this.failureKind, key => i18nService.t(key));
  };

  private collapse(): void {
    this.workspaceOverlay?.remove();
    this.workspaceOverlay = undefined;
    if (!this.expanded) return;
    const dialog = this.renderRoot.querySelector('dialog');
    dialog?.close();
    dialog?.setAttribute('open', '');
    this.expanded = false;
  }

  private readonly toggleExpanded = (): void => {
    if (this.expanded) {
      this.collapse();
      return;
    }
    const dialog = this.renderRoot.querySelector('dialog');
    if (!dialog || !this.current()) return;
    // Top-layer promotion preserves the same iframe document and local inputs.
    dialog.close();
    dialog.showModal();
    this.expanded = true;
    // Native workspace views sit above CSS/top-layer content. Publish their
    // existing overlay signal in light DOM, outside the chat's shadow root.
    const overlay = this.ownerDocument.createElement('div');
    overlay.dataset.workspaceOverlay = 'true';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none';
    this.ownerDocument.body.append(overlay);
    this.workspaceOverlay = overlay;
  };

  private renderViewActions() {
    const expandLabel = i18nService.t(
      this.expanded ? 'coworkWidgetCollapse' : 'coworkWidgetExpand',
    );
    return html`<div class="view-actions">
      <button
        type="button"
        title=${expandLabel}
        aria-label=${expandLabel}
        aria-expanded=${this.expanded}
        ?disabled=${!this.current()}
        @click=${this.toggleExpanded}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <path
            d=${
              this.expanded
                ? 'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5'
                : 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'
            }
          />
        </svg>
      </button>
    </div>`;
  }

  private renderSuggestion() {
    if (!this.suggestion || !this.draftAllowed()) return nothing;
    const binding = this.binding;
    const text = this.suggestion;
    return html`<section class="suggestion" aria-label=${i18nService.t('coworkWidgetSuggestion')}>
      <p>${this.suggestion}</p>
      <div class="suggestion-actions">
        <button
          class="primary"
          @click=${(event: MouseEvent) => {
            if (!event.isTrusted || !this.draftAllowed(binding) || this.suggestion !== text) return;
            this.dispatchEvent(
              new CustomEvent(NATIVE_WIDGET_DRAFT_EVENT, {
                bubbles: true,
                composed: true,
                detail: { sessionKey: binding!.context.sessionKey, text },
              }),
            );
            this.suggestion = '';
          }}
        >
          ${i18nService.t('coworkWidgetAddDraft')}
        </button>
        <button
          @click=${() => {
            if (!this.current(binding) || this.suggestion !== text) return;
            this.suggestion = '';
          }}
        >
          ${i18nService.t('coworkWidgetDismiss')}
        </button>
      </div>
    </section>`;
  }

  protected render() {
    const title = this.preview?.title || i18nService.t('coworkCanvasTitle');
    const binding = this.binding;
    const retry = () => {
      if (!this.current(binding)) return;
      this.clear();
      this.failure = false;
      this.requestUpdate();
    };
    return html`<dialog
      open
      role=${this.expanded ? 'dialog' : 'group'}
      aria-label=${title}
      aria-modal=${this.expanded ? 'true' : nothing}
      @cancel=${(event: Event) => {
        event.preventDefault();
        this.collapse();
      }}
    >
      <header><span class="title">${title}</span>${this.renderViewActions()}</header>
      ${
        this.failure
          ? html`<div class="status" role="alert">
              ${i18nService.t(this.failureKind === WidgetFailure.RUNTIME ? 'coworkWidgetRuntimeFailed' : 'coworkWidgetFailed')}<button
                @click=${retry}
              >
                ${i18nService.t('coworkWidgetRetry')}
              </button>
              ${
                this.draftAllowed()
                  ? html`<button
                      @click=${(event: MouseEvent) => this.requestRebuild(event, binding)}
                    >
                      ${i18nService.t('coworkWidgetRebuild')}
                    </button>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${
        this.view
          ? keyed(
              this.version,
              html`<div class=${this.ready ? 'frame' : 'frame loading'}>
                ${!this.ready ? html`<div class="status" role="status">${i18nService.t(this.slow ? 'coworkWidgetLoadingSlow' : 'coworkWidgetLoading')}</div>` : nothing}${
                  window.electron
                    ? html`<webview
                        .inert=${!this.ready}
                        aria-label=${title}
                        style=${this.expanded ? 'height:100%' : `height:${this.height}px`}
                      ></webview>`
                    : html`<iframe
                        .inert=${!this.ready}
                        title=${title}
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        referrerpolicy="origin"
                        style=${this.expanded ? 'height:100%' : `height:${this.height}px`}
                        @error=${() => {
                          if (this.current(binding)) this.fail();
                        }}
                      ></iframe>`
                }
              </div>`,
            )
          : !this.failure
            ? html`<div class="status" role="status">
                ${i18nService.t(this.context?.isCurrent() ? (this.slow ? 'coworkWidgetLoadingSlow' : 'coworkWidgetLoading') : 'coworkWidgetDisconnected')}
              </div>`
            : nothing
      }${this.renderSuggestion()}
    </dialog>`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('justdo-native-widget'))
  customElements.define('justdo-native-widget', NativeWidgetView);

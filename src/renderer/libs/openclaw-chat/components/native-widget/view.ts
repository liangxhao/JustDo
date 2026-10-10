import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

import { i18nService } from '@/services/i18n';

import { isNativeCanvasPreview, type NativeCanvasPreview } from '../../pipeline/native-canvas';
import { acceptWidgetDraft } from './draft';
import {
  MAX_WIDGET_BYTES,
  NATIVE_WIDGET_CONTEXT_REQUEST,
  NATIVE_WIDGET_DRAFT_EVENT,
  type NativeWidgetContext,
  NativeWidgetSandboxHost,
  resolveNativeSandboxUrl,
} from './host';
import { postNativeWidgetMessage } from './messaging';
import { WidgetFailure, type WidgetFailureKind, widgetRebuildDraft } from './rebuild';

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
  };
  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      max-width: 840px;
      min-width: 0;
      margin: 12px auto;
      border: 1px solid var(--justdo-border, #ddd);
      border-radius: 10px;
      overflow: hidden;
      color: var(--justdo-text-primary, inherit);
    }
    header {
      padding: 10px 14px;
      font-size: 13px;
      overflow-wrap: anywhere;
      border-bottom: 1px solid var(--justdo-border, #ddd);
    }
    iframe {
      display: block;
      width: 100%;
      border: 0;
      min-height: 48px;
    }
    .status {
      padding: 20px 14px;
      font-size: 13px;
    }
    .notice {
      padding: 9px 14px;
      font-size: 11px;
      overflow-wrap: anywhere;
      color: var(--justdo-text-secondary, #777);
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
  private binding?: Binding;
  private host?: NativeWidgetSandboxHost;
  private themeObserver?: MutationObserver;
  private listenerDocument?: Document;
  private listenerWindow?: Window;
  private version = 0;
  private promptPort?: MessagePort;
  private failureKind: WidgetFailureKind = WidgetFailure.LOAD;

  constructor() {
    super();
    this.failure = false;
    this.ready = false;
    this.height = 420;
    this.failureKind = WidgetFailure.LOAD;
    this.suggestion = '';
  }

  connectedCallback(): void {
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
    this.postDraftPolicy(false);
    this.promptPort?.close();
    this.promptPort = undefined;
    this.suggestion = '';
    this.version++;
    this.binding = undefined;
    this.host?.dispose();
    this.host = undefined;
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
        Boolean(this.promptPort && this.ownerDocument.visibilityState !== 'hidden'),
      );
      return;
    }
    this.clear();
    this.failure = false;
    const binding: Binding = { context, docId: this.preview.docId, version: this.version };
    this.binding = binding;
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
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>('iframe');
    if (!frame || !this.view || !this.current() || this.host || this.failure) return;
    const binding = this.binding!;
    this.host = new NativeWidgetSandboxHost(
      frame,
      this.view.url,
      this.view.html,
      () => {
        if (!this.current(binding)) return;
        this.ready = true;
        this.postHostState();
      },
      () => {
        if (this.current(binding)) this.fail();
      },
    );
    const ownerWindow = this.ownerDocument.defaultView!;
    this.themeObserver = new ownerWindow.MutationObserver(() => this.postHostState());
    this.themeObserver.observe(this.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-theme-mode'],
    });
    frame.src = this.view.url;
  }

  private fail(kind: WidgetFailureKind = WidgetFailure.LOAD): void {
    this.postDraftPolicy(false);
    this.promptPort?.close();
    this.promptPort = undefined;
    this.suggestion = '';
    this.host?.dispose();
    this.host = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.view = undefined;
    this.failure = true;
    this.failureKind = kind;
    this.ready = false;
  }

  private postHostState(): void {
    if (!this.host || !this.current()) return;
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
    };
    const tokens = Object.fromEntries(
      Object.entries(map)
        .map(([token, source]) => [token, styles.getPropertyValue(`--justdo-${source}`).trim()])
        .filter(([, value]) => value),
    );
    const target = new URL(this.host.url).origin;
    postNativeWidgetMessage(
      this.host.frame,
      {
        type: 'openclaw:widget-theme',
        mode: styles.colorScheme === 'dark' ? 'dark' : 'light',
        tokens,
      },
      target,
    );
    postNativeWidgetMessage(this.host.frame, { type: 'openclaw:widget-chat-host' }, target);
    this.postDraftPolicy(
      Boolean(this.promptPort && this.ownerDocument.visibilityState !== 'hidden'),
    );
  }

  private readonly onVisibility = (): void =>
    this.postDraftPolicy(
      this.ownerDocument.visibilityState !== 'hidden' && Boolean(this.promptPort),
    );

  private postDraftPolicy(available: boolean): void {
    if (!this.host) return;
    postNativeWidgetMessage(
      this.host.frame,
      {
        type: 'openclaw:scenario-draft-policy',
        available:
          available && this.ownerDocument.visibilityState !== 'hidden' && this.draftAllowed(),
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
      if (!port || this.promptPort || !host.loaded || event.ports.length !== 1) {
        for (const offered of event.ports) offered.close();
        return;
      }
      const binding = this.binding!;
      this.promptPort = port;
      port.onmessage = message => {
        if (
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
      return;
    }
    // Inline widgets never receive dashboard, tools, resources or execution grants.
    if (event.data?.type === 'openclaw:widget-bridge-port-offer') {
      for (const port of event.ports) port.close();
      return;
    }
    host.handleMessage(event);
    if (event.data?.type === 'openclaw:widget-runtime-error') {
      this.fail(WidgetFailure.RUNTIME);
      return;
    }
    if (
      event.data?.type === 'openclaw:widget-size' &&
      typeof event.data.height === 'number' &&
      Number.isFinite(event.data.height) &&
      event.data.height > 0
    )
      this.height = Math.min(8000, Math.max(48, Math.ceil(event.data.height)));
    if (event.data?.type === 'openclaw:widget-bridge-ready') this.postHostState();
  };

  private readonly requestRebuild = (event: MouseEvent, binding = this.binding): void => {
    if (!event.isTrusted || !this.failure || !this.draftAllowed(binding) || !this.preview) return;
    this.suggestion = widgetRebuildDraft(this.preview, this.failureKind, key => i18nService.t(key));
  };

  private renderSuggestion() {
    if (!this.suggestion || !this.draftAllowed()) return nothing;
    const binding = this.binding;
    const text = this.suggestion;
    return html`<section class="status" aria-label=${i18nService.t('coworkWidgetSuggestion')}>
      <strong>${i18nService.t('coworkWidgetSuggestion')}</strong>
      <p style="white-space:pre-wrap">${this.suggestion}</p>
      <button
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
    return html`<header>${title}</header>
      ${
        this.failure
          ? html`<div class="status" role="alert">
              ${i18nService.t('coworkWidgetFailed')}<button @click=${retry}>
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
          : this.view
            ? keyed(
                this.version,
                html`${!this.ready ? html`<div class="status" role="status">${i18nService.t('coworkWidgetLoading')}</div>` : nothing}<iframe
                    title=${title}
                    sandbox="allow-scripts allow-same-origin"
                    referrerpolicy="origin"
                    style=${`height:${this.height}px`}
                    @error=${() => {
                      if (this.current(binding)) this.fail();
                    }}
                  ></iframe>
                  <div class="notice">${i18nService.t('coworkWidgetActionsUnavailable')}</div> `,
              )
            : html`<div class="status" role="status">
                ${i18nService.t(this.context?.isCurrent() ? 'coworkWidgetLoading' : 'coworkWidgetDisconnected')}
              </div>`
      }${this.renderSuggestion()}`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('justdo-native-widget'))
  customElements.define('justdo-native-widget', NativeWidgetView);

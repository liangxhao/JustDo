import type { McpAppContentReference } from '@shared/plugins/mcpAppReferences';
import { McpAppEvent, type McpAppPreview } from '@shared/plugins/mcpApps';
import { html, LitElement, nothing, type PropertyValues, svg } from 'lit';

import { i18nService } from '@/services/i18n';
import { TOKEN_CONTRACT } from '@/theme/tokens/contract';

import type { McpAppSession } from '../../gateway/mcp-app/mcp-app-session';
import { isNativeAppReference } from '../../pipeline/native-app-reference';
import { isNativeMcpAppPreview, readNativeMcpAppIdentity } from '../../pipeline/native-mcp-app';
import { MCP_APP_ICON_STYLE, renderMcpAppIcon } from './icon';
import { resolveMcpAppIcons } from './icons';
import { restoreAppReference } from './plugin-content';
import { getMcpAppPresentations, type McpAppPresentation } from './presentations';
import { findMcpAppContentView, type McpAppViewContext } from './view';

/** A message is an anchor, never the owner of a retained iframe. */
export class McpAppAnchor extends LitElement {
  static properties = {
    preview: { attribute: false },
    reference: { attribute: false },
    context: { attribute: false },
    loading: { state: true },
    error: { state: true },
  };
  declare preview?: McpAppPreview;
  declare reference?: McpAppContentReference;
  declare context?: McpAppViewContext;
  declare loading: boolean;
  declare error: string;
  private entry?: McpAppPresentation;
  private stop?: () => void;
  private stopApps?: () => void;
  private apps?: McpAppSession;
  private observer?: ResizeObserver;
  private mutations?: MutationObserver;
  private pendingPin = false;
  private failedIcons: string[] = [];
  private readonly layout = () => getMcpAppPresentations(this.ownerDocument).requestLayout();
  private scrollRoot?: Node;

  constructor() {
    super();
    this.loading = false;
    this.error = '';
  }

  protected createRenderRoot() {
    const root = this.attachShadow({ mode: 'open' });
    const style = this.ownerDocument.createElement('style');
    style.textContent = `
      :host{display:block;max-width:840px;margin:12px auto;color:var(${TOKEN_CONTRACT['text-primary']},inherit)}
      .reference{box-sizing:border-box;display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 12px;border:1px solid var(${TOKEN_CONTRACT.border},#ddd);border-radius:12px;background:var(${TOKEN_CONTRACT.background},transparent);font:inherit;font-size:13px}
      .app-icon{--app-icon-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;border-radius:7px;background:var(${TOKEN_CONTRACT.surface},#f4f4f5)}
      ${MCP_APP_ICON_STYLE}
      .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}
      .status{display:flex;align-items:center;gap:4px;flex-shrink:0;padding:3px 7px;border-radius:6px;background:var(${TOKEN_CONTRACT.surface},#f4f4f5);font-size:11px;white-space:nowrap;color:var(${TOKEN_CONTRACT['text-secondary']},#666)}
      .status svg,button svg{width:13px;height:13px;flex-shrink:0}
      button{display:flex;align-items:center;gap:4px;flex-shrink:0;font:inherit;font-size:12px;white-space:nowrap;color:inherit;background:transparent;border:0;border-radius:6px;padding:6px 4px;cursor:pointer}button:hover{background:var(${TOKEN_CONTRACT.surface},#f4f4f5)}button:focus-visible{outline:2px solid var(${TOKEN_CONTRACT.primary},#666);outline-offset:2px}button:disabled{opacity:.5;cursor:default}.error{padding:8px 14px;font-size:12px}
    `;
    root.append(style);
    this.renderOptions.renderBefore = null;
    return root;
  }

  connectedCallback() {
    super.connectedCallback();
    this.dispatchEvent(
      new CustomEvent(McpAppEvent.ContextRequest, { bubbles: true, composed: true }),
    );
    const manager = getMcpAppPresentations(this.ownerDocument);
    this.stop = manager.subscribe(this.presentationChanged);
    this.observer = new ResizeObserver(this.layout);
    this.observer.observe(this);
    this.scrollRoot = this.getRootNode();
    this.scrollRoot.addEventListener('scroll', this.layout, true);
    this.mutations = new MutationObserver(this.layout);
    this.mutations.observe(this.scrollRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'open', 'hidden'],
    });
    this.requestUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop?.();
    this.stopApps?.();
    this.apps = undefined;
    this.observer?.disconnect();
    this.mutations?.disconnect();
    this.scrollRoot?.removeEventListener('scroll', this.layout, true);
    if (this.entry) getMcpAppPresentations(this.ownerDocument).release(this, this.entry);
    this.entry = undefined;
  }

  presentationChanged = () => this.requestUpdate();

  protected willUpdate(_changes: PropertyValues) {
    if (!this.isConnected) return;
    const manager = getMcpAppPresentations(this.ownerDocument);
    const context = this.context;
    if (this.apps !== context?.apps) {
      this.stopApps?.();
      this.apps = context?.apps;
      this.stopApps = this.apps?.subscribe(this.presentationChanged);
    }
    if (context?.isCurrent() && isNativeMcpAppPreview(this.preview)) {
      const next = manager.acquire(this, this.preview, context);
      if (next && next !== this.entry) {
        if (this.entry) manager.release(this, this.entry);
        this.entry = next;
      }
    }
    if (this.pendingPin && this.entry?.view.canReference) {
      this.pendingPin = false;
      manager.pin(this.entry);
    }
  }

  protected updated() {
    this.layout();
  }

  private target() {
    if (this.entry) return this.entry.view;
    if (
      !isNativeAppReference(this.reference) ||
      !this.context?.isCurrent() ||
      !this.context.apps.ready
    )
      return;
    const retained = getMcpAppPresentations(this.ownerDocument).findReference(
      this.reference,
      this.context,
    );
    if (retained) return retained.view;
    return findMcpAppContentView(this.reference, this.context);
  }

  private async open() {
    const context = this.context;
    if (!context?.isCurrent() || !context.apps.ready || this.loading) return;
    const manager = getMcpAppPresentations(this.ownerDocument);
    const view = this.target();
    if (view) {
      const entry = manager.find(view);
      if (entry && !entry.pinned && view.canReference) manager.pin(entry);
      else view.revealCanvas?.();
      return;
    }
    const reference = this.reference;
    if (!isNativeAppReference(reference)) return;
    this.loading = true;
    this.error = '';
    try {
      const preview = await restoreAppReference(reference, context);
      if (!this.isConnected || this.context?.apps !== context.apps || !context.isCurrent()) return;
      this.preview = preview;
      this.pendingPin = true;
    } catch {
      if (this.isConnected && context.isCurrent()) this.error = i18nService.t('mcpAppsUnavailable');
    } finally {
      this.loading = false;
    }
  }

  protected render() {
    const manager = getMcpAppPresentations(this.ownerDocument);
    const view = this.target();
    const entry = view ? manager.find(view) : undefined;
    const inline = this.entry && this.entry.primary === this && !this.entry.pinned;
    if (inline) {
      this.style.height = `${this.entry!.height}px`;
      return nothing;
    }
    this.style.height = '';
    const title = entry
      ? manager.title(entry)
      : (this.reference?.title ?? this.preview?.title ?? i18nService.t('mcpAppsTitle'));
    const pinned = entry?.pinned;
    const t = (key: string) => i18nService.t(key);
    const reference = isNativeAppReference(this.reference) ? this.reference : undefined;
    const identity = readNativeMcpAppIdentity(view?.preview ?? this.preview) ?? reference?.content;
    const icons = identity
      ? resolveMcpAppIcons((view?.context ?? this.context)?.apps.iconCatalog, identity)
      : undefined;
    const status = pinned
      ? `${reference ? `${t('mcpAppsUpdated')} · ` : ''}${t('mcpAppsPinned')}`
      : reference
        ? t('mcpAppsUpdated')
        : t('mcpAppsLoading');
    return html`<div class="reference">
        <span class="app-icon" aria-hidden="true">
          ${renderMcpAppIcon(icons, this.failedIcons, src => {
            this.failedIcons = [...this.failedIcons, src];
            this.requestUpdate();
          })}
        </span>
        <span class="title" title=${title}>${title}</span>
        <div class="status">
          ${
            pinned
              ? svg`<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M12.5 3.5v13"/></svg>`
              : nothing
          }
          <span>${status}</span>
        </div>
        <button
          ?disabled=${this.loading || !this.context?.isCurrent() || Boolean(entry && !entry.pinned && !view?.canReference)}
          title=${`${pinned || (view && !entry) ? t('mcpAppsViewReference') : t('mcpAppsPin')}: ${title}`}
          aria-label=${`${pinned || (view && !entry) ? t('mcpAppsViewReference') : t('mcpAppsPin')}: ${title}`}
          @click=${() => void this.open()}
        >
          ${t(pinned || (view && !entry) ? 'mcpAppsViewReference' : 'mcpAppsPin')}
          ${svg`<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 12 4M5 4h7v7"/></svg>`}
        </button>
      </div>
      ${this.error ? html`<div class="error" role="status">${this.error}</div>` : nothing}`;
  }
}

if (!customElements.get('mcp-app-anchor')) customElements.define('mcp-app-anchor', McpAppAnchor);

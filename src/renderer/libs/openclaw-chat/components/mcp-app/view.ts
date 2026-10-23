import {
  type McpUiHostContext,
  McpUiHostContextSchema,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  McpAppContentIdentity,
  McpAppContentReference,
} from '@shared/plugins/mcpAppReferences';
import {
  MCP_APP_SHARED_HEADER,
  McpAppEvent,
  McpAppMethod,
  type McpAppModelContext,
  type McpAppPreview,
  mcpAppRecord,
} from '@shared/plugins/mcpApps';
import { html, LitElement, nothing, type PropertyValues, svg } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

import { i18nService } from '@/services/i18n';
import { TOKEN_CONTRACT } from '@/theme/tokens/contract';

import type { McpAppSession, McpAppSessionView } from '../../gateway/mcp-app/mcp-app-session';
import { isNativeAppReference } from '../../pipeline/native-app-reference';
import { isNativeMcpAppPreview, readNativeMcpAppIdentity } from '../../pipeline/native-mcp-app';
import { resolveNativeSandboxUrl } from '../native-widget/host';
import { presentationTargetVisible } from '../presentation-documents';
import { createMcpAppBridge } from './bridge';
import { prepareMcpAppDownload } from './download';
import { MCP_APP_ICON_STYLE, renderMcpAppIcon } from './icon';
import { resolveMcpAppIcons } from './icons';
import { connectAppContent, restrictRecoveredAppPayload } from './plugin-content';
import { McpAppFrameTransport } from './transport';

export interface McpAppViewContext {
  apps: McpAppSession;
  sessionKey: string;
  isCurrent: () => boolean;
  canDraft: () => boolean;
  addDraft: (text: string) => Promise<boolean>;
  openFile?: (file: { path: string; name: string }) => Promise<boolean>;
  addNewDraft?: (text: string, content: unknown[]) => Promise<boolean>;
  refresh?: () => Promise<McpAppViewContext>;
  /** Product display scope only; never used for native authorization. */
  presentationScope?: string;
  /** Rebind an existing workspace view only after the same native incarnation is ready. */
  resume?: () => McpAppViewContext | undefined;
  /** Explicit user reopen for a file snapshot; never an automatic tool replay. */
  reopen?: () => Promise<{ context: McpAppViewContext; preview: McpAppPreview }>;
}

const activeViews = new WeakMap<McpAppSession, Map<string, McpAppView>>();
const appViews = new Set<McpAppView>();
type Confirmation = {
  text: string;
  purpose: 'draft' | 'new' | 'file';
  respond: (accepted: boolean) => void;
};
type Resources = {
  apps: McpAppSession;
  viewId: string;
  session: McpAppSessionView;
  controller: AbortController;
  frame?: HTMLIFrameElement;
  dispose?: () => void;
  teardown?: () => Promise<void>;
  update?: () => void;
  refreshContext?: () => Promise<void>;
  prepareContext?: () => Promise<void>;
  preparingContext?: boolean;
  content?: Readonly<McpAppContentIdentity>;
  localNotice?: string;
  contentTitle?: string;
  sharedHeader?: boolean;
};

const STYLE = `
  :host{position:relative;display:block;width:100%;max-width:840px;margin:12px auto;border:1px solid var(${TOKEN_CONTRACT.border},#ddd);border-radius:12px;overflow:hidden;color:var(${TOKEN_CONTRACT['text-primary']},inherit);background:var(${TOKEN_CONTRACT.background},transparent)}
  *{box-sizing:border-box}header{display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 10px;border-bottom:1px solid var(${TOKEN_CONTRACT['border-subtle']},#ddd);font-size:13px}header .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}svg{display:block;width:16px;height:16px;flex-shrink:0}.app-icon{color:var(${TOKEN_CONTRACT['text-muted']},#888)}
  button{font:inherit;color:inherit;background:transparent;border:1px solid var(${TOKEN_CONTRACT.border},#ddd);border-radius:7px;padding:6px 10px;cursor:pointer;transition:background .15s}button:hover{background:var(${TOKEN_CONTRACT.surface},#f4f4f5)}button:focus-visible{outline:2px solid var(${TOKEN_CONTRACT.primary},#666);outline-offset:2px}button:disabled{opacity:.5;cursor:default}.icon-button{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;color:var(${TOKEN_CONTRACT['text-secondary']},#666)}.primary{background:var(${TOKEN_CONTRACT.primary},#333);color:var(${TOKEN_CONTRACT['primary-foreground']},#fff);border-color:transparent}.primary:hover{background:var(${TOKEN_CONTRACT['primary-hover']},#555)}
  iframe{display:block;width:100%;border:0;min-height:160px}.status,.notice,.confirmation{padding:12px 14px;font-size:13px;overflow-wrap:anywhere}.status{display:flex;align-items:center;gap:10px}.status span{flex:1}.notice{font-size:12px;color:var(${TOKEN_CONTRACT['text-secondary']},#666)}.confirmation{border-bottom:1px solid var(${TOKEN_CONTRACT.border},#ddd);background:var(${TOKEN_CONTRACT.surface},#fafafa)}.confirmation p{max-height:180px;overflow:auto;white-space:pre-wrap;margin:10px 0}.actions{display:flex;gap:8px}.spinner{width:14px;height:14px;border:2px solid var(${TOKEN_CONTRACT.border},#ddd);border-top-color:currentColor;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}button{transition:none}}
  .status .spinner{flex:0 0 14px}
  header[hidden]{display:none}header .notice{padding:0;flex-shrink:0;white-space:nowrap}
  .branding{display:flex;align-items:center;gap:8px;flex:1;min-width:0}.app-icon{display:flex;flex-shrink:0;width:16px;height:16px}
  .host-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}.app-header-space{display:none}
  header[shared]{position:absolute;inset:0 0 auto;z-index:2;height:44px;min-height:44px;gap:4px;padding:6px 8px;border:0;pointer-events:none}
  header[shared] .app-header-space{display:block;flex:0 0 40%;height:100%}
  header[shared] .host-actions,header[shared] .branding,header[shared] .notice{pointer-events:auto;background:var(${TOKEN_CONTRACT.background},#fff)}
  header[shared] .icon-button{width:26px;height:30px}header[shared] .notice{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
  ${MCP_APP_ICON_STYLE}
  :host([expanded]){position:fixed;inset:36px 12px 130px;z-index:60;width:auto;max-width:none;margin:0;display:flex;flex-direction:column;background:var(${TOKEN_CONTRACT.background},#fff);box-shadow:0 16px 64px #0002}
  :host([expanded]) .mount{flex:1;min-height:0}:host([expanded]) iframe{height:100%!important}:host([fill-container]){height:100%;max-width:none;margin:0;border:0;border-radius:0;display:flex;flex-direction:column}:host([fill-container]) .mount{flex:1;min-height:0}:host([fill-container]) iframe{height:100%!important}
`;
const icon = (path: string) =>
  svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path}/></svg>`;

export class McpAppView extends LitElement {
  static properties = {
    preview: { attribute: false },
    context: { attribute: false },
    retainPresentation: { type: Boolean },
    loading: { state: true },
    error: { state: true },
    inactive: { state: true },
    expanded: { type: Boolean, reflect: true },
    fillContainer: { type: Boolean, attribute: 'fill-container', reflect: true },
    confirmation: { state: true },
    selection: { state: true },
    closed: { state: true },
  };
  declare preview?: McpAppPreview;
  revealCanvas?: () => void;
  pinPresentation?: () => void;
  presentationVisible?: () => boolean;
  declare retainPresentation: boolean;
  declare context?: McpAppViewContext;
  declare loading: boolean;
  declare error: string;
  declare inactive: boolean;
  declare expanded: boolean;
  declare fillContainer: boolean;
  declare confirmation?: Confirmation;
  declare selection: McpAppModelContext | null;
  declare closed: boolean;
  private resources?: Resources;
  private version = 0;
  private mountKey = 0;
  private modes: Array<'inline' | 'fullscreen'> = ['inline'];
  private mode: 'inline' | 'fullscreen' = 'inline';
  private closing?: Promise<void>;
  private lastSession?: McpAppSessionView;
  private expansionFocus?: HTMLElement;
  private waitingApps?: McpAppSession;
  private stopWaiting?: () => void;
  private waitingForBinding = false;
  private failedIcons: string[] = [];
  contextCleanupUnconfirmed = false;

  constructor() {
    super();
    this.loading = false;
    this.error = '';
    this.inactive = false;
    this.expanded = false;
    this.fillContainer = false;
    this.retainPresentation = false;
    this.selection = null;
    this.closed = false;
  }

  protected createRenderRoot(): HTMLElement | DocumentFragment {
    const root = this.attachShadow({ mode: 'open' });
    const style = this.ownerDocument.createElement('style');
    style.textContent = STYLE;
    root.append(style);
    this.renderOptions.renderBefore = null;
    return root;
  }

  connectedCallback(): void {
    super.connectedCallback();
    appViews.add(this);
    this.dispatchEvent(
      new CustomEvent(McpAppEvent.ContextRequest, { bubbles: true, composed: true }),
    );
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    queueMicrotask(() => {
      if (!this.isConnected) {
        appViews.delete(this);
        this.stopWaiting?.();
        this.stopWaiting = undefined;
        this.waitingApps = undefined;
        this.waitingForBinding = false;
        this.clear();
      }
    });
  }

  protected willUpdate(_changes: PropertyValues): void {
    if (!this.isConnected) return;
    if (this.resources && !this.loading && this.resources.session.isCurrent())
      this.resources.session.preservePresentation =
        (this.fillContainer || this.retainPresentation) && Boolean(this.context?.resume);
    if (this.waitingApps !== this.context?.apps) {
      this.stopWaiting?.();
      this.waitingApps = this.context?.apps;
      this.stopWaiting = this.waitingApps?.subscribe(() => {
        if (this.waitingForBinding && this.waitingApps?.ready) {
          this.waitingForBinding = false;
          this.loading = false;
          this.requestUpdate();
        }
        this.requestUpdate();
      });
      if (this.waitingForBinding && this.waitingApps?.ready) {
        this.waitingForBinding = false;
        this.loading = false;
      }
    }
    if (
      this.resources &&
      !this.resources.session.suspended &&
      (!this.resources.session.isCurrent() || !this.context?.isCurrent())
    )
      this.clear();
    if (
      !this.resources &&
      !this.loading &&
      !this.error &&
      !this.closed &&
      this.context?.isCurrent() &&
      isNativeMcpAppPreview(this.preview)
    )
      if (!this.context.apps.ready) {
        this.waitingForBinding = true;
        this.loading = true;
      } else void this.load();
  }

  protected updated(): void {
    this.resources?.update?.();
    this.dispatchEvent(
      new CustomEvent(McpAppEvent.PresentationChanged, { bubbles: true, composed: true }),
    );
  }

  private current(resources: Resources, version: number): boolean {
    return (
      this.isConnected &&
      this.resources === resources &&
      this.version === version &&
      resources.session.isCurrent() &&
      this.context?.isCurrent() === true &&
      !resources.controller.signal.aborted
    );
  }

  private visible(): boolean {
    return (
      this.isConnected &&
      this.ownerDocument.visibilityState !== 'hidden' &&
      presentationTargetVisible(this) &&
      this.presentationVisible?.() !== false &&
      this.context?.isCurrent() === true
    );
  }

  refreshPresentation(): void {
    if (!this.visible()) this.confirmation?.respond(false);
    this.requestUpdate();
  }

  private clear(): void {
    const resources = this.resources;
    this.version++;
    this.resources = undefined;
    this.confirmation?.respond(false);
    this.confirmation = undefined;
    resources?.controller.abort();
    resources?.dispose?.();
    resources?.session.detach();
    resources?.frame?.remove();
    this.loading = false;
    this.expanded = false;
    this.mode = 'inline';
    const map = resources && activeViews.get(resources.apps);
    if (resources && map?.get(resources.viewId) === this) map.delete(resources.viewId);
  }

  private confirm(text: string, purpose: Confirmation['purpose'] = 'draft'): Promise<boolean> {
    if (this.closed || !this.visible() || this.confirmation) return Promise.resolve(false);
    return new Promise(resolve => {
      this.confirmation = {
        text,
        purpose,
        respond: accepted => {
          this.confirmation = undefined;
          resolve(accepted && !this.closed && this.visible());
        },
      };
    });
  }

  private async draft(content: unknown[], target: 'active' | 'new'): Promise<boolean> {
    const resources = this.resources;
    const version = this.version;
    if (!resources || !this.context?.canDraft() || (target === 'new' && !this.context.addNewDraft))
      return false;
    const text = content
      .map(value => {
        const block = mcpAppRecord(value);
        return typeof block?.text === 'string'
          ? block.text
          : typeof block?.title === 'string'
            ? block.title
            : typeof block?.name === 'string'
              ? block.name
              : (block?.type ?? '');
      })
      .join('\n\n');
    if (
      !text.trim() ||
      text.length > 4000 ||
      /^\s*[!/]/.test(text) ||
      !(await this.confirm(text, target === 'new' ? 'new' : 'draft')) ||
      !this.current(resources, version) ||
      this.closed ||
      !this.context?.canDraft()
    )
      return false;
    if (target === 'new') return this.context.addNewDraft?.(text, content) ?? false;
    if (content.some(value => mcpAppRecord(value)?.type !== 'text')) {
      await resources.session.request(McpAppMethod.UpdateModelContext, { content });
      const response = await resources.session.request<{ state: McpAppModelContext | null }>(
        McpAppMethod.ModelContext,
      );
      if (!this.current(resources, version) || this.closed || !this.context?.canDraft())
        return false;
      this.context.apps.reportContext(resources.viewId, this.preview?.title ?? '', response.state);
    }
    return this.context.addDraft(text);
  }

  private hostContext(frame: HTMLIFrameElement): McpUiHostContext {
    const root = this.ownerDocument.documentElement;
    const style = this.ownerDocument.defaultView!.getComputedStyle(this);
    const variable = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback;
    return McpUiHostContextSchema.parse({
      theme:
        root.classList.contains('dark') || root.dataset.theme?.includes('dark') ? 'dark' : 'light',
      locale: root.lang || i18nService.getLanguage(),
      platform: 'desktop',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      styles: {
        variables: {
          '--color-background-primary': variable(TOKEN_CONTRACT.background, '#ffffff'),
          '--color-text-primary': variable(TOKEN_CONTRACT['text-primary'], '#171717'),
          '--color-text-secondary': variable(TOKEN_CONTRACT['text-secondary'], '#666666'),
          '--color-border-primary': variable(TOKEN_CONTRACT.border, '#dddddd'),
          '--font-sans': style.fontFamily,
        },
      },
      displayMode: this.mode,
      availableDisplayModes: this.modes,
      containerDimensions: {
        width: Math.round(frame.clientWidth),
        height: Math.round(frame.clientHeight),
      },
    });
  }

  private get sharedHeader(): boolean {
    return Boolean(
      this.resources?.sharedHeader &&
      !this.fillContainer &&
      !this.closed &&
      !this.loading &&
      !this.error &&
      !this.confirmation,
    );
  }

  private headerLayout(frame: HTMLIFrameElement) {
    if (!this.sharedHeader) return null;
    const space = this.renderRoot.querySelector('.app-header-space')?.getBoundingClientRect();
    const bounds = frame.getBoundingClientRect();
    if (!space || bounds.width <= 0 || space.width <= 0) return null;
    return {
      height: 44,
      left: Math.max(0, Math.ceil(space.left - bounds.left)),
      right: Math.max(0, Math.ceil(bounds.right - space.right)),
    };
  }

  private async load(): Promise<void> {
    const context = this.context;
    const preview = this.preview;
    if (!this.isConnected || !context?.isCurrent() || !isNativeMcpAppPreview(preview)) return;
    let map = activeViews.get(context.apps);
    if (!map) {
      map = new Map();
      activeViews.set(context.apps, map);
    }
    const active = map.get(preview.viewId);
    if (active?.isConnected && active !== this) {
      this.error = i18nService.t('mcpAppsAlreadyOpen');
      return;
    }
    map.set(preview.viewId, this);
    let session: McpAppSessionView;
    try {
      session = context.apps.bind(preview.viewId);
    } catch {
      map.delete(preview.viewId);
      this.error = i18nService.t('mcpAppsUnavailable');
      return;
    }
    const resources: Resources = {
      apps: context.apps,
      viewId: preview.viewId,
      session,
      controller: new AbortController(),
    };
    this.resources = resources;
    this.lastSession = resources.session;
    const stopContext = context.apps.subscribe(() => {
      if (resources.session.suspended) {
        this.selection = null;
        this.confirmation?.respond(false);
        this.confirmation = undefined;
        return;
      }
      if (!this.closed && (!resources.session.isCurrent() || !this.context?.isCurrent())) {
        this.clear();
        this.error = i18nService.t('mcpAppsUnavailable');
        this.requestUpdate();
      }
    });
    resources.dispose = stopContext;
    const version = ++this.version;
    const current = () => this.current(resources, version);
    this.loading = true;
    try {
      const payload = restrictRecoveredAppPayload(
        preview,
        resources.session,
        await resources.session.view(resources.controller.signal, preview.descriptor),
      );
      if (!current()) return;
      if (
        typeof payload.html !== 'string' ||
        new TextEncoder().encode(payload.html).byteLength > 6 * 1024 * 1024
      )
        throw new Error('Invalid native MCP App payload');
      const url = resolveNativeSandboxUrl(
        payload,
        resources.session.gatewayUrl,
        this.ownerDocument.location.origin,
      );
      this.modes = (['inline', 'fullscreen'] as const).filter(
        mode =>
          !payload.displayModes?.availableDisplayModes ||
          payload.displayModes.availableDisplayModes.includes(mode),
      );
      if (!this.modes.length) throw new Error('No supported MCP App display mode');
      this.mode = this.modes.includes('inline') ? 'inline' : 'fullscreen';
      this.expanded = this.mode === 'fullscreen' && !this.fillContainer;
      const nativeContext = mcpAppRecord(payload.hostContext);
      const buildContext = () => ({
        ...nativeContext,
        ...this.hostContext(frame),
        'openai/modelContext': this.selection,
        [MCP_APP_SHARED_HEADER]: this.headerLayout(frame),
      });
      this.selection =
        (mcpAppRecord(nativeContext?.['openai/modelContext']) as McpAppModelContext | null) ?? null;
      this.inactive = payload.messageSupported !== true;
      this.mountKey++;
      this.requestUpdate();
      await this.updateComplete;
      if (!current()) return;
      const mount = this.renderRoot.querySelector('.mount');
      if (!mount) throw new Error('Missing MCP App mount');
      const frame = this.ownerDocument.createElement('iframe');
      frame.title = preview.title;
      frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');
      frame.style.height = '600px';
      frame.src = url;
      const owner = this.ownerDocument.defaultView!;
      let readyListener: ((event: MessageEvent) => void) | undefined;
      const proxyReady = new Promise<void>(resolve => {
        readyListener = event => {
          if (
            event.source === frame.contentWindow &&
            event.origin === new URL(url).origin &&
            event.data?.method === 'ui/notifications/sandbox-proxy-ready' &&
            event.data?.params?.sandboxUrl === url
          )
            resolve();
        };
        owner.addEventListener('message', readyListener);
      });
      mount.append(frame);
      resources.frame = frame;
      if (this.mode === 'fullscreen' && this.fillContainer) await this.setMode('fullscreen');
      const host = createMcpAppBridge({
        session: resources.session,
        payload,
        hostContext: buildContext,
        canInteract: () =>
          current() &&
          this.visible() &&
          this.context?.canDraft() === true &&
          !this.inactive &&
          !this.closed &&
          !resources.preparingContext,
        canRead: () =>
          current() &&
          this.visible() &&
          this.context?.canDraft() === true &&
          !this.closed &&
          !resources.preparingContext,
        canPrepareContext: () =>
          current() && this.context?.canDraft() === true && !this.inactive && !this.closed,
        confirmDraft: (content, target) => this.draft(content, target),
        confirmFile: path => this.confirm(path, 'file'),
        openFile: file => this.context?.openFile?.(file) ?? Promise.resolve(false),
        contextChanged: state => {
          this.selection = state;
          context.apps.reportContext(preview.viewId, preview.title, state);
        },
        close: () => {
          void this.closeApp();
        },
      });
      resources.dispose = () => {
        stopContext();
        host.dispose();
      };
      resources.prepareContext = host.prepareContext;
      const { bridge } = host;
      if (payload.updateModelContextSupported) resources.refreshContext = host.refreshContext;
      bridge.ondownloadfile = async ({ contents }) => {
        if (
          this.closed ||
          resources.preparingContext ||
          !current() ||
          !this.visible() ||
          !this.context?.canDraft()
        )
          return { isError: true };
        try {
          const input = prepareMcpAppDownload(contents);
          const result = await window.electron.mcpApps.downloadFile(input);
          return result.success
            ? result.value.canceled
              ? { isError: true, _meta: { canceled: true } }
              : {}
            : { isError: true };
        } catch {
          return { isError: true };
        }
      };
      let initialized!: () => void;
      const initialization = new Promise<void>(resolve => {
        initialized = resolve;
      });
      bridge.oninitialized = () => {
        resources.sharedHeader =
          mcpAppRecord(bridge.getAppCapabilities()?.experimental?.[MCP_APP_SHARED_HEADER])
            ?.version === 1;
        initialized();
      };
      bridge.onsizechange = ({ height }) => {
        if (
          typeof height === 'number' &&
          Number.isFinite(height) &&
          !this.expanded &&
          !this.fillContainer
        ) {
          frame.style.height = `${Math.max(160, Math.min(1200, Math.round(height)))}px`;
        }
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        if (
          current() &&
          this.visible() &&
          (mode === 'inline' || mode === 'fullscreen') &&
          this.modes.includes(mode)
        ) {
          await this.setMode(mode);
          bridge.setHostContext(buildContext());
        }
        return { mode: this.mode };
      };
      bridge.onopenlink = async ({ url: requested }) => {
        const link = new URL(requested);
        if (
          !current() ||
          resources.preparingContext ||
          !this.visible() ||
          !['http:', 'https:'].includes(link.protocol) ||
          link.username ||
          link.password
        )
          return { isError: true };
        const opened = await window.electron.shell.openExternal(link.href);
        return opened.success ? {} : { isError: true };
      };
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error('MCP App initialization cancelled'));
        resources.controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const timeout = owner.setTimeout(() => resources.controller.abort(), 15_000);
      try {
        await bridge.connect(new McpAppFrameTransport(frame, new URL(url).origin));
        await Promise.race([proxyReady, aborted]);
        if (!current()) return;
        await bridge.sendSandboxResourceReady({ html: payload.html, csp: payload.csp });
        await Promise.race([initialization, aborted]);
      } finally {
        owner.clearTimeout(timeout);
        if (abortListener) resources.controller.signal.removeEventListener('abort', abortListener);
        if (readyListener) owner.removeEventListener('message', readyListener);
      }
      if (!current()) return;
      resources.teardown = () =>
        bridge
          .teardownResource({}, { timeout: 1500, maxTotalTimeout: 1500 })
          .then(() => undefined)
          .catch(() => undefined);
      bridge.setHostContext(buildContext());
      await bridge.sendToolInput({ arguments: payload.toolInput ?? {} });
      if (payload.toolResult) await bridge.sendToolResult(payload.toolResult as never);
      if (!current()) return;
      const identity = readNativeMcpAppIdentity(preview);
      const plugin = connectAppContent({
        identity,
        payload,
        previewViewId: preview.viewId,
        preview,
        session: resources.session,
        context,
        bridge,
        current: () => current() && !this.closed && this.context?.canDraft() === true,
        priority: () => (this.visible() ? (this.fillContainer ? 2 : 1) : 0),
      });
      resources.content = plugin?.content;
      resources.localNotice = plugin?.localNotice;
      resources.contentTitle = plugin?.title;
      resources.update = () => bridge.setHostContext(buildContext());
      const observer = new (owner as Window & typeof globalThis).MutationObserver(() =>
        resources.update?.(),
      );
      observer.observe(this.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'style', 'lang'],
      });
      const Resize = (owner as Window & typeof globalThis).ResizeObserver;
      const resize = new Resize(() => resources.update?.());
      resize.observe(this);
      resources.dispose = () => {
        stopContext();
        plugin?.dispose();
        observer.disconnect();
        resize.disconnect();
        host.dispose();
      };
      if (payload.updateModelContextSupported) await host.refreshContext();
      if (!current()) return;
      resources.session.preservePresentation =
        (this.fillContainer || this.retainPresentation) && Boolean(this.context?.resume);
      this.loading = false;
    } catch {
      if (this.resources === resources) {
        this.clear();
        this.error = i18nService.t('mcpAppsUnavailable');
      }
    }
  }

  resume(presentationContext?: McpAppViewContext, preserveOnly = false): void {
    if (this.closed || this.context?.isCurrent()) return;
    const context = presentationContext ?? this.context?.resume?.();
    if (!context?.isCurrent()) return;
    if (
      preserveOnly &&
      (!this.resources?.session.suspended ||
        !this.resources.session.sameNativeIdentity(context.apps.bind()))
    )
      return;
    if (
      presentationContext &&
      this.resources &&
      (this.resources.apps !== context.apps ||
        !this.resources.session.sameNativeIdentity(context.apps.bind()))
    )
      return;
    if (this.resources?.session.suspended && context.apps.resume(this.resources.session)) {
      this.context = context;
      this.error = '';
      this.resources.update?.();
      void this.resources.refreshContext?.().catch(() => undefined);
      this.requestUpdate();
      return;
    }
    this.clear();
    this.context = context;
    this.lastSession = undefined;
    this.error = '';
    this.requestUpdate();
  }

  async prepareContext(): Promise<void> {
    if (
      this.loading ||
      this.error ||
      this.closed ||
      !this.resources?.session.isCurrent() ||
      !this.context?.isCurrent()
    )
      throw new Error('App context is not ready');
    const resources = this.resources;
    if (resources.preparingContext) throw new Error('App context preparation is already pending');
    resources.preparingContext = true;
    try {
      await resources.prepareContext?.();
    } finally {
      resources.preparingContext = false;
    }
  }

  closeApp(): Promise<void> {
    if (this.closing) return this.closing;
    const resources = this.resources;
    this.contextCleanupUnconfirmed = false;
    this.closed = true;
    this.confirmation?.respond(false);
    this.confirmation = undefined;
    this.expanded = false;
    this.mode = 'inline';
    this.error = '';
    this.closing = (async () => {
      try {
        await resources?.teardown?.();
        resources?.dispose?.();
        if (resources) resources.dispose = undefined;
        await this.lastSession?.close();
      } catch {
        this.contextCleanupUnconfirmed = true;
        this.error = i18nService.t('mcpAppsCloseUnknown');
      } finally {
        this.clear();
        this.requestUpdate();
        this.expansionFocus?.focus();
        this.expansionFocus = undefined;
      }
    })();
    return this.closing;
  }

  private async setMode(mode: 'inline' | 'fullscreen'): Promise<void> {
    if (!this.visible() || !this.modes.includes(mode)) return;
    if (this.fillContainer) {
      let accepted = false;
      this.dispatchEvent(
        new CustomEvent(McpAppEvent.DisplayMode, {
          bubbles: true,
          composed: true,
          detail: {
            mode,
            respond: (value: boolean) => {
              accepted = value;
            },
          },
        }),
      );
      if (!accepted) return;
    }
    if (mode === 'fullscreen' && this.mode !== 'fullscreen')
      this.expansionFocus = this.shadowRoot?.activeElement as HTMLElement | undefined;
    this.mode = mode;
    this.expanded = mode === 'fullscreen' && !this.fillContainer;
    await this.updateComplete;
    if (mode === 'inline') {
      const focus = this.expansionFocus?.isConnected
        ? this.expansionFocus
        : this.renderRoot.querySelector<HTMLButtonElement>('[data-action="display-mode"]');
      focus?.focus();
      this.expansionFocus = undefined;
    }
    this.resources?.update?.();
  }

  private async reload(): Promise<void> {
    if (this.loading) return;
    const context = this.context;
    const preview = this.preview;
    const current = () => this.isConnected && this.context === context && this.preview === preview;
    this.loading = true;
    try {
      await this.closing;
      if (!current()) return;
      const version = this.version;
      const reopened = context?.reopen ? await context.reopen() : undefined;
      const refreshed = reopened?.context ?? (context?.refresh ? await context.refresh() : context);
      if (!current() || this.version !== version || !refreshed?.isCurrent()) return;
      if (reopened && !isNativeMcpAppPreview(reopened.preview)) return;
      this.context = refreshed;
      this.clear();
      if (reopened) this.preview = reopened.preview;
      this.closed = false;
      this.closing = undefined;
      this.lastSession = undefined;
      this.error = '';
      this.requestUpdate();
    } catch {
      if (current()) this.error = i18nService.t('mcpAppsUnavailable');
    } finally {
      if (current()) this.loading = false;
    }
  }

  get contentIdentity(): Readonly<McpAppContentIdentity> | undefined {
    return this.resources?.content;
  }

  get contentTitle(): string | undefined {
    return this.resources?.contentTitle;
  }

  get canReference(): boolean {
    return Boolean(
      !this.closed &&
      !this.loading &&
      !this.error &&
      this.resources?.frame &&
      this.resources.session.isCurrent() &&
      this.context?.isCurrent(),
    );
  }

  /** Pin and navigation can occur before Lit's next update. Fence synchronously. */
  setPresentationRetention(retain: boolean): void {
    this.retainPresentation = retain;
    if (this.resources && !this.loading && this.resources.session.isCurrent())
      this.resources.session.preservePresentation =
        (this.fillContainer || retain) && Boolean(this.context?.resume);
  }

  returnToMessage(): void {
    this.fillContainer = false;
    if (this.modes.includes('inline')) this.mode = 'inline';
    this.expanded = this.mode === 'fullscreen';
    this.requestUpdate();
    void this.updateComplete.then(() => this.resources?.update?.());
  }

  protected render() {
    const t = (key: string) => i18nService.t(key);
    const identity = readNativeMcpAppIdentity(this.preview);
    const icons = identity
      ? resolveMcpAppIcons(this.context?.apps.iconCatalog, identity)
      : undefined;
    return html`
      <header
        ?shared=${this.sharedHeader}
        ?hidden=${this.fillContainer && !this.closed}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Escape' && this.expanded && this.modes.includes('inline')) {
            event.preventDefault();
            void this.setMode('inline');
          }
        }}
      >
        <span class="branding">
          <span class="app-icon" aria-hidden="true"
            >${renderMcpAppIcon(icons, this.failedIcons, src => {
              this.failedIcons = [...this.failedIcons, src];
              this.requestUpdate();
            })}</span
          >
          <span class="title" title=${this.contentTitle ?? this.preview?.title ?? t('mcpAppsTitle')}
            >${this.contentTitle ?? this.preview?.title ?? t('mcpAppsTitle')}</span
          >
        </span>
        ${this.inactive && !this.closed && !this.resources?.localNotice ? html`<span class="notice" title=${t('mcpAppsReadOnly')}>${t('mcpAppsReadOnly')}</span>` : nothing}
        <span class="app-header-space" aria-hidden="true"></span>
        <span class="host-actions">
          ${
            !this.closed
              ? html`${this.pinPresentation ? html`<button class="icon-button" data-action="pin" ?disabled=${!this.canReference} aria-label=${t('mcpAppsPin')} title=${t('mcpAppsPin')} @click=${() => this.pinPresentation?.()}>${icon('M14 3h7v7 M21 3l-9 9 M21 14v6H4V3h6')}</button>` : nothing}${!this.expanded && this.modes.includes('inline') && this.modes.includes('fullscreen') ? html`<button class="icon-button" data-action="display-mode" aria-label=${t(this.mode === 'fullscreen' ? 'mcpAppsReturn' : 'mcpAppsExpand')} title=${t(this.mode === 'fullscreen' ? 'mcpAppsReturn' : 'mcpAppsExpand')} @click=${() => void this.setMode(this.mode === 'fullscreen' ? 'inline' : 'fullscreen')}>${icon(this.mode === 'fullscreen' ? 'M4 9h5V4 M20 9h-5V4 M4 15h5v5 M20 15h-5v5' : 'M9 4H4v5 M15 4h5v5 M4 15v5h5 M20 15v5h-5')}</button>` : nothing}
                  <button
                    class="icon-button"
                    data-action="dismiss"
                    aria-label=${t(this.expanded && this.modes.includes('inline') ? 'mcpAppsReturn' : 'mcpAppsClose')}
                    title=${t(this.expanded && this.modes.includes('inline') ? 'mcpAppsReturn' : 'mcpAppsClose')}
                    @click=${() => {
                      if (this.expanded && this.modes.includes('inline'))
                        void this.setMode('inline');
                      else void this.closeApp();
                    }}
                  >
                    ${icon('m6 6 12 12 M6 18 18 6')}
                  </button>`
              : html`<button
                  class="icon-button"
                  data-action="reopen"
                  aria-label=${t('mcpAppsReopen')}
                  title=${t('mcpAppsReopen')}
                  ?disabled=${this.loading}
                  @click=${() => void this.reload()}
                >
                  ${icon('M3 10a9 9 0 1 1 2.6 8.4 M3 4v6h6')}
                </button>`
          }
        </span>
      </header>
      ${
        this.confirmation
          ? html`<div class="confirmation">
              ${t(this.confirmation.purpose === 'file' ? 'mcpAppsConfirmFile' : this.confirmation.purpose === 'new' ? 'mcpAppsConfirmNewDraft' : 'mcpAppsConfirmDraft')}
              <p>${this.confirmation.text}</p>
              <div class="actions">
                <button class="primary" @click=${() => this.confirmation?.respond(true)}>
                  ${t(this.confirmation.purpose === 'file' ? 'mcpAppsPreview' : 'mcpAppsAddDraft')}
                </button>
                <button @click=${() => this.confirmation?.respond(false)}>
                  ${t('mcpAppsCancel')}
                </button>
              </div>
            </div>`
          : nothing
      }
      ${this.inactive && !this.closed && this.fillContainer && !this.resources?.localNotice ? html`<div class="notice">${t('mcpAppsReadOnly')}</div>` : nothing}
      ${this.loading ? html`<div class="status" role="status"><span class="spinner" aria-hidden="true"></span>${t('mcpAppsLoading')}</div>` : nothing}
      ${
        this.error
          ? html`<div class="status" role="status">
              <span>${this.error}</span>
              ${
                !this.closed
                  ? html`<button
                      @click=${() => {
                        void this.reload();
                      }}
                    >
                      ${t('mcpAppsRetry')}
                    </button>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${this.closed && !this.resources ? nothing : keyed(this.mountKey, html`<div class="mount"></div>`)}
    `;
  }
}

if (!customElements.get('mcp-app-view')) customElements.define('mcp-app-view', McpAppView);

/** Optional content association cannot replace current native view authorization. */
export function findMcpAppContentView(
  reference: McpAppContentReference,
  context: McpAppViewContext,
): McpAppView | undefined {
  const source = reference.content;
  if (
    !isNativeAppReference(reference) ||
    !context.isCurrent() ||
    context.sessionKey !== source.sessionKey
  )
    return;
  const binding = context.apps.bind();
  if (binding.sessionId !== source.sessionId || binding.agentId !== source.agentId) return;
  return [...appViews].find(view => {
    if (!view.context?.isCurrent()) return false;
    const owner = view.context.apps.bind();
    if (
      owner.sessionKey !== source.sessionKey ||
      owner.sessionId !== source.sessionId ||
      owner.agentId !== source.agentId
    )
      return false;
    if (view.contentIdentity)
      return (Object.keys(source) as Array<keyof McpAppContentIdentity>).every(
        key => view.contentIdentity?.[key] === source[key],
      );
    const identity = readNativeMcpAppIdentity(view.preview);
    return (
      identity?.viewId === source.originViewId &&
      identity.serverName === source.serverName &&
      identity.uiResourceUri === source.uiResourceUri &&
      identity.originSessionKey === source.sessionKey
    );
  });
}

import type { WidgetViewportLayout } from '@shared/widgets/viewer';

import { widgetFrameInteractable } from './draft';
import {
  normalizeWidgetLink,
  WIDGET_LINK_OFFER,
  WIDGET_LINK_OPEN,
  WIDGET_LINK_READY,
  withWidgetLinks,
} from './links';
import { postNativeWidgetMessage } from './messaging';
import {
  WIDGET_LAYOUT_READY,
  WIDGET_LAYOUT_REQUEST,
  WIDGET_MEASURED_HEIGHT,
  withWidgetSizing,
} from './sizing';

/** Minimal adapter for OpenClaw's native sandbox transport; no dashboard authority. */
export const NATIVE_WIDGET_CONTEXT_REQUEST = 'native-widget-context-request';
export const NATIVE_WIDGET_DRAFT_EVENT = 'native-widget-draft';
export const WIDGET_SLOW_NOTICE_MS = 10_000;
export const WIDGET_TIMEOUT_MS = 30_000;
export const MAX_WIDGET_BYTES = 10 * 1024 * 1024;

export interface NativeWidgetClient {
  readonly generation: number;
  readonly gatewayUrl: string;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface NativeWidgetContext {
  client: NativeWidgetClient;
  generation: number;
  sessionKey: string;
  /** Also checks current controller connection and session after asynchronous work. */
  isCurrent: () => boolean;
  /** Live product admission; read-only views retain local interaction without draft actions. */
  canDraft: () => boolean;
  /** Opens a web link in this consumer's own workspace, independently of draft permission. */
  openLink?: (url: string) => void;
}

export function resolveNativeSandboxUrl(
  value: unknown,
  gatewayUrl: string,
  hostOrigin: string,
): string {
  if (!value || typeof value !== 'object') throw new Error('invalid sandbox');
  const view = value as Record<string, unknown>;
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol === 'ws:') gateway.protocol = 'http:';
  if (gateway.protocol === 'wss:') gateway.protocol = 'https:';
  const host = new URL(hostOrigin);
  if (
    !['http:', 'https:'].includes(gateway.protocol) ||
    !['http:', 'https:'].includes(host.protocol) ||
    gateway.username ||
    gateway.password
  )
    throw new Error('invalid origin');
  if (
    !Number.isInteger(view.sandboxPort) ||
    (view.sandboxPort as number) < 1 ||
    (view.sandboxPort as number) > 65535 ||
    typeof view.sandboxUrl !== 'string'
  )
    throw new Error('invalid sandbox');
  // Accept only the configured Gateway's own dedicated listener. An authenticated
  // response cannot turn this viewer into a credentialed cross-origin navigator.
  const base = new URL(gateway.origin);
  base.port = String(view.sandboxPort);
  if (
    view.sandboxOrigin !== undefined &&
    (typeof view.sandboxOrigin !== 'string' ||
      new URL(view.sandboxOrigin).origin !== base.origin ||
      view.sandboxOrigin.replace(/\/$/, '') !== base.origin)
  )
    throw new Error('invalid sandbox origin');
  const url = new URL(view.sandboxUrl, base);
  if (
    base.origin === gateway.origin ||
    base.origin === host.origin ||
    url.origin !== base.origin ||
    url.pathname !== '/mcp-app-sandbox' ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('invalid sandbox URL');
  // Native buildSandboxHostPath carries bounded CSP metadata and a SHA-256 shell
  // version. Admit exactly those public fields, never auth or arbitrary query data.
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'csp' && key !== 'v') || new Set(keys).size !== keys.length)
    throw new Error('invalid sandbox query');
  if (keys.length && !/^[a-f0-9]{64}$/.test(url.searchParams.get('v') ?? ''))
    throw new Error('invalid sandbox version');
  const csp = url.searchParams.get('csp');
  if (
    csp !== null &&
    (!/^[A-Za-z0-9_-]+$/.test(csp) || csp.length > Math.ceil((5 * 1024) / 3) * 4 + 4)
  )
    throw new Error('invalid sandbox CSP');
  return url.href;
}

export class NativeWidgetSandboxHost {
  private active = true;
  private ready = false;
  private delivered = false;
  private rendered = false;
  private renderId = crypto.randomUUID();
  private sizingId = crypto.randomUUID();
  private linkId = crypto.randomUUID();
  private linkPort?: MessagePort;
  private linksDisabled = false;
  private lastLinkAt = -Infinity;
  private layout?: WidgetViewportLayout;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    readonly frame: HTMLIFrameElement,
    readonly url: string,
    private html: string,
    private onRendered: () => void,
    private onFailure: () => void,
    private onOpenLink?: (url: string) => void,
  ) {
    this.timer = setTimeout(() => {
      if (this.active) this.onFailure();
    }, WIDGET_TIMEOUT_MS);
  }

  get loaded(): boolean {
    return this.delivered;
  }

  setLayout(layout: WidgetViewportLayout): void {
    if (this.layout && layout.revision < this.layout.revision) return;
    this.layout = layout;
    if (this.active && this.delivered)
      postNativeWidgetMessage(
        this.frame,
        { type: WIDGET_LAYOUT_REQUEST, id: this.sizingId, layout },
        new URL(this.url).origin,
      );
  }

  handleMessage(event: MessageEvent): { height: number; revision: number } | undefined {
    if (
      !this.active ||
      event.source !== this.frame.contentWindow ||
      event.origin !== new URL(this.url).origin
    )
      return;
    if (
      event.data?.method === 'ui/notifications/sandbox-proxy-ready' &&
      event.data?.params?.sandboxUrl === this.url &&
      !this.ready
    ) {
      this.ready = true;
      const delivered = postNativeWidgetMessage(
        this.frame,
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/sandbox-resource-ready',
          params: {
            html: withWidgetLinks(withWidgetSizing(this.html, this.sizingId), this.linkId),
            renderId: this.renderId,
          },
        },
        event.origin,
      );
      if (!delivered) {
        this.onFailure();
        return;
      }
      this.delivered = true;
      this.html = '';
    }
    if (
      this.delivered &&
      event.data?.method === 'ui/notifications/sandbox-resource-loaded' &&
      event.data?.params?.renderId === this.renderId
    ) {
      clearTimeout(this.timer);
      this.rendered = true;
      this.onRendered();
    }
    if (event.data?.type === WIDGET_LINK_OFFER) {
      const port = event.ports[0];
      if (
        !this.delivered ||
        this.linksDisabled ||
        !this.onOpenLink ||
        this.linkPort ||
        event.data.linkId !== this.linkId ||
        !port ||
        event.ports.length !== 1
      ) {
        for (const offered of event.ports) offered.close();
        return;
      }
      this.linkPort = port;
      port.onmessage = message => {
        if (
          !this.active ||
          !this.rendered ||
          this.linksDisabled ||
          this.linkPort !== port ||
          message.data?.type !== WIDGET_LINK_OPEN ||
          !widgetFrameInteractable(this.frame) ||
          this.frame.ownerDocument.defaultView?.navigator.userActivation?.isActive !== true
        )
          return;
        const url = normalizeWidgetLink(message.data.url);
        const now = Date.now();
        if (!url || now - this.lastLinkAt < 250) return;
        this.lastLinkAt = now;
        this.onOpenLink?.(url);
      };
      port.start();
      port.postMessage({ type: WIDGET_LINK_READY });
      return;
    }
    if (
      this.delivered &&
      event.data?.type === WIDGET_LAYOUT_READY &&
      event.data.id === this.sizingId &&
      this.layout
    )
      this.setLayout(this.layout);
    const value = event.data;
    const layout = this.layout;
    if (
      this.delivered &&
      value?.type === WIDGET_MEASURED_HEIGHT &&
      value.id === this.sizingId &&
      layout &&
      value.revision === layout.revision &&
      Number.isFinite(value.height) &&
      value.height > 0 &&
      Number.isFinite(value.width) &&
      Math.abs(value.width - layout.width) <= 1 &&
      Number.isFinite(value.viewportHeight) &&
      Math.abs(value.viewportHeight - layout.height) <= 1
    )
      return {
        height: Math.min(8000, Math.max(48, Math.ceil(value.height))),
        revision: layout.revision,
      };
  }

  dispose(): void {
    this.active = false;
    this.disableLinks();
    this.html = '';
    clearTimeout(this.timer);
  }

  disableLinks(): void {
    this.linksDisabled = true;
    this.linkPort?.close();
    this.linkPort = undefined;
  }
}

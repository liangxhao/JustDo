import { postNativeWidgetMessage } from './messaging';

/** Minimal adapter for OpenClaw's native sandbox transport; no dashboard authority. */
export const NATIVE_WIDGET_CONTEXT_REQUEST = 'native-widget-context-request';
export const NATIVE_WIDGET_DRAFT_EVENT = 'native-widget-draft';
export const WIDGET_TIMEOUT_MS = 10_000;
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
  private renderId = crypto.randomUUID();
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    readonly frame: HTMLIFrameElement,
    readonly url: string,
    private html: string,
    private onRendered: () => void,
    private onFailure: () => void,
  ) {
    this.timer = setTimeout(() => {
      if (this.active) this.onFailure();
    }, WIDGET_TIMEOUT_MS);
  }

  get loaded(): boolean {
    return this.delivered;
  }

  handleMessage(event: MessageEvent): void {
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
          params: { html: this.html, renderId: this.renderId },
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
      this.onRendered();
    }
  }

  dispose(): void {
    this.active = false;
    this.html = '';
    clearTimeout(this.timer);
  }
}

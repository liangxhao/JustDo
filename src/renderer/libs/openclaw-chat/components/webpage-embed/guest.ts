import {
  WEBPAGE_EMBED_OPEN_LINK_EVENT,
  type WebpageEmbedApi,
  type WebpageEmbedEvent,
  WebpageEmbedIpc,
  type WebpageEmbedMount,
} from '@shared/browser/webpageEmbed';

export type WebpageEmbedFrame = HTMLElement & { src: string };

/** Semantic events come from Main or the exact Main-admitted hosted shell webview. */
export class WebpageEmbedGuest {
  private active = true;
  private readonly unsubscribe: () => void;
  constructor(
    readonly frame: WebpageEmbedFrame,
    readonly mount: WebpageEmbedMount,
    api: WebpageEmbedApi,
    private readonly receive: (event: WebpageEmbedEvent) => void,
  ) {
    this.unsubscribe = api.onEvent(this.semanticEvent);
    frame.addEventListener('ipc-message', this.message);
    frame.addEventListener('render-process-gone', this.failure);
    frame.addEventListener('did-fail-load', this.loadFailure);
    frame.setAttribute('partition', mount.partition);
    frame.src = mount.viewerUrl;
  }
  private readonly message = (raw: Event) => {
    const event = raw as Event & { channel?: string; args?: unknown[] };
    if (
      !this.active ||
      event.currentTarget !== this.frame ||
      event.target !== this.frame ||
      event.channel !== WebpageEmbedIpc.Event ||
      event.args?.length !== 1
    )
      return;
    const value = event.args[0] as WebpageEmbedEvent | null;
    // Link requests are accepted only from Main's authenticated owner channel,
    // never from the hosted shell's page-facing status bridge.
    if (value?.type !== WEBPAGE_EMBED_OPEN_LINK_EVENT) this.semanticEvent(value);
  };
  private readonly semanticEvent = (raw: unknown) => {
    const value = raw as WebpageEmbedEvent | null;
    if (
      !this.active ||
      !value ||
      value.mountId !== this.mount.mountId
    )
      return;
    if (value.type === WEBPAGE_EMBED_OPEN_LINK_EVENT) {
      if (typeof value.url !== 'string') return;
      try {
        const url = new URL(value.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
        this.receive({ mountId: value.mountId, type: value.type, url: url.href });
      } catch {
        // A malformed Main payload must not become a browser action.
      }
      return;
    }
    if (!['initialized', 'failure', 'proxy-pending', 'proxy-ready', 'proxy-failed'].includes(value.type))
      return;
    this.receive({ mountId: value.mountId, type: value.type });
  };
  private readonly failure = () => {
    if (this.active) this.receive({ mountId: this.mount.mountId, type: 'failure' });
  };
  private readonly loadFailure = (event: Event) => {
    const failure = event as Event & { isMainFrame?: boolean; errorCode?: number };
    if (failure.errorCode !== -3 && failure.isMainFrame !== false) this.failure();
  };
  dispose(): void {
    this.active = false;
    this.unsubscribe();
    this.frame.removeEventListener('ipc-message', this.message);
    this.frame.removeEventListener('render-process-gone', this.failure);
    this.frame.removeEventListener('did-fail-load', this.loadFailure);
    this.frame.remove();
  }
}

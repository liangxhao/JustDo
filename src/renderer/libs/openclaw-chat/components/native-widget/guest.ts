import {
  WIDGET_VIEWER_PAGE,
  WIDGET_VIEWER_PARTITION,
  type WidgetViewerEvent,
  WidgetViewerIpc,
  type WidgetViewerState,
} from '@shared/widgets/viewer';

import { WIDGET_TIMEOUT_MS } from './host';

export type WidgetWebview = HTMLElement & {
  src: string;
  send: (channel: string, ...args: unknown[]) => Promise<void>;
};

/** Only this webview can deliver semantic events; no page/window message relay. */
export class NativeWidgetGuestHost {
  private active = true;
  private failed = false;
  private initialized = false;
  private mountId = crypto.randomUUID();
  private state: WidgetViewerState = { draftAllowed: false, theme: { mode: 'light', tokens: {} } };
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly frame: WidgetWebview,
    private url: string,
    private html: string,
    private receive: (event: WidgetViewerEvent) => void,
  ) {
    this.timer = setTimeout(() => this.fail(), WIDGET_TIMEOUT_MS);
    frame.addEventListener('dom-ready', this.initialize);
    frame.addEventListener('ipc-message', this.onMessage);
    frame.addEventListener('render-process-gone', this.fail);
    frame.addEventListener('did-fail-load', this.loadFailure);
    frame.setAttribute('partition', WIDGET_VIEWER_PARTITION);
    const viewer = new URL(WIDGET_VIEWER_PAGE, frame.ownerDocument.location.href);
    viewer.searchParams.set('mount', this.mountId);
    frame.src = viewer.href;
  }
  private readonly initialize = () => {
    if (!this.active || this.failed || this.initialized) return;
    this.initialized = true;
    this.send(WidgetViewerIpc.Initialize, {
      ...this.state,
      mountId: this.mountId,
      url: this.url,
      html: this.html,
    });
    this.html = '';
  };
  private send(channel: string, value: unknown): void {
    if (!this.active || this.failed || !this.initialized) return;
    if (!this.frame.isConnected) {
      this.fail();
      return;
    }
    try {
      // Electron webview methods use asynchronous guest-manager IPC. A guest
      // can disappear after dispatch; synchronous try/catch alone cannot catch
      // that rejection. The failure latch also ignores results after disposal.
      void Promise.resolve(this.frame.send(channel, value)).catch(this.fail);
    } catch {
      this.fail();
    }
  }
  private readonly onMessage = (raw: Event) => {
    const event = raw as Event & { channel: string; args: unknown[] };
    if (
      !this.active ||
      this.failed ||
      !this.initialized ||
      event.channel !== WidgetViewerIpc.Event ||
      event.args.length !== 1
    )
      return;
    const value = event.args[0] as WidgetViewerEvent;
    if (!value || value.mountId !== this.mountId) return;
    if (value.type === 'ready') clearTimeout(this.timer);
    this.receive(value);
  };
  private readonly fail = () => {
    if (!this.active || this.failed) return;
    // The receiver revokes draft policy before disposing the guest. Latch first
    // so a failed IPC send cannot re-enter failure through that policy update.
    this.failed = true;
    this.html = '';
    clearTimeout(this.timer);
    this.receive({ mountId: this.mountId, type: 'failure', runtime: false });
  };
  private readonly loadFailure = (event: Event) => {
    if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) this.fail();
  };
  update(state: WidgetViewerState): void {
    this.state = state;
    this.send(WidgetViewerIpc.State, state);
  }
  setDraftAllowed(draftAllowed: boolean): void {
    this.update({ ...this.state, draftAllowed });
  }
  dispose(): void {
    this.active = false;
    this.html = '';
    clearTimeout(this.timer);
    this.frame.removeEventListener('dom-ready', this.initialize);
    this.frame.removeEventListener('ipc-message', this.onMessage);
    this.frame.removeEventListener('render-process-gone', this.fail);
    this.frame.removeEventListener('did-fail-load', this.loadFailure);
    // Disconnect immediately; a delayed Lit render must not leave an old guest alive.
    this.frame.remove();
  }
}

/** The native widget viewer has its own ephemeral network/storage session. */
export const WIDGET_VIEWER_PARTITION = 'native-widget-viewer';
export const WIDGET_VIEWER_PAGE = '/widget-viewer.html';
export const WidgetViewerIpc = {
  ProxyReady: 'widget-viewer:proxy-ready',
  Initialize: 'widget-viewer:initialize',
  State: 'widget-viewer:state',
  Event: 'widget-viewer:event',
} as const;

export type WidgetViewportLayout = {
  revision: number;
  expanded: boolean;
  width: number;
  height: number;
};

export type WidgetViewerState = {
  draftAllowed: boolean;
  theme: { mode: 'light' | 'dark'; tokens: Record<string, string> };
  layout?: WidgetViewportLayout;
};
export type WidgetViewerInitialize = WidgetViewerState & {
  mountId: string;
  html: string;
  url: string;
};
export type WidgetViewerEvent = { mountId: string } & (
  | { type: 'ready' }
  | { type: 'failure'; runtime: boolean }
  | { type: 'height'; height: number; revision: number }
  | { type: 'scroll'; deltaY: number }
  | { type: 'draft'; text: string }
  | { type: 'link'; url: string }
);
export type WidgetViewerBridge = {
  onInitialize: (callback: (value: WidgetViewerInitialize) => void) => void;
  onState: (callback: (value: WidgetViewerState) => void) => void;
  emit: (value: WidgetViewerEvent) => void;
};

/** Only a fixed same-application page can receive the minimal guest preload. */
export function widgetViewerMount(url: string, ownerUrl: string): string | undefined {
  try {
    const viewer = new URL(url);
    const owner = new URL(ownerUrl);
    const mount = viewer.searchParams.get('mount');
    if (
      !['http:', 'https:'].includes(owner.protocol) ||
      viewer.origin !== owner.origin ||
      viewer.username ||
      viewer.password ||
      viewer.hash ||
      viewer.pathname !== WIDGET_VIEWER_PAGE ||
      [...viewer.searchParams].length !== 1 ||
      !mount ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(mount)
    )
      return;
    return mount;
  } catch {
    return;
  }
}

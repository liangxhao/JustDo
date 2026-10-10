export const NATIVE_WIDGET_OWNER_MESSENGER = 'justdoPostNativeWidgetMessage';
type OwnerMessenger = (frame: HTMLIFrameElement, message: unknown, targetOrigin: string) => boolean;
type WidgetWindow = Window & { [NATIVE_WIDGET_OWNER_MESSENGER]?: OwnerMessenger };

function postInCurrentDocument(
  frame: HTMLIFrameElement,
  message: unknown,
  targetOrigin: string,
): boolean {
  if (frame.ownerDocument !== document || !frame.isConnected || frame.localName !== 'iframe')
    return false;
  const root = frame.getRootNode() as ShadowRoot;
  if (root.host?.localName !== 'justdo-native-widget') return false;
  if (!message || typeof message !== 'object') return false;
  const data = message as Record<string, unknown>;
  if (data.method !== undefined) {
    if (data.method !== 'ui/notifications/sandbox-resource-ready') return false;
  } else if (
    typeof data.type !== 'string' ||
    ![
      'openclaw:widget-theme',
      'openclaw:widget-chat-host',
      'openclaw:scenario-draft-policy',
    ].includes(data.type)
  ) {
    return false;
  }
  try {
    const url = new URL(frame.src);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/mcp-app-sandbox' ||
      url.origin !== targetOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      !frame.contentWindow
    )
      return false;
    frame.contentWindow.postMessage(message, targetOrigin);
    return true;
  } catch {
    return false;
  }
}

/** Called by the workspace's own static module, never by a Main-realm callback. */
export function installNativeWidgetMessaging(): void {
  Object.defineProperty(window, NATIVE_WIDGET_OWNER_MESSENGER, { value: postInCurrentDocument });
}

/** postMessage's source is its caller realm, which must be the sandbox's parent. */
export function postNativeWidgetMessage(
  frame: HTMLIFrameElement,
  message: unknown,
  targetOrigin: string,
): boolean {
  const owner = frame.ownerDocument.defaultView as WidgetWindow | null;
  if (!owner) return false;
  if (owner === window) return postInCurrentDocument(frame, message, targetOrigin);
  try {
    const messenger = owner[NATIVE_WIDGET_OWNER_MESSENGER];
    return typeof messenger === 'function' && messenger(frame, message, targetOrigin) === true;
  } catch {
    return false;
  }
}

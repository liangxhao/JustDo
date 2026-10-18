import { type JSONRPCMessage, specTypeSchemas, type Transport } from '@modelcontextprotocol/client';

const MESSENGER = 'registerMcpAppFrameTransport';
type Sender = { send: (message: JSONRPCMessage) => void; close: () => void };
type Register = (frame: HTMLIFrameElement, origin: string) => Sender;
type OwnerWindow = Window & { [MESSENGER]?: Register };

/** Executed in the iframe's actual parent realm, including workspace.html. */
function registerInDocument(frame: HTMLIFrameElement, origin: string): Sender {
  const host = (frame.getRootNode() as ShadowRoot).host;
  const url = new URL(frame.src);
  if (
    frame.ownerDocument !== document ||
    !frame.isConnected ||
    host?.localName !== 'mcp-app-view' ||
    url.origin !== origin ||
    url.pathname !== '/mcp-app-sandbox' ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new Error('Invalid MCP App frame owner');
  }
  let active = true;
  return {
    send(message) {
      if (
        !active ||
        !frame.isConnected ||
        frame.ownerDocument !== document ||
        frame.src !== url.href ||
        !frame.contentWindow
      )
        throw new Error('MCP App frame retired');
      frame.contentWindow.postMessage(message, origin);
    },
    close() {
      active = false;
    },
  };
}

export function installMcpAppFrameMessaging(): void {
  if (!Object.prototype.hasOwnProperty.call(window, MESSENGER))
    Object.defineProperty(window, MESSENGER, { value: registerInDocument });
}

/** No global-window listeners, wildcard origins, credentials or RPC logging. */
export class McpAppFrameTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private sender?: Sender;
  private readonly owner: OwnerWindow;
  private started = false;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly origin: string,
  ) {
    const owner = frame.ownerDocument.defaultView as OwnerWindow | null;
    if (!owner) throw new Error('MCP App document is unavailable');
    this.owner = owner;
  }

  private readonly receive = (event: MessageEvent): void => {
    if (
      !this.started ||
      !this.frame.isConnected ||
      this.frame.ownerDocument.defaultView !== this.owner ||
      event.source !== this.frame.contentWindow ||
      event.origin !== this.origin
    )
      return;
    const result = specTypeSchemas.JSONRPCMessage['~standard'].validate(event.data);
    if (result.issues) return;
    this.onmessage?.(result.value);
  };

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP App transport already started');
    this.sender =
      this.owner === window
        ? registerInDocument(this.frame, this.origin)
        : this.owner[MESSENGER]?.(this.frame, this.origin);
    if (!this.sender) throw new Error('MCP App owner messenger unavailable');
    this.started = true;
    this.owner.addEventListener('message', this.receive);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || !this.sender) throw new Error('MCP App transport is closed');
    this.sender.send(message);
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.owner.removeEventListener('message', this.receive);
    this.sender?.close();
    this.sender = undefined;
    this.onclose?.();
  }
}

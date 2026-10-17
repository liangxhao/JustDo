const REQUEST_TIMEOUT_MS = 60_000;

export class AppServerClient {
  constructor(onNotification) {
    this.onNotification = onNotification;
    this.socket = null;
    this.connectPromise = null;
    this.disposed = false;
    this.nextRequestId = 0;
    this.pending = new Map();
    this.reconnectTimer = null;
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connectPromise = this.open();
    try {
      await this.connectPromise;
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async open() {
    const browserWindow = await chrome.windows.getCurrent();
    const bootstrap = await chrome.runtime.sendMessage({
      type: 'justdo:app-server:ensure',
      clientId:
        typeof browserWindow.id === 'number' ? `sidepanel-window-${browserWindow.id}` : undefined,
    });
    if (!bootstrap?.ok) throw new Error(bootstrap?.error ?? 'Unable to connect to JustDo.');
    const socket = new WebSocket(bootstrap.localAppServerUrl);
    this.socket = socket;
    try {
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener(
          'error',
          () => reject(new Error('Unable to open the JustDo app-server WebSocket.')),
          { once: true },
        );
        socket.addEventListener('message', event => this.handleMessage(event.data));
        socket.addEventListener('close', () => this.handleClose(socket));
      });
      await this.sendRequest('initialize', {
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
        clientInfo: {
          name: 'justdo-chrome-extension-sidepanel',
          title: '__PRODUCT_NAME__ Chrome Extension Sidepanel',
          version: chrome.runtime.getManifest().version,
        },
      });
      socket.send(JSON.stringify({ method: 'initialized' }));
    } catch (error) {
      socket.close();
      this.handleClose(socket);
      throw error;
    }
  }

  async request(method, params = {}) {
    await this.connect();
    return this.sendRequest(method, params);
  }

  sendRequest(method, params = {}) {
    const id = `${method}:${crypto.randomUUID?.() ?? ++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request ${method} timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { reject, resolve, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message ?? 'App-server failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') this.onNotification?.(message.method, message.params);
  }

  handleClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('JustDo app-server disconnected.'));
    }
    this.pending.clear();
    if (!this.disposed) {
      this.onNotification?.('connection/closed', {});
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect()
        .then(() => this.onNotification?.('connection/reconnected', {}))
        .catch(() => this.scheduleReconnect());
    }, 1000);
  }

  disconnect() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    socket?.close(1000, 'Side panel closed.');
    if (socket) this.handleClose(socket);
  }
}

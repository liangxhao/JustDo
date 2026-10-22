const REQUEST_TIMEOUT_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 45_000;
const SOCKET_TIMEOUT_MS = 10_000;
const INITIALIZE_TIMEOUT_MS = 15_000;

function connectionError(message, code, stage, requestSent = false) {
  return Object.assign(new Error(message), { code, stage, requestSent });
}

function waitForConnection(promise, cancellation, timeoutMs, error) {
  let timeout;
  return Promise.race([
    promise,
    cancellation,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(error), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function closeSocket(socket) {
  try {
    socket?.close(1000, 'Side panel connection closed.');
  } catch {
    // Closing a connection that never opened must not prevent rediscovery.
  }
}

export class AppServerClient {
  constructor(onNotification) {
    this.onNotification = onNotification;
    this.socket = null;
    this.connectPromise = null;
    this.disposed = false;
    this.nextRequestId = 0;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.openAttempt = 0;
    this.cancelOpen = null;
  }

  async connect() {
    if (this.disposed) {
      throw connectionError('The side panel is closed.', 'CLIENT_CLOSED', 'discovery');
    }
    if (this.connectPromise) return this.connectPromise;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const connecting = this.open();
    this.connectPromise = connecting;
    try {
      await connecting;
    } catch (error) {
      if (!this.disposed) {
        this.onNotification?.('connection/failed', {
          code: error.code ?? 'SOCKET_ERROR',
          stage: error.stage ?? 'discovery',
        });
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      if (this.connectPromise === connecting) this.connectPromise = null;
    }
  }

  async open() {
    const attempt = ++this.openAttempt;
    let socket;
    let stage = 'discovery';
    let cancel;
    const cancellation = new Promise((_, reject) => {
      cancel = () =>
        reject(connectionError('The side panel is closed.', 'CLIENT_CLOSED', 'discovery'));
    });
    this.cancelOpen = cancel;
    const ensureCurrent = () => {
      if (this.disposed || attempt !== this.openAttempt) {
        throw connectionError('The side panel is closed.', 'CLIENT_CLOSED', 'discovery');
      }
    };
    try {
      const discover = async () => {
        const browserWindow = await chrome.windows.getCurrent();
        ensureCurrent();
        return chrome.runtime.sendMessage({
          type: 'justdo:app-server:ensure',
          clientId:
            typeof browserWindow.id === 'number'
              ? `sidepanel-window-${browserWindow.id}`
              : undefined,
        });
      };
      const bootstrap = await waitForConnection(
        discover(),
        cancellation,
        DISCOVERY_TIMEOUT_MS,
        connectionError('Desktop discovery timed out.', 'DISCOVERY_TIMEOUT', 'discovery'),
      );
      ensureCurrent();
      if (!bootstrap?.ok) {
        throw connectionError(
          bootstrap?.error ?? 'Unable to discover the desktop app.',
          bootstrap?.code ?? 'NATIVE_HOST_UNAVAILABLE',
          'discovery',
        );
      }
      stage = 'socket';
      socket = new WebSocket(bootstrap.localAppServerUrl);
      this.socket = socket;
      await waitForConnection(
        new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener(
            'error',
            () =>
              reject(
                connectionError(
                  'Unable to open the app-server WebSocket.',
                  'SOCKET_ERROR',
                  'socket',
                ),
              ),
            { once: true },
          );
          socket.addEventListener('message', event => {
            if (this.socket === socket) this.handleMessage(event.data);
          });
          socket.addEventListener('close', () => {
            reject(connectionError('The app-server WebSocket closed.', 'SOCKET_CLOSED', 'socket'));
            this.handleClose(socket);
          });
        }),
        cancellation,
        SOCKET_TIMEOUT_MS,
        connectionError('The app-server WebSocket timed out.', 'SOCKET_TIMEOUT', 'socket'),
      );
      ensureCurrent();
      stage = 'initialize';
      await waitForConnection(
        this.sendRequest('initialize', {
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
        }),
        cancellation,
        INITIALIZE_TIMEOUT_MS,
        connectionError('App-server initialization timed out.', 'INITIALIZE_TIMEOUT', 'initialize'),
      );
      ensureCurrent();
      socket.send(JSON.stringify({ method: 'initialized' }));
    } catch (error) {
      if (socket && this.socket === socket) {
        closeSocket(socket);
        this.handleClose(socket);
      }
      // Discovery and initialization never submit the caller's chat request.
      const failure =
        error instanceof Error ? error : new Error('Unable to connect to the app-server.');
      failure.requestSent = false;
      if (!failure.stage || failure.stage === 'request') failure.stage = stage;
      failure.code ??= stage === 'discovery' ? 'NATIVE_HOST_UNAVAILABLE' : 'SOCKET_ERROR';
      throw failure;
    } finally {
      if (this.cancelOpen === cancel) this.cancelOpen = null;
    }
  }

  async request(method, params = {}) {
    await this.connect();
    return this.sendRequest(method, params);
  }

  sendRequest(method, params = {}) {
    const socket = this.socket;
    const id = `${method}:${crypto.randomUUID?.() ?? ++this.nextRequestId}`;
    let raw;
    try {
      raw = JSON.stringify({ id, method, params });
    } catch {
      return Promise.reject(
        connectionError('Invalid app-server request.', 'INVALID_REQUEST', 'request'),
      );
    }
    if (this.disposed || socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        connectionError('The app-server is disconnected.', 'SOCKET_CLOSED', 'request'),
      );
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          connectionError(
            `App-server request ${method} timed out.`,
            'REQUEST_TIMEOUT',
            'request',
            true,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { reject, resolve, timeout, socket });
      try {
        socket.send(raw);
      } catch {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(
          connectionError('Unable to send the app-server request.', 'SOCKET_CLOSED', 'request'),
        );
      }
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          connectionError(
            message.error.message ?? 'App-server failed.',
            message.error.data?.code ?? 'REQUEST_REJECTED',
            'request',
            message.error.data?.requestSent !== false,
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') this.onNotification?.(message.method, message.params);
  }

  handleClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timeout);
      pending.reject(
        connectionError('The app-server disconnected.', 'SOCKET_CLOSED', 'request', true),
      );
      this.pending.delete(id);
    }
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
        .then(() => {
          if (!this.disposed) this.onNotification?.('connection/reconnected', {});
        })
        .catch(() => this.scheduleReconnect());
    }, 1000);
  }

  disconnect() {
    this.disposed = true;
    this.openAttempt += 1;
    this.cancelOpen?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    closeSocket(socket);
    if (socket) this.handleClose(socket);
  }
}

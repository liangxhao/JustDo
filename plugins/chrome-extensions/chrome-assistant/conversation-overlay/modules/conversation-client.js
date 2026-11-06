const REQUEST_TIMEOUT_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 45_000;
const SOCKET_TIMEOUT_MS = 10_000;
const INITIALIZE_TIMEOUT_MS = 15_000;
const SERVER_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_SERVER_REQUESTS = 64;
const MAX_SERVER_REQUEST_IDS = 1024;

const serverRequestFallback = method =>
  method === 'item/commandExecution/requestApproval'
    ? { decision: 'decline' }
    : method === 'item/tool/requestUserInput'
      ? { answers: {} }
      : null;

function serverRequestResult(request, result) {
  const fallback = serverRequestFallback(request.method);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fallback;
  if (request.method === 'item/commandExecution/requestApproval') {
    const available = request.params?.availableDecisions;
    return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(result.decision) &&
      (result.decision !== 'acceptForSession' || Array.isArray(available)) &&
      (available == null || (Array.isArray(available) && available.includes(result.decision)))
      ? { decision: result.decision }
      : fallback;
  }
  if (!result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers))
    return fallback;
  const questions = request.params?.questions;
  const entries = Object.entries(result.answers);
  if (!Array.isArray(questions) || entries.length > 16) return fallback;
  const ids = new Set(questions.map(question => question?.id));
  let characters = 0;
  const answers = Object.create(null);
  for (const [id, answer] of entries) {
    if (!ids.has(id) || !Array.isArray(answer?.answers) || answer.answers.length > 16 ||
        answer.answers.some(value => typeof value !== 'string' || value.length > 8192)) return fallback;
    characters += answer.answers.reduce((total, value) => total + value.length, 0);
    if (characters > 65536) return fallback;
    answers[id] = { answers: [...answer.answers] };
  }
  return { answers };
}

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
  constructor(onNotification, options = {}) {
    this.onNotification = onNotification;
    this.options = options;
    this.socket = null;
    this.connectPromise = null;
    this.disposed = false;
    this.nextRequestId = 0;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.serverRequestIds = new Set();
    this.initializedSocket = null;
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
      const discover =
        this.options.discover ??
        (async () => {
          const chromeWindow = await chrome.windows.getCurrent();
          ensureCurrent();
          return chrome.runtime.sendMessage({
            type: 'justdo:app-server:ensure',
            clientId:
              typeof chromeWindow.id === 'number'
                ? `sidepanel-window-${chromeWindow.id}`
                : undefined,
          });
        });
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
            if (this.socket === socket) this.handleMessage(event.data, socket);
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
          clientInfo: this.options.clientInfo ?? {
            name: 'chrome-extension-sidepanel',
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
      this.initializedSocket = socket;
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

  handleMessage(raw, socket = this.socket) {
    if (socket !== this.socket || this.disposed) return;
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id !== undefined && typeof message.method === 'string') {
      this.handleServerRequest(message, socket);
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          Object.assign(
            connectionError(
              message.error.message ?? 'App-server failed.',
              message.error.data?.code ?? 'REQUEST_REJECTED',
              'request',
              message.error.data?.requestSent !== false,
            ),
            { messageKey: message.error.data?.messageKey },
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      const id = message.params?.requestId;
      const key = `${typeof id}:${id}`;
      const pending = this.serverRequests.get(key);
      if (pending && pending.request.params?.threadId === message.params?.threadId)
        this.finishServerRequest(pending, undefined, false);
    }
    if (typeof message.method === 'string') this.onNotification?.(message.method, message.params);
  }

  handleServerRequest(request, socket) {
    const id = request.id;
    if (!((typeof id === 'string' && id.length > 0 && id.length <= 256) ||
          (typeof id === 'number' && Number.isSafeInteger(id)))) return;
    const key = `${typeof id}:${id}`;
    if (this.serverRequestIds.has(key)) return;
    // Never evict an ID and accidentally re-admit a replay on the same socket.
    if (this.serverRequestIds.size >= MAX_SERVER_REQUEST_IDS || this.serverRequests.size >= MAX_SERVER_REQUESTS) {
      closeSocket(socket);
      this.handleClose(socket);
      return;
    }
    this.serverRequestIds.add(key);
    const fallback = serverRequestFallback(request.method);
    const controller = new AbortController();
    const pending = { key, request, socket, controller, timeout: null };
    this.serverRequests.set(key, pending);
    if (!fallback) {
      this.finishServerRequest(pending, null);
      return;
    }
    if (this.initializedSocket !== socket || typeof this.options.requestHandler !== 'function') {
      this.finishServerRequest(pending, fallback);
      return;
    }
    const offered = this.options.serverRequestTimeoutMs;
    const timeoutMs = Number.isFinite(offered) && offered > 0
      ? Math.min(offered, SERVER_REQUEST_TIMEOUT_MS) : SERVER_REQUEST_TIMEOUT_MS;
    pending.timeout = setTimeout(() => this.finishServerRequest(pending, fallback), timeoutMs);
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return fallback;
      return this.options.requestHandler(request, { signal: controller.signal });
    }).then(result => this.finishServerRequest(pending, serverRequestResult(request, result)),
      () => this.finishServerRequest(pending, fallback));
  }

  finishServerRequest(pending, result, respond = true) {
    if (this.serverRequests.get(pending.key) !== pending) return;
    this.serverRequests.delete(pending.key);
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.controller.abort();
    const socket = pending.socket;
    if (!respond || this.disposed || this.socket !== socket || socket.readyState !== WebSocket.OPEN)
      return;
    const response = result
      ? { id: pending.request.id, result }
      : { id: pending.request.id, error: { code: -32601, message: 'This browser client does not implement this server request.' } };
    try {
      socket.send(JSON.stringify(response));
    } catch {
      closeSocket(socket);
      this.handleClose(socket);
    }
  }

  handleClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.initializedSocket = null;
    for (const pending of this.serverRequests.values())
      this.finishServerRequest(pending, undefined, false);
    this.serverRequestIds.clear();
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

const NATIVE_HOST = 'com.justdo.browserextension';
const REQUEST_TIMEOUT_MS = 20_000;
export const APP_NOT_RUNNING_CODE = 'APP_NOT_RUNNING';
let nativePort = null;
let nextRequestId = 0;
const pending = new Map();

function nativeError(message, code = 'NATIVE_HOST_UNAVAILABLE') {
  return Object.assign(new Error(message), { code });
}

function rejectPending(error, port) {
  for (const [id, request] of pending) {
    if (request.port !== port) continue;
    clearTimeout(request.timeout);
    request.reject(error);
    pending.delete(id);
  }
}

function retireNativePort(port, error) {
  if (nativePort === port) nativePort = null;
  rejectPending(error, port);
  try {
    port.disconnect();
  } catch {
    // A failed native pipe may already have disconnected.
  }
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener(message => {
    const request = pending.get(String(message?.id));
    if (!request) return;
    pending.delete(String(message.id));
    clearTimeout(request.timeout);
    if (message.error) {
      const error = nativeError(message.error.message ?? 'Native host failed.');
      if (message.error.data?.code === APP_NOT_RUNNING_CODE) error.code = APP_NOT_RUNNING_CODE;
      request.reject(error);
    } else request.resolve(message.result);
  });
  port.onDisconnect.addListener(() => {
    if (nativePort === port) nativePort = null;
    const message = chrome.runtime.lastError?.message ?? 'Native host disconnected.';
    rejectPending(nativeError(message), port);
  });
  return port;
}

function requestNativeHost(method, params = {}) {
  const id = `justdo-native:${++nextRequestId}`;
  let port;
  try {
    port = connectNativeHost();
  } catch (error) {
    return Promise.reject(
      nativeError(error instanceof Error ? error.message : 'Native host failed.'),
    );
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      const error = nativeError(`Native host request ${method} timed out.`, 'NATIVE_HOST_TIMEOUT');
      reject(error);
      retireNativePort(port, error);
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { reject, resolve, timeout, port });
    try {
      port.postMessage({ jsonrpc: '2.0', id, method, params });
    } catch {
      pending.delete(id);
      clearTimeout(timeout);
      const error = nativeError('Unable to contact the native host.');
      reject(error);
      retireNativePort(port, error);
    }
  });
}

function validateAppServer(value) {
  if (!value || typeof value.localAppServerUrl !== 'string') return null;
  try {
    const url = new URL(value.localAppServerUrl);
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/app-server' ||
      !url.port ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].join(',') !== 'token' ||
      !/^[0-9a-f]{64}$/u.test(url.searchParams.get('token') ?? '') ||
      value.runtimeConfig?.protocolVersion !== 2
    ) {
      return null;
    }
    return { localAppServerUrl: url.toString(), runtimeConfig: value.runtimeConfig ?? {} };
  } catch {
    return null;
  }
}

export async function ensureAppServer(clientId) {
  const constraints = {
    manifestSchemaVersion: 2,
    nativeHostName: NATIVE_HOST,
    requiredAppServerProtocolVersion: 2,
    requiredNativeHostProtocolVersion: 2,
  };
  const hello = await requestNativeHost('codexRuntime/hello', { constraints });
  if (
    hello?.manifestSchemaVersion !== 2 ||
    hello?.nativeHostProtocolVersion !== 2 ||
    !Array.isArray(hello?.supportedProtocolVersions) ||
    !hello?.supportedProtocolVersions?.includes(2)
  ) {
    throw nativeError(
      'The extension and desktop app versions are incompatible.',
      'INCOMPATIBLE_VERSION',
    );
  }
  const result = await requestNativeHost('codexRuntime/ensure', {
    constraints,
    ...(typeof clientId === 'string' && clientId ? { clientId } : {}),
  });
  const validated = validateAppServer(result);
  if (!validated)
    throw nativeError('The desktop app returned an invalid app-server URL.', 'INVALID_APP_SERVER');
  return validated;
}

export function handleAppServerMessage(message, reply) {
  if (message?.type !== 'justdo:app-server:ensure') return false;
  void ensureAppServer(message.clientId)
    .then(result => reply({ ok: true, ...result }))
    .catch(error =>
      reply({
        ok: false,
        code: error?.code ?? 'NATIVE_HOST_UNAVAILABLE',
        error: error instanceof Error ? error.message : 'Native host failed.',
      }),
    );
  return true;
}

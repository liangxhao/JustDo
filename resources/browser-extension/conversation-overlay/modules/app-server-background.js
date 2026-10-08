const NATIVE_HOST = 'com.justdo.browserextension';
const REQUEST_TIMEOUT_MS = 20_000;
let nativePort = null;
let nextRequestId = 0;
const pending = new Map();

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
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
    if (message.error) request.reject(new Error(message.error.message ?? 'Native host failed.'));
    else request.resolve(message.result);
  });
  port.onDisconnect.addListener(() => {
    if (nativePort === port) nativePort = null;
    const message = chrome.runtime.lastError?.message ?? 'Native host disconnected.';
    rejectPending(new Error(message));
  });
  return port;
}

function requestNativeHost(method, params = {}) {
  const id = `justdo-native:${++nextRequestId}`;
  const port = connectNativeHost();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native host request ${method} timed out.`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { reject, resolve, timeout });
    port.postMessage({ jsonrpc: '2.0', id, method, params });
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
      !/^[0-9a-f]{64}$/u.test(url.searchParams.get('token') ?? '')
    ) {
      return null;
    }
    return { localAppServerUrl: url.toString(), runtimeConfig: value.runtimeConfig ?? {} };
  } catch {
    return null;
  }
}

export async function ensureAppServer(restart, clientId) {
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
    !hello?.supportedProtocolVersions?.includes(2)
  ) {
    throw new Error('The extension and JustDo versions are incompatible.');
  }
  const result = await requestNativeHost(restart ? 'codexRuntime/restart' : 'codexRuntime/ensure', {
    constraints,
    ...(typeof clientId === 'string' && clientId ? { clientId } : {}),
    ...(restart ? { reason: 'sidepanel_retry' } : {}),
  });
  const validated = validateAppServer(result);
  if (!validated) throw new Error('JustDo returned an invalid app-server URL.');
  return validated;
}

export function handleAppServerMessage(message, reply) {
  if (message?.type !== 'justdo:app-server:ensure') return false;
  void ensureAppServer(message.restart === true, message.clientId)
    .then(result => reply({ ok: true, ...result }))
    .catch(error =>
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
}

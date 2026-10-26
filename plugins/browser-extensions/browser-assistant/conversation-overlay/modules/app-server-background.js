const NATIVE_HOST = 'com.justdo.browserextension';
const REQUEST_TIMEOUT_MS = 20_000;
export const APP_NOT_RUNNING_CODE = 'APP_NOT_RUNNING';

function nativeError(message, code = 'NATIVE_HOST_UNAVAILABLE') {
  return Object.assign(new Error(message), { code });
}

function connectNativeHost() {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    throw nativeError(error instanceof Error ? error.message : 'Native host could not be started.');
  }
  const pending = new Map();
  let nextRequestId = 0;
  let closedError = null;
  const close = (error = nativeError('Native host connection closed.')) => {
    if (closedError) return;
    closedError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    try {
      port.disconnect();
    } catch {
      // A failed native pipe may already have disconnected.
    }
  };
  port.onMessage.addListener(message => {
    if (closedError) return;
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
    const message = chrome.runtime.lastError?.message ?? 'Native host disconnected.';
    close(nativeError(message));
  });
  return {
    close,
    request(method, params = {}) {
      if (closedError) return Promise.reject(closedError);
      const id = `justdo-native:${++nextRequestId}`;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          close(nativeError(`Native host request ${method} timed out.`, 'NATIVE_HOST_TIMEOUT'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { reject, resolve, timeout });
        try {
          port.postMessage({ jsonrpc: '2.0', id, method, params });
        } catch {
          close(nativeError('Unable to contact the native host.'));
        }
      });
    },
  };
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
  const connection = connectNativeHost();
  try {
    const constraints = {
      manifestSchemaVersion: 2,
      nativeHostName: NATIVE_HOST,
      requiredAppServerProtocolVersion: 2,
      requiredNativeHostProtocolVersion: 2,
    };
    const hello = await connection.request('codexRuntime/hello', { constraints });
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
    const result = await connection.request('codexRuntime/ensure', {
      constraints,
      ...(typeof clientId === 'string' && clientId ? { clientId } : {}),
    });
    const validated = validateAppServer(result);
    if (!validated)
      throw nativeError(
        'The desktop app returned an invalid app-server URL.',
        'INVALID_APP_SERVER',
      );
    return validated;
  } finally {
    connection.close();
  }
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppServerClient } from '../conversation-overlay/modules/conversation-client.js';

const localAppServerUrl = `ws://127.0.0.1:41234/app-server?token=${'a'.repeat(64)}`;
const unavailableMessage =
  'The desktop app is not running. Start it manually, then reconnect the extension.';

class FixtureSocket {
  static OPEN = 1;
  static behavior = 'open';
  static instances: FixtureSocket[] = [];
  static failSend = false;
  readyState = 0;
  sent: Array<{ id?: string; method: string }> = [];
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(_url: string) {
    FixtureSocket.instances.push(this);
    queueMicrotask(() => {
      if (FixtureSocket.behavior === 'stall') return;
      if (FixtureSocket.behavior === 'close') {
        this.close();
        return;
      }
      this.readyState = FixtureSocket.OPEN;
      this.emit('open');
    });
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(raw: string) {
    const request = JSON.parse(raw);
    if (FixtureSocket.failSend && request.method === 'turn/start') throw new Error('Closed');
    this.sent.push(request);
    if (request.method === 'initialize' && FixtureSocket.behavior !== 'no-initialize') {
      queueMicrotask(() => this.emit('message', { id: request.id, result: {} }));
    }
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  emit(type: string, response?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(response === undefined ? {} : { data: JSON.stringify(response) });
    }
  }
}

describe('browser extension discovers existing app instances', () => {
  let available: boolean;
  let discoveryResult: Record<string, unknown>;
  let requests: Array<{ id: string; method: string; params: Record<string, unknown> }>;
  let ports: Array<{
    disconnect: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    respond: (message: unknown) => void;
    close: () => void;
  }>;
  let client: AppServerClient | undefined;
  const connectNative = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    available = true;
    discoveryResult = { localAppServerUrl, runtimeConfig: { protocolVersion: 2 } };
    FixtureSocket.behavior = 'open';
    FixtureSocket.failSend = false;
    FixtureSocket.instances = [];
    requests = [];
    ports = [];
    connectNative.mockReset().mockImplementation(() => {
      let onNativeMessage: (message: unknown) => void;
      let onNativeDisconnect: () => void;
      const port = {
        onMessage: {
          addListener: (listener: typeof onNativeMessage) => {
            onNativeMessage = listener;
          },
        },
        onDisconnect: {
          addListener: (listener: typeof onNativeDisconnect) => {
            onNativeDisconnect = listener;
          },
        },
        disconnect: vi.fn(() => onNativeDisconnect()),
        postMessage: vi.fn((request: (typeof requests)[number]) => {
          requests.push(request);
          const response =
            request.method === 'codexRuntime/hello'
              ? {
                  result: {
                    manifestSchemaVersion: 2,
                    nativeHostProtocolVersion: 2,
                    supportedProtocolVersions: [2],
                  },
                }
              : available
                ? { result: discoveryResult }
                : { error: { message: unavailableMessage, data: { code: 'APP_NOT_RUNNING' } } };
          onNativeMessage({ id: request.id, ...response });
        }),
      };
      ports.push({
        disconnect: port.disconnect,
        postMessage: port.postMessage,
        respond: message => onNativeMessage(message),
        close: () => onNativeDisconnect(),
      });
      return port;
    });
    sendMessage.mockReset();
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative,
        sendMessage,
        getManifest: () => ({ version: '2.3.0' }),
      },
      windows: { getCurrent: async () => ({ id: 42 }) },
    });
    vi.stubGlobal('WebSocket', FixtureSocket);
  });

  afterEach(() => {
    client?.disconnect();
    client = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('only requests discovery even if an older panel asks for a restart', async () => {
    const { handleAppServerMessage } =
      await import('../conversation-overlay/modules/app-server-background.js');

    const response = await new Promise(resolve => {
      handleAppServerMessage(
        { type: 'justdo:app-server:ensure', restart: true, clientId: 'panel' },
        resolve,
      );
    });

    expect(response).toMatchObject({ ok: true, localAppServerUrl });
    expect(requests.map(request => request.method)).toEqual([
      'codexRuntime/hello',
      'codexRuntime/ensure',
    ]);
    expect(requests[1].params).not.toHaveProperty('reason');
    expect(connectNative).toHaveBeenCalledOnce();
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a missing instance and discovers it after the user starts the app', async () => {
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');
    available = false;

    await expect(ensureAppServer('panel')).rejects.toMatchObject({
      message: unavailableMessage,
      code: 'APP_NOT_RUNNING',
    });
    available = true;
    await expect(ensureAppServer('panel')).resolves.toMatchObject({ localAppServerUrl });

    expect(requests.map(request => request.method)).toEqual([
      'codexRuntime/hello',
      'codexRuntime/ensure',
      'codexRuntime/hello',
      'codexRuntime/ensure',
    ]);
    expect(connectNative).toHaveBeenCalledTimes(2);
    for (const port of ports) expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('starts a fresh discovery after success and reads the current connection details', async () => {
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');
    await expect(ensureAppServer('panel')).resolves.toMatchObject({ localAppServerUrl });
    const updatedUrl = localAppServerUrl
      .replace('41234', '41235')
      .replace(/a{64}/u, 'b'.repeat(64));
    discoveryResult = { ...discoveryResult, localAppServerUrl: updatedUrl };

    await expect(ensureAppServer('panel')).resolves.toMatchObject({
      localAppServerUrl: updatedUrl,
    });

    expect(connectNative).toHaveBeenCalledTimes(2);
    for (const port of ports) expect(port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases concurrent discoveries independently and keeps each handshake on its own pipe', async () => {
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');
    const panel = ensureAppServer('panel');
    const pairing = ensureAppServer('browser-bootstrap');
    for (const port of ports) port.postMessage.mockImplementation(() => {});
    await Promise.resolve();

    expect(connectNative).toHaveBeenCalledTimes(2);
    for (const [index, clientId] of ['panel', 'browser-bootstrap'].entries()) {
      expect(ports[index].postMessage.mock.calls.map(([request]) => request.method)).toEqual([
        'codexRuntime/hello',
        'codexRuntime/ensure',
      ]);
      expect(ports[index].postMessage.mock.calls[1][0].params.clientId).toBe(clientId);
    }
    const panelRequest = ports[0].postMessage.mock.calls[1][0];
    ports[0].respond({ id: panelRequest.id, result: discoveryResult });
    await expect(panel).resolves.toMatchObject({ localAppServerUrl });
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    expect(ports[1].disconnect).not.toHaveBeenCalled();

    ports[0].respond({ id: panelRequest.id, error: { message: 'Late error' } });
    ports[0].close();
    const pairingRequest = ports[1].postMessage.mock.calls[1][0];
    ports[1].respond({ id: pairingRequest.id, result: discoveryResult });
    await expect(pairing).resolves.toMatchObject({ localAppServerUrl });
    expect(ports[1].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a host disconnect after hello without sending ensure on another pipe', async () => {
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');
    const result = ensureAppServer('panel');
    ports[0].close();

    await expect(result).rejects.toMatchObject({ code: 'NATIVE_HOST_UNAVAILABLE' });
    expect(connectNative).toHaveBeenCalledOnce();
    expect(requests.map(request => request.method)).toEqual(['codexRuntime/hello']);
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases an incompatible host before requesting discovery', async () => {
    let respond!: (message: unknown) => void;
    const disconnect = vi.fn();
    connectNative.mockImplementationOnce(() => ({
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          respond = listener;
        },
      },
      onDisconnect: { addListener: vi.fn() },
      disconnect,
      postMessage: (request: { id: string }) => respond({ id: request.id, result: {} }),
    }));
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');

    await expect(ensureAppServer('panel')).rejects.toMatchObject({ code: 'INCOMPATIBLE_VERSION' });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a native launch failure without retaining a request or timer', async () => {
    connectNative.mockImplementationOnce(() => {
      throw new Error('Native host is unavailable');
    });
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');

    await expect(ensureAppServer('panel')).rejects.toMatchObject({
      code: 'NATIVE_HOST_UNAVAILABLE',
      message: 'Native host is unavailable',
    });

    expect(ports).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates a timed-out discovery from another in-flight discovery', async () => {
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');
    const stalled = ensureAppServer('panel').catch((error: Error) => error);
    ports[0].postMessage.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    const pairing = ensureAppServer('browser-bootstrap');
    ports[1].postMessage.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await stalled).toMatchObject({ code: 'NATIVE_HOST_TIMEOUT' });
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    expect(ports[1].disconnect).not.toHaveBeenCalled();
    const request = ports[1].postMessage.mock.calls[1][0];
    ports[1].respond({ id: request.id, result: discoveryResult });
    await expect(pairing).resolves.toMatchObject({ localAppServerUrl });
    expect(ports[1].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps reconnecting after repeated failures without requesting a restart', async () => {
    const onNotification = vi.fn();
    sendMessage.mockResolvedValue({ ok: false, error: unavailableMessage });
    client = new AppServerClient(onNotification);

    await expect(client.connect()).rejects.toThrow(unavailableMessage);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendMessage).toHaveBeenCalledTimes(5);

    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onNotification).toHaveBeenCalledWith('connection/reconnected', {});
    for (const [request] of sendMessage.mock.calls) {
      expect(request).toMatchObject({
        type: 'justdo:app-server:ensure',
        clientId: 'sidepanel-window-42',
      });
      expect(request).not.toHaveProperty('restart');
    }
  });

  it('rejects a close before open and rediscovers instead of leaving connection pending', async () => {
    FixtureSocket.behavior = 'close';
    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    client = new AppServerClient(vi.fn());

    await expect(client.request('turn/start', { message: 'Hello' })).rejects.toMatchObject({
      code: 'SOCKET_CLOSED',
      requestSent: false,
    });
    FixtureSocket.behavior = 'open';
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(FixtureSocket.instances[1].sent.map(request => request.method)).toEqual([
      'initialize',
      'initialized',
    ]);
  });

  it('bounds a stalled WebSocket handshake and retries discovery', async () => {
    FixtureSocket.behavior = 'stall';
    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    client = new AppServerClient(vi.fn());
    const result = client.request('turn/start', {}).catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: 'SOCKET_TIMEOUT', requestSent: false });
    FixtureSocket.behavior = 'open';
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('bounds discovery and ignores its late result', async () => {
    let finishDiscovery!: (value: unknown) => void;
    sendMessage.mockReturnValue(
      new Promise(resolve => {
        finishDiscovery = resolve;
      }),
    );
    client = new AppServerClient(vi.fn());
    const result = client.connect().catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(await result).toMatchObject({ code: 'DISCOVERY_TIMEOUT', requestSent: false });
    finishDiscovery({ ok: true, localAppServerUrl });
    await Promise.resolve();
    await Promise.resolve();

    expect(FixtureSocket.instances).toHaveLength(0);
  });

  it('cancels discovery when the panel closes without creating a late connection', async () => {
    let finishDiscovery!: (value: unknown) => void;
    sendMessage.mockReturnValue(
      new Promise(resolve => {
        finishDiscovery = resolve;
      }),
    );
    client = new AppServerClient(vi.fn());
    const result = client.connect().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);

    client.disconnect();
    expect(await result).toMatchObject({ code: 'CLIENT_CLOSED', requestSent: false });
    finishDiscovery({ ok: true, localAppServerUrl });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FixtureSocket.instances).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('bounds initialization and clears the old socket before reconnecting', async () => {
    FixtureSocket.behavior = 'no-initialize';
    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    client = new AppServerClient(vi.fn());
    const result = client.connect().catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ code: 'INITIALIZE_TIMEOUT', requestSent: false });
    expect(FixtureSocket.instances[0].readyState).toBe(3);
    FixtureSocket.behavior = 'open';
    await vi.advanceTimersByTimeAsync(1_000);

    expect(FixtureSocket.instances).toHaveLength(2);
  });

  it('preserves uncertain delivery after a sent request disconnects and never replays it', async () => {
    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    client = new AppServerClient(vi.fn());
    await client.connect();
    const socket = FixtureSocket.instances[0];
    const result = client
      .request('turn/start', { clientTurnId: 'input-1', message: 'Hello' })
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);

    socket.close();
    expect(await result).toMatchObject({ requestSent: true });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(
      FixtureSocket.instances
        .flatMap(value => value.sent)
        .filter(request => request.method === 'turn/start'),
    ).toHaveLength(1);
  });

  it('marks a synchronous send failure as unsent and clears its pending request', async () => {
    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    client = new AppServerClient(vi.fn());
    await client.connect();
    FixtureSocket.failSend = true;

    await expect(client.request('turn/start', {})).rejects.toMatchObject({ requestSent: false });

    expect(FixtureSocket.instances[0].sent.some(request => request.method === 'turn/start')).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores notifications and repeated close events from a retired socket', async () => {
    const onNotification = vi.fn();
    sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
    client = new AppServerClient(onNotification);
    await client.connect();
    const retired = FixtureSocket.instances[0];
    retired.close();
    await vi.advanceTimersByTimeAsync(1_000);
    onNotification.mockClear();

    retired.emit('message', { method: 'turn/completed', params: { threadId: 'older' } });
    retired.close();

    expect(onNotification).not.toHaveBeenCalled();
    expect(FixtureSocket.instances[1].readyState).toBe(FixtureSocket.OPEN);
  });

  it.each([false, true, undefined])(
    'preserves explicit RPC delivery evidence %s',
    async requestSent => {
      sendMessage.mockResolvedValue({ ok: true, localAppServerUrl });
      client = new AppServerClient(vi.fn());
      await client.connect();
      const socket = FixtureSocket.instances[0];
      const result = client.request('turn/start', {}).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(0);
      const request = socket.sent.find(value => value.method === 'turn/start')!;

      socket.emit('message', {
        id: request.id,
        error: { message: 'Unavailable', data: { requestSent } },
      });

      expect(await result).toMatchObject({ requestSent: requestSent !== false });
    },
  );

  it('forwards a structured missing-app discovery code without exposing the URL', async () => {
    const { handleAppServerMessage } =
      await import('../conversation-overlay/modules/app-server-background.js');
    available = false;

    const response = await new Promise(resolve => {
      handleAppServerMessage({ type: 'justdo:app-server:ensure' }, resolve);
    });

    expect(response).toEqual({ ok: false, code: 'APP_NOT_RUNNING', error: unavailableMessage });
  });

  it.each([
    { localAppServerUrl: localAppServerUrl.replace('127.0.0.1', 'example.com') },
    { localAppServerUrl: localAppServerUrl.replace('127.0.0.1', 'user:password@127.0.0.1') },
    { localAppServerUrl: `${localAppServerUrl}&token=${'b'.repeat(64)}` },
    { localAppServerUrl: `${localAppServerUrl}#fragment` },
    { runtimeConfig: { protocolVersion: 1 } },
  ])('rejects malformed discovery without returning its capability', async override => {
    const { handleAppServerMessage } =
      await import('../conversation-overlay/modules/app-server-background.js');
    discoveryResult = { ...discoveryResult, ...override };

    const response = await new Promise(resolve => {
      handleAppServerMessage({ type: 'justdo:app-server:ensure' }, resolve);
    });

    expect(response).toMatchObject({ ok: false, code: 'INVALID_APP_SERVER' });
    expect(response).not.toHaveProperty('localAppServerUrl');
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an unavailable native port immediately and clears its timeout', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: () => ({
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
          postMessage: () => {
            throw new Error('Port disconnected');
          },
        }),
      },
    });
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');

    await expect(ensureAppServer('panel')).rejects.toMatchObject({
      code: 'NATIVE_HOST_UNAVAILABLE',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires a stalled native pipe and ignores its late disconnect after recovery', async () => {
    const ports: Array<{ disconnect: ReturnType<typeof vi.fn>; close: () => void }> = [];
    const connectNative = vi.fn(() => {
      const stalled = ports.length === 0;
      let respond!: (value: unknown) => void;
      let close!: () => void;
      const port = {
        onMessage: {
          addListener: (listener: typeof respond) => {
            respond = listener;
          },
        },
        onDisconnect: {
          addListener: (listener: typeof close) => {
            close = listener;
          },
        },
        disconnect: vi.fn(),
        postMessage: (request: { id: string; method: string }) => {
          if (stalled) return;
          respond({
            id: request.id,
            result:
              request.method === 'codexRuntime/hello'
                ? {
                    manifestSchemaVersion: 2,
                    nativeHostProtocolVersion: 2,
                    supportedProtocolVersions: [2],
                  }
                : discoveryResult,
          });
        },
      };
      ports.push({ disconnect: port.disconnect, close: () => close() });
      return port;
    });
    vi.stubGlobal('chrome', { runtime: { connectNative } });
    const { ensureAppServer } =
      await import('../conversation-overlay/modules/app-server-background.js');
    const failed = ensureAppServer('panel').catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(await failed).toMatchObject({ code: 'NATIVE_HOST_TIMEOUT' });
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    await expect(ensureAppServer('panel')).resolves.toMatchObject({ localAppServerUrl });
    ports[0].close();
    await expect(ensureAppServer('panel')).resolves.toMatchObject({ localAppServerUrl });

    expect(connectNative).toHaveBeenCalledTimes(3);
    for (const port of ports) expect(port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

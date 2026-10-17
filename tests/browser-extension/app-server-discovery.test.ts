import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppServerClient } from '../../resources/browser-extension/conversation-overlay/modules/conversation-client.js';

const localAppServerUrl = `ws://127.0.0.1:41234/app-server?token=${'a'.repeat(64)}`;
const unavailableMessage =
  'The desktop app is not running. Start it manually, then reconnect the extension.';

class FixtureSocket {
  static OPEN = 1;
  readyState = 0;
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = FixtureSocket.OPEN;
      this.emit('open');
    });
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(raw: string) {
    const request = JSON.parse(raw);
    if (request.method === 'initialize') {
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
  let requests: Array<{ id: string; method: string; params: Record<string, unknown> }>;
  let client: AppServerClient | undefined;
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    available = true;
    requests = [];
    let onNativeMessage: (message: unknown) => void;
    const port = {
      onMessage: {
        addListener: (listener: typeof onNativeMessage) => {
          onNativeMessage = listener;
        },
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage: (request: (typeof requests)[number]) => {
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
              ? { result: { localAppServerUrl, runtimeConfig: { protocolVersion: 2 } } }
              : { error: { message: unavailableMessage, data: { code: 'APP_NOT_RUNNING' } } };
        onNativeMessage({ id: request.id, ...response });
      },
    };
    sendMessage.mockReset();
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: () => port,
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
      await import('../../resources/browser-extension/conversation-overlay/modules/app-server-background.js');

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
  });

  it('reports a missing instance and discovers it after the user starts the app', async () => {
    const { ensureAppServer } =
      await import('../../resources/browser-extension/conversation-overlay/modules/app-server-background.js');
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
});

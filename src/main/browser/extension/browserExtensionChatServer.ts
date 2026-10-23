import { timingSafeEqual } from 'node:crypto';

import { AppServerConnection } from '../../appServer/appServerConnection';
import { AppServerWebSocketServer } from '../../appServer/appServerWebSocketServer';
import { BrowserAppServerHub } from './browserAppServerBinding';
import {
  BROWSER_EXTENSION_ID,
  type BrowserExtensionAppServerCapability,
  type BrowserExtensionChatApi,
} from './browserAppServerTypes';

export * from './browserAppServerTypes';

// A permitted 20 MiB image expands to about 27 MiB in its JSON data URL.
const MAX_OUTPUT_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024 * 1024;

const isAuthorizedToken = (supplied: string, expectedToken: string): boolean => {
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
};

/** Chrome authorization and display lifecycle over the shared WebSocket transport. */
export class BrowserExtensionChatServer {
  private readonly hub: BrowserAppServerHub;
  private readonly transport: AppServerWebSocketServer;
  private generation = 0;
  private starting?: { generation: number; promise: Promise<void> };
  private stopping?: Promise<void>;

  constructor(
    api: BrowserExtensionChatApi,
    private readonly token: string,
    appVersion: string,
    port = 0,
    createBrowserPairing?: () => Promise<{ pairingString: string }>,
  ) {
    this.hub = new BrowserAppServerHub(api, appVersion, createBrowserPairing);
    this.transport = new AppServerWebSocketServer({
      port,
      maxOutputFrameBytes: MAX_OUTPUT_FRAME_BYTES,
      maxPendingOutputBytes: MAX_PENDING_OUTPUT_BYTES,
      authorize: (request, url) =>
        request.headers.origin === 'chrome-extension://' + BROWSER_EXTENSION_ID &&
        isAuthorizedToken(url.searchParams.get('token') ?? '', this.token),
      createConnection: send => new AppServerConnection(context => this.hub.connect(context), send),
    });
  }

  getCapability(): BrowserExtensionAppServerCapability {
    return { localAppServerUrl: this.transport.getUrl() + '?token=' + this.token };
  }

  start(): Promise<void> {
    const generation = this.generation;
    if (this.starting?.generation === generation) return this.starting.promise;
    const stopping = this.stopping;
    const promise = (async () => {
      if (stopping) await stopping;
      if (generation !== this.generation)
        throw new Error('Browser app-server startup was cancelled.');
      await this.transport.start();
      if (generation !== this.generation || !this.transport.running)
        throw new Error('Browser app-server startup was cancelled.');
      this.hub.activate();
    })().finally(() => {
      if (this.starting?.promise === promise) this.starting = undefined;
    });
    this.starting = { generation, promise };
    return promise;
  }

  stop(options: { preserveActiveTurns?: boolean } = {}): Promise<void> {
    this.generation += 1;
    const transport = this.transport.stop();
    const hub = this.hub.stop(options);
    if (this.stopping) return this.stopping;
    const starting = this.starting?.promise;
    const promise = Promise.allSettled([transport, hub, ...(starting ? [starting] : [])])
      .then(() => {})
      .finally(() => {
        if (this.stopping === promise) this.stopping = undefined;
      });
    this.stopping = promise;
    return promise;
  }

  async restart(): Promise<void> {
    const generation = this.generation + 1;
    await this.stop({ preserveActiveTurns: true });
    if (generation !== this.generation)
      throw new Error('Browser app-server startup was cancelled.');
    await this.start();
  }
}

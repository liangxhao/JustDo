import { timingSafeEqual } from 'node:crypto';

import { AppServerConnection } from '../clients/appServer/protocol/appServerConnection';
import { AppServerWebSocketServer } from '../clients/appServer/protocol/appServerWebSocketServer';
import { ChromeAppServerHub } from './chromeAppServerBinding';
import {
  CHROME_EXTENSION_ID,
  type ChromeExtensionAppServerCapability,
  type ChromeExtensionChatApi,
} from './chromeAppServerTypes';
import type { ChromeWebLaunchService } from './chromeWebLaunchService';

export * from './chromeAppServerTypes';

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
export class ChromeExtensionChatServer {
  private readonly hub: ChromeAppServerHub;
  private readonly transport: AppServerWebSocketServer;
  private generation = 0;
  private starting?: { generation: number; promise: Promise<void> };
  private stopping?: Promise<void>;

  constructor(
    api: ChromeExtensionChatApi,
    private readonly token: string,
    appVersion: string,
    port = 0,
    createChromePairing?: () => Promise<{ pairingString: string }>,
    webLaunch?: ChromeWebLaunchService,
    home = process.cwd(),
  ) {
    this.hub = new ChromeAppServerHub(api, appVersion, createChromePairing, webLaunch, home);
    this.transport = new AppServerWebSocketServer({
      port,
      maxOutputFrameBytes: MAX_OUTPUT_FRAME_BYTES,
      maxPendingOutputBytes: MAX_PENDING_OUTPUT_BYTES,
      authorize: (request, url) =>
        request.headers.origin === 'chrome-extension://' + CHROME_EXTENSION_ID &&
        isAuthorizedToken(url.searchParams.get('token') ?? '', this.token),
      createConnection: send => new AppServerConnection(context => this.hub.connect(context), send),
    });
  }

  getCapability(): ChromeExtensionAppServerCapability {
    return { localAppServerUrl: this.transport.getUrl() + '?token=' + this.token };
  }

  notifyWebLaunchChanged(): void { this.hub.notifyWebLaunchChanged(); }

  start(): Promise<void> {
    const generation = this.generation;
    if (this.starting?.generation === generation) return this.starting.promise;
    const stopping = this.stopping;
    const promise = (async () => {
      if (stopping) await stopping;
      if (generation !== this.generation)
        throw new Error('Chrome app-server startup was cancelled.');
      await this.transport.start();
      if (generation !== this.generation || !this.transport.running)
        throw new Error('Chrome app-server startup was cancelled.');
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
      throw new Error('Chrome app-server startup was cancelled.');
    await this.start();
  }
}

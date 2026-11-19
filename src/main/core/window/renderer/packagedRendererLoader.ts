import { setTimeout as delay } from 'node:timers/promises';

import type { BrowserWindow, WebContents } from 'electron';

import {
  type ApplicationRendererHost,
  startApplicationRendererHost,
} from './applicationRendererHost';

type PackagedRendererWindow = Pick<BrowserWindow, 'isDestroyed' | 'loadURL' | 'once' | 'removeListener'> & {
  webContents: Pick<WebContents, 'on' | 'removeListener' | 'stop'>;
};
type ApplicationQuitSource = {
  once: (event: 'before-quit', listener: () => void) => unknown;
  removeListener: (event: 'before-quit', listener: () => void) => unknown;
};

const RETRY_DELAYS_MS = [250, 750, 1500];
const NAVIGATION_TIMEOUT_MS = 30_000;
const RETRYABLE_NAVIGATION_ERRORS = new Set([
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
  'ERR_FAILED',
  'ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT',
]);
const initialNavigations = new WeakSet<PackagedRendererWindow['webContents']>();

export const isLoadingPackagedRenderer = (contents: WebContents): boolean =>
  initialNavigations.has(contents);

async function navigateToRenderer(
  window: PackagedRendererWindow,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  const contents = window.webContents;
  let status: number | undefined;
  const onNavigate = (_event: Electron.Event, currentUrl: string, httpResponseCode: number) => {
    status = currentUrl === url ? httpResponseCode : undefined;
  };
  contents.on('did-navigate', onNavigate);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  try {
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        reject(new Error('The local application page took too long to load.'));
        if (!window.isDestroyed()) contents.stop();
      }, NAVIGATION_TIMEOUT_MS);
    });
    await Promise.race([window.loadURL(url), interrupted]);
    // Electron also resolves loadURL for some HTTP error documents.
    if (status !== 200) {
      throw new Error(`Local application page returned ${status ?? 'no HTTP status'} at ${url}.`);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (!window.isDestroyed()) contents.removeListener('did-navigate', onNavigate);
  }
}

export const loadPackagedRenderer = async (
  window: PackagedRendererWindow,
  application: ApplicationQuitSource,
  directory: string,
  onApplicationUrl: (url: string | undefined) => void,
): Promise<boolean> => {
  if (window.isDestroyed()) return false;
  const contents = window.webContents;
  const abort = new AbortController();
  let host: ApplicationRendererHost | undefined;
  let closing: Promise<void> | undefined;
  const closeHost = (): Promise<void> | undefined => {
    if (host) closing ??= host.close();
    return closing;
  };
  const stop = (): void => {
    abort.abort();
    onApplicationUrl(undefined);
    window.removeListener('closed', stop);
    application.removeListener('before-quit', stop);
    void closeHost();
  };
  window.once('closed', stop);
  application.once('before-quit', stop);
  initialNavigations.add(contents);
  try {
    host = await startApplicationRendererHost(directory);
    if (window.isDestroyed() && !abort.signal.aborted) stop();
    if (abort.signal.aborted) {
      await closeHost();
      return false;
    }
    onApplicationUrl(host.url);
    for (let attempt = 0; !abort.signal.aborted; attempt += 1) {
      try {
        await navigateToRenderer(window, host.url, abort.signal);
        return !abort.signal.aborted;
      } catch (error) {
        const waitMs = RETRY_DELAYS_MS[attempt];
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (abort.signal.aborted || waitMs === undefined || !code || !RETRYABLE_NAVIGATION_ERRORS.has(code)) {
          throw error;
        }
        console.warn(`[PackagedRenderer] Retrying local navigation after ${code} (retry ${attempt + 1}).`);
        await delay(waitMs, undefined, { signal: abort.signal });
      }
    }
    return false;
  } catch (error) {
    const cancelled = abort.signal.aborted;
    if (!cancelled) stop();
    await closeHost();
    if (cancelled) return false;
    throw error;
  } finally {
    initialNavigations.delete(contents);
  }
};

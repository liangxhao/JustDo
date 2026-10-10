import {
  type ApplicationRendererHost,
  startApplicationRendererHost,
} from './applicationRendererHost';

type PackagedRendererWindow = {
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  once: (event: 'closed', listener: () => void) => unknown;
  removeListener: (event: 'closed', listener: () => void) => unknown;
};
type ApplicationQuitSource = {
  once: (event: 'before-quit', listener: () => void) => unknown;
  removeListener: (event: 'before-quit', listener: () => void) => unknown;
};

export const loadPackagedRenderer = async (
  window: PackagedRendererWindow,
  application: ApplicationQuitSource,
  directory: string,
  onApplicationUrl: (url: string | undefined) => void,
  beforeLoad?: () => Promise<void>,
): Promise<void> => {
  let stopped = false;
  let host: ApplicationRendererHost | undefined;
  let closing: Promise<void> | undefined;
  const closeHost = (): Promise<void> | undefined => {
    if (host) closing ??= host.close();
    return closing;
  };
  const stop = (): void => {
    stopped = true;
    onApplicationUrl(undefined);
    window.removeListener('closed', stop);
    application.removeListener('before-quit', stop);
    void closeHost();
  };
  window.once('closed', stop);
  application.once('before-quit', stop);
  try {
    if (beforeLoad) await beforeLoad();
    if (stopped || window.isDestroyed()) {
      stop();
      return;
    }
    host = await startApplicationRendererHost(directory);
    if (stopped || window.isDestroyed()) {
      stop();
      await closeHost();
      return;
    }
    onApplicationUrl(host.url);
    await window.loadURL(host.url);
  } catch (error) {
    stop();
    await closeHost();
    throw error;
  }
};

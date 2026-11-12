import { ipcRenderer } from 'electron';

/** Share one IPC listener in the preload while the channel has subscribers. */
export function createIpcSubscription<Payload, Event>(
  channel: string,
  decode: (payload: Payload) => Event | null,
  onSubscriberError = (_error: unknown) => console.error(`[Preload] ${channel} listener failed`),
) {
  const subscribers = new Set<(event: Event) => void>();
  const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: Payload) => {
    const event = decode(payload);
    if (event === null) return;

    for (const subscriber of [...subscribers]) {
      if (!subscribers.has(subscriber)) continue;
      try {
        subscriber(event);
      } catch (error) {
        onSubscriberError(error);
      }
    }
  };

  return (callback: (event: Event) => void): (() => void) => {
    // Each registration has its own lifetime, even for the same callback.
    const subscriber = (event: Event) => callback(event);
    subscribers.add(subscriber);
    if (subscribers.size === 1) ipcRenderer.on(channel, handler);
    return () => {
      if (!subscribers.delete(subscriber)) return;
      if (subscribers.size === 0) ipcRenderer.removeListener(channel, handler);
    };
  };
}

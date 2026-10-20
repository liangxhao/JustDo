import { ipcRenderer } from 'electron';

import { type ExtensionChangedEvent, ExtensionIpc } from '../../shared/plugins/extensions';

/** Each window shares one IPC listener, regardless of how many extension cards are mounted. */
export function createExtensionChangedSubscription() {
  const subscribers = new Set<(event: ExtensionChangedEvent) => void>();
  const handler = (_event: Electron.IpcRendererEvent, data: ExtensionChangedEvent) => {
    for (const subscriber of [...subscribers]) {
      if (!subscribers.has(subscriber)) continue;
      try {
        subscriber(data);
      } catch (error) {
        console.error('[ExtensionsPreload] Change listener failed:', error);
      }
    }
  };

  return (callback: (event: ExtensionChangedEvent) => void): (() => void) => {
    // A separate wrapper preserves independent subscriptions of the same callback.
    const subscriber = (data: ExtensionChangedEvent) => callback(data);
    subscribers.add(subscriber);
    if (subscribers.size === 1) ipcRenderer.on(ExtensionIpc.Changed, handler);
    return () => {
      if (!subscribers.delete(subscriber)) return;
      if (!subscribers.size) ipcRenderer.removeListener(ExtensionIpc.Changed, handler);
    };
  };
}

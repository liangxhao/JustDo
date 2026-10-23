import { ipcRenderer } from 'electron';

import {
  PluginOperationIpc,
  type PluginOperationProgress,
} from '../../shared/plugins/pluginOperation';

/** One listener per window, including when several plugin panels subscribe. */
export function createPluginOperationSubscription() {
  const subscribers = new Set<(progress: PluginOperationProgress) => void>();
  const handler = (_event: Electron.IpcRendererEvent, progress: PluginOperationProgress) => {
    for (const subscriber of [...subscribers]) {
      if (!subscribers.has(subscriber)) continue;
      try {
        subscriber(progress);
      } catch {
        // A presentation failure must not prevent other consumers seeing progress.
      }
    }
  };
  return (callback: (progress: PluginOperationProgress) => void): (() => void) => {
    const subscriber = (progress: PluginOperationProgress) => callback(progress);
    subscribers.add(subscriber);
    if (subscribers.size === 1) ipcRenderer.on(PluginOperationIpc.Progress, handler);
    return () => {
      if (!subscribers.delete(subscriber)) return;
      if (!subscribers.size) ipcRenderer.removeListener(PluginOperationIpc.Progress, handler);
    };
  };
}

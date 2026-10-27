import { ipcRenderer } from 'electron';

import {
  type WebpageEmbedApi,
  type WebpageEmbedEvent,
  WebpageEmbedIpc,
} from '../../shared/browser/webpageEmbed';
import { WebpageEmbedSettingsIpc } from '../../shared/browser/webpageEmbedSettings';

export function createWebpageEmbedApi(): WebpageEmbedApi {
  return {
    prepare: input => ipcRenderer.invoke(WebpageEmbedIpc.Prepare, input),
    release: mountId => ipcRenderer.invoke(WebpageEmbedIpc.Release, mountId),
    retryProxy: mountId => ipcRenderer.invoke(WebpageEmbedIpc.RetryProxy, mountId),
    onEvent: listener => {
      let active = true;
      const handler = (_event: Electron.IpcRendererEvent, value: WebpageEmbedEvent) => {
        if (active) listener(value);
      };
      ipcRenderer.on(WebpageEmbedIpc.Event, handler);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(WebpageEmbedIpc.Event, handler);
      };
    },
    getSettings: () => ipcRenderer.invoke(WebpageEmbedSettingsIpc.Get),
    saveSettings: input => ipcRenderer.invoke(WebpageEmbedSettingsIpc.Save, input),
  };
}

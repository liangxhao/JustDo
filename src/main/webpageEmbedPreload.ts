import { contextBridge, ipcRenderer } from 'electron';

import {
  WebpageEmbedIpc,
  type WebpageEmbedProxyState,
  type WebpageEmbedViewerBridge,
} from '../shared/browser/webpageEmbed';

if (process.isMainFrame) {
  const bridge: WebpageEmbedViewerBridge = {
    initialize: () => ipcRenderer.invoke(WebpageEmbedIpc.Ready),
    onProxyState: listener => {
      const receive = (_event: Electron.IpcRendererEvent, value: WebpageEmbedProxyState) =>
        listener(value);
      ipcRenderer.on(WebpageEmbedIpc.ProxyState, receive);
      return () => ipcRenderer.removeListener(WebpageEmbedIpc.ProxyState, receive);
    },
    onNativeFailure: listener => {
      const receive = () => listener();
      ipcRenderer.on(WebpageEmbedIpc.NativeFailure, receive);
      return () => ipcRenderer.removeListener(WebpageEmbedIpc.NativeFailure, receive);
    },
    emit: event => ipcRenderer.sendToHost(WebpageEmbedIpc.Event, event),
  };
  contextBridge.exposeInMainWorld('webpageEmbedViewer', bridge);
}

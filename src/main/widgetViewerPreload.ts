import { contextBridge, ipcRenderer } from 'electron';

import {
  type WidgetViewerBridge,
  type WidgetViewerInitialize,
  WidgetViewerIpc,
  type WidgetViewerState,
} from '../shared/widgets/viewer';

// Inner native sandbox frames never receive this bridge or the application preload.
if (process.isMainFrame) {
  let initialized = false;
  let mountId = '';
  const bridge: WidgetViewerBridge = {
    onInitialize(callback) {
      ipcRenderer.once(WidgetViewerIpc.Initialize, (_event, value: WidgetViewerInitialize) => {
        if (initialized) return;
        initialized = true;
        mountId = value.mountId;
        void ipcRenderer
          .invoke(WidgetViewerIpc.ProxyReady)
          .then(() => callback(value))
          .catch(() => {
            ipcRenderer.sendToHost(WidgetViewerIpc.Event, {
              mountId,
              type: 'failure',
              runtime: false,
            });
          });
      });
    },
    onState(callback) {
      ipcRenderer.on(WidgetViewerIpc.State, (_event, value: WidgetViewerState) => callback(value));
    },
    emit(value) {
      if (initialized && value.mountId === mountId)
        ipcRenderer.sendToHost(WidgetViewerIpc.Event, value);
    },
  };
  contextBridge.exposeInMainWorld('widgetViewer', bridge);
}

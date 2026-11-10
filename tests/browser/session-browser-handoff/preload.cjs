const { contextBridge, ipcRenderer } = require('electron');
const prefix = 'cowork:workspaceWindow:';
const listen = (channel, listener) => {
  const handler = (_, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const ignore = () => {};
const unusedListener = () => ignore;
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  window: {
    onStateChanged: unusedListener,
    isMaximized: () => Promise.resolve(false),
  },
  browser: {
    registerAgentTab: value => ipcRenderer.send('probe:browser:register', value),
    unregisterAgentTab: value => ipcRenderer.send('probe:browser:unregister', value),
    setAgentActiveTab: ignore,
    setUserInteractionState: ignore,
    acknowledgeAgentInteraction: ignore,
    onAgentInteractionState: unusedListener,
    onPanelOpenTab: unusedListener,
    onPanelFaviconUpdated: unusedListener,
    onPanelHttpAuthRequest: unusedListener,
    onPanelHttpAuthDismissed: unusedListener,
    onPanelPdfDetected: unusedListener,
    setRecordingLease: () => Promise.resolve(true),
  },
  cowork: {
    startSession: options => ipcRenderer.invoke('probe:handoff:start', options),
    getSession: id => ipcRenderer.invoke('probe:handoff:getSession', id),
    onNativeSessionDispatch: listener => listen('probe:handoff:dispatch', listener),
    respondNativeSessionDispatch: response => ipcRenderer.invoke('probe:handoff:respond', response),
  },
  workspaceWindow: {
    prepare: () => ipcRenderer.invoke(prefix + 'prepare'),
    update: value => ipcRenderer.send(prefix + 'update', value),
    onInvalidated: listener => listen(prefix + 'invalidated', listener),
    onStateChanged: listener => listen(prefix + 'stateChanged', listener),
    getWindowState: generation => ipcRenderer.invoke(prefix + 'getWindowState', generation),
    control: (generation, action, position) => ipcRenderer.send(prefix + 'control', generation, action, position),
    focusMain: () => ipcRenderer.send(prefix + 'focusMain'),
    setDetached: (generation, detached) => ipcRenderer.invoke(prefix + 'setDetached', generation, detached),
  },
});

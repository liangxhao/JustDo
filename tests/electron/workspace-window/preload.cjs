const { contextBridge, ipcRenderer } = require('electron');
const prefix = 'cowork:workspaceWindow:';
const listen = (channel, listener) => {
  const handler = (_, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('probeMarker', true);
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send('probe:main:control', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('probe:main:control', 'toggleMaximize'),
    close: () => ipcRenderer.send('probe:main:control', 'close'),
    showSystemMenu: () => ipcRenderer.send('probe:main:control', 'showSystemMenu'),
    isMaximized: () => Promise.resolve(false),
    onStateChanged: listener => listen('window:state-changed', listener),
  },
  terminal: {
    create: value => ipcRenderer.invoke('probe:terminal:create', value),
    close: id => ipcRenderer.invoke('probe:terminal:close', id),
    resize: value => ipcRenderer.invoke('probe:terminal:resize', value),
    write: value => ipcRenderer.invoke('probe:terminal:write', value),
    onData: listener => listen('probe:terminal:data', listener),
    onStatus: listener => listen('probe:terminal:status', listener),
    onExit: listener => listen('probe:terminal:exit', listener),
  },
  workspaceWindow: {
    getWindowState: generation => ipcRenderer.invoke(prefix + 'getWindowState', generation),
    control: (generation, action, position) => ipcRenderer.send(prefix + 'control', generation, action, position),
    onInvalidated: listener => listen(prefix + 'invalidated', listener),
    prepare: () => ipcRenderer.invoke(prefix + 'prepare'),
    update: value => ipcRenderer.send(prefix + 'update', value),
    setDetached: (generation, detached) =>
      ipcRenderer.invoke(prefix + 'setDetached', generation, detached),
    focusMain: () => ipcRenderer.send(prefix + 'focusMain'),
    focus: () => ipcRenderer.send(prefix + 'focus'),
    onStateChanged: listener => {
      const handler = (_, state) => listener(state);
      ipcRenderer.on(prefix + 'stateChanged', handler);
      return () => ipcRenderer.removeListener(prefix + 'stateChanged', handler);
    },
  },
});

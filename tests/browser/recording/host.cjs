const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('recordingSmoke', {
  report: payload => ipcRenderer.send('recording-smoke:event', payload),
});
